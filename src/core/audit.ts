/**
 * 审计日志：本地 JSONL 追加、按大小滚动、尾部读取、当天汇总、清空。
 *
 * 设计要点：
 * - 只写本机磁盘，不联网；写失败只 warn，绝不影响主流程（engine 外层还有 try/catch）；
 * - 所有写/清空操作在模块内串行（promise 队列），避免并发 append 交错；
 * - 滚动：写入前若累计字节 + 本行 > maxAuditMb，则把 audit.jsonl 整体搬到
 *   audit.1.jsonl 再清空主文件。FileStoreLike 没有 size/rename API，所以用
 *   Buffer.byteLength 自维护字节数（首次从磁盘读出初始化）。
 */

import { Buffer } from 'node:buffer'
import type { AuditEvent, AuditLogLike, AuditSummary, FileStoreLike, Logger } from '../types.ts'
import { dayKey } from '../util/time.ts'

/** 主审计文件。 */
const MAIN_FILE = 'audit.jsonl'
/** 滚动后的历史审计文件（只保留 1 份，避免无限占盘）。 */
const ROLLED_FILE = 'audit.1.jsonl'
/** 默认滚动阈值（MB）。 */
const DEFAULT_MAX_AUDIT_MB = 10

/** AuditLog 构造参数。 */
export interface AuditLogOptions {
  store: FileStoreLike
  enabled: boolean
  logger: Logger
  maxAuditMb: number
}

/** 解析一行 JSONL；损坏行直接跳过（审计文件被手工编辑/写一半时也不能崩）。 */
function parseEventLine(line: string): AuditEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Partial<AuditEvent>
    if (typeof record.ts !== 'number' || typeof record.type !== 'string') return null
    return record as AuditEvent
  } catch {
    return null
  }
}

/** 有限非负整数。 */
function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

export class AuditLog implements AuditLogLike {
  private readonly store: FileStoreLike
  private readonly enabled: boolean
  private readonly logger: Logger
  private readonly limitBytes: number
  /** 主文件当前字节数；-1 = 未知（需要从磁盘读一次）。 */
  private bytes = -1
  /** 写操作串行队列（已 catch，永不 reject）。 */
  private queue: Promise<void> = Promise.resolve()

  constructor(opts: AuditLogOptions) {
    this.store = opts.store
    this.enabled = opts.enabled !== false
    this.logger = opts.logger
    const maxAuditMb = typeof opts.maxAuditMb === 'number' && Number.isFinite(opts.maxAuditMb) ? opts.maxAuditMb : DEFAULT_MAX_AUDIT_MB
    this.limitBytes = Math.max(0, Math.floor(Math.max(0, maxAuditMb) * 1024 * 1024))
  }

  /** 追加一条事件；enabled=false 或写入失败时静默（写失败只 warn）。 */
  record(event: Omit<AuditEvent, 'ts'> & { ts?: number }): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    const ts = typeof event?.ts === 'number' && Number.isFinite(event.ts) ? event.ts : Date.now()
    let line: string
    try {
      line = `${JSON.stringify({ ...event, ts })}\n`
    } catch (error) {
      this.warn('审计事件序列化失败', error)
      return Promise.resolve()
    }
    return this.enqueue(async () => {
      await this.ensureSize()
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (this.limitBytes > 0 && this.bytes > 0 && this.bytes + lineBytes > this.limitBytes) {
        await this.roll()
      }
      await this.store.append(MAIN_FILE, line)
      this.bytes += lineBytes
    })
  }

  /** 读取尾部 n 条事件（按写入顺序，最后一条在末尾）。 */
  async recent(n: number): Promise<AuditEvent[]> {
    await this.queue
    const count = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
    if (count === 0) return []
    const lines = await this.readLines(MAIN_FILE)
    const events: AuditEvent[] = []
    for (const line of lines.slice(-count)) {
      const event = parseEventLine(line)
      if (event) events.push(event)
    }
    return events
  }

  /**
   * 汇总“今天”的事件：按事件自带 ts 的本地 dayKey 过滤（不看文件名），
   * 聚合 llm token / 缓存读 token / 搜索 / 发送 / 草稿 / 按 reason 的 skip 计数。
   */
  async summary(): Promise<AuditSummary> {
    await this.queue
    const today = dayKey(Date.now())
    const result: AuditSummary = {
      dayKey: today,
      llmCalls: 0,
      llmTokens: 0,
      cacheReadTokens: 0,
      searches: 0,
      sends: 0,
      drafts: 0,
      skips: {},
    }
    const lines = [...(await this.readLines(ROLLED_FILE)), ...(await this.readLines(MAIN_FILE))]
    for (const line of lines) {
      const event = parseEventLine(line)
      if (!event) continue
      if (dayKey(event.ts) !== today) continue
      result.lastEventAt = Math.max(result.lastEventAt ?? 0, event.ts)
      switch (event.type) {
        case 'llm': {
          result.llmCalls += 1
          const total = event.llm?.totalTokens
          const input = nonNegativeInt(event.llm?.inputTokens)
          const output = nonNegativeInt(event.llm?.outputTokens)
          result.llmTokens += typeof total === 'number' && Number.isFinite(total) ? nonNegativeInt(total) : input + output
          result.cacheReadTokens += nonNegativeInt(event.llm?.cacheReadTokens)
          break
        }
        case 'search': {
          result.searches += 1
          break
        }
        case 'send': {
          result.sends += 1
          break
        }
        case 'draft': {
          result.drafts += 1
          break
        }
        case 'skip': {
          const reason = typeof event.reason === 'string' && event.reason !== '' ? event.reason : 'unknown'
          result.skips[reason] = (result.skips[reason] ?? 0) + 1
          break
        }
        default:
          break
      }
    }
    return result
  }

  /** 删除主文件与滚动文件（不清空内存计数以外的其它状态）。 */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      for (const file of [MAIN_FILE, ROLLED_FILE]) {
        try {
          await this.store.remove(file)
        } catch (error) {
          this.warn(`审计文件删除失败：${file}`, error)
        }
      }
      this.bytes = 0
    })
  }

  /* ────────────────────────── 内部实现 ────────────────────────── */

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task)
    const guarded = run.catch((error: unknown) => {
      this.warn('审计日志写入失败', error)
    })
    this.queue = guarded
    return guarded
  }

  /** 首次写前从磁盘初始化字节数。 */
  private async ensureSize(): Promise<void> {
    if (this.bytes >= 0) return
    try {
      const content = await this.store.read(MAIN_FILE)
      this.bytes = content === null ? 0 : Buffer.byteLength(content, 'utf8')
    } catch (error) {
      this.warn('审计文件大小读取失败，按 0 处理', error)
      this.bytes = 0
    }
  }

  /** 把主文件内容搬到 audit.1.jsonl 并清空主文件；搬移失败则保留数据不删。 */
  private async roll(): Promise<void> {
    let content: string | null = null
    try {
      content = await this.store.read(MAIN_FILE)
    } catch (error) {
      this.warn('审计滚动读取失败', error)
    }
    if (typeof content === 'string' && content !== '') {
      try {
        await this.store.write(ROLLED_FILE, content)
      } catch (error) {
        this.warn('审计滚动写入失败，跳过本次滚动', error)
        return
      }
    }
    try {
      await this.store.remove(MAIN_FILE)
    } catch (error) {
      this.warn('审计滚动删除主文件失败', error)
    }
    this.bytes = 0
  }

  /** 按行读某个文件；文件不存在返回空数组（空行不参与解析）。 */
  private async readLines(file: string): Promise<string[]> {
    try {
      const content = await this.store.read(file)
      if (content === null || content === '') return []
      return content.split('\n').filter((line) => line.trim() !== '')
    } catch (error) {
      this.warn(`审计文件读取失败：${file}`, error)
      return []
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.logger?.warn?.(message, error instanceof Error ? error.message : String(error))
    } catch {
      // 日志器本身出错也不能影响审计
    }
  }
}

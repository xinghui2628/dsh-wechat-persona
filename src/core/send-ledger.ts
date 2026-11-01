/**
 * 发送幂等账本（任务书 9.4）。
 *
 * 每次逻辑发送生成唯一 sendOperationId；同一次操作（含 multi-part）在账本里按
 * `${opId}#${partIndex}` 记录状态。引擎在执行 `channel.send` 之前先查账本：
 * - 已 `confirmed`（确定发出）：跳过，避免重试/重启后重复发送；
 * - `unknown`（无法确认，例如脚本回车后气泡未确认）：跳过并保留未知状态，绝不自动重发；
 * - `failed` 且 `delivery='not-sent'`（确定未发出）：允许在重试上限内显式重排；
 * - 其余（sending / ready / draft 等未终结状态）：允许继续。
 *
 * 持久化到 `dataDir/send-ledger.json`（注入 FileStoreLike），插件重启后 `load()`
 * 恢复，避免因 DSH 重试 / 进程重启导致同一消息被无条件重复发送。
 *
 * 技术边界：GUI 自动化无法保证严格 exactly-once；账本只覆盖「本插件自己发起的
 * 逻辑发送」，人工在微信里重复操作、或脚本层在退出前已发送但未回报的情况仍需
 * 人工确认（unknown 语义即为此保留）。
 */

import type { Clock, FileStoreLike, Logger, SendDelivery } from '../types.ts'
import type { SendState } from './send-state.ts'
import { isSendState } from './send-state.ts'

export const SEND_LEDGER_FILE = 'send-ledger.json'
export const SEND_LEDGER_VERSION = 1
/** 账本最多保留的记录条数（超出时丢弃最旧的）。 */
export const SEND_LEDGER_MAX_ENTRIES = 200
/** 同一操作/part 最多尝试次数（含首次）；超过后不再发起新尝试。 */
export const SEND_LEDGER_MAX_ATTEMPTS = 3

export interface SendLedgerEntry {
  /** 发送操作 id（一次逻辑发送的唯一标识，multi-part 共享）。 */
  opId: string
  contactId: string
  /** 第几条消息（multi-part 拆分时 0、1、…；单条固定 0）。 */
  partIndex: number
  state: SendState
  /** 已发起的发送尝试次数（含首次）。 */
  attempts: number
  /** 最近一次投递三态（sent / not-sent / unknown）。 */
  delivery?: SendDelivery
  /** 发送文本摘要（不保存明文，避免账本成为隐私落盘面）。 */
  textHash: string
  /** 最近一次更新时间（毫秒时间戳）。 */
  updatedAt: number
}

export interface SendLedgerFile {
  version: 1
  entries: SendLedgerEntry[]
}

export interface BeginOperationInput {
  /** 指定 opId（草稿批准时复用草稿 id）；缺省时自动生成。 */
  opId?: string
  contactId: string
  /** 参与 hash 的发送文本（不落明文，只落 hash）。 */
  text: string
  partIndex?: number
}

export interface RecordSendResultInput {
  state: SendState
  delivery?: SendDelivery
  /** 失败原因（仅内存/日志用，不落账本避免泄露内容）。 */
  error?: string
}

export interface SendLedgerOptions {
  clock: Clock
  store: FileStoreLike
  logger?: Logger
  /** 可注入的 opId 生成器（测试用确定性实现）；缺省 = 时间戳 + 随机数。 */
  nextOperationId?: () => string
  maxEntries?: number
}

/** FNV-1a 32 位文本摘要（稳定、无 crypto 依赖；只用于「同一文本」比对，不做安全用途）。 */
export function hashSendText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 生成发送操作 id（时间戳 + 随机数；文件内不需要密码学强度）。 */
export function createSendOperationId(seed: number, random?: () => number): string {
  const randomPart = Math.floor(Math.abs(random ? random() : Math.random()) * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
  return `op-${Math.max(0, Math.floor(seed)).toString(36)}-${randomPart}`
}

function validPartIndex(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function normalizeLedgerEntry(raw: unknown): SendLedgerEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const record = raw as Record<string, unknown>
  const opId = typeof record.opId === 'string' ? record.opId.trim() : ''
  const contactId = typeof record.contactId === 'string' ? record.contactId.trim() : ''
  if (!opId || !contactId || !isSendState(record.state)) {
    return null
  }
  const attempts = typeof record.attempts === 'number' && Number.isFinite(record.attempts) && record.attempts >= 0
    ? Math.floor(record.attempts)
    : 0
  const delivery =
    record.delivery === 'sent' || record.delivery === 'not-sent' || record.delivery === 'unknown'
      ? record.delivery
      : undefined
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0
  return {
    opId,
    contactId,
    partIndex: validPartIndex(record.partIndex),
    state: record.state,
    attempts,
    delivery,
    textHash: typeof record.textHash === 'string' ? record.textHash.slice(0, 64) : '',
    updatedAt,
  }
}

/**
 * 发送幂等账本（纯逻辑 + 注入 clock/store，无真实 I/O）。
 *
 * 用法：engine 在发送流程中 `beginOperation()` 取得 opId，然后每个 part 发送前
 * `shouldSend()` 判断、`markSending()` 自增尝试、`recordResult()` 记录结果；关键
 * 节点调用 `save()` 落盘。重启后 `load()` 恢复。
 */
export class SendLedger {
  private readonly entries = new Map<string, SendLedgerEntry>()
  private readonly clock: Clock
  private readonly store: FileStoreLike
  private readonly logger?: Logger
  private readonly nextOperationId?: () => string
  private readonly maxEntries: number
  private loaded = false

  constructor(options: SendLedgerOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('SendLedger 需要注入 clock 与 store')
    }
    if (!options.clock || typeof options.clock.now !== 'function') {
      throw new Error('SendLedger 缺少 clock.now()')
    }
    if (!options.store || typeof options.store.writeJson !== 'function') {
      throw new Error('SendLedger 缺少 FileStoreLike.store')
    }
    this.clock = options.clock
    this.store = options.store
    this.logger = options.logger
    this.nextOperationId = options.nextOperationId
    this.maxEntries = Math.max(1, Math.floor(Number(options.maxEntries) || SEND_LEDGER_MAX_ENTRIES))
  }

  /** 是否已从磁盘加载过（load() 成功后为 true）。 */
  isLoaded(): boolean {
    return this.loaded
  }

  /** 从 dataDir/send-ledger.json 加载账本；文件不存在/损坏时安全降级为空账本。 */
  async load(): Promise<void> {
    this.loaded = true
    try {
      const raw = await this.store.readJson<SendLedgerFile>(SEND_LEDGER_FILE)
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as SendLedgerFile).entries)) {
        return
      }
      const entries: SendLedgerEntry[] = []
      for (const item of (raw as SendLedgerFile).entries) {
        const entry = normalizeLedgerEntry(item)
        if (entry) {
          entries.push(entry)
        }
      }
      entries.sort((left, right) => left.updatedAt - right.updatedAt)
      for (const entry of entries.slice(-this.maxEntries)) {
        this.entries.set(this.key(entry.opId, entry.partIndex), entry)
      }
    } catch (error) {
      this.logger?.warn('读取发送账本失败，已按空账本继续（可能失去跨重启幂等保护）', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 落盘账本（只保留最近 maxEntries 条；失败只告警不抛）。 */
  async save(): Promise<void> {
    const entries = this.list().slice(-this.maxEntries)
    try {
      await this.store.writeJson(SEND_LEDGER_FILE, { version: SEND_LEDGER_VERSION, entries } satisfies SendLedgerFile)
    } catch (error) {
      this.logger?.warn('写入发送账本失败（本次运行仍使用内存账本）', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 取某 part 的记录（不存在返回 null）。 */
  get(opId: string, partIndex = 0): SendLedgerEntry | null {
    return this.entries.get(this.key(opId, validPartIndex(partIndex))) ?? null
  }

  /** 全部记录（按 updatedAt 升序，新的在后）。 */
  list(): SendLedgerEntry[] {
    return [...this.entries.values()].sort((left, right) => left.updatedAt - right.updatedAt)
  }

  /**
   * 开始一次逻辑发送（幂等：同一 opId 已存在时直接返回原记录，不重置状态）。
   *
   * 返回记录副本，避免调用方意外修改内部状态。
   */
  beginOperation(input: BeginOperationInput): SendLedgerEntry {
    const partIndex = validPartIndex(input.partIndex)
    const opId = (input.opId && input.opId.trim()) || this.generateOperationId()
    const existing = this.get(opId, partIndex)
    if (existing) {
      return { ...existing }
    }
    const entry: SendLedgerEntry = {
      opId,
      contactId: String(input.contactId || '').slice(0, 128),
      partIndex,
      state: 'ready',
      attempts: 0,
      textHash: hashSendText(input.text || ''),
      updatedAt: this.clock.now(),
    }
    this.entries.set(this.key(opId, partIndex), entry)
    return { ...entry }
  }

  /**
   * 记录一次发送尝试开始（attempts += 1，state='sending'）。
   * 记录不存在时返回 null（调用方不应在未 beginOperation 的情况下发送）。
   */
  markSending(opId: string, partIndex = 0): SendLedgerEntry | null {
    const entry = this.entries.get(this.key(opId, validPartIndex(partIndex)))
    if (!entry) {
      return null
    }
    entry.state = 'sending'
    entry.attempts += 1
    entry.updatedAt = this.clock.now()
    return { ...entry }
  }

  /** 记录发送结果（state=confirmed/failed/unknown/cancelled；delivery 三态）。 */
  recordResult(opId: string, partIndex = 0, input?: RecordSendResultInput): SendLedgerEntry | null {
    const entry = this.entries.get(this.key(opId, validPartIndex(partIndex)))
    if (!entry) {
      return null
    }
    if (input) {
      entry.state = input.state
      if (input.delivery) {
        entry.delivery = input.delivery
      }
    }
    entry.updatedAt = this.clock.now()
    return { ...entry }
  }

  /** 是否终态（confirmed / failed / unknown / cancelled）。 */
  isTerminal(opId: string, partIndex = 0): boolean {
    const entry = this.get(opId, partIndex)
    if (!entry) {
      return false
    }
    return (
      entry.state === 'confirmed' ||
      entry.state === 'failed' ||
      entry.state === 'unknown' ||
      entry.state === 'cancelled'
    )
  }

  /** 是否为「确定未发出、且未超重试上限」的失败（唯一允许重排的情况）。 */
  shouldRetry(opId: string, partIndex = 0): boolean {
    const entry = this.get(opId, partIndex)
    if (!entry) {
      return false
    }
    return entry.state === 'failed' && entry.delivery === 'not-sent' && entry.attempts < SEND_LEDGER_MAX_ATTEMPTS
  }

  /**
   * 是否应执行本次发送（引擎在 `canSend` 之后、`channel.send` 之前调用）。
   *
   * - 无记录：应发送；
   * - 未终结（ready/draft/sending 等）：应发送（sending 表示上次进程中断，允许继续）；
   * - confirmed / cancelled：跳过（绝不重发）；
   * - unknown：跳过（无法确认，绝不自动重发）；
   * - failed：仅 delivery='not-sent' 且未超重试上限时放行。
   */
  shouldSend(opId: string, partIndex = 0): boolean {
    const entry = this.get(opId, partIndex)
    if (!entry) {
      return true
    }
    if (entry.state === 'confirmed' || entry.state === 'cancelled' || entry.state === 'unknown') {
      return false
    }
    if (entry.state === 'failed') {
      return this.shouldRetry(opId, partIndex)
    }
    return true
  }

  /** 测试/维护用：清空内存账本（不落盘）。 */
  clear(): void {
    this.entries.clear()
    this.loaded = false
  }

  private generateOperationId(): string {
    if (this.nextOperationId) {
      const generated = String(this.nextOperationId() || '').trim()
      if (generated) {
        return generated
      }
    }
    return createSendOperationId(this.clock.now())
  }

  private key(opId: string, partIndex: number): string {
    return `${opId}#${partIndex}`
  }
}

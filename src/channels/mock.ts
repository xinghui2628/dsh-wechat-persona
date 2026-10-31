/**
 * mock 通道：完全本地、无外部依赖的测试/空转通道。
 *
 * 用途：
 * - 安装后的默认通道（不碰真实微信）；
 * - 端到端联调：把“收到消息”写进 inboundFile，引擎按真实链路跑一遍；
 * - 单测：配合内存版 FileStoreLike 验证白名单/群聊过滤/去重/风控/发送落盘。
 *
 * 入站文件格式（相对 store.root，两种都支持）：
 * - JSON 数组：[{ id, contactId, contactName, chatType, kind, text, receivedAt }, …]
 * - JSONL：每行一个上述对象
 *
 * 特殊条目：`{ kind: 'risk', text: '...', riskKind?: 'captcha' }` 不投递给 handler，
 * 而是走 onRisk（模拟通道层读到风控文案）。riskKind 省略时用 detectChannelRisk
 * 从 text 推断，推断不出则为 'unknown'。
 *
 * 发送落盘：outbox.jsonl，每行 `{ ts, contactId, part }`，方便断言“引擎到底发了什么”。
 */

import type { WechatPersonaConfig } from '../config.ts'
import type {
  Channel,
  ChannelStatus,
  ChannelState,
  FileStoreLike,
  InboundHandler,
  InboundMessage,
  Logger,
  OutboundPart,
  RiskHandler,
  RiskKind,
  RiskSignal,
  SendResult,
} from '../types.ts'
import type { ChannelDeps } from './channel.ts'
import { detectChannelRisk } from './risk.ts'

/** mock 通道的发送记录文件（相对 store.root）。 */
export const MOCK_OUTBOX_FILE = 'outbox.jsonl'

/** 未显式指定时的轮询间隔。 */
const DEFAULT_POLL_INTERVAL_MS = 1000

/** 内存里去重集合的上限，避免长跑测试无限增长。 */
const MAX_SEEN = 10_000

export interface MockChannelOptions {
  config: WechatPersonaConfig
  deps: ChannelDeps
  /** 覆盖轮询间隔（毫秒）；<=0 表示不轮询，只在 start 时读一次。 */
  pollIntervalMs?: number
}

/** inboundFile 允许的条目形状（比 InboundMessage 多一个 risk / riskKind）。 */
export interface MockInboundEntry {
  id?: string
  contactId?: string
  contactName?: string
  chatType?: 'single' | 'group'
  kind?: InboundMessage['kind'] | 'risk'
  text?: string
  receivedAt?: number
  /** kind='risk' 时可显式指定风险大类。 */
  riskKind?: RiskKind
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function clampInterval(ms: number | undefined, fallback: number): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return fallback
  if (ms <= 0) return 0
  return Math.max(5, Math.round(ms))
}

/** 无 id 条目的稳定兜底 id（同一份文件反复读不会重复投递）。 */
function fallbackId(entry: MockInboundEntry, contactId: string): string {
  const text = typeof entry.text === 'string' ? entry.text : ''
  const raw = `${contactId}\u0000${entry.kind ?? 'text'}\u0000${text}`
  let hash = 5381
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0
  return `mock-${(hash >>> 0).toString(36)}`
}

/**
 * 白名单匹配：条目的 contactId / contactName 命中白名单 id / name / aliases 之一。
 * 白名单为空 => 不放行任何消息（与引擎语义一致）。
 */
function findWhitelistMatch(
  config: WechatPersonaConfig,
  ...candidates: Array<string | undefined>
): WechatPersonaConfig['whitelist'][number] | null {
  const wanted = candidates.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
  if (wanted.length === 0) return null

  for (const entry of config.whitelist ?? []) {
    const identifiers = [entry.id, entry.name, ...(entry.aliases ?? [])]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
    if (identifiers.some((identifier) => wanted.includes(identifier))) return entry
  }
  return null
}

function parseEntries(raw: string): MockInboundEntry[] {
  const text = raw.trim()
  if (!text) return []

  // 先按整体 JSON 解析（数组 / 单个对象）。
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed.filter(isEntryObject)
    if (isEntryObject(parsed)) return [parsed]
  } catch {
    // 落到 JSONL 分支。
  }

  const entries: MockInboundEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isEntryObject(parsed)) entries.push(parsed)
    } catch {
      // 单行坏数据跳过：mock 是测试通道，不值得让整份文件失效。
    }
  }
  return entries
}

function isEntryObject(value: unknown): value is MockInboundEntry {
  return typeof value === 'object' && value !== null
}

export class MockChannel implements Channel {
  readonly id = 'mock' as const

  private readonly config: WechatPersonaConfig
  private readonly deps: ChannelDeps
  private readonly logger: Logger
  private readonly store: FileStoreLike
  private readonly inboundFile: string
  private readonly pollIntervalMs: number

  private handler: InboundHandler | null = null
  private riskHandler: RiskHandler | null = null
  private running = false
  private stopped = true
  private loop: Promise<void> | null = null
  private readonly seenMessages = new Set<string>()
  private readonly seenRisks = new Set<string>()
  private stateInfo: ChannelStatus

  constructor(opts: MockChannelOptions) {
    this.config = opts.config
    this.deps = opts.deps
    this.logger = opts.deps.logger
    this.store = opts.deps.store
    this.inboundFile = (opts.config.channels.mock?.inboundFile ?? '').trim()
    this.pollIntervalMs = clampInterval(opts.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
    this.stateInfo = {
      id: 'mock',
      state: 'stopped',
      since: opts.deps.clock.now(),
      detail: this.inboundFile ? `inboundFile=${this.inboundFile}` : 'inboundFile 未配置（空转）',
    }
  }

  async start(handler: InboundHandler, onRisk: RiskHandler): Promise<void> {
    this.handler = handler
    this.riskHandler = onRisk
    if (this.running) {
      // 幂等：重复 start 只更新回调，不重复起循环。
      return
    }
    this.running = true
    this.stopped = false
    this.setState('running', this.stateInfo.detail)

    // 首轮立即读一次（不阻塞：只等一次文件读取），随后进入轮询循环。
    try {
      await this.scanOnce()
    } catch (error) {
      this.noteError(error)
    }

    if (this.pollIntervalMs > 0 && this.inboundFile) {
      this.loop = this.pollLoop()
    } else if (!this.inboundFile) {
      this.logger.info('[mock] channels.mock.inboundFile 未配置，通道空转（不会产生任何入站消息）')
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.running = false
    this.handler = null
    this.riskHandler = null
    this.setState('stopped', this.stateInfo.detail)
    // 轮询循环在下一轮检查 stopped 后自行退出；start 里不会等它。
    this.loop = null
  }

  async send(contactId: string, part: OutboundPart): Promise<SendResult> {
    const ts = this.deps.clock.now()
    try {
      const line = JSON.stringify({ ts, contactId, part })
      await this.store.append(MOCK_OUTBOX_FILE, `${line}\n`)
      this.stateInfo.lastSendAt = ts
      this.logger.debug(`[mock] 已写 outbox：contactId=${contactId} kind=${part.kind}`)
      return { ok: true }
    } catch (error) {
      const message = errorMessage(error)
      this.stateInfo.lastError = message
      this.logger.warn(`[mock] 写 outbox 失败：${message}`)
      return { ok: false, error: message }
    }
  }

  /** Channel 契约方法：返回快照，调用方改不影响内部状态。 */
  status(): ChannelStatus {
    return { ...this.stateInfo }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.deps.clock.sleep(this.pollIntervalMs)
      } catch {
        // sleep 被中断（AbortSignal 等）按停止处理。
        break
      }
      if (this.stopped) break
      try {
        await this.scanOnce()
      } catch (error) {
        this.noteError(error)
      }
    }
  }

  private async scanOnce(): Promise<void> {
    if (!this.inboundFile) return
    const raw = await this.store.read(this.inboundFile)
    if (raw == null) {
      this.logger.debug(`[mock] ${this.inboundFile} 尚不存在，等待后续轮询`)
      return
    }

    const entries = parseEntries(raw)
    for (const entry of entries) {
      if (this.stopped) return
      if (entry.kind === 'risk') {
        this.emitRiskEntry(entry)
        continue
      }
      this.emitInbound(entry)
    }
  }

  private emitRiskEntry(entry: MockInboundEntry): void {
    const text = typeof entry.text === 'string' ? entry.text : ''
    const detected = text ? detectChannelRisk(text, this.config) : null
    const kind: RiskKind = entry.riskKind ?? detected?.kind ?? 'unknown'
    const key = entry.id?.trim() || `risk:${kind}:${text}`
    if (this.seenRisks.has(key)) return
    this.remember(this.seenRisks, key)

    const signal: RiskSignal = {
      kind,
      text: detected?.text ?? text.slice(0, 80),
      at: this.deps.clock.now(),
      matched: detected?.matched ?? text.slice(0, 40),
    }
    this.logger.warn(`[mock] 注入风控信号 kind=${signal.kind} matched=${signal.matched}`)
    this.riskHandler?.(signal)
  }

  private emitInbound(entry: MockInboundEntry): void {
    const contactId = (entry.contactId ?? entry.contactName ?? '').trim()
    if (!contactId) {
      this.logger.warn('[mock] 入站条目缺少 contactId/contactName，已忽略')
      return
    }
    const messageId = entry.id?.trim() || fallbackId(entry, contactId)
    if (this.seenMessages.has(messageId)) return

    const contactName = (entry.contactName ?? contactId).trim() || contactId
    const chatType: InboundMessage['chatType'] = entry.chatType === 'group' ? 'group' : 'single'
    const kind: InboundMessage['kind'] = entry.kind && entry.kind !== 'risk' ? entry.kind : 'text'
    const text = typeof entry.text === 'string' ? entry.text : ''
    const receivedAt =
      typeof entry.receivedAt === 'number' && Number.isFinite(entry.receivedAt)
        ? entry.receivedAt
        : this.deps.clock.now()

    if (chatType === 'group') {
      this.remember(this.seenMessages, messageId)
      this.logger.debug(`[mock] 跳过群聊消息 id=${messageId} contact=${contactName}`)
      return
    }
    if (!findWhitelistMatch(this.config, contactId, contactName)) {
      this.remember(this.seenMessages, messageId)
      this.logger.debug(`[mock] 跳过非白名单联系人 contactId=${contactId} contactName=${contactName}`)
      return
    }

    this.remember(this.seenMessages, messageId)
    const message: InboundMessage = {
      id: messageId,
      contactId,
      contactName,
      chatType,
      kind,
      text,
      receivedAt,
    }
    this.stateInfo.lastInboundAt = this.deps.clock.now()
    this.logger.debug(`[mock] 投递入站 id=${messageId} contact=${contactName} kind=${kind}`)
    this.handler?.(message)
  }

  private remember(bucket: Set<string>, key: string): void {
    bucket.add(key)
    if (bucket.size <= MAX_SEEN) return
    // Set 迭代顺序即插入顺序，删掉最早的 1/4。
    const drop = Math.ceil(MAX_SEEN / 4)
    let index = 0
    for (const item of bucket) {
      bucket.delete(item)
      if (++index >= drop) break
    }
  }

  private setState(state: ChannelState, detail?: string): void {
    if (this.stateInfo.state !== state) this.stateInfo.since = this.deps.clock.now()
    this.stateInfo.state = state
    if (detail !== undefined) this.stateInfo.detail = detail
  }

  private noteError(error: unknown): void {
    const message = errorMessage(error)
    this.stateInfo.lastError = message
    this.setState('degraded')
    this.logger.warn(`[mock] 读取入站文件失败：${message}`)
  }
}

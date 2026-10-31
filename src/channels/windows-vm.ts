/**
 * windows-vm 通道：本机 DSH 与「Windows 虚拟机 / 独立桌面会话」里的微信客户端之间的桥。
 *
 * 为什么需要它：本机正在用的微信不能被自动化（会抢焦点、有封号风险），所以把
 * 微信放进一台 Windows 虚拟机（或另一个登录会话），由 VM 内的参考 agent
 * （scripts/vm-agent.mjs）用 UI Automation 驱动；本插件通过 localhost TCP
 * 的 JSON-lines 协议与它通信。
 *
 * 协议（每行一个 JSON）：
 *   client -> server
 *     { type: 'hello',  token: string }
 *     { type: 'send',   reqId: string, contactId: string, part: OutboundPart }
 *     { type: 'ping' }
 *   server -> client
 *     { type: 'inbound',     message: InboundMessage }
 *     { type: 'risk',        kind: RiskKind, text: string }
 *     { type: 'send-result', reqId: string, ok: boolean, error?: string }
 *     { type: 'pong' }（可选）
 *
 * 约定：
 * - 服务端在收到 hello 后校验 token；协议层没有 hello-ack，因此连接建立即视为可用
 *   （token 错误时服务端会直接断开，通道表现为断线重连 + degraded）。
 * - 端口默认 127.0.0.1:47653，只监听本机回环地址，不要暴露到局域网。
 * - 重连、心跳都用通道自己的可取消 timer（不是 deps.clock.sleep），保证 stop 一定清理干净。
 * - inbound 的 chatType/白名单过滤在本测执行（与 mock 通道同一语义）：
 *   群聊丢弃、联系人需命中 config.whitelist；风控信号不受白名单限制。
 */

import net from 'node:net'
import type { Socket } from 'node:net'
import type { WechatPersonaConfig } from '../config.ts'
import type {
  Channel,
  ChannelStatus,
  ChannelState,
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

export interface WindowsVmConnectOptions {
  host: string
  port: number
  timeoutMs: number
}

export interface WindowsVmChannelOptions {
  config: WechatPersonaConfig
  deps: ChannelDeps
  /** 覆盖连接实现（测试注入内存 socket / 假服务端）。 */
  connect?: (opts: WindowsVmConnectOptions) => Promise<Socket>
}

/** 心跳间隔：服务端不回 pong 也不会断，只要 socket 还活着。 */
const HEARTBEAT_INTERVAL_MS = 15_000

/** 单次 send 等 send-result 的上限。 */
const SEND_RESULT_TIMEOUT_MS = 10_000

/** 单行 JSON 的上限，防止对端发疯把内存吃满。 */
const MAX_LINE_BYTES = 1024 * 1024

const VALID_KINDS = new Set<InboundMessage['kind']>(['text', 'sticker', 'image', 'voice', 'other'])
const VALID_RISK_KINDS = new Set<RiskKind>(['captcha', 'login-abnormal', 'restricted', 'spam-limit', 'unknown'])

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

interface PendingSend {
  settle: (result: SendResult) => void
  timer: NodeJS.Timeout | null
}

interface ServerMessage {
  type?: unknown
  message?: unknown
  kind?: unknown
  text?: unknown
  reqId?: unknown
  ok?: unknown
  error?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 白名单匹配（与 mock 语义一致）。 */
function findWhitelistMatch(
  config: WechatPersonaConfig,
  ...candidates: Array<string | undefined>
): boolean {
  const wanted = candidates.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
  if (wanted.length === 0) return false
  return (config.whitelist ?? []).some((entry) => {
    const identifiers = [entry.id, entry.name, ...(entry.aliases ?? [])]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
    return identifiers.some((identifier) => wanted.includes(identifier))
  })
}

export class WindowsVmChannel implements Channel {
  readonly id = 'windows-vm' as const

  private readonly config: WechatPersonaConfig
  private readonly deps: ChannelDeps
  private readonly logger: Logger
  private readonly host: string
  private readonly port: number
  private readonly token: string
  private readonly connectTimeoutMs: number
  private readonly reconnectIntervalMs: number
  private readonly connectFn: (opts: WindowsVmConnectOptions) => Promise<Socket>

  private handler: InboundHandler | null = null
  private riskHandler: RiskHandler | null = null
  private stopped = true
  private loop: Promise<void> | null = null
  private socket: Socket | null = null
  private connected = false
  private everConnected = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectResolve: (() => void) | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private buffer = ''
  private reqCounter = 0
  private readonly pending = new Map<string, PendingSend>()
  private stateInfo: ChannelStatus

  constructor(opts: WindowsVmChannelOptions) {
    this.config = opts.config
    this.deps = opts.deps
    this.logger = opts.deps.logger
    const cfg = opts.config.channels.windowsVm
    this.host = (cfg.host || '127.0.0.1').trim()
    this.port = Math.max(1, Math.round(cfg.port || 47653))
    this.token = cfg.token ?? ''
    this.connectTimeoutMs = Math.max(100, Math.round(cfg.connectTimeoutMs || 5000))
    this.reconnectIntervalMs = Math.max(50, Math.round(cfg.reconnectIntervalMs || 3000))
    this.connectFn = opts.connect ?? ((options) => this.defaultConnect(options))
    this.stateInfo = {
      id: 'windows-vm',
      state: 'stopped',
      since: opts.deps.clock.now(),
      detail: `${this.host}:${this.port}`,
    }
  }

  async start(handler: InboundHandler, onRisk: RiskHandler): Promise<void> {
    this.handler = handler
    this.riskHandler = onRisk
    if (!this.stopped) return
    this.stopped = false
    this.setState('starting', this.stateInfo.detail)
    this.logger.info(`[windows-vm] 启动：连接 ${this.host}:${this.port}`)
    if (!this.token) {
      this.logger.warn('[windows-vm] channels.windowsVm.token 为空：VM agent 若校验 token 会直接拒绝连接')
    }
    // 不阻塞：连接/重连都在后台循环。
    this.loop = this.connectLoop()
    this.loop.catch((error) => {
      this.noteError(error)
      this.logger.error(`[windows-vm] 连接循环异常退出：${errorMessage(error)}`)
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.connected = false
    this.setState('stopped', this.stateInfo.detail)
    this.clearReconnect()
    this.stopHeartbeat()
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.removeAllListeners()
      socket.destroy()
    }
    this.failPending('通道已停止')
    this.handler = null
    this.riskHandler = null
    this.logger.info('[windows-vm] 已停止')
  }

  /** Channel 契约方法：返回快照。 */
  status(): ChannelStatus {
    return { ...this.stateInfo }
  }

  async send(contactId: string, part: OutboundPart): Promise<SendResult> {
    const socket = this.socket
    if (this.stopped || !socket || !this.connected) {
      return { ok: false, error: 'windows-vm 未连接（检查虚拟机与 VM agent 是否在运行）' }
    }
    const reqId = this.nextReqId()
    const payload = { type: 'send', reqId, contactId, part }
    return new Promise<SendResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        resolve({ ok: false, error: '等待 send-result 超时' })
      }, SEND_RESULT_TIMEOUT_MS)
      // 超时 timer 不应阻止进程退出（测试里通道 stop 后残留也不会卡住 vitest）。
      timer.unref?.()
      this.pending.set(reqId, { settle: resolve, timer })
      try {
        this.writeLine(payload)
        this.stateInfo.lastSendAt = this.deps.clock.now()
      } catch (error) {
        this.settlePending(reqId, { ok: false, error: errorMessage(error) })
      }
    })
  }

  // ── 内部：连接与重连 ─────────────────────────────────────────────

  private defaultConnect(options: WindowsVmConnectOptions): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: options.host, port: options.port })
      const timer = setTimeout(() => {
        socket.removeAllListeners()
        socket.destroy()
        reject(new Error(`连接 ${options.host}:${options.port} 超时（${options.timeoutMs}ms）`))
      }, options.timeoutMs)
      timer.unref?.()
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const socket = await this.connectFn({
          host: this.host,
          port: this.port,
          timeoutMs: this.connectTimeoutMs,
        })
        if (this.stopped) {
          socket.removeAllListeners()
          socket.destroy()
          return
        }
        await this.serve(socket)
      } catch (error) {
        this.noteError(error)
      }
      if (this.stopped) break
      this.setState(this.everConnected ? 'degraded' : 'error', this.stateInfo.detail)
      await this.waitReconnectDelay()
    }
  }

  /** 接管一条已连接的 socket，直到它关闭/出错。 */
  private serve(socket: Socket): Promise<void> {
    this.socket = socket
    this.connected = true
    this.everConnected = true
    this.buffer = ''
    socket.setEncoding('utf8')

    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        this.connected = false
        if (this.socket === socket) this.socket = null
        this.stopHeartbeat()
        this.buffer = ''
        this.failPending('windows-vm 连接已断开')
        resolve()
      }

      socket.on('data', (chunk: string) => this.consumeChunk(chunk))
      socket.on('close', finish)
      socket.on('error', (error: Error) => {
        this.stateInfo.lastError = errorMessage(error)
        this.logger.warn(`[windows-vm] socket 错误：${errorMessage(error)}`)
        finish()
      })
      // 心跳：服务端不回 pong 也无妨，写失败即会触发 error/close。
      this.heartbeatTimer = setInterval(() => {
        if (!this.connected) return
        try {
          this.writeLine({ type: 'ping' })
        } catch {
          // 写失败交给 close 处理。
        }
      }, HEARTBEAT_INTERVAL_MS)
      this.heartbeatTimer.unref?.()

      try {
        this.writeLine({ type: 'hello', token: this.token })
      } catch (error) {
        this.noteError(error)
        finish()
        return
      }
      this.setState('running', this.stateInfo.detail)
      this.logger.info('[windows-vm] 已连接 VM agent，hello 已发送')
    })
  }

  private consumeChunk(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.logger.error('[windows-vm] 收到的 JSON 行超过上限，丢弃缓冲区')
      this.stateInfo.lastError = '协议行超长'
      this.buffer = ''
      return
    }
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line) this.handleLine(line)
      newlineIndex = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let payload: unknown
    try {
      payload = JSON.parse(line)
    } catch {
      this.logger.warn(`[windows-vm] 无法解析的 JSON 行（已忽略，长度 ${line.length}）`)
      return
    }
    if (!isRecord(payload)) return
    const message = payload as ServerMessage
    switch (message.type) {
      case 'inbound':
        this.emitInbound(message.message)
        break
      case 'risk':
        this.emitRisk(message)
        break
      case 'send-result':
        this.resolveSend(message)
        break
      case 'pong':
        break
      default:
        this.logger.debug(`[windows-vm] 忽略未知消息类型 type=${String(message.type)}`)
    }
  }

  private emitInbound(raw: unknown): void {
    const inbound = this.normalizeInbound(raw)
    if (!inbound) {
      this.logger.warn('[windows-vm] 收到格式不完整的 inbound 消息，已忽略')
      return
    }
    if (inbound.chatType === 'group') {
      this.logger.debug(`[windows-vm] 跳过群聊消息 contact=${inbound.contactName}`)
      return
    }
    if (!findWhitelistMatch(this.config, inbound.contactId, inbound.contactName)) {
      this.logger.debug(`[windows-vm] 跳过非白名单联系人 contactId=${inbound.contactId}`)
      return
    }
    this.stateInfo.lastInboundAt = this.deps.clock.now()
    this.logger.debug(`[windows-vm] 投递入站 id=${inbound.id} contact=${inbound.contactName}`)
    this.handler?.(inbound)
  }

  private normalizeInbound(raw: unknown): InboundMessage | null {
    if (!isRecord(raw)) return null
    const contactId = typeof raw.contactId === 'string' ? raw.contactId.trim() : ''
    if (!contactId) return null
    const contactName = typeof raw.contactName === 'string' && raw.contactName.trim() ? raw.contactName.trim() : contactId
    const chatType: InboundMessage['chatType'] = raw.chatType === 'group' ? 'group' : 'single'
    const kind = VALID_KINDS.has(raw.kind as InboundMessage['kind']) ? (raw.kind as InboundMessage['kind']) : 'text'
    const text = typeof raw.text === 'string' ? raw.text : ''
    const receivedAt =
      typeof raw.receivedAt === 'number' && Number.isFinite(raw.receivedAt) ? raw.receivedAt : this.deps.clock.now()
    const id =
      typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `vm-${contactId}-${receivedAt}-${kind}`
    return { id, contactId, contactName, chatType, kind, text, receivedAt }
  }

  private emitRisk(message: ServerMessage): void {
    const text = typeof message.text === 'string' ? message.text : ''
    const kind = VALID_RISK_KINDS.has(message.kind as RiskKind) ? (message.kind as RiskKind) : 'unknown'
    const signal: RiskSignal = {
      kind,
      text: text.slice(0, 200),
      at: this.deps.clock.now(),
      matched: text.slice(0, 40),
    }
    this.logger.warn(`[windows-vm] VM agent 上报风控 kind=${signal.kind}`)
    this.riskHandler?.(signal)
  }

  private resolveSend(message: ServerMessage): void {
    const reqId = typeof message.reqId === 'string' ? message.reqId : ''
    if (!reqId) return
    const result: SendResult =
      message.ok === true
        ? { ok: true }
        : { ok: false, error: typeof message.error === 'string' && message.error ? message.error : 'VM agent 发送失败' }
    this.settlePending(reqId, result)
  }

  // ── 内部：协议/计时器/状态 ───────────────────────────────────────

  private writeLine(payload: unknown): void {
    const socket = this.socket
    if (!socket || !this.connected) throw new Error('socket 未连接')
    socket.write(`${JSON.stringify(payload)}\n`)
  }

  private nextReqId(): string {
    this.reqCounter += 1
    return `${this.deps.clock.now().toString(36)}-${this.reqCounter}`
  }

  private settlePending(reqId: string, result: SendResult): void {
    const pending = this.pending.get(reqId)
    if (!pending) {
      this.logger.debug(`[windows-vm] 收到未知 reqId 的 send-result：${reqId}`)
      return
    }
    this.pending.delete(reqId)
    if (pending.timer) clearTimeout(pending.timer)
    pending.settle(result)
  }

  private failPending(error: string): void {
    for (const [reqId, pending] of [...this.pending.entries()]) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.settle({ ok: false, error })
      this.pending.delete(reqId)
    }
  }

  private waitReconnectDelay(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.reconnectResolve = resolve
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.reconnectResolve = null
        resolve()
      }, this.reconnectIntervalMs)
      this.reconnectTimer.unref?.()
    })
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const resolve = this.reconnectResolve
    this.reconnectResolve = null
    resolve?.()
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private setState(state: ChannelState, detail?: string): void {
    if (this.stateInfo.state !== state) this.stateInfo.since = this.deps.clock.now()
    this.stateInfo.state = state
    if (detail !== undefined) this.stateInfo.detail = detail
  }

  private noteError(error: unknown): void {
    const message = errorMessage(error)
    this.stateInfo.lastError = message
    this.setState(this.everConnected ? 'degraded' : 'error', this.stateInfo.detail)
    this.logger.warn(`[windows-vm] ${message}`)
  }
}

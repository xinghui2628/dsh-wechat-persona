/**
 * phone-adb 通道：用本机 adb 驱动一台真实安卓手机上的微信。
 *
 * 前提（生产部署时由用户保证）：
 * - 手机已 USB 连接并 `adb devices` 可见、已开启 USB 调试；
 * - 手机已安装 ADBKeyboard（com.android.adbkeyboard），并在微信聊天输入框
 *   切到 AdbIME 输入法（否则 ADB_INPUT_B64 广播无人接收；中文因此可正确输入）；
 * - 通知监听权限已开启，`dumpsys notification --noredact` 能读到 EXTRA_TITLE/EXTRA_TEXT；
 * - WeChat 的通知标题 = 联系人或群名称（白名单按标题匹配）。
 *
 * 本项目的运行环境没有安卓设备，所以这个文件只做静态实现，单测全部注入 fake
 * CommandRunner（见 test/channels/phone-adb.test.ts）；真实可运行性需要在手机上
 * 校准坐标（sendButton / stickerButton / stickerGrid）与输入法。
 *
 * 收的消息来源是系统通知，不是微信内部数据库：因此拿不到稳定的 msgId，
 * 去重键由「postedTime + 标题 + 正文」组成——同一通知重复 dump 不会重复投递，
 * 但用户连发两条完全相同的短消息且系统没给新 postedTime 时有极小概率被折叠。
 */

import { execFile } from 'node:child_process'
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
  RiskSignal,
  SendResult,
} from '../types.ts'
import type { ChannelDeps } from './channel.ts'
import { detectChannelRisk } from './risk.ts'

/** 统一的 adb 命令执行器（测试注入 fake）。 */
export interface CommandRunner {
  (args: string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface PhoneAdbChannelOptions {
  config: WechatPersonaConfig
  deps: ChannelDeps
  /** 覆盖 adb 执行器；默认用 node:child_process.execFile 调 adbPath。 */
  run?: CommandRunner
}

/** 微信包名兜底：即便 config 里 packageName 被改坏，也认 com.tencent.mm。 */
const WECHAT_PACKAGE = 'com.tencent.mm'

/** 内存里去重集合上限。 */
const MAX_SEEN = 10_000

/** 点开表情面板后等待面板动画/加载的时间。 */
const STICKER_PANEL_DELAY_MS = 300

/** 通知键值行：android.title=String (张三)、EXTRA_TEXT=... 等。 */
const TITLE_LINE_RE = /^\s*(?:android\.title|EXTRA_TITLE|mTitle|title)\s*=\s*(.+?)\s*$/
const TEXT_LINE_RE = /^\s*(?:android\.text|EXTRA_TEXT|mText|text|bigText)\s*=\s*(.+?)\s*$/
const PACKAGE_RE = /\b(?:pkg|packageName)=([\w.]+)/
const POSTED_TIME_RE = /\bpostedTime=(\d+)/
const RECORD_START_RE = /NotificationRecord\s*\(/

interface NotificationRecord {
  packageName: string
  title: string
  text: string
  postedTime: string
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 从 `String (张三)` / `"张三"` 之类的 dump 形式里取可读文本。 */
function normalizeValue(raw: string): string {
  let value = raw.trim()
  if (!value) return ''
  const wrapped = /^(?:String|CharSequence|SpannableString|Spanned|CharSequence\[\]|String\[\])\s*\((.*)\)$/s.exec(value)
  if (wrapped) value = wrapped[1]!.trim()
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1)
  }
  return value.replace(/\\n/g, '\n').trim()
}

/** 解析 dumpsys notification 输出，只保留微信包的通知记录。 */
export function parseWechatNotifications(
  output: string,
  packageName: string,
): NotificationRecord[] {
  const packages = new Set<string>([WECHAT_PACKAGE])
  if (typeof packageName === 'string' && packageName.trim()) packages.add(packageName.trim())

  const records: NotificationRecord[] = []
  const lines = output.split(/\r?\n/)
  let block: string[] = []
  let inRecord = false

  const flush = (): void => {
    if (!inRecord || block.length === 0) {
      block = []
      return
    }
    const body = block.join('\n')
    const pkg = PACKAGE_RE.exec(body)?.[1] ?? PACKAGE_RE.exec(block[0] ?? '')?.[1] ?? ''
    if (pkg && packages.has(pkg)) {
      const titleLine = block.map((line) => TITLE_LINE_RE.exec(line)).find((m) => m !== null)
      const textLines = block.map((line) => TEXT_LINE_RE.exec(line)).filter((m) => m !== null)
      const text = textLines
        .map((m) => normalizeValue(m![1]!))
        .filter((value) => value.length > 0)
        .join(' ')
      const postedTime = POSTED_TIME_RE.exec(body)?.[1] ?? ''
      const title = titleLine ? normalizeValue(titleLine[1]!) : ''
      if (title || text) {
        records.push({ packageName: pkg, title, text, postedTime })
      }
    }
    block = []
  }

  for (const line of lines) {
    if (RECORD_START_RE.test(line)) {
      flush()
      inRecord = true
      block = [line]
      continue
    }
    if (!inRecord) continue
    // 非缩进行视为上一个记录的结束（dumpsys 的记录都是缩进块）。
    if (!/^\s/.test(line) && line.trim() !== '') {
      flush()
      inRecord = false
      continue
    }
    block.push(line)
  }
  flush()
  return records
}

/** 白名单匹配：标题（通知里就是联系人/群名）命中 id / name / aliases。 */
function matchWhitelist(
  config: WechatPersonaConfig,
  name: string,
): WechatPersonaConfig['whitelist'][number] | null {
  const wanted = name.trim()
  if (!wanted) return null
  for (const entry of config.whitelist ?? []) {
    const identifiers = [entry.id, entry.name, ...(entry.aliases ?? [])]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
    if (identifiers.includes(wanted)) return entry
  }
  return null
}

function stableId(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  return `adb-${(hash >>> 0).toString(36)}`
}

/**
 * `input text` 的字符转义：空格必须写成 %s，其余 shell 特殊字符用反斜杠转义。
 * 注意：中文等非 ASCII 字符在 `input text` 里不可靠（很多 ROM 会直接吞掉），
 * 所以默认走 ADBKeyboard 广播；tap-keys 只作为没有 ADBKeyboard 时的降级方案。
 */
function escapeInputText(text: string): string {
  return text
    .split('')
    .map((char) => {
      if (char === ' ') return '%s'
      if ('&<>|;()$`\\"\''.includes(char)) return `\\${char}`
      return char
    })
    .join('')
}

export class PhoneAdbChannel implements Channel {
  readonly id = 'phone-adb' as const

  private readonly config: WechatPersonaConfig
  private readonly deps: ChannelDeps
  private readonly logger: Logger
  private readonly adbPath: string
  private readonly serial: string
  private readonly packageName: string
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number
  private readonly run: CommandRunner

  private handler: InboundHandler | null = null
  private riskHandler: RiskHandler | null = null
  private stopped = true
  private loop: Promise<void> | null = null
  private readonly seenInbound = new Set<string>()
  private readonly seenRisks = new Set<string>()
  private opChain: Promise<unknown> = Promise.resolve()
  private stateInfo: ChannelStatus

  constructor(opts: PhoneAdbChannelOptions) {
    this.config = opts.config
    this.deps = opts.deps
    this.logger = opts.deps.logger
    const cfg = opts.config.channels.phoneAdb
    this.adbPath = (cfg.adbPath || 'adb').trim()
    this.serial = (cfg.serial ?? '').trim()
    this.packageName = (cfg.packageName || WECHAT_PACKAGE).trim()
    this.pollIntervalMs = Math.max(1000, Math.round(cfg.pollIntervalMs || 3000))
    this.timeoutMs = Math.max(1000, Math.round(cfg.commandTimeoutMs || 15000))
    this.run = opts.run ?? this.defaultRunner()
    this.stateInfo = {
      id: 'phone-adb',
      state: 'stopped',
      since: opts.deps.clock.now(),
      detail: this.serial ? `adb serial=${this.serial}` : 'adb 自动选择设备',
    }
  }

  /** 默认执行器：execFile(adbPath, args)，超时后杀进程，stdout/stderr 按 utf8 解码。 */
  private defaultRunner(): CommandRunner {
    const adbPath = this.adbPath
    return (args, opts) =>
      new Promise((resolve) => {
        execFile(
          adbPath,
          args,
          { timeout: opts?.timeoutMs ?? this.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            const code = typeof (error as { code?: unknown } | null)?.code === 'number'
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0
            resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
          },
        )
      })
  }

  async start(handler: InboundHandler, onRisk: RiskHandler): Promise<void> {
    this.handler = handler
    this.riskHandler = onRisk
    if (!this.stopped) return
    this.stopped = false
    this.setState('starting', this.stateInfo.detail)
    this.logger.info(`[phone-adb] 启动：adbPath=${this.adbPath} serial=${this.serial || '(auto)'}`)
    // 不阻塞：健康检查与轮询都在后台循环里，失败只改状态并继续重试。
    this.loop = this.runLoop()
    this.loop.catch((error) => {
      this.noteError(error)
      this.logger.error(`[phone-adb] 后台循环异常退出：${errorMessage(error)}`)
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.handler = null
    this.riskHandler = null
    // 不 await 循环：它可能在 sleep 中，下一个 tick 发现 stopped 后自行退出。
    this.loop = null
    this.setState('stopped', this.stateInfo.detail)
    this.logger.info('[phone-adb] 已停止')
  }

  /** Channel 契约方法：返回快照。 */
  status(): ChannelStatus {
    return { ...this.stateInfo }
  }

  async send(contactId: string, part: OutboundPart): Promise<SendResult> {
    if (this.stopped) return { ok: false, error: '通道未启动' }
    try {
      return await this.serialize(() => this.doSend(contactId, part))
    } catch (error) {
      const message = errorMessage(error)
      this.stateInfo.lastError = message
      this.logger.warn(`[phone-adb] 发送异常：${message}`)
      return { ok: false, error: message }
    }
  }

  /** 排障用截图：默认禁用；启用后也不写日志、不进模型上下文。 */
  async captureScreenshot(): Promise<{ ok: boolean; pngBase64?: string; error?: string; savedAs?: string }> {
    if (!this.config.channels.phoneAdb.allowScreenshot) {
      return { ok: false, error: '截图未启用（channels.phoneAdb.allowScreenshot=false）' }
    }
    try {
      const data = await this.serialize(() => this.execBinary(['exec-out', 'screencap', '-p']))
      if (data.code !== 0) return { ok: false, error: `adb screencap 失败(code=${data.code})` }
      const pngBase64 = data.stdout.trim()
      if (!pngBase64) return { ok: false, error: 'adb screencap 返回空数据' }
      const savedAs = `screenshots/phone-adb-${this.deps.clock.now()}.png.b64`
      try {
        await this.deps.store.write(savedAs, pngBase64)
      } catch (error) {
        this.logger.warn(`[phone-adb] 截图落盘失败（仅内存排查）：${errorMessage(error)}`)
        return { ok: true, pngBase64 }
      }
      this.logger.debug(`[phone-adb] 截图已保存（base64）：${savedAs}`)
      return { ok: true, pngBase64, savedAs }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  // ── 内部：循环 / 健康检查 / 收通知 ────────────────────────────────

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const device = await this.serialize(() => this.checkHealth())
        if (!device.ok) {
          this.setState('error', device.error)
          this.stateInfo.lastError = device.error ?? 'adb 不可用'
          this.logger.warn(`[phone-adb] ${device.error ?? 'adb 不可用'}；${this.pollIntervalMs}ms 后重试`)
        } else {
          if (this.stateInfo.state === 'error' || this.stateInfo.state === 'degraded' || this.stateInfo.state === 'starting') {
            this.setState('running', this.stateInfo.detail)
            this.logger.info('[phone-adb] adb 就绪，开始轮询通知')
          }
          await this.serialize(() => this.pollNotificationsOnce())
          if (this.stateInfo.state === 'degraded') this.setState('running', this.stateInfo.detail)
        }
      } catch (error) {
        this.noteError(error)
      }
      if (this.stopped) break
      try {
        await this.deps.clock.sleep(this.pollIntervalMs)
      } catch {
        // sleep 被中断（AbortSignal 等）按停止处理。
        break
      }
    }
  }

  /** `adb devices` 健康检查：解析第一台 state=device 的设备。 */
  private async checkHealth(): Promise<{ ok: boolean; serial?: string; error?: string }> {
    const result = await this.exec(['devices'])
    if (result.code !== 0) {
      return { ok: false, error: `adb devices 失败(code=${result.code})：${(result.stderr || result.stdout).trim().slice(0, 200)}` }
    }
    const devices: string[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('List of devices')) continue
      const [serial, state] = trimmed.split(/\s+/)
      if (!serial || !state) continue
      if (state === 'device') devices.push(serial)
      else this.logger.debug(`[phone-adb] 忽略设备 ${serial}（state=${state}）`)
    }
    if (this.serial) {
      if (!devices.includes(this.serial)) {
        return { ok: false, error: `未找到配置的 adb 设备 serial=${this.serial}（已连接：${devices.join(', ') || '无'}）` }
      }
      return { ok: true, serial: this.serial }
    }
    if (devices.length === 0) {
      return { ok: false, error: 'adb 未发现可用设备，请检查 USB 连接与 USB 调试开关' }
    }
    if (devices.length > 1) {
      return { ok: false, error: `检测到多台 adb 设备（${devices.join(', ')}），请配置 channels.phoneAdb.serial` }
    }
    return { ok: true, serial: devices[0] }
  }

  private async pollNotificationsOnce(): Promise<void> {
    let result = await this.exec(['shell', 'dumpsys', 'notification', '--noredact'])
    if (result.code !== 0 || result.stdout.trim() === '') {
      // 部分 ROM 上 dumpsys 受限，降级尝试 cmd notification（格式可能不同，解析尽力而为）。
      this.logger.debug('[phone-adb] dumpsys notification 不可用，尝试 cmd notification')
      result = await this.exec(['shell', 'cmd', 'notification'])
    }
    if (result.code !== 0) {
      this.stateInfo.lastError = `读取通知失败(code=${result.code})`
      this.setState('degraded', this.stateInfo.detail)
      this.logger.warn(`[phone-adb] ${this.stateInfo.lastError}`)
      return
    }
    const records = parseWechatNotifications(result.stdout, this.packageName)
    this.consumeRecords(records)
  }

  private consumeRecords(records: NotificationRecord[]): void {
    for (const record of records) {
      if (this.stopped) return
      const combined = [record.title, record.text].filter(Boolean).join('\n')
      if (!combined) continue

      // 风控优先：即使标题不在白名单，也要把风控信号报给引擎。
      const risk: RiskSignal | null = detectChannelRisk(combined, this.config)
      if (risk) {
        const key = `${record.postedTime}|${record.title}|${risk.matched}`
        if (!this.seenRisks.has(key)) {
          this.remember(this.seenRisks, key)
          this.logger.warn(`[phone-adb] 检测到风控文案 kind=${risk.kind} title=${record.title}`)
          this.riskHandler?.(risk)
        }
        continue
      }

      const matched = matchWhitelist(this.config, record.title)
      if (!matched || !record.text) continue

      const key = `${record.postedTime}|${record.title}|${record.text}`
      if (this.seenInbound.has(key)) continue
      this.remember(this.seenInbound, key)

      const message: InboundMessage = {
        id: stableId(key),
        contactId: matched.id || matched.name || record.title,
        contactName: record.title,
        chatType: 'single',
        kind: 'text',
        text: record.text,
        receivedAt: record.postedTime ? Number(record.postedTime) : this.deps.clock.now(),
      }
      this.stateInfo.lastInboundAt = this.deps.clock.now()
      this.logger.debug(`[phone-adb] 投递入站 contact=${message.contactName}`)
      this.handler?.(message)
    }
  }

  // ── 内部：发送 ────────────────────────────────────────────────────

  private async doSend(contactId: string, part: OutboundPart): Promise<SendResult> {
    if (part.kind === 'sticker') return this.sendSticker(contactId, part)
    const result = await this.sendText(contactId, part.text)
    if (result.ok) this.stateInfo.lastSendAt = this.deps.clock.now()
    return result
  }

  private async sendText(contactId: string, text: string): Promise<SendResult> {
    if (!text) return { ok: false, error: '空文本不发送' }
    const cfg = this.config.channels.phoneAdb

    try {
      if (cfg.inputMethod === 'tap-keys') {
        // 逐字符 input text：慢，且中文在多数 ROM 上不可用（仅 ASCII 兜底）。
        for (const char of text) {
          const result = await this.exec(['shell', 'input', 'text', escapeInputText(char)])
          if (result.code !== 0) return { ok: false, error: `input text 失败(code=${result.code})` }
        }
      } else {
        // ADBKeyboard 广播：base64(utf8) 交给 AdbIME，中文可靠。
        const payload = Buffer.from(text, 'utf8').toString('base64')
        const result = await this.exec([
          'shell',
          'am',
          'broadcast',
          '-a',
          'ADB_INPUT_B64',
          '--es',
          'msg',
          payload,
        ])
        if (result.code !== 0) {
          return { ok: false, error: `ADB_INPUT_B64 广播失败(code=${result.code})；请确认已安装 ADBKeyboard 并切换到 AdbIME` }
        }
        const combined = `${result.stdout}\n${result.stderr}`
        if (/\bError\b|Exception|Unable to resolve|not found/i.test(combined)) {
          return { ok: false, error: `ADB_INPUT_B64 广播未完成：${combined.trim().slice(0, 200)}` }
        }
      }

      if (cfg.sendButton) {
        const tap = await this.exec(['shell', 'input', 'tap', String(cfg.sendButton.x), String(cfg.sendButton.y)])
        if (tap.code !== 0) return { ok: false, error: `点击发送按钮失败(code=${tap.code})` }
      } else {
        // 回车键发送（微信默认设置下 Enter 即发送）。
        const key = await this.exec(['shell', 'input', 'keyevent', '66'])
        if (key.code !== 0) return { ok: false, error: `keyevent 66 失败(code=${key.code})` }
      }
      this.logger.debug(`[phone-adb] 已发送文本给 ${contactId}（${text.length} 字）`)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  private async sendSticker(contactId: string, part: Extract<OutboundPart, { kind: 'sticker' }>): Promise<SendResult> {
    const cfg = this.config.channels.phoneAdb
    if (!cfg.stickerButton || !Array.isArray(cfg.stickerGrid) || cfg.stickerGrid.length === 0) {
      return { ok: false, error: 'sticker 坐标未配置' }
    }
    try {
      const open = await this.exec([
        'shell',
        'input',
        'tap',
        String(cfg.stickerButton.x),
        String(cfg.stickerButton.y),
      ])
      if (open.code !== 0) return { ok: false, error: `点击表情按钮失败(code=${open.code})` }
      await this.deps.clock.sleep(STICKER_PANEL_DELAY_MS)
      const index = Math.floor(Math.random() * cfg.stickerGrid.length)
      const cell = cfg.stickerGrid[index]!
      const tap = await this.exec(['shell', 'input', 'tap', String(cell.x), String(cell.y)])
      if (tap.code !== 0) return { ok: false, error: `点击表情格子失败(code=${tap.code})` }
      this.logger.debug(`[phone-adb] 已发送表情给 ${contactId}（格子 #${index}）`)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  // ── 内部：命令 ────────────────────────────────────────────────────

  private adbArgs(args: string[]): string[] {
    return this.serial ? ['-s', this.serial, ...args] : args
  }

  private async exec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.run(this.adbArgs(args), { timeoutMs: this.timeoutMs })
  }

  /** 二进制安全的一次性执行（只用于排障截图，默认 utf8 执行器不适用）。 */
  private async execBinary(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        this.adbPath,
        this.adbArgs(args),
        { timeout: this.timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'base64', windowsHide: true },
        (error, stdout, stderr) => {
          const code = typeof (error as { code?: unknown } | null)?.code === 'number'
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        },
      )
    })
  }

  /** 串行化所有 adb 交互，避免并发 tap / 广播交错。 */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(task, task)
    this.opChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private remember(bucket: Set<string>, key: string): void {
    bucket.add(key)
    if (bucket.size <= MAX_SEEN) return
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
    this.setState('degraded', this.stateInfo.detail)
    this.logger.warn(`[phone-adb] ${message}`)
  }
}

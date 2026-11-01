/**
 * desktop 生产链路端到端离线用例（task-23 第 3 项，任务书 §4 的 12 类场景）。
 *
 * 约束：全部使用注入式脚本 runner + 内存 store + 假时钟/假 LLM；
 * 不启动真实微信、不截图、不点击、不发送任何真实消息。
 *
 * 覆盖：
 *  1. 同一消息连续识别 10 次只交付 1 次
 *  2. 连发两条相同文本算两条
 *  3. OCR 错→对（同一 id）不重复投递
 *  4. 滚动/重放后旧消息不重复投递
 *  5. 重启后 pending/delivered 恢复不重放
 *  6. 相似昵称/长消息/左右气泡不误归属
 *  7. 不同联系人会话不混合
 *  8. 置信度冲突不得直接自动发送（且不丢消息）
 *  9. unknown 投递不盲目重发
 * 10. 生成中暂停 / 切只读后不再发送
 * 11. 只读测试模式：所有对外发送接口从代码层拒绝（engine/desktop/草稿/旧队列/脚本路径），mock 仍空转
 * 12. 依赖失败（PS1/OCR/磁盘/LLM）安全降级
 */

import { describe, expect, it } from 'vitest'

import {
  DesktopChannel,
  type DesktopScriptName,
  type DesktopScriptResult,
  type DesktopScriptRunner,
} from '../../src/channels/pc/desktop.ts'
import { defaultConfig, type WechatPersonaConfig } from '../../src/config.ts'
import { MemoryStore } from '../../src/core/memory.ts'
import { PersonaEngine } from '../../src/engine/engine.ts'
import type {
  AuditEvent,
  AuditEventType,
  AuditLogLike,
  AuditSummary,
  Channel,
  ChannelId,
  ChannelState,
  ChannelStatus,
  Clock,
  FileStoreLike,
  InboundHandler,
  InboundMessage,
  LlmLike,
  LlmRequest,
  LlmResult,
  Logger,
  Notifier,
  OutboundPart,
  PersonaPack,
  Random,
  RiskHandler,
  RuntimeState,
  SendResult,
  StickerCatalogLike,
  WechatPersonaConfig as _WechatPersonaConfigAlias,
} from '../../src/types.ts'
import { makeConfig, makeDeps, waitFor, MemoryFileStore, type TestDeps } from './helpers.ts'

/* ────────────────────────── 桌面脚本假数据 ────────────────────────── */

interface ScriptCall {
  script: DesktopScriptName
  args: string[]
}

interface RecordingRunner {
  runner: DesktopScriptRunner
  calls: ScriptCall[]
}

function recordRunner(
  handler: (script: DesktopScriptName, args: string[]) => DesktopScriptResult | Promise<DesktopScriptResult>,
): RecordingRunner {
  const calls: ScriptCall[] = []
  const runner: DesktopScriptRunner = async (script, args) => {
    calls.push({ script, args })
    return handler(script, args)
  }
  return { runner, calls }
}

const USER_IDLE: DesktopScriptResult = { code: 0, stdout: '60000', stderr: '' }
const UIA_OK: DesktopScriptResult = { code: 0, stdout: '{"ok":true}', stderr: '' }

function listResult(rows: unknown[]): DesktopScriptResult {
  return { code: 0, stdout: JSON.stringify({ ok: true, rows }), stderr: '' }
}

function listRow(name: string, options: { unread?: boolean; preview?: string; selected?: boolean; top?: number } = {}): Record<string, unknown> {
  return {
    name,
    found: true,
    unread: options.unread ?? true,
    preview: options.preview ?? '',
    top: options.top ?? 100,
    left: 160,
    height: 80,
    selected: options.selected ?? false,
  }
}

const PANE = { left: 360, right: 1194, top: 80, bottom: 720 }

interface MsgSpec {
  id: string
  text: string
  box?: { x: number; y: number; width: number; height: number }
  side?: 'left' | 'right' | 'unknown'
  confidence?: number
  merged?: number
  agreement?: 'agree' | 'conflict' | 'single'
  status?: string
}

function leftBox(index: number, text: string): { x: number; y: number; width: number; height: number } {
  const width = Math.min(320, Math.max(120, 12 + [...text].length * 15))
  return { x: 378, y: 120 + index * 40, width, height: 28 }
}

function rightBox(index: number): { x: number; y: number; width: number; height: number } {
  return { x: 850, y: 120 + index * 40, width: 260, height: 28 }
}

function readResult(options: {
  messages: MsgSpec[]
  captureId?: string
  pane?: { left: number; right: number; top: number; bottom: number }
  diag?: Record<string, unknown>
  engines?: string[]
  ok?: boolean
  error?: string
}): DesktopScriptResult {
  const messages = options.messages.map((message, index) => {
    const box = message.box ?? (message.side === 'right' ? rightBox(index) : leftBox(index, message.text))
    return {
      id: message.id,
      text: message.text,
      side: message.side,
      box,
      ...(message.confidence === undefined ? {} : { confidence: message.confidence }),
      ...(message.merged === undefined ? {} : { merged: message.merged }),
      ...(message.agreement === undefined ? {} : { agreement: message.agreement }),
      ...(message.status === undefined ? {} : { status: message.status }),
    }
  })
  return {
    code: 0,
    stdout: JSON.stringify({
      ok: options.ok ?? true,
      ...(options.error === undefined ? {} : { error: options.error }),
      ...(options.captureId === undefined ? {} : { captureId: options.captureId }),
      ...(options.pane === undefined ? {} : { pane: options.pane }),
      ...(options.engines === undefined ? {} : { engines: options.engines }),
      ...(options.diag === undefined ? {} : { diag: options.diag }),
      messages,
    }),
    stderr: '',
  }
}

/* ────────────────────────── 桌面通道 harness ────────────────────────── */

const CONTACT_ZHANGSAN = { id: 'wxid_zhangsan', name: '张三', aliases: [], note: '' }

interface DesktopE2EHarness {
  channel: DesktopChannel
  deps: TestDeps
  config: WechatPersonaConfig
  messages: InboundMessage[]
  recorder: RecordingRunner
  start(): Promise<void>
  stop(): Promise<void>
}

function makeDesktopE2EHarness(options: {
  runScript: DesktopScriptRunner
  store?: MemoryFileStore
  contacts?: Array<{ id: string; name: string; aliases: string[]; note: string }>
  pollIntervalMs?: number
  configPatch?: (config: WechatPersonaConfig) => void
}): DesktopE2EHarness {
  const deps = makeDeps(options.store)
  const contacts = options.contacts ?? [CONTACT_ZHANGSAN]
  const config = makeConfig((cfg) => {
    cfg.enabled = true
    cfg.activeChannel = 'desktop'
    cfg.whitelist = contacts
    cfg.channels.desktop.enabled = true
    cfg.channels.desktop.driverEnabled = true
    cfg.channels.desktop.userActivityIdleMs = 5000
    cfg.channels.desktop.pauseSeconds = 30
    if (options.configPatch) options.configPatch(cfg)
  })
  const recorder = recordRunner(options.runScript)
  const channel = new DesktopChannel({
    config,
    deps,
    runScript: recorder.runner,
    pollIntervalMs: options.pollIntervalMs ?? 20,
  })
  const messages: InboundMessage[] = []
  return {
    channel,
    deps,
    config,
    messages,
    recorder,
    start: async () => {
      await channel.start((message) => messages.push(message))
    },
    stop: async () => {
      await channel.stop()
    },
  }
}

/* ────────────────────────── 引擎侧假依赖（仅本地定义，不触网） ────────────────────────── */

const ENGINE_NOW = new Date('2026-11-01T12:00:00+08:00').getTime()

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const PERSONA: PersonaPack = {
  name: '小号',
  systemPrompt: '你是一个普通年轻人，短句口语化，不客服腔。',
  examples: [{ user: '在干嘛', assistant: '躺着刷视频，你呢' }],
  sourceDir: 'C:/fake-persona',
}

class E2EClock implements Clock {
  private current: number
  readonly sleeps: number[] = []
  onSleep: ((ms: number) => void | Promise<void>) | null = null
  constructor(initial: number = ENGINE_NOW) {
    this.current = initial
  }
  now(): number {
    return this.current
  }
  async sleep(ms: number, _signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms)
    this.current += ms
    if (this.onSleep) await this.onSleep(ms)
  }
  advance(ms: number): void {
    this.current += ms
  }
}

class E2ERandom implements Random {
  private index = 0
  private readonly values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
  next(): number {
    const value = this.values[this.index % this.values.length] as number
    this.index += 1
    return value
  }
}

class E2EStore implements FileStoreLike {
  readonly root = 'C:/fake-e2e-data'
  private readonly files = new Map<string, string>()
  seed(rel: string, value: unknown): void {
    this.files.set(rel, JSON.stringify(value))
  }
  async read(rel: string): Promise<string | null> {
    return this.files.get(rel) ?? null
  }
  async readJson<T>(rel: string): Promise<T | null> {
    const text = this.files.get(rel)
    if (!text) return null
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }
  async write(rel: string, text: string): Promise<void> {
    this.files.set(rel, text)
  }
  async writeJson(rel: string, value: unknown): Promise<void> {
    this.files.set(rel, JSON.stringify(value))
  }
  async append(rel: string, text: string): Promise<void> {
    this.files.set(rel, (this.files.get(rel) ?? '') + text)
  }
  async remove(rel: string): Promise<void> {
    this.files.delete(rel)
  }
  async removeTree(relDir: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === relDir || key.startsWith(`${relDir}/`)) this.files.delete(key)
    }
  }
  async list(relDir: string): Promise<string[]> {
    const prefix = relDir.endsWith('/') ? relDir : `${relDir}/`
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
  }
}

class E2EChannel implements Channel {
  readonly id: ChannelId
  readonly capabilities = { stickers: false, images: false, voice: false }
  readonly sent: OutboundPart[] = []
  readonly sendResults: SendResult[] = []
  startCalls = 0
  stopCalls = 0
  handler: InboundHandler | null = null
  constructor(id: ChannelId = 'mock') {
    this.id = id
  }
  async start(handler: InboundHandler, _onRisk: RiskHandler): Promise<void> {
    this.startCalls += 1
    this.handler = handler
  }
  async stop(): Promise<void> {
    this.stopCalls += 1
  }
  async send(_contactId: string, part: OutboundPart, _signal?: AbortSignal): Promise<SendResult> {
    this.sent.push(part)
    const next = this.sendResults.shift()
    return next ?? { ok: true, delivery: 'sent', operationId: 'op-e2e' }
  }
  status(): ChannelStatus {
    return { id: this.id, state: 'running' as ChannelState, since: ENGINE_NOW }
  }
}

class E2ELlm implements LlmLike {
  readonly calls: LlmRequest[] = []
  failuresLeft = 0
  text = '哈哈，刚在追剧，你呢？'
  async complete(request: LlmRequest): Promise<LlmResult> {
    this.calls.push(request)
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1
      throw new Error('llm-unavailable')
    }
    return {
      text: this.text,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      finishReason: 'stop',
    }
  }
}

class E2EAudit implements AuditLogLike {
  readonly events: AuditEvent[] = []
  async record(event: Omit<AuditEvent, 'ts'> & { ts?: number }): Promise<void> {
    this.events.push({ ...event, ts: event.ts ?? ENGINE_NOW } as AuditEvent)
  }
  async recent(n: number): Promise<AuditEvent[]> {
    return this.events.slice(-n)
  }
  async summary(): Promise<AuditSummary> {
    return { dayKey: '2026-11-01', llmCalls: 0, llmTokens: 0, skips: {}, sends: 0 } as unknown as AuditSummary
  }
  async clear(): Promise<void> {
    this.events.length = 0
  }
  reasons(type: AuditEventType): string[] {
    return this.events.filter((event) => event.type === type).map((event) => String(event.reason ?? ''))
  }
}

const noStickers: StickerCatalogLike = {
  categories: () => [],
  count: () => 0,
  pick: () => null,
  pickAny: () => null,
}

function makeRuntimeState(now: number): RuntimeState {
  return {
    version: 1,
    paused: false,
    breaker: { tripped: false },
    budget: { dayKey: '2026-11-01', spentTokens: 0 },
    rate: {},
    seen: {},
    stats: {
      llmCalls: 0,
      llmTokens: 0,
      drafts: 0,
      sends: 0,
      skips: 0,
      errors: 0,
      searchDayKey: '2026-11-01',
      searchDayCount: 0,
      searches: 0,
      startedAt: now,
      summaryDayKey: '2026-11-01',
      summaryCalls: 0,
    },
  }
}

function makeEngineConfig(overrides: (config: WechatPersonaConfig) => void = () => {}): WechatPersonaConfig {
  const config = defaultConfig()
  config.whitelist = [CONTACT_ZHANGSAN]
  config.stickers.maxPerReply = 0
  overrides(config)
  return config
}

interface EngineE2EHarness {
  engine: PersonaEngine
  config: WechatPersonaConfig
  clock: E2EClock
  channel: E2EChannel
  llm: E2ELlm
  audit: E2EAudit
  store: E2EStore
  state: RuntimeState
}

function makeEngineE2EHarness(options: {
  configPatch?: (config: WechatPersonaConfig) => void
  channelId?: ChannelId
  store?: E2EStore
} = {}): EngineE2EHarness {
  const config = makeEngineConfig(options.configPatch)
  const clock = new E2EClock()
  const random = new E2ERandom()
  const store = options.store ?? new E2EStore()
  const channel = new E2EChannel(options.channelId ?? 'mock')
  const llm = new E2ELlm()
  const audit = new E2EAudit()
  const state = makeRuntimeState(ENGINE_NOW)
  const memory = new MemoryStore({ store, config, clock, logger: silentLogger })
  const engine = new PersonaEngine({
    config,
    logger: silentLogger,
    clock,
    random,
    store,
    channel,
    llm,
    search: null,
    notifier: { notify: async () => {} },
    state,
    audit,
    memory,
    stickers: noStickers,
    persona: PERSONA,
    saveState: async () => {},
  })
  return { engine, config, clock, channel, llm, audit, store, state }
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'pc-1-1-e2e',
    contactId: 'wxid_zhangsan',
    contactName: '张三',
    chatType: 'single',
    kind: 'text',
    text: '在吗',
    receivedAt: ENGINE_NOW,
    ...overrides,
  }
}

function callsWith(recorder: RecordingRunner, script: DesktopScriptName, needle: string): ScriptCall[] {
  return recorder.calls.filter((call) => call.script === script && call.args.includes(needle))
}

/* ────────────────────────── 12 类端到端场景 ────────────────────────── */

describe('desktop 生产链路端到端离线用例（任务书 §4）', () => {
  it('1) 同一消息连续识别 10 次：只交付 1 次，且请求带 ack 水位线、不带 -MaxMessages', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow('张三', { unread: true, preview: '' })])
      return readResult({ captureId: 'cap-1', messages: [{ id: 'pc-1-1-abcd', text: '在吗' }] })
    })
    const harness = makeDesktopE2EHarness({ runScript: recorder.runner })
    await harness.start()

    await waitFor(() => callsWith(recorder, 'wechat-uia', 'read').length >= 10, { label: '连续读取 10 帧', timeoutMs: 4000 })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.id).toBe('pc-1-1-abcd')
    const readCalls = callsWith(recorder, 'wechat-uia', 'read')
    expect(readCalls.every((call) => !call.args.includes('-MaxMessages'))).toBe(true)
    // 首次交付成功后写入 ack 水位线；后续请求必须回传 -Ack cap-1。
    expect(readCalls.some((call) => call.args.includes('-Ack') && call.args.includes('cap-1'))).toBe(true)
    await harness.stop()
  })

  it('2) 连发两条相同文本：算两条（预览回退路径也不得只投最后一条）', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow('张三', { unread: true, preview: '在吗' })])
      // 一旦收到 ack 水位线，脚本侧的 pending 已被丢弃（真实 PS1 行为）。
      if (args.includes('-Ack') && args.includes('cap-1')) {
        return readResult({ captureId: 'cap-2', messages: [] })
      }
      return readResult({
        captureId: 'cap-1',
        messages: [
          { id: 'pc-1-1-aaaa', text: '在吗' },
          { id: 'pc-1-2-bbbb', text: '在吗' },
        ],
      })
    })
    const harness = makeDesktopE2EHarness({ runScript: recorder.runner })
    await harness.start()

    await waitFor(() => harness.messages.length >= 2, { label: '两条同文都交付', timeoutMs: 3000 })
    expect(harness.messages.map((message) => message.id)).toEqual(['pc-1-1-aaaa', 'pc-1-2-bbbb'])
    expect(harness.messages.map((message) => message.text)).toEqual(['在吗', '在吗'])
    await harness.stop()
  })

  it('3) OCR 错字→正确（同一 id）：不重复投递', async () => {
    let frame = 0
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow('张三', { unread: true, preview: '' })])
      frame += 1
      return readResult({
        captureId: `cap-${frame}`,
        messages: [{ id: 'pc-1-1-cccc', text: frame <= 1 ? '今天大吧鱼很好吃' : '今天大肥鱼很好吃' }],
      })
    })
    const harness = makeDesktopE2EHarness({ runScript: recorder.runner })
    await harness.start()

    await waitFor(() => harness.messages.length >= 1, { label: '首帧交付', timeoutMs: 3000 })
    await waitFor(() => callsWith(recorder, 'wechat-uia', 'read').length >= 5, { label: '继续识别 5 帧', timeoutMs: 4000 })
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.id).toBe('pc-1-1-cccc')
    await harness.stop()
  })

  it('4) 滚动/重放后旧消息（同 id）不再投递，新消息只交付一次', async () => {
    let phase = 0
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow('张三', { unread: true, preview: '' })])
      phase += 1
      if (phase <= 1) {
        return readResult({
          captureId: 'cap-1',
          messages: [
            { id: 'pc-1-1-old1', text: '第一条旧消息' },
            { id: 'pc-1-2-old2', text: '第二条旧消息' },
          ],
        })
      }
      if (phase <= 4) {
        // 模拟滚动后脚本把已交付的旧消息又重放回来（stored id 不变）。
        return readResult({
          captureId: `cap-${phase}`,
          messages: [
            { id: 'pc-1-1-old1', text: '第一条旧消息' },
            { id: 'pc-1-2-old2', text: '第二条旧消息' },
          ],
        })
      }
      return readResult({
        captureId: `cap-${phase}`,
        messages: [
          { id: 'pc-1-1-old1', text: '第一条旧消息' },
          { id: 'pc-1-2-old2', text: '第二条旧消息' },
          { id: 'pc-5-1-new1', text: '滚动后新消息' },
        ],
      })
    })
    const harness = makeDesktopE2EHarness({ runScript: recorder.runner })
    await harness.start()

    await waitFor(() => harness.messages.length >= 2, { label: '先交付两条旧消息', timeoutMs: 3000 })
    await waitFor(() => harness.messages.length >= 3, { label: '再交付新消息', timeoutMs: 4000 })
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(harness.messages).toHaveLength(3)
    const ids = harness.messages.map((message) => message.id)
    expect(ids).toEqual(['pc-1-1-old1', 'pc-1-2-old2', 'pc-5-1-new1'])
    await harness.stop()
  })

  it('5) 重启后 pending/delivered 恢复：不重放已投递消息，ack 从持久化恢复', async () => {
    const store = new MemoryFileStore()
    const contact = CONTACT_ZHANGSAN
    const firstRunner = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow(contact.name, { unread: true, preview: '' })])
      return readResult({ captureId: 'cap-7', messages: [{ id: 'pc-7-1-abcd', text: '重启前已投递' }] })
    })
    const first = makeDesktopE2EHarness({ runScript: firstRunner.runner, store })
    await first.start()
    await waitFor(() => first.messages.length >= 1, { label: '第一个实例投递', timeoutMs: 3000 })
    await waitFor(() => first.channel.status().state === 'running', { label: '通道运行中', timeoutMs: 3000 })
    await first.stop()

    const secondRecorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow(contact.name, { unread: true, preview: '' })])
      return readResult({
        captureId: 'cap-8',
        messages: [
          { id: 'pc-7-1-abcd', text: '重启前已投递' },
          { id: 'pc-8-1-efgh', text: '重启后新消息' },
        ],
      })
    })
    const second = makeDesktopE2EHarness({ runScript: secondRecorder.runner, store })
    await second.start()
    await waitFor(() => second.messages.length >= 1, { label: '第二个实例只投递新消息', timeoutMs: 4000 })
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(second.messages.map((message) => message.id)).toEqual(['pc-8-1-efgh'])
    const secondReads = callsWith(secondRecorder, 'wechat-uia', 'read')
    // 持久化的 ack 水位线必须回传给脚本，让脚本侧 pending 可以安全丢弃。
    expect(secondReads.some((call) => call.args.includes('-Ack') && call.args.includes('cap-7'))).toBe(true)
    const delivered = await store.readJson<{ ids?: string[] }>('desktop-delivered.json')
    expect(delivered?.ids ?? []).toContain('张三|pc-7-1-abcd')
    await second.stop()
  })

  it('6) 相似昵称/长消息/左右气泡：不误归属、不把 outbound/uncertain 当入站', async () => {
    const longText =
      '今天下班路上看到一只特别胖的橘猫，蹲在便利店门口一动不动，我蹲下来拍了它半天它都懒得理我，最后老板出来喊它回家吃饭，它才慢吞吞站起来，尾巴一甩一甩地走了'
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) {
        return listResult([
          listRow('张三', { unread: true, preview: '' }),
          listRow('张三丰', { unread: true, preview: '', top: 200 }),
        ])
      }
      const contactIndex = args.indexOf('-Contact')
      const contact = contactIndex >= 0 ? args[contactIndex + 1] : ''
      if (contact === '张三丰') {
        return readResult({
          captureId: 'cap-2',
          pane: PANE,
          messages: [{ id: 'pc-2-1-zsf', text: '我是张三丰，不是张三' }],
        })
      }
      return readResult({
        captureId: 'cap-1',
        pane: PANE,
        messages: [
          { id: 'pc-1-1-zs', text: '晚上一起吃火锅吗' },
          { id: 'pc-1-2-right', text: '这条是右侧自己发的', side: 'right' },
          // 他人长气泡越线（贴左但没有贴右、中心越过中线）→ 必须判 uncertain。
          { id: 'pc-1-3-uncertain', text: '越线长气泡：别人发的长消息可能贴着左边但延伸过中线', box: { x: 378, y: 400, width: 810, height: 28 } },
          { id: 'pc-1-4-long', text: longText },
        ],
      })
    })
    const harness = makeDesktopE2EHarness({
      runScript: recorder.runner,
      contacts: [CONTACT_ZHANGSAN, { id: 'wxid_b', name: '张三丰', aliases: [], note: '' }],
    })
    await harness.start()

    await waitFor(() => harness.messages.length >= 3, { label: '两侧会话都交付', timeoutMs: 4000 })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const zsTexts = harness.messages.filter((message) => message.contactName === '张三').map((message) => message.text)
    const zsfTexts = harness.messages.filter((message) => message.contactName === '张三丰').map((message) => message.text)
    expect(zsTexts).toContain('晚上一起吃火锅吗')
    expect(zsTexts).toContain(longText)
    expect(zsfTexts).toEqual(['我是张三丰，不是张三'])
    // outbound 气泡与越线 uncertain 都不能被当成入站消息投递。
    expect(zsTexts.some((text) => text.includes('右侧自己发的'))).toBe(false)
    expect(zsTexts.some((text) => text.includes('越线长气泡'))).toBe(false)
    const status = harness.channel.status() as ChannelStatus & { ocr?: { uncertainCount?: number } }
    expect(status.ocr?.uncertainCount ?? 0).toBeGreaterThanOrEqual(1)
    await harness.stop()
  })

  it('7) 不同联系人会话不混合：同一消息 id 在两个会话各自独立、contactId 正确', async () => {
    const contacts = [
      { id: 'wxid_zhangsan', name: '张三', aliases: [], note: '' },
      { id: 'wxid_lisi', name: '李四', aliases: [], note: '' },
    ]
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) {
        return listResult([listRow('张三', { unread: true, preview: '' }), listRow('李四', { unread: true, preview: '', top: 200 })])
      }
      const index = args.indexOf('-Contact')
      const contact = index >= 0 ? args[index + 1] : ''
      return readResult({
        captureId: `cap-${contact === '张三' ? '1' : '2'}`,
        pane: PANE,
        messages: [{ id: 'pc-shared-1', text: contact === '张三' ? '张三的话' : '李四的话' }],
      })
    })
    const harness = makeDesktopE2EHarness({ runScript: recorder.runner, contacts })
    await harness.start()

    await waitFor(() => harness.messages.length >= 2, { label: '两个会话各交付一条', timeoutMs: 4000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const byContact = new Map(harness.messages.map((message) => [message.contactName, message]))
    expect(harness.messages).toHaveLength(2)
    expect(byContact.get('张三')?.text).toBe('张三的话')
    expect(byContact.get('李四')?.text).toBe('李四的话')
    expect(byContact.get('张三')?.id).toBe('pc-shared-1')
    // 会话隔离：两个会话的文本不能互换。
    expect([...byContact.values()].some((message) => message.contactName === '张三' && message.text === '李四的话')).toBe(false)
    await harness.stop()
  })

  it('8) 置信度冲突：不直接投递、不推进 ack；下次同 id 恢复高置信后只投递一次', async () => {
    let phase = 0
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow('张三', { unread: true, preview: '' })])
      phase += 1
      if (phase <= 2) {
        return readResult({
          captureId: 'cap-1',
          pane: PANE,
          engines: ['winrt'],
          diag: { scale: 1.5, qualityStatus: 'degraded', conflictCount: 2, secondOcrUsed: true, screenshotMode: 'printwindow', dpi: 144 },
          messages: [{ id: 'pc-1-1-low', text: '在吗', confidence: 0.2, merged: 3, agreement: 'conflict' }],
        })
      }
      return readResult({
        captureId: 'cap-2',
        pane: PANE,
        engines: ['winrt', 'rapidocr'],
        diag: { scale: 2, qualityStatus: 'ok', conflictCount: 0, secondOcrUsed: true, screenshotMode: 'printwindow', dpi: 144 },
        messages: [{ id: 'pc-1-1-low', text: '在吗', confidence: 0.95, merged: 1, agreement: 'agree' }],
      })
    })
    const harness = makeDesktopE2EHarness({ runScript: recorder.runner })
    await harness.start()

    await waitFor(() => harness.channel.status().ocr?.rejectCount !== undefined && (harness.channel.status().ocr?.rejectCount ?? 0) > 0, {
      label: '低置信被拒并计数',
      timeoutMs: 4000,
    })
    expect(harness.messages).toHaveLength(0)
    const status = harness.channel.status() as ChannelStatus & { ocr?: { rejectCount?: number; uncertainCount?: number } }
    expect(status.ocr?.rejectCount ?? 0).toBeGreaterThanOrEqual(1)
    const rejectedReads = callsWith(recorder, 'wechat-uia', 'read')
    // 硬拒绝路径不该触发第二次引擎验证；也不该把 cap-1 记为已处理。
    expect(rejectedReads.every((call) => !call.args.includes('-SecondOcr'))).toBe(true)
    expect(rejectedReads.some((call) => call.args.includes('-Ack') && call.args.includes('cap-1'))).toBe(false)

    await waitFor(() => harness.messages.length >= 1, { label: '恢复高置信后重放投递', timeoutMs: 4000 })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.messages.map((message) => message.id)).toEqual(['pc-1-1-low'])
    await harness.stop()
  })

  it('9) unknown 投递：不盲目重发，同一入站重复触发也只发一次', async () => {
    const harness = makeEngineE2EHarness()
    harness.channel.sendResults.push({ ok: false, error: '发送后气泡未确认', delivery: 'unknown' })
    await harness.engine.start()
    await harness.engine.handleInbound(makeInbound())

    expect(harness.channel.sent).toHaveLength(1)
    const sendFails = harness.audit.events.filter((event) => event.type === 'send-fail')
    expect(sendFails.length).toBeGreaterThanOrEqual(1)
    const lastFail = sendFails[sendFails.length - 1] as { send?: { delivery?: string } }
    expect(lastFail.send?.delivery).toBe('unknown')
    expect((await harness.engine.status()).delivery.unknown).toBe(1)

    // 同一条入站消息再次触发：不得重发。
    await harness.engine.handleInbound(makeInbound())
    expect(harness.channel.sent).toHaveLength(1)
    await harness.engine.stop()
  })

  it('10) 生成中暂停 / 切只读：本轮回复不得继续发送', async () => {
    // 10a 拟人延迟中用户暂停
    const paused = makeEngineE2EHarness({ channelId: 'desktop' })
    await paused.engine.start()
    let flipped = false
    paused.clock.onSleep = async () => {
      if (flipped) return
      flipped = true
      await paused.engine.pause('e2e-user-pause')
    }
    await paused.engine.handleInbound(makeInbound())
    expect(paused.channel.sent).toHaveLength(0)
    expect(paused.audit.reasons('skip')).toContain('paused')
    await paused.engine.stop()

    // 10b 拟人延迟中配置被切到只读测试模式
    const readOnly = makeEngineE2EHarness({ channelId: 'desktop' })
    await readOnly.engine.start()
    readOnly.clock.onSleep = () => {
      readOnly.config.readOnlyTestMode = true
    }
    await readOnly.engine.handleInbound(makeInbound())
    expect(readOnly.channel.sent).toHaveLength(0)
    expect(readOnly.audit.reasons('skip')).toContain('read-only-mode')
    await readOnly.engine.stop()
  })

  it('11) 只读测试模式：engine/desktop/草稿/旧队列/脚本路径全部拒绝，mock 仍可空转', async () => {
    /* 11a mock 通道仍空转：只读只拦真实通道 */
    const mock = makeEngineE2EHarness({ configPatch: (config) => { config.readOnlyTestMode = true } })
    await mock.engine.start()
    await mock.engine.handleInbound(makeInbound())
    expect(mock.channel.sent).toHaveLength(1)

    /* 11b 真实 desktop 通道：完成 engine 级只读闭环 */
    const engineStore = new E2EStore()
    engineStore.seed('deferred-inbound.json', {
      version: 1,
      entries: [{ message: makeInbound({ id: 'pc-deferred-1', text: '暂停期间入队' }), deferredAt: ENGINE_NOW - 1000, reason: 'paused' }],
    })
    engineStore.seed('drafts.json', {
      version: 1,
      drafts: [
        {
          id: 'draft-1',
          opId: 'op-1',
          contactId: 'wxid_zhangsan',
          contactName: '张三',
          text: '草稿内容',
          createdAt: ENGINE_NOW - 1000,
          expiresAt: ENGINE_NOW + 3_600_000,
          status: 'pending',
          reason: 'draft-mode',
        },
      ],
    })

    const config = makeEngineConfig((cfg) => {
      cfg.readOnlyTestMode = true
      cfg.channels.desktop.enabled = true
      cfg.channels.desktop.driverEnabled = true
    })
    const msgStore = new MemoryFileStore()
    const deps = makeDeps(msgStore)
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow('张三', { unread: false, preview: '' })])
      return readResult({ captureId: 'cap-1', messages: [] })
    })
    const channel = new DesktopChannel({ config, deps, runScript: recorder.runner, pollIntervalMs: 20 })
    const sendCalls: string[] = []
    const originalSend = channel.send.bind(channel)
    channel.send = async (contactId, part, signal) => {
      sendCalls.push(contactId)
      return originalSend(contactId, part, signal)
    }
    const clock = new E2EClock()
    const audit = new E2EAudit()
    const engine = new PersonaEngine({
      config,
      logger: silentLogger,
      clock,
      random: new E2ERandom(),
      store: engineStore,
      channel,
      llm: new E2ELlm(),
      search: null,
      notifier: { notify: async () => {} },
      state: makeRuntimeState(ENGINE_NOW),
      audit,
      memory: new MemoryStore({ store: engineStore, config, clock, logger: silentLogger }),
      stickers: noStickers,
      persona: PERSONA,
      saveState: async () => {},
    })
    expect(config.readOnlyTestMode).toBe(true)
    expect((await engine.status()).readOnlyTestMode).toBe(true)

    await engine.start()
    await waitFor(() => channel.status().state === 'running', { label: 'desktop 通道启动（只读仍允许接收）', timeoutMs: 3000 })

    // (1) /test/send 对应的 engine.sendTest
    const sendTest = await engine.sendTest('张三', '测试消息')
    expect(sendTest.ok).toBe(false)
    expect(sendTest.delivery).toBe('not-sent')
    expect(String(sendTest.error)).toContain('只读测试模式')

    // (2) 自动回复路径
    await engine.handleInbound(makeInbound({ id: 'pc-11-1' }))

    // (3) 暂停期间入队、重启后补处理的旧队列
    await new Promise((resolve) => setTimeout(resolve, 150))

    // (4) 草稿批准
    const approved = await engine.approveDraft('draft-1')
    expect(approved.ok).toBe(false)
    expect(String(approved.error)).toContain('只读测试模式')

    // (5) 证据：引擎的自动回复/旧队列/草稿批准路径没有任何一次进入 channel.send（代码层拒绝在 canSend）。
    expect(sendCalls).toHaveLength(0)
    // (6) 直接调用通道 send（绕过引擎的工具/脚本路径）：desktop.send 第一行拒绝，绝不触达脚本。
    const direct = await channel.send('张三', { kind: 'text', text: '直接调用' })
    expect(direct.ok).toBe(false)
    expect(direct.delivery).toBe('not-sent')
    expect(sendCalls).toHaveLength(1)
    expect(recorder.calls.filter((call) => call.args.includes('send') && call.args.includes('-Action'))).toHaveLength(0)
    expect(audit.reasons('skip')).toContain('read-only-mode')
    expect(engineStore.list('')).toBeDefined()
    await engine.stop()
  })

  it('12) 依赖失败安全降级：PS1 报错/OCR 失败/磁盘失败/LLM 失败都不崩溃、不误发', async () => {
    // 12a PS1 连续报错 → 通道降级但不抛异常
    const badScript = recordRunner(() => {
      throw new Error('powershell 启动失败')
    })
    const degraded = makeDesktopE2EHarness({ runScript: badScript.runner })
    await degraded.start()
    await waitFor(() => degraded.channel.status().state === 'degraded', { label: '连续失败后降级', timeoutMs: 5000 })
    expect(String(degraded.channel.status().lastError ?? '')).toContain('失败')
    expect(degraded.messages).toHaveLength(0)
    await degraded.stop()

    // 12b OCR 读取失败（脚本返回 ok:false）→ 不投递、记录 warn
    const readFailed = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow('张三', { unread: true, preview: '' })])
      return { code: 0, stdout: JSON.stringify({ ok: false, error: 'OCR 识别失败' }), stderr: '' }
    })
    const ocrFailed = makeDesktopE2EHarness({ runScript: readFailed.runner })
    await ocrFailed.start()
    await waitFor(() => callsWith(readFailed, 'wechat-uia', 'read').length >= 2, { label: '读取失败重试', timeoutMs: 3000 })
    expect(ocrFailed.messages).toHaveLength(0)
    expect(ocrFailed.deps.logger.has('warn', '失败')).toBe(true)
    await ocrFailed.stop()

    // 12c 磁盘写入失败（delivered 持久化）→ 消息照常交付（只是内存去重）+ 仅 debug 记录
    class DiskBrokenStore extends MemoryFileStore {
      override async writeJson(rel: string, value: unknown): Promise<void> {
        if (rel === 'desktop-delivered.json') throw new Error('disk full')
        return super.writeJson(rel, value)
      }
    }
    const diskRunner = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow('张三', { unread: true, preview: '' })])
      return readResult({ captureId: 'cap-1', messages: [{ id: 'pc-12-1-disk', text: '磁盘坏了也要投' }] })
    })
    const diskBroken = makeDesktopE2EHarness({ runScript: diskRunner.runner, store: new DiskBrokenStore() })
    await diskBroken.start()
    await waitFor(() => diskBroken.messages.length >= 1, { label: '磁盘失败仍交付', timeoutMs: 3000 })
    expect(diskBroken.messages[0]?.id).toBe('pc-12-1-disk')
    await diskBroken.stop()

    // 12d LLM 连续失败 → 引擎隔离异常，不发送、不崩溃
    const llmDown = makeEngineE2EHarness()
    llmDown.llm.failuresLeft = 3
    await llmDown.engine.start()
    await expect(llmDown.engine.handleInbound(makeInbound())).resolves.toBeUndefined()
    expect(llmDown.channel.sent).toHaveLength(0)
    expect(llmDown.audit.reasons('error').length).toBeGreaterThanOrEqual(1)
    await llmDown.engine.stop()
  })

  /**
   * 任务书 4.1 滚动回归（task-23 消息身份专项）：
   * PS1 修复后，滚到已知历史时锚点对齐使 newLines 为空；滚回底部时旧消息仍在基线内，
   * 即使脚本把旧消息以「同一 id」重放，desktop 也必须靠 deliveredIds/inFlight 去重，只投一次。
   */
  it('13) 滚动回归：滚到已知历史→滚回底部，旧消息同 id 重放不重复投递', async () => {
    let readIndex = 0
    const payloads: DesktopScriptResult[] = [
      readResult({ captureId: 'cap-1', messages: [{ id: 'pc-1-1-aaaa', text: '早上的消息' }] }),
      // 滚到已知历史（PS1 锚点对齐）：没有任何新行，脚本返回空 messages。
      readResult({ captureId: 'cap-2', messages: [] }),
      // 滚回底部：旧消息仍在 pending 里以原 id 重放 + 一条真正的新消息。
      readResult({
        captureId: 'cap-3',
        messages: [
          { id: 'pc-1-1-aaaa', text: '早上的消息' },
          { id: 'pc-3-1-bbbb', text: '下午的新消息' },
        ],
      }),
    ]
    const runner = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow('张三', { unread: true, preview: '' })])
      const result = payloads[Math.min(readIndex, payloads.length - 1)]!
      readIndex += 1
      return result
    })
    const harness = makeDesktopE2EHarness({ runScript: runner.runner })
    await harness.start()
    await waitFor(() => harness.messages.filter((message) => message.id.startsWith('pc-')).length >= 2, {
      label: '滚动回归：旧消息去重 + 新消息投递',
      timeoutMs: 3000,
    })
    const delivered = harness.messages.filter((message) => message.id.startsWith('pc-'))
    expect(delivered.map((message) => message.id)).toEqual(['pc-1-1-aaaa', 'pc-3-1-bbbb'])
    expect(delivered.filter((message) => message.text === '早上的消息')).toHaveLength(1)
    // 两帧 ack 均已回传，脚本侧不会再重放旧行。
    const readArgs = () => runner.calls.filter((call) => call.args.includes('read')).map((call) => call.args)
    expect(readArgs().some((args) => args.includes('cap-2'))).toBe(true)
    // cap-3 的 ack 只会出现在下一轮 read 的 args 里（先投递、后 commitAck），故用 waitFor 等待水位线推进。
    await waitFor(() => readArgs().some((args) => args.includes('cap-3')), {
      label: '滚动回归：ack 水位线推进到 cap-3',
      timeoutMs: 2000,
    })
    await harness.stop()
  })

  /**
   * 反向证据（残余风险）：如果旧版 PS1 在滚动后把旧消息以「新 id」重新放进 pending，
   * TS 侧不能按文本去重（否则「连发两条同文算两条」会丢失），因此这种重复只能靠 PS1
   * 锚点对齐修复来避免——本用例把该边界固定下来，避免未来误加文本级去重。
   */
  it('14) 反向证据：旧消息以新 id 重放时 TS 侧不做文本去重（必须依赖 PS1 稳定 id）', async () => {
    let readIndex = 0
    const payloads: DesktopScriptResult[] = [
      readResult({ captureId: 'cap-1', messages: [{ id: 'pc-1-1-aaaa', text: '早上的消息' }] }),
      readResult({ captureId: 'cap-2', messages: [] }),
      readResult({ captureId: 'cap-3', messages: [{ id: 'pc-9-1-zzzz', text: '早上的消息' }] }),
    ]
    const runner = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) return listResult([listRow('张三', { unread: true, preview: '' })])
      const result = payloads[Math.min(readIndex, payloads.length - 1)]!
      readIndex += 1
      return result
    })
    const harness = makeDesktopE2EHarness({ runScript: runner.runner })
    await harness.start()
    await waitFor(() => harness.messages.filter((message) => message.id.startsWith('pc-')).length >= 2, {
      label: '反向证据：新 id 重放被当作新消息',
      timeoutMs: 3000,
    })
    const delivered = harness.messages.filter((message) => message.id.startsWith('pc-'))
    // 文本相同但 id 不同 → 两条（不做文本去重，"连发两条同文算两条" 依赖这一点）。
    expect(delivered.map((message) => message.id)).toEqual(['pc-1-1-aaaa', 'pc-9-1-zzzz'])
    expect(delivered.filter((message) => message.text === '早上的消息')).toHaveLength(2)
    await harness.stop()
  })
})

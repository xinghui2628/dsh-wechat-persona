/**
 * 引擎验收集成测试（全部用假依赖，不需要真实网络/微信/手机）：
 *
 * 覆盖用户验收标准：
 * 1. 白名单外 / 免打扰时段 / 纯表情 / 限频：0 次 LLM 调用（审计日志为证）；
 * 2. 命中消息：本地判断后 10 秒内生成并按配置发送（假时钟会记录真实等待）；
 * 3. 表情包随机且连续两条不重复；
 * 4. 按规则触发一次搜索；搜索失败降级不阻断回复；
 * 5. 每日 token 预算：接近上限只生成不发（草稿），超限停止（0 次 LLM）；
 * 6. 风控提示出现：立即停通道 + 通知（不重试）；
 * 7. 聊天内 /stop、一键暂停、异常隔离（LLM 连续失败不会抛给调用方）。
 *
 * 运行：`npx vitest run --pool=threads test/engine/integration.test.ts`
 * （沙箱内需要 NODE_OPTIONS=--import ./test/core/sandbox-preload.mjs，见 package.json）
 */

import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../../src/config.ts'
import type { AuditEvent, AuditEventType, AuditLogLike, AuditSummary, Channel, ChannelStatus, Clock, FileStoreLike, InboundMessage, LlmLike, LlmRequest, LlmResult, Logger, MemoryStoreLike, Notifier, PersonaPack, Random, RiskSignal, RuntimeState, SearchLike, SearchResult, SendResult, StickerCatalogLike, StickerChoice } from '../../src/types.ts'
import type { WechatPersonaConfig } from '../../src/config.ts'
import { MemoryStore } from '../../src/core/memory.ts'
import { PersonaEngine, canRetrySend, resolveSendDelivery } from '../../src/engine/engine.ts'

/* ────────────────────────────── 假依赖 ────────────────────────────── */

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

class FakeClock implements Clock {
  private current: number
  readonly sleeps: number[] = []
  /** 测试钩子：每次 sleep 时触发，用来模拟「延迟中用户暂停 / 熔断 / 恢复」等并发场景。 */
  onSleep: ((ms: number) => void | Promise<void>) | null = null
  constructor(initial: number) {
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

class FakeRandom implements Random {
  private index = 0
  private readonly values: number[]
  constructor(values: number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    this.values = values
  }
  next(): number {
    const value = this.values[this.index % this.values.length] as number
    this.index += 1
    return value
  }
}

class FakeStore implements FileStoreLike {
  readonly root = 'C:/fake-data'
  readonly files = new Map<string, string>()
  async read(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`ENOENT: ${path}`)
    return value
  }
  async readJson<T>(path: string, fallback: T): Promise<T> {
    const value = this.files.get(path)
    if (value === undefined) return fallback
    return JSON.parse(value) as T
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }
  async writeJson(path: string, value: unknown): Promise<void> {
    this.files.set(path, JSON.stringify(value))
  }
  async append(path: string, content: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? '') + content)
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }
  async removeTree(prefix: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.files.delete(key)
    }
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort()
  }
}

class FakeChannel implements Channel {
  readonly id = 'mock' as const
  state: 'stopped' | 'running' = 'stopped'
  handler: ((message: InboundMessage) => void) | null = null
  riskHandler: ((signal: RiskSignal) => void) | null = null
  /** 记录每次 send 调用（含被中断/失败的尝试）。 */
  readonly sent: Array<{ contactId: string; part: unknown }> = []
  /** 记录每次 send 收到的 AbortSignal（P0-1：引擎必须把 signal 传给通道）。 */
  readonly sendSignals: Array<AbortSignal | undefined> = []
  /** 依次消费的发送结果；用完后回退为 {ok:true}（用来模拟重试/三态）。 */
  sendResults: SendResult[] = []
  startCalls = 0
  stopCalls = 0
  async start(handler: (message: InboundMessage) => void, onRisk: (signal: RiskSignal) => void): Promise<void> {
    this.startCalls += 1
    this.handler = handler
    this.riskHandler = onRisk
    this.state = 'running'
  }
  async stop(): Promise<void> {
    this.stopCalls += 1
    this.state = 'stopped'
  }
  async send(contactId: string, part: unknown, signal?: AbortSignal): Promise<SendResult> {
    this.sent.push({ contactId, part })
    this.sendSignals.push(signal)
    const queued = this.sendResults.shift()
    return queued ? { ...queued } : { ok: true }
  }
  status(): ChannelStatus {
    return { id: 'mock', state: this.state, since: 0 }
  }
}

class FakeLlm implements LlmLike {
  readonly calls: LlmRequest[] = []
  text = '哈哈，刚在追剧，你呢？'
  usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 } as const
  failuresLeft = 0
  async complete(request: LlmRequest): Promise<LlmResult> {
    this.calls.push(request)
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1
      throw new Error('upstream 429')
    }
    return {
      text: this.text,
      usage: { ...this.usage },
      finishReason: 'stop',
      provider: 'fake',
      model: 'fake-model',
      durationMs: 5,
    }
  }
}

class FakeSearch implements SearchLike {
  readonly queries: string[] = []
  fails = false
  async search(query: string): Promise<SearchResult> {
    this.queries.push(query)
    if (this.fails) throw new Error('search timeout')
    return {
      content: '今日多云转晴，18~25℃，微风。',
      sources: [{ url: 'https://example.com/weather', title: '天气' }],
      truncated: false,
    }
  }
}

class FakeNotifier implements Notifier {
  readonly notes: Array<{ level: string; title: string; body: string }> = []
  async notify(level: 'info' | 'warn' | 'critical', title: string, body: string): Promise<void> {
    this.notes.push({ level, title, body })
  }
}

class FakeAudit implements AuditLogLike {
  readonly events: AuditEvent[] = []
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }
  async recent(n: number): Promise<AuditEvent[]> {
    return this.events.slice(-n)
  }
  async summary(): Promise<AuditSummary> {
    const count = (type: AuditEventType) => this.events.filter((event) => event.type === type).length
    return {
      dayKey: '2026-10-30',
      llmCalls: count('llm'),
      llmTokens: this.events.reduce((sum, event) => sum + (event.llm?.totalTokens ?? 0), 0),
      cacheReadTokens: this.events.reduce((sum, event) => sum + (event.llm?.cacheReadTokens ?? 0), 0),
      searches: count('search'),
      sends: count('send'),
      drafts: count('draft'),
      skips: {},
    }
  }
  async clear(): Promise<void> {
    this.events.length = 0
  }
  reasons(type: AuditEventType): string[] {
    return this.events.filter((event) => event.type === type).map((event) => event.reason ?? '')
  }
}

class FakeStickers implements StickerCatalogLike {
  private readonly pool: Record<string, StickerChoice[]>
  constructor(pool: Record<string, StickerChoice[]> = {}) {
    this.pool = pool
  }
  categories(): string[] {
    return Object.keys(this.pool)
  }
  count(): number {
    return Object.values(this.pool).reduce((sum, list) => sum + list.length, 0)
  }
  pick(category: string, recentIds: string[]): StickerChoice | null {
    const list = (this.pool[category] ?? []).filter((item) => !recentIds.includes(item.id))
    return list[0] ?? null
  }
  pickAny(recentIds: string[]): StickerChoice | null {
    const list = Object.values(this.pool)
      .flat()
      .filter((item) => !recentIds.includes(item.id))
    return list[0] ?? null
  }
}

const persona: PersonaPack = {
  name: '小号',
  systemPrompt: '你是一个普通年轻人，短句口语化，不客服腔。',
  examples: [{ user: '在干嘛', assistant: '躺着刷视频，你呢' }],
  sourceDir: 'C:/fake-persona',
}

/* ────────────────────────────── 组装 ────────────────────────────── */

interface Harness {
  engine: PersonaEngine
  config: WechatPersonaConfig
  clock: FakeClock
  random: FakeRandom
  store: FakeStore
  channel: FakeChannel
  llm: FakeLlm
  search: FakeSearch
  notifier: FakeNotifier
  audit: FakeAudit
  state: RuntimeState
  events: AuditEvent[]
}

function makeHarness(options: {
  now?: number
  config?: Partial<WechatPersonaConfig>
  search?: boolean
  state?: Partial<RuntimeState>
} = {}): Harness {
  const now = options.now ?? new Date('2026-10-30T12:00:00+08:00').getTime()
  const config = { ...defaultConfig(), ...(options.config ?? {}) } as WechatPersonaConfig
  const clock = new FakeClock(now)
  const random = new FakeRandom()
  const store = new FakeStore()
  const channel = new FakeChannel()
  const llm = new FakeLlm()
  const search = new FakeSearch()
  const notifier = new FakeNotifier()
  const audit = new FakeAudit()
  const state: RuntimeState = {
    version: 1,
    paused: false,
    breaker: { tripped: false },
    budget: { dayKey: '2026-10-30', spentTokens: 0 },
    rate: {},
    seen: {},
    stats: {
      llmCalls: 0,
      llmTokens: 0,
      drafts: 0,
      sends: 0,
      skips: 0,
      errors: 0,
      searchDayKey: '2026-10-30',
      searchDayCount: 0,
      searches: 0,
      startedAt: now,
      summaryDayKey: '2026-10-30',
      summaryCalls: 0,
    },
    ...(options.state ?? {}),
  }
  const memory: MemoryStoreLike = new MemoryStore({ store, config, clock, logger })
  const stickers = new FakeStickers({
    happy: [
      { id: 'happy/001.png', category: 'happy', file: 'C:/fake-stickers/happy/001.png' },
      { id: 'happy/002.png', category: 'happy', file: 'C:/fake-stickers/happy/002.png' },
    ],
    neutral: [{ id: 'neutral/001.png', category: 'neutral', file: 'C:/fake-stickers/neutral/001.png' }],
  })
  const engine = new PersonaEngine({
    config,
    logger,
    clock,
    random,
    store,
    channel,
    llm,
    search: options.search === false ? null : search,
    notifier,
    state,
    audit,
    memory,
    stickers,
    persona,
    saveState: async () => {},
  })
  return { engine, config, clock, random, store, channel, llm, search, notifier, audit, state, events: audit.events }
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  const now = new Date('2026-10-30T12:00:00+08:00').getTime()
  return {
    id: `msg-${Math.random().toString(16).slice(2)}`,
    contactId: '张三',
    contactName: '张三',
    chatType: 'single',
    kind: 'text',
    text: '在干嘛呢',
    receivedAt: now,
    ...overrides,
  }
}

const whitelist = [{ id: '张三', name: '张三', aliases: ['阿三'] }]

/* ────────────────────────────── 测试 ────────────────────────────── */

describe('本地 0-token 规则：不该调模型的绝不调', () => {
  it('白名单外消息：0 次 LLM 调用，审计记 not-whitelisted', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.handleInbound(inbound({ contactId: '陌生人', contactName: '陌生人', text: '在吗' }))
    expect(h.llm.calls).toHaveLength(0)
    expect(h.channel.sent).toHaveLength(0)
    expect(h.audit.reasons('skip')).toContain('not-whitelisted')
  })

  it('免打扰时段（凌晨 2 点）：0 次 LLM 调用，审计记 offline-hours', async () => {
    const h = makeHarness({ now: new Date('2026-10-30T02:00:00+08:00').getTime(), config: { whitelist } })
    await h.engine.handleInbound(inbound())
    expect(h.llm.calls).toHaveLength(0)
    expect(h.audit.reasons('skip')).toContain('offline-hours')
  })

  it('纯表情/无意义消息：0 次 LLM 调用', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.handleInbound(inbound({ text: '😀😀😀' }))
    expect(h.llm.calls).toHaveLength(0)
    expect(h.channel.sent).toHaveLength(0)
  })

  it('群聊消息：0 次 LLM 调用', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.handleInbound(inbound({ chatType: 'group', text: '大家晚上好' }))
    expect(h.llm.calls).toHaveLength(0)
    expect(h.audit.reasons('skip')).toContain('group-chat')
  })

  it('同一消息重复投递：只调用一次模型', async () => {
    const h = makeHarness({ config: { whitelist } })
    const message = inbound({ id: 'dup-1', text: '在干嘛' })
    await h.engine.handleInbound(message)
    await h.engine.handleInbound({ ...message })
    expect(h.llm.calls).toHaveLength(1)
    expect(h.audit.reasons('skip')).toContain('duplicate')
  })
})

describe('命中消息：10 秒内生成并发送', () => {
  it('白名单单聊文本 → 恰好一次 LLM 调用，延迟 0.8–5 秒后发送', async () => {
    const h = makeHarness({ config: { whitelist } })
    const start = h.clock.now()
    await h.engine.handleInbound(inbound())
    const elapsed = h.clock.now() - start
    expect(h.llm.calls).toHaveLength(1)
    expect(h.channel.sent.length).toBeGreaterThanOrEqual(1)
    expect(elapsed).toBeGreaterThanOrEqual(800)
    expect(elapsed).toBeLessThan(10_000)
    expect(h.llm.calls[0]?.system).toContain('普通年轻人')
    expect(h.state.stats.sends).toBe(h.channel.sent.length)
    expect(h.audit.events.some((event) => event.type === 'llm' && (event.llm?.totalTokens ?? 0) > 0)).toBe(true)
  })

  it('没有搜索需求时不联网：搜索 0 次', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.handleInbound(inbound({ text: '你吃饭了吗' }))
    expect(h.search.queries).toHaveLength(0)
  })
})

describe('按需联网搜索', () => {
  it('天气类消息触发一次搜索，并把结果带进上下文', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.handleInbound(inbound({ text: '今天天气怎么样' }))
    expect(h.search.queries).toHaveLength(1)
    expect(h.audit.events.some((event) => event.type === 'search' && event.search?.ok === true)).toBe(true)
    expect(JSON.stringify(h.llm.calls[0]?.messages ?? [])).toContain('18~25')
  })

  it('搜索失败降级：仍然回复，不抛错', async () => {
    const h = makeHarness({ config: { whitelist } })
    h.search.fails = true
    await h.engine.handleInbound(inbound({ text: '今天天气怎么样' }))
    expect(h.llm.calls).toHaveLength(1)
    expect(h.channel.sent.length).toBeGreaterThanOrEqual(1)
    expect(h.audit.events.some((event) => event.type === 'search' && event.search?.ok === false)).toBe(true)
  })
})

describe('表情包：随机但不连续重复', () => {
  it('连续两条回复不会发同一张表情包', async () => {
    const h = makeHarness({
      config: {
        whitelist,
        reply: { ...defaultConfig().reply, stickerProbability: 1, splitProbability: 0, maxSplitParts: 1 },
        rateLimit: { ...defaultConfig().rateLimit, minReplyIntervalSec: 0, perContactPerHour: 20 },
      },
    })
    await h.engine.handleInbound(inbound({ text: '在干嘛呀' }))
    await h.engine.handleInbound(inbound({ text: '有推荐的吗' }))
    const stickerIds = h.channel.sent
      .map((item) => item.part as { kind: string; stickerId?: string })
      .filter((part) => part.kind === 'sticker')
      .map((part) => part.stickerId)
    expect(stickerIds.length).toBeGreaterThanOrEqual(2)
    expect(stickerIds[0]).not.toBe(stickerIds[1])
  })
})

describe('token 预算与草稿模式', () => {
  it('越过草稿线：只生成不发，写 drafts 审计', async () => {
    const h = makeHarness({
      config: { whitelist, budget: { ...defaultConfig().budget, dailyTokens: 100, draftModeRatio: 0.5 } },
    })
    await h.engine.handleInbound(inbound())
    expect(h.llm.calls).toHaveLength(1)
    expect(h.channel.sent).toHaveLength(0)
    expect(h.state.stats.drafts).toBe(1)
    expect(h.audit.events.some((event) => event.type === 'draft')).toBe(true)
  })

  it('超过每日预算：直接停，0 次 LLM 调用', async () => {
    const h = makeHarness({
      config: { whitelist, budget: { ...defaultConfig().budget, dailyTokens: 100 } },
      state: { budget: { dayKey: '2026-10-30', spentTokens: 100 } },
    })
    await h.engine.handleInbound(inbound())
    expect(h.llm.calls).toHaveLength(0)
    expect(h.audit.reasons('skip')).toContain('budget-hard-stop')
  })
})

describe('风控熔断与紧急停止', () => {
  it('风控信号：立即停通道 + critical 通知 + 熔断标记，不重试', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.start()
    const before = h.clock.now()
    await h.engine.handleRisk({ kind: 'captcha', text: '请完成安全验证', matched: '安全验证', at: before })
    expect(h.clock.now() - before).toBeLessThan(1000)
    expect(h.state.breaker.tripped).toBe(true)
    expect(h.channel.stopCalls).toBeGreaterThanOrEqual(1)
    expect(h.notifier.notes.some((note) => note.level === 'critical')).toBe(true)
    expect(h.audit.events.some((event) => event.type === 'risk')).toBe(true)
  })

  it('熔断后新消息：0 次 LLM 调用', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.handleRisk({ kind: 'restricted', text: '账号被限制', matched: '限制', at: h.clock.now() })
    await h.engine.handleInbound(inbound())
    expect(h.llm.calls).toHaveLength(0)
  })

  it('聊天内 /stop：暂停后不再调用模型', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.handleInbound(inbound({ text: '/stop' }))
    expect(h.llm.calls).toHaveLength(0)
    expect(h.state.paused).toBe(true)
    await h.engine.handleInbound(inbound({ text: '在吗' }))
    expect(h.llm.calls).toHaveLength(0)
    expect(h.audit.reasons('skip')).toContain('paused')
  })
})

describe('限频与异常隔离', () => {
  it('每人每小时上限：第二条被限频，不额外调用模型', async () => {
    const h = makeHarness({
      config: { whitelist, rateLimit: { ...defaultConfig().rateLimit, perContactPerHour: 1, minReplyIntervalSec: 0 } },
    })
    await h.engine.handleInbound(inbound({ text: '在干嘛' }))
    expect(h.llm.calls).toHaveLength(1)
    await h.engine.handleInbound(inbound({ text: '出来玩吗' }))
    expect(h.llm.calls).toHaveLength(1)
    expect(h.audit.reasons('skip')).toContain('rate-hour-limit')
  })

  it('模型连续失败：异常被隔离，审计 error，不向调用方抛错', async () => {
    const h = makeHarness({ config: { whitelist } })
    h.llm.failuresLeft = 2
    await expect(h.engine.handleInbound(inbound())).resolves.toBeUndefined()
    expect(h.state.stats.errors).toBeGreaterThanOrEqual(1)
    expect(h.audit.reasons('error')).toContain('model-failed')
    expect(h.channel.sent).toHaveLength(0)
  })
})

/* ───────────────── 第二轮迭代：行为开关验收 ───────────────── */

describe('第二轮开关：人格/私聊/白名单/表情/熔断', () => {
  const base = defaultConfig()

  it('人格停用：0 次 LLM 调用，skip persona-disabled', async () => {
    const h = makeHarness({
      config: { whitelist, persona: { ...base.persona, enabled: false } },
    })
    await h.engine.handleInbound(inbound())
    expect(h.llm.calls).toHaveLength(0)
    expect(h.channel.sent).toHaveLength(0)
    expect(h.audit.reasons('skip')).toContain('persona-disabled')
  })

  it('私聊开关关闭：0 次 LLM 调用，skip private-chat-disabled', async () => {
    const h = makeHarness({
      config: { whitelist, reply: { ...base.reply, privateChatEnabled: false } },
    })
    await h.engine.handleInbound(inbound())
    expect(h.llm.calls).toHaveLength(0)
    expect(h.audit.reasons('skip')).toContain('private-chat-disabled')
  })

  it('只回白名单关闭：非白名单单聊也会回复（1 次 LLM）', async () => {
    const h = makeHarness({ config: { whitelist, whitelistOnly: false } })
    await h.engine.handleInbound(inbound({ contactId: '陌生人', contactName: '陌生人', text: '你好呀' }))
    expect(h.llm.calls).toHaveLength(1)
    expect(h.channel.sent.length).toBeGreaterThanOrEqual(1)
  })

  it('群聊开关打开且发送者在白名单：允许回复', async () => {
    const h = makeHarness({ config: { whitelist, reply: { ...base.reply, groupChatEnabled: true } } })
    await h.engine.handleInbound(inbound({ chatType: 'group', text: '大家晚上好' }))
    expect(h.llm.calls).toHaveLength(1)
  })

  it('表情包总开关关闭：即使概率 100% 也不发', async () => {
    const h = makeHarness({
      config: {
        whitelist,
        stickers: { ...base.stickers, enabled: false },
        reply: { ...base.reply, stickerProbability: 1, splitProbability: 0, maxSplitParts: 1 },
        rateLimit: { ...base.rateLimit, minReplyIntervalSec: 0 },
      },
    })
    await h.engine.handleInbound(inbound())
    expect(h.channel.sent.filter((item) => item.part.kind === 'sticker')).toHaveLength(0)
  })

  it('maxPerReply 限制单次回复的表情数量', async () => {
    const h = makeHarness({
      config: {
        whitelist,
        stickers: { ...base.stickers, enabled: true, maxPerReply: 1 },
        reply: { ...base.reply, stickerProbability: 1, splitProbability: 1, maxSplitParts: 3 },
        rateLimit: { ...base.rateLimit, minReplyIntervalSec: 0 },
      },
    })
    await h.engine.handleInbound(inbound())
    expect(h.channel.sent.filter((item) => item.part.kind === 'sticker').length).toBeLessThanOrEqual(1)
  })

  it('熔断开关关闭：风控信号只通知不暂停、不停通道', async () => {
    const h = makeHarness({
      config: { whitelist, safety: { ...base.safety, circuitBreakerEnabled: false } },
    })
    await h.engine.start()
    await h.engine.handleRisk({ kind: 'captcha', text: '请完成安全验证', matched: '安全验证', at: h.clock.now() })
    expect(h.state.breaker.tripped).toBe(false)
    expect(h.state.paused).toBe(false)
    expect(h.channel.stopCalls).toBe(0)
    expect(h.notifier.notes.some((note) => note.level === 'warn')).toBe(true)
  })

  it('联系人偏好（称呼/忌口）0 token 提取并注入提示词', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.handleInbound(inbound({ text: '以后叫我老王，我不吃香菜' }))
    const prompt = JSON.stringify(h.llm.calls[0]?.messages ?? [])
    expect(prompt).toContain('老王')
    expect(prompt).toContain('香菜')
  })

  it('status 携带下次上线时间', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.start()
    const status = await h.engine.status()
    expect(typeof status.nextOnlineAt === 'number' || status.nextOnlineAt === null).toBe(true)
  })
})

describe('自回声保护：机器人不会自问自答', () => {
  it('把自己刚发出的回复回读成入站：不调用模型、不重复发送', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.handleInbound(inbound({ id: 'echo-base', text: '在干嘛呢' }))
    expect(h.channel.sent.length).toBeGreaterThan(0)
    const own = (h.channel.sent[0]!.part as { text: string }).text
    const sentBefore = h.channel.sent.length
    const llmBefore = h.llm.calls.length

    await h.engine.handleInbound(inbound({ id: 'echo-replay', text: own }))
    expect(h.channel.sent.length).toBe(sentBefore)
    expect(h.llm.calls.length).toBe(llmBefore)
    expect(h.audit.reasons('skip')).toContain('self-echo')
  })

  it('100 次自回声重复投递都不产生新回复', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.handleInbound(inbound({ id: 'echo-base', text: '在干嘛呢' }))
    const own = (h.channel.sent[0]!.part as { text: string }).text
    const sentBefore = h.channel.sent.length
    for (let i = 0; i < 100; i += 1) {
      await h.engine.handleInbound(inbound({ id: `echo-${i}`, text: own }))
    }
    expect(h.channel.sent.length).toBe(sentBefore)
    expect(h.llm.calls.length).toBeLessThanOrEqual(1)
  })

  it('好友复述一个短词（如「大吧鱼」）不会被当成自回声，必须正常回复', async () => {
    const h = makeHarness({ config: { whitelist } })
    h.llm.text = '大吧鱼？我这名字还能被你叫歪，行吧'
    await h.engine.handleInbound(inbound({ id: 'short-base', text: '咱俩定个暗号' }))
    const sentBefore = h.channel.sent.length
    // 拉开最小回复间隔，排除限频跳过的干扰（只验证自回声保护不误杀）
    await h.clock.sleep(60_000)
    await h.engine.handleInbound(inbound({ id: 'short-quote', text: '大吧鱼' }))
    expect(h.channel.sent.length).toBeGreaterThan(sentBefore)
    expect(h.audit.reasons('skip')).not.toContain('self-echo')
  })
})

/* ═══════════════════════ P0-2 投递三态工具函数 ═══════════════════════ */

describe('SendResult 投递三态工具函数（P0-2）', () => {
  it('resolveSendDelivery：成功即 sent；缺省/非法一律保守 unknown', () => {
    expect(resolveSendDelivery({ ok: true })).toBe('sent')
    expect(resolveSendDelivery({ ok: false, error: 'x' })).toBe('unknown')
    expect(resolveSendDelivery({ ok: false, delivery: 'not-sent' })).toBe('not-sent')
    expect(resolveSendDelivery({ ok: false, delivery: 'unknown' })).toBe('unknown')
  })

  it('canRetrySend：只有确认未发出才可重试，unknown 一律不重试', () => {
    expect(canRetrySend({ ok: true })).toBe(false)
    expect(canRetrySend({ ok: false, error: 'x', delivery: 'unknown' })).toBe(false)
    expect(canRetrySend({ ok: false, error: 'x', delivery: 'sent' })).toBe(false)
    expect(canRetrySend({ ok: false, error: 'x', delivery: 'not-sent' })).toBe(true)
    // 旧版通道：按错误文案保守推断
    expect(canRetrySend({ ok: false, error: '无法确认目标聊天窗口，已拒绝发送以避免发错人' })).toBe(true)
    expect(canRetrySend({ ok: false, error: '快发送已回车但气泡未确认且输入框未清空，已跳过保守重发以免重复' })).toBe(false)
    expect(canRetrySend({ ok: false, error: '脚本异常: timeout' })).toBe(false)
  })
})

/* ═══════════════════════ P0-1 暂停门禁 + AbortController ═══════════════════════ */

describe('P0-1 发送门禁：暂停后坚决不发', () => {
  it('生成结束、拟人延迟中暂停：LLM 已调用但 send 一次都不调用', async () => {
    const h = makeHarness({ config: { whitelist } })
    h.clock.onSleep = async (ms) => {
      // 生成完成后的拟人延迟（typingMs 一定 >= 800）里用户点了暂停
      if (ms >= 800 && h.llm.calls.length === 1 && h.channel.sent.length === 0) {
        await h.engine.pause('manual-test')
      }
    }
    await h.engine.handleInbound(inbound())
    expect(h.llm.calls).toHaveLength(1)
    expect(h.channel.sent).toHaveLength(0)
    expect(h.state.paused).toBe(true)
    expect(h.state.stats.sends).toBe(0)
    expect(
      h.audit.events.some(
        (event) =>
          event.type === 'skip' && event.reason === 'paused' && String(event.detail ?? '').includes('send-blocked'),
      ),
    ).toBe(true)
    // 暂停时 AbortSignal 已 abort；send 从未被调用（也就没有 signal 传出去）
    expect(h.channel.sendSignals).toHaveLength(0)
  })

  it('多 part 之间暂停：第一条已发，后续 part 不再发送', async () => {
    const h = makeHarness({
      config: {
        whitelist,
        reply: {
          ...defaultConfig().reply,
          splitProbability: 1,
          maxSplitParts: 2,
          maxChars: 200,
          stickerProbability: 0,
          typingMinMs: 800,
          typingMaxMs: 800,
        },
        rateLimit: { ...defaultConfig().rateLimit, minReplyIntervalSec: 0 },
      },
    })
    h.llm.text = '刚在追剧呢，你呢？今天好累，想早点睡。'
    h.clock.onSleep = async (ms) => {
      // 第一条 part 已发出后的间隔睡眠里暂停
      if (h.channel.sent.length === 1 && ms >= 300) {
        await h.engine.pause('between-parts')
      }
    }
    await h.engine.handleInbound(inbound({ text: '在干嘛呢' }))
    expect(h.llm.calls).toHaveLength(1)
    expect(h.channel.sent).toHaveLength(1)
    expect(h.state.paused).toBe(true)
  })

  it('重试前暂停：第一次失败（not-sent）后暂停，不再尝试第二次', async () => {
    const h = makeHarness({ config: { whitelist } })
    h.channel.sendResults = [{ ok: false, error: '发送前校验失败', delivery: 'not-sent' }]
    h.clock.onSleep = async (ms) => {
      if (h.channel.sent.length === 1 && ms >= 400 && ms < 1100) {
        await h.engine.pause('before-retry')
      }
    }
    await h.engine.handleInbound(inbound())
    expect(h.channel.sent).toHaveLength(1)
    expect(h.state.paused).toBe(true)
    expect(h.state.stats.sends).toBe(0)
  })
})

/* ═══════════════════════ P0-2 引擎侧重试策略 ═══════════════════════ */

describe('P0-2 引擎只对「确认未发出」重试', () => {
  it('delivery=unknown（已按回车但气泡未确认）：只调用一次 send，不重试并记 send-fail/unknown', async () => {
    const h = makeHarness({ config: { whitelist, reply: { ...defaultConfig().reply, stickerProbability: 0 } } })
    h.channel.sendResults = [
      { ok: false, error: '发送后未在聊天区看到消息气泡（已重试 3 次）：在吗', delivery: 'unknown' },
    ]
    await h.engine.handleInbound(inbound())
    expect(h.channel.sent).toHaveLength(1)
    expect(h.state.stats.sends).toBe(0)
    const fail = h.audit.events.find((event) => event.type === 'send-fail')
    expect(fail?.send?.delivery).toBe('unknown')
    const status = await h.engine.status()
    expect(status.delivery).toMatchObject({ unknown: 1, sent: 0 })
  })

  it('delivery=not-sent：重试一次，第二次成功', async () => {
    const h = makeHarness({ config: { whitelist, reply: { ...defaultConfig().reply, stickerProbability: 0 } } })
    h.channel.sendResults = [
      { ok: false, error: '缺少聊天定位信息，已拒绝发送', delivery: 'not-sent' },
      { ok: true },
    ]
    await h.engine.handleInbound(inbound())
    expect(h.channel.sent).toHaveLength(2)
    expect(h.state.stats.sends).toBe(1)
    expect(h.audit.events.some((event) => event.type === 'send' && event.send?.delivery === 'sent')).toBe(true)
  })

  it('旧版通道（无 delivery）明确未发文案：允许重试一次', async () => {
    const h = makeHarness({ config: { whitelist, reply: { ...defaultConfig().reply, stickerProbability: 0 } } })
    h.channel.sendResults = [
      { ok: false, error: '无法确认目标聊天窗口，已拒绝发送以避免发错人' },
      { ok: true },
    ]
    await h.engine.handleInbound(inbound())
    expect(h.channel.sent).toHaveLength(2)
    expect(h.state.stats.sends).toBe(1)
  })

  it('旧版通道（无 delivery）「回车后气泡未确认」文案：一律不重试（防重复发送）', async () => {
    const h = makeHarness({ config: { whitelist, reply: { ...defaultConfig().reply, stickerProbability: 0 } } })
    h.channel.sendResults = [
      { ok: false, error: '快发送已回车但气泡未确认且输入框未清空，已跳过保守重发以免重复' },
    ]
    await h.engine.handleInbound(inbound())
    expect(h.channel.sent).toHaveLength(1)
    expect(h.state.stats.sends).toBe(0)
    expect(h.state.stats.errors).toBe(1)
  })
})

/* ═══════════════════════ P1-4 暂停期间消息不丢 ═══════════════════════ */

describe('P1-4 暂停期间入站消息 deferred 持久化 + 恢复补处理', () => {
  it('暂停时白名单消息写入 deferred-inbound.json，恢复后补处理并回复', async () => {
    const h = makeHarness({ config: { whitelist }, state: { paused: true, pauseReason: 'manual' } })
    await h.engine.handleInbound(inbound({ id: 'deferred-1', text: '在吗' }))
    expect(h.llm.calls).toHaveLength(0)
    expect(h.channel.sent).toHaveLength(0)
    expect((await h.engine.status()).deferredCount).toBe(1)
    const saved = JSON.parse(h.store.files.get('deferred-inbound.json') ?? '{}') as {
      entries?: Array<{ message: { id: string } }>
    }
    expect(saved.entries?.map((entry) => entry.message.id)).toEqual(['deferred-1'])
    expect(
      h.audit.events.some(
        (event) =>
          event.type === 'skip' && event.reason === 'paused' && String(event.detail ?? '').startsWith('deferred:'),
      ),
    ).toBe(true)

    await h.engine.resume()
    expect(h.state.paused).toBe(false)
    expect(h.llm.calls).toHaveLength(1)
    expect(h.channel.sent.length).toBeGreaterThanOrEqual(1)
    expect((await h.engine.status()).deferredCount).toBe(0)
    const after = JSON.parse(h.store.files.get('deferred-inbound.json') ?? '{}') as { entries?: unknown[] }
    expect(after.entries).toEqual([])
  })

  it('重启后 start() 读取持久化的 deferred 并补处理', async () => {
    const first = makeHarness({ config: { whitelist }, state: { paused: true, pauseReason: 'manual' } })
    await first.engine.handleInbound(inbound({ id: 'persist-1', text: '在吗' }))
    const raw = first.store.files.get('deferred-inbound.json')
    expect(raw).toBeTruthy()

    const second = makeHarness({ config: { whitelist } })
    second.store.files.set('deferred-inbound.json', raw as string)
    await second.engine.start()
    expect(second.channel.startCalls).toBe(1)
    expect(second.llm.calls.length).toBeGreaterThanOrEqual(1)
    expect(second.channel.sent.length).toBeGreaterThanOrEqual(1)
    expect((await second.engine.status()).deferredCount).toBe(0)
  })
})

/* ═══════════════════════ P1-5 手动发送统一门禁 ═══════════════════════ */

describe('P1-5 sendTest 与自动发送统一走门禁', () => {
  it('正常发送：走通道、计发送数、记 manual-send 审计', async () => {
    const h = makeHarness({ config: { whitelist } })
    const result = await h.engine.sendTest('张三', '测试消息')
    expect(result).toMatchObject({ ok: true, delivery: 'sent' })
    expect(h.channel.sent).toHaveLength(1)
    expect(h.state.stats.sends).toBe(1)
    expect(h.audit.events.some((event) => event.type === 'send' && event.reason === 'manual-send')).toBe(true)
  })

  it('暂停时拒绝：不调用通道、返回 not-sent、记 send-fail/paused', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.pause('manual-test')
    const result = await h.engine.sendTest('张三', '测试消息')
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe('not-sent')
    expect(String(result.error)).toContain('已拒绝发送')
    expect(h.channel.sent).toHaveLength(0)
    expect(
      h.audit.events.some((event) => event.type === 'send-fail' && event.reason === 'paused'),
    ).toBe(true)
  })

  it('熔断时拒绝', async () => {
    const h = makeHarness({ config: { whitelist }, state: { breaker: { tripped: true, reason: 'risk:captcha' } } })
    const result = await h.engine.sendTest('张三', '测试消息')
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe('not-sent')
    expect(String(result.error)).toContain('熔断')
    expect(h.channel.sent).toHaveLength(0)
  })

  it('预算耗尽时拒绝', async () => {
    const h = makeHarness({
      config: { whitelist },
      state: { budget: { dayKey: '2026-10-30', spentTokens: 60_000 } },
    })
    const result = await h.engine.sendTest('张三', '测试消息')
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('预算')
    expect(h.channel.sent).toHaveLength(0)
  })

  it('白名单外拒绝', async () => {
    const h = makeHarness({ config: { whitelist } })
    const result = await h.engine.sendTest('陌生人', '测试消息')
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('白名单')
    expect(h.channel.sent).toHaveLength(0)
  })
})

/* ═══════════════════════ P1-7 启动时保持暂停/熔断 ═══════════════════════ */

describe('P1-7 start 检查 paused / breaker', () => {
  it('state.paused=true：start 不启动通道，保持暂停并记审计', async () => {
    const h = makeHarness({ config: { whitelist }, state: { paused: true, pauseReason: 'manual' } })
    await h.engine.start()
    expect(h.channel.state).toBe('stopped')
    expect(h.channel.handler).toBeNull()
    expect((await h.engine.status()).paused).toBe(true)
    expect(h.audit.events.some((event) => event.type === 'start' && event.reason === 'paused')).toBe(true)
  })

  it('breaker.tripped=true：start 不启动通道', async () => {
    const h = makeHarness({
      config: { whitelist },
      state: { breaker: { tripped: true, reason: 'risk:captcha' } },
    })
    await h.engine.start()
    expect(h.channel.state).toBe('stopped')
    expect(h.audit.events.some((event) => event.type === 'start' && event.reason === 'breaker')).toBe(true)
  })

  it('未暂停/未熔断：start 正常启动通道', async () => {
    const h = makeHarness({ config: { whitelist } })
    await h.engine.start()
    expect(h.channel.startCalls).toBe(1)
    expect(h.channel.state).toBe('running')
  })

  it('仅预算耗尽（未暂停/未熔断）：start 仍应启动通道，避免重启后永远起不来', async () => {
    const h = makeHarness({
      config: { whitelist },
      state: { budget: { dayKey: '2026-10-30', spentTokens: 60_000 } },
    })
    await h.engine.start()
    expect(h.channel.startCalls).toBe(1)
    expect(h.channel.state).toBe('running')
  })
})

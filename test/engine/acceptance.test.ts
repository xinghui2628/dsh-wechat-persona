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
import { PersonaEngine } from '../../src/engine/engine.ts'

/* ────────────────────────────── 假依赖 ────────────────────────────── */

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

class FakeClock implements Clock {
  private current: number
  readonly sleeps: number[] = []
  constructor(initial: number) {
    this.current = initial
  }
  now(): number {
    return this.current
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    this.current += ms
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
  readonly sent: Array<{ contactId: string; part: unknown }> = []
  stopCalls = 0
  async start(handler: (message: InboundMessage) => void, onRisk: (signal: RiskSignal) => void): Promise<void> {
    this.handler = handler
    this.riskHandler = onRisk
    this.state = 'running'
  }
  async stop(): Promise<void> {
    this.stopCalls += 1
    this.state = 'stopped'
  }
  async send(contactId: string, part: unknown): Promise<SendResult> {
    this.sent.push({ contactId, part })
    return { ok: true }
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
})

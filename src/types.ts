/**
 * 领域类型契约（host 与运行时无关）。
 *
 * 设计原则：
 * - 本文件只放类型，不放实现，任何模块都可以安全 import type；
 * - 通道 / LLM / 搜索 / 存储 / 时钟 / 随机数全部是接口——引擎可在 vitest 里
 *   用假实现驱动，验收标准（0 次 LLM 调用、10 秒内生成、token 预算、1 秒熔断…）
 *   全部可以用确定性的假依赖证明；
 * - 时间一律用 epoch 毫秒（number），本地时区换算放在 schedule 模块。
 */

import type { SendMode, WechatPersonaConfig } from './config.ts'

/* ────────────────────────────── 通道层 ────────────────────────────── */

export type ChannelId = 'mock' | 'phone-adb' | 'windows-vm' | 'desktop'

/** 通道上报的入站消息（只允许白名单单聊，由通道自行过滤）。 */
export interface InboundMessage {
  /** 通道内稳定消息 id（用于去重）。 */
  id: string
  /** 联系人稳定标识：手机通道用备注名/昵称，Windows 通道用会话 id。 */
  contactId: string
  contactName: string
  /** 群聊消息不应到达引擎（通道必须过滤）；保留字段用于防御性检查。 */
  chatType: 'single' | 'group'
  kind: 'text' | 'sticker' | 'image' | 'voice' | 'other'
  /** 文本内容；非文本消息为通道能读到的占位（如 "[图片]"），可能为空串。 */
  text: string
  /** epoch ms */
  receivedAt: number
}

export type OutboundPart =
  | { kind: 'text'; text: string }
  | { kind: 'sticker'; stickerId: string; file: string }

/**
 * 发送投递三态（P0-2，任务书 9.2 相关）：
 * - `sent`：确认已投递（通道看到气泡 / 脚本明确成功）；
 * - `not-sent`：确认没有投出去（发送前校验失败、通道未启动、未按回车等），可安全重试；
 * - `unknown`：已执行发送动作但无法确认结果（典型：脚本已按回车、气泡却未确认），
 *   重试可能造成重复发送，引擎必须保守地不重试。
 */
export type SendDelivery = 'sent' | 'not-sent' | 'unknown'

export interface SendResult {
  ok: boolean
  error?: string
  /**
   * 投递确认状态。旧版通道可能不返回该字段：引擎按错误语义保守推断，
   * 无法证明「未发送」的一律按 `unknown` 处理（宁可漏发一次，不重复发错一次）。
   */
  delivery?: SendDelivery
}

/**
 * 通道能力声明（可选）。引擎据此做降级：通道发不出表情/图片/语音时，
 * 不再把对应内容放进发送计划，避免「无谓发送→失败→错误计数」。
 */
export interface ChannelCapabilities {
  /** 能否发送表情包（桌面通道 false：UIA 表情面板未实现）。 */
  stickers?: boolean
  /** 能否发送图片。 */
  images?: boolean
  /** 能否发送语音。 */
  voice?: boolean
}

export type ChannelState = 'stopped' | 'starting' | 'running' | 'degraded' | 'error'

export interface ChannelStatus {
  id: ChannelId
  state: ChannelState
  detail?: string
  lastError?: string
  since: number
  lastInboundAt?: number
  lastSendAt?: number
}

/** 风控信号：验证码 / 异常登录 / 限制登录 / 操作频繁等。 */
export type RiskKind = 'captcha' | 'login-abnormal' | 'restricted' | 'spam-limit' | 'unknown'

export interface RiskSignal {
  kind: RiskKind
  /** 命中的原文片段（只用于本机日志，不外发、不进模型上下文）。 */
  text: string
  at: number
  matched: string
}

export type InboundHandler = (msg: InboundMessage) => void
export type RiskHandler = (signal: RiskSignal) => void

/**
 * 通道契约：被动收消息、发消息、停启与状态。
 * 通道自身必须负责“只读白名单单聊”，引擎再做一次防御性白名单检查。
 */
export interface Channel {
  readonly id: ChannelId
  /** 启动监听。实现方在 start 成功后不得阻塞（长驻轮询放内部 timer）。 */
  start(handler: InboundHandler, onRisk: RiskHandler): Promise<void>
  /** 停止监听并清理定时器/子进程/连接；幂等。 */
  stop(): Promise<void>
  /** 发送一段内容；失败返回 {ok:false}，不抛异常。 */
  send(contactId: string, part: OutboundPart, signal?: AbortSignal): Promise<SendResult>
  status(): ChannelStatus
  /** 可选：通道能力声明。缺省视为支持表情（保持旧通道行为不变）。 */
  readonly capabilities?: ChannelCapabilities
  /** 可选：主动扫描当前界面/通知里的风控文案（不落盘原文）。 */
  scanRisk?(): Promise<RiskSignal[]>
}

/* ────────────────────────────── 模型层 ────────────────────────────── */

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface LlmMessage {
  role: 'user' | 'assistant'
  /** 纯文本（本插件不发送图片给模型，表情包由本地选）。 */
  text: string
}

export interface LlmRequest {
  /** 稳定不变的前缀（人格 + 规则），用于 provider 前缀缓存。 */
  system: string
  messages: LlmMessage[]
  temperature: number
  maxTokens: number
  /** 思考等级：low/medium/high。默认 low（省 token）。 */
  reasoningEffort?: 'low' | 'medium' | 'high'
  signal?: AbortSignal
}

export interface LlmResult {
  text: string
  usage: LlmUsage
  finishReason: string
  /** 实际使用的 provider/model（审计用）。 */
  provider?: string
  model?: string
  durationMs?: number
}

export interface LlmLike {
  complete(request: LlmRequest): Promise<LlmResult>
}

/* ────────────────────────────── 搜索层 ────────────────────────────── */

export interface SearchSource {
  title?: string
  url: string
  snippet?: string
}

export interface SearchResult {
  content?: string
  sources: SearchSource[]
  truncated?: boolean
}

export interface SearchLike {
  search(query: string, signal?: AbortSignal): Promise<SearchResult>
}

/* ────────────────────────── 运行时依赖（可注入） ────────────────────────── */

export interface Clock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export interface Random {
  /** [0,1) */
  next(): number
}

/** 数据目录内的文件存储（记忆/状态/审计都在这里）。实现需串行化同名写。 */
export interface FileStoreLike {
  readonly root: string
  read(rel: string): Promise<string | null>
  readJson<T>(rel: string): Promise<T | null>
  write(rel: string, text: string): Promise<void>
  writeJson(rel: string, value: unknown): Promise<void>
  append(rel: string, text: string): Promise<void>
  remove(rel: string): Promise<void>
  removeTree(relDir: string): Promise<void>
  list(relDir: string): Promise<string[]>
}

export type NotifyLevel = 'info' | 'warn' | 'critical'

export interface Notifier {
  notify(level: NotifyLevel, title: string, body: string): Promise<void>
}

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
}

/* ────────────────────────────── 状态 ────────────────────────────── */

export interface RateCounter {
  /** 本地小时键，如 2026-10-30T20 */
  hourKey: string
  hourCount: number
  /** 本地日期键，如 2026-10-30 */
  dayKey: string
  dayCount: number
  /** 该联系人最近一次成功回复的 epoch ms（用于最小间隔）。 */
 lastReplyAt: number
}

export interface BudgetState {
  /** 本地日期键 */
  dayKey: string
  spentTokens: number
}

export interface BreakerState {
  tripped: boolean
  reason?: string
  at?: number
}

export interface StatsState {
  llmCalls: number
  llmTokens: number
  drafts: number
  sends: number
  skips: number
  errors: number
  searchDayKey: string
  searchDayCount: number
  searches: number
  /** 长期摘要调用的日键与次数（摘要也占用 token 预算）。 */
  summaryDayKey: string
  summaryCalls: number
  startedAt: number
}

/**
 * 持久化运行时状态（state.json）。
 * - 规则模块以纯函数方式读它；
 * - 引擎负责在关键节点落盘（StateManager）。
 */
export interface RuntimeState {
  version: 1
  paused: boolean
  pauseReason?: string
  pausedAt?: number
  breaker: BreakerState
  budget: BudgetState
  /** key = contactId */
  rate: Record<string, RateCounter>
  /** 去重指纹 -> 首次见到的时间戳 */
  seen: Record<string, number>
  stats: StatsState
  /** 上次成功发送/收到消息的时间（用于“断线恢复”后补状态判断）。 */
  lastActivityAt?: number
}

/* ────────────────────────────── 决策 ────────────────────────────── */

export type SkipReason =
  | 'disabled'
  | 'paused'
  | 'breaker'
  | 'channel-not-ready'
  | 'not-whitelisted'
  | 'group-chat'
  | 'private-chat-disabled'
  | 'persona-disabled'
  | 'self-message'
  | 'self-echo'
  | 'empty-message'
  | 'pure-sticker'
  | 'noise'
  | 'duplicate'
  | 'offline-hours'
  | 'rate-hour-limit'
  | 'rate-day-limit'
  | 'rate-interval'
  | 'low-activity-day-limit'
  | 'budget-hard-stop'
  | 'forbidden-content'
  | 'draft-only'
  | 'model-failed'
  | 'send-failed'
  /** 安全运行模式（safeMode=true 且通道非 mock 时拒绝一切真实发送）。 */
  | 'safe-mode'
  /** 发布前验收：只读测试模式（readOnlyTestMode=true 时拒绝一切真实发送）。 */
  | 'read-only'

export type Decision = { skip: false } | { skip: true; reason: SkipReason; detail?: string }

/* ────────────────────────────── 人格 / 记忆 / 表情 ────────────────────────────── */

export type Emotion = 'happy' | 'playful' | 'shy' | 'comfort' | 'curious' | 'neutral'

export interface PersonaPack {
  /** 人格名（用于日志与提示）。 */
  name: string
  /** 只包含稳定内容的系统提示词（可做前缀缓存）。 */
  systemPrompt: string
  /** few-shot 样例，按消息序列注入到 system 之后的固定前缀中。 */
  examples: Array<{ user: string; assistant: string }>
  sourceDir: string
}

export interface MemoryMessage {
  role: 'user' | 'assistant'
  text: string
  at: number
}

export interface PersonaPackV2 {
  /** 人格包格式版本（2 = 本插件格式；导入 SillyTavern 卡也会映射为 v2）。 */
  version: 2
  /** 稳定 id（用于目录名，需匹配 [a-z0-9-_]）。 */
  id: string
  name: string
  /** 头像：data URI / http(s) URL / emoji / 空字符串。 */
  avatar: string
  /** 性格与说话风格（一句话）。 */
  style: string
  /** 口头禅（随机注入）。 */
  catchphrases: string[]
  /** 系统提示词（性格、价值观、幽默方式、边界、拒绝方式）。 */
  systemPrompt: string
  /** few-shot 示例。 */
  examples: Array<{ user: string; reply: string }>
  /** 禁忌话题（命中的入站消息会触发安全拒绝，不调用模型）。 */
  taboo: string[]
  /** 人格自带表情包（安装时落到人格目录）。 */
  stickers: PersonaStickerRef[]
  author: string
  description: string
  tags: string[]
  /** 人格包版本（语义化字符串即可）。 */
  packVersion: string
  /** 来源：内置 / 市场 / 本地导入。 */
  source?: 'builtin' | 'market' | 'local'
  /** 安装时间（毫秒时间戳；内置为空）。 */
  installedAt?: number
}

/** 人格包中的表情包引用：data URI 直接内嵌，url 由 Host 下载。 */
export interface PersonaStickerRef {
  emotion: Emotion
  name: string
  data?: string
  url?: string
}

/** 人格列表里展示的精简信息。 */
export interface PersonaSummary {
  id: string
  name: string
  avatar: string
  style: string
  description: string
  tags: string[]
  author: string
  packVersion: string
  source: 'builtin' | 'market' | 'local'
  /** 是否为当前启用的人格。 */
  active: boolean
  installedAt?: number
}

/** 远程人格市场索引条目。 */
export interface MarketEntry {
  id: string
  name: string
  description: string
  author: string
  avatar: string
  tags: string[]
  version: string
  downloads: number
  /** 人格包 JSON 的下载地址（远程索引给出）。 */
  url: string
  /** 是否已安装。 */
  installed: boolean
}

/** 市场列表结果：source=remote 表示远端索引可用，builtin 表示回退内置。 */
export interface MarketResult {
  source: 'remote' | 'builtin'
  entries: MarketEntry[]
  /** 回退/失败时的友好提示（不阻塞 UI）。 */
  warning?: string
}

/** 表情包列表情信息（设置页预览用）。 */
export interface StickerSummary {
  /** 全局唯一 id：<origin>:<相对路径>，如 package:happy/001.png。 */
  id: string
  category: Emotion
  name: string
  origin: 'package' | 'uploaded' | 'persona'
  /** 经 Host API 预览的相对 URL（/dsh-wechat-persona/api/sticker-file?id=...&v=...）。 */
  url: string
}

/** 记忆里对联系人的轻量偏好（0 token 规则提取 + 摘要补充）。 */
export interface MemoryProfile {
  /** 对方希望的称呼（如“叫我老王”）。 */
  nickname: string
  /** 忌口/雷区。 */
  taboos: string[]
  /** 最近话题（最新在后，最多 5 个）。 */
  topics: string[]
  updatedAt: number
}

export interface MemoryRecord {
  version: 1
  contactId: string
  contactName: string
  /** 最近消息（上限 config.memory.recentKeep，默认 30）。 */
  recent: MemoryMessage[]
  /** 长期摘要（每 summaryEveryTurns 轮压缩一次）。 */
  summary: string
  /** 累计消息条数（用于触发摘要）。 */
  totalTurns: number
  /** 最近发送过的表情包 id（最新在后），用于不连续重复。 */
  recentStickerIds: string[]
  /** 对联系人的偏好记忆（缺失视为空）。 */
  profile?: MemoryProfile
  updatedAt: number
}

export interface StickerChoice {
  /** 相对 stickers/ 的标识，如 happy/001.png */
  id: string
  category: Emotion
  file: string
}

export type SearchCategory = 'weather' | 'news' | 'meme' | 'location' | 'price' | 'other'

export interface SearchIntent {
  category: SearchCategory
  query: string
  reason: string
}

/* ────────────────────────────── 审计 ────────────────────────────── */

export type AuditEventType =
  | 'start'
  | 'stop'
  | 'resume'
  | 'channel'
  | 'inbound'
  | 'skip'
  | 'risk'
  | 'llm'
  | 'search'
  | 'draft'
  | 'send'
  | 'send-fail'
  | 'summary'
  | 'error'
  | 'config'
  /** 发送生命周期状态推进（9.1，引擎在真实阶段落审计）。 */
  | 'send-state'

export interface AuditLlmInfo {
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  durationMs?: number
  finishReason?: string
}

export interface AuditSearchInfo {
  query: string
  category?: SearchCategory
  sources?: number
  ok: boolean
  durationMs?: number
}

export interface AuditSendInfo {
  kind: 'text' | 'sticker'
  chars?: number
  stickerId?: string
  ok: boolean
  error?: string
  /** 投递三态（P0-2）：审计里保留结果，便于事后排查重复发送/未送达。 */
  delivery?: SendDelivery
  durationMs?: number
}

export interface AuditEvent {
  ts: number
  type: AuditEventType
  contactId?: string
  contactName?: string
  msgId?: string
  reason?: string
  detail?: string
  llm?: AuditLlmInfo
  search?: AuditSearchInfo
  send?: AuditSendInfo
  extra?: Record<string, unknown>
}

export interface AuditLogLike {
  record(event: Omit<AuditEvent, 'ts'> & { ts?: number }): Promise<void>
  /** 最近 n 条（新的在后）。 */
  recent(n: number): Promise<AuditEvent[]>
  /** 今日统计摘要（token / 调用次数 / skip 分布 / 发送数）。 */
  summary(): Promise<AuditSummary>
  clear(): Promise<void>
}

export interface AuditSummary {
  dayKey: string
  llmCalls: number
  llmTokens: number
  cacheReadTokens: number
  searches: number
  sends: number
  drafts: number
  skips: Record<string, number>
  lastEventAt?: number
}

/* ────────────────────────────── 引擎 ────────────────────────────── */

export interface EngineDeps {
  config: WechatPersonaConfig
  logger: Logger
  clock: Clock
  random: Random
  store: FileStoreLike
  channel: Channel
  llm: LlmLike
  /** 未启用搜索时为 null。 */
  search: SearchLike | null
  notifier: Notifier
  state: RuntimeState
  audit: AuditLogLike
  memory: MemoryStoreLike
  stickers: StickerCatalogLike
  persona: PersonaPack
  /** 引擎在关键状态变化后调用，由 host 层落盘 state.json。 */
  saveState(): Promise<void>
  /** 生成发送操作 id（9.4 幂等；测试可注入确定性实现，默认用时间戳+随机数）。 */
  nextOperationId?: () => string
}

/** 发送投递三态累计计数（status 对外可见，P0-2）。 */
export interface SendDeliveryCounts {
  sent: number
  notSent: number
  unknown: number
}

/* ─────────────────────── 发送草稿 / 人工确认（13.4） ─────────────────────── */

export type DraftStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/**
 * 待发送草稿（sendMode=draft/confirm 或 safeMode 下生成，持久化到 dataDir/drafts.json）。
 *
 * `id` 同时也是幂等账本的发送操作 id：同一草稿即使被重复批准，也只会真正发送一次
 * （unknown 结果绝不自动重发，见 send-ledger.ts 与任务书 9.3/9.4）。
 */
export interface SendDraft {
  id: string
  opId: string
  contactId: string
  contactName?: string
  text: string
  createdAt: number
  expiresAt: number
  status: DraftStatus
  /** 生成原因：draft-mode / confirm-mode / safe-mode / budget-draft / budget-exhausted。 */
  reason: string
  /** 实际投递三态（批准发送后才有）。 */
  delivery?: SendDelivery
  /** 最近一次批准尝试的失败原因（展示给用户）。 */
  lastError?: string
}

/** 草稿批准/拒绝结果（POST /drafts/approve、POST /drafts/reject）。 */
export interface DraftDecisionResult {
  ok: boolean
  error?: string
  detail?: string
  delivery?: SendDelivery
  draft?: SendDraft
  result?: SendResult
}

/** 供 DSH 工具 / 服务查询的只读状态快照。 */
export interface EngineStatus {
  personaName: string
  channelId: ChannelId
  channelState: ChannelState
  channelDetail?: string
  paused: boolean
  pauseReason?: string
  breaker: BreakerState
  budget: BudgetState
  budgetPhase: 'ok' | 'draft' | 'exhausted'
  stats: StatsState
  today: AuditSummary
  contacts: number
  online: boolean
  lowActivityDay: boolean
  /** 下次上线时间（毫秒时间戳；当前在线或常开时为 now，永不上线为 null）。 */
  nextOnlineAt?: number | null
  startedAt: number
  lastActivityAt?: number
  /** 发送尝试的投递三态计数（P0-2：sent / notSent / unknown）。 */
  delivery?: SendDeliveryCounts
  /** 暂停期间暂存、等待恢复后按序补处理的消息条数（P1-4）。 */
  deferredCount?: number
  /** 安全运行模式（Phase F，默认 false）。 */
  safeMode?: boolean
  /** 发送模式（13.4：auto / draft / confirm）。 */
  sendMode?: SendMode
  /** 待人工批准的草稿条数（13.4）。 */
  pendingDrafts?: number
  /** 最近一次发送生命周期状态（9.1）。 */
  sendState?: string
  /**
   * 只读测试模式（发布前验收，任务书第五部分；持久化配置，重启后仍生效）。
   * 为 true 时代码层拒绝一切真实通道发送与键鼠模拟。
   */
  readOnlyTestMode?: boolean
  /**
   * v3.0.0-beta.1 预览版安全闸门（默认 true）：真实通道默认禁止发送，只允许 mock 空转。
   * 该字段同时出现在 `config.betaSafeMode` 与 `EngineStatus`，便于设置页/验收脚本核对。
   */
  betaSafeMode?: boolean
}

/** memory.ts 暴露的接口（engine 依赖）。 */
export interface MemoryStoreLike {
  get(contactId: string, contactName: string): Promise<MemoryRecord>
  /** 最近 n 条（旧的在前）。 */
  recent(contactId: string, contactName: string, n: number): Promise<MemoryMessage[]>
  summaryOf(contactId: string, contactName: string): Promise<string>
  append(contactId: string, contactName: string, message: MemoryMessage): Promise<void>
  setSummary(contactId: string, contactName: string, summary: string): Promise<void>
  lastStickerIds(contactId: string, contactName: string): Promise<string[]>
  rememberSticker(contactId: string, contactName: string, stickerId: string): Promise<void>
  /** 读取联系人的轻量偏好（称呼/忌口/话题）；未实现或没有时返回 undefined。 */
  profileOf?(contactId: string, contactName: string): Promise<MemoryProfile | undefined>
  /** 合并偏好片段（0 token 规则提取的结果）。 */
  mergeProfile?(
    contactId: string,
    contactName: string,
    patch: Partial<MemoryProfile>,
    now: number,
  ): Promise<MemoryProfile>
  /** totalTurns 达到阈值时返回 true（引擎负责真正调用摘要）。 */
  shouldSummarize(contactId: string, contactName: string): Promise<boolean>
  clear(contactId?: string): Promise<void>
  listContacts(): Promise<string[]>
  flush(): Promise<void>
}

/** stickers.ts 暴露的接口（engine 依赖）。 */
export interface StickerCatalogLike {
  categories(): Emotion[]
  count(): number
  pick(category: Emotion, recentIds: readonly string[]): StickerChoice | null
  /** 分类缺失时的兜底：任意分类里挑一个不重复的。 */
  pickAny(recentIds: readonly string[]): StickerChoice | null
}

/* ────────────────────────── Host 控制面（设置页 API） ────────────────────────── */

/** 控制面依赖的人格库接口（persona-library.ts 实现）。 */
export interface PersonaLibraryLike {
  list(activeId: string): Promise<PersonaSummary[]>
  get(id: string): Promise<PersonaPackV2 | null>
  install(pack: PersonaPackV2, source: 'market' | 'local'): Promise<PersonaSummary>
  importJson(input: unknown): Promise<PersonaSummary>
  uninstall(id: string): Promise<boolean>
  exportPack(id: string): Promise<PersonaPackV2 | null>
}

/** 控制面依赖的人格市场接口（persona-market.ts 实现）。 */
export interface PersonaMarketLike {
  fetchIndex(): Promise<MarketResult>
  install(id: string): Promise<{ persona: PersonaSummary; updated: boolean }>
}

/** 设置页可管理/预览的表情包目录（stickers.ts 扩展方法）。 */
export interface StickerCatalogApi extends StickerCatalogLike {
  reload(): Promise<void>
  list(): StickerSummary[]
  /** 按全局 id 取本地文件绝对路径（预览/删除用）；找不到返回 null。 */
  fileOf(id: string): string | null
}

/** 引擎控制面（server/api.ts 依赖；PersonaEngine 实现）。 */
export interface PersonaEngineLike {
  status(): Promise<EngineStatus>
  pause(reason: string): Promise<void>
  resume(): Promise<void>
  sendTest(contactId: string, text: string): Promise<SendResult>
  handleInbound(message: InboundMessage): Promise<void>
  clearMemory(contactId?: string): Promise<void>
  clearAudit(): Promise<void>
  /** 设置页切换人格后热更新（不必重载插件）。 */
  setPersona?(pack: PersonaPack): void
  /** 上传/删除表情后热更新目录。 */
  setStickers?(catalog: StickerCatalogLike): void
  /** 待发送草稿（13.4：sendMode=draft/confirm 或 safeMode 下生成）。 */
  listDrafts?(): Promise<SendDraft[]>
  /** 人工批准草稿：重新走全部门禁 + 幂等账本后发送。 */
  approveDraft?(id: string): Promise<DraftDecisionResult>
  /** 人工拒绝草稿。 */
  rejectDraft?(id: string): Promise<DraftDecisionResult>
  /** OCR 只读诊断（duck-typing；通道未提供时由 API 层降级 available:false）。 */
  ocrDiagnostics?(): Promise<unknown>
}

/** 配置持久化状态（设置页显示“已保存/不可写/上次错误”）。 */
export interface ConfigPersistenceInfo {
  /** 是否可写（configEditor 可用且找到本插件 entry）。 */
  editable: boolean
  /** 不可写时的原因（展示给用户）。 */
  reason?: string
  /** 最近一次成功保存时间（毫秒时间戳）。 */
  lastSavedAt?: number
  /** 最近一次保存失败的错误。 */
  lastError?: string
}

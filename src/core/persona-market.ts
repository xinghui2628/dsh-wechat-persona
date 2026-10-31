/**
 * 人格市场（PersonaMarket）：远程索引 + 内置人格回退 + 按需下载安装。
 *
 * 数据流：
 * - `fetchIndex()`：GET config.market.indexUrl 的 JSON 索引
 *   （格式 `{version, personas:[{id,name,description,author,avatar,tags,version,downloads,url}]}`）；
 *   未配置 URL / builtinOnly / 网络失败 / 超时 / 格式错误 → 回退内置人格列表，
 *   返回 `{source:'builtin', warning}`，**绝不抛异常**（设置页不白屏）。
 * - `install(id)`：在索引里找到条目 → 下载条目 url 的 pack JSON → parsePersonaPack()
 *   （兼容本插件 v2 包与 SillyTavern 角色卡）→ PersonaLibrary.install(..., 'market')。
 *   索引找不到 / 无下载地址 / 下载失败 / 包格式错误 → 抛普通 Error，由 Host API 层转 `{ok:false}`。
 *
 * 依赖注入：fetchImpl / timeoutMs 可注入，测试不碰网络；library 用接口类型，测试可给假实现。
 */

import type { WechatPersonaConfig } from '../config.ts'
import type {
  Logger,
  MarketEntry,
  MarketResult,
  PersonaLibraryLike,
  PersonaMarketLike,
  PersonaSummary,
} from '../types.ts'
import { isValidPersonaId, parsePersonaPack, sanitizePersonaId } from './persona-library.ts'

/* ────────────────────────────── 小工具 ────────────────────────────── */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown, limit = 20): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const text = stringValue(item)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/** fetch 的最小抽象：便于测试注入；默认用全局 fetch。 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** 远程索引里最多接受的条目数（防止畸形索引拖垮 UI）。 */
const MAX_INDEX_ENTRIES = 200
/** 超时兜底默认值（config.market.timeoutMs 缺失/非法时）。 */
const DEFAULT_TIMEOUT_MS = 8000
const MIN_TIMEOUT_MS = 1
const MAX_TIMEOUT_MS = 600000

/* ────────────────────────────── 构造函数参数 ────────────────────────────── */

export interface PersonaMarketOptions {
  /** 插件配置（读 market.indexUrl / market.builtinOnly / market.timeoutMs / persona.activeId）。 */
  config: WechatPersonaConfig
  /** 人格库（安装落盘、列已安装状态）。 */
  library: PersonaLibraryLike
  /** 内置索引条目（回退时展示）；留空时从 library.list() 的内置人格推导。 */
  personas?: MarketEntry[]
  logger: Logger
  /** 注入 fetch（测试用）；默认 globalThis.fetch。 */
  fetchImpl?: FetchLike
  /** 覆盖 config.market.timeoutMs。 */
  timeoutMs?: number
}

/* ────────────────────────────── 索引条目归一化 ────────────────────────────── */

/** 把一条原始索引数据归一化成 MarketEntry；id 非法返回 null（由调用方跳过）。 */
function normalizeMarketEntry(input: unknown): MarketEntry | null {
  if (!isRecord(input)) return null
  const id = sanitizePersonaId(input.id ?? input.name)
  if (!isValidPersonaId(id)) return null
  const downloads =
    typeof input.downloads === 'number' && Number.isFinite(input.downloads)
      ? Math.max(0, Math.floor(input.downloads))
      : 0
  return {
    id,
    name: stringValue(input.name) || id,
    description: stringValue(input.description),
    author: stringValue(input.author) || '未知作者',
    avatar: stringValue(input.avatar),
    tags: stringArray(input.tags),
    version: stringValue(input.version) || stringValue(input.packVersion) || '1.0.0',
    downloads,
    url: stringValue(input.url),
    installed: input.installed === true,
  }
}

/* ────────────────────────────── 人格市场 ────────────────────────────── */

export class PersonaMarket implements PersonaMarketLike {
  private readonly config: WechatPersonaConfig
  private readonly library: PersonaLibraryLike
  private readonly logger: Logger
  private readonly fetchImpl: FetchLike | null
  private readonly timeoutMs: number
  /** 显式注入的内置索引（Normalize 后的副本）。 */
  private readonly injectedBuiltin: MarketEntry[]

  constructor(opts: PersonaMarketOptions) {
    if (!opts || typeof opts !== 'object') throw new Error('PersonaMarket 构造参数缺失')
    if (!opts.config || typeof opts.config !== 'object') throw new Error('PersonaMarket 缺少 config')
    if (!opts.library) throw new Error('PersonaMarket 缺少 library')
    if (!opts.logger) throw new Error('PersonaMarket 缺少 logger')
    this.config = opts.config
    this.library = opts.library
    this.logger = opts.logger
    this.fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null

    const configured =
      typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
        ? opts.timeoutMs
        : Number((opts.config.market && opts.config.market.timeoutMs) || DEFAULT_TIMEOUT_MS)
    this.timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(configured)))

    const injected: MarketEntry[] = []
    for (const item of Array.isArray(opts.personas) ? opts.personas : []) {
      const entry = normalizeMarketEntry(item)
      if (entry) injected.push(entry)
    }
    this.injectedBuiltin = injected
  }

  /* ─────────────── 索引 ─────────────── */

  /**
   * 拉取人格市场索引。任何失败都回退内置人格列表并带 warning，绝不 reject。
   */
  async fetchIndex(): Promise<MarketResult> {
    const market = this.config.market ?? { indexUrl: '', builtinOnly: false, timeoutMs: this.timeoutMs }
    const indexUrl = stringValue(market.indexUrl)
    if (market.builtinOnly === true || !indexUrl) {
      return this.builtinResult()
    }
    try {
      const raw = await this.fetchJson(indexUrl, '拉取人格索引')
      const entries = this.normalizeIndex(raw)
      const installed = await this.installedIds()
      const mapped = entries.map((entry) => ({ ...entry, tags: [...entry.tags], installed: installed.has(entry.id) }))
      this.logger.debug('persona-market: 远程人格索引已加载', { url: indexUrl, entries: mapped.length })
      return { source: 'remote', entries: mapped }
    } catch (error) {
      const reason = errorText(error)
      this.logger.warn('persona-market: 远程人格索引不可用，已回退内置人格', {
        url: indexUrl,
        error: reason,
      })
      return this.builtinResult(`远程人格索引不可用，已回退内置人格：${reason}`)
    }
  }

  /**
   * 从市场安装人格：下载 pack JSON → PersonaLibrary.install(..., 'market')。
   * 失败抛普通 Error（API 层转 {ok:false}）；`updated` 表示是否覆盖了已安装副本。
   */
  async install(id: string): Promise<{ persona: PersonaSummary; updated: boolean }> {
    const rawId = typeof id === 'string' ? id.trim() : ''
    const safeId = sanitizePersonaId(rawId)
    if (!isValidPersonaId(safeId)) throw new Error(`人格 id 非法：${rawId || '(空)'}`)

    const index = await this.fetchIndex()
    const entry = index.entries.find((item) => item.id === safeId)
    if (!entry) throw new Error(`人格市场中找不到 id：${safeId}`)
    if (!entry.url) {
      throw new Error(
        index.source === 'builtin'
          ? `「${entry.name}」是内置人格，无需安装，可直接启用`
          : `「${entry.name}」没有提供下载地址`,
      )
    }

    const packUrl = this.assertHttpUrl(entry.url)
    const raw = await this.fetchJson(packUrl, `下载人格包「${entry.name}」`)
    // 索引 id 是市场里的稳定身份：下载到的包若自带别的 id，统一收敛到索引 id，避免列表出现重复人格。
    const pack = parsePersonaPack(raw)
    pack.id = safeId

    const before = await this.library.get(safeId)
    const updated = before !== null && before.source !== 'builtin'
    const persona = await this.library.install(pack, 'market')
    this.logger.info('persona-market: 人格已从市场安装', {
      id: persona.id,
      name: persona.name,
      updated,
      url: packUrl,
    })
    return { persona, updated }
  }

  /* ─────────────── 内部 ─────────────── */

  /** 回退内置人格列表；entries 为空时追加提示，避免设置页空白。 */
  private async builtinResult(warning?: string): Promise<MarketResult> {
    const entries = await this.builtinEntries()
    const result: MarketResult = { source: 'builtin', entries }
    const extra = entries.length === 0 ? '没有找到可用的内置人格，请检查插件安装是否完整' : warning
    if (extra) result.warning = extra
    return result
  }

  /** 内置人格条目：优先用构造时注入的数据，否则从人格库的内置人格推导。 */
  private async builtinEntries(): Promise<MarketEntry[]> {
    if (this.injectedBuiltin.length > 0) {
      // 内置人格随包分发、天然可用，installed 固定 true（可直接启用）。
      return this.injectedBuiltin.map((entry) => ({ ...entry, tags: [...entry.tags], installed: true }))
    }
    try {
      const summaries = await this.library.list(stringValue(this.config.persona?.activeId))
      return summaries
        .filter((summary) => summary.source === 'builtin')
        .map((summary) => ({
          id: summary.id,
          name: summary.name,
          description: summary.description,
          author: summary.author,
          avatar: summary.avatar,
          tags: [...summary.tags],
          version: summary.packVersion,
          downloads: 0,
          url: '',
          installed: true,
        }))
    } catch (error) {
      this.logger.warn('persona-market: 读取内置人格列表失败', { error: errorText(error) })
      return []
    }
  }

  /** 当前已安装人格 id 集合（内置不算；读取失败时按空集处理，只影响“已安装”标记）。 */
  private async installedIds(): Promise<Set<string>> {
    try {
      const summaries = await this.library.list(stringValue(this.config.persona?.activeId))
      return new Set(summaries.filter((summary) => summary.source !== 'builtin').map((summary) => summary.id))
    } catch (error) {
      this.logger.warn('persona-market: 读取已安装人格失败，市场“已安装”标记可能不准确', {
        error: errorText(error),
      })
      return new Set()
    }
  }

  /** 解析索引 JSON：接受 `{version, personas:[...]}` 或直接数组；逐条归一化并去重。 */
  private normalizeIndex(raw: unknown): MarketEntry[] {
    const list = Array.isArray(raw)
      ? raw
      : isRecord(raw) && Array.isArray(raw.personas)
        ? raw.personas
        : null
    if (!list) throw new Error('索引格式错误：应为 {version, personas:[...]}')
    const entries: MarketEntry[] = []
    const seen = new Set<string>()
    for (const item of list) {
      const entry = normalizeMarketEntry(item)
      if (!entry) {
        this.logger.debug('persona-market: 索引条目格式非法，已跳过')
        continue
      }
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      entries.push(entry)
      if (entries.length >= MAX_INDEX_ENTRIES) break
    }
    if (entries.length === 0) throw new Error('索引格式错误：没有可用的 persona 条目')
    return entries
  }

  /** GET 一个 JSON 地址；失败统一抛带上下文的 Error（超时/网络/HTTP/JSON 都覆盖）。 */
  private async fetchJson(url: string, action: string): Promise<unknown> {
    const fetcher = this.resolveFetch()
    if (!fetcher) throw new Error(`${action}失败：当前运行环境不支持 fetch`)
    const signal = this.timeoutSignal()
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const reason =
        name === 'AbortError' || name === 'TimeoutError'
          ? `请求超时（${this.timeoutMs}ms）`
          : errorText(error)
      throw new Error(`${action}失败：${reason}`)
    }
    if (!response || typeof response.ok !== 'boolean') {
      throw new Error(`${action}失败：fetch 返回值不是有效响应`)
    }
    if (!response.ok) throw new Error(`${action}失败：HTTP ${response.status}`)
    try {
      return (await response.json()) as unknown
    } catch (error) {
      throw new Error(`${action}失败：响应不是合法 JSON（${errorText(error)}）`)
    }
  }

  /** 默认用全局 fetch；可注入替身。 */
  private resolveFetch(): FetchLike | null {
    if (this.fetchImpl) return this.fetchImpl
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis) as FetchLike
    return null
  }

  /** 构造超时信号；运行环境不支持 AbortSignal.timeout 时退回 undefined（仅靠 fetch 自身超时）。 */
  private timeoutSignal(): AbortSignal | undefined {
    try {
      return AbortSignal.timeout(this.timeoutMs)
    } catch {
      return undefined
    }
  }

  /** 只允许 http/https 下载人格包（拒绝 file:/data:/javascript: 等危险协议）。 */
  private assertHttpUrl(url: string): string {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`人格包下载地址非法：${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`人格包下载地址只支持 http/https：${url}`)
    }
    return parsed.toString()
  }
}

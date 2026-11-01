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

import { lookup as dnsLookup } from 'node:dns/promises'
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

/* ────────────────────── 远程下载安全（任务书 10.3 SSRF 防护） ────────────────────── */

/** 远程 JSON 响应体上限（2MB；Content-Length 与流式读取双重限制）。 */
export const MARKET_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** 最多跟随的重定向次数（每一跳都重新做协议/内网校验）。 */
export const MARKET_MAX_REDIRECTS = 2
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** 允许的 JSON Content-Type（application/json 与 application/*+json）。 */
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.+-]*\+)?json\b/i

/** 统一读取响应头（兼容标准 Headers 与测试替身/普通对象）。 */
function responseHeader(response: unknown, name: string): string {
  const headers = (response as { headers?: unknown } | null | undefined)?.headers
  if (!headers) return ''
  const getter = (headers as { get?: unknown }).get
  if (typeof getter === 'function') {
    const value = (getter.call(headers, name) as unknown) ?? ''
    return String(value)
  }
  const record = headers as Record<string, unknown>
  const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase())
  return key ? String(record[key] ?? '') : ''
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '')
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [first, second] = octets as [number, number, number, number]
  if (first === 0 || first === 10 || first === 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  // 运营商级 NAT 100.64.0.0/10（内网性质，同样拒绝）
  if (first === 100 && second >= 64 && second <= 127) return true
  // 基准测试保留段 198.18.0.0/15 与组播/保留段 224.0.0.0/3 同样不允许
  if (first === 198 && (second === 18 || second === 19)) return true
  if (first >= 224) return true
  return false
}

/** 解析 IPv6 文本为 8 个 16 位分组；支持 `::` 压缩与内嵌 IPv4；非法返回 null。 */
function parseIpv6Groups(host: string): number[] | null {
  const text = host.replace(/%.*$/, '').toLowerCase()
  if (text === '' || !text.includes(':')) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parsePart = (part: string): number[] | null => {
    if (part === '') return []
    const groups: number[] = []
    for (const item of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null
      groups.push(Number.parseInt(item, 16))
    }
    return groups
  }
  const head = parsePart(halves[0] ?? '')
  if (!head) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const tail = parsePart(halves[1] ?? '')
  if (!tail) return null
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail]
  return groups.length === 8 ? groups : null
}

/** 从 IPv6 分组中提取内嵌 IPv4（IPv4-mapped / IPv4-compatible / NAT64 64:ff9b::/96）。 */
function embeddedIpv4(groups: number[]): string | null {
  const high = groups[6] ?? 0
  const low = groups[7] ?? 0
  const ipv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  // ::ffff:a.b.c.d（IPv4-mapped）
  if (groups.slice(0, 5).every((value) => value === 0) && groups[5] === 0xffff) return ipv4
  // ::a.b.c.d（IPv4-compatible）：排除 :: 与 ::1（回环另判）
  if (
    groups.slice(0, 6).every((value) => value === 0) &&
    !(groups[6] === 0 && (groups[7] === 0 || groups[7] === 1))
  ) {
    return ipv4
  }
  // 64:ff9b::/96（NAT64）
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((value) => value === 0)) {
    return ipv4
  }
  return null
}

/**
 * 判断主机名是否指向本机 / 内网 / 保留地址（SSRF 防护，任务书 10.3 / next §7）。
 *
 * 覆盖：localhost、`.local` / `.internal` / `.localhost`、IPv4 私有/回环/链路本地/
 * CGNAT/基准测试段/组播保留段、IPv6 回环（::1）、IPv6 ULA（fc00::/7）、IPv6 链路本地
 * （fe80::/10）、IPv6 组播（ff00::/8）、IPv4-mapped / IPv4-compatible / NAT64 内嵌 IPv4、
 * 纯数字主机名（十进制 IP 变体）。
 */
export function isPrivateMarketHost(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (!host) return true
  if (host === 'localhost' || host === '0.0.0.0') return true
  if (host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return true
  }
  if (host.includes(':')) {
    const groups = parseIpv6Groups(host)
    // 非法 IPv6 一律按不可信处理
    if (!groups) return true
    // ::（未指定地址）
    if (groups.every((value) => value === 0)) return true
    // ::1（回环）
    if (groups.slice(0, 7).every((value) => value === 0) && groups[7] === 1) return true
    // IPv4-mapped / IPv4-compatible / NAT64：按内嵌 IPv4 判定
    const ipv4 = embeddedIpv4(groups)
    if (ipv4 !== null) return isPrivateIpv4(ipv4)
    // fc00::/7（唯一本地地址）
    if ((groups[0]! & 0xfe00) === 0xfc00) return true
    // fe80::/10（链路本地）
    if ((groups[0]! & 0xffc0) === 0xfe80) return true
    // ff00::/8（组播）
    if ((groups[0]! & 0xff00) === 0xff00) return true
    // 2001:db8::/32（文档保留段）
    if (groups[0] === 0x2001 && groups[1] === 0xdb8) return true
    return false
  }
  // 纯数字主机名（如 2130706433）一律拒绝，避免十进制 IP 绕过点分检查。
  if (/^\d+$/.test(host)) return true
  const dotParts = host.split('.')
  if (dotParts.every((part) => /^\d+$/.test(part)) && dotParts.length > 0) {
    // 非标准点分写法（如 "127.1"、"10.1"）：按内网处理更安全。
    return dotParts.length !== 4 || isPrivateIpv4(host)
  }
  return false
}

/**
 * 校验远程地址：只允许 http/https、拒绝内嵌凭据、拒绝本机/内网地址。
 *
 * 错误信息**不回显原始 URL**（避免把内网地址写进设置页/日志响应），只给原因。
 */
export function assertSafeMarketUrl(rawUrl: string, label = '远程地址'): string {
  const text = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`${label}不是合法 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label}只支持 http/https`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label}不允许包含用户名或密码`)
  }
  if (isPrivateMarketHost(parsed.hostname)) {
    throw new Error(`${label}不允许指向本机或内网地址（已拒绝，防 SSRF）`)
  }
  return parsed.toString()
}

/* ────────────────────── DNS 解析后校验（防 DNS rebinding） ────────────────────── */

/** 主机名解析器：返回该主机名对应的全部 IP（测试可注入以避免真实 DNS）。 */
export type MarketHostResolver = (hostname: string) => Promise<string[]>

/** 默认解析器：`node:dns` 解析全部 A/AAAA 记录。 */
async function defaultMarketHostResolver(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

/** 主机名是否为 IP 字面量（点分 IPv4 或含冒号的 IPv6）。 */
function isIpLiteralHost(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/**
 * 校验远程地址并解析 DNS：在字符串校验之后，对域名做真实解析并拒绝任何解析到
 * 本机/内网/保留地址的结果（防 DNS rebinding，任务书 next §7）。
 *
 * 错误信息不回显解析出的 IP 或原始 URL。
 */
export async function assertSafeResolvedMarketUrl(
  rawUrl: string,
  label = '远程地址',
  resolver: MarketHostResolver = defaultMarketHostResolver,
): Promise<string> {
  const safeUrl = assertSafeMarketUrl(rawUrl, label)
  const parsed = new URL(safeUrl)
  if (isIpLiteralHost(parsed.hostname)) return safeUrl
  let addresses: string[]
  try {
    addresses = await resolver(normalizeHostname(parsed.hostname))
  } catch {
    throw new Error(`${label}的域名解析失败`)
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`${label}的域名解析失败`)
  }
  for (const address of addresses) {
    if (isPrivateMarketHost(address)) {
      throw new Error(`${label}解析到本机或内网地址（已拒绝，防 SSRF/DNS rebinding）`)
    }
  }
  return safeUrl
}


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
  /**
   * 注入 DNS 解析器（测试用）；默认 node:dns。
   * 传 null 可禁用解析后校验（仅测试替身场景使用）。
   */
  resolveHostname?: MarketHostResolver | null
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
  /** DNS 解析器：null 表示不做解析后校验（测试注入 fetch 且未注入解析器时）。 */
  private readonly resolveHostname: MarketHostResolver | null
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
    this.resolveHostname = typeof opts.resolveHostname === 'function' ? opts.resolveHostname : null

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
      // 10.3：远程索引地址必须先过 SSRF 校验（非 http/https、本机/内网直接拒绝）。
      const safeIndexUrl = assertSafeMarketUrl(indexUrl, '人格索引地址')
      const raw = await this.fetchJson(safeIndexUrl, '拉取人格索引')
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

    const packUrl = assertSafeMarketUrl(entry.url, `人格包「${entry.name}」的下载地址`)
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

  /**
   * GET 一个 JSON 地址；失败统一抛带上下文的 Error（超时/网络/HTTP/JSON 都覆盖）。
   *
   * 统一走模块级 fetchRemoteJson：协议/内网地址校验、DNS 解析后校验（防 rebinding）、
   * 手动跟随重定向（最多 2 跳且每跳重新校验）、JSON Content-Type、2MB 双重上限。
   */
  private async fetchJson(url: string, action: string): Promise<unknown> {
    const fetcher = this.resolveFetch()
    if (!fetcher) throw new Error(`${action}失败：当前运行环境不支持 fetch`)
    // 测试注入 fetchImpl 时默认不做真实 DNS（避免联网）；显式注入 resolveHostname 时按注入执行。
    // 生产环境（未注入 fetch）默认启用 DNS 解析后校验，防 DNS rebinding。
    const resolver = this.resolveHostname ?? (this.fetchImpl === null ? defaultMarketHostResolver : null)
    return fetchRemoteJson(url, {
      fetchImpl: fetcher,
      action,
      timeoutMs: this.timeoutMs,
      resolveHostname: resolver,
    })
  }

  /** 默认用全局 fetch；可注入替身。 */
  private resolveFetch(): FetchLike | null {
    if (this.fetchImpl) return this.fetchImpl
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis) as FetchLike
    return null
  }
}

/* ─────────────────────── 远程 JSON 下载（统一 SSRF 校验） ─────────────────────── */

/** fetchRemoteJson 的选项；抽成模块级便于 API 层（/personas/install {url}）复用同一套校验。 */
export interface RemoteJsonFetchOptions {
  /** 注入 fetch（默认 globalThis.fetch）。 */
  fetchImpl?: FetchLike | null
  /** 动作名，用于错误信息（如「拉取人格索引」）。 */
  action: string
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number
  /** 注入 DNS 解析器；不传时用 node:dns；传 null 表示禁用解析校验（测试替身用）。 */
  resolveHostname?: MarketHostResolver | null
  /** 响应体上限（默认 MARKET_MAX_RESPONSE_BYTES）。 */
  maxBytes?: number
  /** 是否要求 JSON Content-Type（默认 true）。 */
  requireJsonContentType?: boolean
}

/** 人类可读的字节上限文案（2MB / N 字节）。 */
function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (Number.isInteger(mb)) return `${mb}MB`
  return `${bytes} 字节`
}

/** 构造超时信号；运行环境不支持 AbortSignal.timeout 时退回 undefined（仅靠 fetch 自身超时）。 */
function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(timeoutMs)
  } catch {
    return undefined
  }
}

/** 读取响应文本；优先流式读取以便在超大响应时尽早中止（10.3 / next §7）。 */
async function readResponseText(response: Response, action: string, maxBytes: number): Promise<string> {
  const body = (response as { body?: unknown }).body
  const getReader = body && typeof (body as { getReader?: unknown }).getReader === 'function'
    ? (body as ReadableStream<Uint8Array>).getReader.bind(body)
    : null
  if (getReader) {
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // 取消失败不影响结论
        }
        throw new Error(`${action}失败：响应体超过 ${formatLimit(maxBytes)} 上限`)
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8').decode(merged)
  }
  const textFn = (response as { text?: unknown }).text
  if (typeof textFn === 'function') {
    return await (textFn as () => Promise<string>).call(response)
  }
  // 兼容极简测试替身：只有 json()
  if (typeof response.json === 'function') {
    return JSON.stringify(await response.json())
  }
  throw new Error(`${action}失败：响应没有可读内容`)
}

/**
 * GET 一个 JSON 地址并做完整校验（任务书 10.3 / next §7）：
 * - 协议仅 http/https、拒绝内嵌凭据、拒绝本机/内网/保留地址；
 * - 域名解析后再次校验所有 IP（防 DNS rebinding / 重绑定）；
 * - 手动跟随重定向，最多 MARKET_MAX_REDIRECTS 跳，每跳都重新校验；
 * - 要求 JSON Content-Type；
 * - 响应体上限（Content-Length + 流式读取双重限制）；
 * - 错误信息不回显原始 URL 或解析出的 IP。
 */
export async function fetchRemoteJson(rawUrl: string, options: RemoteJsonFetchOptions): Promise<unknown> {
  const action = options.action
  const fetcher =
    options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as FetchLike) : null)
  if (!fetcher) throw new Error(`${action}失败：当前运行环境不支持 fetch`)
  const configuredTimeout = options.timeoutMs
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(
      MIN_TIMEOUT_MS,
      Math.floor(Number.isFinite(configuredTimeout) ? (configuredTimeout as number) : DEFAULT_TIMEOUT_MS),
    ),
  )
  const maxBytes =
    typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : MARKET_MAX_RESPONSE_BYTES
  const requireJson = options.requireJsonContentType !== false
  const resolver = options.resolveHostname === undefined ? defaultMarketHostResolver : options.resolveHostname

  let currentUrl = assertSafeMarketUrl(rawUrl, `${action}的请求地址`)
  if (resolver) currentUrl = await assertSafeResolvedMarketUrl(currentUrl, `${action}的请求地址`, resolver)

  for (let redirects = 0; ; redirects += 1) {
    const signal = timeoutSignal(timeoutMs)
    let response: Response
    try {
      response = await fetcher(currentUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal,
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const reason =
        name === 'AbortError' || name === 'TimeoutError' ? `请求超时（${timeoutMs}ms）` : errorText(error)
      throw new Error(`${action}失败：${reason}`)
    }
    if (!response || typeof response.ok !== 'boolean') {
      throw new Error(`${action}失败：fetch 返回值不是有效响应`)
    }
    if (REDIRECT_STATUSES.has(Number(response.status))) {
      if (redirects >= MARKET_MAX_REDIRECTS) {
        throw new Error(`${action}失败：重定向次数超过上限（${MARKET_MAX_REDIRECTS} 次）`)
      }
      const location = responseHeader(response, 'location').trim()
      if (!location) throw new Error(`${action}失败：重定向响应缺少 Location`)
      let nextUrl: string
      try {
        nextUrl = new URL(location, currentUrl).toString()
      } catch {
        throw new Error(`${action}失败：重定向地址非法`)
      }
      // 每一跳都重新做协议 + 内网地址 + DNS 解析校验，防止 302 到内网域名（rebinding 变体）。
      currentUrl = assertSafeMarketUrl(nextUrl, `${action}的重定向地址`)
      if (resolver) currentUrl = await assertSafeResolvedMarketUrl(currentUrl, `${action}的重定向地址`, resolver)
      continue
    }
    if (!response.ok) throw new Error(`${action}失败：HTTP ${response.status}`)
    if (requireJson) {
      const contentType = responseHeader(response, 'content-type').trim()
      if (!JSON_CONTENT_TYPE.test(contentType)) {
        throw new Error(`${action}失败：响应 Content-Type 不是 JSON`)
      }
    }
    const declaredLength = Number(responseHeader(response, 'content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`${action}失败：响应体超过 ${formatLimit(maxBytes)} 上限`)
    }
    const text = await readResponseText(response, action, maxBytes)
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`${action}失败：响应体超过 ${formatLimit(maxBytes)} 上限`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`${action}失败：响应不是合法 JSON`)
    }
  }
}

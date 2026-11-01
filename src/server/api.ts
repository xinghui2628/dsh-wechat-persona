/**
 * Host HTTP API 纯逻辑层（`/dsh-wechat-persona/api/`）。
 *
 * 设计要点：
 * - 纯逻辑与传输分离：`createPersonaApi()` 只负责鉴权、路由、参数校验与调用
 *   注入的依赖，返回 `ApiResponse`（JSON 或二进制）；`attachPersonaRoutes()`
 *   负责 node:http 的请求体读取、JSON 解析与响应写出，由宿主 webServer 注册。
 * - 任何路径都不向宿主抛异常：`handle()` 最外层 try/catch，统一返回
 *   `{ ok:false, error, detail? }`；attach 的 handler 也再兜一层 500。
 * - 鉴权：只接受回环 socket、`x-dsh-wechat-persona: 1` 请求头，并校验 Host /
 *   Origin / Sec-Fetch-Site 以降低 DNS rebinding 与 CSRF 风险；配置了
 *   `config.apiToken` 时还要求 `Authorization: Bearer <token>`（或
 *   `x-dsh-persona-token`），用 constant-time 比较。纯逻辑直调
 *   （未传 remoteAddress）视为本机调用，便于单元测试。
 * - 配置校验：不直接依赖 schemastery。以 `config.ts` 的 `defaultConfig()`
 *   为基线合并输入，再做类型/枚举/时间格式校验与数值范围 clamp，保证
 *   API 侧默认值与配置 schema 永不漂移。
 * - 远程/本机人格包在进入人格库前先做结构校验与消毒（字段白名单、长度/
 *   深度/数组上限、拒绝路径穿越与可执行 URL），校验失败信息只回显路径，
 *   不回显用户内容。
 * - 本文件只依赖 node: 内置模块与项目内相对 import（带 .ts 后缀）。
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { defaultConfig } from '../config.ts'
import type { WechatPersonaConfig, WhitelistEntry } from '../config.ts'
import { EMOTION_ORDER } from '../core/stickers.ts'
import type {
  AuditLogLike,
  Clock,
  ConfigPersistenceInfo,
  Emotion,
  EngineStatus,
  InboundMessage,
  Logger,
  MemoryStoreLike,
  PersonaEngineLike,
  PersonaLibraryLike,
  PersonaMarketLike,
  PersonaPackV2,
  RuntimeState,
  SendResult,
  StickerCatalogApi,
  StickerSummary,
} from '../types.ts'

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 路由前缀（不带结尾斜杠）。 */
export const API_PREFIX = '/dsh-wechat-persona/api'
/** 鉴权请求头。 */
const AUTH_HEADER = 'x-dsh-wechat-persona'
/** JSON 请求体上限（4MB；表情包 base64 最大约 2.67MB，留足余量）。 */
export const MAX_API_BODY_BYTES = 4 * 1024 * 1024
/** 上传表情包解码后的体积上限（2MB）。 */
const MAX_STICKER_BYTES = 2 * 1024 * 1024
/** 允许的图片扩展名（与 StickerCatalog 保持一致）。 */
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.gif', '.webp'])
/** 扩展名 -> Content-Type。 */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
/** 回环地址白名单。 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** 回环 Host/Origin 主机名白名单（含 localhost，避免误伤本机浏览器访问）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
/** 进程内限速：窗口内最大请求数。 */
export const API_RATE_LIMIT_MAX = 240
/** 进程内限速：时间窗口（毫秒）。 */
export const API_RATE_LIMIT_WINDOW_MS = 60_000
/** 人格导入 JSON 文本上限（2MB，与远程下载上限一致，防止解析炸弹）。 */
export const MAX_IMPORT_JSON_BYTES = 2 * 1024 * 1024
/** 读取请求体超时（毫秒）：防止 slowloris 长期占用连接。 */
export const REQUEST_BODY_TIMEOUT_MS = 10_000

/* ─────────────────────────── 人格包导入校验常量 ─────────────────────────── */

/** 允许的最大嵌套深度（超过即拒绝，防 JSON 深度炸弹）。 */
const IMPORT_MAX_DEPTH = 6
/** 单个数组最大元素数。 */
const IMPORT_MAX_ARRAY_ITEMS = 500
/** 单个对象最大键数。 */
const IMPORT_MAX_OBJECT_KEYS = 200
/** 整棵树最大节点数（防懒解析耗尽 CPU）。 */
const IMPORT_MAX_NODES = 20_000
/** 普通字符串字段最大长度。 */
const IMPORT_MAX_STRING_CHARS = 20_000
/** 超长字符串字段（头像/表情 data URL）允许的最大长度。 */
const IMPORT_MAX_LONG_STRING_CHARS = 2 * 1024 * 1024
/** 危险键：原型污染 / 代码注入载体，出现即整体拒绝。 */
const IMPORT_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
/** 允许保留的顶层字段（PersonaPackV2 + SillyTavern v2 卡常见字段，其余丢弃）。 */
const IMPORT_ALLOWED_TOP_KEYS = new Set([
  // PersonaPackV2
  'version', 'id', 'name', 'avatar', 'style', 'catchphrases', 'systemPrompt', 'examples',
  'taboo', 'stickers', 'author', 'description', 'tags', 'packVersion', 'source', 'installedAt',
  // SillyTavern / 角色卡常见字段（由人格库再做归一化）
  'spec', 'spec_version', 'data', 'char_name', 'char_id', 'char_persona', 'char_scenario',
  'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt',
  'post_history_instructions', 'alternate_greetings', 'character_book', 'extensions', 'creator',
  'character_version',
])
/** 需要做 URL 协议校验的字段（相对路径末尾；头像/表情引用）。 */
const IMPORT_URL_FIELDS = new Set(['avatar', 'url'])
/** 需要做「标识符」校验（拒绝路径穿越/分隔符/控制字符）的字段。 */
const IMPORT_IDENTIFIER_FIELDS = new Set(['id', 'name', 'char_id', 'char_name', 'packVersion', 'spec', 'spec_version'])
/** 允许的 URL 协议前缀（data 仅限图片，禁止 javascript:/file:/vbscript: 等可执行内容）。 */
const IMPORT_ALLOWED_URL_PREFIXES = ['http://', 'https://', 'data:image/']

/* ────────────────────────────── 公开类型 ────────────────────────────── */

/**
 * API 依赖：全部由 index.ts 装配注入。
 * 注意所有方法都不应抛异常（抛了也会被 handle 兜底成 500），但 API 层仍会
 * 对关键调用做 try/catch，尽量给出可读的中文错误。
 */
export interface PersonaApiDeps {
  /** 插件版本号（GET /health 用）。 */
  version: string
  /** 当前生效配置（内存副本）。 */
  getConfig(): WechatPersonaConfig
  /** 异步保存配置（POST /config、POST /personas/activate 用）。 */
  saveConfig(next: WechatPersonaConfig): Promise<{ ok: boolean; error?: string }>
  /** 配置持久化能力信息（GET /config 用）。 */
  persist(): ConfigPersistenceInfo
  /** 当前引擎；未启动/降级时为 null。 */
  getEngine(): PersonaEngineLike | null
  /** 人格库。 */
  personas: PersonaLibraryLike
  /** 人格市场。 */
  market: PersonaMarketLike
  /** 表情包目录（多来源、可重载）。 */
  stickers: StickerCatalogApi
  /** 每联系人记忆。 */
  memory: MemoryStoreLike
  /** 审计日志。 */
  audit: AuditLogLike
  /** 运行时状态快照。 */
  state(): RuntimeState
  /** 时钟（测试注入假时钟）。 */
  clock: Clock
  /** 日志。 */
  logger: Logger
  /**
   * 读取插件包内资源文件内容（相对包根），不存在返回 null。
   * 例如 asset('docs/使用说明.md')。
   */
  asset(rel: string): Promise<string | null>
  /** 数据目录绝对路径（表情包上传/删除用）。 */
  dataDir(): string
  /**
   * 当前**强制生效**的 API 共享 token；空字符串/未提供 = 兼容模式（不强制）。
   * 由 index.ts 注入：`config.apiToken` 显式配置时返回该值，否则返回 ''。
   */
  apiToken?(): string
}

/** 一次 API 调用的结果（由 attachPersonaRoutes 写成 HTTP 响应）。 */
export type ApiResponse = {
  status: number
  json?: unknown
  binary?: { data: Buffer; contentType: string }
  headers?: Record<string, string>
}

/** 纯逻辑 API 门面。 */
export interface PersonaApi {
  handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
    remoteAddress?: string,
  ): Promise<ApiResponse>
  dispose(): void
}

/** 宿主 webServer.register 的入参形状（结构化，不 import 宿主包）。 */
export interface PersonaRoute {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 宿主 webServer 的最小结构化接口。 */
export interface PersonaWebServerLike {
  register(route: PersonaRoute): () => void
}

/* ────────────────────────────── 通用小工具 ────────────────────────────── */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** child 是否位于 parent 目录之内（不含 parent 自身）。 */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 文件/目录是否存在（不抛异常）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`
}

/** 统一成功响应。 */
function okJson(json: unknown, status = 200): ApiResponse {
  return { status, json }
}

/** 统一失败响应：{ ok:false, error, detail? }。 */
function failJson(status: number, error: string, detail?: string): ApiResponse {
  return {
    status,
    json: detail === undefined ? { ok: false, error } : { ok: false, error, detail },
  }
}

/** 方法不允许（405 + Allow 头）。 */
function methodNotAllowed(allowed: readonly string[]): ApiResponse {
  return {
    status: 405,
    json: { ok: false, error: '方法不允许', detail: `允许的方法：${allowed.join(', ')}` },
    headers: { Allow: allowed.join(', ') },
  }
}

/** 把任意请求头对象按大小写不敏感方式取一个值。 */
function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lower) continue
    const value = headers[key]
    if (Array.isArray(value)) return value[0]
    return value
  }
  return undefined
}

/** 是否回环地址（undefined 视为纯逻辑直调，放行）。 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address.trim() === '') return true
  const normalized = address.trim().toLowerCase()
  if (LOOPBACK_ADDRESSES.has(normalized)) return true
  if (normalized.startsWith('127.')) return true
  return normalized === '::ffff:7f00:1'
}

/** 鉴权失败原因（status 用于 HTTP 状态码）。 */
interface AuthFailure {
  status: number
  message: string
}

/** 提取提交上来的共享 token：优先 Authorization: Bearer，其次 x-dsh-persona-token。 */
function extractProvidedToken(
  headers: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const authorization = headerValue(headers, 'authorization')
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match !== null) return match[1]!.trim()
  }
  const alt = headerValue(headers, 'x-dsh-persona-token')
  if (typeof alt === 'string' && alt.trim() !== '') return alt.trim()
  return undefined
}

/** constant-time 比较 token（先 sha256 定长，避免长度差时序泄漏）。 */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || expected === '') return false
  const a = createHash('sha256').update(provided, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** Host 头是否是回环主机名（防 DNS rebinding：恶意域名解析到 127.0.0.1 时 Host 为域名）。 */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (normalized === '') return true
  const withoutPort = normalized.replace(/:\d+$/, '')
  return LOOPBACK_HOSTS.has(withoutPort)
}

/** Origin 是否同源回环（防跨站请求伪造）。 */
function isLoopbackOrigin(origin: string): boolean {
  const normalized = origin.trim().toLowerCase()
  if (normalized === '' || normalized === 'null') return false
  try {
    const url = new URL(normalized)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.host)
  } catch {
    return false
  }
}

/**
 * 鉴权：回环地址 + `x-dsh-wechat-persona: 1` + Host/Origin/Sec-Fetch-Site 防跨站
 * +（启用时）共享 token。返回 AuthFailure，通过返回 null。
 */
function checkAuth(
  headers: Record<string, string | string[] | undefined> | undefined,
  remoteAddress: string | undefined,
  expectedToken = '',
): AuthFailure | null {
  const loopback = isLoopbackAddress(remoteAddress)
  if (!loopback) return { status: 403, message: '只允许从本机回环地址访问（127.0.0.1 / ::1）' }
  const header = headerValue(headers, AUTH_HEADER)
  const headerOk = typeof header === 'string' && header.trim() === '1'
  if (!headerOk) return { status: 403, message: `缺少或错误的 ${AUTH_HEADER} 请求头（应为 1）` }
  // DNS rebinding：Host 必须是回环主机名；浏览器访问时同源 Origin 也必须是回环。
  const host = headerValue(headers, 'host')
  if (typeof host === 'string' && !isLoopbackHost(host)) {
    return { status: 403, message: '请求 Host 不是本机回环地址，已拒绝（疑似 DNS rebinding）' }
  }
  const origin = headerValue(headers, 'origin')
  if (typeof origin === 'string' && !isLoopbackOrigin(origin)) {
    return { status: 403, message: '请求 Origin 不是本机回环来源，已拒绝（疑似跨站请求伪造）' }
  }
  const fetchSite = headerValue(headers, 'sec-fetch-site')
  if (typeof fetchSite === 'string' && fetchSite.trim().toLowerCase() === 'cross-site') {
    return { status: 403, message: '跨站请求（Sec-Fetch-Site: cross-site）已被拒绝' }
  }
  if (expectedToken !== '') {
    const provided = extractProvidedToken(headers)
    if (!tokenMatches(provided, expectedToken)) {
      return { status: 401, message: '缺少或错误的 API token（需 Authorization: Bearer <token> 或 x-dsh-persona-token）' }
    }
  }
  return null
}

/** 进程内滑动窗口限速器：按来源地址分桶，超限返回 false。 */
function createRateLimiter(max: number, windowMs: number) {
  const buckets = new Map<string, { windowStart: number; count: number }>()
  return {
    allow(key: string): boolean {
      const now = Date.now()
      const bucket = buckets.get(key)
      if (bucket === undefined || now - bucket.windowStart >= windowMs) {
        if (buckets.size > 10_000) {
          // 防御性清理：来源地址异常多时避免内存无界增长。
          for (const [bucketKey, value] of buckets) {
            if (now - value.windowStart >= windowMs) buckets.delete(bucketKey)
          }
        }
        buckets.set(key, { windowStart: now, count: 1 })
        return true
      }
      bucket.count += 1
      return bucket.count <= max
    },
  }
}

/**
 * 把 handle 收到的路径归一化成路由内部路径。
 * 兼容：`/dsh-wechat-persona/api/status`、`/status`、末尾斜杠、带 query 的字符串。
 */
function normalizeRoutePath(rawPath: string): string {
  let path = typeof rawPath === 'string' ? rawPath : '/'
  const cut = path.search(/[?#]/)
  if (cut >= 0) path = path.slice(0, cut)
  if (!path.startsWith('/')) path = `/${path}`
  if (path === API_PREFIX) path = '/'
  else if (path.startsWith(`${API_PREFIX}/`)) path = path.slice(API_PREFIX.length)
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path === '' ? '/' : path
}

/* ─────────────────────── 配置校验（不依赖 schemastery） ─────────────────────── */

interface ConfigIssue {
  path: string
  message: string
}

type ConfigValidationResult =
  | { ok: true; config: WechatPersonaConfig }
  | { ok: false; error: string; detail: string }

/** 枚举字段 -> 允许值。 */
const CONFIG_ENUMS: Record<string, readonly string[]> = {
  activeChannel: ['mock', 'phone-adb', 'windows-vm', 'desktop'],
  'reply.reasoningEffort': ['low', 'medium', 'high'],
  'channels.phoneAdb.inputMethod': ['adb-keyboard', 'tap-keys'],
  'logging.level': ['debug', 'info', 'warn', 'error', 'silent'],
}

/** 在线时段字段（HH:mm）。 */
const CONFIG_TIME_PATHS = new Set([
  'schedule.onlineStart',
  'schedule.onlineEnd',
  'schedule.workdayStart',
  'schedule.workdayEnd',
  'schedule.weekendStart',
  'schedule.weekendEnd',
])

/** 允许留空的时段字段（留空沿用 onlineStart/onlineEnd）。 */
const CONFIG_OPTIONAL_TIME_PATHS = new Set([
  'schedule.workdayStart',
  'schedule.workdayEnd',
  'schedule.weekendStart',
  'schedule.weekendEnd',
])

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
/** 人格包 id 形状（与 PersonaLibrary 的消毒规则一致）。 */
const PERSONA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** 字符串长度上限（未列出的字段统一 4096）。 */
const CONFIG_STRING_LIMITS: Record<string, number> = {
  ownerName: 64,
  apiToken: 256,
  'channels.desktop.windowTitle': 128,
  'channels.phoneAdb.packageName': 128,
  'channels.phoneAdb.adbKeyboardIme': 256,
  'channels.windowsVm.host': 128,
  'channels.mock.inboundFile': 4096,
}

/** 数值字段的 clamp 范围：[最小值, 最大值, 是否取整]。 */
const CONFIG_NUMBER_RANGES: Record<string, readonly [number, number, boolean]> = {
  'schedule.lowActivityWeekday': [0, 7, true],
  'rateLimit.perContactPerHour': [0, 1000, true],
  'rateLimit.perContactPerDay': [0, 5000, true],
  'rateLimit.minReplyIntervalSec': [0, 86400, true],
  'rateLimit.lowActivityDailyLimit': [0, 1000, true],
  'reply.maxChars': [1, 2000, true],
  'reply.temperature': [0, 2, false],
  'reply.maxTokens': [1, 32768, true],
  'reply.splitProbability': [0, 1, false],
  'reply.maxSplitParts': [1, 5, true],
  'reply.stickerProbability': [0, 1, false],
  'reply.stickerNoRepeatCount': [0, 100, true],
  'reply.typingMinMs': [0, 600000, true],
  'reply.typingMaxMs': [0, 600000, true],
  'reply.maxContextTurns': [0, 100, true],
  'stickers.maxPerReply': [0, 10, true],
  'memory.recentKeep': [1, 500, true],
  'memory.contextMessages': [0, 100, true],
  'memory.summaryEveryTurns': [1, 5000, true],
  'memory.maxSummaryChars': [0, 5000, true],
  'budget.dailyTokens': [0, 10000000, true],
  'budget.draftModeRatio': [0, 1, false],
  'budget.maxSummaryCallsPerDay': [0, 500, true],
  'search.maxPerDay': [0, 500, true],
  'search.maxResults': [1, 10, true],
  'market.timeoutMs': [500, 120000, true],
  'channels.phoneAdb.pollIntervalMs': [200, 600000, true],
  'channels.phoneAdb.commandTimeoutMs': [500, 300000, true],
  'channels.windowsVm.port': [1, 65535, true],
  'channels.windowsVm.connectTimeoutMs': [100, 600000, true],
  'channels.windowsVm.reconnectIntervalMs': [100, 600000, true],
  'channels.desktop.userActivityIdleMs': [0, 600000, true],
  'channels.desktop.pauseSeconds': [0, 3600, true],
  'logging.maxAuditMb': [1, 1024, true],
  'logging.recentLimit': [1, 200, true],
}

/** 白名单条数上限。 */
const WHITELIST_MAX_ENTRIES = 500
/** 字符串数组字段条数上限。 */
const STRING_ARRAY_MAX_ITEMS = 500
/** 坐标数组字段条数上限。 */
const POINT_ARRAY_MAX_ITEMS = 64
/** 坐标取值范围。 */
const COORDINATE_MAX = 100000

/**
 * 校验并归一化一份完整配置。
 *
 * 行为：
 * - 以 `defaultConfig()` 为基线：缺失字段补默认值，多余的未知字段丢弃；
 * - 类型不匹配/枚举非法/时间格式非法 => 返回错误（不做静默纠正）；
 * - 数值超出安全范围 => 静默 clamp（与运行时各模块的防御性 clamp 一致）。
 */
function validateConfig(input: unknown): ConfigValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: '配置校验失败：config 必须是 JSON 对象', detail: 'config 必须是 JSON 对象' }
  }
  const base = defaultConfig() as unknown as Record<string, unknown>
  const issues: ConfigIssue[] = []
  const merged = mergeConfigObject(base, input, '', issues) as unknown as WechatPersonaConfig

  // 打字延迟区间做一次兜底交换，避免 min > max 导致运行时异常。
  const reply = merged.reply
  if (reply.typingMinMs > reply.typingMaxMs) {
    const min = reply.typingMaxMs
    reply.typingMaxMs = reply.typingMinMs
    reply.typingMinMs = min
  }

  if (issues.length > 0) {
    const first = issues[0] as ConfigIssue
    return {
      ok: false,
      error: `配置校验失败：${first.message}`,
      detail: issues.map((issue) => `${issue.path}: ${issue.message}`).join('；'),
    }
  }
  return { ok: true, config: merged }
}

/** 递归合并配置对象（只遍历基线里存在的字段）。 */
function mergeConfigObject(
  base: Record<string, unknown>,
  input: Record<string, unknown>,
  prefix: string,
  issues: ConfigIssue[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(base)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    const baseValue = base[key]
    const hasInput = Object.prototype.hasOwnProperty.call(input, key)
    const inputValue = input[key]
    if (!hasInput || inputValue === undefined) {
      out[key] = baseValue
      continue
    }
    out[key] = mergeConfigValue(baseValue, inputValue, path, issues)
  }
  return out
}

/** 合并单个字段：按基线值的类型决定校验策略。 */
function mergeConfigValue(
  baseValue: unknown,
  inputValue: unknown,
  path: string,
  issues: ConfigIssue[],
): unknown {
  // 坐标类字段：null 或 {x,y}。
  if (baseValue === null) {
    return sanitizePoint(inputValue, path, issues)
  }
  if (typeof baseValue === 'boolean') {
    if (typeof inputValue !== 'boolean') {
      issues.push({ path, message: '必须是布尔值（true/false）' })
      return baseValue
    }
    return inputValue
  }
  if (typeof baseValue === 'number') {
    if (typeof inputValue !== 'number' || !Number.isFinite(inputValue)) {
      issues.push({ path, message: '必须是有限数字' })
      return baseValue
    }
    return clampConfigNumber(path, inputValue)
  }
  if (typeof baseValue === 'string') {
    if (typeof inputValue !== 'string') {
      issues.push({ path, message: '必须是字符串' })
      return baseValue
    }
    return validateConfigString(path, inputValue, issues)
  }
  if (Array.isArray(baseValue)) {
    if (path === 'whitelist') return sanitizeWhitelist(inputValue, issues)
    if (path === 'channels.phoneAdb.stickerGrid') return sanitizePointList(inputValue, path, issues)
    return sanitizeStringArray(inputValue, path, issues)
  }
  if (isPlainObject(baseValue)) {
    if (!isPlainObject(inputValue)) {
      issues.push({ path, message: '必须是 JSON 对象' })
      return baseValue
    }
    return mergeConfigObject(baseValue, inputValue, path, issues)
  }
  return inputValue
}

/** 数值 clamp（未配置范围的字段原样返回，但仍要求有限数字）。 */
function clampConfigNumber(path: string, value: number): number {
  const range = CONFIG_NUMBER_RANGES[path]
  if (!range) return value
  const [min, max, integer] = range
  let next = integer ? Math.round(value) : value
  next = Math.min(max, Math.max(min, next))
  return next
}

/** 字符串字段校验：枚举 / 时间格式 / 人格 id / 长度上限。 */
function validateConfigString(path: string, value: string, issues: ConfigIssue[]): string {
  const allowed = CONFIG_ENUMS[path]
  if (allowed) {
    if (!allowed.includes(value)) {
      issues.push({ path, message: `必须是以下之一：${allowed.join(' / ')}` })
      return allowed[0] as string
    }
    return value
  }
  if (CONFIG_TIME_PATHS.has(path)) {
    if (value === '' && CONFIG_OPTIONAL_TIME_PATHS.has(path)) return ''
    if (!TIME_PATTERN.test(value)) {
      issues.push({ path, message: '必须是 HH:mm 格式的时间（例如 08:30）' })
      return value
    }
    return value
  }
  if (path === 'persona.activeId') {
    if (value !== '' && !PERSONA_ID_PATTERN.test(value)) {
      issues.push({ path, message: '只能包含字母/数字/中划线/下划线，长度 1–64' })
      return ''
    }
    return value
  }
  const limit = CONFIG_STRING_LIMITS[path] ?? 4096
  if (value.length > limit) {
    issues.push({ path, message: `最多 ${limit} 个字符` })
    return value.slice(0, limit)
  }
  return value
}

/** 白名单数组校验（id 必填，其余字段做防御性清洗）。 */
function sanitizeWhitelist(inputValue: unknown, issues: ConfigIssue[]): WhitelistEntry[] {
  if (!Array.isArray(inputValue)) {
    issues.push({ path: 'whitelist', message: '必须是数组' })
    return []
  }
  const out: WhitelistEntry[] = []
  const seen = new Set<string>()
  for (const rawItem of inputValue) {
    if (!isPlainObject(rawItem)) {
      issues.push({ path: 'whitelist', message: '每一项必须是对象（{id,name,aliases,note}）' })
      continue
    }
    const id = typeof rawItem.id === 'string' ? rawItem.id.trim().slice(0, 128) : ''
    if (id === '') {
      issues.push({ path: 'whitelist', message: '每一项必须有非空的 id（微信备注名/昵称）' })
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    const name = typeof rawItem.name === 'string' ? rawItem.name.trim().slice(0, 64) : ''
    const note = typeof rawItem.note === 'string' ? rawItem.note.trim().slice(0, 200) : ''
    const aliases: string[] = []
    if (Array.isArray(rawItem.aliases)) {
      for (const alias of rawItem.aliases) {
        if (typeof alias !== 'string') continue
        const value = alias.trim().slice(0, 64)
        if (value !== '' && !aliases.includes(value)) aliases.push(value)
        if (aliases.length >= 32) break
      }
    }
    out.push({ id, name, aliases, note })
    if (out.length >= WHITELIST_MAX_ENTRIES) break
  }
  return out
}

/** 字符串数组字段清洗（去空、去重、限长）。 */
function sanitizeStringArray(inputValue: unknown, path: string, issues: ConfigIssue[]): string[] {
  if (!Array.isArray(inputValue)) {
    issues.push({ path, message: '必须是字符串数组' })
    return []
  }
  const out: string[] = []
  for (const item of inputValue) {
    if (typeof item !== 'string') {
      issues.push({ path, message: '数组项必须是字符串' })
      continue
    }
    const value = item.trim().slice(0, 200)
    if (value !== '' && !out.includes(value)) out.push(value)
    if (out.length >= STRING_ARRAY_MAX_ITEMS) break
  }
  return out
}

/** 坐标点校验：null 或 {x,y}（坐标 clamp 到 0–100000 的整数）。 */
function sanitizePoint(inputValue: unknown, path: string, issues: ConfigIssue[]): { x: number; y: number } | null {
  if (inputValue === null || inputValue === undefined) return null
  if (!isPlainObject(inputValue)) {
    issues.push({ path, message: '必须是 {x,y} 坐标或 null' })
    return null
  }
  const x = sanitizeCoordinate(inputValue.x, `${path}.x`, issues)
  const y = sanitizeCoordinate(inputValue.y, `${path}.y`, issues)
  if (x === null || y === null) return null
  return { x, y }
}

function sanitizeCoordinate(value: unknown, path: string, issues: ConfigIssue[]): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: '必须是有限数字' })
    return null
  }
  return Math.min(COORDINATE_MAX, Math.max(0, Math.round(value)))
}

/** 坐标数组校验（表情面板格子）。 */
function sanitizePointList(inputValue: unknown, path: string, issues: ConfigIssue[]): Array<{ x: number; y: number }> {
  if (!Array.isArray(inputValue)) {
    issues.push({ path, message: '必须是坐标数组' })
    return []
  }
  const out: Array<{ x: number; y: number }> = []
  for (const item of inputValue) {
    if (!isPlainObject(item)) {
      issues.push({ path, message: '数组项必须是 {x,y} 坐标' })
      continue
    }
    const x = sanitizeCoordinate(item.x, path, issues)
    const y = sanitizeCoordinate(item.y, path, issues)
    if (x === null || y === null) continue
    out.push({ x, y })
    if (out.length >= POINT_ARRAY_MAX_ITEMS) break
  }
  return out
}

/* ────────────────────────────── 表情包辅助 ────────────────────────────── */

/** 图片魔数识别（防止把任意二进制伪装成图片上传）。 */
const IMAGE_SIGNATURES: ReadonlyArray<{ ext: string; test: (data: Buffer) => boolean }> = [
  {
    ext: '.png',
    test: (data) =>
      data.length >= 8 &&
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47 &&
      data[4] === 0x0d &&
      data[5] === 0x0a &&
      data[6] === 0x1a &&
      data[7] === 0x0a,
  },
  {
    ext: '.gif',
    test: (data) => data.length >= 6 && data.subarray(0, 3).toString('latin1') === 'GIF',
  },
  {
    ext: '.webp',
    test: (data) =>
      data.length >= 12 &&
      data.subarray(0, 4).toString('latin1') === 'RIFF' &&
      data.subarray(8, 12).toString('latin1') === 'WEBP',
  },
]

function detectImageExtension(data: Buffer): string | null {
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.test(data)) return signature.ext
  }
  return null
}

/** 表情包预览地址（相对路径，避免反代下绝对路径失效）。 */
function stickerFileUrl(id: string): string {
  return `${API_PREFIX.replace(/^\//, '')}/sticker-file?id=${encodeURIComponent(id)}`
}

/** 文件名消毒：只保留 basename、合法扩展名、安全字符与保留名处理。 */
function sanitizeStickerFilename(rawName: string): { ok: true; name: string } | { ok: false; error: string } {
  const base = rawName.replace(/\\/g, '/').split('/').pop() ?? ''
  const trimmed = base.trim().replace(/[\u0000-\u001f<>:"|?*]/g, '').slice(0, 64)
  if (trimmed === '') return { ok: false, error: '文件名不能为空' }
  const ext = extname(trimmed).toLowerCase()
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) return { ok: false, error: '只支持 .png / .gif / .webp 图片' }
  let stem = trimmed.slice(0, trimmed.length - ext.length).replace(/[.\s]+$/g, '')
  if (stem === '') stem = 'sticker'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `s-${stem}`
  if (stem.length > 40) stem = stem.slice(0, 40)
  return { ok: true, name: `${stem}${ext}` }
}

/** 解析 base64 图片数据（兼容 data URL 前缀），并做体积校验。 */
function decodeBase64Image(raw: unknown): { ok: true; data: Buffer } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'dataBase64 必须是字符串' }
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, error: 'dataBase64 不能为空' }
  const commaIndex = trimmed.startsWith('data:') ? trimmed.indexOf(',') : -1
  const pure = (commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed).replace(/\s+/g, '')
  if (pure === '') return { ok: false, error: 'dataBase64 不能为空' }
  // base64 长度与解码后体积成正比：先按长度粗筛，避免无谓解码大字符串。
  const estimatedBytes = Math.floor((pure.length * 3) / 4)
  if (estimatedBytes > MAX_STICKER_BYTES + 3) {
    return { ok: false, error: `图片超过 ${formatMb(MAX_STICKER_BYTES)} 上限` }
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(pure)) return { ok: false, error: 'dataBase64 不是合法的 base64' }
  let data: Buffer
  try {
    data = Buffer.from(pure, 'base64')
  } catch {
    return { ok: false, error: 'dataBase64 不是合法的 base64' }
  }
  if (data.length === 0) return { ok: false, error: 'dataBase64 解码后为空' }
  if (data.length > MAX_STICKER_BYTES) return { ok: false, error: `图片超过 ${formatMb(MAX_STICKER_BYTES)} 上限` }
  return { ok: true, data }
}

/* ────────────────────────────── 人格包下载 ────────────────────────────── */

/**
 * 从 URL 下载人格包 JSON（POST /personas/install 的 {url} 分支）。
 * 只允许 http/https；超时/非 2xx/超大/非对象都抛可读错误。
 */
async function downloadPersonaPack(url: string, timeoutMs: number): Promise<PersonaPackV2> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('下载地址不是合法 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http/https 下载地址')
  }
  if (typeof fetch !== 'function') throw new Error('当前环境不支持网络下载')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  try {
    const response = await fetch(parsed, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('人格包超过 2MB 上限')
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('下载内容不是合法 JSON')
    }
    if (!isPlainObject(data)) throw new Error('人格包内容必须是 JSON 对象')
    return data as unknown as PersonaPackV2
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('下载人格包超时')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/* ─────────────────── 人格包导入：结构校验与消毒 ─────────────────── */

type ImportSanitizeResult =
  | { ok: true; value: Record<string, unknown>; dropped: string[] }
  | { ok: false; issue: string }

/** 字符串是否包含控制字符（JSON 文本里出现控制字符通常意味着注入尝试）。 */
function hasImportControlChars(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
}

/** 标识符类字段是否安全：拒绝路径穿越、路径分隔符与控制字符。 */
function isSafeImportIdentifier(value: string): boolean {
  if (value.length > 200) return false
  if (hasImportControlChars(value)) return false
  if (value.includes('..') || value.includes('/') || value.includes('\\')) return false
  return true
}

/** URL 类字段是否安全：只允许 http/https 与 data:image（拒绝 javascript:/file: 等可执行内容）。 */
function isSafeImportUrl(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return true
  const lowered = trimmed.toLowerCase()
  if (IMPORT_ALLOWED_URL_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return true
  // 无协议头的相对路径（人格包自带头像等）允许，但拒绝路径穿越。
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false
  if (trimmed.includes('..') || trimmed.includes('\\')) return false
  return true
}

/** 人格包 id 消毒：小写、非法字符折叠为 '-'、最长 64；无法得到合法 id 返回 ''。 */
function sanitizeImportId(input: string): string {
  const folded = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  return folded.slice(0, 64)
}

/** 人格 / 市场条目 id 引用是否安全（允许字母数字与 _ - . :，拒绝路径穿越与分隔符）。 */
function isSafePersonaRef(value: string): boolean {
  if (value === '' || value.length > 128) return false
  if (hasImportControlChars(value)) return false
  if (value.includes('..') || value.includes('/') || value.includes('\\')) return false
  return /^[A-Za-z0-9_.:-]+$/.test(value)
}

interface ImportWalkState {
  nodes: number
  issue: string | null
}

/** 递归校验并复制 JSON 值；发现第一个问题即停止（错误只报字段路径，不回显内容）。 */
function walkImportValue(value: unknown, path: string, depth: number, state: ImportWalkState): unknown {
  if (state.issue !== null) return null
  state.nodes += 1
  if (state.nodes > IMPORT_MAX_NODES) {
    state.issue = `人格包内容过大（节点数超过 ${IMPORT_MAX_NODES}）`
    return null
  }
  if (depth > IMPORT_MAX_DEPTH) {
    state.issue = `人格包嵌套过深（超过 ${IMPORT_MAX_DEPTH} 层）：${path}`
    return null
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if (hasImportControlChars(value)) {
      state.issue = `字段 ${path} 含控制字符`
      return null
    }
    const field = path.split('.').pop()?.replace(/\[\d+\]$/, '') ?? ''
    const limit =
      IMPORT_URL_FIELDS.has(field) || field === 'data' ? IMPORT_MAX_LONG_STRING_CHARS : IMPORT_MAX_STRING_CHARS
    if (value.length > limit) {
      state.issue = `字段 ${path} 超过长度上限（${limit} 字符）`
      return null
    }
    if (IMPORT_URL_FIELDS.has(field) && !isSafeImportUrl(value)) {
      state.issue = `字段 ${path} 不是允许的 URL（只允许 http/https/data:image）`
      return null
    }
    if (IMPORT_IDENTIFIER_FIELDS.has(field) && !isSafeImportIdentifier(value)) {
      state.issue = `字段 ${path} 含非法字符（疑似路径穿越或控制字符）`
      return null
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > IMPORT_MAX_ARRAY_ITEMS) {
      state.issue = `字段 ${path} 数组元素过多（上限 ${IMPORT_MAX_ARRAY_ITEMS}）`
      return null
    }
    return value.map((item, index) => walkImportValue(item, `${path}[${index}]`, depth + 1, state))
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length > IMPORT_MAX_OBJECT_KEYS) {
      state.issue = `字段 ${path} 键过多（上限 ${IMPORT_MAX_OBJECT_KEYS}）`
      return null
    }
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (IMPORT_DANGEROUS_KEYS.has(key)) {
        state.issue = `字段 ${path} 含非法键名（${key}）`
        return null
      }
      if (hasImportControlChars(key)) {
        state.issue = `字段 ${path} 含非法键名`
        return null
      }
      result[key] = walkImportValue(value[key], path === '' ? key : `${path}.${key}`, depth + 1, state)
      if (state.issue !== null) return null
    }
    return result
  }
  state.issue = `字段 ${path} 类型不受支持`
  return null
}

/**
 * 人格包导入前置校验（dry-run）：不落盘、不调人格库，只做结构校验与消毒。
 * - 接受 JSON 字符串（≤2MB）或已解析的 JSON 对象；
 * - 拒绝危险键（原型污染）、控制字符、路径穿越、可执行 URL、超深/超大结构；
 * - 顶层字段走白名单，未知字段丢弃（计入 dropped 供日志/文档说明）。
 */
export function sanitizeImportPayload(input: unknown): ImportSanitizeResult {
  let source: unknown = input
  if (typeof input === 'string') {
    const bytes = Buffer.byteLength(input, 'utf8')
    if (bytes > MAX_IMPORT_JSON_BYTES) {
      return { ok: false, issue: `人格包超过 ${formatMb(MAX_IMPORT_JSON_BYTES)} 上限` }
    }
    const trimmed = input.trim()
    if (trimmed === '') return { ok: false, issue: '人格包内容为空' }
    try {
      source = JSON.parse(trimmed)
    } catch {
      return { ok: false, issue: '人格包不是合法 JSON' }
    }
  }
  if (!isPlainObject(source)) return { ok: false, issue: '人格包内容必须是 JSON 对象' }

  const state: ImportWalkState = { nodes: 0, issue: null }
  walkImportValue(source, '', 0, state)
  if (state.issue !== null) return { ok: false, issue: state.issue }

  const dropped: string[] = []
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (IMPORT_ALLOWED_TOP_KEYS.has(key)) cleaned[key] = value
    else dropped.push(key)
  }
  if (Object.keys(cleaned).length === 0) {
    return { ok: false, issue: '人格包缺少可识别字段（id/name/systemPrompt 等）' }
  }
  if (typeof cleaned.id === 'string') {
    const id = sanitizeImportId(cleaned.id)
    if (id === '') delete cleaned.id
    else cleaned.id = id
  }
  if (typeof cleaned.name === 'string' && cleaned.name.trim() === '') delete cleaned.name
  return { ok: true, value: cleaned, dropped }
}

/* ────────────────────────── OCR / 读屏诊断（Phase F） ────────────────────────── */

/**
 * OCR 诊断视图（设置页只读展示）。
 * 只透出白名单字段并做长度/数值钳制：通道内部结构、截图路径、原始识别文本等
 * 一律不进入 HTTP 响应，避免把敏感内容带到设置页/日志。
 */
export interface OcrDiagnosticsView {
  available: boolean
  reason?: string
  channelId?: string
  channelState?: string
  capturedAt?: number
  captureId?: string
  engines: string[]
  lines?: number
  uncertainCount?: number
  rejectCount?: number
  conflictCount?: number
  durationMs?: number
  lastReadAt?: number
  lastError?: string
  dpi?: number
  scale?: number
  screenshotMode?: string
  engineVersion?: string
  secondOcrUsed?: boolean
  qualityStatus?: string
  dualEngine: boolean
}

function normalizeOcrNumber(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return undefined
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeOcrFloat(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return undefined
  return Math.min(max, Math.max(min, n))
}

function normalizeOcrText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 把引擎 `ocrDiagnostics()` 的原始返回值归一化为只读诊断视图（Phase F）。
 * 引擎返回信封 `{channelId, channelState, capturedAt, ocr}`；`ocr` 缺失时降级为
 * `available:false` + 原因，绝不让设置页报错。纯函数，供单元测试直接覆盖。
 */
export function normalizeOcrDiagnostics(input: unknown): OcrDiagnosticsView {
  const fallback: OcrDiagnosticsView = {
    available: false,
    engines: [],
    dualEngine: false,
    reason: '通道未提供 OCR 诊断数据（desktop 通道需由读屏管线填充 ocr 状态）',
  }
  if (!isPlainObject(input)) return fallback
  const envelope = input as Record<string, unknown>
  const channelId = normalizeOcrText(envelope.channelId, 64)
  const channelState = normalizeOcrText(envelope.channelState, 32)
  const capturedAt = normalizeOcrNumber(envelope.capturedAt, 0, Number.MAX_SAFE_INTEGER)
  if (!isPlainObject(envelope.ocr)) {
    return { ...fallback, channelId, channelState, capturedAt }
  }
  const ocr = envelope.ocr as Record<string, unknown>
  const captureId = normalizeOcrText(ocr.captureId, 128)
  const engines: string[] = []
  if (Array.isArray(ocr.engines)) {
    for (const item of ocr.engines) {
      const name = normalizeOcrText(item, 40)
      if (name !== undefined && !engines.includes(name)) engines.push(name)
      if (engines.length >= 3) break
    }
  }
  const lines = normalizeOcrNumber(ocr.lines, 0, 100_000)
  const uncertainCount = normalizeOcrNumber(ocr.uncertainCount, 0, 100_000)
  const rejectCount = normalizeOcrNumber(ocr.rejectCount, 0, 100_000)
  const conflictCount = normalizeOcrNumber(ocr.conflictCount, 0, 100_000)
  const durationMs = normalizeOcrNumber(ocr.durationMs, 0, 600_000)
  const lastReadAt = normalizeOcrNumber(ocr.lastReadAt, 0, Number.MAX_SAFE_INTEGER)
  const lastError = normalizeOcrText(ocr.lastError, 300)
  // task-12 / 13.4：pipeline-fixer 在通道 status().ocr 新增的只读诊断字段（缺失时安全忽略）。
  const dpi = normalizeOcrNumber(ocr.dpi, 0, 10_000)
  const scale = normalizeOcrFloat(ocr.scale, 0, 16)
  const screenshotMode = normalizeOcrText(ocr.screenshotMode, 32)
  const engineVersion = normalizeOcrText(ocr.engineVersion, 64)
  const secondOcrUsed = ocr.secondOcrUsed === true
  const qualityStatus = normalizeOcrText(ocr.qualityStatus, 32)
  const dualEngine = ocr.dualEngine === true || engines.length >= 2
  const available =
    captureId !== undefined ||
    lines !== undefined ||
    engines.length > 0 ||
    lastReadAt !== undefined ||
    dpi !== undefined ||
    engineVersion !== undefined ||
    qualityStatus !== undefined ||
    screenshotMode !== undefined
  if (!available) {
    return { ...fallback, channelId, channelState, capturedAt, reason: '通道 OCR 诊断数据格式不可识别' }
  }
  return {
    available: true,
    channelId,
    channelState,
    capturedAt,
    captureId,
    engines,
    lines,
    uncertainCount,
    rejectCount,
    conflictCount,
    durationMs,
    lastReadAt,
    lastError,
    dpi,
    scale,
    screenshotMode,
    engineVersion,
    secondOcrUsed,
    qualityStatus,
    dualEngine,
  }
}

/* ────────────────────────────── API 门面 ────────────────────────────── */

/**
 * 创建纯逻辑 API 门面。
 * 注意：本函数只做装配，不注册路由、不读真实网络；所有副作用都经 deps。
 */
export function createPersonaApi(deps: PersonaApiDeps): PersonaApi {
  let disposed = false
  let warnedMissingToken = false
  const rateLimiter = createRateLimiter(API_RATE_LIMIT_MAX, API_RATE_LIMIT_WINDOW_MS)

  /** 当前强制生效的共享 token（空字符串 = 兼容模式，不强制）。 */
  const currentApiToken = (): string => {
    try {
      const token = typeof deps.apiToken === 'function' ? deps.apiToken() : ''
      return typeof token === 'string' ? token.trim() : ''
    } catch (error) {
      deps.logger.warn('读取 API token 失败，按未配置处理', errorMessage(error))
      return ''
    }
  }

  /** 读取一个资源文件内容；缺失/异常都返回 null。 */
  const readAsset = async (rel: string): Promise<string | null> => {
    try {
      const text = await deps.asset(rel)
      return typeof text === 'string' ? text : null
    } catch (error) {
      deps.logger.warn(`读取资源失败：${rel}`, errorMessage(error))
      return null
    }
  }

  /** 已安装人格 id 集合（用于判断 install 是新增还是更新；失败时退化为空集）。 */
  const installedIds = async (): Promise<Set<string>> => {
    try {
      const list = await deps.personas.list(deps.getConfig().persona.activeId)
      return new Set(list.map((item) => item.id))
    } catch {
      return new Set()
    }
  }

  /** 安全读取表情包列表（读取失败按空列表处理）。 */
  const listStickers = (): StickerSummary[] => {
    try {
      const items = deps.stickers.list()
      return Array.isArray(items) ? items : []
    } catch (error) {
      deps.logger.warn('读取表情包列表失败', errorMessage(error))
      return []
    }
  }

  /** 取当前引擎；未启动返回 null。 */
  const currentEngine = (): PersonaEngineLike | null => deps.getEngine()

  /** POST 请求的 body 必须是 JSON 对象。 */
  const requireObject = (body: unknown): Record<string, unknown> | null =>
    isPlainObject(body) ? body : null

  /** 可省略的 body：undefined/null 视为空对象，非对象返回 null（调用方回 400）。 */
  const optionalObject = (body: unknown): Record<string, unknown> | null => {
    if (body === undefined || body === null) return {}
    return isPlainObject(body) ? body : null
  }

  /**
   * 主处理函数：鉴权 -> 路由 -> 参数校验 -> 调用 deps。
   * 永不抛异常（最外层 try/catch 统一 500）。
   */
  const handle = async (
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
    remoteAddress?: string,
  ): Promise<ApiResponse> => {
    try {
      if (disposed) return failJson(503, '接口已卸载（插件可能已停用或重载）')
      const apiToken = currentApiToken()
      const authError = checkAuth(headers, remoteAddress, apiToken)
      if (authError !== null) return failJson(authError.status, authError.message)
      if (apiToken === '' && !warnedMissingToken) {
        warnedMissingToken = true
        deps.logger.warn(
          'API 未配置共享 token（兼容模式）：仅校验回环地址与 x-dsh-wechat-persona 请求头；如需强制鉴权，请设置 config.apiToken（插件启动时会在数据目录生成 api-token 文件供参考）',
        )
      }
      if (!rateLimiter.allow(remoteAddress ?? 'direct')) {
        return failJson(429, '请求过于频繁，请稍后再试（进程内限速）')
      }

      const routePath = normalizeRoutePath(path)
      const verb = typeof method === 'string' && method.trim() !== '' ? method.trim().toUpperCase() : 'GET'

      /* ── 健康检查 ── */
      if (routePath === '/health') {
        if (verb !== 'GET') return methodNotAllowed(['GET'])
        return okJson({
          ok: true,
          version: deps.version,
          pid: process.pid,
          uptime: process.uptime(),
        })
      }

      /* ── 运行状态 ── */
      if (routePath === '/status') {
        if (verb !== 'GET') return methodNotAllowed(['GET'])
        const config = deps.getConfig()
        const engine = currentEngine()
        let status: EngineStatus | null = null
        if (engine) {
          try {
            status = await engine.status()
          } catch (error) {
            deps.logger.warn('读取引擎状态失败', errorMessage(error))
          }
        }
        const channel = status
          ? {
              id: status.channelId,
              state: status.channelState,
              detail: status.channelDetail ?? '',
            }
          : {
              id: config.activeChannel,
              state: config.enabled ? 'starting' : 'stopped',
              detail: config.enabled ? '引擎尚未启动' : '插件已禁用',
            }
        const configSummary = {
          personaName: status?.personaName ?? config.reply.personaName,
          activeChannel: config.activeChannel,
          whitelistCount: config.whitelist.length,
          online: status?.online === true,
        }
        return okJson({
          ok: true,
          status,
          channel,
          configSummary,
          safeMode: config.safeMode === true,
          // task-12 / 13.4：发送模式与草稿队列状态（引擎未提供时按配置/0 兜底）。
          sendMode: status?.sendMode ?? config.sendMode,
          pendingDrafts: status?.pendingDrafts ?? 0,
          sendState: status?.sendState ?? null,
          security: { apiTokenEnabled: apiToken !== '', rateLimitPerMinute: API_RATE_LIMIT_MAX },
        })
      }

      /* ── OCR / 读屏诊断（只读，Phase F） ── */
      // 数据来自引擎对通道 status() 的 duck-typing 读取；通道没提供时降级为 available:false。
      // 只读、不触发截图，并只透出白名单字段（见 normalizeOcrDiagnostics）。
      if (routePath === '/diagnostics/ocr') {
        if (verb !== 'GET') return methodNotAllowed(['GET'])
        const engine = currentEngine()
        let raw: unknown = null
        if (engine && typeof (engine as PersonaEngineLike & { ocrDiagnostics?: unknown }).ocrDiagnostics === 'function') {
          try {
            raw = await (engine as PersonaEngineLike & { ocrDiagnostics(): unknown }).ocrDiagnostics()
          } catch (error) {
            deps.logger.warn('读取 OCR 诊断失败', errorMessage(error))
            raw = null
          }
        }
        return okJson({ ok: true, diagnostics: normalizeOcrDiagnostics(raw) })
      }

      /* ── 配置读写 ── */
      if (routePath === '/config') {
        if (verb === 'GET') {
          let persist: ConfigPersistenceInfo
          try {
            persist = deps.persist()
          } catch (error) {
            persist = { editable: false, reason: `读取持久化信息失败：${errorMessage(error)}` }
          }
          // 不向 HTTP 层回显共享 token 明文：一律替换为空字符串。
          const config = { ...deps.getConfig(), apiToken: '' }
          return okJson({ ok: true, config, persist, apiTokenConfigured: apiToken !== '' })
        }
        if (verb === 'POST') {
          const obj = requireObject(body)
          if (!obj) return failJson(400, '请求体必须是 JSON 对象')
          if (obj.config === undefined) return failJson(400, '缺少 config 字段（完整配置对象）')
          const validation = validateConfig(obj.config)
          if (!validation.ok) return failJson(400, validation.error, validation.detail)
          // 请求体里 token 为空 = 保持现有值（避免设置页读不到明文后把 token 清空）。
          if (validation.config.apiToken.trim() === '') {
            validation.config.apiToken = deps.getConfig().apiToken
          }
          let saved: { ok: boolean; error?: string }
          try {
            saved = await deps.saveConfig(validation.config)
          } catch (error) {
            return failJson(500, `保存配置失败：${errorMessage(error)}`)
          }
          if (!saved || saved.ok !== true) {
            return failJson(500, saved?.error ? `保存配置失败：${saved.error}` : '保存配置失败')
          }
          return okJson({ ok: true, accepted: true }, 202)
        }
        return methodNotAllowed(['GET', 'POST'])
      }

      /* ── 人格库 ── */
      if (routePath === '/personas') {
        if (verb !== 'GET') return methodNotAllowed(['GET'])
        try {
          const activeId = deps.getConfig().persona.activeId
          const personas = await deps.personas.list(activeId)
          return okJson({ ok: true, activeId, personas })
        } catch (error) {
          return failJson(500, '读取人格列表失败', errorMessage(error))
        }
      }

      if (routePath === '/personas/install') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const obj = requireObject(body)
        if (!obj) return failJson(400, '请求体必须是 JSON 对象')
        const url = typeof obj.url === 'string' ? obj.url.trim() : ''
        const pack = obj.pack
        // {url} 分支：下载远程人格包（测试不会走真实网络）。
        if (url !== '' && (pack === undefined || pack === null)) {
          try {
            const downloaded = await downloadPersonaPack(url, deps.getConfig().market.timeoutMs)
            const sanitized = sanitizeImportPayload(downloaded)
            if (!sanitized.ok) {
              return failJson(400, `远程人格包校验失败：${sanitized.issue}`, sanitized.issue)
            }
            if (sanitized.dropped.length > 0) {
              deps.logger.debug(`远程人格包丢弃未知字段：${sanitized.dropped.join(', ')}`)
            }
            const before = await installedIds()
            const persona = await deps.personas.install(sanitized.value as unknown as PersonaPackV2, 'market')
            return okJson({ ok: true, persona, updated: before.has(persona.id) })
          } catch (error) {
            return failJson(400, `从 URL 安装人格失败：${errorMessage(error)}`)
          }
        }
        if (!isPlainObject(pack)) {
          return failJson(400, '请求体需要提供 pack（人格包对象）或 url（下载地址）')
        }
        const sanitizedPack = sanitizeImportPayload(pack)
        if (!sanitizedPack.ok) {
          return failJson(400, `人格包校验失败：${sanitizedPack.issue}`, sanitizedPack.issue)
        }
        if (sanitizedPack.dropped.length > 0) {
          deps.logger.debug(`本机人格包丢弃未知字段：${sanitizedPack.dropped.join(', ')}`)
        }
        try {
          const before = await installedIds()
          const persona = await deps.personas.install(sanitizedPack.value as unknown as PersonaPackV2, 'local')
          return okJson({ ok: true, persona, updated: before.has(persona.id) })
        } catch (error) {
          return failJson(400, `安装人格失败：${errorMessage(error)}`)
        }
      }

      if (routePath === '/personas/import') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const obj = requireObject(body)
        if (!obj) return failJson(400, '请求体必须是 JSON 对象')
        if (obj.json === undefined) {
          return failJson(400, '缺少 json 字段（人格包或 SillyTavern 角色卡 JSON）')
        }
        // dry-run：先做结构校验/消毒（不落盘），通过后再交给人格库。
        const sanitized = sanitizeImportPayload(obj.json)
        if (!sanitized.ok) {
          return failJson(400, `人格包校验失败：${sanitized.issue}`, sanitized.issue)
        }
        if (sanitized.dropped.length > 0) {
          deps.logger.debug(`导入人格包丢弃未知字段：${sanitized.dropped.join(', ')}`)
        }
        try {
          const before = await installedIds()
          const persona = await deps.personas.importJson(sanitized.value)
          return okJson({ ok: true, persona, updated: before.has(persona.id) })
        } catch (error) {
          return failJson(400, `导入人格失败：${errorMessage(error)}`)
        }
      }

      if (routePath === '/personas/activate') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const obj = requireObject(body)
        if (!obj) return failJson(400, '请求体必须是 JSON 对象')
        if (typeof obj.id !== 'string') {
          return failJson(400, '缺少 id 字段（字符串；空串表示关闭人格回复）')
        }
        const id = obj.id.trim()
        if (id.length > 64) return failJson(400, '人格 id 过长')
        if (id !== '' && !isSafePersonaRef(id)) return failJson(400, '人格 id 含非法字符（疑似路径穿越）')
        try {
          if (id !== '') {
            const pack = await deps.personas.get(id)
            if (!pack) return failJson(404, `人格不存在：${id}`)
          }
          const next = structuredClone(deps.getConfig())
          next.persona.activeId = id
          const saved = await deps.saveConfig(next)
          if (!saved || saved.ok !== true) {
            return failJson(500, saved?.error ? `保存配置失败：${saved.error}` : '保存配置失败')
          }
          return okJson({ ok: true, accepted: true, activeId: id }, 202)
        } catch (error) {
          return failJson(400, `启用人格失败：${errorMessage(error)}`)
        }
      }

      if (routePath === '/personas/export') {
        if (verb !== 'GET') return methodNotAllowed(['GET'])
        const id = (query.get('id') ?? '').trim()
        if (id === '') return failJson(400, '缺少 id 参数')
        if (!isSafePersonaRef(id)) return failJson(400, '人格 id 含非法字符（疑似路径穿越）')
        try {
          const pack = await deps.personas.exportPack(id)
          if (!pack) return failJson(404, `人格不存在：${id}`)
          return okJson({ ok: true, pack })
        } catch (error) {
          return failJson(400, `导出人格失败：${errorMessage(error)}`)
        }
      }

      /* ── 人格市场 ── */
      if (routePath === '/market') {
        if (verb !== 'GET') return methodNotAllowed(['GET'])
        let source: 'remote' | 'builtin' = 'builtin'
        let entries: unknown[] = []
        let warning: string | undefined
        try {
          const result = await deps.market.fetchIndex()
          source = result.source === 'remote' ? 'remote' : 'builtin'
          entries = Array.isArray(result.entries) ? [...result.entries] : []
          if (typeof result.warning === 'string' && result.warning !== '') warning = result.warning
        } catch (error) {
          warning = `人格市场不可用：${errorMessage(error)}`
        }
        // 防御性补 installed 标记：以人格库实际安装列表为准。
        const installed = await installedIds()
        const enriched = entries.map((entry) => {
          if (!isPlainObject(entry)) return entry
          const id = typeof entry.id === 'string' ? entry.id : ''
          return { ...entry, installed: entry.installed === true || (id !== '' && installed.has(id)) }
        })
        const payload: Record<string, unknown> = { ok: true, source, entries: enriched }
        if (warning !== undefined) payload.warning = warning
        return okJson(payload)
      }

      if (routePath === '/market/install') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const obj = requireObject(body)
        if (!obj) return failJson(400, '请求体必须是 JSON 对象')
        if (typeof obj.id !== 'string' || obj.id.trim() === '') {
          return failJson(400, '缺少 id 字段（人格市场条目 id）')
        }
        const marketId = obj.id.trim()
        if (!isSafePersonaRef(marketId)) return failJson(400, '人格市场 id 含非法字符（疑似路径穿越）')
        try {
          const result = await deps.market.install(marketId)
          return okJson({ ok: true, persona: result.persona, updated: result.updated === true })
        } catch (error) {
          return failJson(400, `安装人格失败：${errorMessage(error)}`)
        }
      }

      /* ── 表情包 ── */
      if (routePath === '/stickers') {
        if (verb === 'GET') {
          const items = listStickers().map((item) => ({
            ...item,
            url: typeof item.url === 'string' && item.url !== '' ? item.url : stickerFileUrl(item.id),
          }))
          return okJson({ ok: true, items })
        }
        if (verb === 'DELETE') {
          const obj = requireObject(body)
          if (!obj) return failJson(400, '请求体必须是 JSON 对象')
          if (typeof obj.id !== 'string' || obj.id.trim() === '') {
            return failJson(400, '缺少 id 字段（表情包 id）')
          }
          const id = obj.id.trim()
          const item = listStickers().find((entry) => entry.id === id)
          if (!item) return failJson(404, `表情包不存在：${id}`)
          if (item.origin !== 'uploaded') {
            return failJson(400, '只允许删除自己上传的表情包（包内/人格包自带的表情为只读）')
          }
          const file = deps.stickers.fileOf(id)
          if (!file) return failJson(404, `表情包文件不存在：${id}`)
          const uploadRoot = resolve(deps.dataDir(), 'stickers')
          const absolute = resolve(file)
          if (!isInside(absolute, uploadRoot)) {
            return failJson(403, '只允许删除数据目录 stickers/ 内的上传文件')
          }
          try {
            await rm(absolute, { force: false })
          } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code
            if (code === 'ENOENT') return failJson(404, `表情包文件不存在：${id}`)
            return failJson(500, `删除表情包失败：${errorMessage(error)}`)
          }
          try {
            await deps.stickers.reload()
          } catch (error) {
            deps.logger.warn('删除表情包后重载目录失败', errorMessage(error))
          }
          return okJson({ ok: true })
        }
        return methodNotAllowed(['GET', 'DELETE'])
      }

      if (routePath === '/stickers/upload') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const obj = requireObject(body)
        if (!obj) return failJson(400, '请求体必须是 JSON 对象')
        const emotionRaw = typeof obj.emotion === 'string' ? obj.emotion.trim() : ''
        if (emotionRaw === '') return failJson(400, '缺少 emotion 字段（表情分类）')
        const category: Emotion | undefined = EMOTION_ORDER.find((item) => item === emotionRaw)
        if (!category) {
          return failJson(400, `emotion 只能是：${EMOTION_ORDER.join(' / ')}`)
        }
        if (typeof obj.filename !== 'string' || obj.filename.trim() === '') {
          return failJson(400, '缺少 filename 字段（图片文件名）')
        }
        const sanitized = sanitizeStickerFilename(obj.filename)
        if (!sanitized.ok) return failJson(400, sanitized.error)
        const decoded = decodeBase64Image(obj.dataBase64)
        if (!decoded.ok) return failJson(400, decoded.error)
        const detected = detectImageExtension(decoded.data)
        if (detected === null) return failJson(400, '不是有效的 PNG / GIF / WebP 图片')
        const declaredExt = extname(sanitized.name).toLowerCase()
        if (declaredExt !== detected) {
          return failJson(400, '文件内容与扩展名不一致')
        }

        const uploadRoot = resolve(deps.dataDir(), 'stickers')
        const targetDir = resolve(uploadRoot, category)
        try {
          await mkdir(targetDir, { recursive: true })
        } catch (error) {
          return failJson(500, `创建表情包目录失败：${errorMessage(error)}`)
        }
        const stem = sanitized.name.slice(0, sanitized.name.length - declaredExt.length)
        let finalName = sanitized.name
        let finalPath = resolve(targetDir, finalName)
        if (await pathExists(finalPath)) {
          finalName = `${stem}-${randomUUID().replace(/-/g, '').slice(0, 8)}${declaredExt}`
          finalPath = resolve(targetDir, finalName)
        }
        if (!isInside(finalPath, targetDir)) return failJson(400, '文件名不合法')
        const tempPath = `${finalPath}.${randomUUID()}.tmp`
        try {
          await writeFile(tempPath, decoded.data)
          await rename(tempPath, finalPath)
        } catch (error) {
          try {
            await rm(tempPath, { force: true })
          } catch {
            // 临时文件清理失败不影响错误返回
          }
          return failJson(500, `保存表情包失败：${errorMessage(error)}`)
        }
        try {
          await deps.stickers.reload()
        } catch (error) {
          deps.logger.warn('上传表情包后重载目录失败', errorMessage(error))
        }
        const id = `uploaded:${category}/${finalName}`
        const found = listStickers().find((entry) => entry.id === id)
        const item: StickerSummary = found ?? {
          id,
          category,
          name: `${category}/${finalName}`,
          origin: 'uploaded',
          url: '',
        }
        return okJson({
          ok: true,
          item: { ...item, url: item.url !== '' ? item.url : stickerFileUrl(id) },
        })
      }

      if (routePath === '/sticker-file') {
        if (verb !== 'GET') return methodNotAllowed(['GET'])
        const id = (query.get('id') ?? '').trim()
        if (id === '') return failJson(400, '缺少 id 参数')
        const file = deps.stickers.fileOf(id)
        if (!file) return failJson(404, `表情包不存在：${id}`)
        const absolute = resolve(file)
        const ext = extname(absolute).toLowerCase()
        if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
          return failJson(403, '不支持的表情包文件类型')
        }
        const uploadRoot = resolve(deps.dataDir(), 'stickers')
        // 只允许：数据目录 stickers/ 内的上传文件，或任意来源的 <...>/stickers/<分类>/<文件名>。
        const allowed =
          isInside(absolute, uploadRoot) || /[\\/]stickers[\\/][^\\/]+[\\/][^\\/]+$/.test(absolute)
        if (!allowed) return failJson(403, '不允许访问该路径下的文件')
        let data: Buffer
        try {
          data = await readFile(absolute)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code
          if (code === 'ENOENT') return failJson(404, `表情包文件不存在：${id}`)
          return failJson(500, `读取表情包失败：${errorMessage(error)}`)
        }
        return {
          status: 200,
          binary: { data, contentType: IMAGE_CONTENT_TYPES[ext] ?? 'application/octet-stream' },
          headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        }
      }

      /* ── 日志 ── */
      if (routePath === '/logs') {
        if (verb !== 'GET') return methodNotAllowed(['GET'])
        const rawLimit = query.get('limit')
        let limit = 0
        if (rawLimit !== null && rawLimit.trim() !== '') {
          const parsed = Number.parseInt(rawLimit, 10)
          if (Number.isFinite(parsed) && parsed > 0) limit = parsed
        }
        if (limit <= 0) {
          const configured = deps.getConfig().logging.recentLimit
          limit = Number.isFinite(configured) && configured > 0 ? configured : 50
        }
        limit = Math.min(200, Math.max(1, Math.round(limit)))
        try {
          const events = await deps.audit.recent(limit)
          const summary = await deps.audit.summary()
          return okJson({ ok: true, events, summary })
        } catch (error) {
          return failJson(500, '读取日志失败', errorMessage(error))
        }
      }

      /* ── 测试与运行时操作 ── */
      if (routePath === '/test/inbound') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const obj = requireObject(body)
        if (!obj) return failJson(400, '请求体必须是 JSON 对象')
        const text = typeof obj.text === 'string' ? obj.text.trim() : ''
        if (text === '') return failJson(400, 'text 不能为空')
        if (text.length > 4000) return failJson(400, 'text 过长（最多 4000 字）')
        if (obj.contactId !== undefined && typeof obj.contactId !== 'string') {
          return failJson(400, 'contactId 必须是字符串')
        }
        const engine = currentEngine()
        if (!engine) return failJson(409, '引擎未启动，无法模拟入站消息')
        const config = deps.getConfig()
        const contactId =
          typeof obj.contactId === 'string' && obj.contactId.trim() !== ''
            ? obj.contactId.trim().slice(0, 128)
            : config.whitelist[0]?.id || 'test-contact'
        const now = deps.clock.now()
        const message: InboundMessage = {
          id: `test-${now}`,
          contactId,
          contactName: '测试',
          chatType: 'single',
          kind: 'text',
          text,
          receivedAt: now,
        }
        try {
          await engine.handleInbound(message)
          return okJson({ ok: true, accepted: true }, 202)
        } catch (error) {
          return failJson(500, `测试消息处理失败：${errorMessage(error)}`)
        }
      }

      if (routePath === '/test/send') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const obj = requireObject(body)
        if (!obj) return failJson(400, '请求体必须是 JSON 对象')
        const contactId = typeof obj.contactId === 'string' ? obj.contactId.trim() : ''
        const text = typeof obj.text === 'string' ? obj.text.trim() : ''
        if (contactId === '') return failJson(400, 'contactId 不能为空')
        if (text === '') return failJson(400, 'text 不能为空')
        const engine = currentEngine()
        if (!engine) return failJson(409, '引擎未启动，无法发送测试消息')
        // P1-5：暂停期间手动发送与自动发送一样被门禁拒绝（引擎 sendTest 内部还有一层
        // canSend 兜底：安全模式/熔断/预算/白名单/频控；这里提前返回明确的 409，方便工具/设置页提示）。
        let engineStatus: EngineStatus | null = null
        try {
          engineStatus = await engine.status()
        } catch {
          engineStatus = null
        }
        if (engineStatus?.paused === true) return failJson(409, '引擎已暂停，已拒绝发送', 'paused')
        // Phase F：人格模拟器只允许 mock 通道（请求体 mockOnly:true），绝不触达真实微信。
        if (obj.mockOnly === true) {
          const channelId = engineStatus?.channelId ?? deps.getConfig().activeChannel
          if (channelId !== 'mock') {
            return failJson(409, `人格模拟器仅允许在 mock 通道使用（当前通道：${channelId}）`, 'mock-only')
          }
        }
        let result: SendResult
        try {
          result = await engine.sendTest(contactId.slice(0, 128), text.slice(0, 4000))
        } catch (error) {
          return failJson(500, `发送测试消息失败：${errorMessage(error)}`)
        }
        return okJson({ ok: true, result })
      }

      /* ── 待发送草稿 / 人工确认（task-12 / 13.4） ── */
      // 批准会重新走引擎 canSend 全部门禁（暂停/熔断/预算/白名单/频控/安全模式）并复用同一
      // sendOperationId：unknown 的发送结果永远不会在这里被自动重发。
      if (routePath === '/drafts') {
        if (verb !== 'GET') return methodNotAllowed(['GET'])
        const engine = currentEngine()
        if (!engine) return failJson(409, '引擎未启动，无法读取草稿队列')
        const listDrafts = (engine as PersonaEngineLike & { listDrafts?: () => Promise<unknown> }).listDrafts
        if (typeof listDrafts !== 'function') return failJson(409, '当前引擎不支持草稿队列')
        try {
          const drafts = await listDrafts.call(engine)
          return okJson({ ok: true, drafts })
        } catch (error) {
          return failJson(500, `读取草稿队列失败：${errorMessage(error)}`)
        }
      }

      if (routePath === '/drafts/approve' || routePath === '/drafts/reject') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const obj = requireObject(body)
        if (!obj) return failJson(400, '请求体必须是 JSON 对象')
        const id = typeof obj.id === 'string' ? obj.id.trim() : ''
        if (id === '') return failJson(400, 'id 不能为空')
        if (id.length > 128) return failJson(400, 'id 过长')
        const engine = currentEngine()
        if (!engine) return failJson(409, '引擎未启动，无法处理草稿')
        const isApprove = routePath === '/drafts/approve'
        const handler = (
          engine as PersonaEngineLike & {
            approveDraft?: (draftId: string) => Promise<unknown>
            rejectDraft?: (draftId: string) => Promise<unknown>
          }
        )[isApprove ? 'approveDraft' : 'rejectDraft']
        if (typeof handler !== 'function') return failJson(409, '当前引擎不支持草稿人工确认')
        let decision: { ok?: unknown; error?: unknown; detail?: unknown }
        try {
          decision = (await handler.call(engine, id)) as { ok?: unknown; error?: unknown; detail?: unknown }
        } catch (error) {
          return failJson(500, `${isApprove ? '批准' : '拒绝'}草稿失败：${errorMessage(error)}`)
        }
        if (decision?.ok === true) return okJson({ ok: true, result: decision })
        const message = typeof decision?.error === 'string' ? decision.error : '处理草稿失败'
        const detail = typeof decision?.detail === 'string' ? decision.detail : undefined
        // 草稿不存在/已清理 → 404；已处理过、门禁拒绝、unknown 终结 → 409（调用方需人工处理）。
        const status = message.includes('不存在') ? 404 : 409
        return failJson(status, message, detail)
      }

      if (routePath === '/pause') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const obj = optionalObject(body)
        if (obj === null) return failJson(400, '请求体必须是 JSON 对象')
        if (obj.reason !== undefined && typeof obj.reason !== 'string') {
          return failJson(400, 'reason 必须是字符串')
        }
        const reason =
          typeof obj.reason === 'string' && obj.reason.trim() !== ''
            ? obj.reason.trim().slice(0, 200)
            : 'manual'
        const engine = currentEngine()
        if (!engine) return failJson(409, '引擎未启动，无法暂停')
        try {
          await engine.pause(reason)
        } catch (error) {
          return failJson(500, `暂停失败：${errorMessage(error)}`)
        }
        return okJson({ ok: true, paused: true, reason })
      }

      if (routePath === '/resume') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const engine = currentEngine()
        if (!engine) return failJson(409, '引擎未启动，无法恢复')
        try {
          await engine.resume()
        } catch (error) {
          return failJson(500, `恢复失败：${errorMessage(error)}`)
        }
        return okJson({ ok: true, paused: false })
      }

      if (routePath === '/memory/clear') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const obj = optionalObject(body)
        if (obj === null) return failJson(400, '请求体必须是 JSON 对象')
        if (obj.contactId !== undefined && typeof obj.contactId !== 'string') {
          return failJson(400, 'contactId 必须是字符串')
        }
        const contactId =
          typeof obj.contactId === 'string' && obj.contactId.trim() !== ''
            ? obj.contactId.trim().slice(0, 128)
            : undefined
        const engine = currentEngine()
        if (!engine) return failJson(409, '引擎未启动，无法清理记忆')
        try {
          await engine.clearMemory(contactId)
        } catch (error) {
          return failJson(500, `清理记忆失败：${errorMessage(error)}`)
        }
        return okJson({ ok: true })
      }

      if (routePath === '/audit/clear') {
        if (verb !== 'POST') return methodNotAllowed(['POST'])
        const engine = currentEngine()
        if (!engine) return failJson(409, '引擎未启动，无法清空审计日志')
        try {
          await engine.clearAudit()
        } catch (error) {
          return failJson(500, `清空审计日志失败：${errorMessage(error)}`)
        }
        return okJson({ ok: true })
      }

      /* ── 帮助（使用说明 + 版本记录） ── */
      if (routePath === '/help') {
        if (verb !== 'GET') return methodNotAllowed(['GET'])
        const [usage, changelog] = await Promise.all([
          readAsset('docs/使用说明.md'),
          readAsset('CHANGELOG.md'),
        ])
        const missing: string[] = []
        if (usage === null) missing.push('docs/使用说明.md')
        if (changelog === null) missing.push('CHANGELOG.md')
        const payload: Record<string, unknown> = {
          ok: true,
          usage: usage ?? '',
          changelog: changelog ?? '',
        }
        if (missing.length > 0) {
          payload.warning = `缺少文档资源：${missing.join('、')}（请查阅插件包 docs/ 目录）`
        }
        return okJson(payload)
      }

      /* ── 删除人格（路径参数） ── */
      const personaIdMatch = /^\/personas\/([^/]+)$/.exec(routePath)
      if (personaIdMatch) {
        if (verb !== 'DELETE') return methodNotAllowed(['DELETE'])
        let id: string
        try {
          id = decodeURIComponent(personaIdMatch[1] ?? '')
        } catch {
          return failJson(400, '人格 id 不合法')
        }
        if (id === '') return failJson(400, '缺少人格 id')
        if (!isSafePersonaRef(id)) return failJson(400, '人格 id 含非法字符（疑似路径穿越）')
        try {
          const removed = await deps.personas.uninstall(id)
          if (!removed) {
            const existing = await deps.personas.get(id).catch(() => null)
            if (existing) return failJson(400, `内置人格为只读，无法删除：${id}`)
            return failJson(404, `人格不存在：${id}`)
          }
          return okJson({ ok: true })
        } catch (error) {
          return failJson(400, `删除人格失败：${errorMessage(error)}`)
        }
      }

      return failJson(404, `接口不存在：${verb} ${routePath}`)
    } catch (error) {
      deps.logger.error('处理 API 请求时发生未捕获异常', errorMessage(error))
      return failJson(500, '服务器内部错误', errorMessage(error))
    }
  }

  return {
    handle,
    dispose(): void {
      disposed = true
    },
  }
}

/* ────────────────────────────── HTTP 传输层 ────────────────────────────── */

/** attach 读请求体的结果。 */
type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; status: number; error: string }

/** 读取请求体（GET/HEAD 视为空；超过上限返回 413；超时返回 408）。 */
function readRequestBody(req: IncomingMessage): Promise<BodyReadResult> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return Promise.resolve({ ok: true, text: '' })
  return new Promise<BodyReadResult>((resolvePromise) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (result: BodyReadResult): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
      resolvePromise(result)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buffer.length
      if (size > MAX_API_BODY_BYTES) {
        finish({ ok: false, status: 413, error: `请求体超过 ${formatMb(MAX_API_BODY_BYTES)} 上限` })
        // 继续排空剩余数据，保证能正常写回 413 响应。
        req.resume()
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    const onError = (): void => finish({ ok: false, status: 400, error: '读取请求体失败' })
    const onAborted = (): void => finish({ ok: false, status: 400, error: '请求被中断' })
    timer = setTimeout(() => {
      finish({ ok: false, status: 408, error: '读取请求体超时' })
      req.resume()
    }, REQUEST_BODY_TIMEOUT_MS)
    // 超时定时器不应阻止进程退出。
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

/** 写 JSON 响应（attach 内部错误兜底用）。 */
function sendJson(res: ServerResponse, status: number, json: unknown): void {
  if (res.writableEnded || res.destroyed) return
  const payload = JSON.stringify(json)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload, 'utf8')),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(payload)
  } catch {
    try {
      res.destroy()
    } catch {
      // 连接已断开时忽略
    }
  }
}

/** 把 ApiResponse 写成 HTTP 响应。 */
function writeApiResponse(res: ServerResponse, response: ApiResponse): void {
  if (res.writableEnded || res.destroyed) return
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(response.headers ?? {}),
  }
  if (response.binary) {
    headers['content-type'] = response.binary.contentType
    headers['content-length'] = String(response.binary.data.length)
    try {
      res.writeHead(response.status, headers)
      res.end(response.binary.data)
    } catch {
      try {
        res.destroy()
      } catch {
        // 连接已断开时忽略
      }
    }
    return
  }
  let payload: string
  try {
    payload = JSON.stringify(response.json ?? { ok: false, error: '服务端未返回内容' })
  } catch (error) {
    payload = JSON.stringify({ ok: false, error: '服务端响应序列化失败', detail: errorMessage(error) })
  }
  headers['content-type'] = 'application/json; charset=utf-8'
  headers['content-length'] = String(Buffer.byteLength(payload, 'utf8'))
  try {
    res.writeHead(response.status, headers)
    res.end(payload)
  } catch {
    try {
      res.destroy()
    } catch {
      // 连接已断开时忽略
    }
  }
}

/** attach 的 HTTP handler：解析请求 -> 调 api.handle -> 写响应，全程不抛异常。 */
async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  api: PersonaApi,
  logger: Logger,
): Promise<void> {
  try {
    const method = (req.method ?? 'GET').toUpperCase()
    const rawUrl = typeof req.url === 'string' && req.url !== '' ? req.url : '/'
    let parsed: URL
    try {
      parsed = new URL(rawUrl, 'http://127.0.0.1')
    } catch {
      sendJson(res, 400, { ok: false, error: '请求路径不合法' })
      return
    }

    // 先看 Content-Length，超大请求体直接拒绝，避免无谓读取。
    const contentLength = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
    if (Number.isFinite(contentLength) && contentLength > MAX_API_BODY_BYTES) {
      req.resume()
      sendJson(res, 413, { ok: false, error: `请求体超过 ${formatMb(MAX_API_BODY_BYTES)} 上限` })
      return
    }

    // Content-Type 校验：带请求体的写操作必须是 application/json（防 CSRF 表单/simple request 绕过）。
    const expectsBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
    if (expectsBody) {
      const hasBody = (Number.isFinite(contentLength) && contentLength > 0) || typeof req.headers['transfer-encoding'] === 'string'
      const contentType = String(req.headers['content-type'] ?? '').trim().toLowerCase()
      if (hasBody && !contentType.startsWith('application/json')) {
        req.resume()
        sendJson(res, 415, { ok: false, error: '请求 Content-Type 必须是 application/json' })
        return
      }
    }

    const bodyResult = await readRequestBody(req)
    if (!bodyResult.ok) {
      sendJson(res, bodyResult.status, { ok: false, error: bodyResult.error })
      return
    }

    const text = bodyResult.text.trim()
    let body: unknown
    if (text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
    }

    const response = await api.handle(
      method,
      parsed.pathname,
      parsed.searchParams,
      body,
      req.headers,
      req.socket?.remoteAddress,
    )
    writeApiResponse(res, response)
  } catch (error) {
    logger.error('处理微信分身 API 请求失败', errorMessage(error))
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, 500, { ok: false, error: '服务器内部错误', detail: errorMessage(error) })
    } else {
      try {
        res.destroy()
      } catch {
        // 连接已断开时忽略
      }
    }
  }
}

/**
 * 把 API 注册到宿主 webServer（前缀路由 `/dsh-wechat-persona/api/`）。
 *
 * - 使用 node:http 的 IncomingMessage/ServerResponse；
 * - 请求体上限 4MB，超限 413；
 * - 任何异常都转成 JSON 错误响应，不会抛回宿主；
 * - 返回 disposer：插件卸载/重载时注销路由。
 */
export function attachPersonaRoutes(
  webServer: PersonaWebServerLike,
  api: PersonaApi,
  logger: Logger,
): () => void {
  const disposers: Array<() => void> = []
  if (!webServer || typeof webServer.register !== 'function') {
    logger.error('webServer 不支持 register，微信分身设置界面 API 未注册')
    return () => undefined
  }
  try {
    // 方案 A：prefix 路由（若宿主支持则一次覆盖全部子路径）。
    const disposePrefix = webServer.register({
      kind: 'prefix',
      path: `${API_PREFIX}/`,
      handler: (req, res) => handleHttpRequest(req, res, api, logger),
    })
    if (typeof disposePrefix === 'function') disposers.push(disposePrefix)
  } catch (error) {
    logger.error('注册微信分身 API prefix 路由失败', errorMessage(error))
  }

  // 方案 B：宿主 webServer 若不支持 prefix（静默忽略），逐条注册 exact 路由。
  // 这些是设置页实际请求的全部固定路径（动态 id 走 query 或 DELETE 前缀）。
  try {
    const exactPaths = [
      '/health',
      '/status',
      '/diagnostics/ocr',
      '/config',
      '/personas',
      '/personas/install',
      '/personas/import',
      '/personas/activate',
      '/personas/export',
      '/market',
      '/market/install',
      '/stickers',
      '/stickers/upload',
      '/sticker-file',
      '/logs',
      '/test/inbound',
      '/test/send',
      '/drafts',
      '/drafts/approve',
      '/drafts/reject',
      '/pause',
      '/resume',
      '/memory/clear',
      '/audit/clear',
      '/help',
    ]
    for (const sub of exactPaths) {
      const dispose = webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}${sub}`,
        handler: (req, res) => handleHttpRequest(req, res, api, logger),
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (error) {
    logger.error('注册微信分身 API exact 路由失败', errorMessage(error))
  }
  return (): void => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch (error) {
        logger.warn('卸载微信分身 API 路由失败', errorMessage(error))
      }
    }
  }
}

/**
 * Host HTTP API 纯逻辑层（`/dsh-wechat-persona/api/`）。
 *
 * 设计要点：
 * - 纯逻辑与传输分离：`createPersonaApi()` 只负责鉴权、路由、参数校验与调用
 *   注入的依赖，返回 `ApiResponse`（JSON 或二进制）；`attachPersonaRoutes()`
 *   负责 node:http 的请求体读取、JSON 解析与响应写出，由宿主 webServer 注册。
 * - 任何路径都不向宿主抛异常：`handle()` 最外层 try/catch，统一返回
 *   `{ ok:false, error, detail? }`；attach 的 handler 也再兜一层 500。
 * - 鉴权：只接受回环 socket 且请求头 `x-dsh-wechat-persona: 1`；纯逻辑直调
 *   （未传 remoteAddress）视为本机调用，便于单元测试。
 * - 配置校验：不直接依赖 schemastery。以 `config.ts` 的 `defaultConfig()`
 *   为基线合并输入，再做类型/枚举/时间格式校验与数值范围 clamp，保证
 *   API 侧默认值与配置 schema 永不漂移。
 * - 本文件只依赖 node: 内置模块与项目内相对 import（带 .ts 后缀）。
 */

import { randomUUID } from 'node:crypto'
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

/** 鉴权：回环地址 + 正确请求头；返回错误文案，通过返回 null。 */
function checkAuth(
  headers: Record<string, string | string[] | undefined> | undefined,
  remoteAddress: string | undefined,
): string | null {
  const loopback = isLoopbackAddress(remoteAddress)
  const header = headerValue(headers, AUTH_HEADER)
  const headerOk = typeof header === 'string' && header.trim() === '1'
  if (loopback && headerOk) return null
  if (!loopback) return '只允许从本机回环地址访问（127.0.0.1 / ::1）'
  return `缺少或错误的 ${AUTH_HEADER} 请求头（应为 1）`
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

/* ────────────────────────────── API 门面 ────────────────────────────── */

/**
 * 创建纯逻辑 API 门面。
 * 注意：本函数只做装配，不注册路由、不读真实网络；所有副作用都经 deps。
 */
export function createPersonaApi(deps: PersonaApiDeps): PersonaApi {
  let disposed = false

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
      const authError = checkAuth(headers, remoteAddress)
      if (authError !== null) return failJson(403, authError)

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
        return okJson({ ok: true, status, channel, configSummary })
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
          return okJson({ ok: true, config: deps.getConfig(), persist })
        }
        if (verb === 'POST') {
          const obj = requireObject(body)
          if (!obj) return failJson(400, '请求体必须是 JSON 对象')
          if (obj.config === undefined) return failJson(400, '缺少 config 字段（完整配置对象）')
          const validation = validateConfig(obj.config)
          if (!validation.ok) return failJson(400, validation.error, validation.detail)
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
            const before = await installedIds()
            const persona = await deps.personas.install(downloaded, 'market')
            return okJson({ ok: true, persona, updated: before.has(persona.id) })
          } catch (error) {
            return failJson(400, `从 URL 安装人格失败：${errorMessage(error)}`)
          }
        }
        if (!isPlainObject(pack)) {
          return failJson(400, '请求体需要提供 pack（人格包对象）或 url（下载地址）')
        }
        try {
          const before = await installedIds()
          const persona = await deps.personas.install(pack as unknown as PersonaPackV2, 'local')
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
        try {
          const before = await installedIds()
          const persona = await deps.personas.importJson(obj.json)
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
        try {
          const result = await deps.market.install(obj.id.trim())
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
        let result: SendResult
        try {
          result = await engine.sendTest(contactId.slice(0, 128), text.slice(0, 4000))
        } catch (error) {
          return failJson(500, `发送测试消息失败：${errorMessage(error)}`)
        }
        return okJson({ ok: true, result })
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

/** 读取请求体（GET/HEAD 视为空；超过上限返回 413）。 */
function readRequestBody(req: IncomingMessage): Promise<BodyReadResult> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return Promise.resolve({ ok: true, text: '' })
  return new Promise<BodyReadResult>((resolvePromise) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (result: BodyReadResult): void => {
      if (settled) return
      settled = true
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

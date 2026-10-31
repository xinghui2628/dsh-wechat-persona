/**
 * 人格库（PersonaLibrary）：内置人格（只读）+ 已安装人格（可增删）。
 *
 * 目录约定：
 * - 内置人格：`<builtinDir>/*.json`（插件包内即 `personas/builtin/*.json`，文件名即 id，随包升级只读）；
 * - 已安装人格：`<installedDir>/<id>/pack.json`（installedDir 默认 = `<dataDir>/personas`，
 *   可用 config.persona.dir 覆盖；安装时先写临时文件再原子 rename）。
 *
 * 安全 / 稳定性：
 * - persona id 统一消毒为 `[a-z0-9][a-z0-9-_]{0,63}`（安装时消毒，查询时严格校验）；
 * - 所有落盘路径 resolve 后必须仍位于 installedDir 内（防路径穿越）；
 * - 损坏 JSON 只 warn 并跳过，不让一套坏人格拖垮整个列表；
 * - 内置人格永远只读：uninstall 内置 id 返回 false，安装同 id 只会覆盖“已安装副本”；
 * - 其余失败（写入失败、id 非法、格式错误）抛普通 Error，由 Host API 层转成 {ok:false}。
 *
 * 兼容性：`importJson()` 支持本插件 PersonaPackV2 与 SillyTavern 角色卡（v1/v2），
 * 详见 parsePersonaPack()。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WechatPersonaConfig } from '../config.ts'
import type {
  Emotion,
  Logger,
  PersonaLibraryLike,
  PersonaPack,
  PersonaPackV2,
  PersonaStickerRef,
  PersonaSummary,
} from '../types.ts'

/** persona id 规则：小写字母/数字开头，其后允许小写字母、数字、`-`、`_`，总长 1–64。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/u
const ID_MAX_LENGTH = 64

/**
 * 插件包自带的内置人格目录。
 * src/core/persona-library.ts 与 dist/core/persona-library.js 相对插件包根都是
 * `../../personas/builtin/`，所以同一句在源码运行（vitest）与构建产物里都成立。
 */
export const DEFAULT_BUILTIN_DIR = fileURLToPath(new URL('../../personas/builtin/', import.meta.url))

/** 内置人格的固定展示顺序（避免列表顺序随文件系统/语言环境抖动）。 */
export const BUILTIN_PERSONA_ORDER: readonly string[] = [
  'builtin-small',
  'builtin-dafeiyu',
  'builtin-senior',
  'builtin-geek',
]

/** 情绪枚举（与 types.ts 的 Emotion 对齐；此处内联，避免运行时依赖其它业务模块）。 */
const EMOTIONS: readonly string[] = ['happy', 'playful', 'shy', 'comfort', 'curious', 'neutral']

/** 单个人格包的系统提示词上限（防止导入恶意超大文本拖垮提示词/缓存）。 */
const MAX_SYSTEM_PROMPT_CHARS = 20000
/** 单个包的 few-shot 上限。 */
const MAX_EXAMPLES = 50
/** 单个包的表情包引用上限。 */
const MAX_STICKERS = 100
/** 单个包的标签/口头禅/禁忌词条数上限。 */
const MAX_STRING_LIST = 60

/**
 * 从 SillyTavern 卡片映射时追加的微信聊天约束。
 * 原卡多用于长篇角色扮演，直接拿来聊微信会“演过头”，这里收敛成手机短句风格。
 * 同时确保转换后的人格满足产品硬约束（不自称 AI / 不客服腔 / 短句口语）。
 */
const WECHAT_STYLE_HINT = [
  '微信聊天要求：像真人在手机上一个字一个字打出来的，短句、口语，一条消息一两句话就够，别写小作文，别用括号写动作或旁白，不列 1234。',
  '不自称 AI、模型或助手，不客服腔、不端架子，不说「亲」「有什么可以帮您」；被问真实身份就笑着带过。',
  '遇到转账、红包、验证码、密码、银行卡、博彩、刷单这类请求，直接拒绝并结束话题；不主动加好友、不导流、不发链接和二维码。',
].join('\n')

/* ────────────────────────────── 小工具 ────────────────────────────── */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 取字符串字段并 trim；非字符串返回空串。 */
function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 取字符串数组：过滤空串、去重、限长。 */
function stringArray(value: unknown, limit = MAX_STRING_LIST): string[] {
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

/** 截断到指定字符数（按 Unicode 码点，避免把 emoji 劈成两半），超出时补省略号。 */
function truncateText(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return chars.slice(0, Math.max(1, maxChars - 1)).join('') + '…'
}

/** 目录是否存在（且确实是目录）。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    return stat.isDirectory()
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/* ────────────────────────────── id 消毒 / 校验 ────────────────────────────── */

/**
 * 把任意输入消毒成合法 persona id：
 * 小写、非 `[a-z0-9-_]` 的连续字符折叠成 `-`、去掉首尾分隔符、截断到 64。
 * 消毒后可能为空串（例如纯中文名），调用方需自行兜底或报错。
 */
export function sanitizePersonaId(input: unknown): string {
  const raw =
    typeof input === 'string'
      ? input
      : typeof input === 'number' && Number.isFinite(input)
        ? String(input)
        : ''
  const folded = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/gu, '-')
    .replace(/^[-_]+/u, '')
  const capped = folded.slice(0, ID_MAX_LENGTH)
  return capped.replace(/[-_]+$/u, '')
}

/** 严格校验 id（查询/卸载/导出等入口使用，非法直接当作不存在）。 */
export function isValidPersonaId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

/** 由角色名派生稳定 id（中文名会退化为 `card-<hash>`，保证同名同 id、可复现）。 */
function deriveCardId(name: string): string {
  const direct = sanitizePersonaId(name)
  if (isValidPersonaId(direct)) return direct
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 10)
  return `card-${hash}`
}

/* ────────────────────────────── 人格包归一化 ────────────────────────────── */

interface NormalizeOptions {
  /** 来源（内置/市场/本地导入）；不传则尊重包内 source，再兜底 local。 */
  source?: 'builtin' | 'market' | 'local'
  /** 安装时间（毫秒）；不传则尊重包内 installedAt。 */
  installedAt?: number
  /** id 兜底（读取内置/已安装文件时用文件名/目录名兜底）。 */
  fallbackId?: string
}

/** 归一化 few-shot：兼容 {user,reply} / {user,assistant} 两种写法，丢弃不完整项。 */
function normalizeExamples(value: unknown): Array<{ user: string; reply: string }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ user: string; reply: string }> = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const user = stringValue(item.user) || stringValue(item.question)
    const reply =
      stringValue(item.reply) ||
      stringValue(item.assistant) ||
      stringValue(item.char) ||
      stringValue(item.response)
    if (!user || !reply) continue
    out.push({ user, reply })
    if (out.length >= MAX_EXAMPLES) break
  }
  return out
}

/** 归一化人格自带表情包引用：情绪非法时归到 neutral，支持内嵌 data / 远程 url。 */
function normalizeStickers(value: unknown): PersonaStickerRef[] {
  if (!Array.isArray(value)) return []
  const out: PersonaStickerRef[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const name = stringValue(item.name) || stringValue(item.file) || 'sticker'
    const emotionRaw = stringValue(item.emotion).toLowerCase()
    const emotion: Emotion = (EMOTIONS.includes(emotionRaw) ? emotionRaw : 'neutral') as Emotion
    const ref: PersonaStickerRef = { emotion, name }
    const data = stringValue(item.data)
    const url = stringValue(item.url)
    if (data) ref.data = data
    if (url) ref.url = url
    out.push(ref)
    if (out.length >= MAX_STICKERS) break
  }
  return out
}

/**
 * 把“像 PersonaPackV2 的原始对象”归一化成严格 PersonaPackV2。
 * - id 缺失/非法时用 fallbackId 兜底，仍非法则抛 Error（安装入口必须失败）；
 * - systemPrompt 缺失时用 description 兜底，二者都空则抛 Error；
 * - 其余可选字段全部过滤成安全类型，避免脏 JSON 进入引擎提示词。
 */
function normalizePack(raw: unknown, opts: NormalizeOptions = {}): PersonaPackV2 {
  if (!isRecord(raw)) throw new Error('人格包格式错误：内容必须是 JSON 对象')
  const fallbackId = typeof opts.fallbackId === 'string' ? sanitizePersonaId(opts.fallbackId) : ''
  const id = sanitizePersonaId(raw.id) || fallbackId
  if (!isValidPersonaId(id)) {
    throw new Error('人格 id 非法：只允许小写字母、数字、-、_，且以字母或数字开头（最长 64）')
  }
  const name = stringValue(raw.name) || id
  const description = stringValue(raw.description)
  const style = stringValue(raw.style) || stringValue(raw.personality) || truncateText(description, 80)
  const rawPrompt = stringValue(raw.systemPrompt) || stringValue(raw.system_prompt)
  const systemPrompt = rawPrompt || description
  if (!systemPrompt) throw new Error('人格包缺少系统提示词：systemPrompt 与 description 不能同时为空')
  if (Array.from(systemPrompt).length > MAX_SYSTEM_PROMPT_CHARS) {
    throw new Error(`人格包系统提示词过长（上限 ${MAX_SYSTEM_PROMPT_CHARS} 字）`)
  }
  const rawSource = stringValue(raw.source)
  const source: 'builtin' | 'market' | 'local' =
    opts.source ?? (rawSource === 'builtin' || rawSource === 'market' || rawSource === 'local' ? rawSource : 'local')
  const installedAtRaw = typeof raw.installedAt === 'number' && Number.isFinite(raw.installedAt) ? raw.installedAt : undefined
  const installedAt = opts.installedAt ?? installedAtRaw

  const pack: PersonaPackV2 = {
    version: 2,
    id,
    name: name || id,
    avatar: stringValue(raw.avatar),
    style,
    catchphrases: stringArray(raw.catchphrases ?? raw.catchPhrases),
    systemPrompt,
    examples: normalizeExamples(raw.examples),
    taboo: stringArray(raw.taboo ?? raw.taboos),
    stickers: normalizeStickers(raw.stickers),
    author: stringValue(raw.author) || stringValue(raw.creator) || '未知作者',
    description,
    tags: stringArray(raw.tags),
    packVersion: stringValue(raw.packVersion) || stringValue(raw.pack_version) || '1.0.0',
    source,
  }
  if (installedAt !== undefined) pack.installedAt = installedAt
  return pack
}

/** 判断一份 JSON 是不是 SillyTavern 角色卡（而不是本插件 v2 包）。 */
function isSillyTavernCard(raw: Record<string, unknown>): boolean {
  if (typeof raw.spec === 'string' && /chara_card/iu.test(raw.spec)) return true
  const data = isRecord(raw.data) ? raw.data : raw
  const cardFields = ['description', 'personality', 'mes_example', 'first_mes', 'scenario', 'char_name']
  const hasCardField = cardFields.some((key) => typeof data[key] === 'string')
  return hasCardField && typeof raw.systemPrompt !== 'string' && !Array.isArray(raw.examples)
}

/**
 * 解析 SillyTavern 的 mes_example 文本为 few-shot 样例。
 * 约定：`<START>` 分块，`{{user}}:` / `{{char}}:`（也容忍 `用户：`/`对方：`/`你：`）标角色，
 * 无标签的续行拼到上一条同角色消息后面；解析不出完整问答的块直接丢弃。
 */
function parseSillyTavernExamples(text: string): Array<{ user: string; reply: string }> {
  if (!text.trim()) return []
  // 注意：第一个捕获组是“标签”，第二个是“内容”，两者都要捕获。
  const labelPattern =
    /^(\{\{\s*user\s*\}\}|\{\{\s*char\s*\}\}|用户|对方|你|assistant|user|char)\s*[:：]\s*(.*)$/iu
  const out: Array<{ user: string; reply: string }> = []
  for (const block of text.split(/<START>/iu)) {
    const userLines: string[] = []
    const replyLines: string[] = []
    let mode: 'user' | 'reply' | null = null
    for (const rawLine of block.split(/\r?\n/u)) {
      const line = rawLine.trim()
      if (!line) continue
      const match = labelPattern.exec(line)
      if (match) {
        const label = (match[1] ?? '').toLowerCase().replace(/[{}\s]/gu, '')
        const content = (match[2] ?? '').trim()
        if (label === 'user' || label === '用户' || label === '对方') {
          mode = 'user'
          userLines.push(content)
        } else {
          mode = 'reply'
          replyLines.push(content)
        }
        continue
      }
      // 无标签续行：拼到上一条同角色消息后面；没有上一条则丢弃（标题/说明行）。
      if (mode === 'user' && userLines.length > 0) {
        userLines[userLines.length - 1] = `${userLines[userLines.length - 1]} ${line}`
      } else if (mode === 'reply' && replyLines.length > 0) {
        replyLines[replyLines.length - 1] = `${replyLines[replyLines.length - 1]} ${line}`
      }
    }
    const user = userLines.join(' ').trim()
    const reply = replyLines.join(' ').trim()
    if (user && reply) out.push({ user, reply })
    if (out.length >= MAX_EXAMPLES) break
  }
  return out
}

/**
 * 把 SillyTavern（v1/v2）角色卡字段映射为 PersonaPackV2：
 * - char_name/name → name，并据此派生稳定 id（中文名用 `card-<hash>`）；
 * - description / personality / scenario → 系统提示词分段（同时保留 description 摘要）；
 * - mes_example → examples（`<START>` 分块 + `{{user}}`/`{{char}}` 标签）；
 * - tags / creator / character_version / avatar → 对应字段（avatar 允许为空）；
 * - 追加一段微信聊天约束，避免原卡的长篇 RP 风格直接进手机聊天。
 */
export function mapSillyTavernCard(raw: unknown): PersonaPackV2 {
  if (!isRecord(raw)) throw new Error('SillyTavern 角色卡格式错误：data 必须是对象')
  const name = stringValue(raw.char_name) || stringValue(raw.name)
  if (!name) throw new Error('SillyTavern 角色卡缺少 name/char_name')
  const description = stringValue(raw.description)
  const personality = stringValue(raw.personality)
  const scenario = stringValue(raw.scenario)
  const sections: string[] = []
  if (description) sections.push(`【角色设定】\n${description}`)
  if (personality) sections.push(`【性格】\n${personality}`)
  if (scenario) sections.push(`【背景】\n${scenario}`)
  if (sections.length === 0) {
    throw new Error('SillyTavern 角色卡没有可用的 description/personality，无法导入')
  }
  sections.push(WECHAT_STYLE_HINT)
  const idFromCard = sanitizePersonaId(raw.id) || sanitizePersonaId(raw.char_id)
  return {
    version: 2,
    id: isValidPersonaId(idFromCard) ? idFromCard : deriveCardId(name),
    name,
    avatar: stringValue(raw.avatar),
    style: truncateText(personality || description, 120),
    catchphrases: stringArray(raw.catchphrases ?? raw.catchPhrases),
    systemPrompt: sections.join('\n\n'),
    examples: parseSillyTavernExamples(stringValue(raw.mes_example)),
    taboo: stringArray(raw.taboo ?? raw.taboos),
    stickers: normalizeStickers(raw.stickers),
    author: stringValue(raw.creator) || stringValue(raw.author) || '未知作者',
    description: stringValue(raw.creator_notes) || truncateText(description || personality, 200),
    tags: stringArray(raw.tags),
    packVersion: stringValue(raw.character_version) || stringValue(raw.char_version) || '1.0.0',
    source: 'local',
  }
}

function parseJsonText(text: string): unknown {
  const cleaned = text.replace(/^\uFEFF/u, '').trim()
  if (!cleaned) throw new Error('人格包内容为空')
  try {
    return JSON.parse(cleaned) as unknown
  } catch (error) {
    throw new Error(`人格包 JSON 解析失败：${errorText(error)}`)
  }
}

/**
 * 解析任意输入为 PersonaPackV2（安装/导入的统一入口）。
 * 支持：JSON 字符串、PersonaPackV2（含旧字段兜底）、SillyTavern v1/v2 角色卡。
 * 格式不合法时抛普通 Error（由调用方决定 UI 文案）。
 */
export function parsePersonaPack(input: unknown): PersonaPackV2 {
  const raw = typeof input === 'string' ? parseJsonText(input) : input
  if (!isRecord(raw)) throw new Error('人格包格式错误：内容必须是 JSON 对象')
  if (isSillyTavernCard(raw)) {
    const data = isRecord(raw.data) ? raw.data : raw
    const card = mapSillyTavernCard(data)
    // 卡片本体可能带 id（扩展字段），mapSillyTavernCard 已优先使用。
    return card
  }
  return normalizePack(raw)
}

/* ────────────────────────────── 构造函数参数 ────────────────────────────── */

export interface PersonaLibraryOptions {
  /** 插件配置（读 persona.builtinDir / persona.dir / persona.activeId）。 */
  config: WechatPersonaConfig
  logger: Logger
  /** 数据目录；留空 = `<workspace>/.dsh-wechat-persona`。用于推导默认安装根 `<dataDir>/personas`。 */
  dataDir?: string
  /** 工作区根目录（解析相对路径用）；留空 = 进程工作目录。 */
  workspace?: string
  /** 内置人格目录覆盖（测试注入用；留空 = config.persona.builtinDir 或插件包内 personas/builtin）。 */
  builtinDir?: string
  /** 已安装人格根目录覆盖（测试注入用；留空 = config.persona.dir 或 `<dataDir>/personas`）。 */
  installedDir?: string
  /** 当前时间（毫秒）；测试注入用。 */
  now?: () => number
}

/* ────────────────────────────── 人格库 ────────────────────────────── */

export class PersonaLibrary implements PersonaLibraryLike {
  /** 内置人格根目录（可能指向 personas/ 根，扫描时会自动下钻 builtin/）。 */
  readonly builtinRoot: string
  /** 已安装人格根目录（每个子目录即一个人格 id）。 */
  readonly installedRoot: string

  private readonly config: WechatPersonaConfig
  private readonly logger: Logger
  private readonly now: () => number

  constructor(opts: PersonaLibraryOptions) {
    if (!opts || typeof opts !== 'object') throw new Error('PersonaLibrary 构造参数缺失')
    if (!opts.config || typeof opts.config !== 'object') throw new Error('PersonaLibrary 缺少 config')
    if (!opts.logger) throw new Error('PersonaLibrary 缺少 logger')
    this.config = opts.config
    this.logger = opts.logger
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()

    const workspace = stringValue(opts.workspace) ? resolve(stringValue(opts.workspace)) : process.cwd()
    // 数据目录：显式注入 > config.dataDir > <workspace>/.dsh-wechat-persona（与 index.ts boot 时口径一致）。
    const configuredDataDir = stringValue(opts.dataDir) || stringValue(opts.config.dataDir)
    const dataDir = configuredDataDir
      ? resolve(workspace, configuredDataDir)
      : resolve(workspace, '.dsh-wechat-persona')
    const personaConfig: Partial<WechatPersonaConfig['persona']> = opts.config.persona ?? {}
    const configuredBuiltin = stringValue(personaConfig.builtinDir)
    const configuredInstalled = stringValue(personaConfig.dir)

    const builtinOpt = stringValue(opts.builtinDir)
    this.builtinRoot = builtinOpt
      ? resolve(workspace, builtinOpt)
      : configuredBuiltin
        ? resolve(workspace, configuredBuiltin)
        : DEFAULT_BUILTIN_DIR

    const installedOpt = stringValue(opts.installedDir)
    this.installedRoot = installedOpt
      ? resolve(workspace, installedOpt)
      : configuredInstalled
        ? resolve(workspace, configuredInstalled)
        : join(dataDir, 'personas')
  }

  /* ─────────────── 查询 ─────────────── */

  /** 当前启用的人格 id（配置为空 = 关闭人格回复）。 */
  activeId(): string {
    return stringValue(this.config.persona?.activeId)
  }

  /**
   * 列出全部人格：内置在前（固定顺序），已安装的同 id 副本覆盖内置条目，其余已安装按安装时间排序。
   * 单个人格包损坏只 warn + 跳过，不抛异常。
   */
  async list(activeId: string): Promise<PersonaSummary[]> {
    const active = typeof activeId === 'string' ? activeId.trim() : ''
    const builtinPacks = await this.readBuiltinPacks()
    const installedPacks = await this.readInstalledPacks()

    const result: PersonaSummary[] = []
    const used = new Set<string>()
    const builtinIds = [...builtinPacks.keys()].sort(compareBuiltinIds)
    for (const id of builtinIds) {
      const pack = installedPacks.get(id) ?? builtinPacks.get(id)
      if (!pack) continue
      result.push(this.summarize(pack, active))
      used.add(id)
    }
    const extras = [...installedPacks.values()]
      .filter((pack) => !used.has(pack.id))
      .sort((a, b) => (a.installedAt ?? 0) - (b.installedAt ?? 0) || a.id.localeCompare(b.id))
    for (const pack of extras) result.push(this.summarize(pack, active))
    return result
  }

  /** 取单个人格包（已安装优先于内置）；不存在/损坏/id 非法返回 null。 */
  async get(id: string): Promise<PersonaPackV2 | null> {
    const safe = this.lookupId(id)
    if (safe === null) return null
    const installed = await this.readInstalledPack(safe)
    if (installed) return clonePack(installed)
    const builtinPacks = await this.readBuiltinPacks()
    const builtin = builtinPacks.get(safe)
    return builtin ? clonePack(builtin) : null
  }

  /** 当前启用的人格包（activeId 为空/不存在返回 null）。 */
  async activePack(activeId?: string): Promise<PersonaPackV2 | null> {
    const id = stringValue(activeId) || this.activeId()
    if (!id) return null
    return this.get(id)
  }

  /** 当前启用人格转成引擎需要的 PersonaPack（引擎启动时用）；没有则 null。 */
  async loadActivePack(activeId?: string): Promise<PersonaPack | null> {
    const pack = await this.activePack(activeId)
    return pack ? this.toEnginePack(pack) : null
  }

  /** 是否已安装（内置不算“已安装”，只有 installedRoot 下有副本才算）。 */
  async isInstalled(id: string): Promise<boolean> {
    const safe = this.lookupId(id)
    if (safe === null) return false
    try {
      await fs.access(this.packFileOf(safe))
      return true
    } catch {
      return false
    }
  }

  /* ─────────────── 安装 / 导入 / 卸载 / 导出 ─────────────── */

  /**
   * 安装（同 id 覆盖 = 更新）。写入 `<installedRoot>/<id>/pack.json`：
   * 先写同目录临时文件，再原子 rename，避免崩溃留下半截 JSON。
   * 返回安装后的摘要（active 按 config.persona.activeId 计算）。
   */
  async install(pack: PersonaPackV2, source: 'market' | 'local'): Promise<PersonaSummary> {
    if (source !== 'market' && source !== 'local') {
      throw new Error(`人格来源非法：${String(source)}（只支持 market / local）`)
    }
    const normalized = normalizePack(pack, { source, installedAt: this.now() })
    await this.writeInstalledPack(normalized)
    this.logger.info('persona-library: 人格已安装', {
      id: normalized.id,
      name: normalized.name,
      source,
    })
    return this.summarize(normalized, this.activeId())
  }

  /** 导入（PersonaPackV2 或 SillyTavern 角色卡），一律按本地来源安装。 */
  async importJson(input: unknown): Promise<PersonaSummary> {
    const pack = parsePersonaPack(input)
    return this.install(pack, 'local')
  }

  /** 卸载已安装人格；内置人格只读（返回 false），不存在也返回 false。 */
  async uninstall(id: string): Promise<boolean> {
    const safe = this.lookupId(id)
    if (safe === null) return false
    const dir = this.installedDirOf(safe)
    if (!(await isDirectory(dir))) return false
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch (error) {
      throw new Error(`卸载人格失败（${safe}）：${errorText(error)}`)
    }
    this.logger.info('persona-library: 人格已卸载', { id: safe })
    return true
  }

  /** 导出人格包（内置/已安装都支持，返回副本）；不存在返回 null。 */
  async exportPack(id: string): Promise<PersonaPackV2 | null> {
    return this.get(id)
  }

  /* ─────────────── 引擎适配 ─────────────── */

  /**
   * PersonaPackV2 → 引擎的 PersonaPack：
   * - systemPrompt 追加风格/口头禅/禁忌（引擎只看这一个字段，不追加就丢了这些约束）；
   * - examples 的 `reply` 映射成引擎要求的 `assistant`；
   * - sourceDir 指向包所在目录（人格自带表情包用）。
   */
  toEnginePack(pack: PersonaPackV2): PersonaPack {
    const sections: string[] = []
    const prompt = stringValue(pack.systemPrompt)
    if (prompt) sections.push(prompt)
    const style = stringValue(pack.style)
    if (style) sections.push(`说话风格：${style}`)
    const phrases = stringArray(pack.catchphrases)
    if (phrases.length > 0) {
      sections.push(`偶尔使用的口头禅（一句里最多带一个，别每句都带）：${phrases.join('、')}`)
    }
    const taboo = stringArray(pack.taboo)
    if (taboo.length > 0) {
      sections.push(`遇到这些话题轻描淡写地拒绝并转开：${taboo.join('、')}`)
    }
    const examples = normalizeExamples(pack.examples).map((example) => ({
      user: example.user,
      assistant: example.reply,
    }))
    const sourceDir = pack.source === 'builtin' ? this.builtinRoot : this.installedDirOf(pack.id)
    return {
      name: stringValue(pack.name) || pack.id,
      systemPrompt: sections.join('\n\n'),
      examples,
      sourceDir,
    }
  }

  /* ─────────────── 内部：路径与读取 ─────────────── */

  /** 查询入口的严格 id 校验：非法/空串返回 null（当作不存在，绝不抛路径异常）。 */
  private lookupId(id: unknown): string | null {
    if (typeof id !== 'string') return null
    const trimmed = id.trim()
    return isValidPersonaId(trimmed) ? trimmed : null
  }

  /**
   * 计算某个 id 的安装目录；resolve 后必须仍位于 installedRoot 内（路径穿越防护）。
   * 正常 id 已由正则保证不含分隔符，这里是第二道防线。
   */
  private installedDirOf(id: string): string {
    const root = resolve(this.installedRoot)
    const dir = resolve(root, id)
    const rootPrefix = root.endsWith(sep) ? root : root + sep
    if (dir !== root && !dir.startsWith(rootPrefix)) {
      throw new Error(`人格 id 越界：${id}`)
    }
    return dir
  }

  private packFileOf(id: string): string {
    return join(this.installedDirOf(id), 'pack.json')
  }

  /** 引擎用 sourceDir：已安装读安装目录，内置读内置根（可能指向 personas/ 根，够用）。 */
  private summarize(pack: PersonaPackV2, activeId: string): PersonaSummary {
    const summary: PersonaSummary = {
      id: pack.id,
      name: pack.name,
      avatar: pack.avatar,
      style: pack.style,
      description: pack.description,
      tags: [...pack.tags],
      author: pack.author,
      packVersion: pack.packVersion,
      source: pack.source ?? 'local',
      active: pack.id === activeId,
    }
    if (pack.installedAt !== undefined) summary.installedAt = pack.installedAt
    return summary
  }

  /** 内置人格扫描目录：显式/默认目录优先；配置指向 personas/ 根时自动下钻 builtin/。 */
  private async builtinScanDirs(): Promise<string[]> {
    const root = resolve(this.builtinRoot)
    if (root === resolve(DEFAULT_BUILTIN_DIR)) return [root]
    const nested = join(root, 'builtin')
    if (await isDirectory(nested)) return [nested]
    return [root]
  }

  /** 读取全部内置人格（只读）；损坏文件 warn 后跳过。 */
  private async readBuiltinPacks(): Promise<Map<string, PersonaPackV2>> {
    const packs = new Map<string, PersonaPackV2>()
    for (const dir of await this.builtinScanDirs()) {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (isNotFound(error)) {
          this.logger.warn('persona-library: 内置人格目录不存在', { dir })
        } else {
          this.logger.warn('persona-library: 读取内置人格目录失败', { dir, error: errorText(error) })
        }
        continue
      }
      const files = entries
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.json')
        .map((entry) => entry.name)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      for (const fileName of files) {
        const file = join(dir, fileName)
        const fileId = sanitizePersonaId(basename(fileName, extname(fileName)))
        try {
          const text = await fs.readFile(file, 'utf8')
          const pack = normalizePack(JSON.parse(text) as unknown, { source: 'builtin', fallbackId: fileId })
          // 内置人格以文件名为准（文件名即 id）；文件名不是合法 id 时才用包内 id。
          if (isValidPersonaId(fileId)) {
            if (pack.id !== fileId) {
              this.logger.warn('persona-library: 内置人格 id 与文件名不一致，以文件名为准', {
                file,
                fileId,
                packId: pack.id,
              })
              pack.id = fileId
            }
          }
          if (!packs.has(pack.id)) packs.set(pack.id, pack)
        } catch (error) {
          this.logger.warn('persona-library: 内置人格包损坏，已跳过', {
            file,
            error: errorText(error),
          })
        }
      }
    }
    return packs
  }

  /** 读取全部已安装人格；损坏/缺 pack.json 的目录 warn 或 debug 后跳过。 */
  private async readInstalledPacks(): Promise<Map<string, PersonaPackV2>> {
    const packs = new Map<string, PersonaPackV2>()
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(this.installedRoot, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) return packs
      this.logger.warn('persona-library: 读取已安装人格目录失败', {
        dir: this.installedRoot,
        error: errorText(error),
      })
      return packs
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const dirName of dirs) {
      const id = sanitizePersonaId(dirName)
      if (!isValidPersonaId(id)) {
        this.logger.warn('persona-library: 已安装人格目录名非法，已跳过', { dir: dirName })
        continue
      }
      const pack = await this.readInstalledPack(id)
      if (pack) packs.set(id, pack)
    }
    return packs
  }

  /** 读取单个已安装人格（目录名即 id）；缺失返回 null，损坏 warn 后返回 null。 */
  private async readInstalledPack(id: string): Promise<PersonaPackV2 | null> {
    let text: string
    try {
      text = await fs.readFile(this.packFileOf(id), 'utf8')
    } catch (error) {
      if (isNotFound(error)) return null
      this.logger.warn('persona-library: 读取已安装人格失败', { id, error: errorText(error) })
      return null
    }
    try {
      const pack = normalizePack(JSON.parse(text) as unknown, { fallbackId: id })
      // 目录名即 id：以目录名为准，保证 get/list/install 的 id 一致。
      pack.id = id
      if (pack.source !== 'market' && pack.source !== 'local') pack.source = 'local'
      return pack
    } catch (error) {
      this.logger.warn('persona-library: 已安装人格包损坏，已跳过', { id, error: errorText(error) })
      return null
    }
  }

  /* ─────────────── 内部：写入 ─────────────── */

  /** 原子写入 pack.json：临时文件 + rename；Windows 上目标被占用时删掉再重试一次。 */
  private async writeInstalledPack(pack: PersonaPackV2): Promise<void> {
    const dir = this.installedDirOf(pack.id)
    const target = join(dir, 'pack.json')
    const text = JSON.stringify(pack, null, 2) + '\n'
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (error) {
      throw new Error(`创建人格目录失败（${pack.id}）：${errorText(error)}`)
    }
    const tmp = join(dir, `pack.json.${process.pid}.${Date.now()}.tmp`)
    try {
      await fs.writeFile(tmp, text, 'utf8')
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw new Error(`写入人格包失败（${pack.id}）：${errorText(error)}`)
    }
    try {
      await fs.rename(tmp, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'EPERM' || code === 'EACCES' || code === 'EEXIST' || code === 'ENOTEMPTY') {
        // Windows 上目标文件被占用/已存在时 rename 可能失败：内容已完整写入临时文件，删旧再重命名。
        try {
          await fs.rm(target, { force: true })
          await fs.rename(tmp, target)
          return
        } catch (retryError) {
          await fs.rm(tmp, { force: true }).catch(() => undefined)
          throw new Error(`替换人格包失败（${pack.id}）：${errorText(retryError)}`)
        }
      }
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw new Error(`替换人格包失败（${pack.id}）：${errorText(error)}`)
    }
  }
}

/** 内置人格固定顺序：已知 id 按 BUILTIN_PERSONA_ORDER，未知 id 排后面按字母序。 */
function compareBuiltinIds(a: string, b: string): number {
  const ia = BUILTIN_PERSONA_ORDER.indexOf(a)
  const ib = BUILTIN_PERSONA_ORDER.indexOf(b)
  if (ia !== -1 && ib !== -1) return ia - ib
  if (ia !== -1) return -1
  if (ib !== -1) return 1
  return a.localeCompare(b)
}

/** 深拷贝人格包，避免调用方修改内部缓存/磁盘读取结果。 */
function clonePack(pack: PersonaPackV2): PersonaPackV2 {
  return structuredClone(pack)
}

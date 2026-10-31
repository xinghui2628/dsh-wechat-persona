/**
 * 表情包目录（StickerCatalog）。
 *
 * 目录约定：`<dir>/<emotion>/<文件名>.png|.gif|.webp`，例如
 *   stickers/happy/001.png  ->  id = "package:happy/001.png"，file = 绝对路径
 *
 * 支持多个来源（第二轮迭代）：
 * - package：插件包内自带 `stickers/`（只读，随包升级）；
 * - uploaded：数据目录下用户上传的 `<dataDir>/stickers/`（可增删）；
 * - persona：当前人格包自带的表情目录（只读）。
 *
 * 全局 id = `<origin>:<emotion>/<文件名>`，保证同名文件跨来源不冲突；
 * 发送时仍使用本地绝对路径（通道自己决定怎么发）。
 *
 * - `load()` 扫描全部来源并重建索引（可重复调用，幂等）；目录缺失/不可读时
 *   跳过并 warn，不抛异常；
 * - `pick(category, recentIds)` 在指定分类里排除最近用过的 id 随机挑一个；
 *   没有可选项返回 null（引擎据此降级为不发表情包）；
 * - `pickAny(recentIds)` 跨全部分类兜底，规则相同；
 * - 随机源由外部注入（Random），测试里可用确定性假实现。
 */
import { readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import type {
  Emotion,
  Logger,
  Random,
  StickerCatalogApi,
  StickerChoice,
  StickerSummary,
} from '../types.ts'

/** 固定分类顺序：界面/提示词里保持一致，不随磁盘扫描顺序抖动。 */
export const EMOTION_ORDER: readonly Emotion[] = [
  'happy',
  'playful',
  'shy',
  'comfort',
  'curious',
  'neutral',
]

const ALLOWED_EXTENSIONS = new Set(['.png', '.gif', '.webp'])

/** 表情来源与优先级（同分时按此顺序排列）。 */
export type StickerOrigin = 'package' | 'uploaded' | 'persona'
const ORIGIN_ORDER: readonly StickerOrigin[] = ['package', 'uploaded', 'persona']

interface StickerEntry {
  id: string
  category: Emotion
  file: string
  origin: StickerOrigin
}

export interface StickerSource {
  dir: string
  origin: StickerOrigin
}

export interface StickerCatalogOptions {
  /** 单来源简写（等价于 dirs: [{ dir, origin: 'package' }]）。 */
  dir?: string
  /** 多来源（推荐）。 */
  dirs?: StickerSource[]
  random: Random
  logger: Logger
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 文件名排序，保证同分类内顺序稳定（001.png 在 002.png 前）。 */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export class StickerCatalog implements StickerCatalogApi {
  private readonly sources: StickerSource[]
  private readonly random: Random
  private readonly logger: Logger

  /** emotion -> 该分类下的表情包（按来源、文件名排序）。 */
  private byCategory = new Map<Emotion, StickerEntry[]>()
  private allEntries: StickerEntry[] = []
  private total = 0

  constructor(opts: StickerCatalogOptions) {
    const dirs: StickerSource[] = []
    if (typeof opts.dir === 'string' && opts.dir.trim()) dirs.push({ dir: opts.dir, origin: 'package' })
    for (const source of opts.dirs ?? []) {
      if (source && typeof source.dir === 'string' && source.dir.trim()) {
        dirs.push({ dir: source.dir, origin: source.origin })
      }
    }
    // 同一目录只扫描一次（先出现者优先）。
    const seen = new Set<string>()
    this.sources = dirs.filter((source) => {
      const key = resolve(source.dir)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    this.random = opts.random
    this.logger = opts.logger
  }

  /** 扫描全部来源，重建索引；失败时只告警。 */
  async reload(): Promise<void> {
    const next = new Map<Emotion, StickerEntry[]>()
    const all: StickerEntry[] = []

    for (const source of this.sources) {
      const root = resolve(source.dir)
      let rootNames: string[]
      try {
        const entries = await readdir(root, { withFileTypes: true })
        rootNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      } catch (error) {
        if (isNotFound(error)) {
          // 单来源（旧行为）算异常配置，warn 一次；多来源时某个目录缺失属正常。
          if (this.sources.length === 1) {
            this.logger.warn('stickers: 表情包目录不存在', { dir: root })
          } else {
            this.logger.debug('stickers: 来源目录不存在，跳过', {
              dir: root,
              origin: source.origin,
            })
          }
        } else {
          this.logger.warn('stickers: 扫描来源目录失败，跳过', {
            dir: root,
            origin: source.origin,
            error: errorText(error),
          })
        }
        continue
      }
      const present = new Set(rootNames)
      for (const category of EMOTION_ORDER) {
        if (!present.has(category)) continue
        const emotionDir = resolve(root, category)
        let names: string[]
        try {
          const entries = await readdir(emotionDir, { withFileTypes: true })
          names = entries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .filter((name) => ALLOWED_EXTENSIONS.has(extname(name).toLowerCase()))
            .sort(compareNames)
        } catch (error) {
          this.logger.warn('stickers: 扫描表情包分类失败', {
            category,
            origin: source.origin,
            error: errorText(error),
          })
          continue
        }
        if (names.length === 0) continue
        const list = next.get(category) ?? []
        for (const name of names) {
          // 包内来源保持旧 id 格式（happy/001.png），其余来源加前缀避免同名冲突。
          const id = source.origin === 'package' ? `${category}/${name}` : `${source.origin}:${category}/${name}`
          const entry: StickerEntry = {
            id,
            category,
            file: resolve(emotionDir, name),
            origin: source.origin,
          }
          list.push(entry)
          all.push(entry)
        }
        next.set(category, list)
      }
    }

    this.byCategory = next
    this.allEntries = all
    this.total = all.length
    this.logger.debug('stickers: 表情包目录已加载', {
      total: all.length,
      categories: [...next.keys()],
      sources: this.sources.map((source) => `${source.origin}:${source.dir}`),
    })
  }

  /** 兼容旧调用（engine 之前调用 load()）。 */
  async load(): Promise<void> {
    await this.reload()
  }

  /** 非空分类，按固定顺序返回。 */
  categories(): Emotion[] {
    return EMOTION_ORDER.filter((category) => (this.byCategory.get(category)?.length ?? 0) > 0)
  }

  /** 已加载的表情包总数。 */
  count(): number {
    return this.total
  }

  /** 设置页列表情：按分类分组、来源优先的顺序。 */
  list(): StickerSummary[] {
    return [...this.allEntries]
      .sort((a, b) => {
        const byCategory = EMOTION_ORDER.indexOf(a.category) - EMOTION_ORDER.indexOf(b.category)
        if (byCategory !== 0) return byCategory
        const byOrigin = ORIGIN_ORDER.indexOf(a.origin) - ORIGIN_ORDER.indexOf(b.origin)
        if (byOrigin !== 0) return byOrigin
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      .map((entry) => ({
        id: entry.id,
        category: entry.category,
        name: entry.id.slice(entry.id.indexOf(':') + 1),
        origin: entry.origin,
        url: '',
      }))
  }

  /** 按全局 id 找本地文件（API 预览/删除用）。 */
  fileOf(id: string): string | null {
    if (typeof id !== 'string') return null
    const found = this.allEntries.find((entry) => entry.id === id)
    return found ? found.file : null
  }

  /** 指定分类里挑一个近期没用过的；无候选返回 null。 */
  pick(category: Emotion, recentIds: readonly string[]): StickerChoice | null {
    const pool = this.byCategory.get(category)
    if (pool === undefined || pool.length === 0) return null
    return this.choose(pool, recentIds)
  }

  /** 全部分类兜底挑一个近期没用过的；无候选返回 null。 */
  pickAny(recentIds: readonly string[]): StickerChoice | null {
    const pool: StickerEntry[] = []
    for (const category of EMOTION_ORDER) {
      const list = this.byCategory.get(category)
      if (list !== undefined) pool.push(...list)
    }
    if (pool.length === 0) return null
    return this.choose(pool, recentIds)
  }

  /** 排除 recentIds 后等概率随机挑一个。 */
  private choose(pool: readonly StickerEntry[], recentIds: readonly string[]): StickerChoice | null {
    const excluded = new Set<string>()
    if (Array.isArray(recentIds)) {
      for (const id of recentIds) {
        if (typeof id === 'string') excluded.add(id)
      }
    }
    const candidates =
      excluded.size === 0 ? pool : pool.filter((entry) => !excluded.has(entry.id))
    if (candidates.length === 0) return null

    const raw = this.random.next()
    const normalized = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999) : 0
    const index = Math.min(Math.floor(normalized * candidates.length), candidates.length - 1)
    const chosen = candidates[index]
    return { id: chosen.id, category: chosen.category, file: chosen.file }
  }
}

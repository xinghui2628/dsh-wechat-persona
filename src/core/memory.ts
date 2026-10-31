/**
 * 每联系人记忆存储（MemoryStore）。
 *
 * 设计要点：
 * - 一个联系人一个 JSON 文件：`<store.root>/memory/<sha1(contactId)[0:16]>.json`。
 *   用哈希做文件名，contactId（微信备注名/昵称/会话 id）永远不会被拼进路径，
 *   天然规避目录穿越与非法文件名字符；
 * - 所有操作（读与写）都进入同一条内部 promise 队列串行执行，避免并发
 *   append 互相覆盖造成丢消息；`flush()` 只是等待队列排空；
 * - FileStoreLike 由 host 注入（root = dataDir），本模块只用相对路径；
 * - 记忆属于增强能力：磁盘读写失败只 warn 不抛，绝不影响引擎主流程。
 */
import { createHash } from 'node:crypto'
import type { WechatPersonaConfig } from '../config.ts'
import type {
  Clock,
  FileStoreLike,
  Logger,
  MemoryMessage,
  MemoryProfile,
  MemoryRecord,
  MemoryStoreLike,
} from '../types.ts'
import { mergePreferences } from './preferences.ts'

/** 记忆文件所在目录（相对 dataDir/store.root）。 */
const MEMORY_DIR = 'memory'
/** 记忆文件版本，与 MemoryRecord.version 对齐。 */
const MEMORY_VERSION = 1
/** contactId 哈希取前 16 位十六进制（64 bit，碰撞概率可忽略）。 */
const HASH_PREFIX_LEN = 16
/** 最近表情包 id 保留条数（不连续重复用）。 */
const STICKER_HISTORY_KEEP = 20
/** 配置缺失/非法时的兜底值，与 config.ts 的默认值一致。 */
const FALLBACK_RECENT_KEEP = 30
const FALLBACK_SUMMARY_EVERY = 50
const FALLBACK_MAX_SUMMARY_CHARS = 400

export interface MemoryStoreOptions {
  /** host 注入的文件存储（root = dataDir）。 */
  store: FileStoreLike
  /** 完整插件配置（读 memory.* 子配置）。 */
  config: WechatPersonaConfig
  clock: Clock
  logger: Logger
}

/** 配置里的数值做一次防御性规范化：非法值回落到默认，负数归零。 */
function finiteInt(value: unknown, fallback: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.floor(value))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把未知值规范成去空的字符串数组（偏好解析用）。 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '' && !out.includes(item.trim())) {
      out.push(item.trim())
    }
  }
  return out
}

/** 偏好深拷贝（缓存对象不能让外部改到）。 */
function cloneProfile(profile: MemoryProfile): MemoryProfile {
  return {
    nickname: profile.nickname,
    taboos: [...profile.taboos],
    topics: [...profile.topics],
    updatedAt: profile.updatedAt,
  }
}

export class MemoryStore implements MemoryStoreLike {
  private readonly store: FileStoreLike
  private readonly config: WechatPersonaConfig
  private readonly clock: Clock
  private readonly logger: Logger

  /**
   * contactId -> MemoryRecord 的进程内缓存（缓存对象与落盘内容同源，
   * 每次变更后立即写盘；不同 MemoryStore 实例之间不共享）。
   */
  private readonly cache = new Map<string, MemoryRecord>()

  /** 串行队列尾部；写操作全部挂在它后面。 */
  private chain: Promise<void> = Promise.resolve()

  constructor(opts: MemoryStoreOptions) {
    this.store = opts.store
    this.config = opts.config
    this.clock = opts.clock
    this.logger = opts.logger
  }

  /* ────────────────────────────── 公开 API ────────────────────────────── */

  async get(contactId: string, contactName: string): Promise<MemoryRecord> {
    return this.enqueue(async () => {
      const record = await this.load(contactId, contactName)
      return this.clone(record)
    })
  }

  async recent(contactId: string, contactName: string, n: number): Promise<MemoryMessage[]> {
    return this.enqueue(async () => {
      const record = await this.load(contactId, contactName)
      const limit = finiteInt(n, 0)
      if (limit === 0) return []
      return record.recent.slice(-limit).map((message) => ({ ...message }))
    })
  }

  async summaryOf(contactId: string, contactName: string): Promise<string> {
    return this.enqueue(async () => {
      const record = await this.load(contactId, contactName)
      return record.summary
    })
  }

  async append(contactId: string, contactName: string, message: MemoryMessage): Promise<void> {
    await this.enqueue(async () => {
      const record = await this.load(contactId, contactName)
      const now = this.clock.now()
      const role: MemoryMessage['role'] = message.role === 'assistant' ? 'assistant' : 'user'
      const at =
        typeof message.at === 'number' && Number.isFinite(message.at) ? message.at : now
      record.recent.push({ role, text: typeof message.text === 'string' ? message.text : '', at })
      const keep = this.recentKeep()
      if (record.recent.length > keep) {
        record.recent.splice(0, record.recent.length - keep)
      }
      record.totalTurns += 1
      if (typeof contactName === 'string' && contactName.length > 0) {
        record.contactName = contactName
      }
      record.updatedAt = now
      await this.persist(record)
    })
  }

  async setSummary(contactId: string, contactName: string, summary: string): Promise<void> {
    await this.enqueue(async () => {
      const record = await this.load(contactId, contactName)
      const limit = this.maxSummaryChars()
      const text = typeof summary === 'string' ? summary : ''
      record.summary = limit > 0 ? text.slice(0, limit) : ''
      record.updatedAt = this.clock.now()
      await this.persist(record)
    })
  }

  async lastStickerIds(contactId: string, contactName: string): Promise<string[]> {
    return this.enqueue(async () => {
      const record = await this.load(contactId, contactName)
      return [...record.recentStickerIds]
    })
  }

  async rememberSticker(
    contactId: string,
    contactName: string,
    stickerId: string,
  ): Promise<void> {
    if (typeof stickerId !== 'string' || stickerId.length === 0) return
    await this.enqueue(async () => {
      const record = await this.load(contactId, contactName)
      record.recentStickerIds.push(stickerId)
      if (record.recentStickerIds.length > STICKER_HISTORY_KEEP) {
        record.recentStickerIds.splice(
          0,
          record.recentStickerIds.length - STICKER_HISTORY_KEEP,
        )
      }
      record.updatedAt = this.clock.now()
      await this.persist(record)
    })
  }

  /** 读取联系人的轻量偏好（称呼/忌口/话题）；没有则返回 undefined。 */
  async profileOf(contactId: string, contactName: string): Promise<MemoryProfile | undefined> {
    return this.enqueue(async () => {
      const record = await this.load(contactId, contactName)
      return record.profile ? cloneProfile(record.profile) : undefined
    })
  }

  /** 合并偏好片段并落盘（0 token 规则提取的结果）。 */
  async mergeProfile(
    contactId: string,
    contactName: string,
    patch: Partial<MemoryProfile>,
    now: number,
  ): Promise<MemoryProfile> {
    return this.enqueue(async () => {
      const record = await this.load(contactId, contactName)
      const merged = mergePreferences(record.profile, patch, now)
      record.profile = merged
      record.updatedAt = now
      await this.persist(record)
      return cloneProfile(merged)
    })
  }

  async shouldSummarize(contactId: string, contactName: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.config.memory.autoSummary !== true) return false
      const every = this.summaryEveryTurns()
      if (every <= 0) return false
      const record = await this.load(contactId, contactName)
      return record.totalTurns > 0 && record.totalTurns % every === 0
    })
  }

  async clear(contactId?: string): Promise<void> {
    await this.enqueue(async () => {
      // 无 contactId（或空串）=> 清空全部记忆目录。
      if (contactId === undefined || contactId === '') {
        this.cache.clear()
        try {
          await this.store.removeTree(MEMORY_DIR)
        } catch (error) {
          // 目录本来就不存在算正常；其余情况只告警。
          this.logger.debug('memory: 清空记忆目录失败', { error: errorText(error) })
        }
        return
      }
      this.cache.delete(contactId)
      const rel = this.relPath(contactId)
      try {
        const existing = await this.store.read(rel)
        if (existing !== null) await this.store.remove(rel)
      } catch (error) {
        this.logger.warn('memory: 删除联系人记忆失败', {
          contactId,
          error: errorText(error),
        })
      }
    })
  }

  async listContacts(): Promise<string[]> {
    return this.enqueue(async () => {
      let names: string[]
      try {
        names = await this.store.list(MEMORY_DIR)
      } catch (error) {
        this.logger.debug('memory: 列出记忆目录失败', { error: errorText(error) })
        return []
      }
      const seen = new Set<string>()
      const ids: string[] = []
      for (const entry of names) {
        const file = entry.split(/[\\/]/u).pop() ?? entry
        if (!file.toLowerCase().endsWith('.json')) continue
        try {
          const raw = await this.store.read(`${MEMORY_DIR}/${file}`)
          if (raw === null) continue
          const parsed: unknown = JSON.parse(raw)
          const id = isRecord(parsed) && typeof parsed.contactId === 'string' ? parsed.contactId : ''
          if (id.length > 0 && !seen.has(id)) {
            seen.add(id)
            ids.push(id)
          }
        } catch (error) {
          this.logger.debug('memory: 跳过无法解析的记忆文件', {
            file,
            error: errorText(error),
          })
        }
      }
      return ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    })
  }

  async flush(): Promise<void> {
    await this.chain
  }

  /* ────────────────────────────── 内部实现 ────────────────────────────── */

  /**
   * 把一个任务挂到内部串行队列上。
   * 前一个任务失败不影响后一个（新任务作为 onRejected 也执行）。
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private contactHash(contactId: string): string {
    return createHash('sha1').update(contactId, 'utf8').digest('hex').slice(0, HASH_PREFIX_LEN)
  }

  /** 记忆文件相对路径；contactId 只以哈希形式出现。 */
  private relPath(contactId: string): string {
    return `${MEMORY_DIR}/${this.contactHash(contactId)}.json`
  }

  private recentKeep(): number {
    return finiteInt(this.config.memory.recentKeep, FALLBACK_RECENT_KEEP)
  }

  private summaryEveryTurns(): number {
    return finiteInt(this.config.memory.summaryEveryTurns, FALLBACK_SUMMARY_EVERY)
  }

  private maxSummaryChars(): number {
    return finiteInt(this.config.memory.maxSummaryChars, FALLBACK_MAX_SUMMARY_CHARS)
  }

  private emptyRecord(contactId: string, contactName: string): MemoryRecord {
    return {
      version: MEMORY_VERSION,
      contactId,
      contactName: typeof contactName === 'string' ? contactName : '',
      recent: [],
      summary: '',
      totalTurns: 0,
      recentStickerIds: [],
      updatedAt: this.clock.now(),
    }
  }

  /** 内存缓存优先，其次读盘；读不到/解析失败都回落到空记录。 */
  private async load(contactId: string, contactName: string): Promise<MemoryRecord> {
    const cached = this.cache.get(contactId)
    if (cached) return cached

    let loaded: MemoryRecord | null = null
    try {
      const raw = await this.store.read(this.relPath(contactId))
      if (raw !== null) {
        loaded = this.parseRecord(raw, contactId, contactName)
        if (loaded === null) {
          this.logger.warn('memory: 记忆文件解析失败，已按空记忆处理', { contactId })
        }
      }
    } catch (error) {
      this.logger.warn('memory: 读取记忆失败，已按空记忆处理', {
        contactId,
        error: errorText(error),
      })
    }

    const record = loaded ?? this.emptyRecord(contactId, contactName)
    // 以调用方传入的 contactId 为准（文件本身就是按它的哈希定位的）。
    record.contactId = contactId
    this.cache.set(contactId, record)
    return record
  }

  /** 校验并规范化磁盘上的记录；无法解析时返回 null。 */
  private parseRecord(raw: string, contactId: string, contactName: string): MemoryRecord | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!isRecord(parsed)) return null

    const record = this.emptyRecord(contactId, contactName)
    record.contactId =
      typeof parsed.contactId === 'string' && parsed.contactId.length > 0
        ? parsed.contactId
        : contactId
    record.contactName =
      typeof parsed.contactName === 'string' ? parsed.contactName : record.contactName
    record.summary = typeof parsed.summary === 'string' ? parsed.summary : ''
    record.totalTurns = finiteInt(parsed.totalTurns, 0)

    if (Array.isArray(parsed.recent)) {
      for (const item of parsed.recent) {
        if (!isRecord(item)) continue
        const role = item.role === 'assistant' ? 'assistant' : 'user'
        const text = typeof item.text === 'string' ? item.text : ''
        const at = typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0
        record.recent.push({ role, text, at })
      }
      const keep = this.recentKeep()
      if (record.recent.length > keep) {
        record.recent.splice(0, record.recent.length - keep)
      }
    }

    if (Array.isArray(parsed.recentStickerIds)) {
      for (const id of parsed.recentStickerIds) {
        if (typeof id === 'string' && id.length > 0) record.recentStickerIds.push(id)
      }
      if (record.recentStickerIds.length > STICKER_HISTORY_KEEP) {
        record.recentStickerIds.splice(
          0,
          record.recentStickerIds.length - STICKER_HISTORY_KEEP,
        )
      }
    }

    record.updatedAt =
      typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : record.updatedAt

    if (isRecord(parsed.profile)) {
      const nickname = typeof parsed.profile.nickname === 'string' ? parsed.profile.nickname : ''
      const taboos = stringList(parsed.profile.taboos)
      const topics = stringList(parsed.profile.topics)
      if (nickname.trim() !== '' || taboos.length > 0 || topics.length > 0) {
        record.profile = {
          nickname: nickname.trim(),
          taboos,
          topics,
          updatedAt:
            typeof parsed.profile.updatedAt === 'number' && Number.isFinite(parsed.profile.updatedAt)
              ? parsed.profile.updatedAt
              : record.updatedAt,
        }
      }
    }
    return record
  }

  private clone(record: MemoryRecord): MemoryRecord {
    return {
      ...record,
      recent: record.recent.map((message) => ({ ...message })),
      recentStickerIds: [...record.recentStickerIds],
      profile: record.profile ? cloneProfile(record.profile) : undefined,
    }
  }

  /** 落盘失败不抛出（记忆是增强能力，不能拖垮引擎）。 */
  private async persist(record: MemoryRecord): Promise<void> {
    try {
      await this.store.writeJson(this.relPath(record.contactId), record)
    } catch (error) {
      this.logger.warn('memory: 记忆落盘失败', {
        contactId: record.contactId,
        error: errorText(error),
      })
    }
  }
}

/**
 * test/core 共用测试替身：
 * - MemoryStore：内存版 FileStoreLike（不碰磁盘）
 * - FakeLogger：捕获 warn/error，便于断言“损坏时 warn”
 * - SeqRandom：按给定序列返回随机数（用完后返回 fallback）
 * - FakeStickers：可控贴纸库，记录 pick 调用参数
 * - testConfig / inbound / atLocal：测试数据工厂
 */

import type {
  Emotion,
  FileStoreLike,
  InboundMessage,
  Logger,
  Random,
  StickerCatalogLike,
  StickerChoice,
} from '../../src/types.ts'
import { defaultConfig } from '../../src/config.ts'
import type { WechatPersonaConfig } from '../../src/config.ts'

/** 内存文件存储：按相对路径存字符串，行为与真实 store 对齐（不存在返回 null）。 */
export class MemoryStore implements FileStoreLike {
  readonly root = 'memory://test'
  readonly files = new Map<string, string>()

  private key(rel: string): string {
    return rel.replace(/\\/g, '/').replace(/^\.\//, '')
  }

  async read(rel: string): Promise<string | null> {
    return this.files.get(this.key(rel)) ?? null
  }

  async readJson<T>(rel: string): Promise<T | null> {
    const text = await this.read(rel)
    if (text === null) return null
    return JSON.parse(text) as T
  }

  async write(rel: string, text: string): Promise<void> {
    this.files.set(this.key(rel), text)
  }

  async writeJson(rel: string, value: unknown): Promise<void> {
    await this.write(rel, JSON.stringify(value, null, 2))
  }

  async append(rel: string, text: string): Promise<void> {
    const previous = (await this.read(rel)) ?? ''
    this.files.set(this.key(rel), previous + text)
  }

  async remove(rel: string): Promise<void> {
    this.files.delete(this.key(rel))
  }

  async removeTree(relDir: string): Promise<void> {
    const base = this.key(relDir).replace(/\/+$/, '')
    for (const path of [...this.files.keys()]) {
      if (path === base || path.startsWith(`${base}/`)) this.files.delete(path)
    }
  }

  async list(relDir: string): Promise<string[]> {
    const base = this.key(relDir).replace(/\/+$/, '')
    const prefix = base === '' ? '' : `${base}/`
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length))
  }

  /** 测试便捷方法：文件是否存在。 */
  has(rel: string): boolean {
    return this.files.has(this.key(rel))
  }
}

/** 捕获日志的假 Logger。 */
export class FakeLogger implements Logger {
  readonly entries: Array<{ level: 'debug' | 'info' | 'warn' | 'error'; message: string; extra?: unknown }> = []

  debug(message: string, extra?: unknown): void {
    this.entries.push({ level: 'debug', message, extra })
  }

  info(message: string, extra?: unknown): void {
    this.entries.push({ level: 'info', message, extra })
  }

  warn(message: string, extra?: unknown): void {
    this.entries.push({ level: 'warn', message, extra })
  }

  error(message: string, extra?: unknown): void {
    this.entries.push({ level: 'error', message, extra })
  }

  warnings(): string[] {
    return this.entries.filter((entry) => entry.level === 'warn').map((entry) => entry.message)
  }
}

/** 按给定序列返回随机数，用完后返回 fallback（默认 0.5）。 */
export class SeqRandom implements Random {
  private queue: number[] = []
  private fallbackValue = 0.5

  constructor(values: number[] = [], fallback = 0.5) {
    this.queue = [...values]
    this.fallbackValue = fallback
  }

  next(): number {
    const value = this.queue.shift()
    return value === undefined ? this.fallbackValue : value
  }
}

/** 可控贴纸库：pick 按分类过滤 recentIds；pickAny 在 anyChoices 里过滤。 */
export class FakeStickers implements StickerCatalogLike {
  readonly choices: StickerChoice[] = []
  readonly anyChoices: StickerChoice[] = []
  readonly pickCalls: Array<{ category: Emotion; recentIds: readonly string[] }> = []
  readonly anyCalls: Array<readonly string[]> = []

  constructor(choices: StickerChoice[] = [], anyChoices?: StickerChoice[]) {
    this.choices = [...choices]
    this.anyChoices = anyChoices ? [...anyChoices] : [...choices]
  }

  categories(): Emotion[] {
    return [...new Set(this.choices.map((choice) => choice.category))]
  }

  count(): number {
    return this.choices.length
  }

  pick(category: Emotion, recentIds: readonly string[]): StickerChoice | null {
    this.pickCalls.push({ category, recentIds: [...recentIds] })
    return this.choices.find((choice) => choice.category === category && !recentIds.includes(choice.id)) ?? null
  }

  pickAny(recentIds: readonly string[]): StickerChoice | null {
    this.anyCalls.push([...recentIds])
    return this.anyChoices.find((choice) => !recentIds.includes(choice.id)) ?? null
  }
}

/** 测试用 config：默认值 + 一个白名单联系人，可继续 mutate。 */
export function testConfig(mutate?: (config: WechatPersonaConfig) => void): WechatPersonaConfig {
  const config = defaultConfig()
  config.whitelist = [{ id: 'wxid_alice', name: '小爱', aliases: ['Alice'], note: '测试联系人' }]
  if (mutate) mutate(config)
  return config
}

/** 本地时间构造（避免测试假设时区）。 */
export function atLocal(year: number, monthIndex: number, day: number, hour: number, minute = 0): number {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime()
}

/** 2026-10-30（周五）20:00。 */
export const FRIDAY_EVENING = atLocal(2026, 9, 30, 20, 0)
/** 2026-10-26（周一）12:00。 */
export const MONDAY_NOON = atLocal(2026, 9, 26, 12, 0)

/** 构造一条入站私聊消息。 */
export function inbound(overrides: Partial<InboundMessage> = {}, now = FRIDAY_EVENING): InboundMessage {
  return {
    id: 'msg-1',
    contactId: 'wxid_alice',
    contactName: '小爱',
    chatType: 'single',
    kind: 'text',
    text: '在吗',
    receivedAt: now,
    ...overrides,
  }
}

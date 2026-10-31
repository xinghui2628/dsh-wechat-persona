/**
 * MemoryStore 单元测试。
 *
 * 用 mkdtemp 临时目录 + 自实现的最简 FsStore（把 FileStoreLike 映射到 node:fs），
 * 不依赖 host 的存储实现。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WechatPersonaConfig } from '../../src/config.ts'
import { defaultConfig } from '../../src/config.ts'
import { MemoryStore } from '../../src/core/memory.ts'
import type { Clock, FileStoreLike, Logger, MemoryMessage } from '../../src/types.ts'

/* ───────────────────────────── 测试替身 ───────────────────────────── */

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 把 FileStoreLike 直接映射到本机文件系统（root = 临时目录）。 */
class FsStore implements FileStoreLike {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  private abs(rel: string): string {
    return resolve(this.root, rel)
  }

  async read(rel: string): Promise<string | null> {
    try {
      return await readFile(this.abs(rel), 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async readJson<T>(rel: string): Promise<T | null> {
    const text = await this.read(rel)
    if (text === null) return null
    return JSON.parse(text) as T
  }

  async write(rel: string, text: string): Promise<void> {
    const abs = this.abs(rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }

  async writeJson(rel: string, value: unknown): Promise<void> {
    await this.write(rel, JSON.stringify(value, null, 2))
  }

  async append(rel: string, text: string): Promise<void> {
    const abs = this.abs(rel)
    await mkdir(dirname(abs), { recursive: true })
    await appendFile(abs, text, 'utf8')
  }

  async remove(rel: string): Promise<void> {
    try {
      await unlink(this.abs(rel))
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  async removeTree(relDir: string): Promise<void> {
    await rm(this.abs(relDir), { recursive: true, force: true })
  }

  async list(relDir: string): Promise<string[]> {
    try {
      return await readdir(this.abs(relDir))
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }
}

function makeClock(start = 1_700_000_000_000): { clock: Clock; setNow: (value: number) => void } {
  let current = start
  return {
    clock: {
      now: () => current,
      sleep: async () => {
        // 测试里不需要真的等待。
      },
    },
    setNow: (value: number) => {
      current = value
    },
  }
}

function makeLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warns.push(message)
    },
    error: () => {},
  }
  return { logger, warns }
}

function configWith(overrides: Partial<WechatPersonaConfig['memory']>): WechatPersonaConfig {
  const base = defaultConfig()
  return { ...base, memory: { ...base.memory, ...overrides } }
}

function msg(text: string, role: MemoryMessage['role'] = 'user', at = 0): MemoryMessage {
  return { role, text, at }
}

/* ───────────────────────────── 测试上下文 ───────────────────────────── */

const tempDirs: string[] = []

async function makeStore(config: WechatPersonaConfig = defaultConfig()): Promise<{
  root: string
  store: FsStore
  memory: MemoryStore
  clock: Clock
  setNow: (value: number) => void
  warns: string[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  tempDirs.push(root)
  const store = new FsStore(root)
  const { clock, setNow } = makeClock()
  const { logger, warns } = makeLogger()
  const memory = new MemoryStore({ store, config, clock, logger })
  return { root, store, memory, clock, setNow, warns }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/* ───────────────────────────── 用例 ───────────────────────────── */

describe('MemoryStore', () => {
  it('append 只保留最近 30 条，并维护 totalTurns / updatedAt / contactName', async () => {
    const { memory, setNow, store } = await makeStore()
    const base = 1_700_000_000_000
    for (let i = 0; i < 35; i += 1) {
      setNow(base + i)
      await memory.append('alice', 'Alice', msg(`m${i}`, 'user', base + i))
    }
    const record = await memory.get('alice', 'Alice')
    expect(record.version).toBe(1)
    expect(record.totalTurns).toBe(35)
    expect(record.recent).toHaveLength(30)
    expect(record.recent[0]?.text).toBe('m5')
    expect(record.recent[29]?.text).toBe('m34')
    expect(record.updatedAt).toBe(base + 34)
    expect(record.contactName).toBe('Alice')

    // recent(n) 取尾部，n<=0 返回空数组。
    expect((await memory.recent('alice', 'Alice', 3)).map((m) => m.text)).toEqual([
      'm32',
      'm33',
      'm34',
    ])
    expect(await memory.recent('alice', 'Alice', 0)).toEqual([])

    // 落盘文件内容与内存一致。
    const files = await store.list('memory')
    expect(files).toHaveLength(1)
    const raw = await store.read(`memory/${files[0]}`)
    expect(raw).not.toBeNull()
    const saved = JSON.parse(raw as string) as { recent: MemoryMessage[] }
    expect(saved.recent).toHaveLength(30)
  })

  it('get 返回克隆，调用方修改不会污染内部状态', async () => {
    const { memory } = await makeStore()
    await memory.append('bob', 'Bob', msg('hello'))
    const first = await memory.get('bob', 'Bob')
    first.recent[0]!.text = 'hacked'
    first.recentStickerIds.push('happy/001.png')
    const second = await memory.get('bob', 'Bob')
    expect(second.recent[0]?.text).toBe('hello')
    expect(second.recentStickerIds).toEqual([])
  })

  it('shouldSummarize 每 50 轮触发一次，autoSummary=false 时不触发', async () => {
    const { memory } = await makeStore()
    for (let i = 0; i < 49; i += 1) await memory.append('c49', 'C49', msg(`m${i}`))
    expect(await memory.shouldSummarize('c49', 'C49')).toBe(false)

    await memory.append('c49', 'C49', msg('m49'))
    expect(await memory.shouldSummarize('c49', 'C49')).toBe(true)

    // 另一个联系人 100 轮：第 100 轮也触发，第 99 轮不触发。
    for (let i = 0; i < 99; i += 1) await memory.append('c99', 'C99', msg(`m${i}`))
    expect(await memory.shouldSummarize('c99', 'C99')).toBe(false)

    // 0 轮不触发；关闭自动摘要后 50 轮也不触发。
    expect(await memory.shouldSummarize('empty', 'Empty')).toBe(false)
    const { memory: off } = await makeStore(configWith({ autoSummary: false }))
    for (let i = 0; i < 50; i += 1) await off.append('c50', 'C50', msg(`m${i}`))
    expect(await off.shouldSummarize('c50', 'C50')).toBe(false)
  })

  it('summaryEveryTurns<=0 时永不触发摘要', async () => {
    const { memory } = await makeStore(configWith({ summaryEveryTurns: 0, autoSummary: true }))
    await memory.append('x', 'X', msg('m'))
    expect(await memory.shouldSummarize('x', 'X')).toBe(false)
  })

  it('setSummary 按 maxSummaryChars 截断并持久化', async () => {
    const { memory, store } = await makeStore(configWith({ maxSummaryChars: 12 }))
    const long = '一二三四五六七八九十甲乙丙丁戊'
    await memory.setSummary('carol', 'Carol', long)
    expect(await memory.summaryOf('carol', 'Carol')).toBe(long.slice(0, 12))

    // 持久化后重载仍是截断值。
    const files = await store.list('memory')
    const raw = await store.read(`memory/${files[0]}`)
    const saved = JSON.parse(raw as string) as { summary: string }
    expect(saved.summary).toBe(long.slice(0, 12))
  })

  it('rememberSticker 只保留最近 20 个', async () => {
    const { memory } = await makeStore()
    for (let i = 0; i < 25; i += 1) await memory.rememberSticker('dave', 'Dave', `happy/${i}.png`)
    const ids = await memory.lastStickerIds('dave', 'Dave')
    expect(ids).toHaveLength(20)
    expect(ids[0]).toBe('happy/5.png')
    expect(ids[19]).toBe('happy/24.png')
    // 空 id 忽略。
    await memory.rememberSticker('dave', 'Dave', '')
    expect(await memory.lastStickerIds('dave', 'Dave')).toHaveLength(20)
  })

  it('clear(contactId) 只删一个，clear() 清空全部，listContacts 排序返回', async () => {
    const { memory, store } = await makeStore()
    await memory.append('alice', 'Alice', msg('a'))
    await memory.append('bob', 'Bob', msg('b'))
    expect(await memory.listContacts()).toEqual(['alice', 'bob'])
    expect((await store.list('memory')).length).toBe(2)

    await memory.clear('alice')
    expect(await memory.listContacts()).toEqual(['bob'])
    const fresh = await memory.get('alice', 'Alice')
    expect(fresh.totalTurns).toBe(0)
    expect(fresh.recent).toEqual([])
    // 删除不存在的联系人也不报错。
    await memory.clear('nobody')

    await memory.clear()
    expect(await memory.listContacts()).toEqual([])
    expect(await store.list('memory')).toEqual([])
  })

  it('持久化：用同一目录重建 MemoryStore 后仍能读到记忆', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
    tempDirs.push(root)
    const config = defaultConfig()
    const { clock } = makeClock()
    const { logger } = makeLogger()

    const first = new MemoryStore({ store: new FsStore(root), config, clock, logger })
    await first.append('erin', 'Erin', msg('早', 'user'))
    await first.append('erin', 'Erin', msg('早呀', 'assistant'))
    await first.setSummary('erin', 'Erin', '聊了聊早上的事')
    await first.rememberSticker('erin', 'Erin', 'happy/001.png')
    await first.flush()

    const second = new MemoryStore({ store: new FsStore(root), config, clock, logger })
    const record = await second.get('erin', 'Erin')
    expect(record.totalTurns).toBe(2)
    expect(record.recent.map((m) => m.text)).toEqual(['早', '早呀'])
    expect(record.recent.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(record.summary).toBe('聊了聊早上的事')
    expect(record.recentStickerIds).toEqual(['happy/001.png'])
    expect(record.updatedAt).toBeGreaterThan(0)
  })

  it('并发 append 串行执行，不丢消息', async () => {
    const { memory } = await makeStore()
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => memory.append('frank', 'Frank', msg(`c${i}`))),
    )
    await memory.flush()
    const record = await memory.get('frank', 'Frank')
    expect(record.totalTurns).toBe(10)
    expect(record.recent.map((m) => m.text).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `c${i}`).sort(),
    )
  })

  it('contactId 只以 sha1 前 16 位进入文件路径', async () => {
    const { memory, root, store } = await makeStore()
    const contactId = '../../evil/联系人:1'
    await memory.append(contactId, 'Evil', msg('hi'))
    const hash = createHash('sha1').update(contactId, 'utf8').digest('hex').slice(0, 16)
    expect(await store.list('memory')).toEqual([`${hash}.json`])
    // 临时目录根下只有 memory/，没有被路径穿越写出的其它文件。
    expect(await readdir(root)).toEqual(['memory'])
    expect(await memory.listContacts()).toEqual([contactId])
  })

  it('损坏的记忆文件按空记忆处理并告警，后续 append 可正常覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
    tempDirs.push(root)
    const config = defaultConfig()
    const { clock } = makeClock()
    const { logger, warns } = makeLogger()
    const hash = createHash('sha1').update('bad', 'utf8').digest('hex').slice(0, 16)
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(join(root, 'memory', `${hash}.json`), '{this is not json', 'utf8')

    const memory = new MemoryStore({ store: new FsStore(root), config, clock, logger })
    const record = await memory.get('bad', 'Bad')
    expect(record.totalTurns).toBe(0)
    expect(record.recent).toEqual([])
    expect(warns.length).toBeGreaterThanOrEqual(1)

    await memory.append('bad', 'Bad', msg('恢复'))
    expect((await memory.get('bad', 'Bad')).recent[0]?.text).toBe('恢复')
  })
})

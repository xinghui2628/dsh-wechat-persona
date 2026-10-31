/**
 * StickerCatalog 单元测试。
 *
 * 用 mkdtemp 临时目录造出表情包树：6 类情绪目录（部分为空）、合法/非法扩展名、
 * 根目录散图、分类内子目录，验证扫描、分类顺序、排除最近使用与兜底选择。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMOTION_ORDER, StickerCatalog } from '../../src/core/stickers.ts'
import type { Logger, Random } from '../../src/types.ts'

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

function makeRandom(initial = 0): { random: Random; set: (value: number) => void } {
  let value = initial
  return {
    random: { next: () => value },
    set: (next: number) => {
      value = next
    },
  }
}

const tempDirs: string[] = []

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stickers-'))
  tempDirs.push(root)
  const files = [
    'happy/001.png',
    'happy/002.png',
    'happy/003.png',
    'shy/001.gif',
    'comfort/001.webp',
    'neutral/001.PNG',
    'curious/note.txt',
  ]
  for (const rel of files) {
    const abs = join(root, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, Buffer.from([1, 2, 3, 4]))
  }
  await mkdir(join(root, 'playful'), { recursive: true })
  await mkdir(join(root, 'happy', 'nested'), { recursive: true })
  await writeFile(join(root, 'happy', 'nested', 'ignored.png'), Buffer.from([9]))
  await writeFile(join(root, 'loose.png'), Buffer.from([9]))
  return root
}

function catalogFor(
  dir: string,
  random: Random,
  logger: Logger,
): StickerCatalog {
  return new StickerCatalog({ dir, random, logger })
}

const ALL_FIXTURE_IDS = [
  'happy/001.png',
  'happy/002.png',
  'happy/003.png',
  'shy/001.gif',
  'comfort/001.webp',
  'neutral/001.PNG',
]

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('StickerCatalog', () => {
  it('load 后统计数量、固定顺序分类并生成绝对路径', async () => {
    const root = await makeTree()
    const { logger } = makeLogger()
    const { random } = makeRandom()
    const catalog = catalogFor(root, random, logger)
    await catalog.load()

    // 只算 6 个合法图片：空目录/非图片/子目录/根目录散图都不计入。
    expect(catalog.count()).toBe(6)
    expect(catalog.categories()).toEqual(['happy', 'shy', 'comfort', 'neutral'])
    expect(EMOTION_ORDER).toEqual([
      'happy',
      'playful',
      'shy',
      'comfort',
      'curious',
      'neutral',
    ])

    const choice = catalog.pick('happy', [])
    expect(choice).not.toBeNull()
    expect(choice!.id).toBe('happy/001.png')
    expect(choice!.category).toBe('happy')
    expect(isAbsolute(choice!.file)).toBe(true)
    expect(choice!.file).toBe(resolve(root, 'happy', '001.png'))
  })

  it('pick 排除 recentIds，无候选或分类为空时返回 null', async () => {
    const root = await makeTree()
    const { logger } = makeLogger()
    const { random, set } = makeRandom(0)
    const catalog = catalogFor(root, random, logger)
    await catalog.load()

    expect(catalog.pick('happy', [] )!.id).toBe('happy/001.png')
    expect(catalog.pick('happy', ['happy/001.png'])!.id).toBe('happy/002.png')
    expect(catalog.pick('happy', ['happy/001.png', 'happy/002.png'])!.id).toBe('happy/003.png')
    expect(catalog.pick('happy', ALL_FIXTURE_IDS)).toBeNull()

    // 空分类 / 只有非图片的分类 / 不存在的分类目录。
    expect(catalog.pick('playful', [])).toBeNull()
    expect(catalog.pick('curious', [])).toBeNull()

    // 随机值越界（1）时夹到最后一个候选，不越界。
    set(1)
    expect(catalog.pick('happy', ['happy/001.png', 'happy/002.png'])!.id).toBe('happy/003.png')

    // 随机值为 0.999... 时落在最后一个。
    set(0.999999)
    expect(catalog.pick('happy', [])!.id).toBe('happy/003.png')
  })

  it('pickAny 跨分类兜底并同样排除 recentIds', async () => {
    const root = await makeTree()
    const { logger } = makeLogger()
    const { random } = makeRandom(0)
    const catalog = catalogFor(root, random, logger)
    await catalog.load()

    expect(catalog.pickAny([])!.id).toBe('happy/001.png')
    expect(catalog.pickAny(ALL_FIXTURE_IDS)).toBeNull()

    // 排除 happy 全部之后，仍能从其它分类里挑到。
    const choice = catalog.pickAny(['happy/001.png', 'happy/002.png', 'happy/003.png'])
    expect(choice).not.toBeNull()
    expect(choice!.category).not.toBe('happy')
    expect(choice!.id).not.toMatch(/^happy\//u)
  })

  it('目录不存在时 load 不抛异常，按空目录处理', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-stickers-'))
    tempDirs.push(base)
    const dir = join(base, 'not-exist')
    const { logger, warns } = makeLogger()
    const { random } = makeRandom()
    const catalog = catalogFor(dir, random, logger)
    await expect(catalog.load()).resolves.toBeUndefined()
    expect(catalog.count()).toBe(0)
    expect(catalog.categories()).toEqual([])
    expect(catalog.pick('happy', [])).toBeNull()
    expect(catalog.pickAny([])).toBeNull()
    expect(warns).toHaveLength(1)
  })

  it('重复 load 幂等，并能感知新增文件', async () => {
    const root = await makeTree()
    const { logger } = makeLogger()
    const { random } = makeRandom()
    const catalog = catalogFor(root, random, logger)
    await catalog.load()
    expect(catalog.count()).toBe(6)

    await catalog.load()
    expect(catalog.count()).toBe(6)
    expect(catalog.categories()).toEqual(['happy', 'shy', 'comfort', 'neutral'])

    await writeFile(join(root, 'happy', '004.png'), Buffer.from([5]))
    await catalog.load()
    expect(catalog.count()).toBe(7)
    expect(catalog.pick('happy', ['happy/001.png', 'happy/002.png', 'happy/003.png'])!.id).toBe(
      'happy/004.png',
    )
  })
})

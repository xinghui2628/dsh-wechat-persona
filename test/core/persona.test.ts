/**
 * loadPersona / parseExamples 单元测试。
 *
 * 覆盖：正常解析、全角/半角冒号与别名、缺失文件兜底、空文件、解析失败、
 * name 归一化，以及“绝不抛异常 + 只 warn 一次”的契约。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPersona, parseExamples } from '../../src/core/persona.ts'
import type { Logger } from '../../src/types.ts'

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

const tempDirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-persona-'))
  tempDirs.push(dir)
  return dir
}

async function writePersonaFiles(
  dir: string,
  persona: string,
  examples: string,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'persona.md'), persona, 'utf8')
  await writeFile(join(dir, 'examples.md'), examples, 'utf8')
}

const VALID_EXAMPLES = [
  '### 例1',
  '用户：在吗？',
  '小号：在，咋了',
  '',
  '### 例2',
  '对方: 今天好累',
  '你: 早点睡吧',
  '',
  '### 例3',
  '**用户**：你是AI吗',
  '**小号**：哈哈，不是',
  '',
].join('\n')

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parseExamples', () => {
  it('解析标准样例块，容忍全角/半角冒号、别名与加粗标签', () => {
    const examples = parseExamples(VALID_EXAMPLES)
    expect(examples).toHaveLength(3)
    expect(examples[0]).toEqual({ user: '在吗？', assistant: '在，咋了' })
    expect(examples[1]).toEqual({ user: '今天好累', assistant: '早点睡吧' })
    expect(examples[2]).toEqual({ user: '你是AI吗', assistant: '哈哈，不是' })
  })

  it('跳过说明文字与不完整样例，标签行后的正文作为续行', () => {
    const text = [
      '# 样例',
      '',
      '这里是一段说明文字，不应该进样例。',
      '',
      '### 例1',
      '用户：',
      '今天好累',
      '小号：早点睡吧',
      '',
      '### 例2',
      '用户：只有我问问题',
      '',
    ].join('\n')
    const examples = parseExamples(text)
    expect(examples).toHaveLength(1)
    expect(examples[0]).toEqual({ user: '今天好累', assistant: '早点睡吧' })
  })

  it('空文本返回空数组', () => {
    expect(parseExamples('')).toEqual([])
    expect(parseExamples('   \n\n  ')).toEqual([])
    expect(parseExamples('# 只有标题')).toEqual([])
  })
})

describe('loadPersona', () => {
  it('正常读取 persona.md 与 examples.md', async () => {
    const dir = await makeDir()
    await writePersonaFiles(dir, '# 测试人格\n\n你是小号，说话很短。', VALID_EXAMPLES)
    const { logger, warns } = makeLogger()
    const pack = await loadPersona({ dir, name: '小号', logger })
    expect(pack.systemPrompt).toContain('测试人格')
    expect(pack.systemPrompt).toContain('说话很短')
    expect(pack.examples).toHaveLength(3)
    expect(pack.name).toBe('小号')
    expect(pack.sourceDir).toBe(dir)
    expect(warns).toEqual([])
  })

  it('目录缺失时回落到内置人格，绝不抛异常且只 warn 一次', async () => {
    const dir = join(await makeDir(), 'not-exist')
    const { logger, warns } = makeLogger()
    const pack = await loadPersona({ dir, name: '', logger })
    expect(pack.systemPrompt.length).toBeGreaterThan(0)
    expect(pack.systemPrompt).toContain('小号')
    expect(pack.examples.length).toBeGreaterThanOrEqual(5)
    expect(pack.name).toBe('小号')
    expect(pack.sourceDir).toBe(dir)
    expect(warns).toHaveLength(1)
  })

  it('persona.md 为空时只回落到兜底系统提示词，样例仍用磁盘内容', async () => {
    const dir = await makeDir()
    await writePersonaFiles(dir, '  \n\n', VALID_EXAMPLES)
    const { logger, warns } = makeLogger()
    const pack = await loadPersona({ dir, name: '小号', logger })
    expect(pack.systemPrompt).toContain('小号')
    expect(pack.systemPrompt).toContain('如实说是 AI')
    expect(pack.examples).toHaveLength(3)
    expect(warns).toHaveLength(1)
  })

  it('examples.md 解析不到样例时使用兜底样例并告警一次', async () => {
    const dir = await makeDir()
    await writePersonaFiles(dir, '# 我的小号\n说话要短。', '这里没有任何样例格式')
    const { logger, warns } = makeLogger()
    const pack = await loadPersona({ dir, name: '小号', logger })
    expect(pack.systemPrompt).toContain('我的小号')
    expect(pack.examples.length).toBeGreaterThanOrEqual(5)
    expect(pack.examples[0]).toHaveProperty('user')
    expect(pack.examples[0]).toHaveProperty('assistant')
    expect(warns).toHaveLength(1)
  })

  it('文件不可读（同名目录）也不抛异常，落回兜底', async () => {
    const dir = await makeDir()
    await mkdir(join(dir, 'persona.md'), { recursive: true })
    await writeFile(join(dir, 'examples.md'), '### 例1\n用户：在吗\n小号：在', 'utf8')
    const { logger, warns } = makeLogger()
    const pack = await loadPersona({ dir, name: '小号', logger })
    expect(pack.systemPrompt).toContain('小号')
    expect(pack.examples).toEqual([{ user: '在吗', assistant: '在' }])
    expect(warns).toHaveLength(1)
  })

  it('自定义人格名保留，sourceDir 指向传入目录', async () => {
    const dir = await makeDir()
    await writePersonaFiles(dir, '# 阿豪\n说话像哥们。', VALID_EXAMPLES)
    const { logger } = makeLogger()
    const pack = await loadPersona({ dir, name: ' 阿豪 ', logger })
    expect(pack.name).toBe('阿豪')
    expect(pack.sourceDir).toBe(dir)
  })
})

/**
 * 基于 node:fs 的 FileStoreLike 实现（数据目录内所有读写都经过它）。
 *
 * 安全 / 稳定性：
 * - 所有相对路径先 normalize，禁止 `..` 越出数据目录；
 * - 写文件用「临时文件 + rename」原子替换，避免进程崩溃留下半截 JSON；
 * - 同一路径的写/追加串行化（内部 promise 链），避免并发覆盖。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileStoreLike } from '../types.ts'

function safeRelative(rel: string): string {
  const normalized = path.normalize(rel).replace(/^([/\\])+/, '')
  if (normalized === '..' || normalized.startsWith('..' + path.sep) || path.isAbsolute(normalized)) {
    throw new Error(`路径越界: ${rel}`)
  }
  return normalized
}

export class FsStore implements FileStoreLike {
  readonly root: string
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  private abs(rel: string): string {
    return path.join(this.root, safeRelative(rel))
  }

  /** 确保数据目录存在（幂等）。 */
  async ensure(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
  }

  async read(rel: string): Promise<string | null> {
    try {
      return await fs.readFile(this.abs(rel), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async readJson<T>(rel: string): Promise<T | null> {
    const text = await this.read(rel)
    if (text === null || text.trim() === '') return null
    return JSON.parse(text) as T
  }

  private withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    // 保留在链上以便后续操作排队；失败不影响后续任务。
    this.locks.set(key, next.catch(() => undefined))
    return next
  }

  async write(rel: string, text: string): Promise<void> {
    const target = this.abs(rel)
    await this.withLock(target, async () => {
      await fs.mkdir(path.dirname(target), { recursive: true })
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
      await fs.writeFile(tmp, text, 'utf8')
      await fs.rename(tmp, target)
    })
  }

  async writeJson(rel: string, value: unknown): Promise<void> {
    await this.write(rel, JSON.stringify(value, null, 2) + '\n')
  }

  async append(rel: string, text: string): Promise<void> {
    const target = this.abs(rel)
    await this.withLock(target, async () => {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.appendFile(target, text, 'utf8')
    })
  }

  async remove(rel: string): Promise<void> {
    await fs.rm(this.abs(rel), { force: true })
  }

  async removeTree(relDir: string): Promise<void> {
    await fs.rm(this.abs(relDir), { recursive: true, force: true })
  }

  async list(relDir: string): Promise<string[]> {
    try {
      return await fs.readdir(this.abs(relDir))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }
}

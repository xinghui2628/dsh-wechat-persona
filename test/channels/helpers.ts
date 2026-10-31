import { readFileSync } from 'node:fs'

import { defaultConfig, type WechatPersonaConfig } from '../../src/config.ts'
import type { ChannelDeps, Clock, FileStoreLike, Logger } from '../../src/types.ts'

/**
 * test/channels 公共测试基建：
 * - FakeClock：完全由测试推进的时钟，避免真实 sleep
 * - MemoryFileStore：内存版 FileStoreLike（相对路径语义与 dataDir 一致）
 * - TestLogger：收集日志供断言
 * - waitFor：轮询等待异步状态（真实宏任务，超时抛错）
 */

interface SleepEntry {
  due: number
  resolve: () => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

async function flushMacrotasks(rounds: number): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

export class FakeClock implements Clock {
  readonly startTime: number
  private time: number
  private readonly entries: SleepEntry[] = []

  constructor(start = 1_700_000_000_000) {
    this.startTime = start
    this.time = start
  }

  now(): number {
    return this.time
  }

  /** 当前挂起的 sleep 数量（含被 abort 清理前）。 */
  get pendingTimers(): number {
    return this.entries.length
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'))
    const delay = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0
    return new Promise<void>((resolve, reject) => {
      const entry: SleepEntry = { due: this.time + delay, resolve, reject, signal }
      if (signal) {
        entry.onAbort = () => {
          const index = this.entries.indexOf(entry)
          if (index >= 0) this.entries.splice(index, 1)
          reject(new Error('aborted'))
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.entries.push(entry)
    })
  }

  /** 推进时间；到期 sleep 依次 resolve，并让宏任务跑完。 */
  async advance(ms: number): Promise<void> {
    this.time += Math.max(0, Math.floor(ms))
    await flushMacrotasks(3)
    const due = this.entries.filter((entry) => entry.due <= this.time)
    for (const entry of due) {
      const index = this.entries.indexOf(entry)
      if (index >= 0) this.entries.splice(index, 1)
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
      entry.resolve()
    }
    await flushMacrotasks(5)
  }

  /** 仅让异步任务跑几轮，不推进时间。 */
  async flush(): Promise<void> {
    await flushMacrotasks(5)
  }
}

function normalizeRelPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return normalized === '.' ? '' : normalized
}

/** 内存版 FileStoreLike：所有文件放在一个 Map 里，不碰真实磁盘。 */
export class MemoryFileStore implements FileStoreLike {
  readonly root: string
  private readonly files = new Map<string, string>()

  constructor(root = 'C:/memory-store') {
    this.root = root
  }

  async read(relPath: string): Promise<string | null> {
    return this.files.get(normalizeRelPath(relPath)) ?? null
  }

  async readJson<T>(relPath: string): Promise<T | null> {
    const raw = await this.read(relPath)
    if (raw === null) return null
    return JSON.parse(raw) as T
  }

  async write(relPath: string, text: string): Promise<void> {
    this.files.set(normalizeRelPath(relPath), text)
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    await this.write(relPath, JSON.stringify(value, null, 2))
  }

  async append(relPath: string, text: string): Promise<void> {
    const key = normalizeRelPath(relPath)
    this.files.set(key, (this.files.get(key) ?? '') + text)
  }

  async remove(relPath: string): Promise<void> {
    this.files.delete(normalizeRelPath(relPath))
  }

  async removeTree(relDir: string): Promise<void> {
    const key = normalizeRelPath(relDir)
    const prefix = key ? `${key}/` : ''
    for (const file of [...this.files.keys()]) {
      if (key === '' || file === key || file.startsWith(prefix)) this.files.delete(file)
    }
  }

  async list(relDir: string): Promise<string[]> {
    const key = normalizeRelPath(relDir)
    const prefix = key ? `${key}/` : ''
    const children = new Set<string>()
    for (const file of this.files.keys()) {
      if (!key) {
        children.add(file.split('/')[0] ?? file)
        continue
      }
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      children.add(rest.split('/')[0] ?? rest)
    }
    return [...children]
  }

  /** 断言辅助：取原始文本。 */
  text(relPath: string): string | null {
    return this.files.get(normalizeRelPath(relPath)) ?? null
  }

  snapshot(): Map<string, string> {
    return new Map(this.files)
  }
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  extra?: unknown
}

export class TestLogger implements Logger {
  readonly entries: LogEntry[] = []

  debug(message: string, extra?: unknown): void {
    this.push('debug', message, extra)
  }

  info(message: string, extra?: unknown): void {
    this.push('info', message, extra)
  }

  warn(message: string, extra?: unknown): void {
    this.push('warn', message, extra)
  }

  error(message: string, extra?: unknown): void {
    this.push('error', message, extra)
  }

  private push(level: LogEntry['level'], message: string, extra?: unknown): void {
    this.entries.push({ level, message, extra })
  }

  text(): string {
    return this.entries.map((entry) => `[${entry.level}] ${entry.message}`).join('\n')
  }

  has(level: LogEntry['level'], fragment: string): boolean {
    return this.entries.some((entry) => entry.level === level && entry.message.includes(fragment))
  }
}

export interface TestDeps extends ChannelDeps {
  clock: FakeClock
  logger: TestLogger
  store: MemoryFileStore
}

export function makeDeps(store: MemoryFileStore = new MemoryFileStore()): TestDeps {
  return {
    clock: new FakeClock(),
    logger: new TestLogger(),
    store,
  }
}

/** defaultConfig() 的浅改辅助；schema 默认值都在。 */
export function makeConfig(overrides: (config: WechatPersonaConfig) => void = () => {}): WechatPersonaConfig {
  const config = defaultConfig()
  overrides(config)
  return config
}

/** 等待条件成立；失败时抛出带 label 的错误，避免测试静默卡死。 */
export async function waitFor<T>(
  probe: () => T | null | undefined | false,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2_000
  const intervalMs = options.intervalMs ?? 5
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== null && value !== undefined && value !== false) return value as T
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时${options.label ? `：${options.label}` : ''}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** 读取 test/fixtures/ 下的夹具文本。 */
export function readFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
}

/** 真实等待（仅 windows-vm 这类依赖真实 socket 的测试用）。 */
export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

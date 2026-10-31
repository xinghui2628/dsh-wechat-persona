/**
 * 运行时状态：state.json 的创建 / 读取（缺字段补默认、损坏回退）/ 串行保存。
 *
 * 状态结构见 types.ts 的 RuntimeState；这里只做“把任意 JSON 归一化成合法
 * RuntimeState”和“串行落盘”，不做业务判断。损坏时落回默认并 warn，
 * 保证插件重启永远不会因为一份坏 JSON 起不来。
 */

import type {
  BreakerState,
  BudgetState,
  FileStoreLike,
  RateCounter,
  RuntimeState,
  StatsState,
} from '../types.ts'
import { dayKey } from '../util/time.ts'

/** 状态文件名（FileStoreLike 内的相对路径）。 */
const STATE_FILE = 'state.json'
/** 内存中保留的去重指纹上限（与 gate 一致，防止脏数据把内存撑爆）。 */
const SEEN_MAX = 2000

/** 任意输入 -> 有限数，非法返回 fallback。 */
function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 任意输入 -> 非负整数。 */
function nonNegativeInt(value: unknown): number {
  return Math.max(0, Math.trunc(finiteNumber(value, 0)))
}

/** 任意输入 -> 可选时间戳（>0 的有限数）。 */
function optionalTimestamp(value: unknown): number | undefined {
  const num = finiteNumber(value, Number.NaN)
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : undefined
}

/** 是否普通对象（排除 null/数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 创建初始状态（首次运行 / 状态损坏时使用）。 */
export function createInitialState(now: number): RuntimeState {
  const at = finiteNumber(now, Date.now())
  const today = dayKey(at)
  return {
    version: 1,
    paused: false,
    breaker: { tripped: false },
    budget: { dayKey: today, spentTokens: 0 },
    rate: {},
    seen: {},
    stats: {
      llmCalls: 0,
      llmTokens: 0,
      drafts: 0,
      sends: 0,
      skips: 0,
      errors: 0,
      searchDayKey: today,
      searchDayCount: 0,
      searches: 0,
      summaryDayKey: today,
      summaryCalls: 0,
      startedAt: at,
    },
  }
}

/** 归一化单个频控计数器。 */
function normalizeRateCounter(value: unknown, now: number): RateCounter | null {
  if (!isPlainObject(value)) return null
  return {
    hourKey: typeof value.hourKey === 'string' ? value.hourKey : '',
    hourCount: nonNegativeInt(value.hourCount),
    dayKey: typeof value.dayKey === 'string' ? value.dayKey : '',
    dayCount: nonNegativeInt(value.dayCount),
    lastReplyAt: nonNegativeInt(value.lastReplyAt),
  }
}

/** 归一化 breaker。 */
function normalizeBreaker(value: unknown): BreakerState {
  if (!isPlainObject(value)) return { tripped: false }
  const tripped = value.tripped === true
  const reason = typeof value.reason === 'string' && value.reason !== '' ? value.reason : undefined
  const at = optionalTimestamp(value.at)
  return tripped ? { tripped: true, reason, at } : { tripped: false }
}

/** 归一化 budget（保留旧 dayKey，跨日清零交给 normalizeBudget/budgetPhase）。 */
function normalizeBudgetState(value: unknown, today: string): BudgetState {
  if (!isPlainObject(value)) return { dayKey: today, spentTokens: 0 }
  return {
    dayKey: typeof value.dayKey === 'string' && value.dayKey !== '' ? value.dayKey : today,
    spentTokens: nonNegativeInt(value.spentTokens),
  }
}

/** 归一化 stats（缺字段补 0，日期键缺失用今天）。 */
function normalizeStats(value: unknown, today: string, fallbackStartedAt: number): StatsState {
  const raw = isPlainObject(value) ? value : {}
  return {
    llmCalls: nonNegativeInt(raw.llmCalls),
    llmTokens: nonNegativeInt(raw.llmTokens),
    drafts: nonNegativeInt(raw.drafts),
    sends: nonNegativeInt(raw.sends),
    skips: nonNegativeInt(raw.skips),
    errors: nonNegativeInt(raw.errors),
    searchDayKey: typeof raw.searchDayKey === 'string' && raw.searchDayKey !== '' ? raw.searchDayKey : today,
    searchDayCount: nonNegativeInt(raw.searchDayCount),
    searches: nonNegativeInt(raw.searches),
    summaryDayKey: typeof raw.summaryDayKey === 'string' && raw.summaryDayKey !== '' ? raw.summaryDayKey : today,
    summaryCalls: nonNegativeInt(raw.summaryCalls),
    startedAt: optionalTimestamp(raw.startedAt) ?? fallbackStartedAt,
  }
}

/** 归一化去重指纹：只保留合法时间戳，最多 SEEN_MAX 条（保留最新的）。 */
function normalizeSeen(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) return {}
  const entries: Array<[string, number]> = []
  for (const [fingerprint, timestamp] of Object.entries(value)) {
    if (fingerprint === '') continue
    const ts = optionalTimestamp(timestamp)
    if (ts !== undefined) entries.push([fingerprint, ts])
  }
  if (entries.length > SEEN_MAX) {
    entries.sort((a, b) => a[1] - b[1])
    entries.splice(0, entries.length - SEEN_MAX)
  }
  return Object.fromEntries(entries)
}

/** 把磁盘上读到的任意 JSON 归一化成合法 RuntimeState。 */
function normalizeState(raw: Record<string, unknown>, now: number): RuntimeState {
  const base = createInitialState(now)
  const today = dayKey(now)
  const paused = raw.paused === true
  const pausedAt = paused ? optionalTimestamp(raw.pausedAt) : undefined
  const pauseReason = paused && typeof raw.pauseReason === 'string' && raw.pauseReason !== '' ? raw.pauseReason : undefined

  const rate: Record<string, RateCounter> = {}
  if (isPlainObject(raw.rate)) {
    for (const [contactId, counter] of Object.entries(raw.rate)) {
      if (contactId === '') continue
      const normalized = normalizeRateCounter(counter, now)
      if (normalized) rate[contactId] = normalized
    }
  }

  return {
    version: 1,
    paused,
    pauseReason,
    pausedAt,
    breaker: normalizeBreaker(raw.breaker),
    budget: normalizeBudgetState(raw.budget, today),
    rate,
    seen: normalizeSeen(raw.seen),
    stats: normalizeStats(raw.stats, today, base.stats.startedAt),
    lastActivityAt: optionalTimestamp(raw.lastActivityAt),
  }
}

/**
 * 状态管理器：load/save 都走 FileStoreLike；save 在模块内串行执行，
 * 后一次 save 的入参快照在调用时确定（避免同一 tick 内多次 save 交错写坏）。
 */
export class StateManager {
  private readonly store: FileStoreLike
  private queue: Promise<void> = Promise.resolve()

  constructor(store: FileStoreLike) {
    this.store = store
  }

  /** 读取 state.json；不存在返回初始状态；损坏时 warn 并回退初始状态。 */
  async load(now: number): Promise<RuntimeState> {
    let raw: unknown = null
    try {
      raw = await this.store.readJson<unknown>(STATE_FILE)
    } catch (error) {
      this.warn('state.json 读取失败，已回退默认状态', error)
      return createInitialState(now)
    }
    if (raw === null || raw === undefined) return createInitialState(now)
    if (!isPlainObject(raw)) {
      this.warn('state.json 内容损坏（不是对象），已回退默认状态', raw)
      return createInitialState(now)
    }
    return normalizeState(raw, now)
  }

  /**
   * 保存状态（原子性由 FileStoreLike.writeJson 的实现保证；本层保证串行）。
   * 返回的 promise 在本次写入落盘后 resolve，失败会 reject（由 engine persist 兜底）。
   */
  save(state: RuntimeState): Promise<void> {
    const snapshot = state
    const run = this.queue.then(() => this.store.writeJson(STATE_FILE, snapshot))
    this.queue = run.catch(() => undefined)
    return run
  }

  private warn(message: string, error: unknown): void {
    // StateManager 只有 store 依赖（无 logger 注入），这里用 console.warn 兜底
    try {
      console.warn(`[dsh-wechat-persona] ${message}`, error instanceof Error ? error.message : error)
    } catch {
      // 极端环境没有 console 时忽略
    }
  }
}

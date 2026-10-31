/**
 * 频控：每联系人每小时 / 每日 / 低活跃日 / 最小回复间隔。
 *
 * 计数器用“小时键 / 日键”滚动：键不一致就清零，不依赖定时器或外部时钟。
 * 纯本地 0 token，任何非法配置数值都会被 clamp 成安全值（不会因配置为 0
 * 或负数导致“永不放行”或“无限放行”）。
 */

import type { Decision, RateCounter } from '../types.ts'
import type { WechatPersonaConfig } from '../config.ts'
import { dayKey, hourKey } from '../util/time.ts'

/** 把任意输入转成 >= 0 的整数，非法/非有限值用 fallback。 */
function toNonNegativeInt(value: unknown, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Number.isFinite(num) ? Math.max(0, num) : 0
}

/**
 * 频控上限的防御性 clamp：非法值用 fallback，负数/0 至少 clamp 到 1。
 * 语义选择：宁可“配置写错时少拦一点”，也不能因为一个 0 让分身永久不回复。
 */
function toLimit(value: unknown, fallback: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  const fallbackValue = Number.isFinite(fallback) ? Math.trunc(fallback) : 1
  return Math.max(1, Number.isFinite(raw) ? raw : fallbackValue)
}

/** 空计数器：键取当前时间，计数从 0 开始。 */
function emptyCounter(now: number): RateCounter {
  return { hourKey: hourKey(now), hourCount: 0, dayKey: dayKey(now), dayCount: 0, lastReplyAt: 0 }
}

/**
 * 规范化计数器：小时/日键滚动时对应计数清零；缺失字段补默认值。
 * 返回新对象，不修改入参。
 */
export function normalizeCounter(counter: RateCounter | undefined, now: number): RateCounter {
  const currentHour = hourKey(now)
  const currentDay = dayKey(now)
  if (!counter || typeof counter !== 'object') return emptyCounter(now)
  const dayRolled = typeof counter.dayKey !== 'string' || counter.dayKey !== currentDay
  const hourRolled = typeof counter.hourKey !== 'string' || counter.hourKey !== currentHour
  return {
    hourKey: currentHour,
    hourCount: hourRolled ? 0 : toNonNegativeInt(counter.hourCount, 0),
    dayKey: currentDay,
    dayCount: dayRolled ? 0 : toNonNegativeInt(counter.dayCount, 0),
    lastReplyAt: toNonNegativeInt(counter.lastReplyAt, 0),
  }
}

/**
 * 频控检查（只读，不修改计数器）。
 *
 * 优先级（先命中先返回）：
 * 1. 低活跃日每日上限 -> 'low-activity-day-limit'
 * 2. 每小时上限      -> 'rate-hour-limit'
 * 3. 每日上限        -> 'rate-day-limit'
 * 4. 最小回复间隔    -> 'rate-interval'
 */
export function checkRate(
  config: WechatPersonaConfig,
  counter: RateCounter | undefined,
  now: number,
  lowActivityDay: boolean,
): Decision {
  const normalized = normalizeCounter(counter, now)
  const limits = config?.rateLimit
  const perHour = toLimit(limits?.perContactPerHour, 10)
  const perDay = toLimit(limits?.perContactPerDay, 60)
  const minIntervalSec = toLimit(limits?.minReplyIntervalSec, 30)
  const lowActivityLimit = toLimit(limits?.lowActivityDailyLimit, 5)

  if (lowActivityDay && normalized.dayCount >= lowActivityLimit) {
    return {
      skip: true,
      reason: 'low-activity-day-limit',
      detail: `低活跃日每日上限 ${lowActivityLimit} 条（今日已 ${normalized.dayCount} 条）`,
    }
  }
  if (normalized.hourCount >= perHour) {
    return {
      skip: true,
      reason: 'rate-hour-limit',
      detail: `每小时上限 ${perHour} 条（本小时已 ${normalized.hourCount} 条）`,
    }
  }
  if (normalized.dayCount >= perDay) {
    return {
      skip: true,
      reason: 'rate-day-limit',
      detail: `每日上限 ${perDay} 条（今日已 ${normalized.dayCount} 条）`,
    }
  }
  if (minIntervalSec > 0 && normalized.lastReplyAt > 0) {
    const elapsedMs = now - normalized.lastReplyAt
    if (elapsedMs < minIntervalSec * 1000) {
      const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000))
      return {
        skip: true,
        reason: 'rate-interval',
        detail: `距上次回复 ${elapsedSec}s，小于最小间隔 ${minIntervalSec}s`,
      }
    }
  }
  return { skip: false }
}

/**
 * 记录“已回复一条”：对应计数器 +1，并更新 lastReplyAt。
 * 返回新对象，不修改入参；跨小时/跨日由 normalizeCounter 处理。
 */
export function recordReply(counter: RateCounter, now: number): RateCounter {
  const normalized = normalizeCounter(counter, now)
  return {
    ...normalized,
    hourCount: normalized.hourCount + 1,
    dayCount: normalized.dayCount + 1,
    lastReplyAt: Number.isFinite(now) ? now : 0,
  }
}

/**
 * 作息表：判断当前是否“在线时段”以及今天是否“低活跃日”。
 *
 * 纯本地 0 token；被 gate（免打扰过滤）和 engine（状态展示）共用。
 * 第二轮迭代：支持工作日 / 周末分别配置，并提供“下次上线时间”用于设置页倒计时。
 */

import type { WechatPersonaConfig } from '../config.ts'
import { isWithinWindow, parseHhMm, weekdayIndex } from '../util/time.ts'

/** 作息检查结果。 */
export interface ScheduleCheck {
  /** 是否在可回复的在线时段（pauseOutsideHours=false 时恒 true）。 */
  online: boolean
  /** 今天是否为低活跃日（低活跃日要压低每日上限）。 */
  lowActivityDay: boolean
}

/** 当前生效的在线窗口。 */
export interface ActiveWindow {
  start: string
  end: string
  /** 是否使用了周末窗口（仅用于展示/调试）。 */
  weekend: boolean
}

/** 解析当前生效的在线窗口：周末用 weekend*，工作日用 workday*，留空回退 online*。 */
export function activeWindow(config: WechatPersonaConfig, now: number): ActiveWindow {
  const schedule = config?.schedule
  const weekend = weekdayIndex(now) >= 6
  const fallbackStart = String(schedule?.onlineStart ?? '').trim() || '08:30'
  const fallbackEnd = String(schedule?.onlineEnd ?? '').trim() || '23:00'
  const rawStart = weekend ? String(schedule?.weekendStart ?? '') : String(schedule?.workdayStart ?? '')
  const rawEnd = weekend ? String(schedule?.weekendEnd ?? '') : String(schedule?.workdayEnd ?? '')
  return {
    start: rawStart.trim() || fallbackStart,
    end: rawEnd.trim() || fallbackEnd,
    weekend,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

function crossesMidnight(window: ActiveWindow): boolean {
  const start = parseHhMm(window.start)
  const end = parseHhMm(window.end)
  return start !== null && end !== null && start > end
}

/**
 * 判断 `now` 是否落在在线窗口内。
 *
 * 除了当天窗口，还会检查“昨天的跨午夜窗口”：例如工作日 22:00–02:00，
 * 周六凌晨 01:00 仍属于周五的窗口，即使周六配了另一个时段。
 */
export function isOnlineAt(config: WechatPersonaConfig, now: number): boolean {
  if (config?.schedule?.pauseOutsideHours === false) return true
  const window = activeWindow(config, now)
  if (isWithinWindow(now, window.start, window.end)) return true
  const previous = activeWindow(config, now - DAY_MS)
  if (crossesMidnight(previous) && isWithinWindow(now, previous.start, previous.end)) return true
  return false
}

/**
 * 计算当前作息状态。
 *
 * - online：pauseOutsideHours 为 false 时不看时段恒为 true；
 *   否则落在 [start, end) 内才算在线（支持跨零点窗口）。
 * - lowActivityDay：lowActivityWeekday 必须是 1..7（周一..周日），
 *   0 / 非法值视为“不启用低活跃日”。
 */
export function evaluateSchedule(config: WechatPersonaConfig, now: number): ScheduleCheck {
  const schedule = config?.schedule
  const online = isOnlineAt(config, now)
  const rawWeekday = Number(schedule?.lowActivityWeekday)
  const weekday = Number.isFinite(rawWeekday) ? Math.trunc(rawWeekday) : 0
  const enabled = weekday >= 1 && weekday <= 7
  return {
    online,
    lowActivityDay: enabled && weekday === weekdayIndex(now),
  }
}

/**
 * 下次上线时间（毫秒时间戳）。
 *
 * - 当前在线 / pauseOutsideHours=false：返回 now；
 * - 否则向后最多找 7 天，返回下一个窗口开始时间；找不到返回 null。
 *
 * 仅用于设置页“下次上线倒计时”，不参与回复决策。
 */
export function nextOnlineAt(config: WechatPersonaConfig, now: number): number | null {
  if (config?.schedule?.pauseOutsideHours === false) return now
  if (isOnlineAt(config, now)) return now

  for (let offset = 0; offset <= 7; offset += 1) {
    const probe = now + offset * 24 * 60 * 60 * 1000
    const window = activeWindow(config, probe)
    const minutes = parseHhMm(window.start)
    if (minutes === null) continue
    const date = new Date(probe)
    date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
    const candidate = date.getTime()
    if (candidate > now && isWithinWindow(candidate, window.start, window.end)) return candidate
  }
  return null
}

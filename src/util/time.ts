/**
 * 本地时区时间工具。
 *
 * 说明：插件跑在用户本机，所有“今天 / 现在 / 几点”的判断都按系统本地时区，
 * 不用 UTC，避免东八区凌晨两点被算成“昨天”导致日配额提前重置。
 * 全部为纯函数，时间通过入参 now（毫秒时间戳）注入，方便测试用固定时间。
 */

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 本地日键：yyyy-mm-dd。 */
export function dayKey(now: number): string {
  const date = new Date(now)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 本地小时键：yyyy-mm-ddThh（用于“每联系人每小时”频控滚动）。 */
export function hourKey(now: number): string {
  const date = new Date(now)
  return `${dayKey(now)}T${pad2(date.getHours())}`
}

/** 本地星期几：1..7 = 周一..周日（Date#getDay 的 0=周日 转成 7）。 */
export function weekdayIndex(now: number): number {
  const day = new Date(now).getDay()
  return day === 0 ? 7 : day
}

/**
 * 解析 "HH:mm" 为“当天 0 点起的分钟数”。
 * 允许 "8:30"/"08:30"/"23:59"；非法格式、越界值或空串返回 null。
 */
export function parseHhMm(value: string): number | null {
  if (typeof value !== 'string') return null
  const matched = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/u.exec(value)
  if (!matched) return null
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

/** 格式化本地时间为 "HH:mm"。 */
export function formatHhMm(now: number): string {
  const date = new Date(now)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 判断 now 是否落在 [start, end) 时段内（start/end 为 "HH:mm"，start==end 视为全天）。
 *
 * 支持跨零点：start > end 时表示“晚上到次日凌晨”（如 22:00-02:00）。
 * 防御性设计：时段字符串非法时返回 true（不做时段限制），避免配置笔误
 * 让自动化悄无声息地永久静默——这是本插件里更危险的一侧。
 */
export function isWithinWindow(now: number, start: string, end: string): boolean {
  const startMinutes = parseHhMm(start)
  const endMinutes = parseHhMm(end)
  if (startMinutes === null || endMinutes === null) return true
  if (startMinutes === endMinutes) return true
  const date = new Date(now)
  const currentMinutes = date.getHours() * 60 + date.getMinutes()
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  }
  // 跨零点：22:00-02:00 命中 22:00..23:59 与 00:00..01:59
  return currentMinutes >= startMinutes || currentMinutes < endMinutes
}

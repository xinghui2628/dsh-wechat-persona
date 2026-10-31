import { describe, expect, it } from 'vitest'
import { dayKey, formatHhMm, hourKey, isWithinWindow, parseHhMm, weekdayIndex } from '../../src/util/time.ts'
import { atLocal } from './fakes.ts'

describe('time 工具（本地时区）', () => {
  it('dayKey / hourKey 用本地时间格式化', () => {
    expect(dayKey(atLocal(2026, 9, 30, 20, 5))).toBe('2026-10-30')
    expect(hourKey(atLocal(2026, 9, 30, 20, 5))).toBe('2026-10-30T20')
    expect(hourKey(atLocal(2026, 0, 1, 0, 0))).toBe('2026-01-01T00')
  })

  it('weekdayIndex：1..7 = 周一..周日', () => {
    expect(weekdayIndex(atLocal(2026, 9, 26, 9, 0))).toBe(1) // 周一
    expect(weekdayIndex(atLocal(2026, 9, 30, 20, 0))).toBe(5) // 周五
    expect(weekdayIndex(atLocal(2026, 10, 1, 9, 0))).toBe(7) // 周日
  })

  it('parseHhMm 解析与非法值', () => {
    expect(parseHhMm('08:30')).toBe(510)
    expect(parseHhMm('8:30')).toBe(510)
    expect(parseHhMm('00:00')).toBe(0)
    expect(parseHhMm('23:59')).toBe(1439)
    expect(parseHhMm('24:00')).toBeNull()
    expect(parseHhMm('12:60')).toBeNull()
    expect(parseHhMm('abc')).toBeNull()
    expect(parseHhMm('')).toBeNull()
  })

  it('formatHhMm 输出 HH:mm', () => {
    expect(formatHhMm(atLocal(2026, 9, 30, 20, 5))).toBe('20:05')
    expect(formatHhMm(atLocal(2026, 9, 30, 9, 0))).toBe('09:00')
  })

  it('isWithinWindow 普通时段（end 开区间）', () => {
    expect(isWithinWindow(atLocal(2026, 9, 30, 12, 0), '08:30', '23:00')).toBe(true)
    expect(isWithinWindow(atLocal(2026, 9, 30, 8, 30), '08:30', '23:00')).toBe(true)
    expect(isWithinWindow(atLocal(2026, 9, 30, 7, 0), '08:30', '23:00')).toBe(false)
    expect(isWithinWindow(atLocal(2026, 9, 30, 23, 0), '08:30', '23:00')).toBe(false)
  })

  it('isWithinWindow 跨零点（22:00-02:00）', () => {
    expect(isWithinWindow(atLocal(2026, 9, 30, 23, 30), '22:00', '02:00')).toBe(true)
    expect(isWithinWindow(atLocal(2026, 9, 31, 1, 0), '22:00', '02:00')).toBe(true)
    expect(isWithinWindow(atLocal(2026, 9, 31, 2, 0), '22:00', '02:00')).toBe(false)
    expect(isWithinWindow(atLocal(2026, 9, 30, 12, 0), '22:00', '02:00')).toBe(false)
  })

  it('非法时段不做限制；start === end 视为全天', () => {
    expect(isWithinWindow(atLocal(2026, 9, 30, 20, 0), 'oops', '23:00')).toBe(true)
    expect(isWithinWindow(atLocal(2026, 9, 30, 20, 0), '08:00', '08:00')).toBe(true)
  })
})

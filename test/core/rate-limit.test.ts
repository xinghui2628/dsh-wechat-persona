import { describe, expect, it } from 'vitest'
import type { RateCounter } from '../../src/types.ts'
import { checkRate, normalizeCounter, recordReply } from '../../src/core/rate-limit.ts'
import { dayKey, hourKey } from '../../src/util/time.ts'
import { FRIDAY_EVENING, testConfig } from './fakes.ts'

const NOW = FRIDAY_EVENING

function counter(overrides: Partial<RateCounter> = {}): RateCounter {
  return {
    hourKey: hourKey(NOW),
    hourCount: 0,
    dayKey: dayKey(NOW),
    dayCount: 0,
    lastReplyAt: 0,
    ...overrides,
  }
}

describe('normalizeCounter 计数器滚动', () => {
  it('空计数器返回当前键与 0', () => {
    const result = normalizeCounter(undefined, NOW)
    expect(result).toEqual({
      hourKey: hourKey(NOW),
      hourCount: 0,
      dayKey: dayKey(NOW),
      dayCount: 0,
      lastReplyAt: 0,
    })
  })

  it('同一小时同一日保留计数', () => {
    const input = counter({ hourCount: 2, dayCount: 7, lastReplyAt: 123 })
    expect(normalizeCounter(input, NOW)).toEqual(input)
  })

  it('跨小时只清小时计数', () => {
    const input = counter({ hourKey: '2000-01-01T00', hourCount: 5, dayCount: 7 })
    const result = normalizeCounter(input, NOW)
    expect(result.hourCount).toBe(0)
    expect(result.dayCount).toBe(7)
    expect(result.hourKey).toBe(hourKey(NOW))
  })

  it('跨日同时清零，lastReplyAt 保留', () => {
    const input = counter({ hourKey: '2000-01-01T00', hourCount: 5, dayKey: '2000-01-01', dayCount: 9, lastReplyAt: 999 })
    const result = normalizeCounter(input, NOW)
    expect(result.hourCount).toBe(0)
    expect(result.dayCount).toBe(0)
    expect(result.lastReplyAt).toBe(999)
  })
})

describe('checkRate 频控四档', () => {
  it('低活跃日上限优先于每小时/每日', () => {
    const config = testConfig()
    const result = checkRate(config, counter({ hourCount: 1, dayCount: 5, lastReplyAt: 0 }), NOW, true)
    expect(result.skip).toBe(true)
    expect(result.skip && result.reason).toBe('low-activity-day-limit')
  })

  it('低活跃日不启用时不按低活跃日拦', () => {
    const config = testConfig()
    const result = checkRate(config, counter({ hourCount: 1, dayCount: 5 }), NOW, false)
    expect(result).toEqual({ skip: false })
  })

  it('每小时上限', () => {
    const config = testConfig()
    const result = checkRate(config, counter({ hourCount: 10, dayCount: 10 }), NOW, false)
    expect(result.skip && result.reason).toBe('rate-hour-limit')
  })

  it('每日上限', () => {
    const config = testConfig()
    const result = checkRate(config, counter({ hourCount: 0, dayCount: 60 }), NOW, false)
    expect(result.skip && result.reason).toBe('rate-day-limit')
  })

  it('最小回复间隔', () => {
    const config = testConfig()
    const result = checkRate(config, counter({ hourCount: 1, dayCount: 1, lastReplyAt: NOW - 10_000 }), NOW, false)
    expect(result.skip && result.reason).toBe('rate-interval')
  })

  it('间隔已满足时放行', () => {
    const config = testConfig()
    const result = checkRate(config, counter({ hourCount: 1, dayCount: 1, lastReplyAt: NOW - 31_000 }), NOW, false)
    expect(result).toEqual({ skip: false })
  })

  it('非法配置数值防御性 clamp（负数不会导致全部静默）', () => {
    const config = testConfig((value) => {
      value.rateLimit.perContactPerHour = -5
      value.rateLimit.perContactPerDay = Number.NaN
      value.rateLimit.minReplyIntervalSec = -1
    })
    // 上限被 clamp 到 1：0 条时放行，已 1 条时按小时上限拦截
    expect(checkRate(config, counter({ hourCount: 0, dayCount: 0 }), NOW, false)).toEqual({ skip: false })
    expect(checkRate(config, counter({ hourCount: 1, dayCount: 1 }), NOW, false).skip).toBe(true)
  })
})

describe('recordReply 计数', () => {
  it('小时/日计数各 +1 且 lastReplyAt=now，不修改入参', () => {
    const input = counter({ hourCount: 2, dayCount: 4, lastReplyAt: 1 })
    const result = recordReply(input, NOW)
    expect(result.hourCount).toBe(3)
    expect(result.dayCount).toBe(5)
    expect(result.lastReplyAt).toBe(NOW)
    expect(input.hourCount).toBe(2)
    expect(input.dayCount).toBe(4)
    expect(input.lastReplyAt).toBe(1)
  })

  it('跨小时后计数从 1 开始', () => {
    const input = counter({ hourKey: '2000-01-01T00', hourCount: 9, dayCount: 9 })
    const result = recordReply(input, NOW)
    expect(result.hourCount).toBe(1)
    expect(result.dayCount).toBe(10)
  })
})

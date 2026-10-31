/**
 * 作息表 v2 测试：工作日/周末独立时段、跨午夜、下次上线时间、低活跃日。
 */
import { describe, expect, it } from 'vitest'
import { defaultConfig, type WechatPersonaConfig } from '../../src/config.ts'
import {
  activeWindow,
  evaluateSchedule,
  isOnlineAt,
  nextOnlineAt,
} from '../../src/core/schedule.ts'

// 2026-10-30 周五；2026-10-31 周六
const fridayEarly = new Date(2026, 9, 30, 7, 0, 0).getTime()
const fridayNoon = new Date(2026, 9, 30, 12, 0, 0).getTime()
const fridayLate = new Date(2026, 9, 30, 23, 30, 0).getTime()
const fridayNight = new Date(2026, 9, 30, 23, 0, 0).getTime()
const saturdayEarly = new Date(2026, 9, 31, 1, 0, 0).getTime()
const saturdayMorning = new Date(2026, 9, 31, 9, 0, 0).getTime()
const saturdayNoon = new Date(2026, 9, 31, 12, 0, 0).getTime()

function makeConfig(patch: (config: WechatPersonaConfig) => void): WechatPersonaConfig {
  const config = defaultConfig()
  patch(config)
  return config
}

describe('activeWindow 工作日/周末时段', () => {
  it('默认周末窗口留空时回退 online 时段', () => {
    const friday = activeWindow(defaultConfig(), fridayNoon)
    const saturday = activeWindow(defaultConfig(), saturdayNoon)
    expect(friday.weekend).toBe(false)
    expect(saturday.weekend).toBe(true)
    expect(saturday.start).toBe('08:30')
    expect(saturday.end).toBe('23:00')
  })

  it('周末单独配置后按周末生效', () => {
    const config = makeConfig((c) => {
      c.schedule.weekendStart = '10:00'
      c.schedule.weekendEnd = '22:00'
    })
    expect(evaluateSchedule(config, saturdayMorning).online).toBe(false)
    expect(evaluateSchedule(config, saturdayNoon).online).toBe(true)
    expect(evaluateSchedule(config, fridayNoon).online).toBe(true)
    expect(activeWindow(config, saturdayNoon).start).toBe('10:00')
  })
})

describe('跨午夜窗口', () => {
  it('工作日 22:00-02:00：当晚与次日凌晨都在线', () => {
    const config = makeConfig((c) => {
      c.schedule.workdayStart = '22:00'
      c.schedule.workdayEnd = '02:00'
    })
    expect(evaluateSchedule(config, fridayLate).online).toBe(true)
    expect(evaluateSchedule(config, fridayNoon).online).toBe(false)
    // 周六凌晨 01:00 仍属于周五晚上的跨午夜窗口（即使周末时段不同）
    expect(evaluateSchedule(config, saturdayEarly).online).toBe(true)
    expect(isOnlineAt(config, saturdayEarly)).toBe(true)
  })

  it('pauseOutsideHours=false 时恒为在线', () => {
    const config = makeConfig((c) => {
      c.schedule.pauseOutsideHours = false
    })
    expect(evaluateSchedule(config, fridayEarly).online).toBe(true)
    expect(nextOnlineAt(config, fridayEarly)).toBe(fridayEarly)
  })

  it('时段非法时不做时段限制（防御性在线）', () => {
    const config = makeConfig((c) => {
      c.schedule.workdayStart = 'oops'
      c.schedule.workdayEnd = '23:00'
    })
    expect(evaluateSchedule(config, fridayEarly).online).toBe(true)
  })
})

describe('nextOnlineAt 下次上线时间', () => {
  it('当前在线返回 now', () => {
    expect(nextOnlineAt(defaultConfig(), fridayNoon)).toBe(fridayNoon)
  })

  it('未到上班时间返回当天开始时间', () => {
    const next = nextOnlineAt(defaultConfig(), fridayEarly)
    expect(next).not.toBeNull()
    const date = new Date(next as number)
    expect(date.getHours()).toBe(8)
    expect(date.getMinutes()).toBe(30)
  })

  it('已过在线时段返回下一次窗口开始', () => {
    const next = nextOnlineAt(defaultConfig(), fridayNight)
    expect(next).not.toBeNull()
    expect((next as number) > fridayNight).toBe(true)
    expect(new Date(next as number).getDate()).toBe(31)
  })

  it('跨午夜配置下，凌晨之后的下一次上线是当天晚上', () => {
    const config = makeConfig((c) => {
      c.schedule.workdayStart = '22:00'
      c.schedule.workdayEnd = '02:00'
    })
    const at = new Date(2026, 9, 30, 3, 0, 0).getTime()
    const next = nextOnlineAt(config, at)
    expect(next).not.toBeNull()
    const date = new Date(next as number)
    expect(date.getDate()).toBe(30)
    expect(date.getHours()).toBe(22)
  })
})

describe('低活跃日', () => {
  it('按 weekdayIndex 命中周五', () => {
    const config = makeConfig((c) => {
      c.schedule.lowActivityWeekday = 5
    })
    expect(evaluateSchedule(config, fridayNoon).lowActivityDay).toBe(true)
    expect(evaluateSchedule(config, saturdayNoon).lowActivityDay).toBe(false)
  })

  it('0 或非法值视为不启用', () => {
    const config = makeConfig((c) => {
      c.schedule.lowActivityWeekday = 0
    })
    expect(evaluateSchedule(config, fridayNoon).lowActivityDay).toBe(false)
    config.schedule.lowActivityWeekday = 9
    expect(evaluateSchedule(config, fridayNoon).lowActivityDay).toBe(false)
  })
})

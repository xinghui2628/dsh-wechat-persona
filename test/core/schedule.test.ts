import { describe, expect, it } from 'vitest'
import { evaluateSchedule } from '../../src/core/schedule.ts'
import { testConfig, atLocal } from './fakes.ts'

const FRIDAY_NOON = atLocal(2026, 9, 30, 12, 0)
const FRIDAY_EARLY = atLocal(2026, 9, 30, 7, 0)
const FRIDAY_LATE = atLocal(2026, 9, 30, 23, 30)
const MONDAY_NOON = atLocal(2026, 9, 26, 12, 0)

describe('evaluateSchedule 作息表', () => {
  it('默认 08:30-23:00 内在线、窗口外离线', () => {
    const config = testConfig()
    expect(evaluateSchedule(config, FRIDAY_NOON).online).toBe(true)
    expect(evaluateSchedule(config, FRIDAY_EARLY).online).toBe(false)
    expect(evaluateSchedule(config, FRIDAY_LATE).online).toBe(false)
  })

  it('pauseOutsideHours=false 时任何时间都算在线', () => {
    const config = testConfig((value) => {
      value.schedule.pauseOutsideHours = false
    })
    expect(evaluateSchedule(config, FRIDAY_EARLY).online).toBe(true)
    expect(evaluateSchedule(config, FRIDAY_LATE).online).toBe(true)
  })

  it('lowActivityWeekday 命中当天才为低活跃日', () => {
    const config = testConfig()
    expect(config.schedule.lowActivityWeekday).toBe(1)
    expect(evaluateSchedule(config, MONDAY_NOON).lowActivityDay).toBe(true)
    expect(evaluateSchedule(config, FRIDAY_NOON).lowActivityDay).toBe(false)
  })

  it('lowActivityWeekday 非法值（0 / 8 / 非数字）视为不启用', () => {
    const disabled = testConfig((value) => {
      value.schedule.lowActivityWeekday = 0
    })
    expect(evaluateSchedule(disabled, MONDAY_NOON).lowActivityDay).toBe(false)
    const outOfRange = testConfig((value) => {
      value.schedule.lowActivityWeekday = 8
    })
    expect(evaluateSchedule(outOfRange, MONDAY_NOON).lowActivityDay).toBe(false)
  })

  it('周日对应 7', () => {
    const sunday = testConfig((value) => {
      value.schedule.lowActivityWeekday = 7
    })
    expect(evaluateSchedule(sunday, atLocal(2026, 10, 1, 12, 0)).lowActivityDay).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import type { BudgetState } from '../../src/types.ts'
import { addUsage, budgetPhase, normalizeBudget } from '../../src/core/budget.ts'
import { dayKey } from '../../src/util/time.ts'
import { FRIDAY_EVENING, atLocal, testConfig } from './fakes.ts'

const NOW = FRIDAY_EVENING
const TODAY = dayKey(NOW)
const YESTERDAY = dayKey(atLocal(2026, 9, 29, 20, 0))

function budget(spentTokens: number, day = TODAY): BudgetState {
  return { dayKey: day, spentTokens }
}

describe('normalizeBudget 跨日重置', () => {
  it('缺失状态返回今天 0 消耗', () => {
    expect(normalizeBudget(undefined, NOW)).toEqual({ dayKey: TODAY, spentTokens: 0 })
  })

  it('跨日清零', () => {
    expect(normalizeBudget(budget(500, YESTERDAY), NOW)).toEqual({ dayKey: TODAY, spentTokens: 0 })
  })

  it('当日保留并修正非法值', () => {
    expect(normalizeBudget(budget(500), NOW)).toEqual({ dayKey: TODAY, spentTokens: 500 })
    expect(normalizeBudget({ dayKey: TODAY, spentTokens: -3 }, NOW).spentTokens).toBe(0)
    expect(normalizeBudget({ dayKey: TODAY, spentTokens: Number.NaN }, NOW).spentTokens).toBe(0)
  })
})

describe('addUsage 记账', () => {
  it('优先用 totalTokens', () => {
    const result = addUsage(budget(10), { inputTokens: 30, outputTokens: 20, totalTokens: 100 }, NOW)
    expect(result).toEqual({ dayKey: TODAY, spentTokens: 110 })
  })

  it('totalTokens 缺失时用 input+output', () => {
    const result = addUsage(budget(0), { inputTokens: 7, outputTokens: 5 }, NOW)
    expect(result.spentTokens).toBe(12)
  })

  it('跨日先清零再累加', () => {
    const result = addUsage(budget(999, YESTERDAY), { inputTokens: 3, outputTokens: 2 }, NOW)
    expect(result).toEqual({ dayKey: TODAY, spentTokens: 5 })
  })

  it('负数/非法 token 按 0 处理', () => {
    const result = addUsage(budget(10), { inputTokens: -5, outputTokens: Number.NaN }, NOW)
    expect(result.spentTokens).toBe(10)
  })
})

describe('budgetPhase 阶段', () => {
  it('ok -> draft -> exhausted 边界（dailyTokens=1000, ratio=0.85）', () => {
    const config = testConfig((value) => {
      value.budget.dailyTokens = 1000
      value.budget.draftModeRatio = 0.85
    })
    expect(budgetPhase(config, budget(0), NOW)).toBe('ok')
    expect(budgetPhase(config, budget(849), NOW)).toBe('ok')
    expect(budgetPhase(config, budget(850), NOW)).toBe('draft')
    expect(budgetPhase(config, budget(999), NOW)).toBe('draft')
    expect(budgetPhase(config, budget(1000), NOW)).toBe('exhausted')
    expect(budgetPhase(config, budget(1200), NOW)).toBe('exhausted')
  })

  it('跨日的旧消耗不影响今天', () => {
    const config = testConfig((value) => {
      value.budget.dailyTokens = 1000
    })
    expect(budgetPhase(config, budget(5000, YESTERDAY), NOW)).toBe('ok')
  })

  it('dailyTokens 非法时 clamp 到 >=1，不会永远 ok', () => {
    const config = testConfig((value) => {
      value.budget.dailyTokens = 0
      value.budget.draftModeRatio = 0.85
    })
    expect(budgetPhase(config, budget(1), NOW)).toBe('exhausted')
  })
})

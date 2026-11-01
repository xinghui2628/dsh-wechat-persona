import { describe, expect, it } from 'vitest'

import { CONFIDENCE_HIGH, CONFIDENCE_LOW, evaluateConfidence } from '../../src/core/ocr/confidence.ts'

describe('可解释置信度评估（confidence.ts 纯函数，6.5）', () => {
  it('引擎不提供原生置信度时不编造、不计分', () => {
    const result = evaluateConfidence({ boxHeight: 28 })
    expect(result.signals.map((signal) => signal.name)).not.toContain('native-confidence')
    expect(result.decision).toBe('accept')
    for (const signal of result.signals) {
      expect(signal.value).toBeGreaterThanOrEqual(0)
      expect(signal.value).toBeLessThanOrEqual(1)
    }
  })

  it('原生置信度计入加权分，双引擎一致时高分放行', () => {
    const result = evaluateConfidence({ nativeConfidence: 0.95, boxHeight: 28, agreement: 'agree' })
    const native = result.signals.find((signal) => signal.name === 'native-confidence')
    expect(native?.value).toBeCloseTo(0.95, 5)
    expect(result.score).toBeGreaterThanOrEqual(CONFIDENCE_HIGH)
    expect(result.decision).toBe('accept')
    expect(result.explain).toContain('原生置信度')
  })

  it('低行高 + 单引擎落入中可信区间 → verify（二次验证）', () => {
    const result = evaluateConfidence({ boxHeight: 12, agreement: 'single' })
    expect(result.score).toBeGreaterThanOrEqual(CONFIDENCE_LOW)
    expect(result.score).toBeLessThan(CONFIDENCE_HIGH)
    expect(result.decision).toBe('verify')
  })

  it('两引擎结果冲突显著降分 → 不能自动放行', () => {
    const result = evaluateConfidence({ boxHeight: 28, agreement: 'conflict' })
    expect(result.decision).toBe('verify')
    const agreement = result.signals.find((signal) => signal.name === 'multi-engine-agreement')
    expect(agreement?.value).toBeCloseTo(0.2, 5)
  })

  it('联系人身份未确认时硬否决，无论 OCR 多高', () => {
    const result = evaluateConfidence({
      nativeConfidence: 0.99,
      boxHeight: 28,
      agreement: 'agree',
      contactVerified: false,
    })
    expect(result.decision).toBe('reject')
    expect(result.vetoed).toBe(true)
    expect(result.score).toBeLessThanOrEqual(0.2)
    expect(result.explain).toContain('联系人')
  })

  it('跨行合并 / 截断降分到中可信区间', () => {
    const result = evaluateConfidence({ boxHeight: 28, agreement: 'single', mergedLines: 3, truncated: true })
    expect(result.decision).toBe('verify')
    const merge = result.signals.find((signal) => signal.name === 'merge-truncation')
    expect(merge?.value).toBeLessThan(0.6)
  })

  it('完全没有可用质量因子时返回 verify 而不是臆断高分', () => {
    const result = evaluateConfidence({})
    expect(result.signals).toEqual([])
    expect(result.score).toBe(0)
    expect(result.decision).toBe('verify')
    expect(result.explain.length).toBeGreaterThan(0)
  })

  it('每个因子都有 name/weight/value/note，权重为正，总分在 0..1', () => {
    const result = evaluateConfidence({
      nativeConfidence: 0.8,
      boxHeight: 22,
      scale: 3,
      agreement: 'agree',
      boxMatch: 0.9,
      mergedLines: 1,
      truncated: false,
      correctionApplied: true,
      contactVerified: true,
    })
    expect(result.signals.length).toBeGreaterThanOrEqual(5)
    for (const signal of result.signals) {
      expect(signal.name.length).toBeGreaterThan(0)
      expect(signal.weight).toBeGreaterThan(0)
      expect(signal.note.length).toBeGreaterThan(0)
    }
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(1)
    expect(['accept', 'verify', 'reject']).toContain(result.decision)
  })

  it('阈值常量符合高/低两档语义', () => {
    expect(CONFIDENCE_LOW).toBeGreaterThan(0)
    expect(CONFIDENCE_HIGH).toBeGreaterThan(CONFIDENCE_LOW)
    expect(CONFIDENCE_HIGH).toBeLessThanOrEqual(1)
  })

  it('100 组原生置信度单调性：原生分越高总分不降低', () => {
    let previous = -1
    for (let i = 0; i < 100; i += 1) {
      const result = evaluateConfidence({ nativeConfidence: i / 100, boxHeight: 20, agreement: 'agree' })
      expect(result.score).toBeGreaterThanOrEqual(previous)
      previous = result.score
    }
  })
})

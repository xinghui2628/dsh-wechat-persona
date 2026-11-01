import { describe, expect, it } from 'vitest'

import { alignLineSequences } from '../../src/core/ocr/align.ts'
import type { OcrBox } from '../../src/core/ocr/types.ts'

function item(text: string, y = 200, bubbleId?: string): { text: string; box: OcrBox; bubbleId?: string } {
  return { text, box: { x: 380, y, width: text.length * 20, height: 28 }, ...(bubbleId ? { bubbleId } : {}) }
}

describe('引擎行序列对齐（align.ts 纯函数，6.3）', () => {
  it('完全相同的序列全部 match，编辑距离 0', () => {
    const result = alignLineSequences([item('第一句', 200), item('第二句', 240)], [item('第一句', 200), item('第二句', 240)])
    expect(result.distance).toBe(0)
    expect(result.similarity).toBe(1)
    expect(result.steps.map((step) => step.op)).toEqual(['match', 'match'])
    expect(result.matched).toBe(2)
    expect(result.inserted).toBe(0)
    expect(result.deleted).toBe(0)
  })

  it('第二引擎多识别出一行 → insert', () => {
    const result = alignLineSequences([item('甲', 200)], [item('甲', 200), item('乙', 240)])
    expect(result.inserted).toBe(1)
    expect(result.deleted).toBe(0)
    expect(result.replacements).toBe(0)
    expect(result.matched).toBe(1)
    expect(result.steps.map((step) => step.op)).toEqual(['match', 'insert'])
  })

  it('第二引擎漏识别一行 → delete', () => {
    const result = alignLineSequences([item('甲', 200), item('乙', 240)], [item('甲', 200)])
    expect(result.inserted).toBe(0)
    expect(result.deleted).toBe(1)
    expect(result.matched).toBe(1)
  })

  it('OCR 形近字差异归为 replace 而不是一条删+一条增', () => {
    const result = alignLineSequences([item('今天大吧鱼很好吃')], [item('今天大肥鱼很好吃')])
    expect(result.replacements).toBe(1)
    expect(result.inserted).toBe(0)
    expect(result.deleted).toBe(0)
    expect(result.similarity).toBeGreaterThan(0)
    expect(result.steps[0]?.op).toBe('replace')
  })

  it('跨气泡同文本不强行对齐（禁止跨气泡拼接）', () => {
    const result = alignLineSequences([item('在吗', 200, 'b1')], [item('在吗', 200, 'b2')])
    expect(result.matched).toBe(0)
    expect(result.replacements).toBe(0)
    expect(result.deleted).toBe(1)
    expect(result.inserted).toBe(1)
  })

  it('顺序保持：顺序倒置时不会产生交叉匹配', () => {
    const result = alignLineSequences([item('第一句', 200), item('第二句', 240)], [item('第二句', 240), item('第一句', 200)])
    const pairs = result.steps.filter((step) => step.a && step.b)
    expect(pairs.length).toBeLessThanOrEqual(1)
    // 没有任何一步同时对齐 a0↔b1 与 a1↔b0
    const aIndices = result.steps.map((step) => (step.a ? step.aIndex : -1)).filter((value) => value >= 0)
    expect(aIndices).toEqual([...aIndices].sort((left, right) => left - right))
  })

  it('空序列安全', () => {
    const left = alignLineSequences([], [item('甲', 200)])
    expect(left.inserted).toBe(1)
    expect(left.similarity).toBe(0)
    const right = alignLineSequences([item('甲', 200)], [])
    expect(right.deleted).toBe(1)
    const both = alignLineSequences([], [])
    expect(both.matched).toBe(0)
    expect(both.steps).toEqual([])
  })
})

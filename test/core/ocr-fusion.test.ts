import { describe, expect, it } from 'vitest'

import { matchLines } from '../../src/core/ocr/fusion.ts'
import type { OcrBox } from '../../src/core/ocr/types.ts'

function line(text: string, y: number, x = 380, width = 160, height = 28): { text: string; box: OcrBox } {
  return { text, box: { x, y, width, height } }
}

describe('多引擎几何匹配（fusion.ts 纯函数，6.2）', () => {
  it('完全相同的一行一对一匹配，分数接近 1', () => {
    const result = matchLines([line('在吗', 200)], [line('在吗', 200)])
    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]?.primary.text).toBe('在吗')
    expect(result.pairs[0]?.secondary.text).toBe('在吗')
    expect(result.pairs[0]?.score).toBeGreaterThan(0.9)
    expect(result.unmatchedPrimary).toEqual([])
    expect(result.unmatchedSecondary).toEqual([])
  })

  it('两引擎框有偏移时仍能匹配（不是只比 IoU）', () => {
    const result = matchLines([line('今天吃鱼', 200, 380, 160, 28)], [line('今天吃鱼', 215, 386, 150, 26)])
    expect(result.pairs).toHaveLength(1)
    const pair = result.pairs[0]!
    expect(pair.score).toBeGreaterThan(0.45)
    expect(pair.iou).toBeLessThan(0.5)
    expect(pair.centerScore).toBeGreaterThan(0.7)
  })

  it('空间位置相距过远的行不匹配', () => {
    const result = matchLines([line('在吗', 200)], [line('在吗', 600)])
    expect(result.pairs).toEqual([])
    expect(result.unmatchedPrimary).toHaveLength(1)
    expect(result.unmatchedSecondary).toHaveLength(1)
  })

  it('同气泡优先：几何稍差但同气泡的候选胜出，跨气泡候选直接排除', () => {
    const result = matchLines(
      [{ ...line('在吗', 200), bubbleId: 'b1' }],
      [
        { ...line('在吗', 208, 380, 160, 26), bubbleId: 'b2' }, // 几何更近但属于另一个气泡 → 排除
        { ...line('在吗', 204, 380, 150, 26), bubbleId: 'b1' },
      ],
    )
    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]?.sameBubble).toBe(true)
    expect(result.pairs[0]?.secondary.box.y).toBe(204)
    expect(result.unmatchedSecondary).toHaveLength(1)
  })

  it('只有跨气泡候选时不匹配', () => {
    const result = matchLines(
      [{ ...line('在吗', 200), bubbleId: 'b1' }],
      [{ ...line('在吗', 200), bubbleId: 'b2' }],
    )
    expect(result.pairs).toEqual([])
    expect(result.unmatchedPrimary).toHaveLength(1)
  })

  it('一对一贪心：一条候选不会被重复匹配', () => {
    const result = matchLines(
      [line('第一句', 200), line('第二句', 240)],
      [line('第一句', 200)],
    )
    expect(result.pairs).toHaveLength(1)
    expect(result.unmatchedPrimary).toHaveLength(1)
    expect(result.unmatchedSecondary).toEqual([])
  })

  it('空输入安全', () => {
    expect(matchLines([], []).pairs).toEqual([])
    expect(matchLines([line('在吗', 200)], []).unmatchedPrimary).toHaveLength(1)
    expect(matchLines([], [line('在吗', 200)]).unmatchedSecondary).toHaveLength(1)
  })

  it('100 组不同偏移仍全部正确一对一（不抢、不重复）', () => {
    for (let i = 0; i < 100; i += 1) {
      const y = 200 + (i % 10) * 40
      const primary = [line(`甲${i}`, y), line(`乙${i}`, y + 120)]
      const secondary = [line(`乙${i}`, y + 123, 384, 150, 26), line(`甲${i}`, y + 4, 386, 152, 26)]
      const result = matchLines(primary, secondary)
      expect(result.pairs).toHaveLength(2)
      expect(result.unmatchedPrimary).toEqual([])
      expect(result.unmatchedSecondary).toEqual([])
      expect(new Set(result.pairs.map((pair) => pair.secondary.text)).size).toBe(2)
    }
  })
})

import { describe, expect, it } from 'vitest'

import {
  alignBaseline,
  appendPending,
  applyAck,
  captureIdFor,
  emptyBaselineState,
  nextCaptureId,
  normalizeBaselineState,
  pendingAfterAck,
  seqFromCaptureId,
  stableMessageId,
} from '../../src/core/ocr/baseline.ts'
import type { BaselineState, PendingLine } from '../../src/core/ocr/baseline.ts'

function pending(seq: number, text: string, captureId = captureIdFor(seq)): PendingLine {
  return { id: stableMessageId(text, seq), text, captureId, seq, firstSeenAt: 0 }
}

describe('基线对齐（baseline.ts 纯函数，OCR-H1/H2 回归）', () => {
  it('尾对齐：旧基线末尾与新读数开头重合时只输出新行', () => {
    const result = alignBaseline(['a', 'b', 'c'], ['b', 'c', 'd', 'e'])
    expect(result.matched).toBe(true)
    expect(result.matchLen).toBe(2)
    expect(result.newTexts).toEqual(['d', 'e'])
    expect(result.mergedTexts).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(result.reset).toBe(false)
  })

  it('完全重复的读取不产生新行、不重置基线', () => {
    const result = alignBaseline(['a', 'b'], ['a', 'b'])
    expect(result.matched).toBe(true)
    expect(result.matchLen).toBe(2)
    expect(result.newTexts).toEqual([])
    expect(result.mergedTexts).toEqual(['a', 'b'])
  })

  it('单个消息也被识别为新行（不因截断/长度不足丢失）', () => {
    expect(alignBaseline(['a', 'b', 'c'], ['a', 'b', 'c', 'd']).newTexts).toEqual(['d'])
    expect(alignBaseline(['a'], ['a', 'b']).newTexts).toEqual(['b'])
    expect(alignBaseline(['x', 'y'], ['y', 'z']).newTexts).toEqual(['z'])
  })

  it('完全对不上时重置基线（防重复回复旧消息），并把当前行当基线', () => {
    const result = alignBaseline(['a', 'b'], ['x', 'y'])
    expect(result.matched).toBe(false)
    expect(result.reset).toBe(true)
    expect(result.newTexts).toEqual([])
    expect(result.mergedTexts).toEqual(['x', 'y'])
  })

  it('空读数不消费基线、不输出（避免抖动清空历史）', () => {
    const result = alignBaseline(['a', 'b'], [])
    expect(result.matched).toBe(false)
    expect(result.skipped).toBe(true)
    expect(result.newTexts).toEqual([])
    expect(result.mergedTexts).toEqual(['a', 'b'])
  })

  it('首次读取（无基线）只建基线不输出', () => {
    const result = alignBaseline([], ['a', 'b'])
    expect(result.matched).toBe(false)
    expect(result.skipped).toBe(true)
    expect(result.newTexts).toEqual([])
    expect(result.mergedTexts).toEqual(['a', 'b'])
  })

  it('基线长度有上限（默认 200），只保留最近的行', () => {
    const prev = Array.from({ length: 200 }, (_, i) => `old-${i}`)
    const current = [...prev.slice(-3), 'new-1', 'new-2']
    const result = alignBaseline(prev, current)
    expect(result.newTexts).toEqual(['new-1', 'new-2'])
    expect(result.mergedTexts).toHaveLength(200)
    expect(result.mergedTexts.at(-1)).toBe('new-2')
    const many = Array.from({ length: 300 }, (_, i) => `x-${i}`)
    const limited = alignBaseline([], many, 5)
    expect(limited.mergedTexts).toEqual(many.slice(-5))
  })
})

describe('跨帧稳定消息 id（OCR-H2 回归：重放不重复、同文本两条不同）', () => {
  it('同样的文本 + 同样的序号得到同样的 id（跨帧重放稳定）', () => {
    expect(stableMessageId('在吗', 1)).toBe(stableMessageId('在吗', 1))
    expect(stableMessageId('在吗', 1)).toMatch(/^pc-[0-9a-f]{12}-1$/)
  })

  it('连续两条相同文本（两次「在吗」）id 不同', () => {
    expect(stableMessageId('在吗', 3)).not.toBe(stableMessageId('在吗', 4))
  })

  it('同样序号不同文本 id 不同', () => {
    expect(stableMessageId('在吗', 3)).not.toBe(stableMessageId('在的', 3))
  })
})

describe('captureId / pending 队列 / ack 水位线', () => {
  it('captureId 按序号生成并可从头部解析', () => {
    expect(captureIdFor(7)).toBe('cap-7')
    expect(seqFromCaptureId('cap-7')).toBe(7)
    expect(seqFromCaptureId('cap-7-abcd1234')).toBe(7)
    expect(seqFromCaptureId('nope')).toBe(-1)
    expect(seqFromCaptureId('')).toBe(-1)
    expect(seqFromCaptureId('cap-0')).toBe(0)
  })

  it('nextCaptureId 递增序号并返回稳定的 captureId', () => {
    const state = emptyBaselineState()
    expect(state.captureSeq).toBe(0)
    const next = nextCaptureId(state)
    expect(next.seq).toBe(1)
    expect(next.captureId).toBe('cap-1')
    expect(next.state.captureSeq).toBe(1)
    const again = nextCaptureId(next.state)
    expect(again.captureId).toBe('cap-2')
  })

  it('normalizeBaselineState 容错旧格式（纯数组）与缺字段', () => {
    expect(normalizeBaselineState(undefined)).toEqual(emptyBaselineState())
    expect(normalizeBaselineState(['a', 'b'])).toEqual({ ...emptyBaselineState(), texts: ['a', 'b'] })
    const legacy = normalizeBaselineState({ texts: ['a'], updatedAt: 123 })
    expect(legacy.texts).toEqual(['a'])
    expect(legacy.pending).toEqual([])
    expect(legacy.captureSeq).toBe(0)
    const rich = normalizeBaselineState({
      texts: ['a'],
      pending: [{ id: 'pc-x-1', text: 'a', captureId: 'cap-1', seq: 1, firstSeenAt: 5 }],
      captureSeq: 4,
      lastAckCaptureId: 'cap-3',
    })
    expect(rich.pending).toHaveLength(1)
    expect(rich.captureSeq).toBe(4)
    expect(rich.lastAckCaptureId).toBe('cap-3')
  })

  it('appendPending 追加、按 id 去重、尾部截断', () => {
    const state = emptyBaselineState()
    const first = appendPending(state, [pending(1, 'a'), pending(2, 'b')])
    expect(first.pending.map((item) => item.text)).toEqual(['a', 'b'])
    const second = appendPending(first, [pending(2, 'b'), pending(3, 'c')])
    expect(second.pending.map((item) => item.text)).toEqual(['a', 'b', 'c'])
    const limited = appendPending(second, [pending(4, 'd')], 2)
    expect(limited.pending.map((item) => item.text)).toEqual(['c', 'd'])
  })

  it('applyAck 只丢弃 ≤ 水位线的 pending 行，> 水位的行下次重放', () => {
    const state = appendPending(emptyBaselineState(), [pending(1, 'a'), pending(2, 'b'), pending(3, 'c')])
    const acked = applyAck(state, 'cap-2-suffix')
    expect(acked.lastAckCaptureId).toBe('cap-2-suffix')
    expect(acked.pending.map((item) => item.seq)).toEqual([3])
    expect(acked.pending[0]?.id).toBe(stableMessageId('c', 3))
  })

  it('applyAck 空/非法 ack 原样返回（不误删 pending）', () => {
    const state = appendPending(emptyBaselineState(), [pending(1, 'a')])
    expect(applyAck(state, '')).toBe(state)
    expect(applyAck(state, 'garbage')).toBe(state)
  })

  it('pendingAfterAck：重放未确认行且 id 稳定（OCR-H2 不丢消息）', () => {
    const state = appendPending(emptyBaselineState(), [pending(1, 'a'), pending(2, 'b')])
    const before = pendingAfterAck(state, '')
    expect(before.map((item) => item.text)).toEqual(['a', 'b'])
    expect(pendingAfterAck(state, '').map((item) => item.id)).toEqual(before.map((item) => item.id))
    // 确认到 cap-1 后，只剩 cap-2 重放，id 与之前完全一致
    const after = pendingAfterAck(applyAck(state, 'cap-1'), 'cap-1')
    expect(after.map((item) => item.text)).toEqual(['b'])
    expect(after[0]?.id).toBe(stableMessageId('b', 2))
  })

  it('pending 队列有上限，避免状态文件无限膨胀', () => {
    const state = appendPending(emptyBaselineState(), Array.from({ length: 250 }, (_, i) => pending(i + 1, `m-${i}`)))
    expect(state.pending).toHaveLength(200)
    expect(state.pending.at(-1)?.text).toBe('m-249')
  })

  it('BaselineState 形状满足桌面通道持久化需要', () => {
    const state: BaselineState = emptyBaselineState()
    expect(Object.keys(state).sort()).toEqual(['captureSeq', 'lastAckCaptureId', 'pending', 'texts'])
  })
})

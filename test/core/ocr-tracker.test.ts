import { describe, expect, it } from 'vitest'

import { classifyFrameDelta } from '../../src/core/ocr/tracker.ts'
import type { OcrBox } from '../../src/core/ocr/types.ts'

function item(text: string, y: number, id?: string, contactId?: string): { text: string; box: OcrBox; id?: string; contactId?: string } {
  return {
    text,
    box: { x: 380, y, width: text.length * 20, height: 28 },
    ...(id ? { id } : {}),
    ...(contactId ? { contactId } : {}),
  }
}

describe('跨帧序列对齐（tracker.ts 纯函数，8.2/8.3）', () => {
  it('pending 重放识别为 replay，不视为新消息', () => {
    const delta = classifyFrameDelta([item('在吗', 200, 'pc-1')], [item('在吗', 200, 'pc-1')])
    expect(delta.entries.map((entry) => entry.kind)).toEqual(['replay'])
    expect(delta.replay).toHaveLength(1)
    expect(delta.inserted).toEqual([])
    expect(delta.reset).toBe(false)
  })

  it('连发两条相同文本算两条：一条 replay、一条 insert', () => {
    const delta = classifyFrameDelta(
      [item('在吗', 200, 'pc-1')],
      [item('在吗', 200, 'pc-1'), item('在吗', 240, 'pc-2')],
    )
    expect(delta.entries.map((entry) => entry.kind)).toEqual(['replay', 'insert'])
    expect(delta.inserted.map((entry) => entry.id)).toEqual(['pc-2'])
    expect(delta.duplicates).toEqual([])
  })

  it('同帧重复 OCR 行（文本框几乎重合）判为 duplicate', () => {
    const delta = classifyFrameDelta([], [item('在吗', 200, 'a'), item('在吗', 201, 'b')])
    expect(delta.entries.map((entry) => entry.kind)).toEqual(['insert', 'duplicate'])
    expect(delta.inserted).toHaveLength(1)
    expect(delta.duplicates).toHaveLength(1)
  })

  it('窗口向上滚动露出的历史消息判为 scroll，不当作新入站', () => {
    const delta = classifyFrameDelta(
      [item('甲', 200, 'pc-1'), item('乙', 240, 'pc-2'), item('丙', 280, 'pc-3')],
      [item('更早一', 120), item('更早二', 160), item('甲', 200, 'pc-1'), item('乙', 240, 'pc-2')],
    )
    expect(delta.entries.map((entry) => entry.kind)).toEqual(['scroll', 'scroll', 'replay', 'replay'])
    expect(delta.scrolled).toHaveLength(2)
    expect(delta.inserted).toEqual([])
  })

  it('新消息追加在末尾判为 insert', () => {
    const delta = classifyFrameDelta(
      [item('甲', 200, 'pc-1'), item('乙', 240, 'pc-2')],
      [item('甲', 200, 'pc-1'), item('乙', 240, 'pc-2'), item('丙', 280, 'pc-3')],
    )
    expect(delta.entries.map((entry) => entry.kind)).toEqual(['replay', 'replay', 'insert'])
    expect(delta.inserted.map((entry) => entry.id)).toEqual(['pc-3'])
  })

  it('同一消息跨帧 OCR 形近字变化算一条（ocr-changed），id 不同也能关联', () => {
    const delta = classifyFrameDelta(
      [item('今天大吧鱼很好吃', 200, 'pc-a')],
      [item('今天大肥鱼很好吃', 200, 'pc-b')],
    )
    expect(delta.entries.map((entry) => entry.kind)).toEqual(['ocr-changed'])
    expect(delta.ocrChanged).toHaveLength(1)
    expect(delta.ocrChanged[0]?.prev.id).toBe('pc-a')
    expect(delta.ocrChanged[0]?.current.id).toBe('pc-b')
    expect(delta.inserted).toEqual([])
  })

  it('切换联系人清空跨帧关联（reset，全部视为 insert）', () => {
    const delta = classifyFrameDelta(
      [item('在吗', 200, 'pc-1', 'contact-a')],
      [item('在吗', 200, 'pc-9', 'contact-b')],
    )
    expect(delta.reset).toBe(true)
    expect(delta.entries.map((entry) => entry.kind)).toEqual(['insert'])
    expect(delta.replay).toEqual([])
  })

  it('上一帧为空时全部 insert', () => {
    const delta = classifyFrameDelta([], [item('甲', 200, 'pc-1'), item('乙', 240, 'pc-2')])
    expect(delta.entries.map((entry) => entry.kind)).toEqual(['insert', 'insert'])
    expect(delta.inserted).toHaveLength(2)
  })

  it('100 组同文本重放不产生重复投递', () => {
    for (let i = 0; i < 100; i += 1) {
      const delta = classifyFrameDelta(
        [item(`消息${i}`, 200, `pc-${i}`)],
        [item(`消息${i}`, 200, `pc-${i}`), item(`消息${i}`, 240, `pc-new-${i}`)],
      )
      expect(delta.replay).toHaveLength(1)
      expect(delta.inserted).toHaveLength(1)
      expect(delta.inserted[0]?.id).toBe(`pc-new-${i}`)
    }
  })
})

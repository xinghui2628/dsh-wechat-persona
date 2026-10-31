import { describe, expect, it } from 'vitest'

import { planInboundDispatch } from '../../src/core/ocr/pipeline.ts'
import type { BubblePane } from '../../src/core/ocr/types.ts'

const PANE: BubblePane = { left: 360, right: 1194, top: 80, bottom: 720 }

describe('OCR 投递决策（pipeline.ts 纯函数，OCR-H2/M1 回归）', () => {
  it('captureId / ack 透传，nextAck 用本次快照号', () => {
    const plan = planInboundDispatch({
      captureId: 'cap-9',
      ack: 'cap-8',
      pane: PANE,
      messages: [{ id: 'pc-1', text: '在吗', side: 'left', box: { x: 380, y: 200, width: 60, height: 28 } }],
    })
    expect(plan.captureId).toBe('cap-9')
    expect(plan.ack).toBe('cap-8')
    expect(plan.nextAck).toBe('cap-9')
    expect(plan.accepted).toEqual([{ id: 'pc-1', text: '在吗', captureId: 'cap-9', side: 'left' }])
    expect(plan.rejected).toEqual([])
  })

  it('自己消息（outbound）与越线长气泡（uncertain）拒绝投递并分别计数', () => {
    const plan = planInboundDispatch({
      captureId: 'cap-9',
      pane: PANE,
      messages: [
        { id: 'a', text: '对方的短消息', box: { x: 380, y: 200, width: 60, height: 28 } },
        { id: 'b', text: '自己的短消息', box: { x: 1100, y: 220, width: 60, height: 28 } },
        { id: 'c', text: '越线的长气泡', box: { x: 380, y: 240, width: 800, height: 28 } },
      ],
    })
    expect(plan.accepted.map((item) => item.text)).toEqual(['对方的短消息'])
    expect(plan.accepted[0]?.side).toBe('left')
    expect(plan.rejected.map((item) => item.reason)).toEqual(['outbound', 'uncertain'])
    expect(plan.outboundCount).toBe(1)
    expect(plan.uncertainCount).toBe(1)
  })

  it('气泡几何归属映射为入站；越线长气泡绝不当入站（100 组）', () => {
    for (let i = 0; i < 100; i += 1) {
      const plan = planInboundDispatch({
        captureId: 'cap-5',
        pane: PANE,
        messages: [
          { id: `in-${i}`, text: `对方${i}`, box: { x: 380 + (i % 5), y: 200, width: 80, height: 28 } },
          { id: `long-${i}`, text: `对方长气泡${i}`.repeat(4), box: { x: 378, y: 240, width: 802, height: 28 } },
          { id: `out-${i}`, text: `自己${i}`, box: { x: 1100, y: 280, width: 64, height: 28 } },
        ],
      })
      expect(plan.accepted.map((item) => item.id)).toEqual([`in-${i}`])
      expect(plan.uncertainCount).toBe(1)
      expect(plan.outboundCount).toBe(1)
    }
  })

  it('旧脚本输出（无 captureId/pane/box/side）按 legacy 全部接受，保持向后兼容', () => {
    const plan = planInboundDispatch({
      messages: [
        { id: 'm1', text: '在吗' },
        { id: 'm2', text: '在的' },
        { id: 'm3', text: '吃了吗' },
      ],
    })
    expect(plan.accepted.map((item) => item.id)).toEqual(['m1', 'm2', 'm3'])
    expect(plan.legacyCount).toBe(3)
    expect(plan.captureId).toBe('')
    expect(plan.nextAck).toBe('')
  })

  it('只有 side 时按 side 字段判定，unknown 视为 uncertain 不投递', () => {
    const plan = planInboundDispatch({
      captureId: 'cap-2',
      messages: [
        { id: 'l', text: '左', side: 'left' },
        { id: 'r', text: '右', side: 'right' },
        { id: 'u', text: '未知', side: 'unknown' },
      ],
    })
    expect(plan.accepted.map((item) => item.id)).toEqual(['l'])
    expect(plan.accepted[0]?.side).toBe('left')
    expect(plan.rejected.map((item) => item.reason)).toEqual(['outbound', 'uncertain'])
  })

  it('空文本拒绝；同一批重复 id 只投递一次', () => {
    const plan = planInboundDispatch({
      captureId: 'cap-2',
      pane: PANE,
      messages: [
        { id: 'x', text: '   ', box: { x: 380, y: 200, width: 60, height: 28 } },
        { id: 'y', text: '在吗', box: { x: 380, y: 240, width: 60, height: 28 } },
        { id: 'y', text: '在吗', box: { x: 380, y: 240, width: 60, height: 28 } },
      ],
    })
    expect(plan.accepted.map((item) => item.id)).toEqual(['y'])
    expect(plan.rejected.map((item) => item.reason)).toEqual(['empty', 'duplicate'])
    expect(plan.duplicateCount).toBe(1)
  })

  it('缺少 id 时按文本 + 序号生成确定性 id（同一批稳定）', () => {
    const input = {
      captureId: 'cap-3',
      pane: PANE,
      messages: [{ text: '在吗', box: { x: 380, y: 200, width: 60, height: 28 } }],
    }
    const first = planInboundDispatch(input)
    const second = planInboundDispatch(input)
    expect(first.accepted[0]?.id).toMatch(/^pc-[0-9a-f]{12}-0$/)
    expect(first.accepted[0]?.id).toBe(second.accepted[0]?.id)
  })

  it('非法 captureId/ack 不进入 ack 水位线（nextAck 为空）', () => {
    const plan = planInboundDispatch({
      captureId: 'garbage',
      ack: 'garbage',
      messages: [{ id: 'm', text: '在吗' }],
    })
    expect(plan.captureId).toBe('garbage')
    expect(plan.ack).toBe('garbage')
    expect(plan.nextAck).toBe('')
    expect(plan.accepted).toHaveLength(1)
  })

  it('captureId 带后缀也能作为 ack 水位线透传', () => {
    const plan = planInboundDispatch({ captureId: 'cap-12-abcd1234', messages: [{ id: 'm', text: '在吗' }] })
    expect(plan.nextAck).toBe('cap-12-abcd1234')
  })
})

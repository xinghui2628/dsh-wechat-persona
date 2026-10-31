import { describe, expect, it } from 'vitest'

import {
  classifyBubble,
  classifyBubbles,
  inboundBubbles,
  ownershipToSide,
} from '../../src/core/ocr/bubbles.ts'
import type { BubbleLineInput, BubblePane } from '../../src/core/ocr/types.ts'

// 窗口 1200 宽：左侧会话列表 360px，右侧聊天面板 360..1194；顶部标题栏 80px，底部输入区 720px 以下。
const PANE: BubblePane = { left: 360, right: 1194, top: 80, bottom: 720 }

function line(text: string, x: number, width: number, y = 200): BubbleLineInput {
  return { text, box: { x, y, width, height: 28 } }
}

describe('气泡归属（bubbles.ts 纯函数）', () => {
  it('左侧短气泡判 inbound（对方消息）', () => {
    const result = classifyBubble(line('在吗', 380, 60), PANE)
    expect(result.ownership).toBe('inbound')
    expect(result.side).toBe('left')
    expect(result.reason).toBe('inbound')
  })

  it('右侧短气泡判 outbound（自己消息），不得当入站', () => {
    const result = classifyBubble(line('嗯', 1100, 60), PANE)
    expect(result.ownership).toBe('outbound')
    expect(result.side).toBe('right')
    expect(result.reason).toBe('outbound')
  })

  it('长气泡同时贴住左右边界（越过对侧锚点）判 uncertain', () => {
    const result = classifyBubble(line('这是一条非常长的消息'.repeat(6), 380, 800), PANE)
    expect(result.ownership).toBe('uncertain')
    expect(result.side).toBe('unknown')
    expect(result.reason).toBe('spans-both-margins')
  })

  it('左锚定但中心越过中线（长气泡越线）判 uncertain，不得当入站', () => {
    // 收紧左右容差后可以构造「左边贴边、中心已越过中线」的越线长气泡。
    const result = classifyBubble(line('越线的长气泡', 380, 795), PANE, {
      leftMarginRatio: 0.2,
      rightMarginRatio: 0.01,
    })
    expect(result.ownership).toBe('uncertain')
    expect(result.side).toBe('unknown')
    expect(result.reason).toBe('inbound-crosses-center')
  })

  it('右锚定但中心在中线左侧（自己长气泡越线）判 uncertain', () => {
    const result = classifyBubble(line('自己的长气泡', 430, 600), PANE, {
      leftMarginRatio: 0.01,
      rightMarginRatio: 0.2,
    })
    expect(result.ownership).toBe('uncertain')
    expect(result.reason).toBe('outbound-crosses-center')
  })

  it('既不贴左也不贴右的漂浮文本判 uncertain（宁可不回也不猜）', () => {
    const result = classifyBubble(line('漂浮', 600, 100), PANE)
    expect(result.ownership).toBe('uncertain')
    expect(result.reason).toBe('unknown-alignment')
  })

  it('标题栏/输入框等窗格外的行判 uncertain（不消费）', () => {
    expect(classifyBubble(line('微信', 500, 60, 20), PANE).reason).toBe('outside-pane')
    expect(classifyBubble(line('长按说话', 500, 80, 760), PANE).reason).toBe('outside-pane')
    expect(classifyBubble(line('列表里的名字', 40, 100), PANE).reason).toBe('outside-pane')
  })

  it('无效 box / 无效 pane 一律判 uncertain', () => {
    expect(classifyBubble({ text: '', box: { x: 380, y: 200, width: 0, height: 28 } }, PANE).reason).toBe('invalid-box')
    expect(classifyBubble(line('在吗', 380, 60), { left: 500, right: 400, top: 80, bottom: 720 }).reason).toBe('invalid-pane')
  })

  it('批量分类：inboundBubbles 只返回可投递的对方消息，outbound/uncertain 全部过滤（100 组）', () => {
    for (let i = 0; i < 100; i += 1) {
      const lines: BubbleLineInput[] = [
        line(`对方短消息${i}`, 380 + (i % 7), 60),
        line(`自己短消息${i}`, 1100 - (i % 5), 60),
        line(`越线长消息${i}`.repeat(8), 378, 802),
        line(`漂浮${i}`, 600, 80),
      ]
      const result = classifyBubbles(lines, PANE)
      expect(result).toHaveLength(4)
      const inbound = inboundBubbles(lines, PANE)
      expect(inbound).toHaveLength(1)
      expect(inbound[0]).toEqual(result[0])
      expect(result.map((item) => item.ownership)).toEqual(['inbound', 'outbound', 'uncertain', 'uncertain'])
    }
  })

  it('ownershipToSide：inbound→left，outbound→right，uncertain→unknown', () => {
    expect(ownershipToSide('inbound')).toBe('left')
    expect(ownershipToSide('outbound')).toBe('right')
    expect(ownershipToSide('uncertain')).toBe('unknown')
  })
})

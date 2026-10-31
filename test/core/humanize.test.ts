import { describe, expect, it } from 'vitest'
import type { StickerChoice } from '../../src/types.ts'
import { clampText, planHumanReply } from '../../src/core/humanize.ts'
import type { WechatPersonaConfig } from '../../src/config.ts'
import { FakeStickers, SeqRandom, testConfig } from './fakes.ts'

function humanizeConfig(mutate?: (config: WechatPersonaConfig) => void): WechatPersonaConfig {
  return testConfig((config) => {
    config.reply.maxChars = 200
    config.reply.splitProbability = 0
    config.reply.maxSplitParts = 3
    config.reply.stickerProbability = 0
    config.reply.stickerNoRepeatCount = 8
    config.reply.typingMinMs = 800
    config.reply.typingMaxMs = 5000
    if (mutate) mutate(config)
  })
}

const noStickers = new FakeStickers([])

const happyChoices: StickerChoice[] = [
  { id: 'sA', category: 'happy', file: '/stickers/happy/a.png' },
  { id: 'sB', category: 'happy', file: '/stickers/happy/b.png' },
  { id: 'sC', category: 'happy', file: '/stickers/happy/c.png' },
]

describe('clampText', () => {
  it('按字符数截断', () => {
    expect(clampText('abcdef', 3)).toBe('abc')
    expect(clampText('你好世界', 2)).toBe('你好')
    expect(clampText('😀😀😀', 2)).toBe('😀😀')
    expect(clampText('abc', 10)).toBe('abc')
    expect(clampText('abc', 0)).toBe('')
  })
})

describe('planHumanReply', () => {
  it('短文本不拆条，typingMs 在 [800,5000]', () => {
    const random = new SeqRandom([0.999, 0.999])
    const plan = planHumanReply('好的', {
      config: humanizeConfig((config) => {
        config.reply.splitProbability = 1
      }),
      random,
      stickers: noStickers,
      recentStickerIds: [],
      emotion: 'neutral',
    })
    expect(plan.parts).toEqual([{ kind: 'text', text: '好的' }])
    expect(plan.splitCount).toBe(1)
    expect(plan.typingMs).toBeGreaterThanOrEqual(800)
    expect(plan.typingMs).toBeLessThanOrEqual(5000)
  })

  it('typingMs 下限为 800（随机数 0）', () => {
    const plan = planHumanReply('好', {
      config: humanizeConfig(),
      random: new SeqRandom([0, 0]),
      stickers: noStickers,
      recentStickerIds: [],
      emotion: 'neutral',
    })
    expect(plan.typingMs).toBe(800)
  })

  it('长文本按句末标点拆条，且不超过 maxSplitParts', () => {
    const plan = planHumanReply('第一句。第二句。第三句。第四句。第五句。', {
      config: humanizeConfig((config) => {
        config.reply.splitProbability = 1
        config.reply.maxSplitParts = 3
      }),
      random: new SeqRandom([0.1, 0.5, 0.99]),
      stickers: noStickers,
      recentStickerIds: [],
      emotion: 'neutral',
    })
    expect(plan.parts.length).toBe(3)
    expect(plan.splitCount).toBe(3)
    for (const part of plan.parts) expect(part.kind).toBe('text')
    // 尾部多条被合并进最后一条，消息内容不丢
    const mergedText = plan.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')
    expect(mergedText).toContain('第五句')
  })

  it('maxSplitParts 被 clamp 到 1..3', () => {
    const plan = planHumanReply('第一句。第二句。第三句。', {
      config: humanizeConfig((config) => {
        config.reply.splitProbability = 1
        config.reply.maxSplitParts = 1
      }),
      random: new SeqRandom([0.1, 0.5, 0.99]),
      stickers: noStickers,
      recentStickerIds: [],
      emotion: 'neutral',
    })
    expect(plan.parts.length).toBe(1)
  })

  it('maxChars 先截断再拆条', () => {
    const plan = planHumanReply('一二三四五六七八', {
      config: humanizeConfig((config) => {
        config.reply.maxChars = 5
      }),
      random: new SeqRandom([0.5, 0.99]),
      stickers: noStickers,
      recentStickerIds: [],
      emotion: 'neutral',
    })
    expect(plan.parts).toEqual([{ kind: 'text', text: '一二三四五' }])
  })

  it('表情不重复：pick 排除 recentStickerIds', () => {
    const stickers = new FakeStickers(happyChoices)
    const plan = planHumanReply('好呀', {
      config: humanizeConfig((config) => {
        config.reply.stickerProbability = 1
        config.reply.stickerNoRepeatCount = 8
      }),
      random: new SeqRandom([0.5, 0.1]),
      stickers,
      recentStickerIds: ['sA', 'sB'],
      emotion: 'happy',
    })
    expect(plan.parts.length).toBe(2)
    expect(plan.parts[1]).toEqual({ kind: 'sticker', stickerId: 'sC', file: '/stickers/happy/c.png' })
    expect(stickers.pickCalls[0]?.category).toBe('happy')
    expect(stickers.pickCalls[0]?.recentIds).toEqual(['sA', 'sB'])
    expect(plan.splitCount).toBe(2)
  })

  it('只排除最后 stickerNoRepeatCount 个最近表情', () => {
    const choices: StickerChoice[] = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'new'].map((id) => ({
      id,
      category: 'happy',
      file: `/stickers/happy/${id}.png`,
    }))
    const stickers = new FakeStickers(choices)
    const recent = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']
    const plan = planHumanReply('好呀', {
      config: humanizeConfig((config) => {
        config.reply.stickerProbability = 1
        config.reply.stickerNoRepeatCount = 3
      }),
      random: new SeqRandom([0.5, 0.1]),
      stickers,
      recentStickerIds: recent,
      emotion: 'happy',
    })
    expect(stickers.pickCalls[0]?.recentIds).toEqual(['r8', 'r9', 'r10'])
    expect(plan.parts.length).toBe(2)
  })

  it('分类无可用表情时用 pickAny 兜底', () => {
    const stickers = new FakeStickers(happyChoices)
    const plan = planHumanReply('抱抱', {
      config: humanizeConfig((config) => {
        config.reply.stickerProbability = 1
      }),
      random: new SeqRandom([0.5, 0.1]),
      stickers,
      recentStickerIds: [],
      emotion: 'comfort',
    })
    expect(stickers.pickCalls[0]?.category).toBe('comfort')
    expect(stickers.anyCalls.length).toBe(1)
    expect(plan.parts.length).toBe(2)
    expect(plan.parts[1]?.kind).toBe('sticker')
  })

  it('贴纸库为空或随机未命中时不追加表情', () => {
    const empty = new FakeStickers([])
    const planEmpty = planHumanReply('好呀', {
      config: humanizeConfig((config) => {
        config.reply.stickerProbability = 1
      }),
      random: new SeqRandom([0.5, 0.1]),
      stickers: empty,
      recentStickerIds: [],
      emotion: 'happy',
    })
    expect(planEmpty.parts.length).toBe(1)

    const stickers = new FakeStickers(happyChoices)
    const planMiss = planHumanReply('好呀', {
      config: humanizeConfig((config) => {
        config.reply.stickerProbability = 0.25
      }),
      random: new SeqRandom([0.5, 0.9]),
      stickers,
      recentStickerIds: [],
      emotion: 'happy',
    })
    expect(planMiss.parts.length).toBe(1)
    expect(stickers.pickCalls.length).toBe(0)
  })
})

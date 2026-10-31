import { describe, expect, it } from 'vitest'
import {
  boxInsideRegion,
  containsBox,
  groupLinesIntoRows,
  iou,
  makeBox,
  mergeBoxes,
  fromLogicalBox,
  toLogicalBox,
  unionBox,
  verticalOverlapRatio,
} from '../../src/core/ocr/geometry.ts'
import {
  characterErrorRate,
  compareKey,
  isCjkChar,
  lcsSimilarity,
  levenshtein,
  looksLikeSameText,
  normalizeOcrText,
  textOverlapRatio,
  textSimilarity,
} from '../../src/core/ocr/normalize.ts'
import {
  applyControlledCorrection,
  correctOcrText,
  findProtectedSpans,
  looksGarbled,
  noiseScore,
  pickBetterText,
} from '../../src/core/ocr/correction.ts'

describe('ocr geometry', () => {
  it('IoU 计算与完全重合', () => {
    const a = makeBox(0, 0, 10, 10)
    expect(iou(a, a)).toBeCloseTo(1, 5)
    const b = makeBox(5, 0, 10, 10)
    expect(iou(a, b)).toBeCloseTo(1 / 3, 5)
    expect(iou(a, makeBox(100, 100, 10, 10))).toBe(0)
  })

  it('invalid box 安全处理', () => {
    expect(iou(makeBox(0, 0, 0, 0), makeBox(0, 0, 5, 5))).toBe(0)
    expect(boxInsideRegion(makeBox(0, 0, 0, 0), makeBox(0, 0, 10, 10))).toBe(false)
  })

  it('containsBox 只容忍 1px', () => {
    expect(containsBox(makeBox(0, 0, 10, 10), makeBox(1, 1, 5, 5))).toBe(true)
    expect(containsBox(makeBox(0, 0, 10, 10), makeBox(9, 9, 5, 5))).toBe(false)
  })

  it('union/merge 取外接框', () => {
    const merged = mergeBoxes([makeBox(0, 0, 10, 10), makeBox(20, 5, 10, 10)])
    expect(merged).toEqual({ x: 0, y: 0, width: 30, height: 15 })
    expect(unionBox(null, makeBox(1, 2, 3, 4))).toEqual(makeBox(1, 2, 3, 4))
  })

  it('坐标模型换算可逆', () => {
    const box = makeBox(100, 50, 200, 40)
    const logical = toLogicalBox(box, 1.5)
    expect(logical.x).toBeCloseTo(100 / 1.5, 5)
    expect(logical.y).toBeCloseTo(50 / 1.5, 5)
    expect(logical.width).toBeCloseTo(200 / 1.5, 5)
    expect(logical.height).toBeCloseTo(40 / 1.5, 5)
    const back = fromLogicalBox(logical, 1.5)
    expect(back.x).toBeCloseTo(box.x, 5)
    expect(back.y).toBeCloseTo(box.y, 5)
    expect(back.width).toBeCloseTo(box.width, 5)
    expect(back.height).toBeCloseTo(box.height, 5)
  })

  it('同一行带的行合并成 row', () => {
    const rows = groupLinesIntoRows([
      { text: '今', box: makeBox(10, 100, 20, 20) },
      { text: '天', box: makeBox(32, 101, 20, 20) },
      { text: '好', box: makeBox(10, 140, 20, 20) },
    ])
    expect(rows.length).toBe(2)
    expect(rows[0].map((r) => r.text)).toEqual(['今', '天'])
  })

  it('verticalOverlapRatio 衡量同一水平带', () => {
    expect(verticalOverlapRatio(makeBox(0, 0, 10, 20), makeBox(5, 2, 10, 20))).toBeCloseTo(0.9, 5)
    expect(verticalOverlapRatio(makeBox(0, 0, 10, 20), makeBox(5, 30, 10, 20))).toBe(0)
  })
})

describe('ocr normalize', () => {
  it('删除 CJK 之间的空格但保留英文单词空格', () => {
    expect(normalizeOcrText('今 天 大 肥 鱼 很 好 吃')).toBe('今天大肥鱼很好吃')
    expect(normalizeOcrText('hello world 你 好')).toBe('hello world 你好')
    expect(normalizeOcrText('  a  b  ')).toBe('a b')
  })

  it('compareKey 去掉空白标点并全角转半角', () => {
    expect(compareKey('你好，世界！')).toBe('你好世界')
    expect(compareKey('ＡＢＣ　123')).toBe('abc123')
  })

  it('isCjkChar 覆盖扩展区', () => {
    expect(isCjkChar('你')).toBe(true)
    expect(isCjkChar('a')).toBe(false)
    expect(isCjkChar('𠀀')).toBe(true)
  })

  it('levenshtein 与 CER', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(characterErrorRate('今天真好', '今天真好')).toBe(0)
    expect(characterErrorRate('今天真', '今天真好')).toBeCloseTo(0.25, 5)
    expect(characterErrorRate('abc', '')).toBe(1)
    expect(characterErrorRate('', '')).toBe(0)
  })

  it('textSimilarity 与 lcsSimilarity 对称且 0..1 钳制', () => {
    expect(textSimilarity('今天真好', '今天真好')).toBe(1)
    expect(lcsSimilarity('我想拉高你的幽默度', '我想拉高你的幽黑度')).toBeGreaterThan(0.8)
    expect(textSimilarity('完全不同的句子', '今天吃了吗')).toBeGreaterThanOrEqual(0)
  })

  it('textOverlapRatio 用多重集交集', () => {
    expect(textOverlapRatio('今天真好', '今天真好')).toBe(1)
    expect(textOverlapRatio('abc', '')).toBe(0)
    expect(textOverlapRatio('ab', 'abcd')).toBeCloseTo(4 / 6, 5)
  })

  it('looksLikeSameText 容忍 OCR 截断/形近字', () => {
    expect(looksLikeSameText('我想拉高你的幽', '我想拉高你的幽默度')).toBe(true)
    expect(looksLikeSameText('完全无关', '今天吃了吗')).toBe(false)
    expect(looksLikeSameText('a', 'b')).toBe(false)
  })
})

describe('ocr correction quality（v0.2.8 兼容行为）', () => {
  it('noiseScore：纯中文干净文本为 0', () => {
    expect(noiseScore('今天天气不错')).toBe(0)
    expect(noiseScore('')).toBe(100)
    expect(noiseScore('今天ab')).toBeGreaterThan(0)
  })

  it('looksGarbled：残缺偏旁/中英混杂判可疑', () => {
    expect(looksGarbled('今天天气不错')).toBe(false)
    expect(looksGarbled('今天讠语')).toBe(true)
    expect(looksGarbled('你好ab')).toBe(true)
    expect(looksGarbled('')).toBe(false)
  })

  it('pickBetterText：噪声低优先，接近时取更长', () => {
    expect(pickBetterText('今天讠语', '今天天气')).toBe('今天天气')
    expect(pickBetterText('你好', '你好呀')).toBe('你好呀')
    expect(pickBetterText('', '你好')).toBe('你好')
  })
})

describe('ocr correction 受控纠错', () => {
  it('高频词形近字被纠正', () => {
    expect(correctOcrText('我想拉高你的幽黑度')).toBe('我想拉高你的幽默度')
  })

  it('词表可追加（联系人名由配置传入，不写死在源码）', () => {
    expect(correctOcrText('咱俩定个暗号，我说大吧鱼', ['大肥鱼'])).toContain('大肥鱼')
  })

  it('敏感信息不得被改写：手机号/金额/wxid/邮箱/验证码/日期', () => {
    const samples = [
      '我的手机号是13800001111',
      '转账 128.50 元给你',
      'wxid_abc123def 是我的',
      '邮箱 a1b2@example.com',
      '验证码 889900 别告诉别人',
      '2026-10-31 见',
    ]
    for (const sample of samples) {
      expect(findProtectedSpans(sample).length, sample).toBeGreaterThan(0)
      const result = applyControlledCorrection(sample)
      expect(result.text, sample).toBe(sample)
      expect(result.changes.length, sample).toBe(0)
    }
  })

  it('敏感区段内的形近字候选被跳过并计数', () => {
    const result = applyControlledCorrection('订单号 12345678 已发货')
    expect(result.protectedSkipped).toBeGreaterThanOrEqual(0)
    expect(result.text).toBe('订单号 12345678 已发货')
  })

  it('level=none 完全不改', () => {
    expect(applyControlledCorrection('幽黑度', [], { level: 'none' }).text).toBe('幽黑度')
  })

  it('变更明细可审计', () => {
    const result = applyControlledCorrection('我想拉高你的幽黑度')
    expect(result.changes.length).toBe(1)
    expect(result.changes[0]).toMatchObject({ from: '幽黑度', to: '幽默度' })
    expect(result.text).toBe('我想拉高你的幽默度')
  })
})

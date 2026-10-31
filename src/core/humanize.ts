/**
 * 拟人化：把模型输出变成“像人发的”一组消息（分条 + 打字耗时 + 表情包）。
 *
 * 随机源通过 ctx.random 注入（测试可给固定序列），不读全局 Math.random，
 * 保证同一输入 + 同一随机序列可复现。
 */

import type { Emotion, OutboundPart, Random, StickerCatalogLike } from '../types.ts'
import type { WechatPersonaConfig } from '../config.ts'

/** 一条回复的拟人化计划。 */
export interface HumanPlan {
  /** 要依次发送的消息片段（文本 + 可选表情）。 */
  parts: OutboundPart[]
  /** 发送前“正在输入”的等待毫秒数。 */
  typingMs: number
  /** 片段总数（= parts.length，含表情）。 */
  splitCount: number
}

/** 打字耗时硬边界：太快不像人，太慢像掉线。 */
const TYPING_MIN_MS = 800
const TYPING_MAX_MS = 5000
/** 只有足够长的回复才值得拆条。 */
const SPLIT_MIN_CHARS = 12
/** 句末标点/换行处切分（零宽断言，保留标点在句尾）。 */
const SENTENCE_BOUNDARY = /(?<=[。！？!?…；;\n])/u

/** 任意输入 -> 有限数，非法返回 fallback。 */
function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** clamp 成 [min, max] 的整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Math.trunc(finiteNumber(value, fallback))
  return Math.min(max, Math.max(min, num))
}

/** clamp 成 [0, 1] 的概率。 */
function clamp01(value: unknown, fallback: number): number {
  return Math.min(1, Math.max(0, finiteNumber(value, fallback)))
}

/** 按 code point 截断到 maxChars；maxChars 非法/<=0 时返回空串。 */
export function clampText(text: string, maxChars: number): string {
  const source = typeof text === 'string' ? text : ''
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : 0
  const chars = [...source]
  return chars.length <= limit ? source : chars.slice(0, limit).join('')
}

/**
 * 按句末标点/换行拆条。
 * 拆出的条数若超过 maxParts，则把尾部几条合并成一条（宁可一条长点，也不刷屏）。
 */
function splitBySentence(text: string, maxParts: number): string[] {
  if (maxParts <= 1) return [text]
  const pieces = text
    .split(SENTENCE_BOUNDARY)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
  if (pieces.length <= 1) return [text]
  if (pieces.length <= maxParts) return pieces
  const kept = pieces.slice(0, maxParts - 1)
  kept.push(pieces.slice(maxParts - 1).join(''))
  return kept
}

/**
 * 生成拟人化发送计划。
 *
 * 步骤（随机数按 拆条 -> 打字耗时 -> 表情 的顺序消费）：
 * 1. clamp 到 reply.maxChars；
 * 2. random < splitProbability 且长度 > 12：按句末标点/换行拆成 ≤ maxSplitParts 条；
 * 3. typingMs = clamp(typingMin + random*(typingMax-typingMin), 800, 5000)；
 * 4. random < stickerProbability 且贴纸库非空：优先当前情绪分类，pick 排除最近
 *    recentStickerIds 的最后 stickerNoRepeatCount 个；pick 失败用 pickAny；
 *    仍失败则不发表情（绝不因为没表情包而抛错）；
 * 5. splitCount = parts.length。
 */
export function planHumanReply(
  text: string,
  ctx: {
    config: WechatPersonaConfig
    random: Random
    stickers: StickerCatalogLike
    recentStickerIds: readonly string[]
    emotion: Emotion
  },
): HumanPlan {
  const reply = ctx?.config?.reply
  const random = ctx?.random
  const draw = (): number => {
    const value = random?.next?.()
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
  }

  const maxChars = clampInt(reply?.maxChars, 60, 1, 2000)
  const clamped = clampText(text, maxChars)

  const maxSplitParts = clampInt(reply?.maxSplitParts, 3, 1, 3)
  const splitProbability = clamp01(reply?.splitProbability, 0.35)
  const textParts: OutboundPart[] = []
  if (clamped.length > 0) {
    const charsLen = [...clamped].length
    const wantSplit = charsLen > SPLIT_MIN_CHARS && draw() < splitProbability
    const pieces = wantSplit ? splitBySentence(clamped, maxSplitParts) : [clamped]
    for (const piece of pieces) {
      if (piece !== '') textParts.push({ kind: 'text', text: piece })
    }
    if (textParts.length === 0) textParts.push({ kind: 'text', text: clamped })
  }

  const typingMin = clampInt(reply?.typingMinMs, TYPING_MIN_MS, TYPING_MIN_MS, TYPING_MAX_MS)
  const typingMax = clampInt(reply?.typingMaxMs, TYPING_MAX_MS, TYPING_MIN_MS, TYPING_MAX_MS)
  const low = Math.min(typingMin, typingMax)
  const high = Math.max(typingMin, typingMax)
  const typingRaw = low + draw() * (high - low)
  const typingMs = Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, Math.round(typingRaw)))

  const parts: OutboundPart[] = [...textParts]
  const stickerProbability = clamp01(reply?.stickerProbability, 0.25)
  const noRepeat = clampInt(reply?.stickerNoRepeatCount, 8, 0, 100)
  if (textParts.length > 0 && ctx?.stickers && draw() < stickerProbability) {
    try {
      if (ctx.stickers.count() > 0) {
        const recentIds = Array.isArray(ctx.recentStickerIds) ? ctx.recentStickerIds : []
        const excludeIds = noRepeat > 0 ? recentIds.slice(-noRepeat) : []
        const choice = ctx.stickers.pick(ctx.emotion, excludeIds) ?? ctx.stickers.pickAny(excludeIds)
        if (choice) parts.push({ kind: 'sticker', stickerId: choice.id, file: choice.file })
      }
    } catch {
      // 贴纸库异常不应阻断发送：最多是不发这条表情
    }
  }

  return { parts, typingMs, splitCount: parts.length }
}

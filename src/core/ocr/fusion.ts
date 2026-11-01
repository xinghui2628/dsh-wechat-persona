import { centerDistance, iou, isHorizontallyAdjacent, isValidBox, verticalOverlapRatio } from './geometry.ts'
import type { OcrBox } from './types.ts'

/**
 * 参与几何匹配的一行文本。OcrLine 结构兼容（多出的字段忽略）。
 * bubbleId 可选：调用方按气泡/消息块给出分组标识，同气泡优先匹配。
 */
export interface FusionLine {
  text: string
  box: OcrBox
  bubbleId?: string
  /** 原生置信度（引擎提供时才存在；不提供则不参与任何推断） */
  confidence?: number
}

export interface LineMatchOptions {
  /** 低于该分数不视为同一区域 */
  minScore?: number
  /** 中心距超过「行高 × 该倍数」直接排除 */
  maxCenterDistanceRatio?: number
  weightIou?: number
  weightCenter?: number
  weightVertical?: number
  weightAdjacency?: number
  /** 同气泡额外加分（上限仍为 1） */
  sameBubbleBonus?: number
  /** 气泡标识解析器（默认读 line.bubbleId） */
  bubbleOf?: (line: FusionLine) => string | undefined
}

export interface LineMatch {
  primary: FusionLine
  secondary: FusionLine
  /** 综合几何分 0..1 */
  score: number
  iou: number
  centerScore: number
  verticalScore: number
  adjacencyScore: number
  /** 两行都被标注了气泡且为同一个 */
  sameBubble: boolean
}

export interface MatchLinesResult {
  pairs: LineMatch[]
  unmatchedPrimary: FusionLine[]
  unmatchedSecondary: FusionLine[]
}

interface ResolvedOptions {
  minScore: number
  maxCenterDistanceRatio: number
  weightIou: number
  weightCenter: number
  weightVertical: number
  weightAdjacency: number
  sameBubbleBonus: number
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  minScore: 0.35,
  maxCenterDistanceRatio: 2,
  weightIou: 0.35,
  weightCenter: 0.25,
  weightVertical: 0.25,
  weightAdjacency: 0.15,
  sameBubbleBonus: 0.1,
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function bubbleOf(line: FusionLine, resolver?: (line: FusionLine) => string | undefined): string | undefined {
  if (resolver) {
    try {
      return resolver(line)
    } catch {
      return undefined
    }
  }
  return line.bubbleId
}

/** 两行的几何相似分；返回 null 表示可直接排除（无效框 / 跨气泡 / 中心距过远）。 */
function scorePair(
  primary: FusionLine,
  secondary: FusionLine,
  options: ResolvedOptions,
  resolver?: (line: FusionLine) => string | undefined,
): Omit<LineMatch, 'primary' | 'secondary'> | null {
  if (!isValidBox(primary.box) || !isValidBox(secondary.box)) return null
  const primaryBubble = bubbleOf(primary, resolver)
  const secondaryBubble = bubbleOf(secondary, resolver)
  if (primaryBubble && secondaryBubble && primaryBubble !== secondaryBubble) return null
  const sameBubble = Boolean(primaryBubble && secondaryBubble && primaryBubble === secondaryBubble)

  const maxHeight = Math.max(primary.box.height, secondary.box.height)
  const distance = centerDistance(primary.box, secondary.box)
  if (distance > maxHeight * options.maxCenterDistanceRatio) return null

  const iouValue = clamp01(iou(primary.box, secondary.box))
  const centerScore = clamp01(1 - distance / (2 * Math.max(maxHeight, 1)))
  const verticalScore = clamp01(verticalOverlapRatio(primary.box, secondary.box))
  const adjacencyScore = isHorizontallyAdjacent(primary.box, secondary.box, 1.2) ? 1 : 0
  const raw =
    options.weightIou * iouValue +
    options.weightCenter * centerScore +
    options.weightVertical * verticalScore +
    options.weightAdjacency * adjacencyScore +
    (sameBubble ? options.sameBubbleBonus : 0)
  const score = clamp01(raw)
  if (score < options.minScore) return null
  return { score, iou: iouValue, centerScore, verticalScore, adjacencyScore, sameBubble }
}

/**
 * 同帧两引擎行的一对一几何匹配（设计文档 6.2）。
 * - 只看几何（框、行高、气泡分组），不比较文本长度，避免「谁长谁赢」；
 * - 一条 secondary 最多匹配一条 primary；按分数降序贪心，稳定且可复现；
 * - 跨气泡（两侧都有 bubbleId 且不同）的候选直接排除。
 */
export function matchLines(
  primary: FusionLine[],
  secondary: FusionLine[],
  options: LineMatchOptions = {},
): MatchLinesResult {
  const config: ResolvedOptions = {
    minScore: options.minScore ?? DEFAULT_OPTIONS.minScore,
    maxCenterDistanceRatio: options.maxCenterDistanceRatio ?? DEFAULT_OPTIONS.maxCenterDistanceRatio,
    weightIou: options.weightIou ?? DEFAULT_OPTIONS.weightIou,
    weightCenter: options.weightCenter ?? DEFAULT_OPTIONS.weightCenter,
    weightVertical: options.weightVertical ?? DEFAULT_OPTIONS.weightVertical,
    weightAdjacency: options.weightAdjacency ?? DEFAULT_OPTIONS.weightAdjacency,
    sameBubbleBonus: options.sameBubbleBonus ?? DEFAULT_OPTIONS.sameBubbleBonus,
  }
  const resolver = options.bubbleOf
  const candidates: Array<LineMatch & { primaryIndex: number; secondaryIndex: number }> = []
  for (let primaryIndex = 0; primaryIndex < primary.length; primaryIndex += 1) {
    for (let secondaryIndex = 0; secondaryIndex < secondary.length; secondaryIndex += 1) {
      const primaryLine = primary[primaryIndex]!
      const secondaryLine = secondary[secondaryIndex]!
      const scored = scorePair(primaryLine, secondaryLine, config, resolver)
      if (!scored) continue
      candidates.push({
        primary: primaryLine,
        secondary: secondaryLine,
        primaryIndex,
        secondaryIndex,
        ...scored,
      })
    }
  }
  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (left.primaryIndex !== right.primaryIndex) return left.primaryIndex - right.primaryIndex
    return left.secondaryIndex - right.secondaryIndex
  })

  const usedPrimary = new Set<number>()
  const usedSecondary = new Set<number>()
  const pairs: LineMatch[] = []
  for (const candidate of candidates) {
    if (usedPrimary.has(candidate.primaryIndex) || usedSecondary.has(candidate.secondaryIndex)) continue
    usedPrimary.add(candidate.primaryIndex)
    usedSecondary.add(candidate.secondaryIndex)
    pairs.push({
      primary: candidate.primary,
      secondary: candidate.secondary,
      score: candidate.score,
      iou: candidate.iou,
      centerScore: candidate.centerScore,
      verticalScore: candidate.verticalScore,
      adjacencyScore: candidate.adjacencyScore,
      sameBubble: candidate.sameBubble,
    })
  }
  // 按阅读顺序（primary 原始顺序）输出，方便上层消费
  pairs.sort((left, right) => primary.indexOf(left.primary) - primary.indexOf(right.primary))

  return {
    pairs,
    unmatchedPrimary: primary.filter((line) => !usedPrimary.has(primary.indexOf(line))),
    unmatchedSecondary: secondary.filter((line) => !usedSecondary.has(secondary.indexOf(line))),
  }
}

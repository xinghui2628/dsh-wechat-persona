import { lcsSimilarity, compareKey } from './normalize.ts'
import type { OcrBox } from './types.ts'

/**
 * 参与序列对齐的一行文本（两引擎各自的行序列）。
 * bubbleId 可选：两侧都不为空且不同时禁止对齐（避免把其它气泡的行拼进来）。
 */
export interface AlignItem {
  text: string
  box?: OcrBox
  bubbleId?: string
}

export type AlignOp = 'match' | 'replace' | 'insert' | 'delete'

export interface AlignStep {
  op: AlignOp
  /** 来自左侧序列（系统 OCR） */
  a?: AlignItem
  /** 来自右侧序列（第二引擎） */
  b?: AlignItem
  aIndex: number
  bIndex: number
  cost: number
}

export interface AlignLineSequencesOptions {
  /** 替换代价上限系数：cost = min(1, factor * (1 - 相似度))，默认 2 */
  replaceCostFactor?: number
  /** 允许判为「同一行的形近字差异」的最低文本相似度，低于它只能删/增（默认 0.8） */
  minReplaceSimilarity?: number
  /** 气泡标识解析器（默认读 item.bubbleId） */
  bubbleOf?: (item: AlignItem) => string | undefined
}

export interface AlignResult {
  steps: AlignStep[]
  /** 序列编辑距离（match=0，replace=按相似度计，insert/delete=1） */
  distance: number
  /** 0..1，1 表示完全一致 */
  similarity: number
  matched: number
  replacements: number
  inserted: number
  deleted: number
}

/** 大于「删除+插入」代价的有限值：让跨气泡位置优先走 delete+insert 而不是强行替换。 */
const FORBIDDEN_SUBSTITUTION = 3

function bubbleOf(item: AlignItem, resolver?: (item: AlignItem) => string | undefined): string | undefined {
  if (resolver) {
    try {
      return resolver(item)
    } catch {
      return undefined
    }
  }
  return item.bubbleId
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/**
 * 顺序保持的 Levenshtein 对齐（设计文档 6.3）：
 * - 用 compareKey 判断文本是否相同；形近字差异按相似度计为 replace，而不是删一条+增一条；
 * - DP 天然保证顺序，不会把顺序倒置的行强行配对；
 * - 跨气泡（两侧都有 bubbleId 且不同）禁止替换，只能各自 delete/insert。
 */
export function alignLineSequences(
  a: AlignItem[],
  b: AlignItem[],
  options: AlignLineSequencesOptions = {},
): AlignResult {
  const replaceCostFactor = options.replaceCostFactor ?? 2
  const minReplaceSimilarity = options.minReplaceSimilarity ?? 0.8
  const rows = a.length
  const cols = b.length

  const substitutionCost = (left: AlignItem, right: AlignItem): number => {
    const leftBubble = bubbleOf(left, options.bubbleOf)
    const rightBubble = bubbleOf(right, options.bubbleOf)
    if (leftBubble && rightBubble && leftBubble !== rightBubble) return FORBIDDEN_SUBSTITUTION
    if (compareKey(left.text) === compareKey(right.text)) return 0
    const similarity = lcsSimilarity(left.text, right.text)
    // 文本不够相似时不允许「强行对齐」：代价高于删除+插入，DP 自然拆成两步
    if (similarity < minReplaceSimilarity) return FORBIDDEN_SUBSTITUTION
    return Math.min(1, replaceCostFactor * (1 - similarity))
  }

  // dp[i][j] = a[0..i) 与 b[0..j) 的最小编辑代价
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = 1; i <= rows; i += 1) dp[i]![0] = i
  for (let j = 1; j <= cols; j += 1) dp[0]![j] = j
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      const deleteCost = dp[i - 1]![j]! + 1
      const insertCost = dp[i]![j - 1]! + 1
      const replaceCost = dp[i - 1]![j - 1]! + substitutionCost(a[i - 1]!, b[j - 1]!)
      dp[i]![j] = Math.min(deleteCost, insertCost, replaceCost)
    }
  }

  const steps: AlignStep[] = []
  let i = rows
  let j = cols
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const left = a[i - 1]!
      const right = b[j - 1]!
      const cost = substitutionCost(left, right)
      if (approximateEqual(dp[i]![j]!, dp[i - 1]![j - 1]! + cost)) {
        const same = compareKey(left.text) === compareKey(right.text)
        steps.push({
          op: same ? 'match' : 'replace',
          a: left,
          b: right,
          aIndex: i - 1,
          bIndex: j - 1,
          cost: same ? 0 : cost,
        })
        i -= 1
        j -= 1
        continue
      }
    }
    if (i > 0 && (j === 0 || approximateEqual(dp[i]![j]!, dp[i - 1]![j]! + 1))) {
      steps.push({ op: 'delete', a: a[i - 1]!, aIndex: i - 1, bIndex: -1, cost: 1 })
      i -= 1
      continue
    }
    steps.push({ op: 'insert', b: b[j - 1]!, aIndex: -1, bIndex: j - 1, cost: 1 })
    j -= 1
  }
  steps.reverse()

  let matched = 0
  let replacements = 0
  let inserted = 0
  let deleted = 0
  let distance = 0
  for (const step of steps) {
    if (step.op === 'match') matched += 1
    else if (step.op === 'replace') replacements += 1
    else if (step.op === 'insert') inserted += 1
    else deleted += 1
    distance += step.op === 'match' ? 0 : step.op === 'replace' ? step.cost : 1
  }
  const maxLength = Math.max(rows, cols)
  const similarity = maxLength === 0 ? 1 : clamp01(1 - distance / maxLength)

  return { steps, distance, similarity, matched, replacements, inserted, deleted }
}

function approximateEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9
}

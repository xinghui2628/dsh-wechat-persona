import { iou, centerDistance } from './geometry.ts'
import { compareKey, lcsSimilarity } from './normalize.ts'
import type { BubbleSide, FrameDeltaKind, OcrBox } from './types.ts'

/**
 * 参与跨帧对齐的一条候选（上一帧 pending 或当前帧候选）。
 * id 由脚本按「帧号+消息序号+几何」生成，不包含 OCR 文本，因此 OCR 变化不影响身份。
 */
export interface TrackerItem {
  id?: string
  text: string
  box?: OcrBox
  side?: BubbleSide
  captureId?: string
  seq?: number
  contactId?: string
}

export interface FrameDeltaEntry {
  current: TrackerItem
  /** 命中的上一帧候选（replay / ocr-changed 时存在） */
  prev?: TrackerItem
  kind: FrameDeltaKind
}

export interface OcrChangedPair {
  prev: TrackerItem
  current: TrackerItem
}

export interface FrameDelta {
  /** 按当前帧阅读顺序排列 */
  entries: FrameDeltaEntry[]
  /** 已在上一帧出现、本次重放（文本一致） */
  replay: TrackerItem[]
  /** 同一消息但 OCR 文本发生变化（不得当成两条） */
  ocrChanged: OcrChangedPair[]
  /** 真正的新消息（追加在序列末尾） */
  inserted: TrackerItem[]
  /** 窗口滚动露出的历史消息（不是新入站，不投递） */
  scrolled: TrackerItem[]
  /** 同一帧内重复识别的行（文本相同且框几乎重合） */
  duplicates: TrackerItem[]
  /** 联系人切换导致跨帧关联全部失效 */
  reset: boolean
  /** 命中的上一帧候选 id（供诊断/测试） */
  matchedPrevIds: string[]
}

export interface ClassifyFrameDeltaOptions {
  /** 当前联系人（与 item.contactId 任一来源比较，变化即 reset） */
  contactId?: string
  /** 文本相似度阈值（默认 0.7） */
  minSimilarity?: number
  /** 框重合阈值（默认 0.2） */
  minBoxIoU?: number
}

const DEFAULT_MIN_SIMILARITY = 0.7
const DEFAULT_MIN_BOX_IOU = 0.2

function firstContactId(items: TrackerItem[]): string | undefined {
  for (const item of items) {
    if (item.contactId) return item.contactId
  }
  return undefined
}

/** 两帧候选是否为「同一条消息」的证据分；0 表示不匹配。 */
function identityScore(prev: TrackerItem, current: TrackerItem, options: Required<ClassifyFrameDeltaOptions>): number {
  if (prev.side && current.side && prev.side !== 'unknown' && current.side !== 'unknown' && prev.side !== current.side) {
    return 0
  }
  if (prev.id && current.id && prev.id === current.id) return 1
  const sameKey = compareKey(prev.text) === compareKey(current.text)
  if (sameKey) return 0.95
  const similarity = lcsSimilarity(prev.text, current.text)
  if (similarity < options.minSimilarity) return 0
  if (prev.box && current.box) {
    const overlap = iou(prev.box, current.box)
    const maxHeight = Math.max(prev.box.height, current.box.height, 1)
    const verticallyClose = centerDistance(prev.box, current.box) <= maxHeight * 1.5
    if (overlap >= options.minBoxIoU || verticallyClose) return 0.5 + 0.3 * similarity
    return 0
  }
  // 没有几何信息时只接受很高的文本相似度，避免把两条相似消息错误合并
  return similarity >= 0.9 ? 0.4 + 0.3 * similarity : 0
}

/**
 * 跨帧候选序列对齐（设计文档 8.2/8.3）：
 * - 顺序保持的加权 LCS，能识别 pending 重放、OCR 文本变化、滚动露出的历史、新插入消息；
 * - 连发两条相同文本：第一条与上一帧匹配（replay），第二条因几何位置不同判为 insert（算两条）；
 * - 同帧重复识别（框几乎重合）判为 duplicate；
 * - 联系人变化时 reset，全部按新消息处理，避免跨会话误关联。
 */
export function classifyFrameDelta(
  prevPending: TrackerItem[],
  current: TrackerItem[],
  options: ClassifyFrameDeltaOptions = {},
): FrameDelta {
  const config: Required<ClassifyFrameDeltaOptions> = {
    contactId: options.contactId ?? '',
    minSimilarity: options.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
    minBoxIoU: options.minBoxIoU ?? DEFAULT_MIN_BOX_IOU,
  }

  const prevContact = firstContactId(prevPending)
  const currentContact = firstContactId(current) ?? (config.contactId || undefined)
  const reset =
    Boolean(prevContact && currentContact && prevContact !== currentContact) ||
    Boolean(prevContact && config.contactId && prevContact !== config.contactId)

  if (reset) {
    return {
      entries: current.map((item) => ({ current: item, kind: 'insert' as const })),
      replay: [],
      ocrChanged: [],
      inserted: [...current],
      scrolled: [],
      duplicates: [],
      reset: true,
      matchedPrevIds: [],
    }
  }

  // 加权 LCS DP：dp[i][j] = 前 i 个 prev 与前 j 个 current 的最大证据分
  const rows = prevPending.length
  const cols = current.length
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      const score = identityScore(prevPending[i - 1]!, current[j - 1]!, config)
      const skipPrev = dp[i - 1]![j]!
      const skipCurrent = dp[i]![j - 1]!
      const take = score > 0 ? dp[i - 1]![j - 1]! + score : Number.NEGATIVE_INFINITY
      dp[i]![j] = Math.max(skipPrev, skipCurrent, take)
    }
  }

  const matched = new Map<number, number>() // currentIndex → prevIndex
  let i = rows
  let j = cols
  while (i > 0 && j > 0) {
    const score = identityScore(prevPending[i - 1]!, current[j - 1]!, config)
    const currentValue = dp[i]![j]!
    if (score > 0 && Math.abs(currentValue - (dp[i - 1]![j - 1]! + score)) <= 1e-9) {
      matched.set(j - 1, i - 1)
      i -= 1
      j -= 1
    } else if (Math.abs(currentValue - dp[i - 1]![j]!) <= 1e-9) {
      i -= 1
    } else {
      j -= 1
    }
  }

  const matchedCurrentIndexes = [...matched.keys()].sort((left, right) => left - right)
  const firstMatchedCurrentIndex = matchedCurrentIndexes.length > 0 ? matchedCurrentIndexes[0]! : Number.POSITIVE_INFINITY

  const entries: FrameDeltaEntry[] = []
  const replay: TrackerItem[] = []
  const ocrChanged: OcrChangedPair[] = []
  const inserted: TrackerItem[] = []
  const scrolled: TrackerItem[] = []
  const duplicates: TrackerItem[] = []
  const matchedPrevIds: string[] = []

  const seenCurrent: Array<{ text: string; box?: OcrBox }> = []

  for (let index = 0; index < current.length; index += 1) {
    const item = current[index]!
    const prevIndex = matched.get(index)
    if (prevIndex !== undefined) {
      const prev = prevPending[prevIndex]!
      const kind: FrameDeltaKind = compareKey(prev.text) === compareKey(item.text) ? 'replay' : 'ocr-changed'
      entries.push({ current: item, prev, kind })
      if (kind === 'replay') replay.push(item)
      else ocrChanged.push({ prev, current: item })
      if (prev.id) matchedPrevIds.push(prev.id)
      seenCurrent.push({ text: compareKey(item.text), box: item.box })
      continue
    }

    // 同帧重复识别：文本相同且框几乎重合
    const duplicated = seenCurrent.some(
      (seen) => seen.text === compareKey(item.text) && boxesNearlySame(seen.box, item.box),
    )
    if (duplicated) {
      entries.push({ current: item, kind: 'duplicate' })
      duplicates.push(item)
      seenCurrent.push({ text: compareKey(item.text), box: item.box })
      continue
    }

    const kind: FrameDeltaKind =
      matchedCurrentIndexes.length > 0 && index < firstMatchedCurrentIndex ? 'scroll' : 'insert'
    entries.push({ current: item, kind })
    if (kind === 'scroll') scrolled.push(item)
    else inserted.push(item)
    seenCurrent.push({ text: compareKey(item.text), box: item.box })
  }

  return { entries, replay, ocrChanged, inserted, scrolled, duplicates, reset: false, matchedPrevIds }
}

function boxesNearlySame(left?: OcrBox, right?: OcrBox): boolean {
  if (!left || !right) return false
  return iou(left, right) >= 0.5
}

/**
 * 基线对齐 + pending 队列 + ack 水位线（v3.0.0 Phase C，OCR-H1/H2 修复）。
 *
 * 旧实现（scripts/pwsh/wechat-uia.ps1 read action）的问题：
 * 1) **先消费后输出**：新行在 Save-Baseline 之后才输出；如果输出前脚本异常/调用方超时，
 *    消息已被写进基线，下次读取不会再出现 —— 永久丢消息（OCR-H1）。
 * 2) **输出被截断**：最后 `Select-Object -Last $MaxMessages`，一次出现超过 20 条新消息时
 *    前面的全丢（OCR-H2）。
 * 3) **id 不稳定**：id 用「文本 hash + 本次出现序号」，重放时序号变化会导致 id 变化，
 *    上层去重失效。
 *
 * 新模型：
 * - 基线只表示「已确认看过/已投递」的历史文本；
 * - 读到的新行先进入 pending 队列并持久化（原子写由调用方保证），**先输出后消费**；
 * - 输出行带 captureId（本次快照号）；上层处理成功后带 -Ack <captureId> 回来，
 *   只丢弃 seq <= ack 水位线的 pending 行，未确认的行下次重放；
 * - 消息 id = 文本 hash + **持久化递增序号**，同一行重放时 id 完全不变，上层可安全去重。
 *
 * 本模块是纯函数，不读写文件、不含时间戳副作用（firstSeenAt 由调用方传入）。
 */

/** pending 队列中的一行（已输出、等待上层确认）。 */
export interface PendingLine {
  /** 稳定消息 id（跨帧重放不变） */
  id: string
  text: string
  /** 该行首次被读出的帧号 */
  captureId: string
  /** 该行分配到的持久化序号（单调递增，用于生成 id 与 ack 水位） */
  seq: number
  /** 首次出现时间（epoch ms，调用方传入；便于诊断） */
  firstSeenAt: number
}

/** 桌面通道每个联系人持久化的基线状态。 */
export interface BaselineState {
  /** 已确认看过的历史文本（最近 N 条，用于与本次读数做尾对齐） */
  texts: string[]
  /** 已输出但尚未被上层确认的行（下次读取重放） */
  pending: PendingLine[]
  /** 已分配的 capture 序号（持久化，保证 captureId 单调递增） */
  captureSeq: number
  /** 最近一次成功确认的水位线 captureId（诊断用） */
  lastAckCaptureId: string
}

/** 基线保留的最大文本条数（防止状态文件无限增长）。 */
export const MAX_BASELINE_TEXTS = 200
/** pending 队列最大长度（超出的最旧未确认行会被丢弃，属保守降级）。 */
export const MAX_PENDING_LINES = 200

/** 新建空基线状态。 */
export function emptyBaselineState(): BaselineState {
  return { texts: [], pending: [], captureSeq: 0, lastAckCaptureId: '' }
}

/** 生成某序号对应的 captureId（格式 cap-<seq>；允许带后缀以便日志区分，解析只看前缀）。 */
export function captureIdFor(seq: number): string {
  return `cap-${seq}`
}

const CAPTURE_ID_RE = /^cap-(\d+)(?:-[0-9a-z]*)?$/i

/** 从 captureId 解析序号；非法返回 -1。 */
export function seqFromCaptureId(captureId: string): number {
  if (typeof captureId !== 'string') return -1
  const match = CAPTURE_ID_RE.exec(captureId.trim())
  if (!match) return -1
  const seq = Number(match[1])
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : -1
}

/** 分配下一个 captureId（返回新状态，不修改入参）。 */
export function nextCaptureId(state: BaselineState): {
  state: BaselineState
  seq: number
  captureId: string
} {
  const seq = (Number.isSafeInteger(state.captureSeq) ? state.captureSeq : 0) + 1
  return { state: { ...state, captureSeq: seq }, seq, captureId: captureIdFor(seq) }
}

function asTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function normalizePendingLine(raw: unknown): PendingLine | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<PendingLine>
  if (typeof item.id !== 'string' || item.id.trim().length === 0) return null
  if (typeof item.text !== 'string' || item.text.trim().length === 0) return null
  const seq = typeof item.seq === 'number' && Number.isSafeInteger(item.seq) && item.seq >= 0 ? item.seq : 0
  return {
    id: item.id,
    text: item.text,
    captureId: typeof item.captureId === 'string' ? item.captureId : '',
    seq,
    firstSeenAt: typeof item.firstSeenAt === 'number' && Number.isFinite(item.firstSeenAt) ? item.firstSeenAt : 0,
  }
}

/**
 * 把状态文件里读出来的任意形状归一化为 BaselineState。
 * 兼容：旧版纯数组格式（只有 texts）、旧版 { texts, updatedAt }、新版完整对象。
 */
export function normalizeBaselineState(raw: unknown): BaselineState {
  if (Array.isArray(raw)) {
    return { ...emptyBaselineState(), texts: asTextArray(raw) }
  }
  if (!raw || typeof raw !== 'object') return emptyBaselineState()
  const item = raw as Partial<BaselineState> & { updatedAt?: unknown }
  const pending = Array.isArray(item.pending)
    ? item.pending.map(normalizePendingLine).filter((line): line is PendingLine => line !== null)
    : []
  const captureSeq =
    typeof item.captureSeq === 'number' && Number.isSafeInteger(item.captureSeq) && item.captureSeq >= 0
      ? item.captureSeq
      : 0
  const lastAckCaptureId = typeof item.lastAckCaptureId === 'string' ? item.lastAckCaptureId : ''
  return { texts: asTextArray(item.texts), pending, captureSeq, lastAckCaptureId }
}

/** 尾对齐结果。 */
export interface AlignBaselineResult {
  /** 是否找到「旧基线末尾 == 新读数开头」的重叠段 */
  matched: boolean
  /** 本次读数为空或没有旧基线（不消费、不输出） */
  skipped: boolean
  /** 完全对不上：调用方应重置基线（把本次读数当基线）且不输出，避免重复回复历史消息 */
  reset: boolean
  /** 重叠段长度 */
  matchLen: number
  /** 新出现的行（保持读取顺序；不被截断） */
  newTexts: string[]
  /** 合并后的基线（已按 maxBaseline 截断） */
  mergedTexts: string[]
}

/**
 * 把本次读数与旧基线做尾对齐，得出新行。
 *
 * 规则：找最大的 k，使 prev 末尾 k 条 == current 开头 k 条；k>=1 即对齐成功，新行是 current[k..]。
 * 未对齐时 reset=true（调用方重置基线且不输出，保守起见不回复可能已回过的消息）。
 */
export function alignBaseline(
  prev: readonly string[],
  current: readonly string[],
  maxBaseline: number = MAX_BASELINE_TEXTS,
): AlignBaselineResult {
  const limit = Math.max(1, Math.floor(maxBaseline) || MAX_BASELINE_TEXTS)
  const prevTexts = asTextArray(prev)
  const currentTexts = asTextArray(current)
  if (currentTexts.length === 0) {
    return {
      matched: false,
      skipped: true,
      reset: false,
      matchLen: 0,
      newTexts: [],
      mergedTexts: prevTexts.slice(-limit),
    }
  }
  if (prevTexts.length === 0) {
    return {
      matched: false,
      skipped: true,
      reset: false,
      matchLen: 0,
      newTexts: [],
      mergedTexts: currentTexts.slice(-limit),
    }
  }

  const maxK = Math.min(prevTexts.length, currentTexts.length)
  let matchLen = 0
  for (let k = maxK; k >= 1; k -= 1) {
    const prevTail = prevTexts.slice(prevTexts.length - k)
    const currentHead = currentTexts.slice(0, k)
    if (prevTail.every((text, index) => text === currentHead[index])) {
      matchLen = k
      break
    }
  }

  if (matchLen === 0) {
    return {
      matched: false,
      skipped: false,
      reset: true,
      matchLen: 0,
      newTexts: [],
      mergedTexts: currentTexts.slice(-limit),
    }
  }

  const newTexts = currentTexts.slice(matchLen)
  return {
    matched: true,
    skipped: false,
    reset: false,
    matchLen,
    newTexts,
    mergedTexts: [...prevTexts, ...newTexts].slice(-limit),
  }
}

function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/**
 * 稳定消息 id：文本 hash + 持久化序号。
 * 同一行重放时 id 不变（上层 inFlight 去重）；同文本的两条消息因序号不同而区分。
 */
export function stableMessageId(text: string, seq: number): string {
  const first = fnv1a(text, 0x811c9dc5).toString(16).padStart(8, '0')
  const second = fnv1a(`${text}\u0000${seq}`, 0x811c9dc5).toString(16).padStart(8, '0')
  return `pc-${(first + second).slice(0, 12)}-${Math.floor(seq)}`
}

/** 追加 pending 行（按 id 去重、保留顺序、尾部截断到 maxPending）。 */
export function appendPending(
  state: BaselineState,
  entries: readonly PendingLine[],
  maxPending: number = MAX_PENDING_LINES,
): BaselineState {
  const limit = Math.max(1, Math.floor(maxPending) || MAX_PENDING_LINES)
  const merged = new Map<string, PendingLine>()
  for (const item of state.pending) merged.set(item.id, item)
  for (const item of entries) {
    if (!merged.has(item.id)) merged.set(item.id, item)
  }
  return { ...state, pending: [...merged.values()].slice(-limit) }
}

/** 应用 ack 水位线：只丢弃 seq <= 水位的 pending 行；ack 非法时原样返回。 */
export function applyAck(state: BaselineState, ackCaptureId: string): BaselineState {
  const ackSeq = seqFromCaptureId(ackCaptureId)
  if (ackSeq < 0) return state
  return {
    ...state,
    lastAckCaptureId: ackCaptureId.trim(),
    pending: state.pending.filter((line) => line.seq > ackSeq),
  }
}

/** 只读地取 ack 之后仍需重放的 pending 行。 */
export function pendingAfterAck(state: BaselineState, ackCaptureId: string): PendingLine[] {
  const ackSeq = seqFromCaptureId(ackCaptureId)
  if (ackSeq < 0) return [...state.pending]
  return state.pending.filter((line) => line.seq > ackSeq)
}

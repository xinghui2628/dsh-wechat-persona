/**
 * 气泡归属（v3.0.0 Phase C，OCR-M1 修复）。
 *
 * 旧实现（scripts/pwsh/wechat-uia.ps1 Get-InboundCandidates）只用「行中心点是否越过硬编码中线」
 * 判断：中心点越过中线就当自己的消息**直接丢弃** —— 他人长气泡一旦中心越线会被误判为「自己」，
 * 静默丢消息；反过来自己贴左的长气泡也可能被当成入站。
 *
 * 新规则（纯函数，可单测）：
 * - 先按聊天面板几何剔除标题栏/输入框/会话列表里的行（outside-pane）；
 * - 再按「贴左边界 / 贴右边界」判断锚定方向；
 * - 同时贴两边（长气泡跨满窗格）→ uncertain（不猜、不投递）；
 * - 只贴左但中心越过中线（长气泡越线）→ uncertain；
 * - 只贴右但中心在中线左侧（自己长气泡越线）→ uncertain；
 * - 两边都不贴（漂浮文本）→ uncertain。
 *
 * 设计原则：**宁可不回，也不把别人的消息认成自己的、或把自己的消息认成别人的。**
 */

import type {
  BubbleClassification,
  BubbleLineInput,
  BubbleOwnership,
  BubblePane,
  BubbleSide,
} from './types.ts'

/** 气泡判定阈值（比例相对聊天面板宽度）。 */
export interface BubbleClassifyOptions {
  /** 左边界容差比例（默认 0.10） */
  leftMarginRatio?: number
  /** 右边界容差比例（默认 0.10） */
  rightMarginRatio?: number
  /** 中线位置比例（默认 0.50，相对聊天面板左边） */
  centerRatio?: number
  /** 贴边容差的最小像素值（默认 6px，避免高分屏下容差过小） */
  minMarginPx?: number
}

const DEFAULT_OPTIONS: Required<BubbleClassifyOptions> = {
  leftMarginRatio: 0.1,
  rightMarginRatio: 0.1,
  centerRatio: 0.5,
  minMarginPx: 6,
}

function isValidNumber(value: number): boolean {
  return Number.isFinite(value)
}

/** 校验聊天面板几何边界是否可用。 */
export function isValidPane(pane: BubblePane): boolean {
  return (
    isValidNumber(pane.left) &&
    isValidNumber(pane.right) &&
    isValidNumber(pane.top) &&
    isValidNumber(pane.bottom) &&
    pane.right - pane.left > 0 &&
    pane.bottom - pane.top > 0
  )
}

function result(
  line: BubbleLineInput,
  ownership: BubbleOwnership,
  reason: string,
  centerX = 0,
): BubbleClassification {
  const side: BubbleSide =
    ownership === 'inbound' ? 'left' : ownership === 'outbound' ? 'right' : 'unknown'
  const classification: BubbleClassification = { line, side, ownership, reason }
  // centerX 只用于调试日志，不进入契约字段（避免测试绑定内部细节）
  void centerX
  return classification
}

/**
 * 判断一行文本的气泡归属。
 *
 * @param line OCR 行（text 只用来看空串；几何为核心依据）
 * @param pane 聊天面板边界（帧像素坐标）
 */
export function classifyBubble(
  line: BubbleLineInput,
  pane: BubblePane,
  options: BubbleClassifyOptions = {},
): BubbleClassification {
  const config = { ...DEFAULT_OPTIONS, ...options }
  const box = line?.box
  if (!box || !isValidNumber(box.x) || !isValidNumber(box.y) || !isValidNumber(box.width) || !isValidNumber(box.height) || box.width <= 0 || box.height <= 0) {
    return result(line, 'uncertain', 'invalid-box')
  }
  if (!pane || !isValidPane(pane)) {
    return result(line, 'uncertain', 'invalid-pane')
  }

  const boxRight = box.x + box.width
  const boxBottom = box.y + box.height
  const paneWidth = pane.right - pane.left
  const paneHeight = pane.bottom - pane.top
  const toleranceLeft = Math.max(config.minMarginPx, paneWidth * config.leftMarginRatio)
  const toleranceRight = Math.max(config.minMarginPx, paneWidth * config.rightMarginRatio)
  const toleranceTop = Math.max(config.minMarginPx, paneHeight * 0.02)

  // 1) 窗格之外：标题栏、输入框、会话列表里的行绝不参与气泡判断
  if (boxBottom <= pane.top || box.y >= pane.bottom || boxRight <= pane.left || box.x >= pane.right) {
    return result(line, 'uncertain', 'outside-pane')
  }
  if (box.y < pane.top - toleranceTop && boxRight <= pane.left + toleranceLeft) {
    return result(line, 'uncertain', 'outside-pane')
  }

  const centerX = box.x + box.width / 2
  const midX = pane.left + paneWidth * config.centerRatio
  const nearLeft = box.x - pane.left <= toleranceLeft
  const nearRight = pane.right - boxRight <= toleranceRight

  // 2) 同时贴住左右两边：长气泡跨满窗格，无法区分是否对方，判不确定
  if (nearLeft && nearRight) {
    return result(line, 'uncertain', 'spans-both-margins', centerX)
  }

  // 3) 贴左：中心在左半区才是对方消息；中心越线说明可能是自己/对方长气泡，不猜
  if (nearLeft) {
    if (centerX <= midX) return result(line, 'inbound', 'inbound', centerX)
    return result(line, 'uncertain', 'inbound-crosses-center', centerX)
  }

  // 4) 贴右：中心在右半区才是自己消息；中心在中线左侧（长气泡越线）不猜
  if (nearRight) {
    if (centerX >= midX) return result(line, 'outbound', 'outbound', centerX)
    return result(line, 'uncertain', 'outbound-crosses-center', centerX)
  }

  // 5) 两边都不贴：漂浮文本（引用/卡片/识别噪声），不投递
  return result(line, 'uncertain', 'unknown-alignment', centerX)
}

/** 批量分类（保持输入顺序）。 */
export function classifyBubbles(
  lines: readonly BubbleLineInput[],
  pane: BubblePane,
  options: BubbleClassifyOptions = {},
): BubbleClassification[] {
  return lines.map((line) => classifyBubble(line, pane, options))
}

/** 只取可投递的对方消息（inbound）。 */
export function inboundBubbles(
  lines: readonly BubbleLineInput[],
  pane: BubblePane,
  options: BubbleClassifyOptions = {},
): BubbleClassification[] {
  return classifyBubbles(lines, pane, options).filter((item) => item.ownership === 'inbound')
}

/** 归属 → BubbleSide 映射（写回消息候选时使用）。 */
export function ownershipToSide(ownership: BubbleOwnership): BubbleSide {
  if (ownership === 'inbound') return 'left'
  if (ownership === 'outbound') return 'right'
  return 'unknown'
}

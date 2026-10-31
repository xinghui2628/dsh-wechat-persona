/**
 * OCR 投递决策（v3.0.0 Phase C）：把脚本一次读取的输出变成「可投递的入站消息」。
 *
 * 职责（纯函数，不产生副作用、不调引擎）：
 * 1) 按气泡几何归属过滤：outbound（自己）与 uncertain（无法判断）一律不投递并计数，
 *    对应 OCR-M1「他人长气泡越线被当自己丢弃 / 自己长气泡被当入站」的修复；
 * 2) 透传 captureId（同帧身份）与 ack 水位线，供调用方回传下一次读取；
 * 3) 空文本、同一批重复 id 不投递；
 * 4) 旧脚本输出（无 pane/box/side/captureId）按 legacy 兼容接受，保证渐进升级。
 *
 * 设计原则：不确定宁可不回；被拒绝的消息只计数 + 记原因，不静默改文本。
 */

import { seqFromCaptureId, stableMessageId } from './baseline.ts'
import { classifyBubble, isValidPane } from './bubbles.ts'
import type { OcrBox } from './types.ts'
import type { BubbleLineInput, BubblePane, BubbleSide } from './types.ts'

/** 脚本输出的一条消息（字段全部可选，兼容旧版本）。 */
export interface OcrMessageInput {
  id?: string
  text?: string
  /** 该消息来自哪一帧（新版本脚本必填，旧版本为空） */
  captureId?: string
  /** 脚本侧气泡归属（新版本脚本会输出） */
  side?: BubbleSide
  /** 消息外接框（新版本脚本会输出，帧像素坐标） */
  box?: OcrBox
}

/** 一次 read 的完整输入。 */
export interface OcrReadInput {
  captureId?: string
  ack?: string
  pane?: BubblePane
  /** 聊天面板内的行（可选，目前只用于诊断，不参与投递） */
  lines?: BubbleLineInput[]
  messages?: OcrMessageInput[]
}

/** 拒绝原因。 */
export type OcrRejectReason = 'empty' | 'uncertain' | 'outbound' | 'duplicate'

/** 可投递消息。 */
export interface OcrAcceptedMessage {
  id: string
  text: string
  captureId: string
  side: BubbleSide
}

/** 被拒绝消息（只计数与记原因，不投递）。 */
export interface OcrRejectedMessage {
  id: string
  text: string
  reason: OcrRejectReason
}

/** 一次 read 的投递计划。 */
export interface OcrDispatchPlan {
  /** 本次快照号 */
  captureId: string
  /** 上次确认水位线（调用方传入） */
  ack: string
  /** 下次读取应回传的 ack（本次快照号；非法时为空串） */
  nextAck: string
  accepted: OcrAcceptedMessage[]
  rejected: OcrRejectedMessage[]
  /** 因几何不确定被拒条数（诊断中心计数） */
  uncertainCount: number
  /** 因是自己消息被拒条数 */
  outboundCount: number
  /** 同一批内重复条数 */
  duplicateCount: number
  /** 旧格式消息（无任何几何/归属信息）接受条数 */
  legacyCount: number
}

function pickOwnershipBySide(side: BubbleSide | undefined): 'inbound' | 'outbound' | 'uncertain' {
  if (side === 'left') return 'inbound'
  if (side === 'right') return 'outbound'
  return 'uncertain'
}

/**
 * 计算一次 read 的投递计划。
 *
 * 归属判定优先级：pane + box 几何判定 > 脚本给出的 side 字段 > 旧格式（无信息，legacy 接受）。
 */
export function planInboundDispatch(input: OcrReadInput): OcrDispatchPlan {
  const captureId = (input.captureId ?? '').trim()
  const ack = (input.ack ?? '').trim()
  const pane = input.pane
  const messages = Array.isArray(input.messages) ? input.messages : []
  const accepted: OcrAcceptedMessage[] = []
  const rejected: OcrRejectedMessage[] = []
  const seenIds = new Set<string>()
  let uncertainCount = 0
  let outboundCount = 0
  let duplicateCount = 0
  let legacyCount = 0

  messages.forEach((message, index) => {
    const rawText = typeof message.text === 'string' ? message.text : ''
    const text = rawText.trim()
    const providedId = typeof message.id === 'string' ? message.id.trim() : ''
    const id = providedId || stableMessageId(text, index)

    if (!text) {
      rejected.push({ id, text: '', reason: 'empty' })
      return
    }

    const geometryUsable = Boolean(message.box && pane && isValidPane(pane))
    let ownership: 'inbound' | 'outbound' | 'uncertain'
    let side: BubbleSide
    if (geometryUsable && message.box && pane) {
      const classification = classifyBubble({ text, box: message.box }, pane)
      ownership = classification.ownership
      side = classification.side
    } else if (message.side === 'left' || message.side === 'right' || message.side === 'unknown') {
      ownership = pickOwnershipBySide(message.side)
      side = message.side
    } else {
      // 旧格式：脚本不提供任何归属信息 —— 保持旧行为全部接受，避免升级瞬间丢消息
      ownership = 'inbound'
      side = 'unknown'
      legacyCount += 1
    }

    if (ownership === 'outbound') {
      outboundCount += 1
      rejected.push({ id, text, reason: 'outbound' })
      return
    }
    if (ownership === 'uncertain') {
      uncertainCount += 1
      rejected.push({ id, text, reason: 'uncertain' })
      return
    }
    if (seenIds.has(id)) {
      duplicateCount += 1
      rejected.push({ id, text, reason: 'duplicate' })
      return
    }
    seenIds.add(id)
    accepted.push({
      id,
      text,
      captureId: (message.captureId ?? captureId).trim(),
      side,
    })
  })

  const nextAck = seqFromCaptureId(captureId) >= 0 ? captureId : ''
  return {
    captureId,
    ack,
    nextAck,
    accepted,
    rejected,
    uncertainCount,
    outboundCount,
    duplicateCount,
    legacyCount,
  }
}

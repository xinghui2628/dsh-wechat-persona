/**
 * 发送生命周期状态机（任务书 9.1）。
 *
 * 纯函数模块：不依赖 I/O、时钟或宿主，便于单测；engine 在回复流程的真实阶段推进
 * 状态，并把每次推进写入审计（type='send-state'），设置页 / 审计日志据此还原一次
 * 发送的完整生命周期。
 *
 * 技术边界（任务书 9.4 要求明确说明）：GUI 自动化无法实现严格的端到端 exactly-once。
 * 本状态机只保证「未知结果不当作成功、也不允许自动重发」；真正抑制重复发送的是
 * `send-ledger.ts` 的幂等账本（同一 sendOperationId 不会被无条件重复执行）。
 */

/** 一次逻辑发送的生命周期状态（9.1）。 */
export type SendState =
  | 'received'
  | 'validated'
  | 'generating'
  | 'draft'
  | 'ready'
  | 'sending'
  | 'confirmed'
  | 'failed'
  | 'unknown'
  | 'cancelled'

/** 全部合法状态（用于运行时校验与测试遍历）。 */
export const SEND_STATES: readonly SendState[] = [
  'received',
  'validated',
  'generating',
  'draft',
  'ready',
  'sending',
  'confirmed',
  'failed',
  'unknown',
  'cancelled',
]

/**
 * 合法转换表：from → 允许的 to 列表。
 *
 * 设计说明：
 * - `unknown`（无法确认是否发出）与 `confirmed` 都是终态，绝不允许自动回退重发；
 * - `failed` 允许回到 `ready`：仅当账本证明「确定未发出（delivery='not-sent'）」且
 *   未超过重试上限时，才允许显式重排一次新的发送尝试（由 send-ledger 把关）；
 * - `draft` → `ready` 表示用户批准草稿后重新进入发送流程。
 */
export const SEND_TRANSITIONS: Readonly<Record<SendState, readonly SendState[]>> = {
  received: ['validated', 'draft', 'cancelled', 'failed'],
  validated: ['generating', 'draft', 'ready', 'cancelled', 'failed'],
  generating: ['draft', 'ready', 'cancelled', 'failed'],
  draft: ['ready', 'cancelled', 'failed'],
  ready: ['sending', 'draft', 'cancelled', 'failed'],
  sending: ['confirmed', 'failed', 'unknown', 'cancelled'],
  confirmed: [],
  failed: ['ready'],
  unknown: [],
  cancelled: [],
}

/** 中文状态标签（审计 / 设置页展示用）。 */
export const SEND_STATE_LABELS: Readonly<Record<SendState, string>> = {
  received: '已收到消息',
  validated: '已通过门禁',
  generating: '正在生成回复',
  draft: '已生成草稿',
  ready: '准备发送',
  sending: '发送中',
  confirmed: '已确认发出',
  failed: '发送失败',
  unknown: '结果未知',
  cancelled: '已取消',
}

/** 判断 from → to 是否为合法转换。 */
export function canTransition(from: SendState, to: SendState): boolean {
  const allowed = SEND_TRANSITIONS[from]
  return Array.isArray(allowed) ? allowed.includes(to) : false
}

/** 断言合法转换；非法时抛出带中文说明的 Error（engine 在开发期/测试中用来抓 bug）。 */
export function assertTransition(from: SendState, to: SendState): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法发送状态转换：${from} → ${to}（允许：${SEND_TRANSITIONS[from].join(' / ') || '无'}）`)
  }
}

/** 是否为终态（不会再有后续状态推进）。 */
export function isTerminalSendState(state: SendState): boolean {
  return state === 'confirmed' || state === 'failed' || state === 'unknown' || state === 'cancelled'
}

/** 是否为「确定未发出、可安全重试」的失败（仅账本据此放行重排）。 */
export function isRetryableFailureState(state: SendState): boolean {
  return state === 'failed'
}

/** 中文标签；未知状态原样返回，便于审计排障。 */
export function describeSendState(state: SendState): string {
  return SEND_STATE_LABELS[state] ?? String(state)
}

/** 运行时校验（持久化数据 / 外部输入防御用）。 */
export function isSendState(value: unknown): value is SendState {
  return typeof value === 'string' && (SEND_STATES as readonly string[]).includes(value)
}

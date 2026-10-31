/**
 * 聊天内启停命令（主人发 "/stop" 让自动化闭嘴，"/resume" 或 "/start" 恢复）。
 *
 * 纯字符串判断；命令只对白名单联系人生效由 engine/gate 负责，
 * 本模块不做权限判断。
 */

import type { RuntimeState } from '../types.ts'

/** 是否是停止命令：trim 后不区分大小写等于 "/stop"。 */
export function isStopCommand(text: string): boolean {
  if (typeof text !== 'string') return false
  return text.trim().toLowerCase() === '/stop'
}

/** 是否是恢复命令："/resume" 或 "/start"（同样 trim + 忽略大小写）。 */
export function isResumeCommand(text: string): boolean {
  if (typeof text !== 'string') return false
  const command = text.trim().toLowerCase()
  return command === '/resume' || command === '/start'
}

/** 暂停引擎并记录原因/时间（不写审计，审计由 engine 负责）。 */
export function pauseEngine(state: RuntimeState, reason: string, now: number): void {
  state.paused = true
  state.pauseReason = typeof reason === 'string' && reason !== '' ? reason : 'paused'
  state.pausedAt = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
}

/**
 * 恢复引擎：清 paused / pauseReason / pausedAt。
 * opts.clearBreaker 为 true 时同时清熔断标记（主人已人工确认安全）。
 */
export function resumeEngine(state: RuntimeState, opts?: { clearBreaker?: boolean }): void {
  state.paused = false
  state.pauseReason = undefined
  state.pausedAt = undefined
  if (opts?.clearBreaker === true) state.breaker = { tripped: false }
}

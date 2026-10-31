/**
 * Token 预算：按天累计模型消耗，超比例切草稿模式，超硬上限直接停。
 *
 * 纯本地记账，不调模型；跨日自动清零。非法配置数值 clamp 到安全区间：
 * dailyTokens >= 1，draftModeRatio 落在 [0, 1]。
 */

import type { BudgetState, LlmUsage } from '../types.ts'
import type { WechatPersonaConfig } from '../config.ts'
import { dayKey } from '../util/time.ts'

/** 预算阶段：正常 / 草稿模式（只生成不发）/ 耗尽（不再调模型）。 */
export type BudgetPhase = 'ok' | 'draft' | 'exhausted'

/** 任意输入 -> 有限数值（非法返回 fallback）。 */
function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 取一次调用的 token 数：优先 totalTokens，否则 input+output；负数/非法按 0。 */
function usageTokens(usage: Pick<LlmUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'> | undefined): number {
  if (!usage || typeof usage !== 'object') return 0
  const total = finiteNumber(usage.totalTokens, Number.NaN)
  if (Number.isFinite(total)) return Math.max(0, Math.trunc(total))
  const input = finiteNumber(usage.inputTokens, 0)
  const output = finiteNumber(usage.outputTokens, 0)
  return Math.max(0, Math.trunc(Math.max(0, input) + Math.max(0, output)))
}

/**
 * 规范化预算状态：跨日清零；缺失/损坏字段补默认；spentTokens 非负整数。
 * 返回新对象，不修改入参。
 */
export function normalizeBudget(budget: BudgetState | undefined, now: number): BudgetState {
  const currentDay = dayKey(now)
  if (!budget || typeof budget !== 'object' || budget.dayKey !== currentDay) {
    return { dayKey: currentDay, spentTokens: 0 }
  }
  return {
    dayKey: currentDay,
    spentTokens: Math.max(0, Math.trunc(finiteNumber(budget.spentTokens, 0))),
  }
}

/**
 * 累加一次模型调用的 token 消耗（engine 在每次 LLM 返回后调用）。
 * 先按 now 规范化（跨日清零），再累加；返回新对象。
 */
export function addUsage(
  budget: BudgetState | undefined,
  usage: Pick<LlmUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'> | undefined,
  now: number,
): BudgetState {
  const normalized = normalizeBudget(budget, now)
  const spent = normalized.spentTokens + usageTokens(usage)
  return { dayKey: normalized.dayKey, spentTokens: Math.max(0, Math.trunc(spent)) }
}

/**
 * 计算预算阶段：
 * - spent >= dailyTokens               -> 'exhausted'（硬停，engine 不再调模型）
 * - spent >= dailyTokens*draftModeRatio -> 'draft'（正常调模型但只存草稿不发）
 * - 其余                                -> 'ok'
 */
export function budgetPhase(config: WechatPersonaConfig, budget: BudgetState, now: number): BudgetPhase {
  const normalized = normalizeBudget(budget, now)
  const dailyTokens = Math.max(1, Math.trunc(finiteNumber(config?.budget?.dailyTokens, 50000)))
  const ratioRaw = finiteNumber(config?.budget?.draftModeRatio, 0.85)
  const ratio = Math.min(1, Math.max(0, ratioRaw))
  if (normalized.spentTokens >= dailyTokens) return 'exhausted'
  if (normalized.spentTokens >= dailyTokens * ratio) return 'draft'
  return 'ok'
}

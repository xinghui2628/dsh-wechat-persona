/**
 * 风控熔断：本地关键词识别微信/系统的风控提示文案，0 token。
 *
 * 使用场景：通道（adb / windows-vm）截屏识别的文字、或消息流里的系统提示，
 * 命中关键词即说明“自动化可能被微信盯上了”，立刻停通道、暂停引擎、通知主人。
 * 这里只做“是否命中”的本地判断，绝不能为了判断去调模型。
 */

import type { RiskKind, RiskSignal, RuntimeState } from '../types.ts'
import type { WechatPersonaConfig } from '../config.ts'

/** 命中片段最长保留 40 字（避免审计里塞进整段屏幕文字）。 */
const MATCHED_MAX_CHARS = 40

interface RiskPatternGroup {
  kind: RiskKind
  patterns: string[]
}

/**
 * 内置风控文案（中文为主，英文兜底）。
 * 组顺序即优先级；组内长词在前，避免“请完成验证”被“验证码”类短词抢走。
 */
const BUILTIN_PATTERNS: RiskPatternGroup[] = [
  {
    kind: 'captcha',
    patterns: [
      '请完成安全验证',
      '请完成验证',
      '安全验证',
      '滑块验证',
      '滑块',
      '验证码',
      'captcha',
      'verification code',
    ],
  },
  {
    kind: 'login-abnormal',
    patterns: ['异常登录', '登录异常', '异地登录', '新设备登录', 'abnormal login', 'unusual login'],
  },
  {
    kind: 'restricted',
    patterns: [
      '账号存在风险',
      '账号异常',
      '账号受限',
      '限制登录',
      '账号被限制',
      '冻结',
      '封禁',
      '封号',
      'restricted account',
    ],
  },
  {
    kind: 'spam-limit',
    patterns: ['操作过于频繁', '操作频繁', '发送过于频繁', '发送频繁', '请稍后再试', 'rate limit', 'too frequent'],
  },
]

/** 截断到 n 个字符（按 code point，避免把 emoji 切成半个）。 */
function truncate(text: string, maxChars: number): string {
  const chars = [...text]
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('')
}

/** 在原文里找关键词，命中则返回原文片段（保留用户原始大小写）。 */
function matchFragment(source: string, lowerSource: string, keyword: string): string | null {
  const needle = keyword.trim()
  if (needle === '') return null
  const index = lowerSource.indexOf(needle.toLowerCase())
  if (index < 0) return null
  return source.slice(index, index + needle.length)
}

/**
 * 识别风控文案。
 *
 * - 内置模式命中 -> 对应 RiskKind；
 * - config.safety.riskKeywords 命中 -> 'unknown'（用户自定义，归类未知）；
 * - 未命中返回 null。
 * RiskSignal.at 用 Date.now() 兜底（本函数无时钟注入；调用方/审计会再补时间）。
 */
export function detectRisk(text: string, config: WechatPersonaConfig): RiskSignal | null {
  if (typeof text !== 'string') return null
  const source = text.trim()
  if (source === '') return null
  const lowerSource = source.toLowerCase()
  const build = (kind: RiskKind, matched: string): RiskSignal => ({
    kind,
    text: truncate(source, 200),
    at: Date.now(),
    matched: truncate(matched, MATCHED_MAX_CHARS),
  })

  for (const group of BUILTIN_PATTERNS) {
    for (const pattern of group.patterns) {
      const matched = matchFragment(source, lowerSource, pattern)
      if (matched !== null) return build(group.kind, matched)
    }
  }

  const extraKeywords = Array.isArray(config?.safety?.riskKeywords) ? config.safety.riskKeywords : []
  for (const keyword of extraKeywords) {
    if (typeof keyword !== 'string') continue
    const matched = matchFragment(source, lowerSource, keyword)
    if (matched !== null) return build('unknown', matched)
  }
  return null
}

/**
 * 触发熔断：记录原因（`${kind}:${matched}`）并同时暂停引擎。
 * 注意：暂停由这里一并设置，保证任何调用方忘记暂停时也不会继续发消息。
 */
export function tripBreaker(state: RuntimeState, signal: RiskSignal): void {
  const at = typeof signal?.at === 'number' && Number.isFinite(signal.at) && signal.at > 0 ? signal.at : Date.now()
  const kind: RiskKind = signal?.kind ?? 'unknown'
  const matched = truncate(String(signal?.matched ?? signal?.text ?? ''), MATCHED_MAX_CHARS)
  state.breaker = { tripped: true, reason: `${kind}:${matched}`, at }
  state.paused = true
  state.pauseReason = 'risk-control'
  state.pausedAt = at
}

/** 清除熔断标记（不会自动恢复暂停；恢复由 resumeEngine/engine.resume 负责）。 */
export function resetBreaker(state: RuntimeState): void {
  state.breaker = { tripped: false }
}

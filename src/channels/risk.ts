/**
 * 风控文案扫描（纯函数，0 IO / 0 token）。
 *
 * 输入是通道能读到的任意文本（通知标题+正文、UIA 读到的界面文案…），
 * 命中内置中文风控关键词或 config.safety.riskKeywords 时返回 RiskSignal。
 *
 * 约定：
 * - 匹配策略是“最长关键词优先、其次最早出现”，保证「操作过于频繁」不会被
 *   退化成「频繁」，同时结果对调用方是确定的；
 * - 内置词表只覆盖常见文案，真正的兜底在 config.safety.riskKeywords（用户追加）；
 * - 只返回状态信号，不负责暂停/熔断——那是 engine 的职责；
 * - RiskSignal.text 只保留命中位置附近的一小段原文，供本机日志排障使用，
 *   永远不会进入模型上下文，也不在通道里落盘。
 */

import type { WechatPersonaConfig } from '../config.ts'
import type { RiskKind, RiskSignal } from '../types.ts'

export interface RiskPattern {
  keyword: string
  kind: RiskKind
}

/**
 * 内置中文风控文案。
 * 顺序不重要（匹配时会按关键词长度重排），这里按风险大类聚合便于维护。
 */
export const BUILTIN_RISK_PATTERNS: readonly RiskPattern[] = [
  // ── 账号受限 / 封禁（后果最重，同长度时优先上报）
  { keyword: '限制登录', kind: 'restricted' },
  { keyword: '限制使用', kind: 'restricted' },
  { keyword: '账号受限', kind: 'restricted' },
  { keyword: '账号被限制', kind: 'restricted' },
  { keyword: '功能受限', kind: 'restricted' },
  { keyword: '账号冻结', kind: 'restricted' },
  { keyword: '永久封禁', kind: 'restricted' },
  { keyword: '临时限制', kind: 'restricted' },
  { keyword: '账号封禁', kind: 'restricted' },
  { keyword: '冻结', kind: 'restricted' },
  { keyword: '封禁', kind: 'restricted' },
  { keyword: '封号', kind: 'restricted' },

  // ── 异常登录
  { keyword: '异常登录', kind: 'login-abnormal' },
  { keyword: '异地登录', kind: 'login-abnormal' },
  { keyword: '登录异常', kind: 'login-abnormal' },
  { keyword: '账号异常', kind: 'login-abnormal' },
  { keyword: '新设备登录', kind: 'login-abnormal' },
  { keyword: '非常用设备', kind: 'login-abnormal' },
  { keyword: '密码已被修改', kind: 'login-abnormal' },

  // ── 验证码 / 安全验证
  { keyword: '短信验证码', kind: 'captcha' },
  { keyword: '安全验证', kind: 'captcha' },
  { keyword: '身份验证', kind: 'captcha' },
  { keyword: '人机验证', kind: 'captcha' },
  { keyword: '滑动验证', kind: 'captcha' },
  { keyword: '请完成验证', kind: 'captcha' },
  { keyword: '验证码', kind: 'captcha' },

  // ── 发送频率限制
  { keyword: '操作过于频繁', kind: 'spam-limit' },
  { keyword: '发送过于频繁', kind: 'spam-limit' },
  { keyword: '今日发送已达上限', kind: 'spam-limit' },
  { keyword: '操作频繁', kind: 'spam-limit' },
  { keyword: '发送频繁', kind: 'spam-limit' },
  { keyword: '请稍后再试', kind: 'spam-limit' },
  { keyword: '稍后再试', kind: 'spam-limit' },
  { keyword: '频繁', kind: 'spam-limit' },
]

/** 命中片段两侧保留的上下文字符数。 */
const EXCERPT_RADIUS = 24

/** 单个 RiskSignal.text 的上限，避免把整段消息带进本地日志。 */
const EXCERPT_MAX_CHARS = 80

function toPatterns(config: WechatPersonaConfig | undefined): RiskPattern[] {
  const patterns: RiskPattern[] = [...BUILTIN_RISK_PATTERNS]
  const extra = config?.safety?.riskKeywords
  if (!Array.isArray(extra)) return patterns

  for (const raw of extra) {
    if (typeof raw !== 'string') continue
    const keyword = raw.trim()
    if (!keyword) continue
    // 内置词已经覆盖的完全相同关键词不重复计入；用户词的 kind 记为 unknown。
    if (patterns.some((p) => p.keyword === keyword)) continue
    patterns.push({ keyword, kind: 'unknown' })
  }
  return patterns
}

function excerpt(text: string, index: number, keyword: string): string {
  const start = Math.max(0, index - EXCERPT_RADIUS)
  const end = Math.min(text.length, index + keyword.length + EXCERPT_RADIUS)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${body}${suffix}`.slice(0, EXCERPT_MAX_CHARS)
}

/**
 * 扫描一段文本，命中风控文案时返回信号。
 *
 * @param text 通道能读到的文本（通知标题/正文、界面文案等）
 * @param config 使用 config.safety.riskKeywords 作为内置词表的追加规则
 */
export function detectChannelRisk(text: string, config: WechatPersonaConfig): RiskSignal | null {
  if (typeof text !== 'string' || text.length === 0) return null

  const patterns = toPatterns(config)
  let best: { pattern: RiskPattern; index: number } | null = null

  for (const pattern of patterns) {
    const index = text.indexOf(pattern.keyword)
    if (index < 0) continue
    if (
      best === null ||
      pattern.keyword.length > best.pattern.keyword.length ||
      (pattern.keyword.length === best.pattern.keyword.length && index < best.index)
    ) {
      best = { pattern, index }
    }
  }

  if (best === null) return null
  return {
    kind: best.pattern.kind,
    text: excerpt(text, best.index, best.pattern.keyword),
    at: Date.now(),
    matched: best.pattern.keyword,
  }
}

/** 供测试/诊断使用：内置词表里某个 kind 对应的全部关键词。 */
export function riskKeywordsOf(kind: RiskKind): string[] {
  return BUILTIN_RISK_PATTERNS.filter((p) => p.kind === kind).map((p) => p.keyword)
}

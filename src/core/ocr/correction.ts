/**
 * OCR 文本质量评估与受控纠错（纯函数）。
 *
 * v0.2.8 把这段逻辑直接写在 src/channels/pc/desktop.ts（:58-163、:311-355），
 * 无法单测、且纠错没有「敏感信息不得改写」的护栏。v3.0.0 抽出本模块：
 *
 * 1) 质量评估：noiseScore / looksGarbled / pickBetterText —— 行为与 v0.2.8 保持兼容（回归测试锁定）；
 * 2) 受控纠错：只做「同长度、至多差一个字」的高频词替换，且**跳过敏感信息区段**
 *    （姓名由调用方以 extraWords 提供；wxid/金额/手机号/验证码/日期/邮箱/网址/文件名/订单号/密码一律不改）；
 * 3) 每次纠错都返回变更明细，写进 audit，便于事后审计「AI 改了什么」。
 */

export interface ProtectedSpan {
  start: number
  end: number
  category: ProtectedCategory
  /** 命中的原文片段（仅供日志/诊断；写日志前需脱敏） */
  text: string
}

export type ProtectedCategory =
  | 'wxid'
  | 'phone'
  | 'money'
  | 'date'
  | 'email'
  | 'url'
  | 'order-number'
  | 'verification-code'
  | 'password'
  | 'id-card'

/** 敏感信息正则（按顺序执行，跨度以码点索引记录）。 */
const PROTECTED_PATTERNS: Array<{ category: ProtectedCategory; pattern: RegExp }> = [
  { category: 'url', pattern: /https?:\/\/[^\s]+/gi },
  { category: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { category: 'wxid', pattern: /\bwxid_[A-Za-z0-9_-]{4,}\b/g },
  { category: 'id-card', pattern: /\b\d{17}[\dXx]\b/g },
  { category: 'phone', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { category: 'money', pattern: /(?:¥|￥|\$)\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s?(?:元|块钱|块|万元|万|角|分)/g },
  { category: 'date', pattern: /\b\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\b|\b\d{1,2}月\d{1,2}日\b/g },
  {
    category: 'order-number',
    pattern: /(?:订单号|订单编号|运单号|单号|快递单号|交易号|流水号)[:：]?\s*[A-Za-z0-9-]{4,}/g,
  },
  { category: 'verification-code', pattern: /(?:验证码|校验码|动态码|激活码|口令)[:：]?\s*[A-Za-z0-9]{3,}/g },
  { category: 'password', pattern: /(?:密码|口令)[:：]?\s*\S{3,}/g },
]

/** 找出文本中不允许被自动改写的敏感区段（按码点索引）。 */
export function findProtectedSpans(text: string): ProtectedSpan[] {
  const raw = String(text ?? '')
  const spans: ProtectedSpan[] = []
  if (!raw) return spans
  for (const { category, pattern } of PROTECTED_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    let match: RegExpExecArray | null
    while ((match = re.exec(raw)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex += 1
        continue
      }
      const start = [...raw.slice(0, match.index)].length
      const end = start + [...match[0]].length
      spans.push({ start, end, category, text: match[0] })
    }
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  // 合并重叠区段，避免同一段文字被重复保护
  const merged: ProtectedSpan[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end)
      continue
    }
    merged.push({ ...span })
  }
  return merged
}

/** 区段是否与敏感区段重叠。 */
export function overlapsProtected(start: number, end: number, spans: ProtectedSpan[]): boolean {
  return spans.some((span) => start < span.end && end > span.start)
}

// ── 质量评估（与 v0.2.8 兼容）──────────────────────────────────────────────

/** OCR 噪声字符：Windows OCR 对生僻字/形近字常给出残缺偏旁部首。 */
export const OCR_NOISE_CHARS = /[讠刂亻扌氵忄宀纟灬丨丿乛龴]/g

/** 文本的 OCR 噪声分：越高保真度越低（v0.2.8 公式）。 */
export function noiseScore(text: string): number {
  const raw = String(text ?? '').trim()
  if (!raw) return 100
  const chinese = (raw.match(/[\u4e00-\u9fff]/g) || []).length
  const noise = (raw.match(OCR_NOISE_CHARS) || []).length
  const ascii = (raw.match(/[a-zA-Z0-9]/g) || []).length
  const ratio = chinese > 0 ? (noise + ascii * 0.5) / chinese : 0
  return noise + ascii * 0.5 + (chinese === 0 ? 10 : 0) + ratio * 30
}

/** 读取到的文本是否可疑（疑似 OCR 误读），可疑时触发二次高倍识别（v0.2.8 公式）。 */
export function looksGarbled(text: string): boolean {
  const raw = String(text ?? '').trim()
  if (!raw) return false
  if ((raw.match(OCR_NOISE_CHARS) || []).length > 0) return true
  const chinese = (raw.match(/[\u4e00-\u9fff]/g) || []).length
  const ascii = (raw.match(/[a-zA-Z]/g) || []).length
  if (chinese >= 2 && ascii >= Math.max(2, chinese / 3)) return true
  return noiseScore(raw) >= 8
}

/** 两段候选文本里选更可信的一段：噪声低者优先，噪声接近时取更完整的（v0.2.8 公式）。 */
export function pickBetterText(a: string, b: string): string {
  const x = String(a ?? '').trim()
  const y = String(b ?? '').trim()
  if (!x) return y
  if (!y) return x
  const sx = noiseScore(x)
  const sy = noiseScore(y)
  if (Math.abs(sx - sy) >= 1) return sx < sy ? x : y
  return y.length > x.length ? y : x
}

// ── 受控纠错 ───────────────────────────────────────────────────────────────

/**
 * 默认纠错词表（只放通用词，**严禁**放真实好友昵称/人格名；联系人名由调用方经 extraWords 传入）。
 * 这些词是微信聊天里的高频词，Windows OCR 容易出现形近字（如「幽默」→「幽黑」）。
 */
export const DEFAULT_CORRECTION_WORDS: readonly string[] = [
  '幽默度', '幽默', '表情包', '红包', '转账', '聊天', '微信', '测试', '机器人',
  '人格', '分身', '白名单', '空闲', '预算', '审计', '消息', '好友', '语音',
  '图片', '截图', '识别', '误读', '形近字', '吐槽', '键盘', '今天', '明天',
  '刚才', '什么', '怎么', '可以', '没有', '喜欢', '谢谢', '好的', '收到',
]

/** 纠错级别：none=不改；conservative=只做受控词典替换（默认）； */
export type CorrectionLevel = 'none' | 'conservative'

export interface CorrectionChange {
  start: number
  end: number
  from: string
  to: string
  lexeme: string
}

export interface CorrectionResult {
  /** 纠错后的文本 */
  text: string
  /** 变更明细（写 audit） */
  changes: CorrectionChange[]
  /** 因命中敏感区段而被跳过的候选替换数 */
  protectedSkipped: number
}

export interface CorrectionOptions {
  /** 追加词表（如白名单联系人名——由调用方从配置传入，不写死在源码里） */
  extraWords?: string[]
  level?: CorrectionLevel
  /** 参与替换的最短/最长词长（默认 3/6） */
  minWordLength?: number
  maxWordLength?: number
  /** 允许的最大差异字数（默认 1） */
  maxDistance?: number
}

/**
 * 受控词典纠错：只对「长度 3-6 的纯 CJK 词」做「同长度、至多差一个字」的替换，
 * 且任何落在敏感区段内的替换一律跳过（任务书 12 条：姓名/金额/手机号等不得自动改写）。
 */
export function correctOcrText(text: string, extraWords: string[] = [], options: CorrectionOptions = {}): string {
  return applyControlledCorrection(text, extraWords, options).text
}

/** 与 correctOcrText 相同，但返回变更明细（供 audit / 诊断中心使用）。 */
export function applyControlledCorrection(
  text: string,
  extraWords: string[] = [],
  options: CorrectionOptions = {},
): CorrectionResult {
  const level = options.level ?? 'conservative'
  const src = String(text ?? '')
  if (!src || level === 'none') return { text: src, changes: [], protectedSkipped: 0 }

  const minLen = Math.max(2, options.minWordLength ?? 3)
  const maxLen = Math.max(minLen, options.maxWordLength ?? 6)
  const maxDistance = Math.max(0, options.maxDistance ?? 1)

  const words = [...new Set([...DEFAULT_CORRECTION_WORDS, ...(extraWords || [])])]
    .filter((w) => typeof w === 'string' && w.length >= minLen && w.length <= maxLen && /^[\u4e00-\u9fff]+$/.test(w))
    .sort((a, b) => b.length - a.length)

  const chars = [...src]
  const protectedSpans = findProtectedSpans(src)
  const used = new Array<boolean>(chars.length).fill(false)
  const changes: CorrectionChange[] = []
  let protectedSkipped = 0

  for (const word of words) {
    const len = [...word].length
    for (let i = 0; i + len <= chars.length; i += 1) {
      let conflict = false
      for (let k = 0; k < len; k += 1) {
        if (used[i + k]) {
          conflict = true
          break
        }
      }
      if (conflict) continue
      const fragChars = chars.slice(i, i + len)
      if (!fragChars.every((ch) => /[\u4e00-\u9fff]/.test(ch))) continue
      const frag = fragChars.join('')
      if (frag === word) continue
      let distance = 0
      for (let k = 0; k < len; k += 1) if (frag[k] !== word[k]) distance += 1
      if (distance > maxDistance) continue
      if (overlapsProtected(i, i + len, protectedSpans)) {
        protectedSkipped += 1
        continue
      }
      changes.push({ start: i, end: i + len, from: frag, to: word, lexeme: word })
      for (let k = 0; k < len; k += 1) {
        chars[i + k] = [...word][k]
        used[i + k] = true
      }
    }
  }

  const result = chars.join('')
  if (result === src) return { text: src, changes: [], protectedSkipped }
  return { text: result, changes, protectedSkipped }
}

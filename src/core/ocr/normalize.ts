/**
 * OCR 文本归一化与文本相似度（纯函数）。
 *
 * 关键事实（本机实测）：Windows OCR 识别中文时会在字与字之间插入空格
 * （「今天大肥鱼很好吃」→「今 天 大 肥 鱼 很 好 吃」）。若不归一化，
 * CER 会被空格字符严重污染，且同一内容在两帧之间永远无法对齐。
 *
 * 因此提供两层：
 * - normalizeOcrText：给**展示/存储**用的轻度归一（只去 CJK 间空格、压空白、去首尾）；
 * - compareKey：给**比较/去重/对齐**用的重度归一（去所有空白与标点、全角转半角、小写）。
 */

const CJK_RANGES: Array<[number, number]> = [
  [0x3400, 0x4dbf], // CJK Ext-A
  [0x4e00, 0x9fff], // CJK Unified
  [0xf900, 0xfaff], // CJK Compatibility
  [0x20000, 0x2a6df], // Ext-B（代理对，下面按码点判断）
]

/** 单个码点是否为 CJK 表意文字。 */
export function isCjkCodePoint(code: number): boolean {
  for (const [start, end] of CJK_RANGES) {
    if (code >= start && code <= end) return true
  }
  return false
}

/** 字符是否为 CJK 表意文字（按码点，正确处理代理对）。 */
export function isCjkChar(char: string): boolean {
  const cp = char.codePointAt(0)
  return cp === undefined ? false : isCjkCodePoint(cp)
}

/** 字符串里 CJK 字符数。 */
export function countCjk(text: string): number {
  let count = 0
  for (const ch of String(text ?? '')) if (isCjkChar(ch)) count += 1
  return count
}

/** 字符串里 ASCII 字母/数字个数。 */
export function countAsciiAlnum(text: string): number {
  return (String(text ?? '').match(/[A-Za-z0-9]/g) || []).length
}

/** 全角 ASCII（U+FF01..U+FF5E）转半角，全角空格转普通空格。 */
export function toHalfWidth(text: string): string {
  return String(text ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
}

/** 是否是空白字符（含全角空格、零宽字符、各种 Unicode 空白）。 */
export function isWhitespaceChar(char: string): boolean {
  return /\s|\u3000|\u200b|\u200c|\u200d|\ufeff/.test(char)
}

/**
 * 展示用归一化：
 * - 删除两个 CJK 字符之间的空格（Windows OCR 的字间空格）；
 * - 其余空白折叠成一个半角空格；
 * - 两侧 trim；
 * - 不做标点/大小写改写（保留原文信息，便于审计回看）。
 */
export function normalizeOcrText(text: string): string {
  const raw = String(text ?? '')
  const chars = [...raw]
  const out: string[] = []
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    if (isWhitespaceChar(ch)) {
      const prev = out.length > 0 ? out[out.length - 1] : ''
      const next = chars[i + 1] ?? ''
      // CJK 与 CJK 之间的空格直接丢弃；其余保留一个空格（后续折叠）
      if (isCjkChar(prev) && isCjkChar(next)) continue
      out.push(' ')
      continue
    }
    out.push(ch)
  }
  return out.join('').replace(/ {2,}/g, ' ').trim()
}

/**
 * 比较用归一化（compareKey）：
 * - 全角转半角；
 * - 去掉所有空白、标点、符号、emoji 变体选择符；
 * - ASCII 小写。
 * 注意：不改变 CJK 字符本身，避免形近字被错误折叠。
 */
export function compareKey(text: string): string {
  const half = toHalfWidth(text)
  return half
    .replace(/[\s\u3000\u200b-\u200d\ufeff]/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

/** 文本是否「实质为空」（只有空白/标点）。 */
export function isEmptyText(text: string): boolean {
  return compareKey(text).length === 0
}

/** Levenshtein 编辑距离（按码点计算，O(min(m,n)) 内存）。 */
export function levenshtein(a: string, b: string): number {
  const left = [...String(a ?? '')]
  const right = [...String(b ?? '')]
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  let prev = new Array<number>(right.length + 1)
  let curr = new Array<number>(right.length + 1)
  for (let j = 0; j <= right.length; j += 1) prev[j] = j
  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[right.length]
}

/** 字符错误率 CER = 编辑距离 / 参考串长度（参考串为空时：两边都空=0，否则=1）。 */
export function characterErrorRate(hypothesis: string, reference: string): number {
  const hypRaw = String(hypothesis ?? '')
  const refRaw = String(reference ?? '')
  const refLength = [...refRaw].length
  if (refLength === 0) return [...hypRaw].length === 0 ? 0 : 1
  return levenshtein(hypRaw, refRaw) / refLength
}

/** 相似度 = 1 - CER（可能为负，钳到 0）。 */
export function textSimilarity(a: string, b: string): number {
  const left = compareKey(a)
  const right = compareKey(b)
  const denom = Math.max(left.length, right.length)
  if (denom === 0) return 1
  return Math.max(0, 1 - levenshtein(left, right) / denom)
}

/** 两段文本的多重集字符重合度（2*交集/总长，0..1）。用于跨引擎投票。 */
export function textOverlapRatio(a: string, b: string): number {
  const x = compareKey(a)
  const y = compareKey(b)
  if (!x || !y) return 0
  const counts = new Map<string, number>()
  for (const ch of x) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let common = 0
  for (const ch of y) {
    const n = counts.get(ch) ?? 0
    if (n > 0) {
      counts.set(ch, n - 1)
      common += 1
    }
  }
  return (2 * common) / (x.length + y.length)
}

/** 最长公共子序列长度（用于跨帧对齐/消息身份关联）。 */
export function lcsLength(a: string, b: string): number {
  const left = [...String(a ?? '')]
  const right = [...String(b ?? '')]
  if (left.length === 0 || right.length === 0) return 0
  let prev = new Array<number>(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i += 1) {
    const curr = new Array<number>(right.length + 1).fill(0)
    for (let j = 1; j <= right.length; j += 1) {
      curr[j] = left[i - 1] === right[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
    }
    prev = curr
  }
  return prev[right.length]
}

/** 最长公共子序列相似度（LCS / maxLen）。 */
export function lcsSimilarity(a: string, b: string): number {
  const left = compareKey(a)
  const right = compareKey(b)
  const denom = Math.max(left.length, right.length)
  if (denom === 0) return 1
  return lcsLength(left, right) / denom
}

/** 判断文本是否像「自己的消息」（带 OCR 容错的前缀/重合度比较，行为对齐 v0.2.8）。 */
export function looksLikeSameText(candidate: string, known: string): boolean {
  const p = compareKey(candidate)
  const s = compareKey(known)
  if (p.length < 2 || s.length < 2) return false
  if (p === s) return true
  if (s.length >= 4 && (s.includes(p) || p.includes(s))) return true
  const head = Math.min(p.length, s.length, 12)
  if (head >= 4 && (s.startsWith(p.slice(0, head)) || p.startsWith(s.slice(0, head)))) return true
  if (p.length >= 6 && s.length >= 6) {
    const chars = [...new Set([...p])]
    const common = chars.filter((ch) => s.includes(ch)).length
    if (common / chars.length >= 0.6) return true
  }
  return false
}

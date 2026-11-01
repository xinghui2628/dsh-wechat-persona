#!/usr/bin/env node
/**
 * v3.0.0 OCR 管线的「离线等价」实现（benchmark 专用，不是生产代码）。
 *
 * 用途：在合成语料上复现 v3 上线管线「WinRT 2x → 文本归一化 → 可疑消息第二引擎投票 →
 * 受控纠错」的决策链，让 bench 能给出「v3 管线 vs v0.2.8 baseline」的真实、可复现对比。
 *
 * 为什么是「转写」而不是 import：
 *   - src/core/ocr/*.ts 是 TypeScript，本仓库没有 tsx/ts-node，bench 是纯 Node .mjs；
 *   - 且 Phase B 期间 src/core/ocr 正被并行改造，bench 不应把基准绑在会被移动的源码上。
 *   因此这里按当时源码逐行转写为 JS，行为保持等价；若 src 后续改动，需要人工复核本文件。
 *
 * 转写来源（只读，行号基准 feat/v3.0.0 初始提交）：
 *   src/core/ocr/normalize.ts:65-82   normalizeOcrText（CJK 间空格删除）
 *   src/core/ocr/normalize.ts:91-97   compareKey（去空白/标点/符号、全角转半角、小写）
 *   src/core/ocr/normalize.ts:145-160 textOverlapRatio（多重集字符重合度）
 *   src/core/ocr/correction.ts:34-48  PROTECTED_PATTERNS
 *   src/core/ocr/correction.ts:51-85  findProtectedSpans / overlapsProtected
 *   src/core/ocr/correction.ts:90-124 OCR_NOISE_CHARS / noiseScore / looksGarbled / pickBetterText
 *   src/core/ocr/correction.ts:132-137 DEFAULT_CORRECTION_WORDS
 *   src/core/ocr/correction.ts:174-235 applyControlledCorrection（敏感区段跳过）
 *   src/core/ocr/vote.ts:28-51        mergeEngineVote（重合度 <0.35 保留主引擎）
 *   src/channels/pc/desktop.ts:389-437 recheckGarbledText 的决策顺序
 *   scripts/pwsh/wechat-uia.ps1:1906-1954 SecondOcr 的 rapid 行匹配与替换门槛
 *
 * 离线等价的已知偏差（写进 docs/OCR-BENCHMARK.md「局限」）：
 *   1. 真实管线首读后若仍可疑会再换 4x/2x 帧重读；bench 语料没有 4x 变体，只等价到「2x 首读」，
 *      因此本实现相对真实管线偏保守（少了一次 4x 救援机会）。
 *   2. 真实 pipeline 的「消息」由脚本按 UI 坐标分组；bench 用 GT bbox 近似分组（与 baseline A/B 同口径）。
 *   3. 真实 desktop.recheckGarbledText 作用于整段聊天文本并做整串投票；这里按消息粒度做等价投票。
 *   4. 第二引擎行匹配用 compareKey 后的多重集重合度替代脚本里的 Get-TextOverlap（同为 0.35 门槛）。
 *   5. 气泡归属用「行框并集 + 内边距」近似真实 bubble bbox，且 pane 取整图宽度。
 */

/** 敏感信息正则（逐行转写自 src/core/ocr/correction.ts:34-48）。 */
export const PROTECTED_PATTERNS = [
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
];

/** 找出不允许自动改写的敏感区段（转写自 correction.ts:51-80，按码点索引并合并重叠）。 */
export function findProtectedSpans(text) {
  const raw = String(text ?? '');
  const spans = [];
  if (!raw) return spans;
  for (const { category, pattern } of PROTECTED_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match;
    while ((match = re.exec(raw)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const start = [...raw.slice(0, match.index)].length;
      const end = start + [...match[0]].length;
      spans.push({ start, end, category, text: match[0] });
    }
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/** 区段是否与敏感区段重叠。 */
export function overlapsProtected(start, end, spans) {
  return spans.some((span) => start < span.end && end > span.start);
}

// ── 文本归一化（转写自 src/core/ocr/normalize.ts:65-97）────────────────

const CJK_RANGES = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2a6df],
];

function isCjkCodePoint(code) {
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end);
}

export function isCjkChar(char) {
  const cp = char.codePointAt(0);
  return cp === undefined ? false : isCjkCodePoint(cp);
}

function isWhitespaceChar(char) {
  return /\s|\u3000|\u200b|\u200c|\u200d|\ufeff/.test(char);
}

function toHalfWidth(text) {
  return String(text ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 展示用归一化（等价 src/core/ocr/normalize.ts:65-82 的 normalizeOcrText）。 */
export function normalizeOcrText(text) {
  const raw = String(text ?? '');
  const chars = [...raw];
  const out = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (isWhitespaceChar(ch)) {
      const prev = out.length > 0 ? out[out.length - 1] : '';
      const next = chars[i + 1] ?? '';
      if (isCjkChar(prev) && isCjkChar(next)) continue;
      out.push(' ');
      continue;
    }
    out.push(ch);
  }
  return out.join('').replace(/ {2,}/g, ' ').trim();
}

/** 比较用归一化（等价 compareKey）：全角转半角、去空白/标点/符号、小写。 */
export function compareKey(text) {
  return toHalfWidth(text)
    .replace(/[\s\u3000\u200b-\u200d\ufeff]/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/** Levenshtein 编辑距离（按码点；与 normalize.ts:105-124 一致）。 */
export function levenshteinV3(a, b) {
  const left = [...String(a ?? '')];
  const right = [...String(b ?? '')];
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let prev = new Array(right.length + 1);
  let curr = new Array(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) prev[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[right.length];
}

/** 多重集字符重合度 2*交集/总长（等价 normalize.ts:145-160 的 textOverlapRatio）。 */
export function textOverlapRatioV3(a, b) {
  const x = compareKey(a);
  const y = compareKey(b);
  if (!x || !y) return 0;
  const counts = new Map();
  for (const ch of x) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let common = 0;
  for (const ch of y) {
    const n = counts.get(ch) ?? 0;
    if (n > 0) {
      counts.set(ch, n - 1);
      common += 1;
    }
  }
  return (2 * common) / (x.length + y.length);
}

// ── 质量评估（逐行转写自 correction.ts:90-124）──────────────────────────

export const OCR_NOISE_CHARS = /[讠刂亻扌氵忄宀纟灬丨丿乛龴]/g;

export function noiseScore(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return 100;
  const chinese = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  const noise = (raw.match(OCR_NOISE_CHARS) || []).length;
  const ascii = (raw.match(/[a-zA-Z0-9]/g) || []).length;
  const ratio = chinese > 0 ? (noise + ascii * 0.5) / chinese : 0;
  return noise + ascii * 0.5 + (chinese === 0 ? 10 : 0) + ratio * 30;
}

export function looksGarbled(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if ((raw.match(OCR_NOISE_CHARS) || []).length > 0) return true;
  const chinese = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  const ascii = (raw.match(/[a-zA-Z]/g) || []).length;
  if (chinese >= 2 && ascii >= Math.max(2, chinese / 3)) return true;
  return noiseScore(raw) >= 8;
}

export function pickBetterText(a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (!x) return y;
  if (!y) return x;
  const sx = noiseScore(x);
  const sy = noiseScore(y);
  if (Math.abs(sx - sy) >= 1) return sx < sy ? x : y;
  return y.length > x.length ? y : x;
}

// ── 受控纠错（逐行转写自 correction.ts:132-235）─────────────────────────

export const DEFAULT_CORRECTION_WORDS = [
  '幽默度', '幽默', '表情包', '红包', '转账', '聊天', '微信', '测试', '机器人',
  '人格', '分身', '白名单', '空闲', '预算', '审计', '消息', '好友', '语音',
  '图片', '截图', '识别', '误读', '形近字', '吐槽', '键盘', '今天', '明天',
  '刚才', '什么', '怎么', '可以', '没有', '喜欢', '谢谢', '好的', '收到',
];

/**
 * 受控词典纠错：只对「长度 3-6 的纯 CJK 词」做「同长度、至多差一个字」的替换，
 * 落在敏感区段内的替换一律跳过（等价 correction.ts:179-235 的 applyControlledCorrection）。
 * @returns {{text:string, changes:Array, protectedSkipped:number}}
 */
export function applyControlledCorrection(text, extraWords = [], options = {}) {
  const level = options.level ?? 'conservative';
  const src = String(text ?? '');
  if (!src || level === 'none') return { text: src, changes: [], protectedSkipped: 0 };

  const minLen = Math.max(2, options.minWordLength ?? 3);
  const maxLen = Math.max(minLen, options.maxWordLength ?? 6);
  const maxDistance = Math.max(0, options.maxDistance ?? 1);

  const words = [...new Set([...DEFAULT_CORRECTION_WORDS, ...(extraWords || [])])]
    .filter((w) => typeof w === 'string' && w.length >= minLen && w.length <= maxLen && /^[\u4e00-\u9fff]+$/.test(w))
    .sort((a, b) => b.length - a.length);

  const chars = [...src];
  const protectedSpans = findProtectedSpans(src);
  const used = new Array(chars.length).fill(false);
  const changes = [];
  let protectedSkipped = 0;

  for (const word of words) {
    const len = [...word].length;
    for (let i = 0; i + len <= chars.length; i += 1) {
      let conflict = false;
      for (let k = 0; k < len; k += 1) {
        if (used[i + k]) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;
      const fragChars = chars.slice(i, i + len);
      if (!fragChars.every((ch) => /[\u4e00-\u9fff]/.test(ch))) continue;
      const frag = fragChars.join('');
      if (frag === word) continue;
      let distance = 0;
      for (let k = 0; k < len; k += 1) if (frag[k] !== word[k]) distance += 1;
      if (distance > maxDistance) continue;
      if (overlapsProtected(i, i + len, protectedSpans)) {
        protectedSkipped += 1;
        continue;
      }
      changes.push({ start: i, end: i + len, from: frag, to: word, lexeme: word });
      for (let k = 0; k < len; k += 1) {
        chars[i + k] = [...word][k];
        used[i + k] = true;
      }
    }
  }

  const result = chars.join('');
  if (result === src) return { text: src, changes: [], protectedSkipped };
  return { text: result, changes, protectedSkipped };
}

/** 便捷包装（等价 correctOcrText）。 */
export function correctOcrTextV3(text, extraWords = [], options = {}) {
  return applyControlledCorrection(text, extraWords, options).text;
}

// ── 双引擎投票（逐行转写自 src/core/ocr/vote.ts:28-51）──────────────────

const DEFAULT_MIN_OVERLAP = 0.35;
const DEFAULT_LENGTH_GAIN = 1;
const DEFAULT_NOISE_GAIN = 0.5;

export function mergeEngineVote(winText, engineText, options = {}) {
  const win = String(winText || '').trim();
  const eng = String(engineText || '').trim();
  if (!eng) return win;
  if (!win) return eng;
  const minOverlap = options.minOverlap ?? DEFAULT_MIN_OVERLAP;
  if (textOverlapRatioV3(win, eng) < minOverlap) return win;
  const sw = noiseScore(win);
  const se = noiseScore(eng);
  const lengthGain = options.lengthGain ?? DEFAULT_LENGTH_GAIN;
  const noiseGain = options.noiseGain ?? DEFAULT_NOISE_GAIN;
  if (eng.length > win.length + lengthGain) return eng;
  if (eng.length >= win.length && se < sw - noiseGain) return eng;
  return win;
}

// ── 第二引擎同帧匹配（转写自 scripts/pwsh/wechat-uia.ps1:1906-1954）────
//
// 脚本逻辑：对每条候选消息，先按 |rapidY/ocrScale - candidate.top| ≤ 26 找同一行的 rapid 结果，
// 取重合度最高的一条；找不到或重合度 <0.35 时用全图兜底；只有「重合度 ≥0.35 且 rapid 文本更长」
// 才替换候选文本（enginesUsed=winrt+rapidocr）。

/**
 * 在 rapid 同帧行里为一消息找最匹配的一行。
 * @param {{winText:string, winTop:number, rapidLines:Array<{text:string,box:{x:number,y:number,w:number,h:number}}>}} p
 * @returns {null | {text:string, overlap:number, y:number, viaFallback:boolean}}
 */
export function matchSecondEngineLine({ winText, winTop, rapidLines, topTolerance = 26 }) {
  if (!Array.isArray(rapidLines) || rapidLines.length === 0) return null;
  const inBand = rapidLines.filter((l) => Math.abs(l.box.y - winTop) <= topTolerance);
  let best = null;
  for (const line of inBand) {
    const overlap = textOverlapRatioV3(winText, line.text);
    if (!best || overlap > best.overlap) best = { text: line.text, overlap, y: line.box.y, viaFallback: false };
  }
  if (!best || best.overlap < DEFAULT_MIN_OVERLAP) {
    let fallback = best;
    for (const line of rapidLines) {
      const overlap = textOverlapRatioV3(winText, line.text);
      if (!fallback || overlap > fallback.overlap) {
        fallback = { text: line.text, overlap, y: line.box.y, viaFallback: true };
      }
    }
    best = fallback;
  }
  return best;
}

// ── 行级对齐（12.3 D 组「仅新对齐」离线等价）──────────────────────────────

/**
 * 把 WinRT 行对齐到同一帧的 RapidOCR 行：
 * 要求纵向距离 ≤ yTolerance 且文本重合度 ≥ minOverlap（近似 src/core/ocr 的对齐思路）。
 * 返回对齐上的 WinRT 行；未对齐上的行视为「不可信」被丢弃（这正是 D 组要测的取舍）。
 * @param {Array<{text:string, box:{x:number,y:number,w:number,h:number}}>} winLines
 * @param {Array<{text:string, box:{x:number,y:number,w:number,h:number}}>} engLines
 * @returns {{aligned:Array, dropped:Array, pairs:Array}}
 */
export function alignLinesToSecondEngine(winLines, engLines, { yTolerance = 26, minOverlap = 0.35 } = {}) {
  const aligned = [];
  const dropped = [];
  const pairs = [];
  const usedEng = new Set();
  for (let i = 0; i < winLines.length; i++) {
    const wl = winLines[i];
    let best = null;
    for (let j = 0; j < engLines.length; j++) {
      if (usedEng.has(j)) continue;
      const dy = Math.abs(engLines[j].box.y - wl.box.y);
      if (dy > yTolerance) continue;
      const overlap = textOverlapRatioV3(wl.text, engLines[j].text);
      const score = overlap - dy / 1000;
      if (overlap >= minOverlap && (!best || score > best.score)) best = { j, overlap, dy, score };
    }
    if (best) {
      usedEng.add(best.j);
      aligned.push(wl);
      pairs.push({ win: i, eng: best.j, overlap: best.overlap, dy: best.dy });
    } else {
      dropped.push(wl);
    }
  }
  return { aligned, dropped, pairs };
}

// ── v3 管线配置：调参只看 tune 集，eval 只报选中配置 ─────────────────────

export const V3_CONFIGS = [
  {
    id: 'novote',
    label: 'WinRT 2x + 归一 + 受控纠错（不用第二引擎）',
    useVote: 'none',
  },
  {
    id: 'vote-garbled',
    label: 'v3 真实等价：可疑消息才用 RapidOCR 同帧投票',
    useVote: 'garbled',
  },
  {
    id: 'vote-all',
    label: '上界参考（非真实可在线）：所有消息都用 RapidOCR 投票',
    useVote: 'all',
  },
];

export const V3_NOTES = [
  '离线等价按消息粒度实现：winrt 2x 分组文本 → 归一化 → （可疑时）RapidOCR 同帧按 |y-top|≤26 + 重合度≥0.35 + 更长才替换 → mergeEngineVote/pickBetterText → 受控纠错。',
  '真实管线在首读可疑时会再换 4x/2x 帧重读；bench 无 4x 变体，本实现只等价到 2x 首读，偏保守。',
  '消息分组用 GT bbox 近似（与 baseline A/B 同口径）；真实 pipeline 按 UI 坐标分组。',
  '真实 recheckGarbledText 作用于整段聊天文本；这里按消息粒度做等价投票。',
  '气泡归属用「行框并集 + 内边距」近似 bubble bbox，pane 取整图宽度（真实由脚本提供 pane 几何）。',
];

/**
 * 单条消息跑 v3 决策链。
 * @param {{gtText:string, winText:string, winTop:number, rapidLines?:Array, config:string|object}} p
 * @returns {{config:string, winText:string, finalText:string, garbled:boolean, matched:boolean,
 *   matchedOverlap:number, scriptReplaced:boolean, desktopVoted:boolean, corrected:boolean,
 *   protectedSkipped:number, changes:Array, usedSecondEngine:boolean}}
 */
export function runV3Message({ gtText, winText, winTop, rapidLines = [], config = 'vote-garbled' }) {
  const cfg = typeof config === 'string' ? V3_CONFIGS.find((c) => c.id === config) || V3_CONFIGS[1] : config;
  const skipCorrection = cfg.skipCorrection === true;
  const normalized = normalizeOcrText(winText);
  const garbled = looksGarbled(normalized);
  const info = {
    config: cfg.id,
    gtText,
    winText: normalized,
    finalText: normalized,
    garbled,
    matched: false,
    matchedOverlap: 0,
    matchedY: -1,
    scriptReplaced: false,
    desktopVoted: false,
    corrected: false,
    protectedSkipped: 0,
    changes: [],
    usedSecondEngine: false,
  };

  let best = normalized;
  const shouldVote = cfg.useVote === 'all' || (cfg.useVote === 'garbled' && garbled);
  if (shouldVote && rapidLines.length > 0) {
    const matched = matchSecondEngineLine({ winText: normalized, winTop, rapidLines });
    if (matched) {
      info.matched = true;
      info.matchedOverlap = matched.overlap;
      info.matchedY = matched.y;
      info.usedSecondEngine = true;
      // 脚本层替换门槛：重合度 ≥0.35 且 rapid 文本更长（wechat-uia.ps1:1940-1948）
      if (matched.overlap >= DEFAULT_MIN_OVERLAP && matched.text.length > normalized.length) {
        best = matched.text;
        info.scriptReplaced = true;
      }
      // desktop 层双引擎投票 + 取更可信（desktop.ts:418-431；本离线场景中 script 已替换时二者等价）
      const voted = mergeEngineVote(best, matched.text);
      const picked = pickBetterText(best, voted);
      if (picked !== best) {
        best = picked;
        info.desktopVoted = true;
      }
    }
  }

  // 最后一步始终是受控纠错（desktop.ts:394 / :437）；消融实验可用 skipCorrection 关掉
  if (skipCorrection) {
    info.finalText = best;
    return info;
  }
  const correction = applyControlledCorrection(best);
  info.finalText = correction.text;
  info.corrected = correction.changes.length > 0;
  info.protectedSkipped = correction.protectedSkipped;
  info.changes = correction.changes;
  return info;
}

// ── 气泡归属（近似 src/core/ocr/bubbles.ts 的 classifyBubble）───────────

/**
 * 用消息行框并集近似 bubble 位置，判断左右归属；不确定一律 uncertain（v3 的策略是宁可不回）。
 * @param {Array<{box:{x:number,y:number,w:number,h:number}}>} lines 该消息的 OCR 行
 * @param {number} imageWidth 原图宽度
 * @param {{leftMarginRatio?:number,rightMarginRatio?:number,centerRatio?:number,minMarginPx?:number,padding?:number}} [opts]
 * @returns {{side:'left'|'right'|'uncertain', reason:string, center:number, left:number, right:number}}
 */
export function classifySide(lines, imageWidth, opts = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { side: 'uncertain', reason: 'empty', center: NaN, left: NaN, right: NaN };
  }
  const leftMarginRatio = opts.leftMarginRatio ?? 0.1;
  const rightMarginRatio = opts.rightMarginRatio ?? 0.1;
  const centerRatio = opts.centerRatio ?? 0.5;
  const minMarginPx = opts.minMarginPx ?? 6;
  // 行框是文字区，真实 bubble 还包含左右内边距（约为图宽的 4%）
  const padding = opts.padding ?? Math.round(imageWidth * 0.04);
  const rawLeft = Math.min(...lines.map((l) => l.box.x));
  const rawRight = Math.max(...lines.map((l) => l.box.x + l.box.w));
  const left = Math.max(0, rawLeft - padding);
  const right = Math.min(imageWidth, rawRight + padding);
  const center = (left + right) / 2;
  const mid = imageWidth * centerRatio;
  const marginL = Math.max(imageWidth * leftMarginRatio, minMarginPx);
  const marginR = Math.max(imageWidth * rightMarginRatio, minMarginPx);
  const nearLeft = left <= marginL;
  const nearRight = imageWidth - right <= marginR;
  let side = 'uncertain';
  let reason = 'no-margin-contact';
  if (nearLeft && nearRight) {
    reason = 'spans-both-margins';
  } else if (nearLeft) {
    if (center <= mid) {
      side = 'left';
      reason = 'near-left';
    } else {
      reason = 'near-left-but-center-right';
    }
  } else if (nearRight) {
    if (center >= mid) {
      side = 'right';
      reason = 'near-right';
    } else {
      reason = 'near-right-but-center-left';
    }
  }
  return { side, reason, center, left, right };
}

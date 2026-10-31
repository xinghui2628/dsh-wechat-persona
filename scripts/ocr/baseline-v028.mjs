/**
 * v0.2.8 OCR 后处理 baseline —— 逐行转写自 src/channels/pc/desktop.ts:61-163、:307-355
 * （任务书写作 :74-180、:311-360），不得改进，仅作 A/B baseline。
 *
 * 行号基准：feat/v3.0.0 分支初始提交里的 src/channels/pc/desktop.ts
 * （`git show HEAD:src/channels/pc/desktop.ts`）。v3 重构会把纯函数搬到 src/core/ocr/，
 * 本文件仍是 v0.2.8 行为的独立快照，不随 src/ 变化。
 *
 * 来源与用途：
 *   - 纯函数（ocrNoiseScore / looksGarbled / pickBetterText / correctOcrText /
 *     textOverlapRatio / mergeEngineVote / DEFAULT_OCR_DICT）按源码逐行转写成 JS。
 *   - recheckGarbledText 的双帧投票 + 双引擎投票决策逻辑保留；原实现的 script I/O
 *     （runScript/parseJson/isOwnText/logger）改为「注入的帧候选」，以便离线 benchmark
 *     复用同一套决策代码。**决策顺序、阈值、选优函数一律未改**。
 *
 * 为什么单独放一份：bench 需要用 v0.2.8 的原始后处理算 A/B 数字（baseline vs 新方案），
 * 不能直接 import dist（v3 代码已改动），也不能改 src/（本次只新增文件）。
 *
 * 注意：本文件只做文本级后处理，不访问微信、不跑 PowerShell。
 */

// ── 以下 8 个导出严格对应 desktop.ts 中的同名函数（行号为源码位置）──────────

// desktop.ts:61
const OCR_NOISE_CHARS = /[讠刂亻扌氵忄宀纟灬丨丿乛龴]/g;

/** desktop.ts:64-72 文本的 OCR 噪声分：越低保真度越高。 */
export function ocrNoiseScore(text) {
  const raw = String(text || '').trim();
  if (!raw) return 100;
  const chinese = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  const noise = (raw.match(OCR_NOISE_CHARS) || []).length;
  const ascii = (raw.match(/[a-zA-Z0-9]/g) || []).length;
  const ratio = chinese > 0 ? (noise + ascii * 0.5) / chinese : 0;
  return noise + ascii * 0.5 + (chinese === 0 ? 10 : 0) + ratio * 30;
}

/** desktop.ts:75-83 读取到的文本是否可疑（疑似 OCR 误读）。 */
export function looksGarbled(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if ((raw.match(OCR_NOISE_CHARS) || []).length > 0) return true;
  const chinese = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  const ascii = (raw.match(/[a-zA-Z]/g) || []).length;
  if (chinese >= 2 && ascii >= Math.max(2, chinese / 3)) return true;
  return ocrNoiseScore(raw) >= 8;
}

/** desktop.ts:86-95 两段候选文本里选更可信的一段。 */
export function pickBetterText(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x) return y;
  if (!y) return x;
  const sx = ocrNoiseScore(x);
  const sy = ocrNoiseScore(y);
  if (Math.abs(sx - sy) >= 1) return sx < sy ? x : y;
  return y.length > x.length ? y : x;
}

// desktop.ts:101-105
export const DEFAULT_OCR_DICT = [
  '大肥鱼', '本鱼', '幽默度', '幽默', '暗号', '哦鲸鲸', '拉高', '表情包', '红包', '转账',
  '聊天', '微信', '测试', '机器人', '人格', '分身', '白名单', '空闲', '预算', '审计',
  '消息', '好友', '语音', '图片', '截图', '识别', '误读', '形近字', '吐槽', '键盘',
];

/** desktop.ts:108-134 用常用词词典纠正 OCR 形近字（只替换高频词，同长度且至多差一个字）。 */
export function correctOcrText(text, extraWords = []) {
  const src = String(text || '');
  if (!src) return src;
  // 只对长度≥3的词做「差一个字」替换：2 字词只差一个字就等于改掉一半，
  // 太容易误伤正常文本（如「今天」被改成「聊天」），所以 2 字词只做精确匹配（等于不替换）。
  const words = [...new Set([...(DEFAULT_OCR_DICT || []), ...(extraWords || [])])]
    .filter((w) => typeof w === 'string' && w.length >= 3 && w.length <= 6 && /^[\u4e00-\u9fff]+$/.test(w))
    .sort((a, b) => b.length - a.length);
  const chars = src.split('');
  const used = new Array(chars.length).fill(false);
  for (const word of words) {
    const len = word.length;
    for (let i = 0; i + len <= chars.length; i++) {
      let conflict = false;
      for (let k = 0; k < len; k++) { if (used[i + k]) { conflict = true; break; } }
      if (conflict) continue;
      const frag = chars.slice(i, i + len).join('');
      if (frag === word) continue;
      if (!/^[\u4e00-\u9fff]+$/.test(frag)) continue;
      let matched = 0;
      for (let k = 0; k < len; k++) { if (frag[k] === word[k]) matched++; }
      if (matched < len - 1) continue;
      for (let k = 0; k < len; k++) { chars[i + k] = word[k]; used[i + k] = true; }
    }
  }
  return chars.join('');
}

/** desktop.ts:137-149 两段文本的字符重合度（多重集交集*2/总长）。 */
export function textOverlapRatio(a, b) {
  const x = String(a || '').replace(/[\s\p{P}]+/gu, '');
  const y = String(b || '').replace(/[\s\p{P}]+/gu, '');
  if (!x || !y) return 0;
  const counts = new Map();
  for (const ch of x) counts.set(ch, (counts.get(ch) || 0) + 1);
  let common = 0;
  for (const ch of y) {
    const n = counts.get(ch) || 0;
    if (n > 0) { counts.set(ch, n - 1); common++; }
  }
  return (2 * common) / (x.length + y.length);
}

/** desktop.ts:152-163 双引擎投票：系统 OCR 与第二引擎文本重合度高时取更完整/噪声更低的一份。 */
export function mergeEngineVote(winText, engineText) {
  const win = String(winText || '').trim();
  const eng = String(engineText || '').trim();
  if (!eng) return win;
  if (!win) return eng;
  if (textOverlapRatio(win, eng) < 0.35) return win;
  const sw = ocrNoiseScore(win);
  const se = ocrNoiseScore(eng);
  if (eng.length > win.length + 1) return eng;
  if (eng.length >= win.length && se < sw - 0.5) return eng;
  return win;
}

/**
 * desktop.ts:311-355 recheckGarbledText 的逐行转写版本（含双帧投票 + 双引擎投票）。
 *
 * 与原实现的唯一差别：原实现通过 runScript('wechat-uia', [...]) 再跑脚本取帧；
 * 这里把脚本 I/O 换成注入的 `readFrame(scale)` / `readSecondEngine()`，决策逻辑不变。
 * 迁移时不要把本函数当生产代码用（生产实现仍在 desktop.ts）。
 */
export async function recheckGarbledText(name, args, text, deps = {}) {
  const {
    readFrame = async () => null,
    readSecondEngine = async () => null,
    isOwnText = () => false,
    contactNames = () => [],
    logger = { debug() {} },
  } = deps;
  if (!looksGarbled(text)) return correctOcrText(text, contactNames());
  let best = text;
  // 多帧投票：可疑时换不同放大倍数各读一帧，取噪声最低/最完整的一份。
  // 4 倍对形近字更准，2 倍对整体偏糊的窗口更稳；两帧都差就保留原文本，绝不空手丢消息。
  for (const scale of ['4', '2']) {
    if (!looksGarbled(best)) break;
    try {
      const data = await readFrame(scale);
      if (!data || data.ok !== true || !Array.isArray(data.messages)) continue;
      let candidate = '';
      for (const message of data.messages) {
        const item = String(message?.text || '').trim();
        if (!item || isOwnText(name, item)) continue;
        candidate = pickBetterText(candidate, item);
      }
      if (!candidate) continue;
      const chosen = pickBetterText(best, candidate);
      if (!looksGarbled(chosen)) {
        logger.debug?.(`[desktop] OCR 二次识别选优（${scale}x）：${name} 「${text.slice(0, 24)}」→「${chosen.slice(0, 24)}」`);
      }
      best = chosen;
    } catch { /* 单帧失败不影响其他帧 */ }
  }
  // 双引擎投票：多帧系统 OCR 仍可疑时，让脚本调用第二引擎（RapidOCR）独立识别同一截图，
  // 两路结果重合度高时取更完整的一份；python/依赖缺失时脚本静默回退，不影响主流程。
  if (looksGarbled(best)) {
    try {
      const data = await readSecondEngine();
      if (data && data.ok === true && Array.isArray(data.messages)) {
        for (const message of data.messages) {
          const item = String(message?.text || '').trim();
          if (!item || isOwnText(name, item)) continue;
          best = pickBetterText(best, mergeEngineVote(best, item));
        }
        if (!looksGarbled(best)) {
          logger.debug?.(`[desktop] OCR 双引擎投票选优：${name} 「${text.slice(0, 24)}」→「${best.slice(0, 24)}」`);
        }
      }
    } catch { /* 第二引擎不可用时保留原结果 */ }
  }
  return correctOcrText(best, contactNames());
}

/**
 * Benchmark 适配层：把「同一张图不同帧/不同引擎对该消息的候选文本」喂给
 * recheckGarbledText 的判定逻辑，返回后处理后的消息文本。
 *
 * 帧来源（bench --pipeline=baseline）：
 *   frames['2']        = WinRT 对 2x 放大图的原始行（对应源码的 -Upscale 2）
 *   frames['4']        = 未采集（bench 不生成 4x 变体），传 undefined → 跳过该帧
 *   secondEngineText   = RapidOCR 对原图的原始行（对应 -SecondOcr）
 * 调用方负责把这些行按 GT 消息 bbox 聚合成一条消息文本。
 */
export async function baselinePostprocessMessage(rawText, { frames = {}, secondEngineText = '', logger } = {}) {
  const frameData = (scale) => {
    const text = frames[scale];
    if (text === undefined || text === null) return null;
    return { ok: true, messages: [{ text }] };
  };
  return recheckGarbledText('bench', [], rawText, {
    readFrame: async (scale) => frameData(scale),
    readSecondEngine: async () =>
      secondEngineText ? { ok: true, messages: [{ text: secondEngineText }] } : null,
    contactNames: () => [],
    logger: logger || { debug() {} },
  });
}

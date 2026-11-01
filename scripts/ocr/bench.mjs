#!/usr/bin/env node
/**
 * OCR Benchmark 编排（v3.0.0）
 *
 * 流程：
 *   1. 读 test/fixtures/ocr-corpus/manifest.json（合成微信聊天截图 + ground truth）
 *      --split=tune|eval 按 manifest.scenarios 顺序奇偶拆分（tune=偶数下标、eval=奇数下标，两半不重叠）
 *   2. 生成预处理变体图（2x 放大 / 灰度+对比度）到 results/derived/
 *   3. 对每个引擎 × 每个预处理变体跑全部图，算指标：
 *        CER（字符级 Levenshtein / GT 字符数）、行级 P/R/F1（归一化文本 + IoU 辅助）、
 *        整句准确率、漏读率、假消息率、重复率、P50/P95 耗时
 *   4. --pipeline=baseline 组：WinRT 原始行 → v0.2.8 baseline 后处理
 *      （scripts/ocr/baseline-v028.mjs，逐行转写自 desktop.ts）→ 指针，看后处理相对原始行的增益
 *   5. --pipeline=v3 组：v3 上线管线的离线等价
 *      （scripts/ocr/v3-pipeline.mjs：winrt 2x 行 → 归一化 → 可疑消息 RapidOCR 同帧投票 → 受控纠错），
 *      三种配置 novote / vote-garbled / vote-all 全部计算；tune 集选参、eval 集只报选中配置。
 *   6. 每个 run 写 results/<timestamp>-<split>-<engine>-<variant>.json，另写 results/summary.json
 *
 * 用法：
 *   node scripts/ocr/bench.mjs --engine=all --pipeline=all                 # 全量（引擎 + baseline + v3）
 *   node scripts/ocr/bench.mjs --engine=all --pipeline=all --split=eval    # eval 集（不参与调参）
 *   node scripts/ocr/bench.mjs --engine=winrt --limit=10                   # 冒烟
 *   node scripts/ocr/bench.mjs --engine=all --scenario=clear,dark_mode
 *   node scripts/ocr/bench.mjs --pipeline=baseline --engine=all           # 只关心 baseline 组
 *
 * 说明：
 *   - 单图 OCR 失败不中断，按失败记录进结果（ok:false + error），汇总时排除但打印。
 *   - 窗口 chrome（标题/输入框占位/时间戳）用 manifest.expectedContext 豁免，不算假消息。
 *   - RapidOCR 走批量进程（模型只加载一次），单次全量约 1 分钟内；逐图进程会慢 20 倍以上。
 *   - 分组（groupLinesByMessage）用 GT bbox 近似把 OCR 行拼回消息，仅服务于 baseline/v3 A/B；
 *     真实 pipeline 的分组在 desktop.ts 里按 UI 坐标做，不在本 bench 范围内。
 *
 * 只读本仓库合成图；不截图、不启动、不发送微信；结果写 test/fixtures/ocr-corpus/results/。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.python) process.env.OCR_BENCH_PYTHON = args.python;

// --pipeline：raw=只跑引擎；baseline=引擎 + v0.2.8 后处理组；v3=引擎 + v3 管线离线等价组；all=两者都跑
const baselineEnabled = args.pipeline === 'baseline' || args.pipeline === 'all';
const v3Enabled = args.pipeline === 'v3' || args.pipeline === 'all';
const abEnabled = args.pipeline === 'ab';


const engines = await import('./engines.mjs');
const { baselinePostprocessMessage } = await import('./baseline-v028.mjs');
const {
  V3_CONFIGS,
  V3_NOTES,
  runV3Message,
  alignLinesToSecondEngine,
  classifySide,
} = await import('./v3-pipeline.mjs');
const {
  REPO_ROOT,
  VARIANTS,
  VARIANTS_ALL,
  selectVariants,
  variantById,
  runWinrt,
  runRapidocrBatch,
  prepareVariants,
  probeEnvironment,
  normalizeCjkSpaces,
  normalizeForCompare,
  levenshtein,
  textSimilarity,
  mergeBoxes,
  toBox,
  boxCenter,
  pointInRegion,
  iou,
} = engines;

// 4.4 tune 集选出的最优预处理变体（12.3 A/B 六组用；由 tune 结果决定，eval 不参与选择）
const BEST_VARIANT = 'upscale3x';

const CORPUS_DIR = join(REPO_ROOT, 'test', 'fixtures', 'ocr-corpus');
const MANIFEST_PATH = join(CORPUS_DIR, 'manifest.json');
const RESULTS_DIR = args.outDir ? resolve(REPO_ROOT, args.outDir) : join(CORPUS_DIR, 'results');
const DERIVED_DIR = join(RESULTS_DIR, 'derived');

// 预处理变体：默认仍是 3 个（向后兼容），--variants= 可显式指定 4.4 A–H 的任意组合。
let activeVariants;
try {
  activeVariants = selectVariants(args.variants);
} catch (err) {
  console.error(`[bench] ${err.message}`);
  process.exit(2);
}
if (abEnabled) {
  // A/B 六组固定需要的引擎数据：WinRT orig + WinRT 最优变体 + RapidOCR orig（在 [2/3] 段自动补跑）
  const abExtra = [variantById('orig'), variantById('upscale2x'), variantById(BEST_VARIANT)];
  activeVariants = [...new Map([...abExtra].map((v) => [v.id, v])).values()];
}

// ── 0. 环境与语料 ────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const allImages = manifest.images || [];
let selected = allImages;
if (args.scenario.length > 0) {
  const realScenarios = new Set((manifest.scenarios || []).map((s) => s.id));
  for (const s of args.scenario) {
    if (!realScenarios.has(s)) {
      console.error(`[bench] 未知 scenario: ${s}；可用: ${[...realScenarios].join(', ')}`);
      process.exit(2);
    }
  }
  selected = selected.filter((img) => args.scenario.includes(img.scenario));
}

// tune/eval 拆分：按 manifest.scenarios 顺序奇偶（两半场景、图片均不重叠）。
// 调参只看 tune 集，最终只报 eval 集；all 用于补充对照与更新 §5 引擎表。
const scenarioIds = (manifest.scenarios || []).map((s) => (typeof s === 'string' ? s : s.id));
const scenarioSplitOf = new Map(scenarioIds.map((id, i) => [id, i % 2 === 0 ? 'tune' : 'eval']));
const splitScenarios = {
  tune: scenarioIds.filter((_, i) => i % 2 === 0),
  eval: scenarioIds.filter((_, i) => i % 2 === 1),
};
if (args.split !== 'all') {
  selected = selected.filter((img) => (scenarioSplitOf.get(img.scenario) || 'all') === args.split);
  if (selected.length === 0) {
    console.error(`[bench] 按 --split=${args.split} 过滤后没有图片；--scenario 与 --split 可能冲突`);
    process.exit(2);
  }
}
if (args.limit > 0) selected = selected.slice(0, args.limit);
if (selected.length === 0) {
  console.error('[bench] 过滤后没有图片，退出');
  process.exit(2);
}

const env = probeEnvironment();
const startedAt = new Date();
console.log('=== OCR Benchmark (dsh-wechat-persona v3.0.0) ===');
console.log(`语料: ${manifest.imageCount} 张 / ${manifest.scenarioCount} 个场景，seed=${manifest.seed}`);
console.log(`本次: ${selected.length} 张，场景=${[...new Set(selected.map((i) => i.scenario))].join(',')}`);
console.log(`拆分: split=${args.split}${args.split === 'all' ? `（tune=${splitScenarios.tune.length} 场景 / eval=${splitScenarios.eval.length} 场景）` : `（${splitScenarios[args.split].length} 个场景）`}`);
console.log(`环境: ${env.platform} node=${env.nodeVersion} python=${env.pythonVersion || 'N/A'} (${env.rapidocrOk ? 'rapidocr OK' : 'rapidocr 不可用'}) pillow=${env.pillowVersion || 'N/A'}`);
console.log(`预处理变体: ${activeVariants.map((v) => v.id).join('/')}  pipeline=${args.pipeline}`);
if (!env.winrtScriptExists) console.warn('[bench] 警告: scripts/pwsh/ocr-winrt.ps1 不存在，WinRT 会全部失败');
if (!env.rapidocrOk) console.warn('[bench] 警告: RapidOCR 不可用，rapid 结果会全部失败');

mkdirSync(RESULTS_DIR, { recursive: true });

// ── 1. 预处理变体 ────────────────────────────────────────────────────────
const imagePathOf = (img, variant) => {
  if (variant === 'orig') return join(CORPUS_DIR, img.image);
  return join(DERIVED_DIR, variant, `${img.captureId}.png`);
};
const prepareTasks = [];
for (const variant of activeVariants) {
  if (variant.id === 'orig') continue;
  for (const img of selected) {
    prepareTasks.push({
      variant: variant.id,
      src: join(CORPUS_DIR, img.image),
      dst: imagePathOf(img, variant.id),
    });
  }
}
const prepStart = Date.now();
const prep = await prepareVariants(prepareTasks);
console.log(`\n[1/3] 预处理变体: ${prep.count} 张（${Date.now() - prepStart}ms）→ ${relative(REPO_ROOT, DERIVED_DIR)}/`);

// ── 2. 引擎 × 变体跑图 ───────────────────────────────────────────────────
const engineIds = args.engine === 'all' ? ['winrt', 'rapid'] : [args.engine];
// baseline/v3/ab 组只需要 RapidOCR × orig（首读对比用），跑其它变体会白等数分钟→ 自动收敛。
const rapidOnlyOrig = baselineEnabled || v3Enabled || abEnabled;
// rapid 在 baseline/v3/ab 组中一律只跑原图；即使 --variants 未显式包含 orig 也要补上，
// 否则这些组会因「缺少 rapidocr × orig」被静默跳过（task-24 复核发现的可用性小坑）。
const variantsFor = (engineId) =>
  engineId === 'rapid' && rapidOnlyOrig
    ? [activeVariants.find((v) => v.id === 'orig') || variantById('orig')]
    : activeVariants;
console.log(`引擎/变体: ${engineIds.map((e) => `${e}=[${variantsFor(e).map((v) => v.id).join(',')}]`).join(' ')}`);
const runs = new Map(); // key = `${engine}|${variant}`

/**
 * 跑一个（引擎, 变体）组合。
 * @returns {Promise<{engine:string, variant:string, records:Array, wallMs:number, modelLoadMs:number}>}
 */
async function runEngineVariant(engineId, variantId) {
  const variant = variantById(variantId);
  const startWall = Date.now();
  const records = [];
  if (engineId === 'winrt') {
    for (let i = 0; i < selected.length; i++) {
      const img = selected[i];
      const path = imagePathOf(img, variantId);
      try {
        const r = await runWinrt(path);
        records.push({ captureId: img.captureId, ok: true, elapsedMs: r.elapsedMs, wallMs: r.wallMs, cpuMs: r.cpuMs, rssMB: r.rssMB, lines: r.lines });
      } catch (err) {
        records.push({ captureId: img.captureId, ok: false, error: String(err.message || err), lines: [] });
      }
      if (args.verbose) process.stdout.write(`  winrt ${variantId} ${i + 1}/${selected.length}\r`);
    }
  } else {
    const paths = selected.map((img) => imagePathOf(img, variantId));
    try {
      const batch = await runRapidocrBatch(paths);
      for (let i = 0; i < selected.length; i++) {
        const item = batch.items[i];
        records.push({
          captureId: selected[i].captureId,
          ok: Boolean(item && item.ok),
          elapsedMs: item ? item.elapsedMs : 0,
          lines: item ? item.lines || [] : [],
          error: item ? item.error : '批量结果缺失',
        });
      }
      const modelLoadMs = batch.modelLoadMs;
      const wallMs = Date.now() - startWall;
      return { engine: engineId, variant: variantId, records, wallMs, modelLoadMs };
    } catch (err) {
      const msg = String(err.message || err);
      for (const img of selected) records.push({ captureId: img.captureId, ok: false, error: msg, lines: [] });
      return { engine: engineId, variant: variantId, records, wallMs: Date.now() - startWall, modelLoadMs: 0 };
    }
  }
  return { engine: engineId, variant: variantId, records, wallMs: Date.now() - startWall, modelLoadMs: 0 };
}

const totalUnits = engineIds.reduce((n, e) => n + variantsFor(e).length, 0);
let doneUnits = 0;
const variantImages = selected.map((img) => ({
  img,
  origPath: imagePathOf(img, 'orig'),
  variants: Object.fromEntries(activeVariants.map((v) => [v.id, imagePathOf(img, v.id)])),
}));

// winrt 顺序跑；rapid 批量跑；两者都按 variant 轮转，便于中途看进度
const pending = [];
for (const engineId of engineIds) for (const variant of variantsFor(engineId)) pending.push([engineId, variant.id]);
console.log(`\n[2/3] 开始跑图：${totalUnits} 个（引擎×变体）组合，共 ${totalUnits * selected.length} 次识别`);
for (const [engineId, variantId] of pending) {
  const t0 = Date.now();
  const run = await runEngineVariant(engineId, variantId);
  runs.set(`${engineId}|${variantId}`, run);
  doneUnits++;
  const failed = run.records.filter((r) => !r.ok).length;
  console.log(
    `  [${doneUnits}/${totalUnits}] ${engineId.padEnd(6)} × ${variantId.padEnd(13)} ${String(Date.now() - t0).padStart(6)}ms` +
      `  失败 ${failed}/${run.records.length}` +
      (run.modelLoadMs ? `  模型加载 ${run.modelLoadMs}ms` : ''),
  );
}

// ── 3. 指标计算 ──────────────────────────────────────────────────────────

const ms = (v) => (Number.isFinite(v) ? Math.round(v) : 0);

/** 行是否属于窗口 chrome（标题/输入框/时间戳）：中心落在 context region 或文本等于 context 文本。 */
function isChrome(box, text, img) {
  const center = boxCenter(box);
  const norm = normalizeForCompare(normalizeCjkSpaces(text));
  for (const ctx of img.expectedContext || []) {
    if (ctx.region && pointInRegion(center, ctx.region)) return true;
    if (norm && norm === normalizeForCompare(ctx.text)) return true;
  }
  return false;
}

/** 把引擎输出换算成「原图坐标 + CJK 空格归一化」的内容行（剔除 chrome / 空行）。 */
function contentLinesOf(runRecord, variant, img) {
  const variantDef = variantById(variant);
  const scale = variantDef ? variantDef.coordScale : 1;
  const offX = variantDef ? variantDef.coordOffsetX || 0 : 0;
  const offY = variantDef ? variantDef.coordOffsetY || 0 : 0;
  const out = [];
  for (const line of runRecord.lines || []) {
    // 先换算回原图坐标，否则放大/裁剪变体的 chrome 区域判定会失效
    const box = { x: line.x / scale + offX, y: line.y / scale + offY, w: line.w / scale, h: line.h / scale };
    if (isChrome(box, line.text, img)) continue;
    const text = normalizeCjkSpaces(line.text);
    if (!normalizeForCompare(text)) continue;
    out.push({
      text,
      box,
      score: line.score,
      raw: line.text,
    });
  }
  return out;
}

/** GT 行列表（消息文本可能多行）。 */
function gtLinesOf(img) {
  const out = [];
  img.expectedMessages.forEach((msg, mi) => {
    const boxes = Array.isArray(msg.lineBoxes) && msg.lineBoxes.length > 0 ? msg.lineBoxes : [{ text: msg.text, bbox: msg.bbox }];
    boxes.forEach((lb, li) => {
      out.push({ msgIndex: mi, lineIndex: li, text: lb.text, box: toBox(lb.bbox) });
    });
  });
  return out;
}

/**
 * 行匹配：归一化文本相似度为主、IoU 辅助；返回一对一匹配结果。
 * 未被匹配、但内容是某条 GT 消息文本子串的行（引擎把长行切成多段）单独归为 fragments，
 * 不算「假消息」，只影响行级 precision（记为 partial）。
 */
function matchLines(contentLines, gtLines, msgTexts) {
  const candidates = [];
  for (let oi = 0; oi < contentLines.length; oi++) {
    for (let gi = 0; gi < gtLines.length; gi++) {
      const sim = textSimilarity(contentLines[oi].text, gtLines[gi].text);
      const ov = iou(contentLines[oi].box, gtLines[gi].box);
      if (sim < 0.5) continue;
      if (sim < 1 && ov < 0.15) continue; // 文本不完全一致时要求位置也对得上
      candidates.push({ oi, gi, score: sim + ov * 0.5 });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.oi - b.oi || a.gi - b.gi);
  const matchedO = new Map(); // oi -> gi
  const matchedG = new Map(); // gi -> oi
  for (const c of candidates) {
    if (matchedO.has(c.oi) || matchedG.has(c.gi)) continue;
    matchedO.set(c.oi, c.gi);
    matchedG.set(c.gi, c.oi);
  }
  // 重复：未匹配上的行，其归一化文本与「已匹配上某 GT 行」的 OCR 行完全相同
  const matchedTexts = new Set();
  for (const [oi, gi] of matchedO) matchedTexts.add(normalizeForCompare(contentLines[oi].text));
  const duplicates = new Set();
  const falsePositives = new Set();
  for (let oi = 0; oi < contentLines.length; oi++) {
    if (matchedO.has(oi)) continue;
    if (matchedTexts.has(normalizeForCompare(contentLines[oi].text))) duplicates.add(oi);
    else falsePositives.add(oi);
  }
  // 行切分：内容确实是 GT 消息的一部分，只是被引擎切成多行
  const fragments = new Set();
  const msgNorm = (msgTexts || []).map((t) => normalizeForCompare(t)).filter(Boolean);
  for (const oi of [...falsePositives]) {
    const t = normalizeForCompare(contentLines[oi].text);
    if (t.length >= 3 && msgNorm.some((m) => m.includes(t))) {
      falsePositives.delete(oi);
      fragments.add(oi);
    }
  }
  return { matchedO, matchedG, duplicates, falsePositives, fragments };
}

function percentile(values, p) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (arr.length === 0) return 0;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[idx];
}

function ratio(n, d) {
  return d > 0 ? n / d : 0;
}

function f1Of(p, r) {
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

/**
 * 单图指标：
 *   - 行级 P/R/F1（归一化文本 + IoU）
 *   - 消息级 CER / 整句准确率（把匹配到的行按 GT 行序拼成消息文本再算）
 *   - 漏读/假消息/重复
 */
function metricsForImage(img, contentLines) {
  const gtLines = gtLinesOf(img);
  const emptyGt = img.expectedMessages.length === 0 && gtLines.length === 0;
  if (emptyGt) {
    // 空/错误截图：GT 无消息。正确行为 = 不产出任何非 chrome 行；产出行即假消息。
    const anyLine = contentLines.length > 0;
    return {
      cer: null,
      linePrecision: anyLine ? 0 : 1,
      lineRecall: null,
      lineF1: null,
      sentenceAcc: anyLine ? 0 : 1,
      missRate: 0,
      falseRate: anyLine ? 1 : 0,
      dupRate: 0,
      splitRate: 0,
      tp: 0,
      fp: contentLines.length,
      dup: 0,
      frag: 0,
      fn: 0,
      gtLines: 0,
      ocrLines: contentLines.length,
      sentences: 0,
      correctMessages: 0,
      totalEdit: 0,
      totalChars: 0,
      emptyGt: true,
      perMessage: [],
    };
  }
  const msgTexts = img.expectedMessages.map((m) => String(m.text || ''));
  const { matchedO, matchedG, duplicates, falsePositives, fragments } = matchLines(contentLines, gtLines, msgTexts);
  const tp = matchedO.size;
  const fp = falsePositives.size;
  const dup = duplicates.size;
  const frag = fragments.size;
  const fn = gtLines.length - matchedG.size;
  const precision = ratio(tp, tp + fp + dup + frag);
  const recall = ratio(tp, gtLines.length);
  const lineF1 = f1Of(precision, recall);
  const contentCount = contentLines.length;
  const missRate = ratio(fn, gtLines.length);
  const falseRate = ratio(fp, contentCount);
  const dupRate = ratio(dup, contentCount);
  const splitRate = ratio(frag, contentCount);

  let totalEdit = 0;
  let totalChars = 0;
  let correctMessages = 0;
  const perMessage = [];
  img.expectedMessages.forEach((msg, mi) => {
    const parts = [];
    (gtLines.filter((g) => g.msgIndex === mi)).forEach((g) => {
      const oi = matchedG.get(gtLines.indexOf(g));
      parts.push(oi === undefined ? '' : contentLines[oi].text);
    });
    const ocrText = parts.join('');
    const gtText = String(msg.text || '');
    const normOcr = normalizeForCompare(ocrText);
    const normGt = normalizeForCompare(gtText);
    const edit = levenshtein(normOcr, normGt);
    totalEdit += edit;
    totalChars += normGt.length;
    const exact = normOcr === normGt;
    if (exact) correctMessages++;
    perMessage.push({ text: gtText, ocrText, cer: ratio(edit, normGt.length), exact });
  });
  const cer = ratio(totalEdit, totalChars);
  const sentenceAcc = ratio(correctMessages, img.expectedMessages.length);
  return {
    cer,
    linePrecision: precision,
    lineRecall: recall,
    lineF1,
    sentenceAcc,
    missRate,
    falseRate,
    dupRate,
    splitRate,
    tp,
    fp,
    dup,
    frag,
    fn,
    gtLines: gtLines.length,
    ocrLines: contentCount,
    sentences: img.expectedMessages.length,
    correctMessages,
    totalEdit,
    totalChars,
    perMessage,
  };
}

/** 把同一张图上未匹配的行按 GT 消息 bbox 分组（baseline/v3 A/B 用；GT 辅助，见文件头说明）。 */
function groupLineItemsByMessage(contentLines, img) {
  const groups = img.expectedMessages.map(() => []);
  const msgBoxes = img.expectedMessages.map((m) => {
    const lineBoxes = Array.isArray(m.lineBoxes) ? m.lineBoxes.map((lb) => toBox(lb.bbox)) : [];
    return { union: mergeBoxes([toBox(m.bbox), ...lineBoxes]), lineBoxes };
  });
  for (const line of contentLines) {
    let bestIndex = -1;
    let bestScore = 0;
    msgBoxes.forEach((mb, i) => {
      const ovUnion = iou(line.box, mb.union);
      const ovLine = mb.lineBoxes.reduce((acc, lb) => Math.max(acc, iou(line.box, lb)), 0);
      const score = Math.max(ovUnion, ovLine);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });
    if (bestIndex >= 0 && bestScore >= 0.15) groups[bestIndex].push(line);
    // 不落在任何消息 bbox 上的行（假消息）不进分组
  }
  return groups.map((lines) => lines.slice().sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x));
}

/** 分组后按行序拼成一个消息文本（baseline 后处理用）。 */
function groupLinesByMessage(contentLines, img) {
  return groupLineItemsByMessage(contentLines, img).map((lines) => lines.map((l) => l.text).join(''));
}

/** 汇总一组图指标。 */
function aggregate(records, keyOf) {
  const buckets = new Map();
  const empty = () => ({
    images: 0,
    okImages: 0,
    failedImages: 0,
    elapsed: [],
    cerEdit: 0,
    cerChars: 0,
    sentences: 0,
    correct: 0,
    tp: 0,
    fp: 0,
    dup: 0,
    frag: 0,
    fn: 0,
    gtLines: 0,
    ocrLines: 0,
    cpu: [],
    rss: [],
    emptyGtImages: 0,
    emptyGtOk: 0,
  });
  for (const rec of records) {
    const key = keyOf(rec.captureId);
    if (!buckets.has(key)) buckets.set(key, empty());
    const b = buckets.get(key);
    b.images++;
    if (!rec.ok) {
      b.failedImages++;
      continue;
    }
    b.okImages++;
    const m = rec.metrics;
    b.elapsed.push(rec.elapsedMs);
    if (Number.isFinite(rec.cpuMs)) b.cpu.push(rec.cpuMs);
    if (Number.isFinite(rec.rssMB)) b.rss.push(rec.rssMB);
    if (m.emptyGt) {
      b.emptyGtImages++;
      if (m.sentenceAcc === 1) b.emptyGtOk++;
    }
    b.cerEdit += m.totalEdit;
    b.cerChars += m.totalChars;
    b.sentences += m.sentences;
    b.correct += m.correctMessages;
    b.tp += m.tp;
    b.fp += m.fp;
    b.dup += m.dup;
    b.frag += m.frag;
    b.fn += m.fn;
    b.gtLines += m.gtLines;
    b.ocrLines += m.ocrLines;
  }
  const out = {};
  for (const [key, b] of buckets) {
    const precision = ratio(b.tp, b.tp + b.fp + b.dup + b.frag);
    const recall = ratio(b.tp, b.gtLines);
    out[key] = {
      images: b.images,
      okImages: b.okImages,
      failedImages: b.failedImages,
      cer: ratio(b.cerEdit, b.cerChars),
      sentenceAcc: ratio(b.correct, b.sentences),
      linePrecision: precision,
      lineRecall: recall,
      lineF1: f1Of(precision, recall),
      missRate: ratio(b.fn, b.gtLines),
      falseRate: ratio(b.fp, b.ocrLines),
      dupRate: ratio(b.dup, b.ocrLines),
      splitRate: ratio(b.frag, b.ocrLines),
      p50Ms: ms(percentile(b.elapsed, 50)),
      p95Ms: ms(percentile(b.elapsed, 95)),
      cpuP50Ms: ms(percentile(b.cpu, 50)),
      cpuP95Ms: ms(percentile(b.cpu, 95)),
      rssP95MB: ms(percentile(b.rss, 95)),
      rssMaxMB: ms(b.rss.length ? Math.max(...b.rss) : 0),
      emptyGtImages: b.emptyGtImages,
      emptyGtOk: b.emptyGtOk,
      gtLines: b.gtLines,
      ocrLines: b.ocrLines,
      tp: b.tp,
      fp: b.fp,
      dup: b.dup,
      frag: b.frag,
      fn: b.fn,
    };
  }
  return out;
}

const imageById = new Map(selected.map((img) => [img.captureId, img]));
const timestamp = startedAt.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const runFiles = [];
const summaryRuns = [];

function pct(v) {
  return Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : 'N/A';
}
function num(v, digits = 4) {
  return Number.isFinite(v) ? v.toFixed(digits) : 'N/A';
}

for (const engineId of engineIds) {
  for (const variant of variantsFor(engineId)) {
    const run = runs.get(`${engineId}|${variant.id}`);
    if (!run) continue;
    const records = [];
    for (const rec of run.records) {
      const img = imageById.get(rec.captureId);
      if (!img) continue;
      const base = { captureId: rec.captureId, scenario: img.scenario, ok: rec.ok, elapsedMs: rec.elapsedMs, cpuMs: rec.cpuMs, rssMB: rec.rssMB };
      if (!rec.ok) {
        records.push({ ...base, error: rec.error, metrics: null, lines: [] });
        continue;
      }
      const contentLines = contentLinesOf(rec, variant.id, img);
      const metrics = metricsForImage(img, contentLines);
      records.push({
        ...base,
        wallMs: rec.wallMs,
        lines: contentLines.map((l) => ({ text: l.text, x: l.box.x, y: l.box.y, w: l.box.w, h: l.box.h, score: l.score })),
        metrics,
      });
    }
    const totals = aggregate(records, (captureId) => (imageById.get(captureId) || {}).scenario);
    // 全量桶（aggregate 的 key 是场景，这里额外算一份不按场景拆的总指标）
    const overall = aggregate(records, () => '__all').__all;
    const fileName = `${timestamp}-${args.split}-${engineId}-${variant.id}.json`;
    const filePath = join(RESULTS_DIR, fileName);
    const payload = {
      meta: {
        bench: 'ocr-benchmark',
        version: 'v3.0.0',
        generatedAt: new Date().toISOString(),
        command: process.argv.slice(2).join(' '),
        engine: engineId,
        variant: variant.id,
        variantLabel: variant.label,
        python: env.python,
        pythonVersion: env.pythonVersion,
        pillowVersion: env.pillowVersion,
        node: env.nodeVersion,
        platform: env.platform,
        corpus: {
          manifest: relative(REPO_ROOT, MANIFEST_PATH),
          seed: manifest.seed,
          scenarioCount: manifest.scenarioCount,
          imageCount: selected.length,
          split: args.split,
          splitScenarios: args.split === 'all' ? splitScenarios : splitScenarios[args.split],
        },
        durationMs: run.wallMs,
        modelLoadMs: run.modelLoadMs,
      },
      images: records,
      totals: overall,
      byScenario: totals,
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 1), 'utf8');
    runFiles.push(fileName);
    summaryRuns.push({ engine: engineId, variant: variant.id, file: fileName, totals: overall });
    console.log(
      `\n[${engineId} × ${variant.id}] CER ${pct(overall.cer)}  行 F1 ${num(overall.lineF1, 3)}  整句 ${pct(overall.sentenceAcc)}` +
        `  漏读 ${pct(overall.missRate)}  假消息 ${pct(overall.falseRate)}  重复 ${pct(overall.dupRate)}` +
        `  P50 ${overall.p50Ms}ms P95 ${overall.p95Ms}ms`,
    );
    console.log(`  场景明细: ${Object.entries(totals).map(([s, t]) => `${s}:${pct(t.cer)}`).join('  ')}`);
  }
}

// ── 4. baseline（v0.2.8 后处理）A/B ─────────────────────────────────────
let baselineSummary = null;
if (baselineEnabled) {
  const winrtOrig = runs.get('winrt|orig');
  const winrt2x = runs.get('winrt|upscale2x');
  const rapidOrig = runs.get('rapid|orig');
  if (!winrtOrig) {
    console.warn('\n[baseline] 跳过：缺少 winrt × orig 结果（--engine 需含 winrt）');
  } else if (!winrt2x) {
    console.warn('\n[baseline] 跳过：缺少 winrt × upscale2x 结果（--pipeline=baseline 需要全部变体）');
  } else if (!rapidOrig) {
    console.warn('\n[baseline] 跳过：缺少 rapidocr × orig 结果（--engine 需含 rapid）');
  } else {
    console.log('\n[3/4] baseline v0.2.8 后处理 A/B（winrt 原始行 → desktop.ts 转写后处理）');
    const recById = new Map(winrtOrig.records.map((r) => [r.captureId, r]));
    const rec2x = new Map(winrt2x.records.map((r) => [r.captureId, r]));
    const recRapid = new Map(rapidOrig.records.map((r) => [r.captureId, r]));
    const baseRecords = [];
    let corrCount = 0;
    let improved = 0;
    let worsened = 0;
    for (const img of selected) {
      const r1 = recById.get(img.captureId);
      const r2 = rec2x.get(img.captureId);
      const rr = recRapid.get(img.captureId);
      if (!r1 || !r1.ok) {
        baseRecords.push({ captureId: img.captureId, scenario: img.scenario, ok: false, error: (r1 && r1.error) || '无原始行', metrics: null });
        continue;
      }
      const c1 = contentLinesOf(r1, 'orig', img);
      const c2 = r2 && r2.ok ? contentLinesOf(r2, 'upscale2x', img) : [];
      const cr = rr && rr.ok ? contentLinesOf(rr, 'orig', img) : [];
      const g1 = groupLinesByMessage(c1, img);
      const g2 = groupLinesByMessage(c2, img);
      const gr = groupLinesByMessage(cr, img);
      let editRaw = 0;
      let editPost = 0;
      let chars = 0;
      let correctRaw = 0;
      let correctPost = 0;
      const perMessage = [];
      for (let mi = 0; mi < img.expectedMessages.length; mi++) {
        const gtText = String(img.expectedMessages[mi].text || '');
        const rawText = g1[mi] || '';
        const postText = await baselinePostprocessMessage(rawText, {
          frames: { '2': g2[mi] || '' },
          secondEngineText: gr[mi] || '',
        });
        const normGt = normalizeForCompare(gtText);
        const eRaw = levenshtein(normalizeForCompare(rawText), normGt);
        const ePost = levenshtein(normalizeForCompare(postText), normGt);
        editRaw += eRaw;
        editPost += ePost;
        chars += normGt.length;
        if (normalizeForCompare(rawText) === normGt) correctRaw++;
        if (normalizeForCompare(postText) === normGt) correctPost++;
        const changed = normalizeForCompare(postText) !== normalizeForCompare(rawText);
        if (changed) {
          corrCount++;
          if (ePost < eRaw) improved++;
          else if (ePost > eRaw) worsened++;
        }
        perMessage.push({ text: gtText, rawText, postText, changed, cer_raw: ratio(eRaw, normGt.length), cer_post: ratio(ePost, normGt.length) });
      }
      baseRecords.push({
        captureId: img.captureId,
        scenario: img.scenario,
        ok: true,
        metrics: {
          cerRaw: ratio(editRaw, chars),
          cerPost: ratio(editPost, chars),
          sentenceAccRaw: ratio(correctRaw, img.expectedMessages.length),
          sentenceAccPost: ratio(correctPost, img.expectedMessages.length),
          editRaw,
          editPost,
          chars,
          perMessage,
        },
      });
    }
    const totals = aggregateBaseline(baseRecords);
    const fileName = `${timestamp}-${args.split}-baseline-v028-orig.json`;
    const filePath = join(RESULTS_DIR, fileName);
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          meta: {
            bench: 'ocr-benchmark-baseline',
            version: 'v0.2.8-postprocess',
            generatedAt: new Date().toISOString(),
            command: process.argv.slice(2).join(' '),
            source: 'scripts/ocr/baseline-v028.mjs（逐行转写自 src/channels/pc/desktop.ts:61-163、:307-355）',
            frames: { '2': 'winrt upscale2x 行（坐标 /2 后按 GT bbox 分组）', '4': '未采集（bench 未生成 4x 变体）' },
            secondEngine: 'rapidocr × orig 行',
            grouping: 'GT bbox 近似分组（bench 内部；真实 pipeline 按 UI 坐标分组）',
            corpus: { manifest: relative(REPO_ROOT, MANIFEST_PATH), seed: manifest.seed, imageCount: selected.length },
            env: {
              platform: env.platform,
              node: env.nodeVersion,
              pythonVersion: env.pythonVersion,
              pillowVersion: env.pillowVersion,
              rapidocr: env.rapidocrOk ? 'available' : 'unavailable',
            },
          },
          images: baseRecords,
          totals,
        },
        null,
        1,
      ),
      'utf8',
    );
    runFiles.push(fileName);
    baselineSummary = { engine: 'baseline-v0.2.8', variant: 'orig', file: fileName, totals };
    summaryRuns.push(baselineSummary);
    console.log(
      `[baseline] 原始行整句 ${pct(totals.sentenceAccRaw)} / CER ${pct(totals.cerRaw)}` +
        `  →  后处理后整句 ${pct(totals.sentenceAccPost)} / CER ${pct(totals.cerPost)}` +
        `  改动 ${corrCount} 条（改善 ${improved} / 变差 ${worsened}）`,
    );
  }
}

// ── 4b. v3 管线离线等价 A/B ─────────────────────────────────────────────
// winrt 2x 行 → normalize → （可疑消息时）RapidOCR 同帧投票 → 受控纠错。
// 三种配置全部计算：tune 集选参、eval 集只报选中配置；all-40 用于补充对照。
let v3Summaries = [];
if (v3Enabled) {
  const winrt2xRun = runs.get('winrt|upscale2x');
  const rapidOrigRun = runs.get('rapid|orig');
  if (!winrt2xRun) {
    console.warn('\n[v3] 跳过：缺少 winrt × upscale2x 结果（--engine 需含 winrt）');
  } else if (!rapidOrigRun) {
    console.warn('\n[v3] 跳过：缺少 rapidocr × orig 结果（v3 第二引擎投票需要 --engine=all）');
  } else {
    console.log(`\n[4/4] v3 管线离线等价（配置 ${V3_CONFIGS.map((c) => c.id).join(' / ')}）`);
    const rec2x = new Map(winrt2xRun.records.map((r) => [r.captureId, r]));
    const recRapid = new Map(rapidOrigRun.records.map((r) => [r.captureId, r]));
    const v3Records = new Map(V3_CONFIGS.map((cfg) => [cfg.id, []]));
    const attributionRecords = [];
    for (const img of selected) {
      const r2 = rec2x.get(img.captureId);
      const rr = recRapid.get(img.captureId);
      if (!r2 || !r2.ok) {
        for (const cfg of V3_CONFIGS) {
          v3Records.get(cfg.id).push({ captureId: img.captureId, scenario: img.scenario, ok: false, error: (r2 && r2.error) || '无 winrt 2x 行', metrics: null });
        }
        continue;
      }
      const c2 = contentLinesOf(r2, 'upscale2x', img);
      const cr = rr && rr.ok ? contentLinesOf(rr, 'orig', img) : [];
      const groups = groupLineItemsByMessage(c2, img);
      // 气泡归属（与管线配置无关，单独统计）
      attributionRecords.push({
        captureId: img.captureId,
        scenario: img.scenario,
        messages: groups.map((lines, mi) => {
          const side = classifySide(lines, img.width);
          return { gtSender: img.expectedMessages[mi].sender, side: side.side, reason: side.reason, lineCount: lines.length };
        }),
      });
      for (const cfg of V3_CONFIGS) {
        const perMessage = [];
        let edit = 0;
        let chars = 0;
        let correct = 0;
        let garbledCount = 0;
        let scriptReplaced = 0;
        let desktopVoted = 0;
        let correctedCount = 0;
        let protectedSkipped = 0;
        groups.forEach((lines, mi) => {
          const gtText = String(img.expectedMessages[mi].text || '');
          const winText = lines.map((l) => l.text).join('');
          const winTop = lines.length > 0 ? Math.min(...lines.map((l) => l.box.y)) : 0;
          const info = runV3Message({ gtText, winText, winTop, rapidLines: cr, config: cfg.id });
          const normGt = normalizeForCompare(gtText);
          const e = levenshtein(normalizeForCompare(info.finalText), normGt);
          edit += e;
          chars += normGt.length;
          if (normalizeForCompare(info.finalText) === normGt) correct += 1;
          if (info.garbled) garbledCount += 1;
          if (info.scriptReplaced) scriptReplaced += 1;
          if (info.desktopVoted) desktopVoted += 1;
          if (info.corrected) correctedCount += 1;
          protectedSkipped += info.protectedSkipped;
          perMessage.push({
            gtText,
            winText: info.winText,
            finalText: info.finalText,
            cer: ratio(e, normGt.length),
            garbled: info.garbled,
            matched: info.matched,
            matchedOverlap: Number(info.matchedOverlap.toFixed(4)),
            scriptReplaced: info.scriptReplaced,
            desktopVoted: info.desktopVoted,
            corrected: info.corrected,
            correctedChanges: info.changes.length,
            protectedSkipped: info.protectedSkipped,
          });
        });
        v3Records.get(cfg.id).push({
          captureId: img.captureId,
          scenario: img.scenario,
          ok: true,
          metrics: {
            messages: groups.length,
            edit,
            chars,
            cer: ratio(edit, chars),
            correct,
            sentenceAcc: ratio(correct, groups.length),
            garbledCount,
            scriptReplacedCount: scriptReplaced,
            desktopVotedCount: desktopVoted,
            correctedCount,
            protectedSkipped,
            perMessage,
          },
        });
      }
    }
    const attribution = aggregateAttribution(attributionRecords);
    for (const cfg of V3_CONFIGS) {
      const records = v3Records.get(cfg.id);
      const totals = aggregateV3(records);
      const fileName = `${timestamp}-${args.split}-v3-${cfg.id}.json`;
      const filePath = join(RESULTS_DIR, fileName);
      const payload = {
        meta: {
          bench: 'ocr-benchmark-v3-pipeline',
          version: 'v3.0.0',
          generatedAt: new Date().toISOString(),
          command: process.argv.slice(2).join(' '),
          pipelineConfig: cfg.id,
          pipelineConfigLabel: cfg.label,
          split: args.split,
          splitScenarios: args.split === 'all' ? splitScenarios : splitScenarios[args.split],
          inputs: {
            primary: 'winrt × upscale2x 行（坐标 /2 后按 GT bbox 分组）',
            secondEngine: 'rapidocr × orig 行（同帧；按 |y-top|≤26 + 重合度≥0.35 + 更长才替换）',
          },
          offlineEquivalence: V3_NOTES,
          corpus: {
            manifest: relative(REPO_ROOT, MANIFEST_PATH),
            seed: manifest.seed,
            scenarioCount: manifest.scenarioCount,
            imageCount: selected.length,
            split: args.split,
            splitScenarios: args.split === 'all' ? splitScenarios : splitScenarios[args.split],
          },
          env: {
            platform: env.platform,
            node: env.nodeVersion,
            pythonVersion: env.pythonVersion,
            pillowVersion: env.pillowVersion,
            rapidocr: env.rapidocrOk ? 'available' : 'unavailable',
          },
        },
        images: records,
        totals,
        attribution,
      };
      writeFileSync(filePath, JSON.stringify(payload, null, 1), 'utf8');
      runFiles.push(fileName);
      const summaryEntry = { engine: 'v3-pipeline', variant: cfg.id, file: fileName, totals, attribution };
      v3Summaries.push(summaryEntry);
      summaryRuns.push(summaryEntry);
      console.log(
        `\n[v3 × ${cfg.id}] CER ${pct(totals.cer)}  整句 ${pct(totals.sentenceAcc)}` +
          `  可疑消息 ${totals.garbledMessages}/${totals.messages}` +
          `  第二引擎替换 ${totals.scriptReplacedMessages}  纠错改动 ${totals.correctedMessages}（保护跳过 ${totals.protectedSkipped}）`,
      );
      console.log(`  场景明细: ${Object.entries(totals.byScenario).map(([s, t]) => `${s}:${pct(t.cer)}`).join('  ')}`);
    }
    console.log(
      `\n[v3 气泡归属] 消息 ${attribution.messages} 条，判定 ${attribution.classified}（覆盖率 ${pct(attribution.coverage)}）` +
        `，左右正确 ${pct(attribution.sideAccuracy)}，uncertain ${pct(ratio(attribution.uncertain, attribution.messages))}` +
        `；inbound 精确率 ${pct(attribution.inbound.precision)} 召回 ${pct(attribution.inbound.recall)}`,
    );
  }
}

function aggregateV3(records) {
  const ok = records.filter((r) => r.ok);
  const sum = (key) => ok.reduce((acc, r) => acc + r.metrics[key], 0);
  const byScenario = new Map();
  for (const r of ok) {
    const s = r.scenario;
    if (!byScenario.has(s)) {
      byScenario.set(s, { messages: 0, edit: 0, chars: 0, correct: 0, garbled: 0, scriptReplaced: 0, desktopVoted: 0, corrected: 0, protectedSkipped: 0 });
    }
    const b = byScenario.get(s);
    b.messages += r.metrics.messages;
    b.edit += r.metrics.edit;
    b.chars += r.metrics.chars;
    b.correct += r.metrics.correct;
    b.garbled += r.metrics.garbledCount;
    b.scriptReplaced += r.metrics.scriptReplacedCount;
    b.desktopVoted += r.metrics.desktopVotedCount;
    b.corrected += r.metrics.correctedCount;
    b.protectedSkipped += r.metrics.protectedSkipped;
  }
  return {
    images: records.length,
    okImages: ok.length,
    failedImages: records.length - ok.length,
    messages: sum('messages'),
    cer: ratio(sum('edit'), sum('chars')),
    sentenceAcc: ratio(sum('correct'), sum('messages')),
    garbledMessages: sum('garbledCount'),
    scriptReplacedMessages: sum('scriptReplacedCount'),
    desktopVotedMessages: sum('desktopVotedCount'),
    correctedMessages: sum('correctedCount'),
    protectedSkipped: sum('protectedSkipped'),
    byScenario: Object.fromEntries(
      [...byScenario.entries()].map(([s, b]) => [
        s,
        {
          messages: b.messages,
          cer: ratio(b.edit, b.chars),
          sentenceAcc: ratio(b.correct, b.messages),
          garbledMessages: b.garbled,
          scriptReplacedMessages: b.scriptReplaced,
          desktopVotedMessages: b.desktopVoted,
          correctedMessages: b.corrected,
          protectedSkipped: b.protectedSkipped,
        },
      ]),
    ),
  };
}

function aggregateAttribution(records) {
  const bySide = {
    left: { predicted: 0, gtCount: 0, tp: 0, fp: 0 },
    right: { predicted: 0, gtCount: 0, tp: 0, fp: 0 },
  };
  const uncertainReasons = {};
  let messages = 0;
  let classified = 0;
  let correct = 0;
  let wrong = 0;
  let uncertain = 0;
  for (const rec of records) {
    for (const m of rec.messages) {
      messages += 1;
      bySide[m.gtSender].gtCount += 1;
      if (m.side === 'uncertain') {
        uncertain += 1;
        uncertainReasons[m.reason] = (uncertainReasons[m.reason] || 0) + 1;
        continue;
      }
      classified += 1;
      if (m.side === m.gtSender) correct += 1;
      else wrong += 1;
      const b = bySide[m.side];
      b.predicted += 1;
      if (m.side === m.gtSender) b.tp += 1;
      else b.fp += 1;
    }
  }
  return {
    messages,
    classified,
    correct,
    wrong,
    uncertain,
    sideAccuracy: ratio(correct, classified),
    coverage: ratio(classified, messages),
    uncertainReasons,
    inbound: {
      predicted: bySide.left.predicted,
      tp: bySide.left.tp,
      fp: bySide.left.fp,
      precision: ratio(bySide.left.tp, bySide.left.predicted),
      recall: ratio(bySide.left.tp, bySide.left.gtCount),
    },
    outbound: {
      predicted: bySide.right.predicted,
      tp: bySide.right.tp,
      fp: bySide.right.fp,
      precision: ratio(bySide.right.tp, bySide.right.predicted),
      recall: ratio(bySide.right.tp, bySide.right.gtCount),
    },
  };
}

function aggregateBaseline(records) {
  const ok = records.filter((r) => r.ok);
  const sum = (key) => ok.reduce((acc, r) => acc + r.metrics[key], 0);
  const byScenario = new Map();
  for (const r of ok) {
    const s = r.scenario;
    if (!byScenario.has(s)) byScenario.set(s, { editRaw: 0, editPost: 0, chars: 0, messages: 0, correctRaw: 0, correctPost: 0, changed: 0, improved: 0, worsened: 0 });
    const b = byScenario.get(s);
    b.editRaw += r.metrics.editRaw;
    b.editPost += r.metrics.editPost;
    b.chars += r.metrics.chars;
    b.messages += r.metrics.perMessage.length;
    b.correctRaw += Math.round(r.metrics.sentenceAccRaw * r.metrics.perMessage.length);
    b.correctPost += Math.round(r.metrics.sentenceAccPost * r.metrics.perMessage.length);
    for (const m of r.metrics.perMessage) {
      if (m.changed) {
        b.changed++;
        if (m.cer_post < m.cer_raw) b.improved++;
        else if (m.cer_post > m.cer_raw) b.worsened++;
      }
    }
  }
  const chars = sum('chars');
  return {
    images: records.length,
    okImages: ok.length,
    failedImages: records.length - ok.length,
    messages: ok.reduce((acc, r) => acc + r.metrics.perMessage.length, 0),
    cerRaw: ratio(sum('editRaw'), chars),
    cerPost: ratio(sum('editPost'), chars),
    sentenceAccRaw: ratio(
      ok.reduce((acc, r) => acc + Math.round(r.metrics.sentenceAccRaw * r.metrics.perMessage.length), 0),
      ok.reduce((acc, r) => acc + r.metrics.perMessage.length, 0),
    ),
    sentenceAccPost: ratio(
      ok.reduce((acc, r) => acc + Math.round(r.metrics.sentenceAccPost * r.metrics.perMessage.length), 0),
      ok.reduce((acc, r) => acc + r.metrics.perMessage.length, 0),
    ),
    changedMessages: ok.reduce((acc, r) => acc + r.metrics.perMessage.filter((m) => m.changed).length, 0),
    improvedMessages: ok.reduce((acc, r) => acc + r.metrics.perMessage.filter((m) => m.changed && m.cer_post < m.cer_raw).length, 0),
    worsenedMessages: ok.reduce((acc, r) => acc + r.metrics.perMessage.filter((m) => m.changed && m.cer_post > m.cer_raw).length, 0),
    byScenario: Object.fromEntries(
      [...byScenario.entries()].map(([s, b]) => [
        s,
        {
          cerRaw: ratio(b.editRaw, b.chars),
          cerPost: ratio(b.editPost, b.chars),
          sentenceAccRaw: ratio(b.correctRaw, b.messages),
          sentenceAccPost: ratio(b.correctPost, b.messages),
          changed: b.changed,
          improved: b.improved,
          worsened: b.worsened,
        },
      ]),
    ),
  };
}

// ── 4.6 12.3 A/B 六组消融（tune 选参、eval 报数；同口径 GT bbox 分组）────
// A=v0.2.8 baseline；B=仅预处理（最优变体）；C=仅换引擎（RapidOCR）；
// D=仅新对齐（B 的行经新对齐过滤）；E=仅新融合（对齐后行 + 消息级融合，不含纠错）；
// F=完整 v3（B 的最优变体 + v3 管线：可疑投票 + 受控纠错）。
let abSummary = null;
if (abEnabled) {
  const required = [
    ['winrt', 'orig'],
    ['winrt', 'upscale2x'],
    ['winrt', BEST_VARIANT],
    ['rapid', 'orig'],
  ];
  const missing = required.filter(([e, v]) => !runs.has(`${e}|${v}`));
  if (missing.length > 0) {
    console.warn(`\n[ab] 跳过：缺少 ${missing.map(([e, v]) => `${e}×${v}`).join(', ')} 结果（--engine 需含全部所需引擎）`);
  } else {
    console.log(`\n[ab] 12.3 A/B 六组消融（最优预处理变体=${BEST_VARIANT}，由 tune 集选出）`);
    const recOf = (engine, variant) => new Map(runs.get(`${engine}|${variant}`).records.map((r) => [r.captureId, r]));
    const recOrig = recOf('winrt', 'orig');
    const rec2x = recOf('winrt', 'upscale2x');
    const recBest = recOf('winrt', BEST_VARIANT);
    const recRapid = recOf('rapid', 'orig');
    const groupDefs = [
      { id: 'A', label: 'v0.2.8 baseline（winrt orig + desktop.ts 后处理）', stage: 'baseline' },
      { id: 'B', label: `仅预处理（winrt ${BEST_VARIANT}）+ v0.2.8 后处理`, stage: 'preprocess' },
      { id: 'C', label: '仅换引擎（RapidOCR orig，无第二引擎）', stage: 'engine' },
      { id: 'D', label: '仅新对齐（B 的行按新对齐过滤，未对齐行丢弃）', stage: 'align' },
      { id: 'E', label: '仅新融合（对齐后行 + 消息级投票，不含纠错）', stage: 'fusion' },
      { id: 'F', label: `完整 v3（winrt ${BEST_VARIANT} + v3 管线：投票 + 纠错）`, stage: 'full-v3' },
    ];
    const acc = Object.fromEntries(
      groupDefs.map((g) => [g.id, { edit: 0, chars: 0, correct: 0, messages: 0, emptyGtOk: 0, perMessage: [] }]),
    );
    const abImages = [];
    // 12.2 事件类指标：双引擎冲突、气泡归属不确定、纠错误改、同消息重复行（bench 级近似）
    const events = { messages: 0, conflictCount: 0, uncertainCount: 0, correctedCount: 0, misCorrectedCount: 0, duplicateEvents: 0 };
    for (const img of selected) {
      const rOrig = recOrig.get(img.captureId);
      const r2x = rec2x.get(img.captureId);
      const rBest = recBest.get(img.captureId);
      const rRapid = recRapid.get(img.captureId);
      if (!rOrig || !rOrig.ok || !r2x || !r2x.ok || !rBest || !rBest.ok || !rRapid || !rRapid.ok) {
        abImages.push({ captureId: img.captureId, scenario: img.scenario, ok: false });
        continue;
      }
      const cOrig = contentLinesOf(rOrig, 'orig', img);
      const c2x = contentLinesOf(r2x, 'upscale2x', img);
      const cBest = contentLinesOf(rBest, BEST_VARIANT, img);
      const cRapid = contentLinesOf(rRapid, 'orig', img);
      const itemsOrig = groupLineItemsByMessage(cOrig, img);
      const items2x = groupLineItemsByMessage(c2x, img);
      const itemsBest = groupLineItemsByMessage(cBest, img);
      const itemsRapid = groupLineItemsByMessage(cRapid, img);
      const aligned = alignLinesToSecondEngine(cBest, cRapid);
      const itemsAligned = groupLineItemsByMessage(aligned.aligned, img);
      const textOf = (items, mi) => (items[mi] || []).map((l) => l.text).join('');
      const topOf = (items, mi) => {
        const lines = items[mi] || [];
        return lines.length ? Math.min(...lines.map((l) => l.box.y)) : 0;
      };
      const texts = { A: [], B: [], C: [], D: [], E: [], F: [] };
      const perMessage = [];
      for (let mi = 0; mi < img.expectedMessages.length; mi++) {
        const gtText = String(img.expectedMessages[mi].text || '');
        const g2x = textOf(items2x, mi);
        const gRapid = textOf(itemsRapid, mi);
        // A：v0.2.8 baseline（原始行 + 2x 帧 + 第二引擎）
        texts.A.push(await baselinePostprocessMessage(textOf(itemsOrig, mi), { frames: { '2': g2x }, secondEngineText: gRapid }));
        // B：仅换预处理，后处理管线不变
        texts.B.push(await baselinePostprocessMessage(textOf(itemsBest, mi), { frames: { '2': g2x }, secondEngineText: gRapid }));
        // C：仅换引擎（RapidOCR 作首读，无第二引擎/无多帧）
        texts.C.push(await baselinePostprocessMessage(gRapid, { frames: {}, secondEngineText: '' }));
        // D：B 的输入行先做新对齐过滤，再做 v0.2.8 后处理
        texts.D.push(await baselinePostprocessMessage(textOf(itemsAligned, mi), { frames: { '2': g2x }, secondEngineText: gRapid }));
        // E：新对齐后的行 + 只做消息级融合（不含受控纠错）
        const eInfo = runV3Message({
          gtText,
          winText: textOf(itemsAligned, mi),
          winTop: topOf(itemsAligned, mi),
          rapidLines: cRapid,
          config: { id: 'fusion-only', useVote: 'all', skipCorrection: true },
        });
        texts.E.push(eInfo.finalText);
        // F：完整 v3（最优变体 + 可疑投票 + 受控纠错）
        const fInfo = runV3Message({
          gtText,
          winText: textOf(itemsBest, mi),
          winTop: topOf(itemsBest, mi),
          rapidLines: cRapid,
          config: 'vote-garbled',
        });
        texts.F.push(fInfo.finalText);
        const normGt = normalizeForCompare(gtText);
        // 12.2 事件计数
        const normB = normalizeForCompare(texts.B[mi]);
        const normC = normalizeForCompare(texts.C[mi]);
        if (normB && normC && normB !== normC) events.conflictCount++;
        const sideInfo = classifySide(itemsBest[mi] || [], img.width);
        if (sideInfo.side === 'uncertain') events.uncertainCount++;
        for (let li = 0; li < (itemsBest[mi] || []).length; li++) {
          const t = normalizeForCompare((itemsBest[mi][li]).text);
          if (!t) continue;
          for (let lj = li + 1; lj < (itemsBest[mi] || []).length; lj++) {
            if (t === normalizeForCompare((itemsBest[mi][lj]).text)) {
              events.duplicateEvents++;
              break;
            }
          }
        }
        events.messages++;
        const fNorm = normalizeForCompare(texts.F[mi]);
        if (fNorm !== normB) {
          events.correctedCount++;
          const cerB = ratio(levenshtein(normB, normGt), normGt.length);
          const cerF = ratio(levenshtein(fNorm, normGt), normGt.length);
          if (cerF > cerB) events.misCorrectedCount++;
        }
        const row = { text: gtText, normGtLength: normGt.length };
        for (const g of groupDefs) {
          const normOcr = normalizeForCompare(texts[g.id][mi]);
          const edit = levenshtein(normOcr, normGt);
          row[g.id] = { ocrText: texts[g.id][mi], cer: ratio(edit, normGt.length), exact: normOcr === normGt };
          acc[g.id].edit += edit;
          acc[g.id].chars += normGt.length;
          acc[g.id].messages++;
          if (normOcr === normGt) acc[g.id].correct++;
        }
        perMessage.push(row);
      }
      if (img.expectedMessages.length === 0) {
        for (const g of groupDefs) acc[g.id].emptyGtOk++;
      }
      abImages.push({ captureId: img.captureId, scenario: img.scenario, ok: true, alignedPairs: aligned.pairs.length, droppedWinrtLines: aligned.dropped.length, texts, perMessage });
    }
    const groupTotals = {};
    const byScenario = {};
    for (const g of groupDefs) {
      groupTotals[g.id] = {
        id: g.id,
        label: g.label,
        stage: g.stage,
        cer: ratio(acc[g.id].edit, acc[g.id].chars),
        sentenceAcc: ratio(acc[g.id].correct, acc[g.id].messages),
        editDistance: acc[g.id].edit,
        gtChars: acc[g.id].chars,
        messages: acc[g.id].messages,
        correctMessages: acc[g.id].correct,
        emptyGtOk: acc[g.id].emptyGtOk,
      };
      const sc = {};
      for (const im of abImages) {
        if (!im.ok) continue;
        if (!sc[im.scenario]) sc[im.scenario] = { edit: 0, chars: 0, correct: 0, messages: 0 };
        const b = sc[im.scenario];
        for (const m of im.perMessage) {
          b.edit += Math.round(m[g.id].cer * m.normGtLength);
          b.chars += m.normGtLength;
          b.messages++;
          if (m[g.id].exact) b.correct++;
        }
      }
      byScenario[g.id] = Object.fromEntries(
        Object.entries(sc).map(([sid, b]) => [sid, { cer: ratio(b.edit, b.chars), sentenceAcc: ratio(b.correct, b.messages) }]),
      );
    }
    const abFileName = `${timestamp}-${args.split}-ab-six-groups.json`;
    const abPayload = {
      meta: {
        bench: 'ocr-benchmark-ab-six-groups',
        version: 'v3.0.0',
        generatedAt: new Date().toISOString(),
        command: process.argv.slice(2).join(' '),
        split: args.split,
        splitScenarios: args.split === 'all' ? splitScenarios : splitScenarios[args.split],
        bestVariant: BEST_VARIANT,
        bestVariantSource: 'tune 集 A–H 预处理实测（见 docs/OCR-BENCHMARK.md §4.5/§6.6）',
        groups: groupDefs,
        measure: '消息级 CER = Σ编辑距离 / ΣGT字符数（normalizeForCompare 后）；整句准确率 = 完全一致消息数 / 消息数',
        notes: [
          'A/B/D 沿用 v0.2.8 后处理（baseline-v028.mjs 离线转写，帧 2x/第二引擎 RapidOCR）。',
          'C 仅把首读引擎换成 RapidOCR，无第二引擎与多帧，其余后处理沿用。',
          'E 使用 aligned lines + 消息级融合（vote-all 口径）但关闭受控纠错，用于单独衡量融合。',
          'F 为完整 v3 管线离线等价（4x 帧未采集，偏保守）。',
          '所有组统一按 GT bbox 分组（真实 pipeline 按 UI 坐标分组），所以是相对消融比较而非线上绝对延迟。',
        ],
        corpus: { manifest: relative(REPO_ROOT, MANIFEST_PATH), seed: manifest.seed, imageCount: selected.length },
        env: { platform: env.platform, node: env.nodeVersion, pythonVersion: env.pythonVersion, pillowVersion: env.pillowVersion, rapidocr: env.rapidocrOk ? 'available' : 'unavailable' },
      },
      images: abImages,
      totals: groupTotals,
      events: {
        ...events,
        conflictRate: events.messages ? events.conflictCount / events.messages : null,
        uncertainRate: events.messages ? events.uncertainCount / events.messages : null,
        misCorrectedRate: events.correctedCount ? events.misCorrectedCount / events.correctedCount : null,
        wrongContactAssociation: '未测：合成语料每张图只有单个会话，无跨会话关联可构造（真实数据需另测）',
      },
      byScenario,
    };
    writeFileSync(join(RESULTS_DIR, abFileName), JSON.stringify(abPayload, null, 1), 'utf8');
    runFiles.push(abFileName);
    abSummary = { file: abFileName, bestVariant: BEST_VARIANT, groups: groupTotals, events: abPayload.events, byScenario };
    console.log(`\n[ab] 输出 ${relative(REPO_ROOT, join(RESULTS_DIR, abFileName))}`);
    console.log('组  CER      整句     编辑/字符    样本消息');
    for (const g of groupDefs) {
      const t = groupTotals[g.id];
      console.log(`${t.id}   ${pct(t.cer).padEnd(8)} ${pct(t.sentenceAcc).padEnd(8)} ${String(t.editDistance).padStart(5)}/${String(t.gtChars).padEnd(6)} ${t.messages}`);
    }
    console.log(
      `[12.2 事件] 双引擎冲突 ${events.conflictCount}/${events.messages}（${pct(abPayload.events.conflictRate)}）` +
        `  归属不确定 ${events.uncertainCount}（${pct(abPayload.events.uncertainRate)}）` +
        `  纠错 ${events.correctedCount}（误改 ${events.misCorrectedCount}，${pct(abPayload.events.misCorrectedRate)}）` +
        `  重复行事件 ${events.duplicateEvents}`,
    );
  }
}

// ── 5. summary.json ─────────────────────────────────────────────────────
const summary = {
  generatedAt: new Date().toISOString(),
  bench: 'ocr-benchmark',
  version: 'v3.0.0',
  command: `node scripts/ocr/bench.mjs ${process.argv.slice(2).join(' ')}`.trim(),
  env: {
    platform: env.platform,
    node: env.nodeVersion,
    python: env.pythonVersion,
    pillow: env.pillowVersion,
    rapidocr: env.rapidocrOk ? 'available' : 'unavailable',
    winrt: env.winrtScriptExists ? 'available (Windows OCR zh-Hans-CN)' : 'script missing',
    os: process.platform === 'win32' ? osVersion() : 'N/A',
  },
  corpus: {
    manifest: relative(REPO_ROOT, MANIFEST_PATH),
    seed: manifest.seed,
    scenarioCount: manifest.scenarioCount,
    imageCount: selected.length,
    scenarios: [...new Set(selected.map((i) => i.scenario))],
    split: args.split,
    splitScenarios: args.split === 'all' ? splitScenarios : splitScenarios[args.split],
  },
  variants: VARIANTS.map((v) => ({ id: v.id, label: v.label })),
  runs: summaryRuns,
  files: runFiles,
  baseline: baselineSummary,
  abSixGroups: abSummary,
  v3Pipeline: {
    implementedIn: 'scripts/ocr/v3-pipeline.mjs',
    configs: V3_CONFIGS.map((c) => ({ id: c.id, label: c.label, useVote: c.useVote })),
    notices: V3_NOTES,
  },
  notes: [
    'CER = 字符级 Levenshtein / GT 字符数（消息级聚合：Σ edit / Σ GT chars），比较前去空白。',
    '行级 P/R/F1：归一化文本相似度 + IoU 辅助一对一匹配；重复行单独计数并从 TP 之外计。',
    '假消息率 = 未匹配且非重复的 OCR 行 / OCR 内容行；窗口 chrome（标题/输入框/时间戳）按 manifest.expectedContext 豁免。',
    'P50/P95 为引擎自报的 OCR 耗时（不含进程启动/模型加载），RapidOCR 模型加载时间见各 run 的 meta.modelLoadMs。',
    'baseline 组：分组用 GT bbox 近似，仅衡量「同一批原始行经过 v0.2.8 后处理」的增益，不代表真实 pipeline 的定位能力。',
    'v3 组：离线等价（winrt 2x 首读 → 归一 → 可疑消息 RapidOCR 同帧投票 → 受控纠错），无 4x 帧重读；分组同为 GT bbox 近似。',
  ],
};
writeFileSync(join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 1), 'utf8');

// ── 6. 控制台汇总表 ─────────────────────────────────────────────────────
console.log('\n=== 汇总（真实实测数字，供 docs/OCR-BENCHMARK.md 引用）===');
console.log('engine    variant       CER      行F1    整句     漏读     假消息   重复    P50/P95');
for (const r of summaryRuns) {
  const t = r.totals;
  if (r.engine === 'v3-pipeline') {
    console.log(
      `${r.engine.padEnd(9)} ${String(r.variant).padEnd(13)} ${pct(t.cer).padEnd(8)} ${'—'.padEnd(7)} ${pct(t.sentenceAcc).padEnd(8)}` +
        ` ${'—'}       ${'—'}      ${'—'}     可疑${t.garbledMessages}/${t.messages} 替换${t.scriptReplacedMessages} 纠错${t.correctedMessages}`,
    );
    continue;
  }
  if (r.engine === 'baseline-v0.2.8') {
    console.log(
      `${r.engine.padEnd(9)} ${String(r.variant).padEnd(13)} ${pct(t.cerPost).padEnd(8)} ${'—'.padEnd(7)} ${pct(t.sentenceAccPost).padEnd(8)}` +
        ` ${'—'}       ${'—'}      ${'—'}     —`,
    );
    continue;
  }
  console.log(
    `${r.engine.padEnd(9)} ${String(r.variant).padEnd(13)} ${pct(t.cer).padEnd(8)} ${num(t.lineF1, 3).padEnd(7)} ${pct(t.sentenceAcc).padEnd(8)}` +
      ` ${pct(t.missRate).padEnd(8)} ${pct(t.falseRate).padEnd(8)} ${pct(t.dupRate).padEnd(6)} ${t.p50Ms}/${t.p95Ms}ms`,
  );
}
console.log(`\n结果目录: ${relative(REPO_ROOT, RESULTS_DIR)}`);
console.log(`总耗时: ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`);

// ── 辅助 ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { engine: 'all', limit: 0, scenario: [], variants: [], pipeline: 'all', split: 'all', outDir: null, python: null, verbose: false, help: false };
  const takesValue = new Set(['--engine', '--limit', '--scenario', '--variants', '--pipeline', '--split', '--out-dir', '--python']);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    let key = raw;
    let value = '';
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      key = raw.slice(0, eq);
      value = raw.slice(eq + 1);
    } else if (takesValue.has(raw) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      // 同时支持 --out-dir=path 与 --out-dir path 两种写法
      value = argv[++i];
    }
    switch (key) {
      case '--engine':
        if (!['winrt', 'rapid', 'all'].includes(value)) {
          console.error(`[bench] --engine 只支持 winrt|rapid|all，收到: ${value}`);
          process.exit(2);
        }
        out.engine = value;
        break;
      case '--limit':
        out.limit = Math.max(0, Number(value) || 0);
        break;
      case '--scenario':
        out.scenario.push(...String(value).split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--variants':
        out.variants.push(...String(value).split(',').map((v) => v.trim()).filter(Boolean));
        break;
      case '--pipeline':
        if (!['raw', 'baseline', 'v3', 'ab', 'all'].includes(value)) {
          console.error(`[bench] --pipeline 只支持 raw|baseline|v3|ab|all，收到: ${value}`);
          process.exit(2);
        }
        out.pipeline = value;
        break;
      case '--split':
        if (!['all', 'tune', 'eval'].includes(value)) {
          console.error(`[bench] --split 只支持 all|tune|eval，收到: ${value}`);
          process.exit(2);
        }
        out.split = value;
        break;
      case '--out-dir':
        out.outDir = value;
        break;
      case '--python':
        out.python = value;
        break;
      case '--verbose':
        out.verbose = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        if (raw.startsWith('--')) {
          console.error(`[bench] 未知参数: ${raw}`);
          process.exit(2);
        }
    }
  }
  return out;
}

function printHelp() {
  console.log(`OCR Benchmark（dsh-wechat-persona v3.0.0）

用法: node scripts/ocr/bench.mjs [选项]

  --engine=winrt|rapid|all   跑哪个引擎（默认 all）
  --limit=N                  只跑前 N 张（冒烟用）
  --scenario=a,b             只跑指定场景（逗号分隔，见 manifest.scenarios）
  --variants=id1,id2,...     预处理变体（默认 orig,upscale2x,gray_contrast）
                             可用: A–H 全集 orig,crop_pane,gray,equalize_clahe,median3,
                             upscale2x,upscale3x,scale2x_nearest,scale2x_bilinear,
                             scale2x_bicubic,adaptive_threshold（任务书 4.4）
  --pipeline=raw|baseline|v3|all|ab  额外跑哪些后处理/消融组（默认 all）
                             baseline=v0.2.8 后处理；v3=v3 上线管线离线等价；
                             ab=12.3 A/B 六组消融（需 orig/upscale2x/BEST/rapid orig）
  --split=all|tune|eval      按 manifest.scenarios 顺序奇偶拆分（默认 all）
                             tune=偶数下标场景（调参用），eval=奇数下标场景（只报结果）
  --out-dir=path             结果目录（默认 test/fixtures/ocr-corpus/results）
  --python=path              python 解释器（默认环境变量 OCR_BENCH_PYTHON 或 python）
  --verbose                  打印进度
  --help                     显示本帮助

示例:
  python scripts/ocr/gen_corpus.py
  node scripts/ocr/bench.mjs --engine=all --pipeline=all
  node scripts/ocr/bench.mjs --engine=all --pipeline=all --split=tune
  node scripts/ocr/bench.mjs --engine=winrt --limit=6 --scenario=clear,dark_mode
  node scripts/ocr/bench.mjs --engine=winrt --pipeline=raw --split=tune \\
       --variants=orig,crop_pane,upscale2x,adaptive_threshold
  node scripts/ocr/bench.mjs --engine=all --pipeline=ab --split=eval`);
}

function osVersion() {
  try {
    const ret = spawnSync('cmd.exe', ['/c', 'ver'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return String(ret.stdout || '').trim() || 'Windows';
  } catch {
    return 'Windows';
  }
}

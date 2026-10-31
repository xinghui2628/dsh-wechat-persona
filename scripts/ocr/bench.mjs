#!/usr/bin/env node
/**
 * OCR Benchmark 编排（v3.0.0）
 *
 * 流程：
 *   1. 读 test/fixtures/ocr-corpus/manifest.json（合成微信聊天截图 + ground truth）
 *   2. 生成预处理变体图（2x 放大 / 灰度+对比度）到 results/derived/
 *   3. 对每个引擎 × 每个预处理变体跑全部图，算指标：
 *        CER（字符级 Levenshtein / GT 字符数）、行级 P/R/F1（归一化文本 + IoU 辅助）、
 *        整句准确率、漏读率、假消息率、重复率、P50/P95 耗时
 *   4. --pipeline=baseline 组：WinRT 原始行 → v0.2.8 baseline 后处理
 *      （scripts/ocr/baseline-v028.mjs，逐行转写自 desktop.ts）→ 指针，看后处理相对原始行的增益
 *   5. 每个 run 写 results/<timestamp>-<engine>-<variant>.json，另写 results/summary.json
 *
 * 用法：
 *   node scripts/ocr/bench.mjs --engine=all                     # 全量（winrt + rapidocr + baseline）
 *   node scripts/ocr/bench.mjs --engine=winrt --limit=10         # 冒烟
 *   node scripts/ocr/bench.mjs --engine=all --scenario=clear,dark_mode
 *   node scripts/ocr/bench.mjs --pipeline=baseline --engine=all  # 只关心 baseline 组
 *
 * 说明：
 *   - 单图 OCR 失败不中断，按失败记录进结果（ok:false + error），汇总时排除但打印。
 *   - 窗口 chrome（标题/输入框占位/时间戳）用 manifest.expectedContext 豁免，不算假消息。
 *   - RapidOCR 走批量进程（模型只加载一次），单次全量约 1 分钟内；逐图进程会慢 20 倍以上。
 *   - 分组（groupLinesByMessage）用 GT bbox 近似把 OCR 行拼回消息，仅服务于 baseline A/B；
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

const engines = await import('./engines.mjs');
const { baselinePostprocessMessage } = await import('./baseline-v028.mjs');
const {
  REPO_ROOT,
  VARIANTS,
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

const CORPUS_DIR = join(REPO_ROOT, 'test', 'fixtures', 'ocr-corpus');
const MANIFEST_PATH = join(CORPUS_DIR, 'manifest.json');
const RESULTS_DIR = args.outDir ? resolve(REPO_ROOT, args.outDir) : join(CORPUS_DIR, 'results');
const DERIVED_DIR = join(RESULTS_DIR, 'derived');

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
console.log(`环境: ${env.platform} node=${env.nodeVersion} python=${env.pythonVersion || 'N/A'} (${env.rapidocrOk ? 'rapidocr OK' : 'rapidocr 不可用'}) pillow=${env.pillowVersion || 'N/A'}`);
console.log(`引擎: ${args.engine}  预处理变体: ${VARIANTS.map((v) => v.id).join('/')}  pipeline=${args.pipeline}`);
if (!env.winrtScriptExists) console.warn('[bench] 警告: scripts/pwsh/ocr-winrt.ps1 不存在，WinRT 会全部失败');
if (!env.rapidocrOk) console.warn('[bench] 警告: RapidOCR 不可用，rapid 结果会全部失败');

mkdirSync(RESULTS_DIR, { recursive: true });

// ── 1. 预处理变体 ────────────────────────────────────────────────────────
const imagePathOf = (img, variant) => {
  if (variant === 'orig') return join(CORPUS_DIR, img.image);
  return join(DERIVED_DIR, variant, `${img.captureId}.png`);
};
const prepareTasks = [];
for (const variant of VARIANTS) {
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
const runs = new Map(); // key = `${engine}|${variant}`

/**
 * 跑一个（引擎, 变体）组合。
 * @returns {Promise<{engine:string, variant:string, records:Array, wallMs:number, modelLoadMs:number}>}
 */
async function runEngineVariant(engineId, variantId) {
  const variant = VARIANTS.find((v) => v.id === variantId);
  const startWall = Date.now();
  const records = [];
  if (engineId === 'winrt') {
    for (let i = 0; i < selected.length; i++) {
      const img = selected[i];
      const path = imagePathOf(img, variantId);
      try {
        const r = await runWinrt(path);
        records.push({ captureId: img.captureId, ok: true, elapsedMs: r.elapsedMs, wallMs: r.wallMs, lines: r.lines });
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

const totalUnits = engineIds.length * VARIANTS.length;
let doneUnits = 0;
const variantImages = selected.map((img) => ({
  img,
  origPath: imagePathOf(img, 'orig'),
  variants: Object.fromEntries(VARIANTS.map((v) => [v.id, imagePathOf(img, v.id)])),
}));

// winrt 顺序跑；rapid 批量跑；两者都按 variant 轮转，便于中途看进度
const pending = [];
for (const engineId of engineIds) for (const variant of VARIANTS) pending.push([engineId, variant.id]);
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
  const variantDef = VARIANTS.find((v) => v.id === variant);
  const scale = variantDef ? variantDef.coordScale : 1;
  const out = [];
  for (const line of runRecord.lines || []) {
    // 先换算回原图坐标，否则 upscale2x 变体的 chrome 区域判定会因为坐标翻倍而失效
    const box = { x: line.x / scale, y: line.y / scale, w: line.w / scale, h: line.h / scale };
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

/** 把同一张图上未匹配的行按 GT 消息 bbox 分组（baseline A/B 用；GT 辅助，见文件头说明）。 */
function groupLinesByMessage(contentLines, img) {
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
    // 不落在任何消息 bbox 上的行（假消息）不进 baseline 分组
  }
  return groups.map((lines) =>
    lines
      .slice()
      .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
      .map((l) => l.text)
      .join(''),
  );
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
  for (const variant of VARIANTS) {
    const run = runs.get(`${engineId}|${variant.id}`);
    if (!run) continue;
    const records = [];
    for (const rec of run.records) {
      const img = imageById.get(rec.captureId);
      if (!img) continue;
      const base = { captureId: rec.captureId, scenario: img.scenario, ok: rec.ok, elapsedMs: rec.elapsedMs };
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
    const fileName = `${timestamp}-${engineId}-${variant.id}.json`;
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
if (args.pipeline !== 'raw') {
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
    console.log('\n[3/3] baseline v0.2.8 后处理 A/B（winrt 原始行 → desktop.ts 转写后处理）');
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
    const fileName = `${timestamp}-baseline-v028-orig.json`;
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
  },
  variants: VARIANTS.map((v) => ({ id: v.id, label: v.label })),
  runs: summaryRuns,
  files: runFiles,
  baseline: baselineSummary,
  notes: [
    'CER = 字符级 Levenshtein / GT 字符数（消息级聚合：Σ edit / Σ GT chars），比较前去空白。',
    '行级 P/R/F1：归一化文本相似度 + IoU 辅助一对一匹配；重复行单独计数并从 TP 之外计。',
    '假消息率 = 未匹配且非重复的 OCR 行 / OCR 内容行；窗口 chrome（标题/输入框/时间戳）按 manifest.expectedContext 豁免。',
    'P50/P95 为引擎自报的 OCR 耗时（不含进程启动/模型加载），RapidOCR 模型加载时间见各 run 的 meta.modelLoadMs。',
    'baseline 组：分组用 GT bbox 近似，仅衡量「同一批原始行经过 v0.2.8 后处理」的增益，不代表真实 pipeline 的定位能力。',
  ],
};
writeFileSync(join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 1), 'utf8');

// ── 6. 控制台汇总表 ─────────────────────────────────────────────────────
console.log('\n=== 汇总（真实实测数字，供 docs/OCR-BENCHMARK.md 引用）===');
console.log('engine    variant       CER      行F1    整句     漏读     假消息   重复    P50/P95');
for (const r of summaryRuns) {
  const t = r.totals;
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
  const out = { engine: 'all', limit: 0, scenario: [], pipeline: 'all', outDir: null, python: null, verbose: false, help: false };
  const takesValue = new Set(['--engine', '--limit', '--scenario', '--pipeline', '--out-dir', '--python']);
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
      case '--pipeline':
        if (!['raw', 'baseline', 'all'].includes(value)) {
          console.error(`[bench] --pipeline 只支持 raw|baseline|all，收到: ${value}`);
          process.exit(2);
        }
        out.pipeline = value;
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
  --pipeline=raw|baseline|all  是否计算 baseline 组（默认 all）
  --out-dir=path             结果目录（默认 test/fixtures/ocr-corpus/results）
  --python=path              python 解释器（默认环境变量 OCR_BENCH_PYTHON 或 python）
  --verbose                  打印进度
  --help                     显示本帮助

示例:
  python scripts/ocr/gen_corpus.py
  node scripts/ocr/bench.mjs --engine=all
  node scripts/ocr/bench.mjs --engine=winrt --limit=6 --scenario=clear,dark_mode`);
}

function osVersion() {
  try {
    const ret = spawnSync('cmd.exe', ['/c', 'ver'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return String(ret.stdout || '').trim() || 'Windows';
  } catch {
    return 'Windows';
  }
}

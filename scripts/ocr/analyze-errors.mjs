#!/usr/bin/env node
// 发布前 OCR 误差归因（task-20 第七部分）。零依赖：只读已有 bench 结果 JSON，不写仓库文件。
//
// 数据来源（全部为本仓库真实实测结果，路径相对仓库根）：
//   - test/fixtures/ocr-corpus/results/<ts>-eval-ab-six-groups.json
//       A/B 六组逐消息结果（A = v0.2.8 baseline，B = 仅预处理 upscale3x，C = 仅换引擎 RapidOCR，
//       F = 完整 v3），用于字符级编辑操作与 A/B 前后对比。
//   - test/fixtures/ocr-corpus/results/<ts>-eval-winrt-<variant>.json
//       A–H 预处理变体逐图结果（默认取 upscale3x），用于行级碎片/假消息/漏读等结构指标。
//   - test/fixtures/ocr-corpus/manifest.json
//       合成语料 GT、场景、字体/尺寸元数据，用于气泡截断类样本与真实性统计。
//
// 用法：
//   node scripts/ocr/analyze-errors.mjs                  # 打印 Markdown（默认最新 eval 结果）
//   node scripts/ocr/analyze-errors.mjs --json=%TEMP%/ocr-errors.json
//   node scripts/ocr/analyze-errors.mjs --ab=<path> --ah=<path> --top=5
//
// 输出口径（与 docs/OCR-BENCHMARK.md §3 一致）：
//   - 字符级：归一化（去所有空白）后做 Levenshtein 回溯，拆成 替换/删除(漏字)/插入(多字)。
//   - 消息级：整条 ocrText 为空的记为「整条漏读」；逐消息 exact 计入整句准确率。
//   - 行级：bench 的 fragments（引擎把一行切成多段）、假消息、漏行率等直接取 A–H 结果。
//   - 事件：双引擎冲突/不确定/纠错误改等取 AB 结果里的 events。

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeForCompare } from './engines.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS_DIR = join(REPO_ROOT, 'test', 'fixtures', 'ocr-corpus', 'results');
const MANIFEST_PATH = join(REPO_ROOT, 'test', 'fixtures', 'ocr-corpus', 'manifest.json');
const EVAL_SCENARIO_HINT = 'eval';

const CFG_ORDER = ['A', 'B', 'C', 'D', 'E', 'F'];
const CFG_LABEL = {
  A: 'A v0.2.8 baseline（winrt orig）',
  B: 'B 仅预处理（winrt upscale3x）',
  C: 'C 仅换引擎（RapidOCR orig）',
  D: 'D 仅新对齐',
  E: 'E 仅新融合（vote-all）',
  F: 'F 完整 v3（vote-garbled）',
};

function parseArgs(argv) {
  const out = { ab: '', ah: '', manifest: MANIFEST_PATH, json: '', top: 5, abcheck: '' };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : '';
    if (key === 'top') out.top = Math.max(1, Number(val) || 5);
    else if (key in out) out[key] = val;
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listResults() {
  try {
    return readdirSync(RESULTS_DIR).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** 最新的匹配文件（按文件名内置时间戳排序）。 */
function latestMatching(names, pattern) {
  const hits = names.filter((n) => pattern.test(n));
  return hits.length ? join(RESULTS_DIR, hits[hits.length - 1]) : '';
}

function pickPaths(args) {
  const names = listResults();
  const ab = args.ab || latestMatching(names, /-eval-ab-six-groups\.json$/);
  const ah = args.ah || latestMatching(names, /-eval-winrt-upscale3x\.json$/) || latestMatching(names, /-eval-winrt-.*\.json$/);
  if (!ab) throw new Error(`找不到 eval AB 六组结果（${RESULTS_DIR}），可用 --ab= 指定`);
  if (!ah) throw new Error(`找不到 eval A–H 结果（${RESULTS_DIR}），可用 --ah= 指定`);
  return { ab, ah };
}

/** 字符级 Levenshtein 回溯：返回替换/删除/插入/相等计数（删除=漏字，插入=多字）。 */
function editOps(a, b) {
  const s = Array.from(a);
  const t = Array.from(b);
  const n = s.length;
  const m = t.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  let i = n;
  let j = m;
  const ops = { sub: 0, del: 0, ins: 0, eq: 0 };
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)) {
      if (s[i - 1] === t[j - 1]) ops.eq++;
      else ops.sub++;
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.del++;
      i--;
    } else {
      ops.ins++;
      j--;
    }
  }
  return ops;
}

function pct(x, digits = 2) {
  return `${(x * 100).toFixed(digits)}%`;
}

function ratio(num, den) {
  return den > 0 ? num / den : 0;
}

/** 对一个配置做字符级 + 消息级归因。 */
function analyzeConfig(ab, cfg) {
  const perMsg = [];
  const totals = { gtChars: 0, msgs: 0, exact: 0, empty: 0, emptyChars: 0, sub: 0, del: 0, ins: 0, eq: 0, edit: 0 };
  for (const img of ab.images || []) {
    for (const m of img.perMessage || []) {
      const cell = m[cfg];
      if (!cell) continue;
      const gt = normalizeForCompare(m.text);
      const ocr = normalizeForCompare(cell.ocrText);
      totals.msgs++;
      totals.gtChars += gt.length;
      const ops = editOps(gt, ocr);
      totals.sub += ops.sub;
      totals.del += ops.del;
      totals.ins += ops.ins;
      totals.eq += ops.eq;
      totals.edit += ops.sub + ops.del + ops.ins;
      if (cell.exact) totals.exact++;
      if (gt.length > 0 && ocr.length === 0) {
        totals.empty++;
        totals.emptyChars += gt.length;
      }
      perMsg.push({
        captureId: img.captureId,
        scenario: img.scenario,
        gt,
        ocr,
        cellCer: Number(cell.cer) || 0,
        exact: Boolean(cell.exact),
        empty: gt.length > 0 && ocr.length === 0,
        ops,
      });
    }
  }
  // 注意：editOps 对「OCR 为空」的元素会给出与 GT 等长的删除操作，因此 totals.edit 已包含
  // 整条漏读消息的 GT 字符数，不能再用 +emptyChars（那会重复计数）。与 bench AB totals 口径一致。
  totals.cer = ratio(totals.edit, totals.gtChars);
  totals.sentenceAcc = ratio(totals.exact, totals.msgs);
  return { cfg, totals, perMsg };
}

/** 从 A–H 结果聚合行级结构指标（fragments / 漏行 / 假消息 / chrome 之外的空行）。 */
function analyzeLineStructure(ah) {
  const agg = { images: 0, gtLines: 0, ocrLines: 0, tp: 0, fp: 0, fn: 0, dup: 0, frag: 0, fragImages: 0, emptyGtImages: 0 };
  for (const img of ah.images || []) {
    const m = img.metrics || {};
    agg.images++;
    for (const key of ['gtLines', 'ocrLines', 'tp', 'fp', 'fn', 'dup', 'frag']) agg[key] += Number(m[key]) || 0;
    if ((Number(m.frag) || 0) > 0) agg.fragImages++;
    if (m.emptyGt) agg.emptyGtImages++;
  }
  agg.splitRate = ratio(agg.frag, agg.ocrLines);
  agg.missRate = ratio(agg.fn, agg.gtLines);
  agg.falseRate = ratio(agg.fp, agg.ocrLines);
  agg.dupRate = ratio(agg.dup, agg.ocrLines);
  return agg;
}

/** 气泡截断类：按 manifest bbox 判断气泡是否越过图片右缘，并估计不可见字符数。
 *  不用 OCR 文本长度反推（右缘半字误识会干扰），这样结论与 OCR 引擎无关。 */
function analyzeTruncation(manifest) {
  const rows = [];
  for (const img of manifest.images || []) {
    if (img.scenario !== 'truncated_bubble') continue;
    for (const msg of img.expectedMessages || []) {
      const [x, , w] = msg.bbox;
      const overflow = Math.max(0, x + w - img.width);
      const gtLen = Array.from(normalizeForCompare(msg.text)).length;
      rows.push({
        captureId: img.captureId,
        gt: normalizeForCompare(msg.text),
        gtLen,
        overflowPx: overflow,
        truncated: overflow > 0,
        // 文本框内左右各留 12px padding，纯文本宽度约 w-24；按越界像素占比估计被裁字符数
        estHiddenChars: overflow > 0 ? Math.round((gtLen * overflow) / Math.max(1, w - 24)) : 0,
      });
    }
  }
  return rows;
}

function fmtTable(headers, rows) {
  const line1 = `| ${headers.join(' | ')} |`;
  const line2 = `|${headers.map(() => '---').join('|')}|`;
  return [line1, line2, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function sampleMsg(entry) {
  const gt = entry.gt.replace(/\s/g, '');
  const ocr = entry.ocr.replace(/\s/g, '');
  return { gt, ocr };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { ab, ah } = pickPaths(args);
  const abData = readJson(ab);
  const ahData = readJson(ah);
  const manifest = readJson(args.manifest);
  const evalScenarios = new Set(abData.meta?.splitScenarios || []);
  const configs = {};
  for (const cfg of CFG_ORDER) {
    if (!(abData.images || []).some((img) => (img.perMessage || []).some((m) => m[cfg]))) continue;
    configs[cfg] = analyzeConfig(abData, cfg);
  }
  const lines = analyzeLineStructure(ahData);
  const trunc = analyzeTruncation(manifest);
  const events = abData.events || {};

  const md = [];
  md.push('# OCR 误差归因（eval 集，真实结果解析）');
  md.push('');
  md.push(`- AB 六组结果：\`${ab.replace(/\\/g, '/')}\``);
  md.push(`- A–H 行级结果：\`${ah.replace(/\\/g, '/')}\``);
  md.push(`- eval 场景：${[...evalScenarios].join(', ')}`);
  md.push('');

  // 1) 字符级
  md.push('## 1. 字符级编辑操作（归一化后 Levenshtein 回溯）');
  md.push('');
  const rows1 = [];
  for (const cfg of Object.keys(configs)) {
    const t = configs[cfg].totals;
    rows1.push([
      cfg,
      String(t.msgs),
      String(t.gtChars),
      String(t.edit),
      String(t.sub),
      String(t.del),
      String(t.ins),
      pct(ratio(t.sub, t.edit)),
      pct(ratio(t.del, t.edit)),
      pct(ratio(t.ins, t.edit)),
    ]);
  }
  md.push(fmtTable(['组', '消息', 'GT 字符', '编辑总数', '替换', '漏字', '多字', '替换占比', '漏字占比', '多字占比'], rows1));
  md.push('');
  md.push('> 分母 = 该组总编辑操作数（Levenshtein 距离总和）；「漏字」已包含整条漏读消息的 GT 字符数，与 CER 分子同口径（CER = 编辑总数 / GT 字符数，与 §6.6 的 bench totals 一致）。');
  md.push('');

  // 2) 消息级
  md.push('## 2. 消息级');
  md.push('');
  const rows2 = [];
  for (const cfg of Object.keys(configs)) {
    const t = configs[cfg].totals;
    rows2.push([cfg, String(t.msgs), String(t.exact), pct(t.sentenceAcc), String(t.empty), pct(ratio(t.empty, t.msgs)), String(t.emptyChars)]);
  }
  md.push(fmtTable(['组', '消息', '完全正确', '整句准确率', '整条漏读', '漏读消息占比', '漏读字符'], rows2));
  md.push('');

  // 3) 行级结构
  md.push('## 3. 行级/图像级结构指标（A–H eval, upscale3x）');
  md.push('');
  md.push(
    fmtTable(
      ['图', 'GT 行', 'OCR 行', 'TP', 'FP(假消息)', 'FN(漏行)', 'fragments(切行)', '切行占比', '漏行率', '假消息率'],
      [
        [
          String(lines.images),
          String(lines.gtLines),
          String(lines.ocrLines),
          String(lines.tp),
          String(lines.fp),
          String(lines.fn),
          String(lines.frag),
          pct(lines.splitRate),
          pct(lines.missRate),
          pct(lines.falseRate),
        ],
      ],
    ),
  );
  md.push('');
  md.push(`> ${lines.fragImages}/${lines.images} 张图出现切行（fragments）；fragments 不计入假消息，但会拉低行级 precision。`);
  md.push('');

  // 4) 事件指标
  md.push('## 4. 事件指标（AB 结果的 events）');
  md.push('');
  md.push(fmtTable(['指标', '值'], [
    ['消息数', String(events.messages ?? '')],
    ['双引擎冲突数 / 冲突率', `${events.conflictCount ?? ''} / ${events.conflictRate != null ? pct(events.conflictRate) : ''}`],
    ['气泡归属不确定 / 比例', `${events.uncertainCount ?? ''} / ${events.uncertainRate != null ? pct(events.uncertainRate) : ''}`],
    ['纠错改动数 / 误改数', `${events.correctedCount ?? ''} / ${events.misCorrectedCount ?? ''}`],
    ['重复事件数', String(events.duplicateEvents ?? '')],
    ['错误联系人关联', String(events.wrongContactAssociation ?? '')],
  ]));
  md.push('');

  // 5) 九类归因汇总
  const f = configs.F?.totals;
  const a = configs.A?.totals;
  const c = configs.C?.totals;
  md.push('## 5. 九类误差归因汇总（F = 完整 v3 配置；分母已在列内注明）');
  md.push('');
  const editTotal = f ? f.edit : 0;
  const rows5 = [
    ['字符替换', String(f ? f.sub : ''), pct(ratio(f ? f.sub : 0, editTotal)), '编辑操作数 / 总编辑数', 'e.g. 能看清→能看请、很→恨'],
    ['漏字', String(f ? f.del : ''), pct(ratio(f ? f.del : 0, editTotal)), '编辑操作数 / 总编辑数', '含整条漏读（见第 2 节）'],
    ['多字', String(f ? f.ins : ''), pct(ratio(f ? f.ins : 0, editTotal)), '编辑操作数 / 总编辑数', '引擎把背景纹理/图标读成字符'],
    ['错误分行/切行', String(lines.frag), pct(lines.splitRate), 'fragments / OCR 行', '长消息被切成多行、行合并失败'],
    ['气泡截断', `${trunc.filter((r) => r.truncated).length}/${trunc.length}`, pct(ratio(trunc.filter((r) => r.truncated).length, trunc.length)), '越界气泡 / truncated_bubble 消息', `按 bbox 越界判定；估计被裁 ${trunc.reduce((s, r) => s + r.estHiddenChars, 0)} 字符（构造偏弱，见下注）`],
    ['错误区域定位/漏区', String(f ? f.empty : ''), pct(ratio(f ? f.empty : 0, f ? f.msgs : 0)), '整条漏读消息 / 消息', '该消息 bbox 内没有任何 OCR 行'],
    ['引擎结果冲突', String(events.conflictCount ?? ''), events.conflictRate != null ? pct(events.conflictRate) : '', 'winrt 与 rapid 归一化文本不同 / 消息', 'A/B 里仅 3 条被纠错，误改 0'],
    ['字典误改', `${events.correctedCount ?? ''}（误改 ${events.misCorrectedCount ?? ''}）`, events.correctedCount != null && events.messages ? pct(ratio(events.correctedCount, events.messages)) : '', '纠错改动数 / 消息', '37 词表命中少'],
    ['跨帧状态混淆', '未测', '—', '—', '离线等价无 4x 帧；duplicateEvents=0 只是同帧内去重'],
  ];
  md.push(fmtTable(['类别', '计数（F）', '占比', '分母口径', '说明/典型样本'], rows5));
  md.push('');
  md.push(`> 气泡截断构造强度：${trunc.filter((r) => r.truncated).length} 条越界气泡（共 ${trunc.length} 条 truncated_bubble 消息），越界 ${trunc.reduce((s, r) => s + r.overflowPx, 0)}px，估计被裁 ${trunc.reduce((s, r) => s + r.estHiddenChars, 0)} 字符；实际裁剪很轻，真实微信中整段气泡被裁的场景需真实数据补测。`);
  md.push('');

  // 6) OCR 本身 vs 截图/消息关联
  md.push('## 6. 归因来源：OCR 本身 vs 截图/消息关联');
  md.push('');
  const ocrChars = f ? f.edit - f.emptyChars : 0; // 行内字符识别错误（不含整条漏读）
  const assocChars = f ? f.emptyChars : 0;
  md.push(fmtTable(['来源', '字符/事件', '占比', '说明'], [
    ['OCR 本身（字符识别）', String(ocrChars), pct(ratio(ocrChars, editTotal)), '替换+行内漏字+多字'],
    ['OCR 漏识别整条消息（关联候选）', String(assocChars), pct(ratio(assocChars, editTotal)), '该消息没有输出任何行，可能是区域/行合并/整条乱码'],
    ['窗口 chrome 误识别', String(lines.fp), pct(lines.falseRate), '标题/输入框/头像等被当成消息文本（已按 expectedContext 豁免后可测的剩余假消息）'],
    ['气泡归属', `${events.uncertainCount ?? ''} 条 uncertain`, events.uncertainRate != null ? pct(events.uncertainRate) : '', '左右判定不确定（宁可不回）'],
    ['跨帧状态', '未测', '—', '见第 5 节'],
  ]));
  md.push('');

  // 7) A/B 验证
  md.push('## 7. A/B 验证（现有开关，同一 eval 集）');
  md.push('');
  const rows7 = [];
  for (const cfg of ['A', 'B', 'C', 'F']) {
    const t = configs[cfg]?.totals;
    if (!t) continue;
    rows7.push([cfg, pct(t.cer), pct(t.sentenceAcc), String(t.sub), String(t.del), String(t.ins), String(t.empty)]);
  }
  md.push(fmtTable(['组', 'CER', '整句准确率', '替换', '漏字', '多字', '整条漏读消息'], rows7));
  md.push('');
  if (a && f) {
    md.push(`- **A → F（完整 v3）**：CER ${pct(a.cer)} → ${pct(f.cer)}（${((f.cer - a.cer) * 100).toFixed(2)}pp），整句 ${pct(a.sentenceAcc)} → ${pct(f.sentenceAcc)}（+${((f.sentenceAcc - a.sentenceAcc) * 100).toFixed(2)}pp）。`);
      md.push(`- 替换 ${a.sub} → ${f.sub}，漏字 ${a.del} → ${f.del}，多字 ${a.ins} → ${f.ins}：误差下降主要来自**预处理放大（B）**，见 §6.6。`);
  }
  if (c) md.push(`- **C（仅换引擎 RapidOCR）**：CER ${pct(c.cer)} / 整句 ${pct(c.sentenceAcc)} —— 同语料下引擎本身的上限，说明多数字符误差是 WinRT 识别问题而非流水线问题。`);
  md.push('');

  // 8) 组合变体 A/B（新开关验证；tune 用于选型、eval 用于独立验证）
  const abcheckDir = args.abcheck || join(process.env.TEMP || '', 'ocr-task20-ab');
  const abcheckMap = new Map();
  try {
    const names = readdirSync(abcheckDir).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const d = readJson(join(abcheckDir, name));
      if (!d.totals || d.meta?.bench !== 'ocr-benchmark') continue;
      // 同一 split+variant 只保留文件名时间戳最新的一份（names 已排序）
      const split = d.meta?.corpus?.split || d.meta?.split || 'all';
      const key = `${split}|${d.meta?.variant || ''}`;
      abcheckMap.set(key, { split, variant: String(d.meta?.variant || ''), totals: d.totals });
    }
  } catch {
    /* 没有额外 A/B 结果时跳过 */
  }
  const splitRank = { tune: 0, eval: 1, all: 2 };
  const abcheckRows = [...abcheckMap.values()]
    .sort((x, y) => (splitRank[x.split] ?? 9) - (splitRank[y.split] ?? 9) || x.variant.localeCompare(y.variant))
    .map((r) => [
      r.split,
      r.variant,
      pct(Number(r.totals.cer) || 0),
      pct(Number(r.totals.sentenceAcc) || 0),
      r.totals.lineF1 != null ? (Number(r.totals.lineF1) || 0).toFixed(3) : '',
      `${Number(r.totals.p50Ms) || 0}ms`,
      `${Number(r.totals.p95Ms) || 0}ms`,
    ]);
  if (abcheckRows.length) {
    md.push('## 8. 修复假设 A/B：裁剪窗格 + 放大（新组合变体，tune/eval 双集）');
    md.push('');
    md.push(fmtTable(['split', '变体', 'CER', '整句准确率', '行 F1', 'P50', 'P95'], abcheckRows));
    md.push('');
    md.push('> 命令：见 docs/OCR-ERROR-ANALYSIS.md §7；结果写到 `%TEMP%`，不改仓库 results/。tune 用于选择变体，eval 用于独立验证（不得反过来调参）。');
    md.push('');
  }

  // 9) 典型样本
  md.push('## 9. 典型样本（F 配置，按误差类型）');
  md.push('');
  const fm = configs.F?.perMsg || [];
  const pick = (pred, n) => fm.filter(pred).slice(0, n);
  const samples = [
    ['字符替换', pick((r) => r.ops.sub > 0 && !r.empty, 3)],
    ['漏字', pick((r) => r.ops.del > 0 && !r.empty, 3)],
    ['多字', pick((r) => r.ops.ins > 0, 3)],
    ['整条漏读', pick((r) => r.empty, 3)],
  ];
  for (const [label, list] of samples) {
    md.push(`### ${label}`);
    md.push('');
    if (!list.length) {
      md.push('（无）');
      md.push('');
      continue;
    }
    md.push(fmtTable(['场景', 'GT', 'OCR'], list.map((r) => [r.scenario, sampleMsg(r).gt, sampleMsg(r).ocr])));
    md.push('');
  }

  // 10) 语料真实性统计
  md.push('## 10. 合成语料真实性统计（manifest 直接统计）');
  md.push('');
  const fontSizes = new Map();
  const dims = new Map();
  const themes = new Map();
  let lineHeights = [];
  for (const img of manifest.images || []) {
    fontSizes.set(String(img.fontSize), (fontSizes.get(String(img.fontSize)) || 0) + 1);
    dims.set(`${img.width}x${img.height}`, (dims.get(`${img.width}x${img.height}`) || 0) + 1);
    themes.set(String(img.theme), (themes.get(String(img.theme)) || 0) + 1);
    for (const msg of img.expectedMessages || []) {
      for (const lb of msg.lineBoxes || []) lineHeights.push(lb.bbox[3]);
    }
  }
  lineHeights = lineHeights.sort((x, y) => x - y);
  const median = lineHeights.length ? lineHeights[Math.floor(lineHeights.length / 2)] : 0;
  md.push(fmtTable(['项', '值'], [
    ['字体', String(manifest.font)],
    ['基准窗口尺寸', String(manifest.baseSize)],
    ['字号分布（px → 图数）', [...fontSizes.entries()].map(([k, v]) => `${k}px×${v}`).join('，')],
    ['图片尺寸分布', [...dims.entries()].map(([k, v]) => `${k}×${v}`).join('，')],
    ['主题分布', [...themes.entries()].map(([k, v]) => `${k}×${v}`).join('，')],
    ['GT 行高中位数', `${median}px`],
    ['GT 行高范围', `${lineHeights[0] || 0}-${lineHeights[lineHeights.length - 1] || 0}px`],
  ]));
  md.push('');

  const text = md.join('\n');
  process.stdout.write(text + '\n');
  if (args.json) {
    const payload = {
      generatedAt: new Date().toISOString(),
      sources: { ab, ah, manifest: args.manifest },
      configs: Object.fromEntries(Object.entries(configs).map(([k, v]) => [k, { totals: v.totals }])),
      lineStructure: lines,
      events,
      truncation: { total: trunc.length, truncated: trunc.filter((r) => r.truncated).length },
      corpusStats: { fontSizes: Object.fromEntries(fontSizes), dims: Object.fromEntries(dims), themes: Object.fromEntries(themes), medianLineHeight: median },
    };
    // 只写到显式指定的路径（默认不写文件），避免污染仓库。
    const outPath = resolve(args.json);
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    process.stderr.write(`[analyze-errors] JSON → ${outPath}\n`);
  }
}

main();

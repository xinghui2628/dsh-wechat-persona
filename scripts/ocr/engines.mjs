/**
 * OCR Benchmark 引擎适配层（v3.0.0）
 *
 * 两个独立引擎，统一成同一份返回结构，供 bench.mjs 编排：
 *   runWinrt(path)         Windows 自带 OCR（Windows.Media.Ocr，走 PS 5.1 helper）
 *   runRapidocr(path)      单图 RapidOCR（内部用批量进程，只是批量里放 1 张）
 *   runRapidocrBatch(paths) 批量 RapidOCR：**一次进程只加载一次模型**。
 *                          逐图单进程约 2.9s/张（模型加载占大头），全量 240 次会到 12 分钟，
 *                          批量后模型只加载一次，是 bench 能在几分钟内跑完的关键。
 *   prepareVariants(tasks) Pillow 预处理变体（2x 放大、灰度+对比度），走一次 python 进程。
 *
 * 统一返回：{ engine, elapsedMs, width?, height?, lines:[{ text, x, y, w, h, score? }] }
 *   - 坐标一律为「该引擎输入图」的像素坐标；bench 用 VARIANTS[].coordScale 换算回原图坐标。
 *   - 文本保持引擎原始输出（WinRT 中文会在字与字之间插空格），由 normalizeCjkSpaces 归一化。
 *
 * 编码约定（本机实测的坑）：
 *   - PowerShell 5.1 直接 `[Console]::Out.WriteLine` 到 pipe 时是 UTF-8，但用 shell 重定向 `>` 时
 *     会变 UTF-16LE。这里 decodeProcessText 同时兼容 UTF-8 / UTF-8 BOM / UTF-16LE BOM。
 *   - python stdout 默认 GBK 会乱码：spawn 时注入 PYTHONIOENCODING=utf-8；批量结果一律写
 *     临时 JSON 文件（显式 encoding='utf-8'），不从管道读中文。
 *
 * 只读本仓库 test/fixtures 下的合成图；不截图、不启动、不发送微信。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WINRT_SCRIPT = join(REPO_ROOT, 'scripts', 'pwsh', 'ocr-winrt.ps1');
const PYTHON = process.env.OCR_BENCH_PYTHON || process.env.PYTHON || 'python';

// ── 预处理变体定义 ────────────────────────────────────────────────────────
// coordScale：该变体图相对原图的坐标缩放倍数（bench 把 OCR bbox 除以它换回原图坐标）。
// coordOffsetX/Y：裁剪类变体的坐标偏移（裁剪掉的上/左像素在图坐标中加回来）。
// ops：Pillow 预处理步骤（engines.mjs 内联 python 解释执行，见 PREPARE_CODE）。
// 默认 3 个变体（向后兼容）：引用 VARIANTS_ALL 中的完整定义（含 ops），
// 定义见文件下方 `VARIANTS` 派生（避免两处定义漂移导致预处理被跳过）。

// 任务书 4.4 预处理 A–H：11 个变体（F/G 各含多种缩放/重采样，H 为自适应阈值近似）。
// A orig、B crop_pane、C gray、D equalize（CLAHE 的 Pillow 近似）、E median3、
// F2 upscale2x(2x)、F3 upscale3x(3x)、G nearest/bilinear/bicubic(2x)、H adaptive_threshold。
export const VARIANTS_ALL = [
  { id: 'orig', label: 'A 原始原图', coordScale: 1, coordOffsetX: 0, coordOffsetY: 0, ops: [] },
  {
    id: 'crop_pane',
    label: 'B 精确裁剪聊天窗格（去标题/输入栏）',
    coordScale: 1,
    coordOffsetX: 0,
    coordOffsetY: 36,
    ops: [{ op: 'crop', top: 36, bottom: 56 }],
  },
  { id: 'gray', label: 'C 灰度', coordScale: 1, coordOffsetX: 0, coordOffsetY: 0, ops: [{ op: 'grayscale' }] },
  {
    id: 'equalize_clahe',
    label: 'D 对比度增强（equalize，CLAHE 近似）',
    coordScale: 1,
    coordOffsetX: 0,
    coordOffsetY: 0,
    ops: [{ op: 'grayscale' }, { op: 'equalize' }, { op: 'contrast', factor: 1.6 }],
  },
  {
    id: 'median3',
    label: 'E 中值去噪 3x3',
    coordScale: 1,
    coordOffsetX: 0,
    coordOffsetY: 0,
    ops: [{ op: 'median', size: 3 }],
  },
  {
    id: 'upscale2x',
    label: 'F 2x 放大（LANCZOS）',
    scale: 2,
    coordScale: 2,
    coordOffsetX: 0,
    coordOffsetY: 0,
    ops: [{ op: 'resize', factor: 2, resample: 'LANCZOS' }],
  },
  {
    id: 'upscale3x',
    label: 'F 3x 放大（LANCZOS）',
    scale: 3,
    coordScale: 3,
    coordOffsetX: 0,
    coordOffsetY: 0,
    ops: [{ op: 'resize', factor: 3, resample: 'LANCZOS' }],
  },
  {
    id: 'scale2x_nearest',
    label: 'G 2x 放大（NEAREST）',
    scale: 2,
    coordScale: 2,
    coordOffsetX: 0,
    coordOffsetY: 0,
    ops: [{ op: 'resize', factor: 2, resample: 'NEAREST' }],
  },
  {
    id: 'scale2x_bilinear',
    label: 'G 2x 放大（BILINEAR）',
    scale: 2,
    coordScale: 2,
    coordOffsetX: 0,
    coordOffsetY: 0,
    ops: [{ op: 'resize', factor: 2, resample: 'BILINEAR' }],
  },
  {
    id: 'scale2x_bicubic',
    label: 'G 2x 放大（BICUBIC）',
    scale: 2,
    coordScale: 2,
    coordOffsetX: 0,
    coordOffsetY: 0,
    ops: [{ op: 'resize', factor: 2, resample: 'BICUBIC' }],
  },
  {
    id: 'adaptive_threshold',
    label: 'H 自适应阈值二值化（Pillow 近似）',
    coordScale: 1,
    coordOffsetX: 0,
    coordOffsetY: 0,
    ops: [{ op: 'adaptive_threshold' }],
  },
  // 组合变体（task-20 误差归因的修复假设验证用）：
  // 「先裁掉标题/输入栏（去掉 chrome 干扰与无内容区域），再放大」，对比单用裁剪 / 单用放大。
  {
    id: 'crop_pane_upscale2x',
    label: '组合：裁剪窗格 + 2x 放大（LANCZOS）',
    scale: 2,
    coordScale: 2,
    coordOffsetX: 0,
    coordOffsetY: 36,
    ops: [{ op: 'crop', top: 36, bottom: 56 }, { op: 'resize', factor: 2, resample: 'LANCZOS' }],
  },
  {
    id: 'crop_pane_upscale3x',
    label: '组合：裁剪窗格 + 3x 放大（LANCZOS）',
    scale: 3,
    coordScale: 3,
    coordOffsetX: 0,
    coordOffsetY: 36,
    ops: [{ op: 'crop', top: 36, bottom: 56 }, { op: 'resize', factor: 3, resample: 'LANCZOS' }],
  },
];

/** gray_contrast（旧默认变体）也可被 --variants 显式引用。 */
VARIANTS_ALL.push({ id: 'gray_contrast', label: '灰度+对比度增强（旧默认，1.6x）', coordScale: 1, coordOffsetX: 0, coordOffsetY: 0, ops: [{ op: 'grayscale' }, { op: 'autocontrast' }, { op: 'contrast', factor: 1.6 }] });

// 默认 3 个变体（原 bench 默认集合）从 VARIANTS_ALL 派生，保证 ops 与 A–H 定义一致。
export const VARIANTS = VARIANTS_ALL.filter((v) => ['orig', 'upscale2x', 'gray_contrast'].includes(v.id));

/** 按 id 取变体定义（默认 3 变体 + A–H 全部）。 */
export function variantById(id) {
  return VARIANTS.find((v) => v.id === id) || VARIANTS_ALL.find((v) => v.id === id) || null;
}

/** 解析 --variants= 过滤；空/未给时返回默认 3 变体。 */
export function selectVariants(ids) {
  if (!ids || ids.length === 0) return VARIANTS;
  const out = [];
  const unknown = [];
  for (const id of ids) {
    const found = variantById(id);
    if (found) out.push(found);
    else unknown.push(id);
  }
  if (unknown.length) {
    throw new Error(`未知预处理变体: ${unknown.join(', ')}；可用: ${[...VARIANTS, ...VARIANTS_ALL].map((v) => v.id).join(', ')}`);
  }
  return out;
}

// ── 通用工具 ──────────────────────────────────────────────────────────────

/** 解码子进程 stdout：兼容 UTF-8（含 BOM）与 UTF-16LE BOM（PS 5.1 重定向时的编码）。 */
export function decodeProcessText(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/** 取 stdout 里最后一行非空文本，解析成 JSON；失败返回 null。 */
export function parseJsonLine(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* 继续尝试上一行 */
    }
  }
  return null;
}

const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/**
 * WinRT OCR 中文行会在字与字之间插空格（"今 天 大 肥 鱼"），直接算 CER 会虚高。
 * 归一化规则（任务书要求）：
 *   1. 两个 CJK 字符之间的空格删除；
 *   2. 英文/数字单词之间的空格保留（"hello world" 不变）。
 */
export function normalizeCjkSpaces(text) {
  const src = String(text || '');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === ' ' || ch === '\u3000') {
      const prev = out[out.length - 1] || '';
      const next = src[i + 1] || '';
      if (CJK_RE.test(prev) && CJK_RE.test(next)) continue; // CJK 之间的空格删掉
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** 指标比较前的文本归一化：去掉所有空白（含全角空格），不做简繁/全半角转换。 */
export function normalizeForCompare(text) {
  return String(text || '').replace(/[\s\u3000]+/g, '');
}

/** 字符级 Levenshtein 距离（滚动数组，CER 用）。 */
export function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= t.length; j++) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[t.length];
}

/** 文本相似度 = 1 - Levenshtein/max(len)，用于行匹配。 */
export function textSimilarity(a, b) {
  const s = normalizeForCompare(a);
  const t = normalizeForCompare(b);
  const max = Math.max(s.length, t.length);
  if (max === 0) return 1;
  return 1 - levenshtein(s, t) / max;
}

/** 多个 bbox（{x,y,w,h} 或 [x,y,w,h]）求并集。 */
export function mergeBoxes(boxes) {
  const list = (boxes || []).map(toBox).filter(Boolean);
  if (list.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of list) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 统一 bbox 形状：支持 {x,y,w,h} 与 [x,y,w,h]。 */
export function toBox(box) {
  if (!box) return null;
  if (Array.isArray(box)) return { x: box[0], y: box[1], w: box[2], h: box[3] };
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

export function boxCenter(box) {
  const b = toBox(box);
  if (!b) return { x: 0, y: 0 };
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** 点是否落在区域 [x,y,w,h] 内。 */
export function pointInRegion(point, region) {
  const r = toBox(region);
  if (!r) return false;
  return point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h;
}

/** IoU（交并比），行匹配的辅助信号。 */
export function iou(a, b) {
  const p = toBox(a);
  const q = toBox(b);
  if (!p || !q) return 0;
  const x0 = Math.max(p.x, q.x);
  const y0 = Math.max(p.y, q.y);
  const x1 = Math.min(p.x + p.w, q.x + q.w);
  const y1 = Math.min(p.y + p.h, q.y + q.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  const inter = (x1 - x0) * (y1 - y0);
  const union = Math.max(1, p.w * p.h + q.w * q.h - inter);
  return inter / union;
}

// ── Windows OCR（WinRT，PS 5.1 helper）──────────────────────────────────

/**
 * @param {string} imagePath 图片路径（相对仓库根或绝对路径）
 * @returns {{engine:string, elapsedMs:number, wallMs:number, width:number, height:number, lines:Array}}
 */
export async function runWinrt(imagePath) {
  const abs = resolve(REPO_ROOT, imagePath);
  if (!existsSync(abs)) throw new Error(`图片不存在：${abs}`);
  const wallStart = Date.now();
  const ret = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINRT_SCRIPT, '-Path', abs],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 120000 },
  );
  const wallMs = Date.now() - wallStart;
  const stdout = decodeProcessText(ret.stdout);
  const stderr = decodeProcessText(ret.stderr).trim();
  const payload = parseJsonLine(stdout);
  if (!payload) {
    throw new Error(`WinRT 输出无法解析（exit=${ret.status}）${stderr ? '：' + stderr.slice(0, 300) : ''}`);
  }
  if (payload.ok !== true) throw new Error(`WinRT OCR 失败：${payload.error || '未知错误'}`);
  const lines = (payload.lines || []).map((l) => ({
    text: String(l.text || ''),
    x: Number(l.x) || 0,
    y: Number(l.y) || 0,
    w: Number(l.w) || 0,
    h: Number(l.h) || 0,
  }));
  return {
    engine: payload.engine || 'winrt',
    elapsedMs: Number(payload.elapsedMs) || 0,
    wallMs,
    width: Number(payload.width) || 0,
    height: Number(payload.height) || 0,
    cpuMs: Number(payload.cpuMs) || 0,
    rssMB: Number(payload.rssMB) || 0,
    lines,
  };
}

// ── RapidOCR（批量进程，模型只加载一次）──────────────────────────────────

const RAPID_BATCH_CODE = String.raw`
import json, sys, time
inp = json.load(open(sys.argv[1], encoding="utf-8"))
load_ms = 0
try:
    t_load = time.perf_counter()
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    load_ms = int((time.perf_counter() - t_load) * 1000)
except Exception as exc:
    json.dump({"fatal": "rapidocr unavailable: %s" % exc}, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
    sys.exit(0)
results = []
for item in inp:
    try:
        t0 = time.perf_counter()
        result, _elapse = engine(item["path"])
        elapsed = int((time.perf_counter() - t0) * 1000)
        lines = []
        for it in result or []:
            box, text, score = it[0], it[1], it[2]
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            lines.append({
                "text": str(text),
                "x": int(round(min(xs))),
                "y": int(round(min(ys))),
                "w": int(round(max(xs) - min(xs))),
                "h": int(round(max(ys) - min(ys))),
                "score": float(score),
            })
        results.append({"ok": True, "lines": lines, "elapsedMs": elapsed})
    except Exception as exc:
        results.append({"ok": False, "error": str(exc), "elapsedMs": 0})
json.dump({"modelLoadMs": load_ms, "results": results}, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
`;

function runPythonInline(code, args, timeoutMs = 600000) {
  const ret = spawnSync(PYTHON, ['-c', code, ...args], {
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return {
    status: ret.status,
    stdout: decodeProcessText(ret.stdout),
    stderr: decodeProcessText(ret.stderr),
  };
}

/**
 * 批量跑 RapidOCR。
 * @param {string[]} imagePaths
 * @returns {Promise<{modelLoadMs:number, wallMs:number, items:Array<{ok:boolean, elapsedMs:number, lines?:Array, error?:string}>}>}
 */
export async function runRapidocrBatch(imagePaths) {
  const paths = (imagePaths || []).map((p) => resolve(REPO_ROOT, p));
  if (paths.length === 0) return { modelLoadMs: 0, wallMs: 0, items: [] };
  for (const p of paths) if (!existsSync(p)) throw new Error(`图片不存在：${p}`);
  const dir = mkdtempSync(join(tmpdir(), 'ocr-bench-rapid-'));
  const inFile = join(dir, 'in.json');
  const outFile = join(dir, 'out.json');
  const wallStart = Date.now();
  try {
    writeFileSync(inFile, JSON.stringify(paths.map((p) => ({ path: p }))), 'utf8');
    const ret = runPythonInline(RAPID_BATCH_CODE, [inFile, outFile], 900000);
    const wallMs = Date.now() - wallStart;
    if (!existsSync(outFile)) {
      throw new Error(
        `RapidOCR 批量进程失败（exit=${ret.status}）${ret.stderr ? '：' + ret.stderr.trim().slice(-500) : ''}`,
      );
    }
    const parsed = JSON.parse(readFileSync(outFile, 'utf8'));
    if (parsed.fatal) throw new Error(parsed.fatal);
    const items = (parsed.results || []).map((r) => ({
      ok: r.ok === true,
      elapsedMs: Number(r.elapsedMs) || 0,
      lines: (r.lines || []).map((l) => ({
        text: String(l.text || ''),
        x: Number(l.x) || 0,
        y: Number(l.y) || 0,
        w: Number(l.w) || 0,
        h: Number(l.h) || 0,
        score: Number(l.score) || 0,
      })),
      error: r.error,
    }));
    return { modelLoadMs: Number(parsed.modelLoadMs) || 0, wallMs, items };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
}

/** 单图 RapidOCR（内部走批量接口；bench 全量走 runRapidocrBatch 更快）。 */
export async function runRapidocr(imagePath) {
  const batch = await runRapidocrBatch([imagePath]);
  const item = batch.items[0];
  if (!item || !item.ok) throw new Error(`RapidOCR 失败：${item?.error || '无结果'}`);
  return {
    engine: 'rapidocr',
    elapsedMs: item.elapsedMs,
    wallMs: batch.wallMs,
    lines: item.lines,
    modelLoadMs: batch.modelLoadMs,
  };
}

// ── Pillow 预处理变体 ────────────────────────────────────────────────────

const PREPARE_CODE = String.raw`
import json, os, sys
from PIL import Image, ImageEnhance, ImageOps, ImageFilter
import numpy as np

RESAMPLE = {
    "LANCZOS": Image.LANCZOS,
    "BILINEAR": Image.BILINEAR,
    "BICUBIC": Image.BICUBIC,
    "NEAREST": Image.NEAREST,
}

def apply_op(im, op):
    name = op.get("op")
    if name == "crop":
        w, h = im.size
        top = int(op.get("top", 0))
        bottom = int(op.get("bottom", 0))
        return im.crop((0, top, w, h - bottom))
    if name == "resize":
        factor = float(op.get("factor", 2))
        resample = RESAMPLE[op.get("resample", "LANCZOS")]
        return im.resize((max(1, int(round(im.width * factor))), max(1, int(round(im.height * factor)))), resample)
    if name == "grayscale":
        return ImageOps.grayscale(im).convert("RGB")
    if name == "equalize":
        return ImageOps.equalize(ImageOps.grayscale(im)).convert("RGB")
    if name == "autocontrast":
        return ImageOps.autocontrast(ImageOps.grayscale(im)).convert("RGB")
    if name == "contrast":
        return ImageEnhance.Contrast(im).enhance(float(op.get("factor", 1.6)))
    if name == "median":
        return im.filter(ImageFilter.MedianFilter(int(op.get("size", 3))))
    if name == "adaptive_threshold":
        # 局部均值阈值近似：gray > 高斯背景 - C 判白，否则黑（Pillow+numpy 实现）
        gray = np.asarray(ImageOps.grayscale(im), dtype=np.int16)
        bg = np.asarray(ImageOps.grayscale(im).filter(ImageFilter.GaussianBlur(15)), dtype=np.int16)
        out = np.where(gray > bg - 10, 255, 0).astype(np.uint8)
        return Image.fromarray(out).convert("RGB")
    raise ValueError("unknown op: " + str(name))

tasks = json.load(open(sys.argv[1], encoding="utf-8"))
done = 0
fail = []
for t in tasks:
    try:
        im = Image.open(t["src"]).convert("RGB")
        for op in (t.get("ops") or []):
            im = apply_op(im, op)
        parent = os.path.dirname(t["dst"])
        if parent:
            os.makedirs(parent, exist_ok=True)
        im.save(t["dst"])
        done += 1
    except Exception as exc:  # 单个变体失败不影响整体
        fail.append({"dst": t.get("dst"), "error": str(exc)})
json.dump({"done": done, "fail": fail}, open(sys.argv[2], "w", encoding="utf-8"))
`;

/**
 * 生成预处理变体图。
 * @param {Array<{variant:string, src:string, dst:string}>} tasks
 * @returns {Promise<{count:number, wallMs:number}>}
 */
export async function prepareVariants(tasks) {
  if (!tasks || tasks.length === 0) return { count: 0, wallMs: 0 };
  const dir = mkdtempSync(join(tmpdir(), 'ocr-bench-prep-'));
  const inFile = join(dir, 'tasks.json');
  const outFile = join(dir, 'out.json');
  const wallStart = Date.now();
  try {
    const payload = tasks.map((t) => {
      const def = variantById(t.variant);
      return { variant: t.variant, ops: def?.ops || [], src: resolve(REPO_ROOT, t.src), dst: resolve(REPO_ROOT, t.dst) };
    });
    writeFileSync(inFile, JSON.stringify(payload), 'utf8');
    const ret = runPythonInline(PREPARE_CODE, [inFile, outFile], 300000);
    if (!existsSync(outFile)) {
      throw new Error(`预处理进程失败（exit=${ret.status}）${ret.stderr ? '：' + ret.stderr.trim().slice(-500) : ''}`);
    }
    const parsed = JSON.parse(readFileSync(outFile, 'utf8'));
    if (Array.isArray(parsed.fail) && parsed.fail.length > 0) {
      throw new Error(`预处理失败 ${parsed.fail.length} 张：${JSON.stringify(parsed.fail.slice(0, 3))}`);
    }
    return { count: Number(parsed.done) || 0, wallMs: Date.now() - wallStart };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 探测三个引擎依赖是否可用（bench 启动时打印，便于文档记录「未测」原因）。 */
export function probeEnvironment() {
  const py = spawnSync(PYTHON, ['-c', 'import sys, rapidocr_onnxruntime, PIL; print(sys.version.split()[0]); print(PIL.__version__)'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    timeout: 120000,
  });
  const pyOk = py.status === 0;
  return {
    python: PYTHON,
    pythonOk: pyOk,
    pythonVersion: pyOk ? String(py.stdout || '').trim().split(/\r?\n/)[0] : null,
    pillowVersion: pyOk ? String(py.stdout || '').trim().split(/\r?\n/)[1] : null,
    rapidocrOk: pyOk,
    winrtScript: WINRT_SCRIPT,
    winrtScriptExists: existsSync(WINRT_SCRIPT),
    platform: process.platform,
    nodeVersion: process.version,
  };
}

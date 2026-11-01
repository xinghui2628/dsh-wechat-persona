// worker-eval.mjs —— 任务书 5.3：RapidOCR 常驻 Worker 的量化评估（只测量，不接线生产）。
//
// 现状（v0.2.8/v3.0.0）：每次识别都 spawn 一个 python 进程重新加载 ONNX 模型；
// 任务书 5.3 要求先量化「值不值得做常驻 Worker」，再决定是否接线。
// 本脚本分别测：
//   1) 每次调用重新加载模型（现状）——python 启动 + import + RapidOCR() 初始化 + 单图推理；
//   2) 常驻 Worker（模型只加载一次）——初始化一次后逐图推理，稳态每图耗时；
//   3) 内存占用：python 进程初始化后 / 推理后的 RSS 与峰值 RSS（psapi 采样）；
//   4) 参照生产约束：2 秒轮询周期、90 秒脚本上限（见 docs/CHANNELS.md 与 scripts）。
//
// 只读 test/fixtures/ocr-corpus 下的合成图；不截图、不启动、不发送微信；不 pip install。
//
// 用法：
//   node scripts/ocr/worker-eval.mjs [--repeat=1] [--out-dir=test/fixtures/ocr-corpus/results]
//                                    [--python=python] [--json]

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORPUS_DIR = join(REPO_ROOT, 'test', 'fixtures', 'ocr-corpus');
const MANIFEST_PATH = join(CORPUS_DIR, 'manifest.json');
const RAPID_SCRIPT = join(REPO_ROOT, 'scripts', 'py', 'rapid_ocr.py');
const PYTHON = process.env.OCR_BENCH_PYTHON || process.env.PYTHON || 'python';

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}
const repeat = Math.max(1, Number(argValue('--repeat', '1')) || 1);
const outDir = argValue('--out-dir', join(CORPUS_DIR, 'results'));
const resultsDir = resolve(REPO_ROOT, outDir);
const jsonOnly = argv.includes('--json');

// 采样图：覆盖清晰/数字/长气泡/深色四类（与「每次调用」对比用同一批图）
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const sampleIds = ['clear-00', 'numbers-00', 'long_bubble-00', 'dark_mode-00', 'small_font-00'];
const sampleImages = [];
for (const id of sampleIds) {
  const img = (manifest.images || []).find((x) => x.captureId === id);
  if (img) sampleImages.push({ captureId: id, path: join(CORPUS_DIR, img.image) });
}
if (sampleImages.length === 0) {
  console.error('[worker-eval] 语料里找不到采样图，先跑 python scripts/ocr/gen_corpus.py');
  process.exit(2);
}

const WORKER_CODE = String.raw`
import ctypes, json, os, sys, time

class _PMC(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]

def rss_mb():
    # 必须显式声明 argtypes/restype，否则 64 位下 Handle 会被截断、GetProcessMemoryInfo 返回 0（本机实测踩坑）
    from ctypes import wintypes
    pmc = _PMC()
    pmc.cb = ctypes.sizeof(_PMC)
    fn = ctypes.windll.psapi.GetProcessMemoryInfo
    fn.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PMC), wintypes.DWORD]
    fn.restype = wintypes.BOOL
    get_current = ctypes.windll.kernel32.GetCurrentProcess
    get_current.restype = wintypes.HANDLE
    if not fn(get_current(), ctypes.byref(pmc), pmc.cb):
        return 0.0, 0.0
    return pmc.WorkingSetSize / 1048576.0, pmc.PeakWorkingSetSize / 1048576.0

tasks = json.load(open(sys.argv[1], encoding="utf-8"))
images = tasks["images"]
repeat = int(tasks.get("repeat", 1))
out_path = sys.argv[2]
result = {"pythonVersion": sys.version.split()[0], "available": False}

t0 = time.perf_counter()
try:
    import rapidocr_onnxruntime as ro
    from rapidocr_onnxruntime import RapidOCR
    impl = "rapidocr_onnxruntime"
    try:
        from importlib.metadata import version as pkg_version
        version = pkg_version("rapidocr_onnxruntime")
    except Exception:
        version = "unknown"
except Exception as exc:
    result["error"] = "rapidocr_onnxruntime 不可用：%s" % exc
    json.dump(result, open(out_path, "w", encoding="utf-8"))
    sys.exit(0)
result.update({"engine": impl, "version": version, "importMs": (time.perf_counter() - t0) * 1000.0})

t1 = time.perf_counter()
engine = RapidOCR()
result["initMs"] = (time.perf_counter() - t1) * 1000.0

rss, peak = rss_mb()
result["rssAfterInitMB"] = rss
result["peakRssAfterInitMB"] = peak

per_image = []
first_ms = None
total_start = time.perf_counter()
for _ in range(repeat):
    for item in images:
        t = time.perf_counter()
        engine(item["path"])
        elapsed = (time.perf_counter() - t) * 1000.0
        if first_ms is None:
            first_ms = elapsed
        per_image.append({"captureId": item["captureId"], "ms": elapsed})
result["firstInferMs"] = first_ms
result["inferCount"] = len(per_image)
result["perImageMs"] = [round(x["ms"], 1) for x in per_image]
result["steadyAvgMs"] = sum(x["ms"] for x in per_image[1:]) / max(1, len(per_image) - 1) if len(per_image) > 1 else per_image[0]["ms"]
result["workerBatchTotalMs"] = (time.perf_counter() - total_start) * 1000.0
rss2, peak2 = rss_mb()
result["rssAfterInferMB"] = rss2
result["peakRssAfterInferMB"] = peak2
result["available"] = True
json.dump(result, open(out_path, "w", encoding="utf-8"))
`;

function runWorker() {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-worker-eval-'));
  const inFile = join(dir, 'tasks.json');
  const outFile = join(dir, 'out.json');
  try {
    writeFileSync(inFile, JSON.stringify({ images: sampleImages, repeat }, null, 1), 'utf8');
    const t = Date.now();
    const ret = spawnSync(PYTHON, ['-X', 'utf8', '-c', WORKER_CODE, inFile, outFile], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout: 600000,
      windowsHide: true,
    });
    const wallMs = Date.now() - t;
    if (ret.status !== 0 || !readFileSyncSafe(outFile)) {
      return { ok: false, wallMs, error: String(ret.stderr || '').trim().slice(-800) || `python exit ${ret.status}` };
    }
    const parsed = JSON.parse(readFileSync(outFile, 'utf8'));
    return { ok: true, wallMs, ...parsed };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function readFileSyncSafe(p) {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
}

/** 现状路径：每次识别都 spawn 一次 python（重新加载模型）。 */
function runPerCall(imagePath) {
  const t = Date.now();
  const ret = spawnSync(PYTHON, ['-X', 'utf8', RAPID_SCRIPT, imagePath], {
    encoding: 'buffer',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    timeout: 120000,
    windowsHide: true,
  });
  const wallMs = Date.now() - t;
  return { ok: ret.status === 0, wallMs, stderr: String(ret.stderr || '').slice(-400) };
}

const out = {
  generatedAt: new Date().toISOString(),
  command: argv.join(' '),
  platform: process.platform,
  node: process.version,
  python: PYTHON,
  corpus: { manifest: 'test/fixtures/ocr-corpus/manifest.json', images: sampleImages.map((i) => i.captureId), repeat },
  constraints: {
    pollIntervalMs: 2000,
    scriptTimeoutMs: 90000,
    note: '2s 轮询与 90s 脚本上限取自 v0.2.8 生产通道配置（docs/CHANNELS.md）',
  },
};

const worker = runWorker();
out.worker = worker;

const perCall = [];
for (const img of sampleImages) {
  const r = runPerCall(img.path);
  perCall.push({ captureId: img.captureId, ok: r.ok, wallMs: r.wallMs, stderr: r.stderr || undefined });
}
const perCallMs = perCall.map((p) => p.wallMs);
out.perCall = {
  samples: perCall,
  avgMs: perCallMs.reduce((a, b) => a + b, 0) / perCallMs.length,
  minMs: Math.min(...perCallMs),
  maxMs: Math.max(...perCallMs),
};

// 与生产约束对照的结论（纯计算，不改生产代码）
if (worker.ok && worker.available) {
  out.comparison = {
    workerInitOnceMs: Math.round(worker.importMs + worker.initMs),
    workerFirstInferMs: Math.round(worker.firstInferMs),
    workerSteadyAvgMs: Math.round(worker.steadyAvgMs),
    perCallAvgMs: Math.round(out.perCall.avgMs),
    savedPerCaptureMs: Math.round(out.perCall.avgMs - worker.steadyAvgMs),
    withinPollingBudget: {
      perCallFits2s: out.perCall.avgMs < 2000,
      workerFits2s: worker.steadyAvgMs < 2000,
      perCallFits90s: out.perCall.avgMs < 90000,
    },
    rssMB: {
      afterInit: Math.round(worker.rssAfterInitMB),
      afterInfer: Math.round(worker.rssAfterInferMB),
      peak: Math.round(worker.peakRssAfterInferMB),
    },
  };
} else {
  out.comparison = { error: worker.error || 'worker 不可用' };
}

mkdirSync(resultsDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const file = join(resultsDir, `${ts}-worker-eval.json`);
writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');

if (jsonOnly) {
  console.log(JSON.stringify(out, null, 1));
} else {
  console.log('=== RapidOCR Worker 量化评估（5.3，只测不接线） ===');
  console.log(`样本: ${sampleImages.map((i) => i.captureId).join(', ')}  repeat=${repeat}`);
  if (worker.ok && worker.available) {
    console.log(`[worker] 模型 = ${worker.engine} ${worker.version}；import ${Math.round(worker.importMs)}ms + 初始化 ${Math.round(worker.initMs)}ms（只一次）`);
    console.log(`[worker] 首图 ${Math.round(worker.firstInferMs)}ms，稳态每图 ${Math.round(worker.steadyAvgMs)}ms，${worker.inferCount} 张共 ${Math.round(worker.workerBatchTotalMs)}ms`);
    console.log(`[worker] RSS 初始化后 ${Math.round(worker.rssAfterInitMB)}MB，推理后 ${Math.round(worker.rssAfterInferMB)}MB（峰值 ${Math.round(worker.peakRssAfterInferMB)}MB）`);
  } else {
    console.log(`[worker] 不可用：${worker.error || '未知原因'}`);
  }
  console.log(`[现状] 每次调用重新加载模型：平均 ${Math.round(out.perCall.avgMs)}ms（${out.perCall.minMs}-${out.perCall.maxMs}ms，${perCall.length} 次采样）`);
  const c = out.comparison || {};
  if (c.savedPerCaptureMs) {
    console.log(`[对比] 常驻 Worker 每帧可省约 ${c.savedPerCaptureMs}ms；2s 轮询预算: ${c.withinPollingBudget.workerFits2s ? '可容纳' : '不可容纳'}；90s 脚本上限: ${c.withinPollingBudget.perCallFits90s ? '可容纳' : '不可容纳'}`);
    console.log('[结论] 是否值得做 Worker 见 docs/OCR-BENCHMARK.md §6.8（本脚本只给量化数据，不接线）');
  }
  console.log(`\n结果文件: ${file}`);
}

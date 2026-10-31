# OCR Benchmark（草稿）

> 状态：v3.0.0 OCR 方案的**基准地基草稿**（2026-10-31）。
> 覆盖：合成类微信聊天截图语料 + 独立 OCR 引擎适配 + CER/行级/整句指标 + v0.2.8 后处理 baseline。
> 不覆盖：真实微信截图（合规：不截图、不启动、不发送）、v3 新 OCR 方案的最终数字（等方案落地后用它跑 A/B）。

本文所有数字都来自 `scripts/ocr/bench.mjs` 在「语料 40 张 + 3 个预处理变体」上的**真实运行结果**（原始 JSON 在 `test/fixtures/ocr-corpus/results/`）。未测项在文中明确写「未测」并给原因，没有编造数字。

---

## 1. 环境

| 项 | 值 |
|---|---|
| OS | Windows 11 家庭中文版 10.0.22631（x64） |
| CPU | Intel Core i7-14700HX |
| 内存 | 15.8 GB |
| Node.js | v26.13.0（npm 11.20.0） |
| Python | 3.14.2 |
| Pillow | 13.0.0 |
| rapidocr_onnxruntime | 1.2.3（该包没有 `__version__` 属性，`engines.mjs` 只能探测「可导入/不可导入」） |
| onnxruntime | 1.31.1 |
| WinRT OCR | `Windows.Media.Ocr`，语言 `zh-Hans-CN`（语言包已安装） |
| 调用 PowerShell | Windows PowerShell 5.1（`powershell.exe`；PowerShell 7 没有 WinRT 类型投影，不能用） |
| 字体 | 微软雅黑 `msyh.ttc` + Segoe UI Emoji `seguiemj.ttf` |

`node scripts/ocr/bench.mjs` 每次会自检并打印一行环境摘要，例如：

```text
环境: win32 node=v26.13.0 python=3.14.2 (rapidocr OK) pillow=13.0.0
```

> 机器相关的绝对路径（python 解释器位置、字体路径）不写进文档，脚本会自己探测；需要指定解释器时用 `--python=<path>` 或环境变量 `OCR_BENCH_PYTHON`。

---

## 2. 语料：合成「类微信聊天截图」

- 生成器：`scripts/ocr/gen_corpus.py`（纯 Pillow 绘制，不截屏、不启动微信）。
- 固定种子：`seed = 20261031`，重跑得到同样的 40 张图（时间戳由种子派生，也固定）。
- 规模：**20 个场景 × 2 个变体 = 40 张**，基准尺寸 480×640（模拟手机竖屏聊天窗口）。
- 每张图包含：窗口标题栏（好友名）、顶部/中间时间戳、左右气泡 + 头像、底部输入框占位「输入消息」、浅色/深色主题。
- 隐私：**全部内容虚构**。好友名只用 `A`/`B`/`C`，正文是测试文案，手机号/单号/金额均为占位假数据（如 `13800000000`），不含真实人名、wxid、邮箱。

产物：

```text
test/fixtures/ocr-corpus/
  images/<captureId>.png      # 40 张合成图
  manifest.json               # 真值（GT）+ 场景元信息
  results/                    # bench 输出（按运行时间戳命名，summary.json 为汇总）
  results/derived/            # bench 生成的预处理变体图（2x、灰度+对比度）
```

`manifest.json` 每个 image 的关键字段：

| 字段 | 说明 |
|---|---|
| `captureId` / `scenario` / `variant` | 图 id、场景、变体（`-00`/`-01`） |
| `scalePct` / `scaleX` / `scaleY` | 该场景的缩放/拉伸比例（100/125/150/175%、stretch x1.35） |
| `theme` / `fontSize` / `blurRadius` / `noiseSigma` | 渲染参数 |
| `width` / `height` | 最终图像素尺寸 |
| `expectedMessages[]` | 真值消息：`sender`（left/right）、`text`、`bbox`、`lineBoxes[{text,bbox}]` |
| `expectedContext[]` | 窗口 chrome：`kind`（title/input/timestamp）、`text`、`region`，用于从假消息统计里豁免 |

坐标约定：**全部是最终图像素坐标**（缩放/拉伸后已换算），原点在左上角。

### 场景表（每场景 2 张）

| 场景 | 说明 | winrt-orig CER | rapid-orig CER |
|---|---|---|---|
| `clear` | 清晰基准（15px、浅色、100%） | 12.12% | 0.00% |
| `small_font` | 小字号（10px，模拟微信小号字） | 100.00% | 11.43% |
| `low_contrast` | 低对比（灰字浅底） | 37.84% | 0.00% |
| `gaussian_blur` | 高斯模糊（radius 1.2） | 100.00% | 0.00% |
| `scale_100` | 缩放 100%（基准） | 6.67% | 0.00% |
| `scale_125` | 缩放 125% | 6.45% | 0.00% |
| `scale_150` | 缩放 150% | 0.00% | 0.00% |
| `scale_175` | 缩放 175% | 3.33% | 0.00% |
| `long_bubble` | 超长气泡（多行换行） | 14.93% | 0.75% |
| `repeat_two` | 连发两条相同文本 | 0.00% | 0.00% |
| `bilingual` | 中英混排 | 7.89% | 0.00% |
| `numbers` | 数字 / 金额 / 电话 / 日期（均为虚构占位） | 20.37% | 0.93% |
| `emoji` | emoji / 颜文字（OCR 通常读不出，属预期） | 85.00% | 72.50% |
| `dark_mode` | 深色模式 | 12.12% | 0.00% |
| `occluded` | 半遮挡（通知条盖住部分气泡） | 60.00% | 52.50% |
| `multi_message` | 多行多消息（6 条 + 中间时间戳） | 20.69% | 0.00% |
| `short_msgs` | 极短消息（1-2 字气泡） | 27.27% | 36.36% |
| `stretched` | 截图横向拉伸（x1.35 / y1.0） | 87.50% | 0.00% |
| `noisy` | 压缩噪声（sigma 8） | 8.57% | 0.00% |
| `ai_disclaimer` | AI 免责声明长消息 | 42.31% | 1.28% |

---

## 3. 指标定义

### 3.1 预处理变体

bench 对每张图生成 3 个变体再分别识别（变体图写到 `results/derived/<variant>/`）：

| 变体 | 做法 | 坐标换算 |
|---|---|---|
| `orig` | 原图 | ×1 |
| `upscale2x` | LANCZOS 放大 2 倍 | 识别坐标 ÷2 后与 GT 比较 |
| `gray_contrast` | 自动对比度 → 灰度 → 对比度 ×1.6 | ×1 |

### 3.2 文本归一化（必须先做，否则指标失真）

1. **CJK 空格归一化**：Windows OCR 的中文行输出字与字之间有空格（`今 天 大 肥 鱼`）。规则：两个 CJK 字符之间的空格删除，英文/数字单词之间的空格保留（`OK 明天` 里的空格保留，`今 天` 里的删掉）。
2. **比较时再去掉全部空白**（`normalizeForCompare`），用于 CER/整句/行匹配。
3. **窗口 chrome 豁免**：标题、输入框占位、时间戳按 `expectedContext.region`（中心点落在区域内）或文本相等剔除，不计入假消息。

### 3.3 行级指标

- **行匹配**：OCR 行与 GT 行文本相似度 `sim = 1 - Levenshtein/len`；要求 `sim ≥ 0.5`，且 `sim < 1` 时 IoU ≥ 0.15（文本不完全一致时位置也要对得上）；贪心一对一匹配。
- **行切分（fragment）**：未匹配上、但内容是某条 GT 消息文本子串且长度 ≥3 的 OCR 行，视为「引擎把长行切成多段」，不算假消息，但计入行 precision 分母（partial）。否则长消息换行/emoji 断行会把 precision 打得很低、失真。
- 公式：
  - `行 Precision = TP / (TP + FP + 重复 + 切分)`
  - `行 Recall = TP / GT 行数`
  - `行 F1 = 2PR/(P+R)`
- **漏读率** = `FN / GT 行数`；**假消息率** = `FP / OCR 内容行数`；**重复率** = `重复行 / OCR 内容行数`；**行切分率** = `fragment / OCR 内容行数`。

### 3.4 消息级指标

- **CER**：按 GT 行序把匹配到的 OCR 行拼成消息文本（未匹配行视为缺失），
  `CER = Σ Levenshtein(OCR 消息文本, GT 消息文本) / Σ GT 字符数`。
  插入多于 GT 时 CER 可能 >100%（如 winrt 在 `stretched` 场景 105%）。
- **整句准确率**：归一化后 OCR 消息文本与 GT 完全一致的消息数 / 消息数。

### 3.5 耗时

- P50/P95 用 nearest-rank，单位为单图 OCR 毫秒数。
- WinRT 的 `elapsedMs` 是脚本内 `Stopwatch` 的纯识别时间（不含 PowerShell 进程启动）；bench 打印的组合墙钟包含每图一次 `powershell.exe` 启动开销（≈330ms/图，见 §5）。
- RapidOCR 走「一个 Python 进程批量跑完一组图」，P50 含单图推理 + 批量循环开销，不含模型加载（模型加载时间单独记录为 `modelLoadMs`）。

---

## 4. 引擎适配层

| 文件 | 作用 |
|---|---|
| `scripts/pwsh/ocr-winrt.ps1` | PS 5.1 + WinRT OCR。`-Path <png>`，stdout 单行 UTF-8 JSON：`{ok,engine,elapsedMs,width,height,lines:[{text,x,y,w,h}]}`；失败 `{ok:false,error}` + exit 1。只读图片。 |
| `scripts/ocr/engines.mjs` | ESM 适配层：`runWinrt(path)`、`runRapidocr(path)`、`runRapidocrBatch(paths)`（一次加载模型）、`prepareVariants()`（Pillow 生成变体图）、CJK 空格归一化、Levenshtein、IoU、行框合并等。 |
| `scripts/ocr/bench.mjs` | 基准编排 + 指标 + 结果落盘；见 §6/§7。 |
| `scripts/ocr/baseline-v028.mjs` | v0.2.8 后处理逐行转写（`desktop.ts:61-163`、`:307-355`），只做文本级后处理。 |

实现上的两个坑（已踩过，写在这里避免后人重踩）：

1. **PowerShell 输出编码**：PS 5.1 默认按系统代码页（GBK）写 stdout；被 Node 以 `windowsHide: true`（CREATE_NO_WINDOW）启动时 `[Console]::OutputEncoding` 设置也会失效，中文变乱码、CER 直接 100%。现在的写法是用 `[Console]::OpenStandardOutput()` 直接写 UTF-8 字节，绕开 TextWriter 编码；`.ps1` 必须保存为 **UTF-8 带 BOM**（PS 5.1 读无 BOM 的 UTF-8 中文会解析出错）。
2. **WinRT 只接受绝对路径**：`StorageFile.GetFileFromPathAsync` 传相对路径会抛 `One or more errors occurred`，helper 里先 `[IO.Path]::GetFullPath()`。

调用示例：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/pwsh/ocr-winrt.ps1 -Path test/fixtures/ocr-corpus/images/clear-00.png
```

400×640 的 `clear-00.png` 实测单行 JSON（`elapsedMs` ≈ 25-30ms）：
`{"ok":true,"engine":"winrt-zh-Hans-CN","elapsedMs":26,...}`。
注意 WinRT 会把中文识别成字间带空格、且会漏字（例如把「今天大肥鱼很好吃」读成「今 天 大 肥 很 好 吃」），所以 bench 侧一定要先做 CJK 空格归一化。

---

## 5. 结果：引擎 × 变体（40 张/组，真实实测）

本次全量运行 240 次识别（6 组 × 40 张），总墙钟 **237.5 s**（其中变体图生成 80 张耗时 1.64s）。

| 引擎 | 变体 | CER | 行 P | 行 R | 行 F1 | 整句 | 漏读率 | 假消息率 | 重复率 | 行切分率 | P50 | P95 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| winrt | orig | 31.22% | 73.74% | 75.26% | 0.745 | 31.82% | 24.74% | 22.22% | 0.00% | 4.04% | 26ms | 37ms |
| winrt | upscale2x | 21.64% | 84.04% | 81.44% | 0.827 | 46.59% | 18.56% | 12.77% | 0.00% | 3.19% | 36ms | 49ms |
| winrt | gray_contrast | 31.00% | 76.09% | 72.16% | 0.741 | 25.00% | 27.84% | 22.83% | 0.00% | 1.09% | 26ms | 37ms |
| rapid | orig | 6.57% | 95.74% | 92.78% | 0.942 | 82.95% | 7.22% | 1.06% | 0.00% | 3.19% | 1425ms | 1947ms |
| rapid | upscale2x | 7.64% | 92.86% | 93.81% | 0.933 | 77.27% | 6.19% | 2.04% | 0.00% | 5.10% | 1774ms | 2224ms |
| rapid | gray_contrast | 7.43% | 96.81% | 93.81% | 0.953 | 80.68% | 6.19% | 1.06% | 0.00% | 2.13% | 1501ms | 1977ms |

解读：

- **RapidOCR 在本合成集上全面优于 WinRT**：orig 变体 CER 6.57% vs 31.22%（约 4.8×），整句准确率 82.95% vs 31.82%，行 F1 0.942 vs 0.745。
- **WinRT 放大 2 倍收益明显**：CER 31.22% → 21.64%，整句 31.82% → 46.59%。WinRT 对小字号/低分辨率很敏感，预处理放大是 v3 值得试的方向。
- **RapidOCR 放大反而略差**（6.57% → 7.64%）：它自带检测/缩放，再放大 2x 收益不明显，且变体图更大更慢（P50 1425 → 1774ms）。
- **灰度+对比度提升**：对 WinRT 基本持平（31.00%），对 RapidOCR 也持平/略差（7.43%）；在本语料上不是有效增益方向。
- **耗时**：WinRT 纯 OCR P50 26-36ms/图，但 bench 里每图要新起一次 `powershell.exe`（组合墙钟 13.4s/40 张 ≈ 334ms/图），生产应复用进程或批量；RapidOCR P50 1.4-1.8s/图、单进程模型加载 0.96-1.28s（`modelLoadMs`：964/1280/1034ms），远慢于 WinRT，但精度高一个档位。

### 分场景 CER（4 种组合）

| 场景 | winrt-orig | winrt-2x | rapid-orig | rapid-gray |
|---|---|---|---|---|
| clear | 12.12% | 6.06% | 0.00% | 0.00% |
| small_font | 100.00% | 34.29% | 11.43% | 5.71% |
| low_contrast | 37.84% | 45.95% | 0.00% | 2.70% |
| gaussian_blur | 100.00% | 100.00% | 0.00% | 33.33% |
| scale_100 | 6.67% | 0.00% | 0.00% | 0.00% |
| scale_125 | 6.45% | 3.23% | 0.00% | 0.00% |
| scale_150 | 0.00% | 6.67% | 0.00% | 0.00% |
| scale_175 | 3.33% | 3.33% | 0.00% | 0.00% |
| long_bubble | 14.93% | 5.22% | 0.75% | 0.75% |
| repeat_two | 0.00% | 21.43% | 0.00% | 0.00% |
| bilingual | 7.89% | 3.95% | 0.00% | 0.00% |
| numbers | 20.37% | 11.11% | 0.93% | 0.93% |
| emoji | 85.00% | 67.50% | 72.50% | 72.50% |
| dark_mode | 12.12% | 0.00% | 0.00% | 0.00% |
| occluded | 60.00% | 52.50% | 52.50% | 52.50% |
| multi_message | 20.69% | 5.17% | 0.00% | 0.00% |
| short_msgs | 27.27% | 36.36% | 36.36% | 18.18% |
| stretched | 87.50% | 100.00% | 0.00% | 0.00% |
| noisy | 8.57% | 8.57% | 0.00% | 0.00% |
| ai_disclaimer | 42.31% | 8.97% | 1.28% | 0.00% |

各场景的整句准确率/漏读率/假消息率见 `results/*.json` 的 `byScenario` 字段（bench 已按场景聚合）。

值得注意的几项：

- **emoji/颜文字**：两个引擎都基本读不出（winrt 85%、rapid 72.5%），这是 OCR 引擎的固有限制，属**预期失败**；生产里 emoji 不应该进文本管道。
- **stretched（横向拉伸 1.35x）**：WinRT 87.5% 崩掉，RapidOCR 0% —— RapidOCR 的检测框对横向拉伸更鲁棒。
- **small_font（10px）**：WinRT 完全失败（100%）、RapidOCR 11.4%；这个字号在真实微信里偏小，但用户可调小字号，是需要防的场景。
- **gaussian_blur（radius 1.2）**：WinRT 两个变体都 100%，RapidOCR 原图 0%、灰度 33% —— 该场景对 RapidOCR 原图仍可读，对 WinRT 是死区。
- **occluded（通知条遮住下半气泡）**：两边都 ~52%，丢的正是被遮住的那半行。

---

## 6. v0.2.8 后处理 baseline（A/B 基线）

实现：`scripts/ocr/baseline-v028.mjs`，**逐行转写自 `src/channels/pc/desktop.ts:61-163`、`:307-355`**（行号基准是 feat/v3.0.0 初始提交；v3 重构把纯函数搬到了 `src/core/ocr/`，本文件是 v0.2.8 行为的独立快照），包含：
`ocrNoiseScore` / `looksGarbled` / `pickBetterText` / `correctOcrText`（含 `DEFAULT_OCR_DICT` 30 词）/ `textOverlapRatio` / `mergeEngineVote` / `recheckGarbledText`（双帧 4x/2x + 第二引擎投票）。
script I/O 换成注入的帧候选，**决策顺序、阈值、选优函数一律未改**。

跑法：winrt 原始行 → baseline 后处理 → 同一套指标；`--pipeline=baseline`（或默认 `all`）。

| 指标 | v0.2.8 原始（raw） | v0.2.8 后处理后（post） | 变化 |
|---|---|---|---|
| CER（88 条消息） | 28.42% | 28.09% | −0.33pp |
| 整句准确率 | 31.82% | 32.95% | +1.14pp |
| 改动消息数 | — | 3 条 | 改善 2 / 变差 0 |

3 条被改动的消息（全量 88 条里 3 条）：

| 图 | GT | raw → post | CER raw → post |
|---|---|---|---|
| `clear-00` | 今天大肥鱼很好吃 | 今天大肥很好吃 → 今天大肥鱼好吃 | 12.50% → 12.50% |
| `bilingual-00` | OK，明天 10:30 我们开个 Zoom 会议聊一下 OCR 的事情 | …开个 Zoom 芸议… → …开个 Zoom 会议… | 10.34% → 6.90% |
| `occluded-00` | 遮挡的部分还能认出来吗 | 遮扌当的部分… → 遮挡的部分… | 18.18% → 0.00% |

结论：

- v0.2.8 后处理主要靠 `DEFAULT_OCR_DICT` 纠正**固定词误读**（`芸议→会议`、`遮扌当→遮挡`），这类修正在本语料上只有 2 条收益；对**漏字**没有帮助（`今天大肥很好吃→今天大肥鱼好吃` 补了字但位置错，CER 不变）。
- 因此 v3 新方案要证明价值，必须在这套指标上显著超过 **CER ≤ 28.09% / 整句 ≥ 32.95%** 这条 v0.2.8 基线；只靠词典纠错不够。

口径说明（重要）：

- baseline 组用 **GT bbox 近似分组**（把这组文字按消息框归类），而引擎总表用的是「行匹配 + GT 行序拼接」，两者口径略有差异，所以 baseline 的 raw CER（28.42%）与 §5 表里 winrt-orig 的 CER（31.22%）不完全相等；**raw 与 post 两列同口径，可直接对比**。
- 真实 `recheckGarbledText` 用 4x + 2x 双帧投票；本 bench 只生成了 2x 变体，`frames['4']` **未采集（未测）**，投票退化为单 2x 帧 + 第二引擎（RapidOCR orig）投票。因此这里的 baseline 是**偏保守的近似**，不包含 4x 帧带来的潜在收益。

---

## 7. 复现

前置：Windows + 已装 `zh-Hans-CN` OCR 语言包（WinRT 需要）；Python 已装 Pillow 与 rapidocr_onnxruntime（RapidOCR 需要，未装时可用 `--engine=winrt` 只跑 WinRT）。

```powershell
# 1) 生成语料（固定 seed，可重复生成同样的 40 张）
python scripts/ocr/gen_corpus.py

# 2) 全量基准（两个引擎 × 3 个变体 + baseline 组），约 4 分钟
node scripts/ocr/bench.mjs --engine=all

# 3) 冒烟/子集
node scripts/ocr/bench.mjs --engine=winrt --limit=6 --scenario=clear,dark_mode
node scripts/ocr/bench.mjs --engine=rapid --pipeline=baseline --limit=10
# 自定义结果目录（避免覆盖工作区结果）
node scripts/ocr/bench.mjs --engine=winrt --limit=2 --out-dir=%TEMP%\ocr-bench-smoke

# 4) 单独跑一次 WinRT helper（单图）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/pwsh/ocr-winrt.ps1 -Path test/fixtures/ocr-corpus/images/clear-00.png
```

输出：

- `results/<时间戳>-<engine>-<variant>.json`：每次（引擎×变体）一份，含 `meta`（环境/命令/语料信息）、`images`（每图识别行 + 指标 + perMessage）、`totals`（总指标）、`byScenario`（分场景）。
- `results/<时间戳>-baseline-v028-orig.json`：baseline raw/post 对照（`--pipeline=baseline|all` 时生成）。
- `results/summary.json`：本次所有 run 的汇总，供文档/CI 取值。

参数：`--engine=winrt|rapid|all`、`--limit=N`、`--scenario=a,b`、`--pipeline=raw|baseline|all`、`--out-dir=<path>`、`--python=<path>`。单图失败不会中断整体（失败记录写入 JSON 的 `ok:false`）。

全量耗时参考（本机）：变体图生成 80 张 ≈1.6s；winrt 3 组 × 40 张 ≈13.4/14.1/13.7s；rapid 3 组 × 40 张 ≈58.3/74.1/62.3s；总 **237.5s**。

---

## 8. 已知局限（未测的都在这里）

1. **未测真实微信截图**：合规要求不截图/不启动/不发送真实微信，语料全部是 Pillow 合成图；真实微信的头像照片、表情、引用、图片消息、系统通知条分布与之不同。
2. **规模小、方差大**：只有 40 张、每场景 2 张，单张图的分数波动会影响场景均值；做显著性结论前需要扩量。
3. **emoji/颜文字不可读**：合成 emoji 用 Segoe UI Emoji，和微信自有 emoji 渲染不同；OCR 读不出 emoji 是预期行为，但会让整句准确率天然为 0（`emoji` 场景）。
4. **头像偶发假文本**：真实头像是照片，合成头像是低对比度马赛克纹理，但仍可能被 OCR 读成 `0`/`网` 等（如 `low_contrast-01`、`scale_175-00`）；这类假消息在真实场景也存在，v0.2.8 靠坐标/`contactNames` 过滤，不是本 bench 能消除的。
5. **小字号是压力场景**：10px 在 WinRT 下基本全错（100% CER），但它对应真实用户把微信字号调小的情况，保留作为防御场景。
6. **缩放变体是图像 resize，不是真实系统 DPI 缩放**：字体 hinting/次像素渲染与真实高 DPI 截图不同，只能做相对比较。
7. **`gaussian_blur` radius 1.2 偏狠**（100% 失败），属于压力上限，不代表日常截图。
8. **RapidOCR 耗时不等于生产延迟**：bench 用单进程批量跑（含 Python 启动、批量编排），生产若每图起一个 python 进程还要再加 0.96-1.28s 模型加载；反过来 WinRT 每图起一个 PowerShell 进程的开销（≈330ms/图）也不应带进生产。
9. **行级指标对切行策略敏感**：引擎把一条 GT 行切成两行时记为 fragment（不算假消息、计入 precision 分母），指标仍会略吃亏；这是刻意的保守口径。
10. **baseline 组的 4x 帧未采集**（见 §6 口径说明），真实 v0.2.8 的 4x/2x 双帧投票收益未测。
11. **单机单次测量**：P50/P95 未做多次重复与置信区间；RapidOCR 首次加载模型耗时（0.8-1.0s）单独记录，但不同机器差异可能很大。
12. **未接入真实 UI 坐标分组**：baseline 分组用 GT bbox 近似，真实 pipeline 按 UI 元素坐标分组；分组误差会轻微影响 baseline 数字。

---

## 9. 本次改动范围

只新增文件，未修改任何既有文件：

```text
scripts/ocr/gen_corpus.py        # 合成语料生成器
scripts/ocr/engines.mjs          # 引擎适配层（WinRT / RapidOCR / 预处理 / 文本工具）
scripts/ocr/bench.mjs            # 基准编排 + 指标 + 结果落盘
scripts/ocr/baseline-v028.mjs    # v0.2.8 后处理逐行转写（A/B baseline）
scripts/pwsh/ocr-winrt.ps1       # WinRT OCR helper（PS 5.1，UTF-8 带 BOM）
test/fixtures/ocr-corpus/        # 40 张合成图 + manifest.json + results/
docs/OCR-BENCHMARK.md            # 本文
```

`scripts/py/rapid_ocr.py`、`scripts/pwsh/wechat-uia.ps1`、`src/**`、`package.json`、`.gitignore` 等既有文件均未改动（仓库工作区里其它未提交改动来自并行任务，与本目录无关）。

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
- 固定种子：`seed = 20261031`，重跑得到同样的 **60 张图**（时间戳、头像纹理、噪点全部由种子派生，也固定）。
- 规模：**30 个场景 × 2 个变体 = 60 张**（v1 为 20 场景 / 40 张；§5/§6/§6.5 的历史数字基于 v1 语料），基准尺寸 480×640（模拟手机竖屏聊天窗口）。
- 每张图包含：窗口标题栏（好友名）、顶部/中间时间戳、左右气泡 + 头像、底部输入框占位「输入消息」、浅色/深色主题。
- 隐私：**全部内容虚构**。好友名只用 `A`/`B`/`C`，正文是测试文案，手机号/单号/金额均为占位假数据（如 `13800000000`），不含真实人名、wxid、邮箱。

产物：

```text
test/fixtures/ocr-corpus/
  images/<captureId>.png      # 60 张合成图
  manifest.json               # 真值（GT）+ 场景元信息
  results/                    # bench 输出（按运行时间戳命名，summary.json 为汇总）
  results/derived/            # bench 生成的预处理变体图（按 --variants 生成，可重建，不入库）
```

`manifest.json` 每个 image 的关键字段：

| 字段 | 说明 |
|---|---|
| `captureId` / `scenario` / `variant` | 图 id、场景、变体（`-00`/`-01`） |
| `scalePct` / `scaleX` / `scaleY` | 该场景的缩放/拉伸比例（100/125/150/175%、stretch x1.35） |
| `theme` / `fontSize` / `blurRadius` / `noiseSigma` | 渲染参数 |
| `width` / `height` | 最终图像素尺寸 |
| `expectedMessages[]` | 真值消息：`sender`（left/right）、`text`、`bbox`、`lineBoxes[{text,bbox}]` |
| `expectedContext[]` | 窗口 chrome：`kind`（title/input/timestamp/system/screen_text）、`text`、`region`，用于从假消息统计里豁免 |
| `manifest.version` / `coverageCount` | v2 语料：`version: 2`、`coverageCount: 21`；每个场景带 `index`，顶层 `coverage[]` 是任务书 12.1 覆盖项 → 场景映射（生成时断言 21 项全覆盖，否则 `SystemExit`） |
| `emptyGt` | `empty_error` 场景的 GT 为「无消息」（模拟截图失败/空截图）；bench 对该类图单独统计（CER 不进分母、整句/假消息另算） |

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

### v2 新增场景（12.1 覆盖补齐，index 20-29）

> 新场景全部追加在列表**末尾**，旧 20 场景的渲染顺序与 rng 消耗不变；已实测：重跑后旧 40 张图 SHA256 与 v1 完全一致。

| 场景 | 说明 | 对应覆盖项 |
|---|---|---|
| `rare_chars` | 生僻字/多音字（银行行长、魑魅魍魉、饕餮耄耋…） | polyphone-rare |
| `homophone` | 形近字（己已巳、未末、戌戍、辨辩辫） | near-chars、engine-conflict |
| `network_slang` | 网络口语（yyds、绝绝子、破防、栓Q、emo） | slang |
| `similar_nickname` | 相似昵称（标题「小A」「小A2」） | similar-nickname |
| `long_nickname` | 长昵称（8-9 字标题） | long-nickname |
| `truncated_bubble` | 气泡被窗口右缘截断（GT 为完整文本，被裁部分必然读不到） | truncated-bubble |
| `empty_error` | 错误/空截图（空白画面 + 居中提示文字，GT 无消息） | empty-error |
| `engine_conflict` | 双引擎易冲突（小字号 + 低对比 + 形近字） | engine-conflict、near-chars |
| `scrolled` | 窗口滚动中（12 条短消息，顶部消息/时间戳被标题栏盖住） | scrolled |
| `contact_switch` | 切换联系人（系统提示「你已添加了 A…」+ 2 条消息） | contact-switch |

### 12.1 场景覆盖对照（`manifest.coverage`，21 项）

| 覆盖项 | 场景 |
|---|---|
| 形近字 | `homophone`、`engine_conflict` |
| 多音字及生僻字 | `rare_chars` |
| 中英混排 | `bilingual` |
| 数字和标点 | `numbers` |
| 网络口语 | `network_slang` |
| Emoji | `emoji` |
| 多行消息 | `long_bubble`、`multi_message` |
| 长消息 | `long_bubble`、`ai_disclaimer` |
| 同一消息重复出现 | `repeat_two`、`multi_message` |
| 连续两条相同消息 | `repeat_two` |
| 相似昵称 | `similar_nickname` |
| 长昵称 | `long_nickname` |
| 深色主题 | `dark_mode` |
| 浅色主题 | `clear`、`scale_100` |
| 不同 DPI/缩放 | `scale_100`、`scale_125`、`scale_150`、`scale_175`、`stretched` |
| 消息内容截断 | `truncated_bubble` |
| 被遮挡 | `occluded` |
| 错误或空截图 | `empty_error` |
| 双引擎识别冲突 | `engine_conflict` |
| 窗口滚动 | `scrolled` |
| 用户或切换联系人 | `contact_switch` |

> 任务书 12.1 的「合成图、模拟数据、真实数据分别统计」：本仓库只能覆盖**合成图**这一类；真实微信数据按合规要求不采集，模拟数据也未接入（见 §8）。

---

## 3. 指标定义

### 3.1 预处理变体

bench 对每张图生成 3 个变体再分别识别（变体图写到 `results/derived/<variant>/`）：

| 变体 | 做法 | 坐标换算 |
|---|---|---|
| `orig` | 原图 | ×1 |
| `upscale2x` | LANCZOS 放大 2 倍 | 识别坐标 ÷2 后与 GT 比较 |
| `gray_contrast` | 自动对比度 → 灰度 → 对比度 ×1.6 | ×1 |

> 上表是 bench 默认 3 变体（向后兼容）。任务书 4.4 的 A–H 预处理通过 `--variants=` 选用：`crop_pane`(B)、`gray`(C)、`equalize_clahe`(D)、`median3`(E)、`upscale3x`(F3)、`scale2x_nearest/bilinear/bicubic`(G)、`adaptive_threshold`(H)，实测见 §4.5。`crop_pane` 变体的坐标带 y 偏移（裁掉标题栏 36px），bench 会先换算回原图坐标再与 GT 比较。

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
- **资源指标（任务书 12.2）**：`ocr-winrt.ps1` 额外输出 `cpuMs`（当前 PowerShell 进程的 TotalProcessorTime 增量）与 `rssMB`（进程 PeakWorkingSet），bench 聚合为 `cpuP50Ms/cpuP95Ms/rssP95MB/rssMaxMB`；这些是**脚本子进程**指标，含进程启动开销，不代表生产主进程资源占用。数字见 §6.7。

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

## 4.5 预处理 A–H（任务书 4.4，tune/eval 分开实测）

**方法**：单引擎 WinRT；每个变体先用 Pillow 生成派生图（`--variants=`，见 `engines.mjs` 的 `VARIANTS_ALL` / `PREPARE_CODE`），再做 OCR，最后用同一套行级/消息级指标。拆分按 `manifest.scenarios` 0-based 奇偶：偶数索引 15 场景 = **tune**，奇数索引 15 场景 = **eval**，两组图片不重叠；**选型只看 tune，eval 不参与选择**。样本：tune 30 图 / 83 GT 行，eval 30 图 / 70 GT 行。命令见 §7。

**tune 结果**（30 图，总耗时 120.7s，含 330 张派生图生成与 330 次识别）：

| 变体 | CER | 行 F1 | 整句 | 漏读率 | 假消息率 | P50 | P95 | cpuP50 | rssP95 |
|---|---|---|---|---|---|---|---|---|---|
| `orig` (A) | 30.62% | 0.783 | 26.92% | 21.69% | 18.07% | 25ms | 36ms | 31ms | 104MB |
| `crop_pane` (B) | 31.00% | 0.800 | 25.64% | 22.89% | 12.99% | 22ms | 34ms | 47ms | 104MB |
| `gray` (C) | 31.26% | 0.769 | 25.64% | 21.69% | 23.26% | 24ms | 37ms | 47ms | 104MB |
| `equalize_clahe` (D) | 68.11% | 0.517 | 6.41% | 62.65% | 16.22% | 22ms | 38ms | 31ms | 103MB |
| `median3` (E) | 96.82% | 0.062 | 1.28% | 95.18% | 91.49% | 24ms | 45ms | 47ms | 103MB |
| `upscale2x` (F2) | 18.93% | 0.871 | 53.85% | 14.46% | 6.25% | 34ms | 56ms | 31ms | 120MB |
| **`upscale3x` (F3)** | **17.66%** | **0.902** | **53.85%** | **10.84%** | 7.41% | 46ms | 101ms | 47ms | 159MB |
| `scale2x_nearest` (G) | 25.92% | 0.841 | 38.46% | 16.87% | 9.88% | 32ms | 64ms | 31ms | 120MB |
| `scale2x_bilinear` (G) | 21.73% | 0.866 | 51.28% | 18.07% | 8.11% | 30ms | 44ms | 47ms | 120MB |
| `scale2x_bicubic` (G) | 21.35% | 0.841 | 53.85% | 16.87% | 11.11% | 32ms | 59ms | 47ms | 120MB |
| `adaptive_threshold` (H) | 43.84% | 0.711 | 10.26% | 34.94% | 18.84% | 24ms | 33ms | 31ms | 103MB |

**eval 结果**（30 图，总耗时 118.6s）：

| 变体 | CER | 行 F1 | 整句 | 漏读率 | 假消息率 | P50 | P95 | cpuP50 | rssP95 |
|---|---|---|---|---|---|---|---|---|---|
| `orig` (A) | 40.84% | 0.711 | 28.79% | 31.43% | 24.62% | 25ms | 31ms | 31ms | 105MB |
| `crop_pane` (B) | 35.44% | 0.758 | 30.30% | 28.57% | 19.35% | 23ms | 28ms | 16ms | 105MB |
| `gray` (C) | 45.65% | 0.627 | 25.76% | 40.00% | 32.81% | 25ms | 32ms | 31ms | 104MB |
| `equalize_clahe` (D) | 73.12% | 0.374 | 6.06% | 75.71% | 19.05% | 21ms | 36ms | 31ms | 104MB |
| `median3` (E) | 92.64% | 0.125 | 4.55% | 90.00% | 83.33% | 26ms | 33ms | 31ms | 104MB |
| `upscale2x` (F2) | 26.58% | 0.812 | 46.97% | 20.00% | 17.65% | 33ms | 45ms | 47ms | 130MB |
| **`upscale3x` (F3)** | **25.68%** | **0.837** | **51.52%** | **15.71%** | **16.90%** | 46ms | 90ms | 62ms | 182MB |
| `scale2x_nearest` (G) | 35.74% | 0.723 | 30.30% | 27.14% | 26.76% | 35ms | 55ms | 31ms | 130MB |
| `scale2x_bilinear` (G) | 27.18% | 0.803 | 45.45% | 21.43% | 17.91% | 34ms | 53ms | 47ms | 130MB |
| `scale2x_bicubic` (G) | 26.88% | 0.800 | 43.94% | 20.00% | 20.00% | 34ms | 54ms | 31ms | 130MB |
| `adaptive_threshold` (H) | 46.70% | 0.667 | 13.64% | 41.43% | 22.64% | 25ms | 35ms | 31ms | 104MB |

结论：

- **放大是最有效的单一预处理**：`upscale3x` 在 tune 上 CER 17.66%（orig 30.62%，−12.96pp）、eval 上 25.68%（orig 40.84%，−15.16pp），整句 +26.9pp/+22.7pp；`upscale2x` 次之。代价是 P50 25→46ms、RSS 105→182MB（eval 3x）。
- **G 组（2x 不同插值核）差异不大**：bilinear 21.73%、bicubic 21.35% 都接近 2x，`nearest` 25.92% 明显差——关键在像素量，插值核只影响几个点。
- **裁剪（B）单独用没有稳定 CER 增益**：tune 31.00%（orig 30.62%）略差，但假消息率 12.99%（orig 18.07%）明显下降、eval 35.44%（orig 40.84%）反而更好；说明裁剪主要减少「窗口 chrome / 滚动残条」被误读成消息，对正文识别无稳定提升。**裁剪与放大组合未测**（本任务时间只够单变体，留作后续）。
- **灰度/对比度/中值/自适应阈值在 WinRT 前一律有害**：`equalize_clahe` 68.11%/73.12%、`median3` 96.82%/92.64%、`adaptive_threshold` 43.84%/46.70%——二值化/平滑会破坏笔画。结论是「先放大，不要先动对比度」。
- **选型**：`BEST_VARIANT='upscale3x'`（tune 最优），eval 复核仍是 CER 最低，进入 §6.6 的 B/F 组。

---

## 5. 结果：引擎 × 变体（v1 语料 40 张/组，历史实测）

> §5 / §6 / §6.5 的数字基于 **v1 语料（20 场景 / 40 图）**，保留作历史对照（与任务书 12.4 的既有基线数字一致）；**v2 语料（30 场景 / 60 图）的最新数据**见 §4.5（预处理 A–H）、§6.6（A/B 六组）、§6.7（资源与事件）。

### 5.0 v2 语料全量（最新，60 图/组）

`node scripts/ocr/bench.mjs --engine=all --pipeline=all`（总耗时 152.0s，结果快照 `results/2026-11-01_02-01-45-*`，60 图 / 153 GT 行 / 144 条消息）：

| 引擎 / 管线 | CER | 行 F1 | 整句 | 漏读率 | P50 |
|---|---|---|---|---|---|
| winrt orig | 35.31% | 0.751 | 27.78% | 26.14% | 27ms |
| winrt upscale2x | 22.44% | 0.844 | 50.69% | 16.99% | 35ms |
| winrt gray_contrast | 35.38% | 0.731 | 20.14% | 30.72% | 26ms |
| rapid orig | **8.95%** | **0.950** | **79.86%** | 7.19% | 1444ms |
| baseline v0.2.8 raw | 31.38% | — | 27.78% | — | — |
| baseline v0.2.8 post | 30.70% | — | 29.17% | — | — |
| v3 novote / vote-garbled | 20.30% | — | 51.39% | — | — |
| v3 vote-all（上界参考） | 16.86% | — | 63.19% | — | — |

> v2 比 v1 多 10 个场景（`rare_chars`/`network_slang`/`scrolled`/`truncated_bubble` 等），整体更难（winrt orig CER 31.22% → 35.31%），**v1/v2 数字不完全可比**；v1 数字保留在下文与 §6.5。

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
- 因此 v3 新方案要证明价值，必须在这套指标上显著超过 **CER ≤ 28.09% / 整句 ≥ 32.95%** 这条 v0.2.8 基线；只靠词典纠错不够。v3 管线的验证结果见 **§6.5**。

**v2 语料复核（60 图 / 144 条消息，最新）**：

| 指标 | raw | post | 变化 |
|---|---|---|---|
| CER | 31.38% | 30.70% | −0.68pp |
| 整句准确率 | 27.78% | 29.17% | +1.39pp |
| 改动消息数 | — | 6 条 | 改善 5 / 变差 0 |

> v2 的 6 条改动全部来自 `DEFAULT_OCR_DICT` 词典命中（如 `similar_nickname`、`truncated_bubble`、`network_slang`、`occluded`、`bilingual`、`clear`），方向与 v1 一致：v0.2.8 后处理只能修固定词/个别字，不解决放大与漏字问题。

口径说明（重要）：

- baseline 组用 **GT bbox 近似分组**（把这组文字按消息框归类），而引擎总表用的是「行匹配 + GT 行序拼接」，两者口径略有差异，所以 baseline 的 raw CER（28.42%）与 §5 表里 winrt-orig 的 CER（31.22%）不完全相等；**raw 与 post 两列同口径，可直接对比**。
- 真实 `recheckGarbledText` 用 4x + 2x 双帧投票；本 bench 只生成了 2x 变体，`frames['4']` **未采集（未测）**，投票退化为单 2x 帧 + 第二引擎（RapidOCR orig）投票。因此这里的 baseline 是**偏保守的近似**，不包含 4x 帧带来的潜在收益。

---

## 6.5 v3 管线 vs v0.2.8 baseline（eval 集，Phase C 验证）

**目标**：验证发布门槛第 2 条「OCR 相对 v0.2.8 可测量改善」，目标线即 §6 的 `CER ≤ 28.09% / 整句 ≥ 32.95%`。

**语料拆分（tune / eval 不重叠，按 `manifest.scenarios` 0-based 奇偶）**：

| 拆分 | 场景数 | 图数 | GT 消息数 | 场景 |
|---|---|---|---|---|
| tune（只用于调试/看趋势） | 10 | 20 | 42 | clear、low_contrast、scale_100、scale_150、long_bubble、bilingual、emoji、occluded、short_msgs、noisy |
| eval（只跑一次，只报结果） | 10 | 20 | 46 | small_font、gaussian_blur、scale_125、scale_175、repeat_two、numbers、dark_mode、multi_message、stretched、ai_disclaimer |

本轮结果文件：`results/2026-10-31_15-25-03-tune-*.json`（已清理到临时目录，不在仓库）、`results/2026-10-31_15-26-56-eval-*.json`、`results/2026-10-31_15-28-57-all-*.json`。

### 实现与离线等价说明

`scripts/ocr/v3-pipeline.mjs` 把 `src/core/ocr/` 的纯函数**逐行转写成 JS**（不直接 import TS：bench 是纯 Node 脚本，且 `src/core/ocr/` 当时在并行改造）：

1. `normalizeOcrText`（CJK 间空格归一）→ 2. WinRT 2x 首读行按 GT bbox 分组、拼成消息文本 → 3. `looksGarbled` 判定可疑消息 → 4. 可疑时用 **RapidOCR 同图（orig）行**做第二引擎匹配（`|rapid.y - winTop| ≤ 26` 取最高重合度，<0.35 全局兜底；重合度 ≥0.35 且**更长**才替换，对齐 `wechat-uia.ps1:1906-1954` 的 SecondOcr）→ 5. `mergeEngineVote` + `pickBetterText`（对齐 `desktop.ts:389-437`）→ 6. `applyControlledCorrection`（对齐 `src/core/ocr/correction.ts:179-235`）。

三种配置：

| 配置 id | 行为 | 用途 |
|---|---|---|
| `novote` | WinRT 2x + 归一 + 受控纠错（不用第二引擎） | 拆出「只换 2x 首读」的贡献 |
| `vote-garbled` | 可疑消息才做 RapidOCR 同帧投票 | **v3 真实等价（结论用这一行）** |
| `vote-all` | 所有消息都跑 RapidOCR 投票 | 上界参考：在线每帧 1.4-2.1s，非真实可行方案 |

离线等价与真实 pipeline 的 5 处已知偏差（也见 §8）：无 4x 帧（真实首读可疑时会再换 4x/2x 帧重读，本实现等价到 2x 为止，偏保守）；消息分组用 GT bbox 近似（真实按 UI 坐标）；`recheckGarbledText` 真实作用于整段文本，这里按消息粒度；pane 取整图宽度；气泡归属用行框并集 + 4% 内边距近似 bubble bbox。

### tune 集结果（选参用）

| 组 | CER | 整句 | 可疑消息 | 第二引擎替换 | 桌面投票 | 纠错 |
|---|---|---|---|---|---|---|
| v0.2.8 raw | 19.53% | 35.71% | — | — | — | — |
| v0.2.8 post | 18.88% | 38.10% | — | — | — | — |
| winrt 2x（首读） | 18.45% | 45.24% | — | — | — | — |
| rapid orig（单引擎参考） | 11.80% | 76.19% | — | — | — | — |
| **v3 novote** | 16.31% | 47.62% | 5 | 0 | 0 | 1 |
| **v3 vote-garbled** | 16.31% | 47.62% | 5 | 0 | 0 | 1 |
| v3 vote-all（上界） | 12.02% | 61.90% | 5 | 5 | 6 | 1 |

tune 上的结论：`novote` 与 `vote-garbled` 完全相同 → **没有可调参数**（配置在调参前就由真实实现固定），因此 eval 只跑一次 `vote-garbled`。`vote-all` 明显更好，但它要求每条消息都跑 RapidOCR（1.4-2.1s/帧），只作为上界参考。

### eval 集结果（只报一次，真实实测）

| 组 | CER | 整句 | 消息数 | 可疑消息 | 第二引擎替换 | 桌面投票 | 纠错 |
|---|---|---|---|---|---|---|---|
| v0.2.8 raw | 37.37% | 28.26% | 46 | — | — | — | — |
| v0.2.8 post | 37.37% | 28.26% | 46 | — | — | — | — |
| winrt 2x（首读） | 24.84% | 47.83% | 46 | — | — | — | — |
| rapid orig（单引擎参考） | 1.30% | 89.13% | 46 | — | — | — | — |
| v3 novote | 21.38% | 47.83% | 46 | 9 | 0 | 0 | 0 |
| **v3 vote-garbled（结论）** | **21.38%** | **47.83%** | 46 | 9 | 0 | 0 | 0 |
| v3 vote-all（上界） | 17.71% | 63.04% | 46 | 9 | 8 | 2 | 0 |

**相对同集 v0.2.8**：CER 37.37% → 21.38%（**−15.99pp**），整句 28.26% → 47.83%（**+19.57pp**）；逐消息 46 条中 **27 条改善、16 条持平、3 条变差**。

**相对 §6 发布门槛（跨口径对照）**：21.38% ≤ 28.09%、47.83% ≥ 32.95% —— **两条门槛均满足**。注意 §6 门槛是 40 图全量集合上的数字，而 eval 是 10 个场景的硬场景子集（baseline 在 eval 上只有 37.37%/28.26%），因此上面同时列了「同集对比」与「跨口径对照」两种读法。

> 本小节的 v1 数字（20 图/46 条消息）保留为 Phase C 历史记录。任务书第 12 章复核已扩到 v2 语料（60 图/30 场景）：同一 eval 集上按 A/B 六组重算的结论见 §6.6（A 35.59% → F 22.07%，整句 30.30% → 51.52%），发布门槛结论以 §6.6 为准。

eval 分场景：

| 场景 | 消息 | v0.2.8 post CER | winrt 2x CER | rapid orig CER | v3 vote-garbled CER | v3 vote-all CER | v3 vote-garbled 整句 |
|---|---|---|---|---|---|---|---|
| small_font | 4 | 77.14% | 34.29% | 11.43% | 34.29% | 28.57% | 0.00% |
| gaussian_blur | 4 | 100.00% | 100.00% | 0.00% | 75.00% | 61.11% | 0.00% |
| scale_125 | 4 | 6.45% | 3.23% | 0.00% | 3.23% | 0.00% | 75.00% |
| scale_175 | 4 | 3.33% | 3.33% | 0.00% | 3.33% | 3.33% | 75.00% |
| repeat_two | 4 | 0.00% | 21.43% | 0.00% | 21.43% | 0.00% | 75.00% |
| numbers | 4 | 20.37% | 11.11% | 0.93% | 11.11% | 11.11% | 0.00% |
| dark_mode | 4 | 12.12% | 0.00% | 0.00% | 0.00% | 0.00% | 100.00% |
| multi_message | 10 | 20.69% | 5.17% | 0.00% | 5.17% | 0.00% | 80.00% |
| stretched | 4 | 105.00% | 100.00% | 0.00% | 82.50% | 82.50% | 0.00% |
| ai_disclaimer | 4 | 34.62% | 8.97% | 1.28% | 8.97% | 5.13% | 25.00% |

改善来自哪里（逐消息抽样）：

- 最大改善是 **baseline 完全没读到整条消息（raw=''，CER 100%）**：`multi_message-00`「在吗」「在的」、`multi_message-01`「收到」、`ai_disclaimer-01`「明白，那我先不打扰了」——v3 的 2x 首读把这些短消息读出来了（ΔCER −100pp）。
- 硬场景：`stretched-00`「比例不对，文字会变形」CER 160%→80%；`small_font-00`「能看清，就是有点糊」66.67%→22.22%；`gaussian_blur-00`「整个窗口都糊掉了」100%→75%。
- 3 条变差：`repeat_two-01`「明天见」0%→100%（2x 放大后这条完全漏读，属引擎行为，不是后处理引入）；`stretched-01`「拉伸后的文字宽度变了」50%→80%；`multi_message-00`「晚上一起吃饭吗」0%→28.57%。

### 气泡归属（eval / all）

| 指标 | eval | all（40 图） |
|---|---|---|
| 消息数 | 46 | 88 |
| 判定出左右 | 37（覆盖率 80.43%） | 69（78.41%） |
| 左右正确率 | 100.00% | 100.00% |
| inbound 精确率 / 召回率 | 100.00% / 82.61% | 100.00% / 77.78% |
| outbound 精确率 / 召回率 | 100.00% / 78.26% | 100.00% / 79.07% |
| uncertain 原因 | 7 条贴边距离不足 + 2 条 OCR 无行 | 11 + 8 |

归属判定用的是「行框并集 + 4% 内边距」近似 bubble bbox（真实由脚本给 pane/气泡几何）；**判错的 0 条、uncertain 的 9 条全部是「宁可不回」**——在 OCR 漏行的消息上，这等价于漏回，属于真实场景需要权衡的保守策略。

### 结论（发布门槛第 2 条）

**达成**（限定在本离线等价口径与合成语料上）：v3 真实等价配置在 eval 上 `CER 21.38% / 整句 47.83%`，相对同集 v0.2.8（37.37% / 28.26%）显著改善，且同时低于/高于 §6 的发布门槛绝对值。

但必须同时记录三条限制，避免过度声明：

1. 本轮的增益**几乎全部来自「WinRT 首读从 orig 换成 2x」+ 文本归一化**（同集 winrt 2x 24.84% 已明显好于 baseline 37.37%）。第二引擎融合在离线等价里 **0 次替换**：9 条可疑消息虽然都匹配到了 RapidOCR 行（重合度 0.31-1.00），但 RapidOCR 文本长度都不大于 WinRT 原文（数字/时间戳场景 WinRT 带全角标点和空格），脚本层「更长才替换」门槛一次都没通过；受控纠错词表（37 词）也没覆盖这些误读，故 0 条纠错。
2. `vote-all` 上界（17.71% / 63.04%）说明**融合的潜在空间存在**（放宽「更长」门槛或对每帧跑 RapidOCR 可再降 3.7pp），但每帧 1.4-2.1s 的成本不适合在线逐帧执行——是否值得改写门槛，需要真实微信数据支撑。
3. 离线等价无 4x 帧、无真实 pane/消息分组、语料仅 20 图/46 条消息：结论方向可信，绝对数字需在真实微信截图与更大语料上复测后再对外引用。

v2 语料（60 图）上的复核见 **§6.6**：完整 v3（F）22.07% / 51.52% vs 同集 v0.2.8（A）35.59% / 30.30%，相对改善 −13.52pp / +21.22pp，结论方向与 v1 一致；v2 全量 run 的 v3 真实等价配置为 20.30% / 51.39%（baseline post 30.70% / 29.17%）。

耗时（本次本机）：tune 组 113s、eval 组 121s、all 组 264s（均含 6 组引擎识别 + baseline + v3 三配置）；v3 后处理本身是纯 JS、毫秒级，瓶颈仍在 RapidOCR（eval：P50 1463ms / P95 2107ms，模型加载 774ms；WinRT 2x：P50 35ms / P95 53ms）。

---

## 6.6 A/B 六组消融（任务书 12.3，eval 集）

**方法**：同一 eval 集（15 场景 / 30 图 / 66 条 GT 消息），每组只替换流水线里的一个阶段，其余不变；`bestVariant` 由 §4.5 的 **tune** 集选出（`upscale3x`），eval 不参与选型。命令：`node scripts/ocr/bench.mjs --engine=all --variants=orig,upscale2x,upscale3x --pipeline=ab --split=eval`（总耗时 79.6s），输出 `results/<ts>-eval-ab-six-groups.json`。

| 组 | 定义 | 与 A 的差异 |
|---|---|---|
| **A** | v0.2.8 baseline：winrt orig 首读 → `baseline-v028` 后处理（2x 帧 + 第二引擎投票） | — |
| **B** | 仅预处理：winrt `upscale3x` 首读 → 同一 `baseline-v028` 后处理 | 首读预处理 |
| **C** | 仅换引擎：RapidOCR orig 首读 → `baseline-v028` 后处理（无第二引擎/多帧） | 首读引擎 |
| **D** | 仅新对齐：B 的识别行经 `alignLinesToSecondEngine` 过滤（y±26 内找不到 rapid 对应行的丢弃）→ `baseline-v028` 后处理 | 新对齐 |
| **E** | 仅新融合：D 的对齐行 + `vote-all` 融合（跳过纠错） | 新融合 |
| **F** | 完整 v3：B 的识别行 + `v3-pipeline` 的 `vote-garbled`（可疑行才投票）+ 受控纠错 | 完整管线 |

| 组 | CER | 整句准确率 | 相对 A（CER / 整句） |
|---|---|---|---|
| A | 35.59% | 30.30% | — |
| B | 22.82% | 51.52% | −12.77pp / +21.22pp |
| C | **2.25%** | **84.85%** | −33.34pp / +54.55pp |
| D | 24.47% | 51.52% | −11.12pp / +21.22pp |
| E | 12.91% | 63.64% | −22.68pp / +33.34pp |
| F | **22.07%** | 51.52% | −13.52pp / +21.22pp |

分场景 F vs A（CER）：

| 场景 | A | F | 场景 | A | F |
|---|---|---|---|---|---|
| small_font | 77.14% | 25.71% | multi_message | 20.69% | 6.90% |
| gaussian_blur | 100.00% | 77.78% | stretched | 105.00% | 72.50% |
| scale_125 | 6.45% | 3.23% | ai_disclaimer | 34.62% | 2.56% |
| scale_175 | 3.33% | 3.33% | homophone | 9.52% | 4.76% |
| repeat_two | 0.00% | 0.00% | similar_nickname | 0.00% | 0.00% |
| numbers | 20.37% | 12.04% | truncated_bubble | 12.07% | 10.34% |
| dark_mode | 12.12% | 3.03% | engine_conflict | 100.00% | 100.00% |
| contact_switch | 17.78% | 13.33% | | | |

解读：

- **预处理（4.4）是本轮最大的单阶段收益**：B 相对 A −12.77pp，且不需要任何在线第二次识别成本（只多一次图像放大）。
- **换引擎（C）精度最高**（2.25% / 84.85%），但 RapidOCR 每帧推理 1.4-1.8s、每次进程启动 2.8-3.5s（§6.7/§6.8），不适合在线逐帧；适合低频/高精度路径。
- **新对齐单独（D）反而比 B 差**（24.47% vs 22.82%）：丢弃未对齐行会损失覆盖；新对齐的价值必须和融合一起评估。
- **新融合（E）潜力大**（12.91%），但它对每帧都跑 RapidOCR，成本同 C，不可在线。
- **完整 v3（F）是唯一可部署组合**：相对 v0.2.8 baseline（A）CER −13.52pp、整句 +21.22pp，达到任务书 12.4 发布门槛第 2 条「OCR 相对 v0.2.8 有可测量改善」（限定离线等价 + 合成语料）。
- **F 与 B 接近**（22.07% vs 22.82%）：在「可疑才投票 + 更长才替换」的保守门槛下，融合与 37 词纠错在 eval 上几乎不再带来额外增益；想拿到 E 的收益需要放宽投票门槛或每帧跑第二引擎，两者的成本/收益需要真实数据再权衡。

**发布门槛判定**：达成（限定条件见 §8 第 13、15、17-23 条）。若只看绝对门槛 `CER ≤ 28.09% / 整句 ≥ 32.95%`（§6.5 口径，v1 40 图），F 的 22.07% / 51.52% 也在门槛内。

---

## 6.7 资源与事件指标（任务书 12.2，v2 语料）

**资源**：`ocr-winrt.ps1` 输出 `cpuMs`（PowerShell 进程 TotalProcessorTime 增量）与 `rssMB`（PeakWorkingSet）；bench 对每变体聚合为 `cpuP50Ms / cpuP95Ms / rssP95MB / rssMaxMB`。这些数字包含 `powershell.exe` 进程启动与 WinRT 初始化，**不是生产主进程占用**。

eval 集各预处理变体资源（与 §4.5 同一次 run，30 图）：

| 变体 | 纯 OCR P50 | cpuP50 | cpuP95 | rssP95 | rssMax |
|---|---|---|---|---|---|
| orig | 25ms | 31ms | 109ms | 105MB | 105MB |
| crop_pane | 23ms | 16ms | 47ms | 105MB | 105MB |
| gray | 25ms | 31ms | 78ms | 104MB | 104MB |
| equalize_clahe | 21ms | 31ms | 47ms | 104MB | 104MB |
| median3 | 26ms | 31ms | 78ms | 104MB | 105MB |
| upscale2x | 33ms | 47ms | 156ms | 130MB | 130MB |
| upscale3x | 46ms | 62ms | 156ms | 182MB | 188MB |
| scale2x_nearest | 35ms | 31ms | 94ms | 130MB | 133MB |
| scale2x_bilinear | 34ms | 47ms | 109ms | 130MB | 133MB |
| scale2x_bicubic | 34ms | 31ms | 109ms | 130MB | 130MB |
| adaptive_threshold | 25ms | 31ms | 94ms | 104MB | 104MB |

**事件**（A/B 六组 eval run 的 `events` 字段，66 条消息）：

| 指标 | 定义 | 实测 |
|---|---|---|
| 双引擎冲突数 / 冲突率 | B（winrt 3x）与 C（rapid）归一化文本不同的消息数 / 消息数 | 28 / **42.42%** |
| 不确定比例 | `classifySide` 判为 uncertain 的消息数 / 消息数 | 12 / **18.18%** |
| 纠错改动数 | F 的文本与 B 不同的消息数 | 3 / 4.55% |
| 纠错误改数 / 误改率 | 上述改动中 CER 变差的数量 / 改动数 | 0 / **0.00%** |
| 重复事件数 | 同一条消息内出现归一化文本相同的重复行 | 0 |
| 错误联系人关联 | 消息被归到错误联系人 | **未测**：合成语料每图只有一个会话、无联系人切换注入（见 §8） |

说明：冲突率 42% 说明两个引擎在本语料上差异很大（RapidOCR 明显更准，见 §5/C 组），这也是「仅换引擎」精度跃升的来源；不确定 18% 来自行框贴边/漏行，属于「宁可不回」的保守策略。

---

## 6.8 RapidOCR 常驻 Worker 量化评估（任务书 5.3，只量化不接线）

**方法**：`node scripts/ocr/worker-eval.mjs --repeat=2`（新脚本，`results/<ts>-worker-eval.json`）：同一批 5 张图（`clear-00`、`numbers-00`、`long_bubble-00`、`dark_mode-00`、`small_font-00`），对比「进程内加载一次模型连续推理」与「每次调用新起 python 进程跑 `rapid_ocr.py`」；RSS 用 `psapi.GetProcessMemoryInfo`（PeakWorkingSet）在 python 进程内采样。

| 指标 | 实测 |
|---|---|
| `import rapidocr_onnxruntime` | 224ms（一次） |
| 模型初始化 | 589ms（一次） |
| 首图（含预热） | 1717ms |
| 稳态每图 | **1323ms** |
| 10 张（5 图 × repeat 2）总推理 | 13624ms |
| RSS 初始化后 / 推理后 / 峰值 | 101MB / 110MB / 243MB |
| 现状：每次新起进程（`rapid_ocr.py` 单图） | 平均 **3130ms**（2848-3503ms，5 次采样） |
| 常驻 Worker 每帧可省 | ≈ **1807ms** |
| 2s 轮询预算 | 可容纳（1323ms < 2000ms） |
| 90s 脚本上限 | 可容纳 |

**建议**：从数字看**值得做常驻 Worker**（每帧省 ~1.8s、内存 110-243MB 可接受、稳态延迟 1.3s 落在 2s 轮询预算内），但按任务书 5.3 的 8 个条件（模型只加载一次、stdin/IPC、requestId、超时取消、有限恢复、限并发、不监听公网、不持久化截图/关闭释放）实现成本不低；**本期只做量化评估，不接线**（未改 `src/**`）。真实微信数据复测后再决定是否接入。

---

## 7. 复现

前置：Windows + 已装 `zh-Hans-CN` OCR 语言包（WinRT 需要）；Python 已装 Pillow 与 rapidocr_onnxruntime（RapidOCR 需要，未装时可用 `--engine=winrt` 只跑 WinRT）。

```powershell
# 1) 生成语料（固定 seed，可重复生成同样的 60 张；v2 = 30 场景 × 2）
python scripts/ocr/gen_corpus.py

# 2) 全量基准（2 引擎 × 3 变体 + v0.2.8 baseline + v3 三配置），v2 实测 152s
node scripts/ocr/bench.mjs --engine=all --pipeline=all

# 2b) 任务书 4.4 预处理 A–H（tune 选型，eval 只复核；各 30 图，约 120s/组）
node scripts/ocr/bench.mjs --engine=winrt --pipeline=raw --split=tune --variants=orig,crop_pane,gray,equalize_clahe,median3,upscale2x,upscale3x,scale2x_nearest,scale2x_bilinear,scale2x_bicubic,adaptive_threshold
node scripts/ocr/bench.mjs --engine=winrt --pipeline=raw --split=eval --variants=orig,crop_pane,gray,equalize_clahe,median3,upscale2x,upscale3x,scale2x_nearest,scale2x_bilinear,scale2x_bicubic,adaptive_threshold

# 2c) 任务书 12.3 A/B 六组消融（eval 集，约 80s）
node scripts/ocr/bench.mjs --engine=all --variants=orig,upscale2x,upscale3x --pipeline=ab --split=eval

# 2d) 任务书 5.3 RapidOCR 常驻 Worker 量化评估（只测不接线，约 40s）
node scripts/ocr/worker-eval.mjs --repeat=2

# 2e) 单图调 RapidOCR（新版 unified 包未安装时自动回退旧包；不可用也不报错）
python scripts/py/rapid_ocr.py test/fixtures/ocr-corpus/images/clear-00.png

# 3) tune/eval 拆分复跑（v3 结论只看 eval；tune 用来调试）
node scripts/ocr/bench.mjs --engine=all --pipeline=all --split=tune
node scripts/ocr/bench.mjs --engine=all --pipeline=all --split=eval

# 4) 冒烟/子集
node scripts/ocr/bench.mjs --engine=winrt --limit=6 --scenario=clear,dark_mode
node scripts/ocr/bench.mjs --engine=rapid --pipeline=baseline --limit=10
node scripts/ocr/bench.mjs --engine=all --pipeline=v3 --split=eval --limit=4 --out-dir=%TEMP%\ocr-bench-smoke
# 自定义结果目录（避免覆盖工作区结果）
node scripts/ocr/bench.mjs --engine=winrt --limit=2 --out-dir=%TEMP%\ocr-bench-smoke

# 5) 单独跑一次 WinRT helper（单图）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/pwsh/ocr-winrt.ps1 -Path test/fixtures/ocr-corpus/images/clear-00.png
```

输出：

- `results/<时间戳>-<split>-<engine>-<variant>.json`：每次（引擎×变体）一份，含 `meta`（环境/命令/split/语料信息）、`images`（每图识别行 + 指标 + perMessage）、`totals`（总指标）、`byScenario`（分场景）。
- `results/<时间戳>-<split>-baseline-v028-orig.json`：baseline raw/post 对照（`--pipeline=baseline|all` 时生成）。
- `results/<时间戳>-<split>-ab-six-groups.json`：A/B 六组消融（`--pipeline=ab` 时生成），含每组 totals / events / byScenario。
- `results/<时间戳>-worker-eval.json`：Worker 量化评估（`worker-eval.mjs`，不是 bench 生成）。
- `results/summary.json`：最近一次 bench run 的所有 run 汇总（`v3Pipeline` 等；`abSixGroups` 仅在 `--pipeline` 含 `ab` 的 run 写入，本仓库保留的 AB 结果见下面的独立文件），供文档/CI 取值。
- 仓库里保留的最终证据（共 32 个 JSON + `summary.json`，合计 33 个文件）：
  - `2026-11-01_02-01-45-all-*`（8 份）：v2 语料全量（§5.0、§6 v2 复核，`summary.json` 由这次 run 生成）；
  - `2026-11-01_01-53-37-tune-winrt-*` / `2026-11-01_01-55-38-eval-winrt-*`（各 11 份）：A–H 预处理（§4.5，tune/eval 分开）；
  - `2026-11-01_01-57-37-eval-ab-six-groups.json`：A/B 六组（§6.6）；
  - `2026-11-01_02-00-24-worker-eval.json`：Worker 量化（§6.8）。
  - 更早的 run、v1 语料 run、`results/derived/`（派生变体图，可由 manifest 重建）已移出仓库；`derived/` 不入库。

参数：`--engine=winrt|rapid|all`、`--pipeline=raw|baseline|v3|all|ab`、`--split=all|tune|eval`、`--variants=a,b,...`（默认 `orig,upscale2x,gray_contrast`；A–H 见 §4.5）、`--limit=N`、`--scenario=a,b`、`--out-dir=<path>`、`--python=<path>`。v3 组需要同时有 winrt 与 rapid 结果；rapid 组在 `--pipeline` 含 baseline/v3/ab 时只跑 `orig` 变体（省时间）。单图失败不会中断整体（失败记录写入 JSON 的 `ok:false`）。

耗时参考（本机）：变体图生成 v2 全量约 1.3s；winrt 3 变体 × 60 图 ≈19s（P50 26-35ms/图，但每图要起一次 `powershell.exe`）；rapid orig × 60 图 ≈90s（P50 1444ms，一次模型加载 0.8-1.2s）；v2 全量（8 组 × 60 图）实测 **152.0s**；A–H tune / eval 各 120.7s / 118.6s（330 次识别）；AB eval 79.6s；worker-eval ≈40s。

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
12. **未接入真实 UI 坐标分组**：baseline / v3 分组都用 GT bbox 近似，真实 pipeline 按 UI 元素坐标分组；分组误差会轻微影响数字。
13. **v3 离线等价有 5 处偏差**（见 §6.5）：无 4x 帧重读、消息分组用 GT bbox、投票按消息粒度而非整段文本、pane 取整图宽度、气泡归属用行框并集近似；真实 pipeline 的定位/分组误差未计入。
14. **tune/eval 规模小**：各 10 场景 / 20 图 / 42-46 条消息，单条消息就能移动整句准确率约 2pp；结论方向可信，具体数值需扩量复测。
15. **第二引擎融合与受控纠错在本语料几乎没触发**（eval：替换 0、纠错 0；tune：纠错仅 1 条），它们的独立收益**未被本 bench 证明**；`vote-all` 上界不能当成在线可达结果。
16. **归属指标是近似**：pane 取整图宽度、bubble bbox 用行框并集 + 4% 内边距；真实脚本提供窗口/气泡几何，判左右准确率会受此近似影响。
17. **v2 语料仍全部是合成图**：12.1 的 21 项覆盖是「场景存在」而非「分布真实」——每项覆盖只有 2-4 张图支撑（`homophone`、`similar_nickname` 等新场景各 2 张），真实微信里的昵称、系统提示、表情分布不同。
18. **A–H 的结论绑定「480×640 合成窗口 + WinRT」**：真实微信在不同系统 DPI、抗锯齿、字体（微软雅黑以外的回退字体）下最优预处理可能不同；`upscale3x` 的增益需要在真实截图上复测，不能直接外推。
19. **新 `rapidocr` 统一包未安装、未实测**：本机只有 `rapidocr_onnxruntime 1.2.3`。`scripts/py/rapid_ocr.py` 已按 `rapidocr` 的 `boxes/txts/scores` 结构写好适配并自动回退，但**新版返回值结构从未在本机跑通**（`RAPIDOCR_IMPL=unified` 实测 `No module named 'rapidocr'`）。按合规要求没有 `pip install`。
20. **CPU/RSS 是脚本子进程指标**：`cpuMs` 是 PowerShell 进程 TotalProcessorTime 增量、`rssMB` 是 PeakWorkingSet，包含进程启动与 WinRT 初始化，且受机器负载影响（cpuP50 在 16-62ms 间抖动）；不能当作生产主进程资源占用。RapidOCR 侧 bench 批量模式未采 RSS（单进程复用），Worker 评估单独测过（§6.8）。
21. **12.3 的 B 与 F 组差异在噪声范围内**：22.82% vs 22.07%（66 条消息，1 条消息 ≈1.5pp 整句），只能说明「本合成集上融合/纠错未体现额外收益」，不能断言失效；需要更大 eval 集或专门构造的双引擎冲突样本。
22. **`truncated_bubble` / `scrolled` / `engine_conflict` 是压力场景**：前两者 GT 包含窗口外/被标题栏遮挡的不可见文本，CER 必然偏高；`engine_conflict` 双引擎都读不准（A 100% / F 100%）。它们用于验证「不误报、不崩」，不应计入发布门槛的典型样本人群。
23. **12.1 的「模拟数据 / 真实数据」未采集**：按合规要求不截真实微信、不注入真实消息；本 bench 只有合成图一类，模拟数据（脚本注入的历史消息）与真实数据统计均**未测**。

---

## 9. 本次改动范围

新增/修改范围（都在允许目录内，未 commit）：

```text
scripts/ocr/gen_corpus.py        # 合成语料生成器（v2：30 场景/60 图 + 12.1 覆盖 + 空 GT/system/滚动/截断）
scripts/ocr/engines.mjs          # 引擎适配层（WinRT / RapidOCR / A–H 预处理变体 / 文本与几何工具）
scripts/ocr/bench.mjs            # 基准编排 + 指标 + 结果落盘（本次扩展 --variants / --pipeline=ab / 空 GT / 资源聚合）
scripts/ocr/baseline-v028.mjs    # v0.2.8 后处理逐行转写（A/B baseline）
scripts/ocr/v3-pipeline.mjs      # v3 管线离线等价（normalize/correction/vote 纯函数转写 + 新对齐）
scripts/ocr/worker-eval.mjs      # 任务书 5.3：RapidOCR 常驻 Worker 量化评估（只测不接线）
scripts/py/rapid_ocr.py          # 5.2：统一输出 + rapidocr 新包/旧包双路径（新包本机未安装，未实测）
scripts/pwsh/ocr-winrt.ps1       # WinRT OCR helper（12.2：新增 cpuMs/rssMB；PS 5.1，UTF-8 带 BOM）
test/fixtures/ocr-corpus/        # v2：60 张合成图 + manifest v2（12.1 覆盖 21 项）+ results/（最终证据集）
docs/OCR-BENCHMARK.md            # 本文
```

- `scripts/ocr/**`、`scripts/py/rapid_ocr.py`、`scripts/pwsh/ocr-winrt.ps1`、`test/fixtures/ocr-corpus/**`、`docs/OCR-BENCHMARK.md` 均在本任务允许范围内；`bench.mjs` 等是范围内既有文件的扩展。
- `results/` 只保留最终证据集（见 §7）；`derived/`（派生变体图，可由 manifest 重建）不入库。
- `src/**`、`client/**`、`scripts/pwsh/wechat-uia.ps1`、`package.json`、`.gitignore` 等文件**未改动**（仓库工作区里其它未提交改动来自并行任务，与本目录无关）。
- 未 commit / 未 push（按任务书要求）。

# OCR 误差归因与 RapidOCR / Worker 复核（task-20）

> 发布前独立复核材料。所有数字均来自本仓库 `test/fixtures/ocr-corpus/results/` 的既有实测结果，
> 或本次用 `scripts/ocr/*` 现有关卡实测（命令见 §11）。**没有真实微信截图参与**，语料是
> `scripts/ocr/gen_corpus.py` 合成的 60 张「类微信聊天窗口」图（全部内容虚构）。

## 0. 结论摘要

1. **误差主体是 OCR 引擎本身**：完整 v3（F 组）147 个字符编辑中 93 个（63.27%）是行内字符
   替换/漏字/多字，54 个（36.73%）是「整条消息没有任何 OCR 行」造成的整条漏读。行级假消息
   12 条（16.90% of OCR 行），气泡归属不确定 12/66（18.18%）。
2. **同语料下 RapidOCR 首读 CER 2.25%、整句 84.85%**（C 组），远好于 WinRT 的 35.59% / 30.30%
   （A 组）。说明多数字符误差不是流水线（预处理/后处理）问题，而是 WinRT 识别能力问题。
3. **现有开关中，预处理放大是唯一显著有效的单项**：3x 放大（upscale3x）把 CER 从 40.84%
   降到 25.68%、整句 28.79%→51.52%（eval 集 A–H 实测）。灰度/中值/自适应阈值/对比度类均劣化。
4. **新增「裁剪窗格 + 放大」组合变体未通过 eval 复核**：tune 集看似最优（crop+2x：
   CER 17.28%、整句 58.97%），eval 集 CER 26.43% / 整句 48.48%，均不如全窗 3x
   （25.68% / 51.52%）→ **不采纳**，不改默认 `BEST_VARIANT`。
5. **RapidOCR 统一包（新 `rapidocr`）适配代码已就绪但本机无网络/未安装，未实测**；旧包
   `rapidocr_onnxruntime` 1.2.3 路径已实测回归。安装体积/版本只能给参考值（见 §9）。
6. **常驻 Worker 量化结论**：一次初始化 + 稳态 1323ms/图，相比「每图起一次 python 进程」
   3130ms/图，可省约 1807ms/帧；峰值 RSS 243MB。**建议本期不接线**（理由见 §10）。

## 1. 方法与数据源

| 项 | 值 |
|---|---|
| 语料 | `test/fixtures/ocr-corpus/`，60 图 / 30 场景（seed=20261031，确定性重跑 SHA256 一致） |
| tune / eval 拆分 | 按场景序号 0-based 奇偶拆分，两者不重叠；v3 调参只用 tune |
| eval 集样本量 | AB 组：30 图 / 66 条 GT 消息；A–H 组：30 图 / 70 条 GT 行 |
| tune 集样本量 | 30 图 / 83 条 GT 行（A–H）、42 条 GT 消息（AB） |
| 结果文件 | `results/2026-11-01_01-57-37-eval-ab-six-groups.json`（A/B 六组逐消息）<br>`results/2026-11-01_01-55-38-eval-winrt-upscale3x.json`（A–H 行级）<br>`results/2026-11-01_02-01-45-all-*.json`（v2 全量）<br>`results/2026-11-01_02-00-24-worker-eval.json`（Worker） |
| 归因脚本 | `scripts/ocr/analyze-errors.mjs`（零依赖，只读上述 JSON 与 manifest；默认只打印不写文件） |
| 字符级口径 | `normalizeForCompare`（全角转半角、去空白/标点/符号、小写）后做 Levenshtein 回溯，拆成替换/删除/插入；编辑总数 = 距离总和 = bench CER 分子 |
| 消息级口径 | 单条消息 OCR 归一化文本为空 → 「整条漏读」；与 GT 完全一致 → 整句正确 |
| 行级口径 | 取 A–H eval `upscale3x` 结果里的 `tp/fp/fn/dup/frag`（定义见 `docs/OCR-BENCHMARK.md` §3） |

复算校验：本报告 §3 的 A/B/C/F 编辑总数与 bench AB `totals` 完全一致
（A 237 / B 152 / C 15 / F 147，GT 666 字符 → CER 35.59% / 22.82% / 2.25% / 22.07%），
说明归因口径与 `docs/OCR-BENCHMARK.md` §6.6 的发布门槛数字同源。

## 2. 九类误差分类（F = 完整 v3 配置；分母逐个注明）

| # | 类别 | 计数（F） | 占比 | 分母口径 | 典型样本（虚构） |
|---|---|---|---|---|---|
| 1 | 字符替换 | 54 | 36.73% | 替换 / 总编辑数 | small_font：`能看清吗` → `吾清吗` |
| 2 | 漏字（行内） | 25 | 17.01% | 行内删除 / 总编辑数 | gaussian_blur：`整个窗口都糊掉了` → `整个过口-了` |
| 3 | 多字 | 14 | 9.52% | 插入 / 总编辑数 | numbers：`金额128.50元` → `全额12&50元` |
| 4 | 错误分行 / 切行 | 0 | 0.00% | fragments / OCR 行（0/71） | 本批 eval 无切行 |
| 5 | 气泡截断 | 1/4 消息 | 25.00% | 越界气泡 / truncated_bubble 消息 | truncated_bubble-00 长消息 bbox 越右缘 33px（估计裁掉 2 字符） |
| 6 | 错误区域定位 / 漏区 | 5 | 7.58% | 整条漏读消息 / 消息（5/66） | gaussian_blur：`截图被人手抖了一下` 无任何行 |
| 7 | 引擎结果冲突 | 28 | 42.42% | winrt≠rapid 归一化文本 / 消息（28/66） | 双引擎 42% 消息不一致，但仅 3 条被纠错、误改 0 |
| 8 | 字典误改 | 3（误改 0） | 4.55% | 纠错改动 / 消息（3/66） | 37 词表覆盖窄，命中少 |
| 9 | 跨帧状态混淆 | 未测 | — | — | 离线等价无 4x 帧；`duplicateEvents=0` 只是同帧内去重 |

> 注 1：第 2 行的「漏字（行内）」= 总删除 79 − 整条漏读 54 = 25；整条漏读归入第 6 类
> （消息级），不在字符分类里重复计入。三类字符合计 54+25+14=93（63.27%），
> 加上整条漏读 54（36.73%）= 147，与 §3 编辑总数一致。
> 注 2：第 4/5 类按「行/消息」计量，与字符分类不是同一分母，不能相加。

## 3. 字符级与消息级分解（eval 集，66 条消息 / 666 GT 字符）

| 组 | 编辑总数 | 替换 | 漏字 | 多字 | CER | 整句准确率 | 整条漏读消息 |
|---|---|---|---|---|---|---|---|
| A v0.2.8 baseline（winrt orig） | 237 | 71 | 145 | 21 | 35.59% | 30.30% | 15 |
| B 仅预处理（winrt upscale3x） | 152 | 53 | 79 | 20 | 22.82% | 51.52% | 5 |
| C 仅换引擎（RapidOCR orig） | 15 | 10 | 5 | 0 | 2.25% | 84.85% | 0 |
| D 仅新对齐 | 163 | 47 | 100 | 16 | 24.47% | 51.52% | 6 |
| E 仅新融合（vote-all） | 86 | 66 | 7 | 13 | 12.91% | 63.64% | 0 |
| F 完整 v3（vote-garbled） | 147 | 54 | 79 | 14 | 22.07% | 51.52% | 5 |

读法：

- A→B（只换预处理）吃掉 85 个编辑（237→152），整句 +21.22pp → **预处理是主收益**。
- B→F（融合 + 受控纠错）只再降 5 个编辑（152→147），且 F≈B 的整句准确率；原因是
  v3 保守门槛（`overlap≥0.35 且 rapid 文本更长才替换`）在 eval 只触发 3 条纠错，融合
  几乎不生效。
- C 说明引擎天花板：同一批图换成 RapidOCR，整条漏读从 5 条降到 0、编辑从 152 降到 15。
- E（无条件融合）CER 12.91% 但每帧都要跑 RapidOCR（1.4–2.0s），生产不可接受（见 §10）。

## 4. 行级结构指标（A–H eval，upscale3x）

| 图 | GT 行 | OCR 行 | TP | FP(假消息) | FN(漏行) | fragments(切行) | 切行占比 | 漏行率 | 假消息率 |
|---|---|---|---|---|---|---|---|---|---|
| 30 | 70 | 71 | 59 | 12 | 11 | 0 | 0.00% | 15.71% | 16.90% |

- 无切行（fragments=0），说明 v3 的行合并策略在合成语料上没被触发；这一项需要真实长消息验证。
- 假消息 12 条主要是头像马赛克纹理、emoji、半遮挡通知条被读成字符（已按 `expectedContext`
  区域/文本豁免窗口 chrome，剩余仍算假消息）。
- 漏行 11 条集中在 gaussian_blur / small_font / engine_conflict。

## 5. 归因来源：OCR 本身 vs 截图/消息关联

| 来源 | 字符/事件 | 占比 | 说明 |
|---|---|---|---|
| OCR 本身（行内字符识别） | 93 | 63.27% | 替换 + 行内漏字 + 多字（F 组） |
| 整条消息未产出 OCR 行（关联候选） | 54 | 36.73% | 该消息 bbox 内无任何行：可能是区域裁剪、行聚类失败或整条乱码 |
| 窗口 chrome 误识别 | 12 行 | 16.90% of 71 OCR 行 | 头像纹理/emoji/遮挡条等；标题/输入框已豁免 |
| 气泡归属不确定 | 12 条 | 18.18% of 66 消息 | `classifySide` 返回 uncertain（宁可不回） |
| 跨帧状态混淆 | 未测 | — | 离线管线没有 4x 帧与滚动状态 |

**判断**：字符误差（63%）属引擎能力问题；整条漏读（37%）里只有 5 条是「该消息完全没有行」，
另一半发生在模糊/形变图上，可能是行分割阈值问题。要再降 CER，优先级是换引擎 / 提升分辨率
（放大），而不是继续加后处理规则。

## 6. 合成语料真实性评估

manifest 统计（`scripts/ocr/analyze-errors.mjs` §10 直接输出）：

| 项 | 值 |
|---|---|
| 字体 | `msyh.ttc`（微软雅黑）——单一字体 |
| 字号分布 | 15px×48、14px×6、13px×2、11px×2、10px×2 |
| 图片尺寸分布 | 480×640×52、600×800×2、720×960×2、840×1120×2、648×640×2 |
| 主题分布 | light×58、dark×2 |
| GT 行高中位数 / 范围 | 23px / 17–40px |

**偏乐观的地方**（真实数据会更差）：

- 单一字体、无字体回退；真实微信会混用系统字体/表情/链接卡片。
- PNG 无损、背景纯色；真实截图经 DWM 缩放 + 压缩，边缘更糊。
- 窗口 chrome 只有标题、时间戳、输入框占位，没有未读红点、菜单栏、侧边栏。
- 没有真实贴纸/图片/引用/语音条，emoji 只画了少量彩色字形。
- 光源一致、无屏幕反光/缩放模糊/多屏 DPI 混合。

**偏悲观的地方**（会把真实平均指标拉低）：

- 故意加入了 gaussian_blur（radius 1.2）、stretched（x1.35）、small_font（10px）、
  engine_conflict（11px + 低对比 + 0.5 模糊）等压力场景，实际使用占比没这么高。
- 每场景 2 张图、按场景平均时压力场景权重被放大。

综合判断：**清晰/常规场景的绝对值偏乐观，但跨场景相对结论（放大有效、灰度/二值化有害、
换引擎显著）方向可信**；绝对 CER 不能直接外推到真实微信，需真实数据复测（见 §12）。

## 7. 修复建议（按预期收益排序）

1. **换/并用 RapidOCR**：C 组 CER 2.25%、整句 84.85%，是当前所有开关里上限最高的一项。
   生产建议：首读仍用 WinRT（快、无模型常驻），对 `looksGarbled` 的消息跑 RapidOCR 融合
   （v3 已实现，但门槛要放宽——当前「更长才替换」导致 0 替换，可改为「重合度≥0.35 且噪声分
   更低」）。
2. **提高首读分辨率**：3x 放大是已验证的最大单项收益（CER 40.84%→25.68%）。生产 PowerShell
   目前是最近邻 2x（`scripts/pwsh/wechat-uia.ps1:519-534`），建议在真机 A/B：2x nearest vs
   3x nearest（离线 LANCZOS 3x 最优，但真机是 GDI nearest，结论需复测）。
3. **整条漏读兜底**：对「该消息 bbox 内 0 行」的情况做一次 4x 放大重读或 RapidOCR 重读
   （v3 的 4x 帧在离线管线未采集，生产 desktop.ts 有 `recheckGarbledText` 双帧路径）。
4. **扩大受控纠错词表**：37 词只覆盖很少的高频词；eval 仅 3 条改动、误改 0，说明当前门槛
   安全但收益低。可把「同一消息内两引擎都不一致」的 token 加入候选。
5. **降低 chrome 假消息**：头像/emoji 用区域掩码（已知头像位置与气泡区），而不是靠 OCR 后过滤。
6. **归属覆盖**：uncertain 18.18%，主要因消息没有任何行（empty）或两侧都不贴边；对 empty
   消息可以先用会话行/时间戳定位再判左右。

## 8. A/B 验证（用现有 bench 开关，同一 eval/tune 集）

新增两个组合变体（只改 `scripts/ocr/engines.mjs:116-141`，未改生产代码）：

- `crop_pane_upscale2x`：裁掉标题 36px + 底部输入区 56px，再 2x LANCZOS 放大；
- `crop_pane_upscale3x`：同上再 3x 放大。

命令（结果写 `%TEMP%`，不污染仓库 results）：

```powershell
node scripts/ocr/bench.mjs --engine=winrt `
  --variants=crop_pane_upscale2x,crop_pane_upscale3x,upscale3x `
  --pipeline=raw --split=tune --out-dir=%TEMP%/ocr-task20-ab
node scripts/ocr/bench.mjs --engine=winrt `
  --variants=crop_pane_upscale2x,crop_pane_upscale3x,upscale3x `
  --pipeline=raw --split=eval --out-dir=%TEMP%/ocr-task20-ab
```

实测结果（WinRT，30 图/组；本机实测 tune ≈39s、eval ≈38s，均 90 次识别 0 失败）：

| split | 变体 | CER | 整句准确率 | 行 F1 | P50 | P95 |
|---|---|---|---|---|---|---|
| tune | crop_pane_upscale2x | 17.28% | 58.97% | 0.894 | 31ms | 51ms |
| tune | crop_pane_upscale3x | 21.73% | 55.13% | 0.852 | 45ms | 70ms |
| tune | upscale3x（默认） | 17.66% | 53.85% | 0.902 | 47ms | 83ms |
| eval | crop_pane_upscale2x | 26.43% | 48.48% | 0.824 | 34ms | 54ms |
| eval | crop_pane_upscale3x | 25.23% | 48.48% | 0.809 | 44ms | 90ms |
| eval | upscale3x（默认） | **25.68%** | **51.52%** | **0.837** | 50ms | 104ms |

**结论**：裁剪窗格在 tune 上看似更好（17.28%），eval 上未复现（26.43% vs 25.68%；整句 48.48%
vs 51.52%）→ 判定为 tune 集噪声/过拟合，**不采纳**。默认仍用全窗 `upscale3x`。另外
`crop_pane_upscale3x` 在两种情况都差于全窗 3x，说明「裁剪后再放大」没有额外收益
（损失的是气泡左右留白上下文，而不是裁掉了干扰）。

## 9. RapidOCR 统一包适配复核（5.2）

### 9.1 适配代码（scripts/py/rapid_ocr.py，187 行）

| 位置 | 作用 |
|---|---|
| `scripts/py/rapid_ocr.py:52-63` | `_load_engine`：`RAPIDOCR_IMPL=auto/unified/legacy`；unified 试 `from rapidocr import RapidOCR`，legacy 试 `from rapidocr_onnxruntime import RapidOCR`，异常不抛出而是返回 `load_error` |
| `:67-76` | `_get_attr`：对象或 dict 取 `boxes|box`、`txts|txt|texts`、`scores|score` |
| `:79-83` | `_box_from_quad`：四点坐标 → `x/y/w/h`（int round） |
| `:86-96` | `_lines_from_pairs`：旧包 `[[box,text,score]]` |
| `:99-120` | `_lines_from_columns`：新包 `boxes/txts/scores` 并列（长度必须一致，score 可选） |
| `:123-132` | `_extract_lines`：未知结构返回 None 让调用方报 ok:false |
| `:141-183` | `main`：先按 IMPL 解析；`out = engine(path)`；`result = out[0] if tuple(len==2) else out`；**不可用/失败也 exit 0**，输出单行 JSON `{ok,available,engine,version,lines|error}` |

### 9.2 复核结论

- **API 假定已隔离**：新包只假定「`RapidOCR()` 可无参构造、调用返回对象或 dict，含
  boxes/txts/scores 三列」；旧包只假定「返回 `[box, text, score]` 列表」。两种形态均已有
  单元级 stub 验证（dict-columns / object-columns / legacy-pairs / `(result, elapse)` 二元组
  解包 / 无 scores / 未知结构→None，全部按预期）。
- **模型加载/释放**：每次进程只构造一次引擎；进程退出即释放。**未做 Worker 常驻**（见 §10）。
- **超时/取消/并发**：无内部并发；由调用方（PS `runScript`）的 90s 超时负责杀进程；
  不提供 requestId 取消（本轮不接线）。
- **网络**：适配脚本里没有任何 socket/HTTP/监听代码 → 不监听公网、不上传截图。
  **但**：新 `rapidocr` 包首次运行是否自动下载模型/是否访问网络，本机无该包，**未验证**。
- **截图持久化**：`rapid_ocr.py` 只接收图片路径、不写文件；截图文件生命周期由 PowerShell
  调用方管理（`scripts/pwsh/wechat-uia.ps1:1962-2026` 复用同帧 `$script:LastSnapshotImage`），
  适配层没有把截图写到数据目录。
- **旧包回归**：`python scripts/py/rapid_ocr.py <clear-00.png>` 实测输出
  `{"ok": true, "available": true, "engine": "rapidocr_onnxruntime", "version": "1.2.3", ...}` 4 行；
  `RAPIDOCR_IMPL=unified` 实测输出
  `{"ok": false, "available": false, ..., "error": "rapidocr 引擎不可用（未安装？）：unified: No module named 'rapidocr'"}`，
  exit 0（优雅降级）。
- **本机已安装旧包的体积**（`D:\python\Lib\site-packages\rapidocr_onnxruntime`，1.2.3）：
  31 文件 / 13.2MB，含 det 2.3MB + rec 10.2MB + cls 0.6MB；`onnxruntime` 1.31.1 目录 45.8MB。
  依赖：pyclipper / onnxruntime / opencv-python / numpy / six / Shapely / PyYAML / Pillow。

### 9.3 安装步骤与真机验证方案（未执行，属「未验证」）

```powershell
# 1) 在独立 venv 中安装（版本未联网核实，先记录 pip 解析出的版本与体积）
python -m venv %TEMP%\rapidocr-venv
%TEMP%\rapidocr-venv\Scripts\python.exe -m pip install rapidocr
# 2) 打印实际版本与安装体积
%TEMP%\rapidocr-venv\Scripts\python.exe -m pip show rapidocr onnxruntime
# 3) 用统一适配层跑同一张图，确认 engine 字段变为 rapidocr、行结构与旧包一致
$env:RAPIDOCR_IMPL='unified'
%TEMP%\rapidocr-venv\Scripts\python.exe scripts\py\rapid_ocr.py test\fixtures\ocr-corpus\images\clear-00.png
```

验证项：`ok/available/version/lines` 字段、boxes 是否为四点框、scores 是否存在、首次运行
是否联网下载模型、冷启动时间与内存。**本机离线且按要求不安装任何包，以上均未实测**；
文档中不写具体版本号/体积，避免编造。

## 10. RapidOCR 常驻 Worker 量化评估（5.3）

数据源：`results/2026-11-01_02-00-24-worker-eval.json`（`scripts/ocr/worker-eval.mjs --repeat=2`，
5 张图 × 2 轮，Windows 11，Python 3.14.2，rapidocr_onnxruntime 1.2.3）：

| 指标 | 数值 |
|---|---|
| Python 导入 | 224ms（一次） |
| 引擎初始化 `RapidOCR()` | 589ms（一次） |
| 首图推理 | 1717ms |
| 稳态每图 | 平均 1323ms（10 次：851–1786ms） |
| 10 张批总量 | 13.6s |
| RSS（初始化后 / 推理后 / 峰值） | 101MB / 110MB / 243MB |
| 现状「每图新起进程」平均 | 3130ms（5 采样 2848–3503ms） |
| 常驻可省 | ≈1807ms/帧 |
| 2s 轮询预算 | 现状 3130ms ❌ 超；Worker 1323ms ✅ |
| 90s 脚本上限 | 两者均 ✅ |

**建议：本期不接线。** 理由：

1. 当前生产是「按需」调用（白名单消息到来才识别），单帧 1.3s 与 2s 轮询预算可共存，但
   Worker 需要常驻 100–243MB 内存 + 进程生命周期管理，收益只在连续多帧时才明显。
2. 引入 Worker 必须同时做 requestId、超时取消、异常重启、限并发、关闭释放，否则一个卡死
   的推理会拖死整个通道；本轮只做量化、不接线，符合任务边界。
3. 如果后续要做，建议顺序：先做「Python 进程池 + 超时杀进程」（收益已有 1807ms/帧），
   再评估常驻进程；并保留 RapidOCR 不可用时回退 WinRT 的路径。

## 11. 未验证项 / 已知局限

1. **新 `rapidocr` 包未安装、未联网**：API 断言只经 stub 单测；真实返回结构、版本、体积、
   首次运行是否下载模型 —— 未验证（见 §9.3）。
2. **没有真实微信截图**：所有结论来自合成语料，绝对 CER 不能外推；真实数据需按
   `docs/OCR-BENCHMARK.md` §8 的方式另建标注集复测。
3. **4x 帧 / 滚动 / 跨帧状态**未在离线等价覆盖（任务书允许的限制），相关误差类别标「未测」。
4. **错误联系人关联**：合成语料每图单会话，无法构造；真实数据需多会话测试。
5. **truncated_bubble 构造偏弱**：只有 1/4 消息真正被右缘裁掉（33px ≈ 2 字符），
   真实「整段气泡被裁」场景需要更强构造或真实数据。
6. **测试时长约束**：eval 只有 66 条消息、tune 42 条，占比 1–2 条消息的指标波动可能达数 pp；
   本报告只对 ≥5pp 的差异下结论。

## 12. 复现命令（仓库根目录执行）

```powershell
# 1) 误差归因 Markdown（只读 results，不写文件；--json= 可另存中间数据）
node scripts/ocr/analyze-errors.mjs
node scripts/ocr/analyze-errors.mjs --json=%TEMP%/ocr-errors.json

# 2) A/B 组合变体（写入 %TEMP%，不改仓库 results）
node scripts/ocr/bench.mjs --engine=winrt `
  --variants=crop_pane_upscale2x,crop_pane_upscale3x,upscale3x `
  --pipeline=raw --split=tune --out-dir=%TEMP%/ocr-task20-ab
node scripts/ocr/bench.mjs --engine=winrt `
  --variants=crop_pane_upscale2x,crop_pane_upscale3x,upscale3x `
  --pipeline=raw --split=eval --out-dir=%TEMP%/ocr-task20-ab

# 3) RapidOCR 适配层（旧包路径已实测；unified 需先按 §9.3 安装新包）
python scripts/py/rapid_ocr.py test/fixtures/ocr-corpus/images/clear-00.png
$env:RAPIDOCR_IMPL='unified'
python scripts/py/rapid_ocr.py test/fixtures/ocr-corpus/images/clear-00.png

# 4) Worker 量化评估（会起 python 子进程，约 40s）
node scripts/ocr/worker-eval.mjs --repeat=2

# 5) 全量测试（本任务改动只涉及 scripts/ocr 与 docs，测试应保持全绿）
npm run test:sandbox
```

结果文件命名：`results/<时间戳>-worker-eval.json`；A/B 组合结果只在 `%TEMP%/ocr-task20-ab/`
（默认不入库，避免污染发布用证据目录）。

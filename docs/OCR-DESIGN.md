# OCR 架构设计（v3.0.0）

> 目标：把 v0.2.8 内联在 `src/channels/pc/desktop.ts`（含 `// @ts-nocheck`）里的视觉识别逻辑，
> 重构成**无 IO、可单测、可 benchmark、可解释**的模块；生产链路仍然零新增运行时依赖。
> 本文只描述设计与落地状态，实测数字见 `docs/OCR-BENCHMARK.md`（由 benchmark 脚本真实产出）。

## 1. 设计原则

1. **同帧不可变**：一次识别只允许使用一张截图；所有引擎/预处理共享同一个 `captureId`，禁止二次截图参与同一判定（修正 v0.2.8 的 OCR-H3）。
2. **识别与提交解耦**：`capture → recognize → match → validate → commit → emit`。识别失败/低可信只影响本次识别，不提前消费消息基线（修正 OCR-H1/H2）。
3. **不确定比猜错便宜**：低可信、联系人验证失败、气泡归属不明 → 一律不自动回复，交给诊断中心与人工。
4. **可解释**：每个消息候选带 `ConfidenceReport`（因子 + 分值 + 阈值 + 状态），审计日志可回溯。
5. **算法与 IO 分离**：`src/core/ocr/*` 全部是纯函数/纯类型；PowerShell/Node IO 留在通道层。

## 2. 目标流水线（12 阶段）

| # | 阶段 | 输入 → 输出 | 落点 |
| --- | --- | --- | --- |
| 1 | 窗口定位 | 微信窗口 → `geo{left,top,width,height}` + `dpiScale` | `wechat-uia.ps1` Get-WindowGeo |
| 2 | 截图 | 窗口/区域 → PNG bytes + `FrameMeta{captureId,capturedAt,width,height,dpiScale,region}` | `wechat-uia.ps1:467 Get-WindowShot` |
| 3 | 预处理 | 同帧 → 候选 A–H（原图/2x/3x/灰度/二值/锐化/去边框/对比度） | `src/core/ocr/preprocess.ts`（待落地） |
| 4 | 引擎识别 | 同帧 + 候选 → `OcrResult{lines:OcrLine[]}` | `OcrEngine` 接口（见 §4） |
| 5 | 文本归一 | 原始行 → 去 CJK 间空格/全半角/标点 | `src/core/ocr/normalize.ts`（已落地） |
| 6 | 行合并 | 行 → 视觉行（同带合并） | `src/core/ocr/geometry.ts`（已落地） |
| 7 | 气泡归属 | 行 → `left/right/unknown`（按气泡几何+窗格，不只看中点） | `src/core/ocr/bubbles.ts`（已落地） |
| 8 | 消息提取 | 行 → `MessageCandidate[]`（含文本、气泡、行框、所属帧） | `src/core/ocr/pipeline.ts`（已落地） |
| 9 | 多引擎融合 | 同帧多引擎结果 → 逐行几何匹配 | `src/core/ocr/fusion.ts` + `align.ts`（已落地，未接入生产） |
| 10 | 置信度评估 | 候选 → `ConfidenceEvaluation`（accept/verify/reject + 因子） | `src/core/ocr/confidence.ts`（已落地） |
| 11 | 联系人验证 | 标题/当前会话/白名单 → 是否允许回复 | 通道层 + `Test-IsTargetChat*` |
| 12 | 去重与提交 | 稳定消息身份 → 已观察/待确认/已交付 | `src/core/ocr/baseline.ts` + `pipeline.ts`（已接入）；`tracker.ts` 跨帧差分（已落地，未接入） |

## 3. 坐标模型

- 统一逻辑坐标：**以 window 客户区左上角为原点、按 DPI 缩放回 100%** 的像素；`FrameMeta.dpiScale` 记录实际缩放。
- 所有盒子统一 4 元组 `{x, y, width, height}`（见 `types.ts:OcrBox`）；换算函数 `toLogicalBox/fromLogicalBox` 已有单测。
- 多显示器：以 `Screen.AllScreens` 中命中窗口的那块屏为基准，禁止跨屏混合坐标。
- 只接受 `isValidBox`（有限正数）的盒子进入融合；非法盒子直接丢弃并计数。

## 4. 引擎抽象（OcrEngine）

```ts
export interface OcrEngine {
  readonly engineId: string;      // 'windows-ocr' | 'rapidocr' | ...
  readonly version: string;       // 引擎/模型版本
  availability(): Promise<OcrAvailability>;   // available/unavailable + reason
  recognize(input: OcrRecognizeInput, options?: OcrRecognizeOptions): Promise<OcrResult>;
  healthCheck(): Promise<OcrAvailability>;
}
```

契约要点：

- `OcrLine.text` 必须保留原始文本，**归一化只在消费端做**（便于统计与回溯）。
- `OcrLine.confidence`：引擎原生不提供置信度时必须是 `undefined`，**禁止编造**（Windows OCR 无置信度）。
- 每次识别返回 `captureId`/`preprocessingId`，融合层据此拒绝跨帧结果（修正 OCR-H3）。
- 超时、取消（`AbortSignal`）、`elapsedMs` 是接口的一部分，不是可选装饰。

## 5. 多引擎融合与行序列对齐

### 5.1 旧投票（baseline，保留）

`src/core/ocr/vote.ts:mergeEngineVote(winText, engineText, options)`：

- 先算归一化后的字符重合度（`normalize.ts:textOverlapRatio`）。
- 重合度 < `minOverlap`（默认 0.35）→ 两路内容无关，保留系统 OCR。
- 第二引擎长 ≥2 字 → 采用第二引擎。
- 同长且噪声分低 ≥0.5 → 采用第二引擎。
- 规则刻意与 v0.2.8 一致，方便 A/B 归因；生产预览回退路径仍会调用它（`desktop.ts` 的 `recheckGarbledText` 预览分支），**不再用于最终行文本判定**。

### 5.2 几何匹配（`fusion.ts`，已实现 + 单测，未接入生产）

`matchLines(primary, secondary, options)` 做一对一匹配，**只看几何、不比较文本长度**（避免 v0.2.8 的“谁更长谁赢”）：

- 打分 = IoU 0.35 + 中心距离 0.25 + 垂直重合 0.25 + 水平相邻 0.15；同气泡再加 0.1；
- 两侧都有 `bubbleId` 且不同 → 直接排除（跨气泡不配对）；
- 按分数降序贪心配对，结果稳定可复现；`minScore` 默认 0.35。

### 5.3 顺序保持对齐（`align.ts`，已实现 + 单测，未接入生产）

`alignLineSequences(a, b)` 用 Levenshtein DP 做序列对齐，并保证顺序与气泡一致：

- 归一化文本相同 → 替换代价 0；
- 相似度 < `minReplaceSimilarity`（默认 0.8）或跨气泡 → 用 `FORBIDDEN_SUBSTITUTION=3` 禁止强行配对，迫使走 delete+insert；
- 其余替换代价 = `min(1, 2 × (1 − similarity))`。

> 生产链路当前不使用 fusion/align：第二引擎的融合由 `wechat-uia.ps1` 的分层决策完成（重叠 ≥0.90 记 `agree` 取第二引擎分；0.35–0.90 记 `conflict` 且 score ≥0.85 才替换；无匹配记 `single`），TS 侧不再重排/重算文本。

## 6. 受控纠错（已落地部分）

`src/core/ocr/correction.ts`：

- `noiseScore` / `looksGarbled` / `pickBetterText`：与 v0.2.8 公式一致（baseline 可复用）。
- `DEFAULT_CORRECTION_WORDS`：只放通用高频词，**不预设任何真实好友昵称/人格名**；联系人名与人格名由调用方经 `extraWords` 传入。
- `findProtectedSpans` + `applyControlledCorrection`：姓名/wxid/金额/手机号/验证码/日期/邮箱/网址/文件名/订单号/密码等区段**禁止任何模糊替换**；被保护区段内的候选直接跳过并计数。
- 纠错等级：`none`（关闭）/`conservative`（默认，仅受控词典替换）；未来可加 `aggressive`，但默认永远不启用。

## 7. 置信度、消息身份、去重与持久化

### 7.1 置信度评估（`confidence.ts`，已接入 `desktop.ts`）

`evaluateConfidence(inputs)` 输出 `{score, signals, decision, explain, vetoed}`：

- 因子与权重：原生置信度 0.35、清晰度（行高/缩放）0.2、引擎一致度 0.25、行匹配 0.1、合并/截断 0.1、纠错 0.05；按**实际可用因子**重新归一化，缺的因子不臆造（与 `OcrLine.confidence` 的约定一致：引擎不提供就是 `undefined`）。
- 阈值：`CONFIDENCE_HIGH=0.75`、`CONFIDENCE_LOW=0.45`。
- 决策：`accept`（≥0.75 或证据充分）→ 正常投递；`verify`（0.45–0.75 或证据不足）→ 用同帧 `-SecondOcr` 复评；`reject`（<0.45 或 `contactVerified=false` 硬否决）→ 不投递、不推进 ack。
- 硬约束：`contactVerified===false` 时分数压到 ≤0.2 且 `decision='reject'`；没有可解释证据时默认 `verify`，**绝不默认放行**。

### 7.2 消息身份与 ack 水位线（`baseline.ts` + `bubbles.ts` + `pipeline.ts`，已接入生产）

- 身份 = 脚本生成的稳定 id `pc-<captureSeq>-<messageSeq>-<几何哈希>`（**不含 OCR 文本**，跨帧稳定；连发两条相同文本靠 `messageSeq` 区分）；旧的纯文本消息由 `pipeline.ts:stableMessageId(text, index)` 兜底。
- ack 水位线：调用方把上一次成功投递的 `captureId` 作为 `-Ack cap-N` 传回，脚本只重放 `seq > ackSeq` 的 pending 行；TS 侧把水位线持久化到 `dataDir/desktop-ack.json`（懒加载、串行落盘、写失败仅 debug），避免重启后重放已处理帧。
- 归属：`bubbles.ts:classifyBubble` 按 `pane + box` 几何判断 left/right/unknown，跨窗格/越界不猜；`pipeline.ts:planInboundDispatch` 汇总 accepted/rejected、uncertain/outbound/duplicate/legacy 计数，并计算 `nextAck`。
- 基线原子写：PS1 先 `Save-State`（临时文件 + `File.Replace`）再输出，避免“输出后崩溃导致重复投递”。

### 7.3 跨帧差分（`tracker.ts`，已实现 + 单测，未接入生产）

`classifyFrameDelta(prevPending, current)` 用加权 LCS 做跨帧关联，输出 `replay/ocrChanged/inserted/scrolled/duplicates/reset` 与 `matchedPrevIds`：

- 同 id → 1；归一化文本相同 → 0.95；相似度 ≥0.7 且几何重合/垂直接近 → 0.5 + 0.3×相似度；无几何时仅高相似文本 → 0.4 + 0.3×相似度；
- 连发相同文本时第一条 replay、第二条因几何不同记 insert；同帧重复（文本同 + IoU ≥0.5）→ duplicate；联系人变化 → reset 全部 insert。

> 当前生产脚本用“窗口开头 k 条 == 基线末尾 k 条”的尾对齐来找出新行，**没有接入 tracker.ts**；tracker 的价值（OCR 变化/滚动/重放分类）需后续评估后再接线。

### 7.4 持久化状态（设计）

- 持久化状态：`observed / pending / delivered / processed / sent / send-unknown`；重启不重刷历史；一次识别失败不永久吞消息（低置信不推进 ack，留 pending 下次重放）。
- 去重：同批重复 id 拒投；`desktop.ts` 用 `${name}|${id}` 在 `inFlight` 集合中判重（上限 200），重放消息第二次到达时直接跳过置信度门禁。

## 8. 发送前二次校验（与 Phase D 联动）

发送路径必须在**每个 part 发出前**重新校验（不能只在生成前查一次）：

1. 用户暂停/停止（含生成后、拟人延迟结束时刻）
2. 熔断/预算/频控
3. 白名单 + 联系人定位（标题 OCR 交叉验证，修正 REL-P0-3）
4. 用户键鼠空闲门槛
5. 通道状态/驱动开关
6. 消息三态：`sent / not-sent / unknown`；`unknown` 不自动重发（修正 REL-P0-2）
7. 幂等账本：`sendOperationId + partIndex` 在 `send-ledger.json` 中只执行一次；终态（confirmed/cancelled/unknown）不再发送，`failed` 仅在账本证明 `not-sent` 且尝试 <3 时允许重试（v3.0.0 补充）
8. 门禁优先：`safeMode` → `sendMode=draft/confirm` 只生成草稿；草稿批准时重新走 1–7 全部校验并复用同一 `opId`（v3.0.0 补充）

## 9. 测试与 Benchmark 策略

- **纯函数单测**：`test/core/ocr-pure.test.ts`（几何、归一化、噪声/判糊、纠错保护、双引擎投票）、`ocr-baseline.test.ts`、`ocr-bubbles.test.ts`、`ocr-pipeline.test.ts`、`ocr-fusion.test.ts`、`ocr-align.test.ts`、`ocr-confidence.test.ts`、`ocr-tracker.test.ts`；通道侧 `test/channels/desktop.test.ts` 覆盖置信度门禁、ack 水位线、气泡归属与防误发。完整数量以 `npm run test:sandbox` 实测为准。
- **合成语料**：`scripts/ocr/gen_corpus.py` 生成 20 类场景（清晰/小字/低对比/模糊/缩放 100–175%/长气泡/连发同文/中英混排/金额电话/深色背景/半遮挡…），全部虚构内容。
- **A/B**：v0.2.8 baseline（逐行转写）vs 仅预处理 / 仅引擎 / 仅对齐 / 仅融合 / 完整流水线；bench 支持 `--pipeline=raw|baseline|v3|all`、`--split=all|tune|eval`，指标含 CER、行级 P/R/F1、整句准确率、漏读率、假消息率、重复率、不确定比例、误改率、P50/P95、CPU/内存。
- **门槛**：OCR 必须在独立数据集上有可测量改善，否则不宣称「更准」（任务书发布门槛）；结论在 `docs/OCR-BENCHMARK.md` §6.5，限定合成语料 + 离线等价。
- **真实窗口**：只做只读验证（不发送），由 `scripts/pwsh/selfcheck.ps1 -Port …` 与人工确认。

## 10. 迁移映射（v0.2.8 → v3.0.0）

| v0.2.8 位置 | v3.0.0 落点 | 状态 |
| --- | --- | --- |
| `desktop.ts:64 ocrNoiseScore` | `core/ocr/correction.ts:noiseScore` | 已迁移（同名导出兼容） |
| `desktop.ts:75 looksGarbled` | `core/ocr/correction.ts:looksGarbled` | 已迁移 |
| `desktop.ts:86 pickBetterText` | `core/ocr/correction.ts:pickBetterText` | 已迁移 |
| `desktop.ts:101 DEFAULT_OCR_DICT` | `core/ocr/correction.ts:DEFAULT_CORRECTION_WORDS`（`desktop.ts` 保留别名） | 已迁移 |
| `desktop.ts:108 correctOcrText` | `core/ocr/correction.ts:applyControlledCorrection` | 已迁移（受控替换） |
| `desktop.ts:137 textOverlapRatio` | `core/ocr/normalize.ts:textOverlapRatio` | 已迁移 |
| `desktop.ts:152 mergeEngineVote` | `core/ocr/vote.ts:mergeEngineVote` | 已迁移 |
| `desktop.ts:311 recheckGarbledText` | 通道层编排（多帧 + 双引擎），算法调用 core/ocr | 已重构（IO 仍在通道层） |
| `desktop.ts` 文件头 `// @ts-nocheck` | 已移除；全文件强类型 | 已落地 |
| PS1 同帧截图/基线原子提交 | `wechat-uia.ps1`（Phase C：`-Ack`/captureId/pending/稳定 id/Save-State） | 已落地（真实微信未端到端验证） |

## 11. 当前落地状态（诚实标注）

**已落地（纯逻辑，`src/core/ocr/`）**：`types/geometry/normalize/correction/vote` + `fusion/align/confidence/tracker/baseline/bubbles/pipeline`。

**已接入生产读取路径**：`baseline/bubbles/pipeline/confidence`（`desktop.ts` 的 `planRead`/`evaluateMessage`/`verifySecondEngine`/`commitAck`）；PS1 侧同帧截图、`-Ack` 水位线、分层第二引擎、pending 重放、稳定 id、原子 `Save-State`；ack 水位线持久化到 `dataDir/desktop-ack.json`。

**已实现 + 单测、尚未接入生产**：`fusion.ts`（几何匹配）、`align.ts`（顺序保持对齐）、`tracker.ts`（跨帧差分）；生产读取仍用 PS1 尾对齐 + 分层第二引擎，未做 TS 侧重排/重算。

**待落地**：预处理候选 A–H 的 TS 侧实现（bench 用的 2x/灰度变体由 Python 生成，生产只做 2 倍近邻放大）；`tracker.ts` 是否接入的评估；**真实微信窗口端到端验证（需用户单独授权）**。

**不做的事**：不新增生产运行时 Python 依赖（RapidOCR 仅作为可选第二引擎，缺失即回退）；不移除 v0.2.8 行为兼容层（`vote.ts`/`correction.ts` 的 baseline 仍需用于 A/B）。

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
| 7 | 气泡归属 | 行 → `left/right/unknown`（按气泡几何+窗格，不只看中点） | `src/core/ocr/bubbles.ts`（待落地） |
| 8 | 消息提取 | 行 → `MessageCandidate[]`（含文本、气泡、行框、所属帧） | `src/core/ocr/extract.ts`（待落地） |
| 9 | 多引擎融合 | 同帧多引擎结果 → 逐行投票 | `src/core/ocr/vote.ts`（已落地） |
| 10 | 置信度评估 | 候选 → `ConfidenceReport`（confirmed/uncertain/unreadable…） | `src/core/ocr/confidence.ts`（待落地） |
| 11 | 联系人验证 | 标题/当前会话/白名单 → 是否允许回复 | 通道层 + `Test-IsTargetChat*` |
| 12 | 去重与提交 | 稳定消息身份 → 已观察/待确认/已交付 | `src/core/ocr/tracker.ts`（待落地） |

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

## 5. 多引擎融合（已落地部分）

`src/core/ocr/vote.ts:mergeEngineVote(winText, engineText, options)`：

- 先算归一化后的字符重合度（`normalize.ts:textOverlapRatio`）。
- 重合度 < `minOverlap`（默认 0.35）→ 两路内容无关，保留系统 OCR。
- 第二引擎长 ≥2 字 → 采用第二引擎。
- 同长且噪声分低 ≥0.5 → 采用第二引擎。
- 规则刻意与 v0.2.8 一致，方便 A/B 归因；后续若引入序列对齐（Levenshtein + 行高/IoU 约束），以新函数实现并保留本函数作 baseline。

## 6. 受控纠错（已落地部分）

`src/core/ocr/correction.ts`：

- `noiseScore` / `looksGarbled` / `pickBetterText`：与 v0.2.8 公式一致（baseline 可复用）。
- `DEFAULT_CORRECTION_WORDS`：只放通用高频词，**不预设任何真实好友昵称/人格名**；联系人名与人格名由调用方经 `extraWords` 传入。
- `findProtectedSpans` + `applyControlledCorrection`：姓名/wxid/金额/手机号/验证码/日期/邮箱/网址/文件名/订单号/密码等区段**禁止任何模糊替换**；被保护区段内的候选直接跳过并计数。
- 纠错等级：`none`（关闭）/`conservative`（默认，仅受控词典替换）；未来可加 `aggressive`，但默认永远不启用。

## 7. 消息身份、去重与持久化（设计）

- 身份 = `captureId + 几何指纹（气泡边/行框相对位置）+ 归一化文本 + 邻接关系`，不能只用文本哈希（修正 REL-P1-6）。
- 连发两条相同文本（如两次「在吗」）必须算两条：靠几何行号/isNew 标记区分，而不是文本。
- 跨帧 OCR 变化（同一条消息两次识别结果不同）必须算一条：用 LCS 相似度 + 行框 IoU 关联。
- 持久化状态：`observed / pending / delivered / processed / sent / send-unknown`；重启不重刷历史；一次识别失败不永久吞消息（修正 OCR-H1、REL-P1-4）。
- 基线原子写：临时文件 + 原子重命名（修正 OCR-M6）。

## 8. 发送前二次校验（与 Phase D 联动）

发送路径必须在**每个 part 发出前**重新校验（不能只在生成前查一次）：

1. 用户暂停/停止（含生成后、拟人延迟结束时刻）
2. 熔断/预算/频控
3. 白名单 + 联系人定位（标题 OCR 交叉验证，修正 REL-P0-3）
4. 用户键鼠空闲门槛
5. 通道状态/驱动开关
6. 消息三态：`sent / not-sent / unknown`；`unknown` 不自动重发（修正 REL-P0-2）

## 9. 测试与 Benchmark 策略

- **纯函数单测**：`test/core/ocr-pure.test.ts`（已落地，当前 23 用例）覆盖几何、归一化、噪声/判糊、纠错保护、双引擎投票。
- **合成语料**：`scripts/ocr/gen_corpus.py` 生成 20 类场景（清晰/小字/低对比/模糊/缩放 100–175%/长气泡/连发同文/中英混排/金额电话/深色背景/半遮挡…），全部虚构内容。
- **A/B**：v0.2.8 baseline（逐行转写）vs 仅预处理 / 仅引擎 / 仅对齐 / 仅融合 / 完整流水线；指标含 CER、行级 P/R/F1、整句准确率、漏读率、假消息率、重复率、不确定比例、误改率、P50/P95、CPU/内存。
- **门槛**：OCR 必须在独立数据集上有可测量改善，否则不宣称「更准」（任务书发布门槛）。
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
| PS1 同帧截图/基线原子提交 | `wechat-uia.ps1`（Phase C） | 待落地 |

## 11. 当前落地状态（诚实标注）

- 已落地：`types.ts`、`geometry.ts`、`normalize.ts`、`correction.ts`、`vote.ts` + `test/core/ocr-pure.test.ts`；`desktop.ts` 去 `@ts-nocheck`、去 `any`、纯函数改由 core 提供；`typecheck` 干净、`test:sandbox` 全绿。
- 待落地：同帧截图与 captureId 贯通（PS1）、预处理候选、气泡归属重写、置信度评分、消息身份/tracker、基线原子写与「先输出后消费」修复。
- 不做的事：不新增生产运行时 Python 依赖；不移除 v0.2.8 行为兼容层（A/B 需要 baseline）。

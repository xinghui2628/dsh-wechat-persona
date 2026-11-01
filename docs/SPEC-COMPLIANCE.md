# v3.0.0 任务书逐项对照（合规清单）

> 对照对象：`DSH_微信AI插件_v3.0.0_完整开发提示词.md`（1382 行，共十六部分）。
> 状态口径：**✅ 已达成**（有代码/测试/实测证据）、**⚠️ 部分达成/受限**（如实标注差距）、**⏳ 待维护者批准**（不擅自执行）。
> 本清单只记录真实证据；无证据项一律标 ⚠️，不写「已支持」。最后更新：2026-11-01。

## 0. 分支与提交状态

- 工作分支：`feat/v3.0.0`（本地，无 upstream）。
- 起点提交：`42a3caa`（v0.2.8 文档 HEAD）。
- 已提交（18 个本地提交，按阶段）：
  - A `6eceaff` → B `0408860` → D `dfbc9c1` → A/C bench `e49432d` → 扫描修复 `4e324d2` → C `e8316b2` → E `364c57b` → F `f63decc` → C bench `325299f` → G `646a2ba` → 版本 3.0.0 `d2f9207` → CHANGELOG/V3-AUDIT 快照 `d9cf985`
  - 逐项复核补齐：AI 身份透明 `28d3a89` → OCR 融合/置信度/追踪 `5c0735b` → 发送状态机/幂等/草稿/SSRF `a466ac0` → 预处理 A–H/A-B/Worker/60 图语料 `29dcfee` → CI/发布准备/文档同步 `bf7d82e` → 本清单与 CHANGELOG 终版（本次提交）
- **未 push、未打 tag、未发布 Release、`package.json` 仍 `private: true`**（任务书要求发布需明确批准）。

## 1. 第一部分：定位 / 最高原则 / 开发约束

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 最高原则优先级 | ✅ | 隐私门禁 `check-sensitive`；跨联系人误发修复（无行坐标一律拒发）；三态投递 + 幂等账本；测试全绿 |
| 不擅自 push / 重写历史 / force push | ✅ | 18 个提交全部留在本地 `feat/v3.0.0` |
| 不用真实联系人自动发送测试 | ✅ | 自动化测试全用 mock / fake channel；真实微信未触发 |
| 不伪造测试结果 | ✅ | 所有数字来自 `npm run test:sandbox` / bench 实跑，命令与耗时在 `docs/OCR-BENCHMARK.md` |
| 先建独立分支、分阶段提交 | ✅ | `feat/v3.0.0`，按 A–G + 复核补齐分 18 次提交 |

## 2. 第二部分：隐私与安全底线

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 2.1 敏感信息排查（真名/昵称/wxid/路径/token 等） | ✅ | `docs/ACCEPTANCE.md` 真名→测试占位；`docs/HANDOFF-0.3.0.md` 14 处指纹泛化；`scripts/check-sensitive.mjs` 212 个受跟踪文本文件 0 命中 |
| 2.2 Privacy by Default | ✅ | 日志不含聊天全文；诊断 15 字段不含聊天内容；草稿/账本只在 dataDir；市场 URL 校验 |
| 2.3 Git 历史中的敏感信息 | ⏳ 待批准 | `9db6c5b`（已推送 origin/master）文档含真实中文姓名；改写历史不可逆，需维护者明确决定 |

## 3. 第三部分：OCR 架构改造目标

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 独立、可单测、可替换的 OCR 模块 | ✅ | `src/core/ocr/`：types/geometry/normalize/correction/vote/bubbles/baseline/pipeline + `fusion/align/confidence/tracker`（共 12 模块，纯函数无 IO） |
| 同帧截图、不可变、带 captureId | ✅ | PS1 `-KeepImage` + `captureId='cap-<seq>'`；Windows OCR 与 RapidOCR 识别同一 PNG |

## 4. 第四部分：截图与坐标

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 4.1 同一帧截图（同帧不可变） | ✅ | `wechat-uia.ps1` Get-WindowSnapshot -KeepImage；`-SecondOcr` 复用同一 PNG |
| 4.2 统一坐标模型（100/125/150/175%、多显示器 DPI） | ✅ | `geometry.ts` toLogicalBox/fromLogicalBox/scaleBox；PS1 输出 `scale` 与真实 `GetDpiForWindow`，坐标统一回 100% |
| 4.3 聊天区域与气泡左右归属检测 | ✅ | `bubbles.ts` classifyBubble（长气泡越线判 uncertain）；PS1 Get-BubblePane/Get-BubbleSide；desktop 拒投 uncertain/outbound |
| 4.4 预处理候选 A–H 真实指标比较 | ✅ | `docs/OCR-BENCHMARK.md` §4.5：A–H 十一变体 tune/eval 各 330 次识别（0 失败）。结论：upscale3x 最优（tune 17.66%/整句 53.85%，eval 25.68%/51.52%）；精确裁剪单用不优于全窗放大（但假消息率更低 12.99% vs 18.07%）；灰度/中值/对比度类劣化 |

## 5. 第五部分：OCR 引擎

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 5.1 OcrEngine 接口 + OcrLine/OcrResult 结构，无置信度用 undefined | ✅ 类型层 | `types.ts`（engineId/version/availability/recognize/healthCheck + OcrLine/OcrResult）；生产识别仍由 PS1/Windows OCR 与 Python/RapidOCR 执行，适配层在脚本侧（如实说明） |
| 5.2 RapidOCR 迁移统一 `rapidocr`（boxes/txts/scores）、可选增强、不私自下载 | ⚠️ 代码就绪未实测 | `scripts/py/rapid_ocr.py` 双路径（`RAPIDOCR_IMPL=auto\|unified\|legacy`）：旧包实测 `ok=true engine=rapidocr_onnxruntime version=1.2.3`；统一包本机未安装，返回 `available:false` 而非崩溃，未声称已验证 |
| 5.3 测启动/初始化/推理/内存；可设计常驻 Worker | ✅ 评估完成、不接线 | `scripts/ocr/worker-eval.mjs`：import 224ms + 初始化 589ms、首图 1717ms、稳态 1323ms/图、RSS 101/110/243MB；现状每图新起进程 3130ms → 常驻可省 ~1807ms/帧；结论「值得做、本期不接线生产」（§6.8） |

## 6. 第六部分：多引擎融合

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 6.2 几何匹配（IoU/中心距/垂直重合/行高/气泡边界）+ 一对一 | ✅ | `fusion.ts` matchLines：权重 IoU .35/中心距 .25/垂直重合 .25/水平相邻 .15 + 同气泡 bonus，minScore 0.35，一对一贪心，输出 pairs/unmatched（8 条单测） |
| 6.3 Levenshtein 序列对齐 + 多行 DP，不拼接其他消息 | ✅ | `align.ts` alignLineSequences：Levenshtein DP（compareKey），跨气泡禁配、顺序倒置不强配（minReplaceSimilarity=0.8；7 条单测） |
| 6.4 分层投票状态 confirmed/uncertain/unreadable/mismatch/duplicate/wrong-contact；不自动产生正确答案、不硬编码 | ✅ | `pipeline.ts` OcrMergeStatus 分层拒绝 + `fusion.ts`；PS1 SecondOcr 改分层决策（overlap≥0.90 agree / 0.35–0.90 conflict 且第二引擎 score≥0.85 才替换 / 无匹配 single），删除「谁更长谁用谁」 |
| 6.5 可解释置信度 + 高低阈值 + 中可信二次验证/草稿 + 低可信不回复 + 联系人失败不发 | ✅ | `confidence.ts` evaluateConfidence（score/factors/decision/explain/vetoed，HIGH=0.75 LOW=0.45，无原生 confidence 不计分、contactVerified=false 硬否决）；desktop read 接入：reject 不投递、verify 用同帧第二引擎二次验证、低置信不推进 ack（留 pending 下次重放，不丢消息） |

## 7. 第七部分：OCR 纠错

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 7.1 分级纠错（≥5 步） | ✅ | `correction.ts`：noiseScore / looksGarbled / pickBetterText / findProtectedSpans / applyControlledCorrection |
| 7.2 受保护内容不得改写 | ✅ | `findProtectedSpans` + `overlapsProtected`；无约束模糊替换已停止；默认词典不含真实昵称 |
| 7.3 不让 LLM 猜测 OCR 原文、不把未经同意截图发远程 | ✅ | 提示词只接收文本；无截图外发代码路径 |

## 8. 第八部分：消息去重与状态跟踪

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 8.1 capture/recognize/match/validate/commit/emit 解耦，重识别不提前消费 | ✅ | `pipeline.ts planInboundDispatch`；PS1「先 Save-State 后输出」+ pending 队列；desktop 分阶段 |
| 8.2 稳定消息身份（不能只用文本哈希；连发同文算两条；跨帧变化算一条） | ✅ | PS1 pending id `pc-<captureSeq>-<messageSeq>-<几何hash>`（不含文本哈希）；`tracker.ts` LCS 跨帧；连发同文/跨帧重放用例 |
| 8.3 LCS/序列编辑距离/DP/几何关联 + 测试 | ✅ | `tracker.ts classifyFrameDelta`（replay/ocr-changed/insert/scroll/duplicate/reset）+ 9 条单测（重复文本、滚动、插入、OCR 变化、切联系人） |
| 8.4 原子写、状态区分、重启不刷历史、一次失败不永久吞消息、基线重建流程、exactly-once 边界 | ✅ 部分 | 原子写（tmp+File.Replace）、ack 水位线持久化（desktop-ack.json）、pending 不截断、低置信留 pending 重放；状态词表与 exactly-once 边界见 `docs/OCR-DESIGN.md`/`docs/TROUBLESHOOTING.md`；「基线重建流程」以 TROUBLESHOOTING ack 状态 + pending 重放语义说明，未做专用重建命令（如实标注） |

## 9. 第九部分：发送安全

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 9.1 发送状态机 10 态 + 合法转换测试 | ✅ | `send-state.ts`（SEND_TRANSITIONS/canTransition/assertTransition，10×10 遍历 6 条单测）；engine 真实阶段推进 + audit `send-state` |
| 9.2 发送前二次校验 10 项，修「生成后暂停、拟人延迟完仍发送」 | ✅ | `engine.ts canSend()`（:377-408）；发送循环每 part/每次调通道前复查；`pause()/stop()` 立即 AbortController 打断拟人延迟 |
| 9.3 三态 confirmed/not-sent/unknown；unknown 不自动重发；人工检查 | ✅ | `SendDelivery` + resolveSendDelivery + canRetrySend；PS1 两处返回 unknown；unknown 不重试并计数/审计 |
| 9.4 唯一 sendOperationId 幂等；超时/异常/OCR 失败/重试/重启不重复；部分成功/多 part/中途暂停测试 | ✅ | `send-ledger.ts`（dataDir/send-ledger.json，上限 200，terminal 不重发，multi-part 按 partIndex，重启加载）+ 13 条单测 + acceptance 幂等用例（重复 sendTest 只发 1 次、重启后 0 次） |

## 10. 第十部分：安全

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 10.1 API 认证/来源/参数/大小/错误脱敏/限流；密钥不进前端 | ✅ | `api.ts checkAuth` 六层（回环 socket、专用头、Host/Origin/Sec-Fetch-Site、可选 Bearer，SHA-256+timingSafeEqual）、限速 240/min、10s 请求体超时、415/413、错误不回显原值、token 落盘 0600 |
| 10.2 /test/send 不绕过门禁；mock 与真实分离、默认 mock | ✅ | `sendTest` 走 canSend({checkWhitelist,checkRate})；`/test/send` 暂停 409；`mockOnly`；默认 activeChannel=mock |
| 10.3 市场：URL/内网/重定向/长度/非法 JSON/路径穿越/恶意提示词/动态执行/隐私覆盖；默认只导入数据 | ✅ 部分 | `persona-market.ts`：仅 http/https、拒内网/回环/链路本地/`.local`、redirect manual ≤2 跳每跳重校验、Content-Type 必须 JSON、2MB 双限、错误不回显 URL；导入结构消毒（id/URL 协议/原型污染/大小）；**DNS rebinding 残余面**已在 SECURITY.md 标注 |
| 10.4 AI 身份透明：被问如实说明、不冒充真人、不诱导敏感信息 | ✅ | `src/llm/prompt.ts:39` 最高优先级规则；`persona.ts:29/39/47`、4 个内置人格 systemPrompt 与示例对话、`persona/persona.md`、`persona/examples.md`、persona-library 转换约束全部同步；persona/persona-library/persona-market 57 用例全过 |

## 11. 第十一部分：架构与代码质量

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 11.1 去 @ts-nocheck / any / 不安全断言；严格类型 + 运行时校验 | ✅ | desktop.ts 去 @ts-nocheck 与 any；src 无 `: any`/`as any`；PS 输出经 normalize/运行时校验；typecheck 0 错 |
| 11.2 模块拆分（ScreenshotProvider/OcrEngine/…/SendCoordinator/PrivacyManager/DiagnosticsService） | ✅ 部分 | 已拆 core/ocr/*（融合/对齐/置信度/跟踪）+ send-state/send-ledger + sendMode；ScreenshotProvider 与 SendCoordinator 仍由 desktop/PS1 承担（如实标注） |
| 11.3 缓存与性能（截图复用/哈希/识别缓存/模型复用/自适应频率/第二引擎按需/不重复启动 Python/限并发；不旧图当新消息、不漏消息、不降安全检查频率；P50/P95 与资源） | ⚠️ 部分 | 同帧复用、第二引擎按需、8s 低频轮询、P50/P95 与 cpu/rss 已记录（OCR-BENCHMARK §6.7）；识别缓存/模型复用（Worker）评估完成但**未接线**，无缓存实现 |

## 12. 第十二部分：OCR Benchmark

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 12.1 虚构语料覆盖（22 类场景；合成与真实分开） | ✅ | `scripts/ocr/gen_corpus.py` 30 场景×2=60 张（旧 40 张 SHA256 不变、可确定性重跑），manifest v2 有 `coverage` 21 项对照、`scenarioIndex`、`emptyGt`；真实数据未采集（如实标注） |
| 12.2 指标（CER/整句/漏读/假消息/错误联系人/重复/冲突/不确定/误改/P50-P95/CPU 内存） | ✅ 部分 | 全部指标已跑：冲突 28/66=42.42%、不确定 12/66=18.18%、纠错 3 条误改 0、重复 0、P50/P95 与 cpuP50/rssP95 在 §4.5/§6.7；**错误联系人关联未测**（合成语料每图单会话，无多联系人对） |
| 12.3 A/B 六组（A v0.2.8 / B 预处理 / C 引擎 / D 对齐 / E 融合 / F 完整 v3），tune/eval 不重叠 | ✅ | eval 集（66 条消息）：A 35.59% / B 22.82% / C 2.25% / D 24.47% / E 12.91% / F **22.07%**（整句 A 30.30% → F 51.52%）；tune 仅用于选变体；F≈B 说明保守投票下融合/纠错额外增益有限（如实记录） |
| 12.4 发布门槛 10 条 + OCR 独立数据集可测量改善 | ✅ 限定口径 | 10 条逐条在 `docs/RELEASE-CHECKLIST.md`；OCR 门槛 2：两轮 eval 相对 v0.2.8 均有可测量改善（本轮 −13.52pp CER / +21.22pp 整句），**限定「合成语料 + 离线等价」**；真实微信未验证，不夸大 |

## 13. 第十三部分：用户体验

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 13.1 首次配置向导（10 步）且默认不真实发送 | ⚠️ | 已有向导（4 步：默认 mock + safeMode、可跳过）→ 步骤数少于 10，如实标注；默认 mock + safeMode 已达成 |
| 13.2 诊断中心（引擎/依赖/模型版本/可捕获/DPI/截图方式/耗时/错误/冲突数/二次识别/质量状态；默认不显示聊天内容） | ✅ | `/diagnostics/ocr` 15 字段：captureId/engines/lines/uncertainCount/rejectCount/durationMs/lastReadAt/lastError/dpi/scale/screenshotMode/engineVersion/conflictCount/secondOcrUsed/qualityStatus；白名单+钳制+不含聊天内容 |
| 13.3 mock 人格模拟器 | ✅ | `/test/send` mockOnly + client 按钮（非 mock 禁用） |
| 13.4 安全模式（mock/只读诊断/仅生成草稿/人工确认/白名单自动回复；UI 标明、可随时暂停） | ✅ | safeMode（真实通道拒发）+ 只读诊断 + `sendMode: auto/draft/confirm`（草稿面板批准后才发，approve 重走全部门禁）+ 白名单自动回复 + 可暂停 |

## 14. 第十四部分：GitHub / CI / 发布准备

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 14.1 README 12 节 + Mermaid、无真实图片 | ✅ | `README.md` 12 节 + Mermaid（仅文本图） |
| 14.2 定位文字避免未验证宣传 | ✅ | README 标注「3.0.0 开发中、private:true 不公开发布」；OCR 结论限定口径 |
| 14.3 文档清单 | ✅ | ARCHITECTURE/OCR-DESIGN/OCR-BENCHMARK/PRIVACY/SECURITY/MIGRATION-v3/TROUBLESHOOTING/CONTRIBUTING/RELEASE-CHECKLIST 全部存在 |
| 14.4 CI ≥10 项，不依赖真实账号，不掩盖锁文件问题 | ✅ | `.github/workflows/ci.yml` verify-windows 14 步：typecheck/单测/集成/Windows 兼容（含 .ps1 BOM 断言）/build/API 验证/npm audit/敏感扫描/发布包检查/OCR 冒烟（marked skip）+ linux-guard；`npm ci` 无回退；YAML 校验通过 |
| 14.5 Release 准备（更新日志/兼容/安装/迁移/已知限制/可复现构建/SHA256/干净包/回退；private:true 不得改公开；需批准） | ✅ 文档 | `docs/RELEASE-CHECKLIST.md` §6（发布说明/可复现构建+dist-SHA256SUMS/SHA256 命令/干净发布包流程+禁 npm pack/回退 v0.2.8/批准边界）；`scripts/check-package.mjs` 189 候选 0 违规；仅文档与 dry-run，未实际发布 |

## 15. 第十五部分：执行顺序 A–G（每阶段独立提交 + 测试）

| 阶段 | 状态 | 提交 / 证据 |
| --- | --- | --- |
| A 审计与基线 | ✅ | `6eceaff`、`e49432d`；`docs/V3-AUDIT.md` |
| B OCR 架构重构 | ✅ | `0408860`；`src/core/ocr/*`、desktop 强类型化 |
| C OCR 算法与同帧 | ✅ | `e8316b2`、`325299f`；同帧/基线/气泡/ack + bench tune/eval |
| D 消息可靠性 | ✅ | `dfbc9c1`；暂停打断/三态/去重 |
| E 安全 | ✅ | `364c57b` + `a466ac0`；鉴权/导入安全/SSRF |
| F 体验 | ✅ | `f63decc` + `a466ac0`；safeMode/诊断/向导/模拟器/draft-confirm |
| G 文档与发布准备 | ✅ | `646a2ba` + `bf7d82e`；README/文档/CI/发布包检查/发布准备 |
| 收尾与逐项复核 | ✅ | `d2f9207`、`d9cf985`、`28d3a89`、`5c0735b`、`a466ac0`、`29dcfee`、`bf7d82e` + 本清单 |

## 16. 第十六部分：最终报告 7 节

| 章节 | 状态 |
| --- | --- |
| 一、审计发现摘要 | ✅ `docs/V3-AUDIT.md` |
| 二、OCR 优化报告（10 个问题）+ 三、数据对比 | ✅ `docs/OCR-BENCHMARK.md`（A–H、A/B 六组、资源、Worker） |
| 四、代码修改说明 | ✅ `docs/ARCHITECTURE.md`、`docs/OCR-DESIGN.md`、18 个提交 |
| 五、隐私与安全报告 | ✅ `docs/PRIVACY.md`、`docs/SECURITY.md`、check-sensitive |
| 六、发布状态与门槛核对 | ✅ `docs/RELEASE-CHECKLIST.md`（10 条逐条 + 发布准备 §6） |
| 七、Git 交付状态 | ✅ 见第 0 节（18 提交未推送、无 tag、测试命令与结果） |

## 当前已知残余风险（不掩盖）

1. **OCR 结论的适用范围**：提升来自「Pillow 合成语料 + 离线等价转写」，未在真实微信窗口跑过；真实设备回归需维护者在场授权。
2. **PS1 改动未实机**：同帧/ack/气泡/DPI/双引擎阈值（0.90/0.85）/几何 id 只经 PS5.1 语法 + AST 校验，需真机校准。
3. **置信度阈值**：0.75/0.45 为规则初值，未用标注集校准（任务书要求先规则评分、不训练）。
4. **fusion/align/tracker 未接线生产**：核心库 + 单测就绪，生产 read 路径仍用 PS1 几何匹配 + pending/ack 重放（避免未经实机验证的行为切换）。
5. **RapidOCR 统一包未实测**：本机未安装 `rapidocr`，双路径只实测旧包；未安装新包属于「不私自下载模型/依赖」的遵守。
6. **Worker 未接线**：量化结论为「值得做」，本期未改生产。
7. **市场 SSRF**：基于主机名字符串判定，未做 DNS 解析后二次校验（DNS rebinding 残余面），SECURITY.md 已标注。
8. **错误联系人关联未测**：合成语料每图单会话，缺少多联系人对样本。
9. **历史实名残留**：`9db6c5b` 已推送 origin/master 的文档含真实姓名，改写历史需维护者决定。

## 待维护者决定的事（3 件）

1. 是否 `git push` `feat/v3.0.0`（18 个本地提交，未推送）。
2. 是否打 tag / 发 Release（`private: true` 不改公开；Release 需明确批准）。
3. 是否改写 git 历史清除 `9db6c5b` 的真实姓名残留（不可逆，需明确授权）。


## 附录 B：发布前独立复核轮次（2026-11-01）

发布前按《DSH_v3.0.0_发布前独立复核与只读验收_完整提示词》做了独立复核，结论与证据见 `docs/V3-PRE-RELEASE-REVIEW.md`（A–G 全节）。与本清单相关的增量状态：

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 4.3 先核查后替换 / 受控 Feature Flag | ✅ | `config.ocrPipelineMode: 'v3'｜'legacy'`（默认 v3），legacy 保持 v0.2.8 行为，切换不影响发送门禁 |
| 5 只读测试模式（发布前验收） | ✅ 代码层 | `readOnlyTestMode` 四层硬阻断 + 22 条以上回归；真实微信未验证（方案 `docs/OCR-REAL-DEVICE-TEST-PLAN.md` 待批准） |
| 4.1/8.2 消息 ID 稳定性 | ✅ mock 回归 | `test/channels/desktop-id-stability.test.ts` 6 条（含重启不重发）；已投递 id 持久化到 `desktop-delivered.json` |
| 独立复核门禁 | ✅ | `typecheck` 0；`test:sandbox` 41 文件/678 用例；`check-sensitive` 212 文件 0；`check-package` 189 候选 0；`verify:api` 25/25；`build` 通过 |
| 生产接线诚实标注 | ✅ | `fusion/align/tracker` 仍「仅测试/未集成」；`pipeline/confidence/vote` 生产使用（`docs/V3-PRE-RELEASE-REVIEW.md` §B） |
| 发布决策 | ⏳ 待维护者 | push / tag+Release / 历史改名 / 真实设备只读验证 / 本地未跟踪 PII 目录处置（见复核报告 §G） |

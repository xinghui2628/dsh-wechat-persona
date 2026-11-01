# v3.0.0 任务书逐项对照（合规清单）

> 对照对象：`DSH_微信AI插件_v3.0.0_完整开发提示词.md`（1382 行，共十六部分）。
> 状态口径：**✅ 已达成**（有代码/测试/实测证据）、**🚧 进行中**（本轮补齐，含任务号）、**⚠️ 部分达成/受限**（如实标注差距）、**⏳ 待维护者批准**（不擅自执行）。
> 本清单只记录真实证据；无证据项一律标 ⚠️，不写「已支持」。

## 0. 分支与提交状态

- 工作分支：`feat/v3.0.0`（本地，无 upstream）。
- 起点提交：`42a3caa`（v0.2.8 文档 HEAD）。
- 已提交：`6eceaff` A → `0408860` B → `dfbc9c1` D → `e49432d` A/C bench → `4e324d2` 扫描修复 → `e8316b2` C → `364c57b` E → `f63decc` F → `325299f` C bench → `646a2ba` G → `d2f9207` 版本 3.0.0 → `d9cf985` CHANGELOG/V3-AUDIT 快照。
- 本轮差距补齐的改动：待验收后按阶段提交（task-12/13/14/15）。
- **未 push、未打 tag、未发布 Release、`package.json` 仍 `private: true`**（任务书要求发布需明确批准）。

## 1. 第一部分：定位 / 最高原则 / 开发约束

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 最高原则：隐私安全 > 不发错联系人 > OCR 准确率 > 不漏不重 > 稳定 > 安装体验 > 代码质量 > 文档 > 新功能 | ✅ | 隐私门禁 `scripts/check-sensitive.mjs`；跨联系人误发修复（desktop.send 无行坐标一律拒绝）；三态投递；测试全绿 |
| 不擅自 push / 重写历史 / force push | ✅ | 全部提交留在本地 `feat/v3.0.0` |
| 不用真实联系人自动发送测试 | ✅ | 自动化测试全用 mock / fake channel；真实微信未触发 |
| 不伪造测试结果 | ✅ | 所有数字来自 `npm run test:sandbox` / bench 实跑，报告附命令 |
| 先建独立开发分支、分阶段提交 | ✅ | 12 个本地提交，按阶段 A→G 划分 |

## 2. 第二部分：隐私与安全底线

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 2.1 敏感信息排查（真名、昵称、wxid、路径、token 等） | ✅ | `docs/ACCEPTANCE.md:304` 真实姓名 → 「测试甲」；`docs/HANDOFF-0.3.0.md` 14 处指纹泛化；`scripts/check-sensitive.mjs` 176 个受跟踪文件 0 命中 |
| 2.2 Privacy by Default | ✅ | 日志不含聊天全文；诊断接口默认不含聊天内容；文档默认值说明 |
| 2.3 Git 历史中的敏感信息 | ⚠️ 待批准 | 历史中确实存在一条已推送的真实中文姓名（v0.2.8 时期提交 `9db6c5b`）；改写历史需维护者明确决定，未擅自操作 |

## 3. 第三部分：OCR 架构改造目标

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 独立、可单测、可替换的 OCR 模块 | ✅ | `src/core/ocr/`：types/geometry/normalize/correction/vote/bubbles/baseline/pipeline（+ 本轮 fusion/align/confidence/tracker） |
| 同帧截图、不可变、带 captureId | ✅ | PS1 `-KeepImage` + `captureId='cap-<seq>'`；desktop 同帧读取，第二引擎识别同一 PNG |

## 4. 第四部分：截图与坐标

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 4.1 同一帧截图（同帧不可变） | ✅ | `scripts/pwsh/wechat-uia.ps1` Get-WindowSnapshot -KeepImage；第二引擎复用同一 PNG |
| 4.2 统一坐标模型（100/125/150/175%、多显示器 DPI） | ✅ | `src/core/ocr/geometry.ts`（toLogicalBox/fromLogicalBox/scaleBox）；PS1 输出 `scale`，坐标统一回 100%；多显示器按命中屏处理（`wechat-uia.ps1` 窗口定位逻辑） |
| 4.3 聊天区域与气泡左右归属检测 | ✅ | `bubbles.ts` classifyBubble；PS1 Get-BubblePane/Get-BubbleSide/Get-InboundCandidates；desktop 对 uncertain 不投递 |
| 4.4 预处理候选 A–H 用真实指标比较 | 🚧 task-14 | 当前 bench 只覆盖「原始 / 2x / 灰度对比度」；task-14 补齐 A–H 全表与结论 |

## 5. 第五部分：OCR 引擎

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 5.1 OcrEngine 接口（engineId/version/availability/recognize/healthCheck/timeout/cancellation）+ OcrLine/OcrResult 结构；无置信度用 undefined | ✅ 类型层 | `src/core/ocr/types.ts:12-110`；生产识别仍由 PS1（Windows OCR）/ Python（RapidOCR）执行——接口已定义、适配层在脚本侧，未把引擎搬到 TS（如实说明） |
| 5.2 RapidOCR 迁移到统一 `rapidocr` 包（boxes/txts/scores）、可选增强依赖、不私自下载模型 | 🚧 task-14 | `scripts/py/rapid_ocr.py` 现仅支持旧 `rapidocr_onnxruntime`；task-14 加双路径适配（新包本机未安装，只写代码、如实标注未实测） |
| 5.3 测量启动/初始化/推理/内存；可设计常驻 Worker；收益不明显则不强上 | 🚧 task-14 | 已有静态耗时（WinRT 26ms/进程启动≈330ms；RapidOCR 冷 3.3s/热 2.0s、模型初始化 0.66s）；task-14 给量化结论，不接线生产 |

## 6. 第六部分：多引擎融合

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 6.2 几何匹配（IoU/中心距/垂直重合/行高/气泡边界）+ 一对一匹配 | 🚧 task-13 | 新增 `fusion.ts` |
| 6.3 Levenshtein 序列对齐 + 多行 DP，不得拼接其他消息 | 🚧 task-13 | 新增 `align.ts` |
| 6.4 分层投票：同帧→同气泡→文本差异→引擎可靠性→confirmed/uncertain/unreadable/mismatch/duplicate/wrong-contact；不因投票自动产生正确答案、不硬编码 | 🚧 task-13 | `vote.ts` 目前仍是「重合度 + 谁更长/噪声低」的 v0.2.8 规则（仅保留给 A/B 基线） |
| 6.5 可解释置信度评分 + 高/低阈值；中可信二次验证或只出草稿；低可信不自动回复；联系人验证失败不发 | 🚧 task-13 | 新增 `confidence.ts` 并接入 read 流程 |

## 7. 第七部分：OCR 纠错

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 7.1 分级纠错（至少 5 步） | ✅ | `src/core/ocr/correction.ts`：noiseScore / looksGarbled / pickBetterText / findProtectedSpans / applyControlledCorrection |
| 7.2 受保护内容不得改写（姓名/昵称/wxid/金额/手机号/验证码/日期/邮箱/网址/文件名/订单号/密码） | ✅ | `findProtectedSpans` + `overlapsProtected`；禁用无约束模糊替换；默认词典不含真实昵称 |
| 7.3 不让 LLM 猜测 OCR 原文、不把未经同意真实截图发远程 | ✅ | 提示词只接收文本，不接收截图；无把截图外发的代码路径 |

## 8. 第八部分：消息去重与状态跟踪

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 8.1 capture/recognize/match/validate/commit/emit 解耦，重识别不提前消费 | ✅ | `pipeline.ts planInboundDispatch`；PS1「先 Save-State 后输出」；desktop 读流程分阶段 |
| 8.2 稳定消息身份（不能只用文本哈希；连发两条「在吗」算两条；跨帧 OCR 变化算一条） | 🚧 task-13 | PS1 pending id 现为 `'pc-'+文本哈希+'-'+messageSeq`；task-13 改为 captureSeq+messageSeq+几何、并加 LCS 跨帧对齐 |
| 8.3 LCS/序列编辑距离/DP/几何关联 + 测试（重复文本、滚动、插入、OCR 变化） | 🚧 task-13 | 新增 `tracker.ts` 与测试 |
| 8.4 原子写、状态区分 observed/pending/delivered/processed/sent/send-unknown、重启不刷历史、一次失败不永久吞消息、基线重建流程、exactly-once 边界 | ✅ 部分 | 原子写（tmp+File.Replace）、ack 水位线持久化、pending 不截断、失败重试；状态词表在文档中定义；「基线重建流程」文档待 task-15 补 |

## 9. 第九部分：发送安全

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 9.1 发送状态机 received→validated→generating→draft→ready→sending→confirmed/failed/unknown/cancelled + 合法转换测试 | 🚧 task-12 | engine 已有暂停/中断/三态，但无独立状态机模块 |
| 9.2 发送前二次校验 10 项，特别修「生成后暂停、拟人延迟完仍发送」 | ✅ | engine.ts:377-408 canSend；发送循环每 part、每次调通道前复查；暂停立即 abort |
| 9.3 三态 confirmed/not-sent/unknown；unknown 不得自动重发；提供人工检查 | ✅ | `SendDelivery` + `resolveSendDelivery` + `canRetrySend`；PS1 两处返回 unknown；unknown 不重试 |
| 9.4 唯一 sendOperationId 幂等；超时/子进程异常/OCR 失败/DSH 重试/重启不重复执行；部分成功/多 part/中途暂停测试 | 🚧 task-12 | 新增 `send-ledger.ts` + 测试 |

## 10. 第十部分：安全

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 10.1 API 认证/来源约束/参数校验/请求大小/错误脱敏/限流；密钥不进前端 | ✅ | `api.ts checkAuth` 六层（回环 socket、专用头、Host/Origin/Sec-Fetch-Site、可选 Bearer），SHA-256+timingSafeEqual、限速 240/min、10s 请求体超时、415/413、错误不回显原值 |
| 10.2 /test/send 不绕过白名单/暂停/熔断/收件人确认/人工授权；区分 mock 与真实、默认 mock | ✅ | `sendTest` 走 canSend({checkWhitelist,checkRate})；`/test/send` 暂停 409；mockOnly 支持 |
| 10.3 市场：不受信任 URL/内网地址/重定向/内容长度/非法 JSON/路径穿越/恶意提示词/动态执行/隐私覆盖；默认只导入数据 | 🚧 task-12 | 已有导入结构消毒（id/URL 协议/原型污染/大小限制）；SSRF（内网 IP、重定向、Content-Type、2MB 限制）本轮补 |
| 10.4 AI 身份透明：被直接问如实说明是 AI，不冒充真人/特定联系人，不诱导敏感信息 | ✅ 本轮补齐 | `src/llm/prompt.ts:39` 最高优先级规则；`src/core/persona.ts:29/39/47`、`persona/persona.md`、`personas/builtin/*.json`（4 个）与 `persona/examples.md` 全部改为如实说明；persona-library 转换约束同步；测试断言更新（persona/persona-library/persona-market 57 用例全过） |

## 11. 第十一部分：架构与代码质量

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 11.1 去 @ts-nocheck / any / 不安全断言；OCR/通道/发送/PS JSON 严格类型 + 运行时校验 | ✅ | desktop.ts 已去 @ts-nocheck 与 any；`src` 无 `: any`/`as any`；PS 输出经 normalize 与运行时校验 |
| 11.2 模块拆分（ScreenshotProvider/OcrEngine/…/SendCoordinator/PrivacyManager/DiagnosticsService） | ✅ 部分 | 已拆：core/ocr/*（引擎接口/预处理/匹配/置信度/跟踪）、bubbles/baseline/pipeline；ScreenshotProvider 与 SendCoordinator 仍是 desktop/PS1 职责（如实标注）；PrivacyManager 由 check-sensitive + sanitize 覆盖 |
| 11.3 缓存与性能（截图复用/哈希/识别缓存/模型复用/自适应频率/第二引擎按需/不重复启动 Python/限并发；不得旧图当新消息、不得漏消息、不得降安全检查频率；记录 P50/P95 与资源） | ✅ 部分 | 同帧复用、第二引擎按需、8s 低频轮询；P50/P95 已有 bench 数字；模型复用/缓存策略未做（task-14 给 Worker 评估结论） |

## 12. 第十二部分：OCR Benchmark

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 12.1 虚构语料覆盖 22 类场景；合成与真实分开统计 | 🚧 task-14 | 现有 20 场景×2 变体=40 图（seed 20261031 可重跑 SHA256 一致）；task-14 对照场景清单补齐 |
| 12.2 指标（CER/整句/漏读/假消息/错误联系人/重复/冲突/不确定/误改/P50-P95/CPU 内存） | 🚧 task-14 | CER/整句/行 P-R-F1/漏读/假消息/P50-P95 已有；错误联系人/冲突/不确定/误改/资源本轮补 |
| 12.3 A/B 六组（A v0.2.8 / B 预处理 / C 引擎 / D 对齐 / E 融合 / F 完整 v3），tune/eval 不重叠 | 🚧 task-14 | 现有 A/F 对照（eval 集 CER 37.37%→21.38%，整句 28.26%→47.83%）；B–E 单因素组本轮补 |
| 12.4 发布门槛 10 条 + OCR 独立数据集可测量改善 | ⚠️ 部分 | 10 条逐条写在 `docs/RELEASE-CHECKLIST.md`；OCR 门槛 2 在「合成语料 + 离线等价」口径下达成（−15.99pp CER / +19.57pp 整句），真实微信未验证——如实标注，不夸大 |

## 13. 第十三部分：用户体验

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 13.1 首次配置向导（10 步）且默认不真实发送 | ⚠️ | 已有首次向导（4 步：默认 mock + safeMode、可跳过）→ 步骤数少于 10，如实标注；默认 mock + safeMode 已达成 |
| 13.2 诊断中心（引擎/依赖/模型版本/可捕获/DPI/截图方式/耗时/错误/冲突数/二次识别/质量状态；默认不显示聊天内容） | 🚧 task-13 | 已有 GET /diagnostics/ocr（只读、白名单）与前端 Card；缺 DPI/截图方式/模型版本/冲突数/质量状态等字段 |
| 13.3 mock 人格模拟器 | ✅ | `/test/send` mockOnly + client 按钮（非 mock 禁用） |
| 13.4 安全模式（mock/只读诊断/仅生成草稿/人工确认/白名单自动回复；UI 标明、可随时暂停） | 🚧 task-12 | 已有 mock/safeMode/只读诊断；缺「仅生成草稿」「人工确认发送」——本轮加 draft/confirm 模式 |

## 14. 第十四部分：GitHub / CI / 发布准备

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 14.1 README 12 节 + Mermaid、无真实图片 | ✅ | `README.md` 12 节 + Mermaid |
| 14.2 定位文字避免未验证宣传 | ✅ | README 标注「3.0.0 开发中、private:true 不公开发布」；OCR 结论限定口径 |
| 14.3 文档清单（ARCHITECTURE/OCR-DESIGN/OCR-BENCHMARK/PRIVACY/SECURITY/MIGRATION-v3/TROUBLESHOOTING/CONTRIBUTING/RELEASE-CHECKLIST） | ✅ | 全部存在 |
| 14.4 CI ≥10 项（类型/单测/集成/OCR 基准/Windows 兼容/Build/API 验证/依赖安全/敏感扫描/发布包检查；不依赖真实账号） | 🚧 task-15 | 现有两 job（typecheck/test/check-sensitive/build/OCR 冒烟）；本轮补集成、依赖审计、发布包检查 |
| 14.5 Release 准备（更新日志/兼容/安装/迁移/已知限制/可复现构建/SHA256/干净包/回退；private:true 不得擅自公开；Release 需批准） | 🚧 task-15 | CHANGELOG [3.0.0] 已有；SHA256/可复现/干净包/回退流程本轮补文档（不实际发布） |

## 15. 第十五部分：执行顺序 A–G（每阶段独立提交 + 测试）

| 阶段 | 状态 | 提交 / 证据 |
| --- | --- | --- |
| A 审计与基线 | ✅ | `6eceaff`、`e49432d`；`docs/V3-AUDIT.md` |
| B OCR 架构重构 | ✅ | `0408860`；`src/core/ocr/*`、desktop 强类型化 |
| C OCR 算法与同帧 | ✅ | `e8316b2`、`325299f`；同帧/基线/气泡/ack、bench tune/eval |
| D 消息可靠性 | ✅ | `dfbc9c1`；暂停打断/三态/幂等雏形/去重 |
| E 安全 | ✅ | `364c57b`；鉴权/导入安全（SSRF 本轮补） |
| F 体验 | ✅ 部分 | `f63decc`；safeMode/诊断/向导/模拟器（draft/confirm 本轮补） |
| G 文档与发布准备 | ✅ 部分 | `646a2ba`；README/文档/CI（CI/发布包本轮补） |
| 收尾 | ✅ | `d2f9207` 版本 3.0.0 + 使用说明；`d9cf985` CHANGELOG + V3-AUDIT 快照 |

## 16. 第十六部分：最终报告 7 节

| 章节 | 状态 |
| --- | --- |
| 一、审计发现摘要 | ✅（`docs/V3-AUDIT.md`） |
| 二、OCR 优化报告（重点解释任务书 10 个问题）+ 三、数据对比 | ✅（`docs/OCR-BENCHMARK.md`，含 eval 集 A/F 对照；B–E 单因素组 task-14 补） |
| 四、代码修改说明 | ✅（`docs/ARCHITECTURE.md`、`docs/OCR-DESIGN.md`、提交历史） |
| 五、隐私与安全报告 | ✅（`docs/PRIVACY.md`、`docs/SECURITY.md`、check-sensitive） |
| 六、发布状态与门槛核对 | 🚧 本轮完成后更新（task-15 + RELEASE-CHECKLIST） |
| 七、Git 交付状态（SHA、未推送、测试命令） | ✅（见第 0 节；本轮提交后更新） |

## 当前已知残余风险（不掩盖）

1. **OCR 结论的适用范围**：所有提升来自「Pillow 合成语料 + 离线等价转写」，未在真实微信窗口跑过；真实设备回归需维护者在场授权。
2. **PS1 改动未实机**：`scripts/pwsh/wechat-uia.ps1` 的同帧/ack/气泡补丁只通过 PS5.1 语法解析与 TW 单测，未在真实微信上验证。
3. **RapidOCR 统一包适配未实测**：本机未安装 `rapidocr`，任务书 5.2 的迁移路径代码就绪但未在本机跑通（如实标注）。
4. **历史实名残留**：`9db6c5b` 已推送到 origin/master 的文档含真实姓名，改写历史需维护者决定（不擅自 force push）。
5. **Windows OCR 无置信度**：`confidence` 字段一律 undefined，不编造；置信度评分用可解释启发因子替代。

## 待维护者决定的事（3 件）

1. 是否 `git push` `feat/v3.0.0`（12+ 本地提交）。
2. 是否打 tag / 发 Release（`private: true` 不改公开；Release 需明确批准）。
3. 是否改写 git 历史清除 `9db6c5b` 的真实姓名残留（不可逆，需明确授权）。

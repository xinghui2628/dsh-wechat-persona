# 发布检查清单（v3.0.0）

> 用途：v3.0.0 是否达到「可发布」状态的唯一判定清单。门槛原文来自任务书 §12.4（10 条），逐条照抄后按**当前代码与实测**标注。
> 状态取值：**满足**（有代码 + 可复现证据）/ **未满足**（已知缺口）/ **未验证**（无证据，不能宣称通过）。
> 维护者：发布前必须重新执行 §4 的命令并把真实输出填进 §4；**不得用「测试全绿」替代 OCR 准确率结论**。
> **仓库公开性**：GitHub 仓库 `xinghui2628/dsh-wechat-persona` 为 **public**；`private: true` 仅表示不发布 npm，**不代表仓库私有**。公开 Git 历史风险见 [PRIVACY-REVIEW-PRE-RELEASE.md](PRIVACY-REVIEW-PRE-RELEASE.md) 与 [PII-INVENTORY.md](PII-INVENTORY.md)。

## 1. 结论

**10 条发布质量门槛全部满足；OCR 准确率专项「达成（限定口径）」；只读测试模式与安装包内容已做离线验收（`docs/PRE-RELEASE-INSTALL.md`）；唯一未完成项：真实设备验证未获用户授权，因此不得宣称「真实微信环境已可靠」。**

| 项 | 状态 | 说明 |
| --- | --- | --- |
| §2 的 1–10 条门槛 | **全部满足** | 证据见 §2、§4；工作区基线测试规模 **43 文件 / 729 用例**（2026-11-01 12:25 最终实测；发布前以最终重跑为准） |
| 仓库公开性 / 分发边界 | **已纠正并写清** | GitHub 仓库 **public**；`private: true` 只阻止 `npm publish`；公开历史中的疑似个人信息风险单独披露，不通过 private 隐藏。不得创建 tag/Release/npm 发布（未获维护者批准） |
| CI 十项门禁（任务书 §14.4） | **满足** | `.github/workflows/ci.yml` 逐项成步：typecheck / 单测 / 集成 / OCR 冒烟 / Windows 兼容 / build / API 验证 / 依赖审计 / 敏感扫描 / 发布包内容检查；本地逐步复跑见 §4-9，README §10 有映射表；CI 无私人微信/聊天图片/OneDrive/外部私人服务依赖 |
| 发布包干净度 | **满足（本地实测）** | `node scripts/check-package.mjs`：**189** 个候选文件（干净 checkout 受跟踪文件 ∩ `package.json files` + `dist/`），0 违规；**9** 个被 gitignore 的本地调试垃圾只警告、不入包（§4-7）。`npm pack --dry-run`（11:40 最终）：**192 文件 / 749,729 B / 解包 2,233,778 B，垃圾 0**；11:25 实际 pack 为 190 文件 / 705,755 B（SHA256 `64C229…` 仅该次构建）。与候选集的差集是**未跟踪**的 `docs/V3-PRIVACY-AND-DEVICE-READINESS.md`（说明 npm pack 会带上未提交文件，发布包仍按 §6.4 用受跟踪文件制作） |
| 安装包 / 版本一致性 | **满足（离线）** | `package.json` = `src/index.ts` = `dist/index.js` 均 **3.0.0**；解包后 `import dist/index.js` 成功、`migrateConfig` 可用、`client/client.js` 语法检查通过；详细 PASS/FAIL 表见 [PRE-RELEASE-INSTALL.md](PRE-RELEASE-INSTALL.md) |
| 只读测试模式（任务书 §五） | **满足（离线 mock 验收）** | `readOnlyTestMode=true` 时 `/test/send` 与 `/drafts/approve` 均 **409 `read-only-mode`**，草稿状态不变、无 `outbox.jsonl`；`/status`、`/config`、`security` 透出开关；mock 通道不拦（不触达真实微信）。离线 harness **14/14 PASS**（§4-11）。真实微信窗口下未验证 |
| 发送可靠性 / 幂等 / 草稿 | **满足（代码 + 单测）** | `src/core/send-state.ts`（10 态）、`src/core/send-ledger.ts`（`sendOperationId` 幂等、`unknown` 永不自动重发）、`sendMode=draft/confirm` 草稿队列与批准（`engine.ts` 的 `persistDraft()`/`approveDraft()`）均有单测；真实故障路径未实机演练（见门槛 10） |
| OCR 准确率附加条目 | **达成（限定「合成语料 + 离线等价」）** | 同一独立 eval 集 v3 CER 21.38% / 整句 47.83%，v0.2.8 基线 37.37% / 28.26%；跨口径也满足 CER ≤ 28.09% / 整句 ≥ 32.95%。**真实微信截图未验证**，见 §3 |
| 真实设备验证 | **未验证（需用户单独授权）** | Phase C（同帧/captureId/ack/气泡归属）、Phase E 鉴权、Phase F `safeMode`/诊断/向导、只读测试模式均有单测与离线验收，但真实微信端到端未跑 |

另：本清单全部通过也不等于可以对外分发或创建 Release；真实设备未验证前，对「真机可用性/防封效果」只能按「未验证」描述。四类状态划分见 §7。

## 2. 发布质量门槛（10 条）

> 行号说明：下表代码行号为 **2026-11-01 工作树快照**（HEAD `2823439` + 未提交改动）；并行开发会让行号漂移，
> 复核时以函数名 / `it()` 用例名定位为准。

| # | 门槛（原文） | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| 1 | 所有核心单元测试通过 | **满足** | `npm run test:sandbox`：**41 文件 / 678 用例全部通过**（2026-11-01 阶段 2 实测，exit 0，1.62s）；含 Phase C 新增 `test/core/ocr-{baseline,bubbles,pipeline,fusion,align,confidence,tracker}.test.ts`、`test/core/{send-state,send-ledger,persona-market}.test.ts`、`test/channels/desktop.test.ts`（39 用例，含 ack 水位线落盘/重放与置信度门禁）、`test/server/api.test.ts`（132 用例，含草稿接口/诊断/鉴权）与 `test/engine/acceptance.test.ts`（safeMode/OCR 诊断/草稿用例）。证据记录见 §4-2 |
| 2 | OCR 重试不改变消息基线 | **满足（代码 + 单测 + 脚本双向接线）** | 纯逻辑：`src/core/ocr/baseline.ts`（尾对齐/pending 队列/captureId/ack/稳定 id）、`bubbles.ts`（气泡归属）、`pipeline.ts`（可投递决策 + legacy 兼容）；`desktop.ts` 接线：`planInboundDispatch`、`ackArgs` 传 `-Ack`、`planRead`/`commitAck`，ack 水位线持久化到 `<dataDir>/desktop-ack.json`（懒加载 `loadAckState()`（:326）/串行落盘 `persistAckState()`（:341），跨进程重启读回）；**置信度门禁**：reject 不投递且**不推进 ack**，pending 下次重放（`desktop.ts:989-1002`；needRead 路径 :1085-1096）；脚本侧：`wechat-uia.ps1` 的 `-Ack` 参数、`captureId` 生成与输出、`Get-BubblePane/Get-BubbleSide`（:747-788）、稳定 id `pc-<captureSeq>-<messageSeq>-<几何哈希>`、`Save-State` 原子写（:1207-1230）、同帧 `-KeepImage`/分层 `-SecondOcr`；测试：`test/core/ocr-{baseline,bubbles,pipeline}.test.ts`、`test/channels/desktop.test.ts` Phase C describe（长气泡越线拒投、captureId 记录、`-Ack` 重放 id 稳定、12 条不截断、ack 落盘与重启读回）。残余：真实微信环境端到端未验证（由门槛 10 与 §1 覆盖） |
| 3 | 不存在已知的跨联系人错误发送路径 | **满足**（代码 + 回归测试层面） | 桌面发送必须拿会话列表行坐标，无坐标直接拒发：`src/channels/pc/desktop.ts` 的 `send()`（:1138 起；无行坐标 :1165-1170，错误文案 `缺少聊天定位信息…已拒绝发送以避免发错人`）；不再信任 `lastActiveContact`（`REL-P0-3` 注释 `desktop.ts:1161-1164`，原 180s 兜底已删）；发送参数不传 `-CurrentContact`（`desktop.ts:1198` 注释，避免脚本 trustedOpen 跳过标题 OCR）；回归测试 `test/channels/desktop.test.ts`（无行拒发/A 无坐标 P0-3 用例）。残余：脚本内 `trustedOpen` 分支仍存在（`wechat-uia.ps1:1691` 起），仅当显式传 `RowTop≤0` 且 `CurrentContact` 与 `Contact` 一致才触发，桌面通道不构造该条件；真实微信环境未验证（由门槛 10 覆盖） |
| 4 | 暂停后不能启动新的发送 | **满足** | 统一门禁 `engine.canSend()`（`src/engine/engine.ts:486`；paused/abort/breaker/budget/safeMode 全部拦截，safeMode 拦截在 :509；只读模式 `readOnlyTestMode` 拦截在 :501，仅拦非 mock 通道）；`engine.start()` 在暂停/熔断时保持不启动通道（`engine.ts:223-260`）；发送循环每个 part、每次重试前都重新门禁（`engine.ts:1383-1460`）；草稿批准也重走同一 `canSend`（`engine.ts:830-895`）；API 层 `/test/send` 暂停返回 409（`test/server/api.test.ts` 的「暂停时返回 409」用例）；只读模式 `/test/send` 与 `/drafts/approve` 硬拒 409（`api.ts:1732-1735`、`:1789-1792`，离线 harness 14/14，§4-11）；桌面通道 `send()` 只读第一行硬拒绝（`desktop.ts:1141-1146`）；聊天内 `/stop` 暂停后 0 次 LLM（`test/engine/acceptance.test.ts` 的 `/stop` 用例） |
| 5 | 发送结果 unknown 时不能盲目重发 | **满足** | `resolveSendDelivery`（`engine.ts:119`）缺省/非法一律保守 `unknown`；`canRetrySend`（`engine.ts:127`）只有 `not-sent` 才允许重试；发送循环最多 2 次尝试且 `unknown` 不重试、任一 part 失败中止整批；**幂等账本** `src/core/send-ledger.ts`：`shouldSend` 对 confirmed/cancelled/unknown 返回 false，failed 仅在 `delivery='not-sent'` 且 attempts<3 时允许；账本落 `dataDir/send-ledger.json`（只存文本哈希、上限 200），主回复与 `sendTest` 均接线（`engine.ts:1383-1460`、`:405` 起）。测试：`test/core/send-ledger.test.ts`、`test/core/send-state.test.ts`、`test/engine/acceptance.test.ts` 的「SendResult 投递三态工具函数」（:657）与 unknown 只发一次用例；通道层 `test/channels/desktop.test.ts` 三态用例；脚本层 `Fail-With` 输出 `delivery`，气泡未确认返回 `unknown` |
| 6 | 非授权 API 请求不能触发真实发送 | **满足** | 鉴权链：仅回环 socket + `x-dsh-wechat-persona: 1` + Host/Origin/Sec-Fetch-Site 防跨站 + 可选 apiToken + 进程内限速 429（`src/server/api.ts`；文档 [SECURITY.md](SECURITY.md)）。测试：`test/server/api.test.ts:487-660`（缺头/错值/非回环 → 403；错误 token → 401；跨站 Host/Origin/Sec-Fetch → 403；429）；`:689` 起 `/status` 暴露 `safeMode/sendMode/pendingDrafts/sendState`；`:1343` 暂停 409、`:1358` mockOnly 非 mock 通道 409；`:1372` 起逐端点「未授权不得触发」矩阵；`:1424-1474` `/diagnostics/ocr` 白名单字段/降级；`/drafts` 与 `/drafts/approve|reject` 走同一鉴权与门禁（批准重走 `canSend`）；safeMode 拒发：`test/engine/acceptance.test.ts:935-983`（真实通道 0 次 `channel.send`）；只读测试模式：`/test/send` 409「已拒绝一切真实发送」、`/drafts/approve` 409「已拒绝草稿批准发送」（`api.ts:1749-1752`/`:1806-1809`），离线验证无 `outbox.jsonl`（§4-11）；SSRF 防护另有 `test/core/persona-market.test.ts`（见 SECURITY §七） |
| 7 | 旧版本配置可以正确迁移 | **满足** | `migrateConfig`（`src/config.ts:483` 起；`sendMode` 迁移在 :541-545、`readOnlyTestMode` 在 :548-551、`ocrPipelineMode` 在 :553-556）幂等；测试 `test/core/config-migration.test.ts`：空配置补安全默认值、旧 onlineStart/End → 工作日/周末时段、幂等、保留显式开关、非法输入回落、旧 `reply.personaDir` 提示不丢人格库默认、**旧配置缺 `sendMode` 补默认 `auto`（保持旧行为）**。新增字段 `safeMode/onboardingDone/sendMode/apiToken/readOnlyTestMode/ocrPipelineMode` 均有默认值（`false/false/'auto'/''/false/'v3'`），旧配置无需手改。升级/回滚步骤见 [MIGRATION-v3.md](MIGRATION-v3.md) |
| 8 | 发布包不存在已知敏感数据 | **满足**（本次实测） | `node scripts/check-sensitive.mjs` 扫描 **212 个 git 受跟踪文本文件，0 命中，exit 0**（2026-11-01 阶段 2 复核，10:07 实测）；规则覆盖 wxid/本机路径/手机号/真实邮箱/密钥/疑似真实姓名，输出打码。发布维度另有 `node scripts/check-package.mjs`：只扫会进入发布包的 **189** 个文件（受跟踪 ∩ `files` + `dist/`），0 命中（§4-7）。说明：`dist/`、dataDir 不入库；`drafts.json`/`send-ledger.json`/`desktop-ack.json` 属运行时数据（gitignore 且被 check-package 黑名单覆盖），不会进包；OCR 语料截图为脚本合成的虚构内容（`scripts/ocr/gen_corpus.py`，seed 固定） |
| 9 | README 能正确指导 mock 安装 | **满足**（本地可复现） | README §5 安装（链接进 profile / plugin_manager 两种）与 §6 mock 快速开始（默认 mock、虚构白名单、`POST /test/inbound` 注入、`/status` 校验）；离线验收 `node scripts/verify-api.mjs`：**25/25 PASS**（§4-4），其中 mock 通道 `/test/inbound` 202、`/test/send` 200 且 `delivery:'sent'`。未在「全新干净机器」实测，宿主版本差异属门槛 10 的未验证范围 |
| 10 | 真实环境未验证的功能有明确说明 | **满足** | 未验证项在 README §3/§9/§10、ARCHITECTURE §14、本清单 §1/§3 与 [MIGRATION-v3.md](MIGRATION-v3.md)、[TROUBLESHOOTING.md](TROUBLESHOOTING.md)、[PRIVACY.md](PRIVACY.md)、[OCR-DESIGN.md](OCR-DESIGN.md) §11 中逐项标注；Phase C（同帧/captureId/ack/气泡归属/置信度门禁）、Phase E（鉴权 + SSRF 加固）、Phase F（`safeMode`、`GET /diagnostics/ocr`、首次配置向导、mock 测试入口）、发送状态机/幂等账本/草稿模式、只读测试模式（`readOnlyTestMode`）**已实现并有单测或离线验收**，但统一标注「真实微信环境未验证」；`fusion/align/tracker` 明确标注「已实现+单测、未接入生产读取路径」；OCR 准确率结论限定「合成语料 + 离线等价」并注明真实截图需授权复测；真实微信端到端测试明确要求用户单独授权 |

## 3. OCR 准确率专项（附加发布条件）

任务书要求：必须在**同一独立数据集**上证明 v3.0.0 完整方案相对 v0.2.8 有**可测量且具有实际意义**的改善；
改善不明显，不能仅因测试全绿宣称算法优化成功；真实设备测试需**用户单独授权**。

| 项 | 数值 / 状态 | 来源 |
| --- | --- | --- |
| 数据集 | `test/fixtures/ocr-corpus/`：20 场景 × 2 变体 = 40 张，seed=20261031，全虚构内容；tune/eval 不重叠，**只报 eval**（10 场景 / 20 图 / 46 条消息） | [OCR-BENCHMARK.md](OCR-BENCHMARK.md) §6.5 |
| v0.2.8 基线（同 eval 集） | CER **37.37%**、整句准确率 **28.26%** | OCR-BENCHMARK.md §6.5 |
| WinRT 2x 首读（v3 管线第一步） | CER 24.84%、整句 47.83% | 同上 |
| RapidOCR 原始（可选第二引擎） | CER 1.30%、整句 89.13%、P50 1463ms / P95 2107ms | 同上 |
| v3 完整方案（结论行 vote-garbled） | **CER 21.38%、整句 47.83%**（46 条消息；可疑 9 条，第二引擎替换 0、桌面投票 0、纠错 0） | 同上 |
| v3 上界（vote-all，仅参考） | CER 17.71%、整句 63.04%（替换 8、投票 2；不能当作在线可达） | 同上 |
| 相对同集 v0.2.8 | CER **−15.99pp**、整句 **+19.57pp**；逐消息 27 改善 / 16 持平 / 3 变差 | 同上 |
| 跨口径门槛对照 | 21.38% ≤ 28.09% 且 47.83% ≥ 32.95% → **两条均满足** | 本清单 |
| **结论** | **达成（限定「合成语料 + 离线等价」）**：改善主要来自 WinRT 2x 放大 + CJK 字间空格归一；第二引擎融合与受控纠错在该语料几乎未触发，**独立收益未被证明**；样本小（单条消息约 2pp）、无真实 pane/消息分组、真实微信截图未测 | 本清单与 OCR-BENCHMARK.md §6.5 |

注意：本次仅做 1 张图的冒烟（§4-5），**冒烟结果（单图 CER 10.53%）不构成精度结论**。task-14（bench-builder）仍在补预处理 A–H / 语料覆盖，发布前应以其定稿后的 [OCR-BENCHMARK.md](OCR-BENCHMARK.md) 最终版为准；本清单不引用未定稿的新数字。

## 4. 执行记录（2026-10-31 实测 + 2026-11-01 阶段 2 / task-25 复核）

环境：Windows 11（本机）、Node v26.13.0、npm 11.20.0、分支 `feat/v3.0.0`。
2026-10-31 记录对应 v3.0.0 各阶段改动（当时未提交）；2026-11-01 **阶段 1** 复核对应 HEAD `d9cf985`（12 个本地提交，未 push）；
2026-11-01 **阶段 2** 复核对应 HEAD `28d3a89` + task-12/13/14 未提交改动；**task-25（发布前安装验收）** 复核对应
HEAD `2823439`（42 个本地提交、领先 `origin/master` 21 个提交）+ task-25/26 未提交改动（工作区）。

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run typecheck` | exit 0，无报错（阶段 2 复核同） |
| 2 | `npm run test:sandbox` | 阶段 2：**41 文件 / 678 用例通过**，1.62s，exit 0（`test/server/api.test.ts` 132、`test/channels/desktop.test.ts` 39 等；新增 send-state/send-ledger/fusion/align/confidence/tracker/persona-market 测试） |
| 3 | `node scripts/check-sensitive.mjs` | 扫描 **212** 个受跟踪文本文件，**0 命中**，exit 0（2026-11-01 阶段 2 复核，10:07 实测；新增未跟踪文件需 `git add` 后再跑） |
| 4 | `node scripts/verify-api.mjs` | **25/25 PASS**，exit 0（mock 通道收/发、暂停/恢复、鉴权 403、`/diagnostics/ocr`、config/personas/market/stickers/help；需先 `npm run build`，旧 dist 会报 `/health` 0.2.8） |
| 5 | `node scripts/ocr/bench.mjs --engine=winrt --limit=1 --scenario=clear --pipeline=raw` | exit 0，总耗时 1.2s；winrt orig 单图 CER 10.53% / 行 F1 1.000 / P50 26ms（仅冒烟） |
| 6 | `npm run build` | exit 0；重建后 `GET /health` 返回 `version=3.0.0`（重建前旧 `dist/` 仍报 0.2.8 —— 发版前必须重新 build 并重载插件） |
| 7 | `node scripts/check-package.mjs` | exit 0：候选 **189** 个文件（受跟踪 ∩ `files` + `dist/`），**0 违规**；警告 8 条（`scripts/pwsh/wechat-uia.ps1.bak-*` ×4、`scripts/**/__pycache__/*.pyc` ×4，均被 gitignore 且已被 `package.json files` 排除，不进发布包） |
| 8 | `npm audit --omit=dev --audit-level=high` | exit 0，**found 0 vulnerabilities**（生产依赖仅 `@deepseek-ai/schemastery`；peer `cordis` 由宿主提供） |
| 9 | CI 十项本地等价复跑 | typecheck、单测子集、集成子集（engine+server+channels）、Windows 兼容（4 个 .ps1 均带 UTF-8 BOM）、build、verify-api、audit、check-sensitive、check-package、OCR 冒烟逐项通过 |
| 10 | 阶段 2 全量门禁 | `typecheck` exit 0；`test:sandbox` **41 文件 / 678 用例全过**（1.59s）；`check-sensitive` **157 文件 0 命中**（阶段 2 时点；task-25 复跑为 **212 文件 0 命中**，见行 11）；`check-package` **189 候选 0 违规**（8 条 gitignore 垃圾警告；发布包 files 已排除本地垃圾）；文档相对链接 0 缺失；`ci.yml` YAML 解析通过（2026-11-01，工作区含未提交改动，最终数字以提交后重跑为准） |
| 11 | task-25 安装验收全量复跑（2026-11-01 11:25–11:27） | `npm run typecheck` **exit 0**；`npm run test:sandbox` **41 文件 / 678 用例全过**（1.63s）；`node scripts/check-sensitive.mjs` **212 个受跟踪文本文件 0 命中**（exit 0）；`node scripts/check-package.mjs` **189 候选 0 违规**（exit 0，8 条 gitignore 垃圾仅警告）；`npm run verify:api` **25/25 PASS**（exit 0）；`npx vitest run test/core/config-migration.test.ts` **10/10 passed**；`npm pack --dry-run` **190 文件 / 705,755 B / 解包 2,122,201 B**，实际 pack tarball 同尺寸、SHA256 `64C229C1945C8C0646A213EC37F5C98D94D1F4E340D1C6704AD3E88E5015819B`，`tar -tf` 坏文件 0；解包复制到临时 `node_modules`（复用宿主 `@deepseek-ai` 依赖）后 `import dist/index.js` **OK**（name/provide/apply）、`migrateConfig` **OK**（sendMode=auto/readOnlyTestMode=false/ocrPipelineMode=v3/changed=true）、`node --check client/client.js` **exit 0**；只读模式离线 harness **14/14 PASS**（`/test/send`、`/drafts/approve` 均 409 `read-only-mode`，无 `outbox.jsonl`）。详见 [PRE-RELEASE-INSTALL.md](PRE-RELEASE-INSTALL.md) |
| 12 | task-25 收尾最终门禁（2026-11-01 11:40） | `npm run typecheck` **exit 0**；`npm run test:sandbox` **42 文件 / 709 用例全过**（2.59s，exit 0）；`check-sensitive` **212 文件 0 命中**；`check-package` **189 候选 0 违规**（9 条 gitignore 垃圾警告）；`npm pack --dry-run` **192 文件 / 749,729 B / 解包 2,233,778 B、垃圾 0**；`verify:api` **25/25**；说明：工作区仍有并行未提交改动（`src/**`/`test/**`）与未跟踪文档，最终发布前需按 §6 重建并重跑 |
| 13 | **beta.1 最终门禁**（2026-11-01 12:15–12:25，含 `betaSafeMode` 四层闸门） | `typecheck` **exit 0**；`test:sandbox` **43 文件 / 729 用例全过**（含 API 安全字段保护 4 条新用例）；`check-sensitive` **222 文件 0 命中**；`check-package` **197 候选 0 违规**；`verify:api` **25/25**；`build` exit 0；发布候选包最终附件以 Release `SHA256SUMS.txt` 为准；干净模拟安装 19/19、回滚通过；真实 DSH profile 安装与真实微信未验证 |

复现命令（发布前完整跑一遍，顺序建议）：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run test:sandbox
git add -A
node scripts/check-sensitive.mjs
npm run build
node scripts/verify-api.mjs
node scripts/check-package.mjs
npm audit --omit=dev --audit-level=high
node scripts/ocr/bench.mjs --engine=winrt --limit=1 --scenario=clear --pipeline=raw
# 全量 A/B（需 Python + Pillow + rapidocr_onnxruntime；--split=eval 只跑独立评估集）：
# node scripts/ocr/bench.mjs --engine=all --pipeline=all --split=eval
```

CI 对应关系：`.github/workflows/ci.yml` 的 `verify-windows` job 覆盖任务书 §14.4 十项：
typecheck → 单测（`test/core`+`test/client`）→ 集成（`test/engine`+`test/server`+`test/channels`）→
Windows 兼容（版本 + .ps1 UTF-8 BOM）→ build → API 验证 → 依赖审计 → 敏感扫描 → 发布包内容检查 →
OCR 冒烟（WinRT/Pillow 不可用时显式 marked skip）。`linux-guard` 覆盖 typecheck/沙箱测试/敏感扫描并显式
声明 OCR 冒烟在 Linux 跳过。CI 不联网访问真实微信/私人服务，也不发布。

## 5. 发布动作检查（人工）

- [x] §2 的 1–10 全部为「满足」
- [x] §3 的独立 eval 集 A/B 有可复现结论且跨口径显著优于 v0.2.8 基线（限定合成语料 + 离线等价）
- [x] 发送状态机 / 幂等账本 / 草稿（draft/confirm）有单测，unknown 不自动重发、同 opId 只发一次、批准重走门禁（§2 门槛 5、§4-10）
- [x] 只读测试模式离线验收：`readOnlyTestMode=true` 时 `/test/send` 与 `/drafts/approve` 均返回 **409 `read-only-mode`**，草稿状态不变、无 `outbox.jsonl`；mock 通道不拦（不触达真实微信）（§4-11）
- [x] 仓库公开性已复核并写清：GitHub 仓库 **public**；`private: true` 仅表示不发布 npm，不构成仓库私有；公开历史风险链接 [PRIVACY-REVIEW-PRE-RELEASE.md](PRIVACY-REVIEW-PRE-RELEASE.md)
- [ ] 真实设备验证已取得用户单独授权，且结果记录在案（当前未授权；**未授权前不得对外宣称真机可用/防封有效**）
- [ ] `CHANGELOG.md` 已写 3.0.0 变更；`package.json`、`src/index.ts`、`dist/index.js` 的版本号三处一致（当前实测均为 3.0.0，任务书要求 §8）
- [ ] 重新 `npm run build` 并用新 `dist` 重启/重载插件后 `/health` 返回 3.0.0
- [ ] 确认 `git status` 不含个人数据目录、调试截图、`dev-notes/`、`.dsh-tmp/`、`backups/`（这些均不入库）
- [ ] 维护者确认仓库公开性口径（GitHub public、`private: true` 仅 npm），且未创建 tag/Release/npm 发布
- [x] 发布包内容检查通过（`node scripts/check-package.mjs`：189 个候选 0 违规，§4-7）
- [x] `npm pack` 实测：`files` 排除项生效（`.bak`/`__pycache__`/`.pyc` 垃圾 0）；但 pack 会带上未跟踪文件（与候选集差 1），发布包仍按 §6.4 用受跟踪文件+`dist` 制作
- [x] 生产依赖安全审计通过（`npm audit --omit=dev --audit-level=high`：0 漏洞，§4-8）
- [ ] 按 §6.2 在同一环境重复构建并比对 `dist-SHA256SUMS.txt`（可复现构建复核，未做）
- [ ] 按 §6.4 生成干净发布包与 SHA256SUMS 并归档；`Get-FileHash` 复核发布包哈希（未做）
- [ ] 按 §6.5 在受控环境演练回退到 v0.2.8（未演练前不承诺回退可用）

## 6. 发布准备（任务书 §14.5，只写文档，未实际发布）

> **边界**：GitHub 仓库为 **public**；`private: true` **仅表示不发布 npm**，不代表仓库私有。本节所有操作由维护者在**明确批准**后、
> 在受控环境手动执行；当前状态 = **文档与打包机制已就绪，但未打 tag、未创建 Release、未实际发布、未 `npm publish`**。
> 公开 Git 历史不可通过 private 设置撤回（风险见 [PRIVACY-REVIEW-PRE-RELEASE.md](PRIVACY-REVIEW-PRE-RELEASE.md)）。
> 真实设备验证未获授权前，发布说明只能按「未验证」描述真机可用性/防封效果。

### 6.1 发布说明必须包含的内容

| 项 | 要求 | 现状 / 来源 |
| --- | --- | --- |
| 更新日志 | v3.0.0 变更分类（OCR、发送可靠性、API 鉴权、安全模式/诊断/向导、文档与 CI） | `CHANGELOG.md` 已写；不得写成「已真机验证」 |
| 兼容性 | 数据文件、配置字段、行为变化、桌面通道语义变化 | [MIGRATION-v3.md](MIGRATION-v3.md) §0/§4/§5 |
| 安装方式 | 链接进 profile / `plugin_manager` 两种；必须先 `npm run build` | README §5 |
| 配置迁移 | `migrateConfig` 幂等、新字段默认值、旧字段保留 | MIGRATION-v3 §4 + `src/config.ts:422` |
| 已知限制 | 真实微信未验证；OCR 仅合成语料+离线等价；表情/图片/语音不支持；仅 Windows 桌面通道 | README §3/§9/§10、[ARCHITECTURE.md](ARCHITECTURE.md) §14、本清单 §1/§3 |
| OCR 数字 | 只报 eval 集口径并注明局限，不得外推真机准确率 | [OCR-BENCHMARK.md](OCR-BENCHMARK.md) §6.5 |
| 校验和 | 发布包 SHA256 + 构建清单 | 本节 §6.3/§6.4 |

禁止出现的表述：零封号 / 永不误发 / 100% 识别准确 / 真机已验证 / 已通过微信官方兼容性。

### 6.2 可复现构建

前置：同一台/同类 Windows 10/11 环境、**Node 22.x**、npm 版本与 `package-lock.json` 一致、`git status` 无未提交源码改动。

```powershell
git rev-parse HEAD                      # 记录 commit SHA（发布说明里写明）
node --version; npm --version           # 记录运行时
npm ci --ignore-scripts --no-audit --no-fund   # 严格按锁文件安装，失败不默认回退
npm run build
# 生成 dist 构建清单（用于比对两次构建是否一致）
$distFiles = Get-ChildItem dist -Recurse -File | Sort-Object FullName
$distFiles | ForEach-Object {
  "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.FullName.Substring($PWD.Path.Length + 1).Replace('\','/'))"
} | Set-Content dist-SHA256SUMS.txt -Encoding ascii
Get-FileHash dist-SHA256SUMS.txt -Algorithm SHA256
```

要求：

- `npm run build` 必须 exit 0；`dist/` 文件数以实测为准（阶段 1 为 **94** 个；阶段 2 新增 `send-state/send-ledger/ocr/{fusion,align,confidence,tracker}` 等模块后会增加，发布前用 `Get-ChildItem dist -Recurse -File | Measure-Object` 回填并核对 `check-package.mjs` 候选数）。
- 在同一环境重复一次（清理 `dist/` 后重建），两次 `dist-SHA256SUMS.txt` 应**完全一致**；
  不一致必须排查（tsc/依赖版本漂移、产物含时间戳等），**不允许把差异当作「构建波动」放过**。
- 本仓库不提交 `dist/`；发布包必须包含本次构建产物与构建清单。
- 只在同一 Node/npm/lock 环境内验证过确定性；跨 OS 的 bit 级一致性未验证，不要承诺。

### 6.3 SHA256 校验

```powershell
Get-FileHash .\dsh-wechat-persona-3.0.0.zip -Algorithm SHA256
# 或：certutil -hashfile .\dsh-wechat-persona-3.0.0.zip SHA256
# Linux/macOS：sha256sum dsh-wechat-persona-3.0.0.zip
```

- 生成 `SHA256SUMS.txt`（格式 `<hash>  <file>`，与安装包同目录分发），把官方 hash 写进发布说明；
  本仓库不擅自创建公开 Release，hash 只随受控分发提供。
- 使用者/另一台机器收到包后必须重新计算并比对；不一致**禁止安装**。
- 机制已验证（**dry-run，不是发布包**）：task-25（11:25）实际 `npm pack` 190 文件 / 705,755 B，解包到临时目录核对（SHA256 `64C229…`，仅该次构建）；收尾（11:40）`npm pack --dry-run` 192 文件 / 749,729 B / 解包 2,233,778 B、垃圾 0。上述数字均**不是发布值**，发布前须按最终代码重建后重新计算。

### 6.4 干净发布包制作（Windows，推荐「受跟踪文件 + dist」精简包）

前置门禁全部通过：

```powershell
git status --short                       # 应为空（dist/ 不提交）
npm run typecheck
npm run test:sandbox
npm run build
node scripts/check-sensitive.mjs
node scripts/check-package.mjs
npm audit --omit=dev --audit-level=high
```

> **发布包优先基于「git 受跟踪文件 + 本次 dist 构建产物」制作**（可复现、可逐文件清单校验）。
> 此前实测 `npm pack` 会把 `files` 目录（如 `scripts/`）下被 `.gitignore` 忽略的调试垃圾
> （`*.bak-*`、`__pycache__/*.pyc`）一起打进 tarball；v3.0.0 已在 `package.json files` 中排除
> `!**/*.bak-*`、`!**/__pycache__`、`!**/*.pyc`，task-25 复测 **pack 192 文件（11:40 dry-run）/ 190 文件（11:25 实际）、垃圾 0**（排除项生效）。
> 但 `npm pack` 仍会把**未跟踪文件**打进包（task-25 实测与候选集差 1 个未跟踪 docs 文件），
> 因此发布包不要依赖 `npm pack`，按本节用受跟踪文件制作。

```powershell
$ver = (Get-Content package.json -Raw | ConvertFrom-Json).version
$out = Join-Path $env:TEMP "release-$ver"
if (Test-Path $out) { Move-Item $out "$out.old" -Force }
$stage = Join-Path $out "dsh-wechat-persona-$ver"
New-Item -ItemType Directory $stage -Force | Out-Null

# 1) 取 git 受跟踪文件，按 package.json files 白名单筛出运行时会用到的文件
$filesField = @((Get-Content package.json -Raw | ConvertFrom-Json).files)
$tracked = @(git -c core.quotepath=false ls-files)
$included = $tracked | Where-Object {
  $rel = $_
  ($filesField -contains $rel) -or
  ($filesField | Where-Object { $rel.StartsWith($_ + '/') })
}
$included += @('package.json', 'LICENSE') | Where-Object { $tracked -contains $_ }   # npm 默认随包附带
foreach ($rel in $included) {
  $dest = Join-Path $stage $rel
  New-Item -ItemType Directory (Split-Path $dest) -Force | Out-Null
  Copy-Item $rel $dest -Force
}
# 2) 加入本次构建产物
Copy-Item dist (Join-Path $stage 'dist') -Recurse
```

> 期望文件数：**189**（= `check-package.mjs` 的候选集，§4-7；候选数随发布包文件集变化，最终以实测 189 为准）。
> 若想连测试/文档一起归档，可用「整仓归档」变体：`git archive --format=tar --prefix="dsh-wechat-persona-$ver/" HEAD | tar -x -C $stageRoot`
> 再复制 `dist/`——同样只含受跟踪文件，不含任何忽略垃圾。

```powershell
# 3) 发布包垃圾复核（黑名单命中即中止）
$banned = Get-ChildItem $stage -Recurse -File | Where-Object {
  $_.Name -match '(\.bak($|-)|\.bak-\d+|\.log$|\.pyc$|\.tmp$|\.zip$|^state\.json$|^audit.*\.jsonl$|^alerts\.jsonl$|^drafts\.jsonl$|^outbox\.jsonl$|^inbound\.jsonl$|^deferred-inbound\.json$|^(desktop-ack|desktop-delivered)\.json$|^api-token$|^uia-state\.json$|^list-preview\.json$)'
}
if ($banned.Count -gt 0) { throw "发布包含垃圾/数据文件：$($banned.FullName -join '、')" }

# 4) 打包 + 校验和
$zip = Join-Path $out "dsh-wechat-persona-$ver.zip"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  dsh-wechat-persona-$ver.zip" | Set-Content (Join-Path $out 'SHA256SUMS.txt') -Encoding ascii
```

```powershell
# 5) 归档内容抽查（应含 package.json / dist/index.js / README.md / cordis.patch.yml）
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead($zip).Entries |
  Select-Object -ExpandProperty FullName | Select-Object -First 30
```

完成标准：包文件数/内容与 `check-package.mjs` 清单一致、垃圾黑名单 0 命中、`SHA256SUMS.txt` 与 zip
放在仓库外的受控目录；把包 hash、commit SHA、构建环境（Node/npm）记录进发布说明。

### 6.5 回退到 v0.2.8（发布前必须演练一次）

前提：升级前已按 [MIGRATION-v3.md](MIGRATION-v3.md) §1 备份**整个数据目录**（另存 `uia-state.json` 与配置原文）；
本机存在 tag `v0.2.8`（`git tag -l v0.2.8` 已确认；不可回退前先 `git fetch --tags` 确认远端 tag）。

```powershell
# 0) 停：插件设置页暂停/停止引擎，确认微信无在途自动操作
# 1) 备份 v3 数据与配置（不要原地覆盖；整目录改名）
# 2) 切回旧版
git switch --detach v0.2.8
# 3) 安装旧版依赖并构建（旧 tag 的 lockfile 若与当前 npm 不兼容，npm ci 会明确报错；
#    此时才允许显式改用 npm install --ignore-scripts —— 不允许静默回退掩盖问题）
npm ci --ignore-scripts --no-audit --no-fund
npm run build
# 4) 重启 DSH（或关 2 秒再开插件开关），验证 /health 返回 version=0.2.8
# 5) 用升级前备份「恢复数据目录」（v3 新增的 desktop-ack.json / uia-state.json 新字段
#    不保证被 v0.2.8 识别；以备份整目录替换最稳）
```

验证与风险：

- `GET /health` 的 `version` 必须回到 `0.2.8`；mock 注入一条消息能看到回复即表示基本可用。
- v0.2.8 无 `safeMode`/`/diagnostics/ocr`/ack 持久化，功能降级属预期；真实微信环境下的回退
  **未演练**（本次仅文档准备），不得对外承诺「可无痛回退」。
- 回退后如需再升级，重复 [MIGRATION-v3.md](MIGRATION-v3.md) 步骤；数据目录始终以备份副本恢复，不原地覆盖。

### 6.6 批准与边界

- [ ] 维护者明确批准本次发布（记录批准日期、commit SHA、包 hash）
- [ ] 确认 `package.json` 仍为 `private: true`、无 `publishConfig`、未执行 `npm publish`
- [ ] 未获明确批准不得创建公开 GitHub Release / 打发布 tag / 分发给第三方
- [ ] 真实设备验证（用户单独授权）结果已记录，或在发布说明中明确「未验证」

## 7. 四类状态表与发布阻断清单（task-25 发布前验收）

> 任务书要求：最终报告必须用四类状态区分——**已验证 / 待验证 / 需要用户授权 / 不得发布**；
> 并给出「哪些解决前不能发布、哪些可标注限制」的阻断清单。以下为 2026-11-01 task-25 的当前结论，随代码变动需重跑更新。

### 7.1 已验证（有命令与输出证据）

| 项 | 证据 | 记录 |
| --- | --- | --- |
| TypeScript 类型检查 | `npm run typecheck` exit 0 | §4-11 |
| 单元 + 集成测试 | `npm run test:sandbox`：42 文件 / 709 用例全过（2.59s） | §4-12 |
| 敏感信息扫描 | `check-sensitive`：212 个受跟踪文本文件，0 命中，exit 0 | §4-12 |
| 发布包内容检查 | `check-package`：189 候选文件，0 违规，exit 0（9 条 gitignore 垃圾仅警告） | §4-12 |
| API 离线验收 | `verify-api`：25/25 PASS（mock 收/发、鉴权、暂停/恢复、诊断） | §4-12 |
| 配置迁移 | `config-migration.test.ts`：10/10 passed；dist 探针 `sendMode=auto`、旧字段保留、二次迁移幂等 | §4-11 |
| 版本一致性 | `package.json` / `src/index.ts:83` / `dist/index.js:41` 均为 3.0.0 | §4-11 |
| 发布包可解包可导入 | `npm pack --dry-run` 192 文件/749,729 B（垃圾 0）；11:25 实际 pack 190 文件/705,755 B，解包后 `import dist/index.js` OK、`migrateConfig` OK、`node --check client/client.js` exit 0 | §4-11/§4-12 |
| 只读测试模式 | 离线 harness 14/14 PASS：`/test/send` 与 `/drafts/approve` 均 409 `read-only-mode`、无 `outbox.jsonl`、mock 不拦 | §4-11 |
| 文档与 CI 语法 | 文档相对链接 0 缺失；`ci.yml` YAML 解析通过 | §4-11 |

### 7.2 待验证（有实现/文档，但缺真实或完整环境证据）

- 真实微信窗口下的 Phase C 端到端（同帧 OCR、captureId/ack、气泡归属、置信度门禁、pending 重放）。
- 真实通道下 `safeMode` / `readOnlyTestMode` 的拒发表现（离线 harness 只覆盖 mock 通道与 HTTP 层）。
- OCR 准确率：仅合成语料 + 离线等价（v3 CER 21.38% / 整句 47.83%），**真实微信截图未测**。
- 真实故障路径：DSH 重启、脚本超时、子进程异常时的幂等账本/状态机行为（单测覆盖逻辑，未做故障注入）。
- 全新干净机器安装（本轮离线 tarball `npm install` 因 ENOTCACHED 失败，改用解包+复用宿主依赖验证 import）。
- 卸载/回退流程（仅文档化，未在真实 profile/微信环境演练；回退 v0.2.8 未演练）。
- 跨 OS/跨版本一致性、`fusion/align/tracker` 未接入生产读取路径不参与线上评估。

### 7.3 需要用户单独授权

- 真实微信设备测试（测试小号 + 虚构语料；按 [OCR-REAL-DEVICE-TEST-PLAN.md](OCR-REAL-DEVICE-TEST-PLAN.md) 的授权门槛逐步执行）。
- 被动截图 / 交互式读取 / 发送模式实机验证（会改变已读、焦点或触达真实会话）。
- 上传截图/聊天记录等私人数据到任何外部服务。
- 打发布 tag / 创建 GitHub Release / `npm publish` / 对外分发。

### 7.4 不得发布（阻断项与约束）

**当前阻断发布动作的条件（不是「代码不可用」，而是「不得对外发布/不得宣称」）**：

| # | 阻断项 | 当前状态 | 解除条件 |
| --- | --- | --- | --- |
| B1 | 真实设备验证未授权 | **未满足** | 用户单独授权并按实机方案执行、结果记录在案 |
| B2 | 公开 Git 历史疑似个人信息（`9db6c5b` 等） | **未处理**（不可通过 private 隐藏） | 隐私审计/处置方案经用户确认；发布说明显式披露 |
| B3 | 最终发布包未基于最终代码重建 | **未完成** | 最终代码冻结后 `npm run build`，按 §6.4 用受跟踪文件+`dist` 制包并记录 SHA256 |
| B4 | 可复现构建双次比对、SHA256 发布包归档、回退演练 | **未完成**（仅机制 dry-run） | 按 §6.2/§6.3/§6.5 执行并归档证据 |
| B5 | 发布 tag / Release / `npm publish` 未获批准 | **未授权** | 维护者明确批准 |

**可标注限制后发布（若维护者决定在无真机验证下发布）**：必须在发布说明写清「真实微信未验证、OCR 仅合成语料、
发送可靠性未实机演练、只读模式仅离线验收」，并禁止使用「零封号 / 永不误发 / 100% 识别」等表述。
**任何重跑出现失败（typecheck/test/check-sensitive/check-package/verify-api）都视为新增阻断项，必须修复后重新记录。**

## 8. 签署

| 角色 | 结论 | 日期 | 依据（commit/tag） |
| --- | --- | --- | --- |
| 文档/CI（本清单维护） | 10 条门槛满足；OCR 专项达成（限定口径）；CI 十项与发布包检查（§6）文档就绪；发送可靠性/幂等/草稿/只读模式有单测或离线验收；真实设备未授权 → 不宣称真机可用；发布包已验证可解包可导入；最终门禁 42 文件/709 用例、212 文件 0 敏感命中、189 候选 0 违规、pack dry-run 192 文件垃圾 0（11:40） | 2026-11-01 | `2823439`（42 提交，领先 origin/master 21）+ task-25 未提交改动（§4） |
| 代码评审 | 待填 | 待填 | 待填 |
| 维护者 | 待填 | 待填 | 待填 |

变更记录：本清单随每次发布更新状态与 §4 实测输出；新增/修改门槛必须给出原文出处。

# 发布检查清单（v3.0.0）

> 用途：v3.0.0 是否达到「可发布」状态的唯一判定清单。门槛原文来自任务书 §12.4（10 条），逐条照抄后按**当前代码与实测**标注。
> 状态取值：**满足**（有代码 + 可复现证据）/ **未满足**（已知缺口）/ **未验证**（无证据，不能宣称通过）。
> 维护者：发布前必须重新执行 §4 的命令并把真实输出填进 §4；**不得用「测试全绿」替代 OCR 准确率结论**。

## 1. 结论

**10 条发布质量门槛全部满足；OCR 准确率专项「达成（限定口径）」；唯一未完成项：真实设备验证未获用户授权，因此不得宣称「真实微信环境已可靠」。**

| 项 | 状态 | 说明 |
| --- | --- | --- |
| §2 的 1–10 条门槛 | **全部满足** | 证据见 §2、§4；测试规模 34 文件 / 548 用例 |
| OCR 准确率附加条目 | **达成（限定「合成语料 + 离线等价」）** | 同一独立 eval 集 v3 CER 21.38% / 整句 47.83%，v0.2.8 基线 37.37% / 28.26%；跨口径也满足 CER ≤ 28.09% / 整句 ≥ 32.95%。**真实微信截图未验证**，见 §3 |
| 真实设备验证 | **未验证（需用户单独授权）** | Phase C（同帧/captureId/ack/气泡归属）、Phase E 鉴权、Phase F `safeMode`/诊断/向导均有单测与离线验收，但真实微信端到端未跑 |

另：本仓库 `private: true`，**不公开发布、不发 npm**；本清单全部通过也不等于可以对外分发。真实设备未验证前，对「真机可用性/防封效果」只能按「未验证」描述。

## 2. 发布质量门槛（10 条）

| # | 门槛（原文） | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| 1 | 所有核心单元测试通过 | **满足** | `npm run test:sandbox`：**34 文件 / 548 用例全部通过**（2026-10-31 实测，exit 0，1.86s）；含 Phase C 新增 `test/core/ocr-{baseline,bubbles,pipeline}.test.ts`（19+10+9 用例）、`test/channels/desktop.test.ts`（34 用例，含 ack 水位线落盘/重放）、`test/server/api.test.ts`（121 用例）与 `test/engine/acceptance.test.ts`（Phase F safeMode/OCR 诊断用例）。证据记录见 §4-2 |
| 2 | OCR 重试不改变消息基线 | **满足（代码 + 单测 + 脚本双向接线）** | 纯逻辑：`src/core/ocr/baseline.ts`（尾对齐/pending 队列/captureId/ack/稳定 id）、`bubbles.ts`（气泡归属）、`pipeline.ts`（可投递决策）；`desktop.ts` 接线：`planInboundDispatch`（:36）、`ackArgs` 传 `-Ack`（:560-563）、`planRead`、`commitAck`（:602-607），ack 水位线持久化到 `<dataDir>/desktop-ack.json`（懒加载 :282-294 / 串行落盘 :297-303，跨进程重启读回）；脚本侧：`wechat-uia.ps1` 的 `-Ack` 参数、`captureId` 生成与输出、`Get-BubblePane/Get-BubbleSide`（:747-788）、`Save-State` 原子写（:1207-1230）、pending 重放、同帧 `-KeepImage`/`-SecondOcr`；测试：`test/core/ocr-{baseline,bubbles,pipeline}.test.ts`（19+10+9）、`test/channels/desktop.test.ts` Phase C describe（:669 起：长气泡越线拒投、captureId 记录、`-Ack` 重放 id 稳定、12 条不截断、ack 落盘与重启读回）。残余：真实微信环境端到端未验证（由门槛 10 与 §1 覆盖） |
| 3 | 不存在已知的跨联系人错误发送路径 | **满足**（代码 + 回归测试层面） | 桌面发送必须拿会话列表行坐标，无坐标直接拒发：`src/channels/pc/desktop.ts:815-822`（`缺少聊天定位信息…已拒绝发送以避免发错人`）；不再信任 `lastActiveContact`（`REL-P0-3` 注释 `desktop.ts:815`，原 180s 兜底已删）；发送参数不传 `-CurrentContact`（`desktop.ts:852`，避免脚本 trustedOpen 跳过标题 OCR）；回归测试 `test/channels/desktop.test.ts:225`（无行拒发）与 `:274`（P0-3：最近活跃恰好是目标但无行坐标也拒发）。残余：脚本内 `trustedOpen` 分支仍存在（`wechat-uia.ps1:1691` 起），仅当显式传 `RowTop≤0` 且 `CurrentContact` 与 `Contact` 一致才触发，桌面通道不构造该条件；真实微信环境未验证（由门槛 10 覆盖） |
| 4 | 暂停后不能启动新的发送 | **满足** | 统一门禁 `src/engine/engine.ts:406`（paused/abort/breaker/budget/safeMode 全部拦截）；`engine.start()` 在暂停/熔断时保持不启动通道（`engine.ts:180-211`）；发送循环每个 part、每次重试前都重新门禁（`engine.ts:1045-1082`）；API 层 `/test/send` 暂停返回 409（`test/server/api.test.ts:1343`）；聊天内 `/stop` 暂停后 0 次 LLM（`test/engine/acceptance.test.ts:479`） |
| 5 | 发送结果 unknown 时不能盲目重发 | **满足** | `resolveSendDelivery`（`engine.ts:97-102`）缺省/非法一律保守 `unknown`；`canRetrySend`（`engine.ts:105-110`）只有 `not-sent` 才允许重试；发送循环最多 2 次尝试且 `unknown` 不重试、任一 part 失败中止整批。测试：`test/engine/acceptance.test.ts:653`（三态工具函数）、`:738`（unknown 只发一次、审计 `send-fail/unknown`）；通道层 `test/channels/desktop.test.ts:258`；脚本层 `Fail-With` 输出 `delivery`，气泡未确认返回 `unknown` |
| 6 | 非授权 API 请求不能触发真实发送 | **满足** | 鉴权链：仅回环 socket + `x-dsh-wechat-persona: 1` + Host/Origin/Sec-Fetch-Site 防跨站 + 可选 apiToken + 进程内限速 429（`src/server/api.ts:322-340`、`:1115`；文档 [SECURITY.md](SECURITY.md)）。测试：`test/server/api.test.ts:487-660`（缺头/错值/非回环 → 403；错误 token → 401；跨站 Host/Origin/Sec-Fetch → 403；429）；`:689` 起 `/status` 暴露 safeMode；`:1343` 暂停 409、`:1358` mockOnly 非 mock 通道 409；`:1372` 起逐端点「未授权不得触发」矩阵；`:1424-1474` `/diagnostics/ocr` 白名单字段/降级；safeMode 拒发：`test/engine/acceptance.test.ts:935-983`（真实通道 0 次 `channel.send`） |
| 7 | 旧版本配置可以正确迁移 | **满足** | `migrateConfig`（`src/config.ts:422`）幂等；测试 `test/core/config-migration.test.ts` 6 例：空配置补安全默认值、旧 onlineStart/End → 工作日/周末时段、幂等、保留显式开关、非法输入回落、旧 `reply.personaDir` 提示不丢人格库默认。新增字段 `safeMode/onboardingDone/apiToken` 均有默认值（`safeMode=false`、`onboardingDone=false`、`apiToken=''`），旧配置无需手改。升级/回滚步骤见 [MIGRATION-v3.md](MIGRATION-v3.md) |
| 8 | 发布包不存在已知敏感数据 | **满足**（本次实测） | `node scripts/check-sensitive.mjs` 扫描 **143 个 git 受跟踪文本文件，0 命中，exit 0**（2026-10-31 §4-3）；规则覆盖 wxid/本机路径/手机号/真实邮箱/密钥/疑似真实姓名，输出打码。说明：脚本只扫**受跟踪**文本文件——本次新增文档在提交前需 `git add` 后再跑一遍（已对全部 9 个新增/改写文档手工正则复核，仅合成占位符）；`dist/`、dataDir 不入库，OCR 语料截图为脚本合成的虚构内容（`scripts/ocr/gen_corpus.py`，seed 固定），二进制图片本身不被文本扫描 |
| 9 | README 能正确指导 mock 安装 | **满足**（本地可复现） | README §5 安装（链接进 profile / plugin_manager 两种）与 §6 mock 快速开始（默认 mock、虚构白名单、`POST /test/inbound` 注入、`/status` 校验）；离线验收 `node scripts/verify-api.mjs`：**24/24 PASS**（§4-4），其中 mock 通道 `/test/inbound` 202、`/test/send` 200 且 `delivery:'sent'`。未在「全新干净机器」实测，宿主版本差异属门槛 10 的未验证范围 |
| 10 | 真实环境未验证的功能有明确说明 | **满足** | 未验证项在 README §3/§9/§10、ARCHITECTURE §14、本清单 §1/§3 与 [MIGRATION-v3.md](MIGRATION-v3.md)、[TROUBLESHOOTING.md](TROUBLESHOOTING.md)、[PRIVACY.md](PRIVACY.md) 中逐项标注；Phase C（同帧/captureId/ack/气泡归属）、Phase F（`safeMode`、`GET /diagnostics/ocr`、首次配置向导、mock 测试入口）**已实现并有单测**，但统一标注「真实微信环境未验证」；OCR 准确率结论限定「合成语料 + 离线等价」并注明真实截图需授权复测；真实微信端到端测试明确要求用户单独授权 |

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

注意：本次仅做 1 张图的冒烟（§4-5），**冒烟结果（单图 CER 10.53%）不构成精度结论**。

## 4. 执行记录（2026-10-31 本机实测）

环境：Windows（本机）、Node v26.13.0、分支 `feat/v3.0.0`、HEAD `4e324d2` + 工作区 v3.0.0 改动（未提交）。

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run typecheck` | exit 0，无报错 |
| 2 | `npm run test:sandbox` | **34 文件 / 548 用例通过**，1.90s，exit 0（`test/server/api.test.ts` 121、`test/channels/desktop.test.ts` 34 等） |
| 3 | `node scripts/check-sensitive.mjs` | 扫描 143 个受跟踪文本文件，**0 命中**，exit 0（新增文档提交前需 `git add` 后复跑，见门槛 8） |
| 4 | `node scripts/verify-api.mjs` | **24/24 PASS**，exit 0（mock 通道收/发、暂停/恢复、鉴权 403、`/diagnostics/ocr`、config/personas/market/stickers/help；需先 `npm run build`，旧 dist 会报 `/health` 0.2.8） |
| 5 | `node scripts/ocr/bench.mjs --engine=winrt --limit=1 --scenario=clear --pipeline=raw` | exit 0，总耗时 1.2s；winrt orig 单图 CER 10.53% / 行 F1 1.000 / P50 26ms（仅冒烟） |
| 6 | `npm run build` | exit 0；重建后 `GET /health` 返回 `version=3.0.0`（重建前旧 `dist/` 仍报 0.2.8 —— 发版前必须重新 build 并重载插件） |

复现命令（发布前完整跑一遍，顺序建议）：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run test:sandbox
git add -A
node scripts/check-sensitive.mjs
npm run build
node scripts/verify-api.mjs
node scripts/ocr/bench.mjs --engine=winrt --limit=1 --scenario=clear --pipeline=raw
# 全量 A/B（需 Python + Pillow + rapidocr_onnxruntime；--split=eval 只跑独立评估集）：
# node scripts/ocr/bench.mjs --engine=all --pipeline=all --split=eval
```

CI 对应关系：`.github/workflows/ci.yml` 的 `verify-windows` 覆盖 1–3、6 与 OCR 冒烟（WinRT/Pillow 不可用时显式
marked skip，不联网、不碰真实微信）；`linux-guard` 覆盖 typecheck + 敏感扫描并显式声明 OCR 冒烟在 Linux 跳过。

## 5. 发布动作检查（人工）

- [x] §2 的 1–10 全部为「满足」
- [x] §3 的独立 eval 集 A/B 有可复现结论且跨口径显著优于 v0.2.8 基线（限定合成语料 + 离线等价）
- [ ] 真实设备验证已取得用户单独授权，且结果记录在案（当前未授权；**未授权前不得对外宣称真机可用/防封有效**）
- [ ] `CHANGELOG.md` 已写 3.0.0 变更；`package.json` 与 `src/index.ts` 的版本号一致（均为 3.0.0）
- [ ] 重新 `npm run build` 并用新 `dist` 重启/重载插件后 `/health` 返回 3.0.0
- [ ] 确认 `git status` 不含个人数据目录、调试截图、`dev-notes/`、`.dsh-tmp/`、`backups/`（这些均不入库）
- [ ] 维护者确认本仓库 `private: true`，无公开发布动作

## 6. 签署

| 角色 | 结论 | 日期 | 依据（commit/tag） |
| --- | --- | --- | --- |
| 文档/CI（本清单维护） | 10 条门槛满足；OCR 专项达成（限定口径）；真实设备未授权 → 不宣称真机可用 | 2026-10-31 | `4e324d2` + 工作区 v3.0.0 |
| 代码评审 | 待填 | 待填 | 待填 |
| 维护者 | 待填 | 待填 | 待填 |

变更记录：本清单随每次发布更新状态与 §4 实测输出；新增/修改门槛必须给出原文出处。

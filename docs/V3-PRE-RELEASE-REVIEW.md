# v3.0.0 发布前独立复核与只读验收报告

> 依据：`DSH_v3.0.0_发布前独立复核与只读验收_完整提示词.md`（发布前验收任务书，444 行）。
> 原则：先核查后修复；所有数字来自本机真实命令输出；不把「文件存在 + 单测通过」写成「已投入生产」；未经授权不操作真实微信。
> 代理：Lead 主导 + 5 个只读/修复任务并行（task-16 只读隔离与重启去重、task-17 安全复核、task-18 隐私与 Git 历史审计、task-19 安装与迁移验收、task-20 OCR 误差归因与 RapidOCR/Worker 复核）。

## 0. 结论速览（TL;DR）

- **自动化门禁（本轮独立重跑，2026-11-01 10:53–10:56）**：`typecheck` 0 错；`test:sandbox` **41 文件 / 678 用例全过**（1.58s）；`build` exit 0；`check-sensitive` **212 个受跟踪文本文件 0 命中**；`check-package` **189 个候选 0 违规**（8 条 gitignore 垃圾警告，发布包 `files` 已排除）；`verify:api` **25/25 通过**。
- **发布包实测**：`npm pack` → `dsh-wechat-persona-3.0.0.tgz`，**189 文件 / 699,321 B**，SHA256 `5A0C59856F83EB9EDA5051B077B4A88E239C84E5EC496D76DF0441EFD797494E`；包内 **0 个 `.bak-*`、0 个 `.pyc`**（修复前有 3 个 PS1 备份 + 4 个字节码）。
- **发现并修复的真实问题 7 项**：C1 `verify:api` 门禁失败；C2 重启后已投递消息可能重复投递；C3 只读测试模式缺失；C4 OCR 新模块「未接线」被误当「已上线」的风险；C5 文档数字过期；C6 发布包夹带本地垃圾；C7 测试夹具误报真实邮箱。均见 §C。
- **生产调用链核查**：`pipeline.ts`（气泡归属+去重计划）、`confidence.ts`（置信度门禁，条件触发）、`vote.ts`（双引擎投票旧路径）**已接入生产读取路径**；`fusion.ts`（几何融合）、`align.ts`（Levenshtein 序列对齐）、`tracker.ts`（跨帧差分）**仅在测试与离线 benchmark 中使用，未接入生产**——本报告不把它算作线上收益。
- **只读隔离**：新增 `readOnlyTestMode`，四层硬阻断（engine 门禁 / desktop.send 首行 / API 409 / PS1 `-ReadOnly`），7 条代码层证据全部有测试覆盖（§E）；**真实微信上未验证**（按任务书禁止操作真实微信，未执行）。
- **未授权事项均未发生**：未 push、未打 tag、未发 Release、未改写 Git 历史、未向真实微信发送或读取、未安装未确认依赖、未上传任何截图/聊天记录。

## A. 真实代码状态（交付前快照）

| 项目 | 事实 |
| --- | --- |
| 分支 | `feat/v3.0.0`（无 upstream） |
| 本轮新增提交 | **6b3b81a**（只读模式/重启去重/流水线开关）、**4fe7cfe**（verify:api 修复/发布包排除/OCR 误差归因）、末次文档提交见 `git log --oneline -1` |
| 累计本地提交 | `42a3caa..feat/v3.0.0` 共 **21 个**（任务书按上一轮报告写「19 个本地提交」= 含基线本身；口径更正：不含基线 `42a3caa` 时本报告基线数为 18，本轮 +3） |
| 相对 `origin/master` | 21 个本地提交，**未 push** |
| 版本 | `package.json` `version=3.0.0`、`private=true`（未改）；`src/index.ts:82` `PLUGIN_VERSION='3.0.0'` |
| 工作树 | 本轮提交后 clean；`dist/` 已按最终 src 重建（10:54，含只读模式与流水线开关） |
| 备份 | `%TEMP%\dsh-wp-backup\v3.0.0-20261101-103304.bundle`（2,432,226 B，SHA256 `DB89EAB638B7A07A360300E0ABA038D0D2077F09D639A110E8F59AE17CFFB7D3`），同目录 manifest/log；可用 `git bundle` 恢复 |
| 远程 | `origin` = GitHub（未推送）；`private:true` 未改公开 |

## B. 生产调用链核查（任务书 §四，最高优先级）

判定口径：**生产使用**=被 `src/**` 运行时 import 且随通道实际执行；**仅测试**=只被 `test/**` 或离线脚本使用；**未集成**=文件存在但无生产引用。

### B.1 链路总表

| # | 阶段 | 实现位置 | 生产状态 | 证据/说明 |
| --- | --- | --- | --- | --- |
| 1 | 窗口定位/激活 | `scripts/pwsh/wechat-uia.ps1`（`Get-Window*`，标题定位） | 生产使用 | `desktop.ts` `runScript('wechat-uia', …)`；脚本只操作微信窗口 |
| 2 | 截图（同帧） | `scripts/pwsh/wechat-uia.ps1:575` `Get-WindowSnapshot -KeepImage`；`:1914` read 复用 `$script:LastSnapshotImage`；`:481` PrintWindow(2)，`:486-497` CopyFromScreen 回退，`:445` 空白检测 | 生产使用 | `-KeepImage` 保证 OCR 与消息提取用**同一帧**（OCR-H1/H3 修复）；`-Upscale 4/2` 见 `:163/:1753` |
| 3 | OCR 引擎 | PS1 `Get-OcrLines :525`（Windows.Media.Ocr，zh-Hans-CN，`:419-442` 初始化）；第二引擎 `scripts/py/rapid_ocr.py`（PS1 `:1952-2025` 调起） | 生产使用 | Windows OCR 单帧 ~70–120ms；RapidOCR 按需（`-SecondOcr`），未作为默认双向融合 |
| 4 | 文本归一/清洗 | PS1 `Get-CleanText :126-134`（去 CJK 间空格）；TS `src/core/ocr/normalize.ts` | 生产使用 | normalize 由 `correction.ts`/`desktop.ts` 纠错与自回声比较调用 |
| 5 | 行合并 | PS1 `Merge-OcrLines :667`（`:678` gap≤max(5,avgH*.45) 且缩进≤28） | 生产使用 | 跨行合并为一条消息；`merged` 字段进诊断 |
| 6 | 气泡归属 | PS1 `Get-BubblePane :747` / `Get-BubbleSide :766` / `Get-InboundCandidates :793`；TS `src/core/ocr/bubbles.ts` `classifyBubble`（`:82`） | 生产使用 | `pipeline.ts:155` 优先用 `pane+box` 几何判定，其次脚本 `side`，最后 legacy |
| 7 | 消息提取/身份 | PS1 `:2060-2238`（per-contact `texts/pending/captureSeq/messageSeq/lastAckCaptureId`；id=`pc-<captureSeq>-<messageSeq>-<Get-Hash(geom)>`；先 `Save-State` 后输出）；TS `src/core/ocr/baseline.ts` | 生产使用 | PS1 为主；TS `stableMessageId` 仅给无 id 的 legacy 消息兜底（`pipeline.ts:129`） |
| 8 | 双引擎融合/投票 | PS1 `:1952-2025`（overlap≥0.90 一致→保留系统文本；0.35≤overlap<0.90 冲突→RapidOCR 原生 score≥0.85 才替换）；TS `src/core/ocr/vote.ts`（desktop `recheckGarbledText` 内使用） | 生产使用（旧路径）/ 新模块未接线 | **`fusion.ts`（几何匹配+分层结论）与 `align.ts`（Levenshtein 序列对齐）零生产引用**，仅测试与 `scripts/ocr/v3-pipeline.mjs` 离线使用 |
| 9 | 置信度评估 | `src/core/ocr/confidence.ts` `evaluateConfidence`（HIGH=0.75 / LOW=0.45，`contactVerified=false` 硬否决） | 生产使用（有条件） | `desktop.ts:38` import；`:717` 调用；**仅当脚本输出 `diag`/`engines`/`raw.confidence/merged/agreement` 证据时才评估，否则返回 null 保持旧行为**（无证据不臆造置信度） |
| 10 | 跨帧差分 | `src/core/ocr/tracker.ts` `classifyFrameDelta` | **未集成（仅测试）** | `src` 零 import；生产去重靠 PS1 pending+ack 与 desktop `inFlight` + 已投递 id 持久化 |
| 11 | 去重/ACK | PS1 pending/ack（`:2093-2097/:2196-2206`）；TS `desktop.ts` `commitAck/persistAckState/loadAckState`（`desktop-ack.json`）+ `inFlight` + **本轮新增 `desktop-delivered.json`（FIFO 500、串行原子写、启动加载）** | 生产使用 | ack 水位线=「已投递的最后一帧」；重启重放的重复投递已修复（§C2） |
| 12 | 桌面轮询与投递 | `src/channels/pc/desktop.ts`：`tick :560`、`readInboundOnce :763-963`、`planRead :594`、`emitMessage :971`、`emitPreview :965` | 生产使用 | 2s 轮询；已打开会话 8s 低频 `-NoSearch`；未识别联系人不用 Ctrl+F |
| 13 | 引擎入站 | `src/engine/engine.ts:936` `handleInbound`（channel.start 回调 `:234-236/:280-282`）→ 门禁 `src/core/gate.ts` → 回复生成 → 发送 | 生产使用 | 入站消息最终进入引擎事务 |
| 14 | 回复生成 | `src/llm/prompt.ts` `buildSystemPrompt/buildMessages` → provider | 生产使用 | system 前缀稳定以命中缓存 |
| 15 | 发送 | `src/engine/engine.ts` 10 态状态机 + `send-ledger` 幂等 + `canSend` + `desktop.send :995-1072`（10 道校验、无行坐标拒绝） | 生产使用 | 见 `docs/SECURITY-REVIEW-PRE-RELEASE.md` |

### B.2 结论要点

1. **接入生产的 v3 OCR 能力**：同帧截图、气泡归属（bubbles）、消息计划（pipeline）、置信度门禁（confidence，条件触发）、稳定身份/ack 水位线（PS1 + desktop）、已投递 id 持久化去重。
2. **未接入生产**：`fusion.ts`、`align.ts`、`tracker.ts`；离线 A/B 中「D 仅新对齐」「E 仅新融合」的增益未进入生产路径，因此 **不能把离线 F 组数字当作线上收益**。
3. **生产仍保留旧融合逻辑**：PS1 overlap/score 阈值属于旧路径（已删除「谁更长谁赢」）；`vote.ts` 由 desktop 纠错路径调用。
4. 任务书 §4.3「未过生产等价测试前不替换旧逻辑」：本轮新增 `ocrPipelineMode: 'v3' | 'legacy'` Feature Flag（默认 v3，可一键回退到 v0.2.8 行为），且切换不会开启自动发送（发送仍走全部门禁）。

## C. 已修复问题（本轮，均带真实运行证据）

| # | 问题 | 位置 | 原因 | 修复与证据 |
| --- | --- | --- | --- | --- |
| C1 | `verify:api` 首次运行失败（24/25） | `scripts/verify-api.mjs` | 脚本旧假设：`/test/inbound` 自动回复后再 `/test/send` 应成功；但 `sendTest` 已接入 `canSend({checkWhitelist,checkRate})`，30s 最小间隔内第二次发送被拒（`delivery:'not-sent'`） | 重排用例 + 新增「频控拒绝」正期望断言 → `npm run verify:api` **25/25，exit 0**（提交 4fe7cfe） |
| C2 | 重启后 pending 重放可能重复投递 | `src/channels/pc/desktop.ts`（`inFlight` 仅内存） | 已投递 id 未持久化，重启后脚本按 ack 契约外重放时无法去重 | 新增 `desktop-delivered.json`（`loadDeliveredState :353` / `rememberDelivered :367` / FIFO 500 / 串行原子写 / `wasDelivered :811`）；`test/channels/desktop-id-stability.test.ts` **6/6 全绿**（先复现失败再修复） |
| C3 | 只读测试模式缺失 | `src/config.ts`、`desktop.ts`、`engine.ts`、`api.ts`、`client.js`、`wechat-uia.ps1` | 发布前只读验收要求从代码层禁止真实发送与键鼠模拟 | `readOnlyTestMode`（默认 false）+ 四层硬阻断（§E）；新增 21 条安全/只读回归 + 3 条 desktop 回归；`docs/READ-ONLY-MODES.md` |
| C4 | OCR 新模块「未接线」被误当「已上线」风险 | `docs/V3-AUDIT.md`、`docs/SPEC-COMPLIANCE.md`、`CHANGELOG.md` | 文档只有整体描述，未逐模块标注生产状态 | 本报告 §B 逐模块标注；SPEC-COMPLIANCE 同步「仅测试/未集成」；CHANGELOG 写明 fusion/align/tracker 未接线 |
| C5 | 数字口径过期（verify 24/24、用例 648、敏感扫描 157、发布包 167） | `README.md`、`docs/RELEASE-CHECKLIST.md`、`CHANGELOG.md`、`docs/SPEC-COMPLIANCE.md` | 多轮并行改动后未同步 | 统一为最终实测：**25/25、41 文件/678 用例、212 文件 0 命中、189 候选 0 违规** |
| C6 | 发布包夹带本地垃圾 | `package.json` `files` | `files` 含整个 `scripts/`，会把 `*.bak-*` 与 `__pycache__/*.pyc` 打进包 | 增加 `!**/*.bak-*`、`!**/__pycache__`、`!**/*.pyc`；`npm pack` 实测 **0 bak / 0 pyc**（提交 4fe7cfe） |
| C7 | 测试夹具被敏感扫描误报真实邮箱 | `test/core/persona-market.test.ts:825` | 夹具 URL 使用「用户:口令@测试域名」形如真实邮箱，域名不在示例白名单 | 改为 `example.com`（IANA 保留示例域名）→ `check-sensitive` **212/0**，单文件 39 用例全绿 |

## D. 剩余风险（P0/P1/P2）

> P0=发布阻塞；P1=可发布但必须在发布说明标注；P2=建议后续。本轮修复后 **P0=0**。

| 级别 | 风险 | 证据/位置 | 建议 |
| --- | --- | --- | --- |
| P1 | **真实微信窗口未验证**（OCR 归属/身份/ack 在真实字体/DPI 下可能不同；PS1 只经 PS5.1 语法校验 + mock 测试） | 本报告 §B；`docs/OCR-BENCHMARK.md` 限定「合成语料+离线等价」；PS1 `-ReadOnly` 未实机 | 按 `docs/OCR-REAL-DEVICE-TEST-PLAN.md` 获授权后执行；未执行前不得宣称真实环境可用 |
| P1 | `fusion.ts`/`align.ts`/`tracker.ts` 未接入生产，生产仍走 PS1 旧融合 + 条件置信度 | §B.1 #8/#10 | 要么接入并做生产等价 A/B，要么在发布说明明确「离线实验能力，未上线」 |
| P1 | 置信度阈值 0.75/0.45（TS 规则评分）与 PS1 0.90/0.85（overlap/原生 score）是两套不同评分体系，未标定 | `confidence.ts:66-74/:215`、`wechat-uia.ps1:1958-2015` | 文档/诊断中已区分命名（规则评分 vs overlap/原生 score，非概率）；真实数据标定后再定阈值 |
| P1 | 兼容模式默认不强制 API token；DNS rebinding 未处理 | `docs/SECURITY-REVIEW-PRE-RELEASE.md` §7.2（方案 A/B/C + 7 条测试设计） | 发布说明标注；推荐下一版默认开启 token 并在设置页增加 token 输入 |
| P1 | 隐私：1 处真实感姓名残留在**已推送历史**（`9db6c5b`/`42a3caa` 的 `docs/ACCEPTANCE.md` 历史行），当前树已脱敏 | `docs/PRIVACY-REVIEW-PRE-RELEASE.md`（C=1） | 需维护者决定：方案 A 保留（永久暴露）或方案 B 局部改写（影响已推历史/tag/缓存，需 force push，本轮未执行） |
| P1 | 只读模式不阻止 LLM 调用（只阻断发送）；跨重启持久化依赖宿主 `configEditor` | `docs/READ-ONLY-MODES.md`、`docs/SECURITY-REVIEW-PRE-RELEASE.md` §9 | 需要完全离线时用 mock 通道/断网；宿主不支持 configEditor 时 POST /config 会报错（平台限制） |
| P2 | 预览 id 含分钟桶，同一预览跨分钟可能重复投递 | `desktop.ts:965-969` | 后续改为稳定 id 或加入持久化去重 |
| P2 | `inFlight` 超过 200 全清（去重表重置） | `desktop.ts`（`inFlight` 逻辑） | 已投递 id 持久化可兜底重启场景；后续改 LRU |
| P2 | 低置信 pending 保留上限 200；ack 语义=「该帧已处理」 | PS1 pending 设计 | 发布说明标注；真实设备验证时观察 |
| P2 | 首次配置向导仅 4 步（任务书期望 10 步）；设置页无 API token 输入入口 | `client/client.js:4213+`；`docs/SECURITY-REVIEW-PRE-RELEASE.md` P1③ | 列为下一版 UX 项 |
| P2 | `rapidocr` 统一包未安装未实测；Worker 评估完成但未接线 | `docs/OCR-ERROR-ANALYSIS.md` §10-11 | 给出安装/验证步骤；本期不接线（收益/成本见报告） |
| P2 | 安装包未做真实干净机安装（离线 npm install 无法缓存）；未跨平台验证 | `docs/PRE-RELEASE-INSTALL.md` | 发布前在干净环境按 RELEASE-CHECKLIST §6.4 复验 |
| P2 | Windows ACL、宿主反代回环判定、token 轮换、长期运行压力未验证 | `docs/SECURITY-REVIEW-PRE-RELEASE.md` §9 | 设备/环境相关，发布说明列为已知限制 |

## E. 只读测试准备状态（任务书 §五）

**必须回答：是否已从代码层证明真实发送路径被完全禁用？**

**答案：是（代码层已证明，共四层阻断；真实微信上未执行，因此不宣称「已通过真实环境只读验证」）。**

- [x] `readOnlyTestMode=true` 时 `desktop.send` 在最前返回 `not-sent`，`runScript` 调用数为 0（`desktop.ts:1125`；`test/channels/desktop.test.ts` 只读 send 脚本调用数=0）；
- [x] `engine.canSend` 对自动回复/重试/`sendTest`/草稿批准一律拒绝（`engine.ts:501-503`，顺序在 breaker 后、safeMode 前；`acceptance.test.ts:1228-1289` 4 条；mock 通道不受限）；
- [x] `POST /test/send`、`POST /drafts/approve` 返回 409（`api.ts:1751-1752` / `:1808-1809`，detail=`read-only-mode`），`/drafts/reject` 仍可用（测试固化）；
- [x] LLM 工具入口全部经 `engine.sendTest`→`canSend`（`src/tools.ts:182` → `src/index.ts:321-323` → `engine.sendTest :405-442`）；
- [x] 只读模式不执行粘贴/回车/点击：`desktop.send` 前置拒绝 + PS1 `-ReadOnly` 在定位窗口前 `Fail-With`，read 强制 `-NoSearch`，不恢复/移动/置顶/切前台窗口、遮挡不抢前台（`wechat-uia.ps1:69/:166-167/:516/:1604-1610/:1636-1662`）；
- [x] 重启后保持只读：配置持久化 + `engine.start :235-242` 写配置态审计并以只读启动（`acceptance.test.ts` 重启仍拒绝用例）；
- [x] 设置页/日志明确显示：顶部只读 Banner、标题栏 Badge、安全红线卡、草稿批准按钮禁用、`/status` 三处暴露、`/config` 返回 boolean（`client/client.js:3556-3576/:3990-4037/:4748-4754/:4800`；`api.ts:1299/:1304/:1312`）。

隔离边界说明：只读模式只阻断「真实发送」，不阻断 LLM 调用与只读 OCR；读取模式仍可能「被动截图当前会话」，四种模式与副作用见 `docs/READ-ONLY-MODES.md`。

真实设备只读验证：**未执行**（方案见 `docs/OCR-REAL-DEVICE-TEST-PLAN.md`，待维护者批准；本轮未读取任何真实聊天、未上传任何数据）。

## F. 隐私审计（任务书 §九）

- **当前树**（772 文件、受跟踪 281）：真实姓名、本机用户名路径、真实手机号/邮箱/wxid/密钥 **0 命中**；6 处邮箱均 noreply/example.com；手机号 71 处、wxid 全部为合成值；`check-sensitive` **212 文件 0 命中**；`check-package` 0 违规。
- **Git 历史**（39 可达提交 = 已推 21 + 本地 18；477 blob）：**C=1** 真实感姓名仅存在于 `docs/ACCEPTANCE.md` 历史行（1 blob，涉及已推送提交 `9db6c5b`/`42a3caa`；当前树已改为「测试甲」）；**B=1** `42a3caa` 版 `docs/HANDOFF-0.3.0.md` 环境指纹（已在新版泛化，仅历史可读）。
- **本地未跟踪 C=3**（从未入库，位于 OneDrive 同步目录）：`.dsh-tmp/`（107 个 PII 文件 + 181 张真机截图 ≈24.9MB）、`dev-notes/`（5 文件）、`backups/`（2 文件）——发布前需维护者手动清理或移出同步目录。
- 方案对比与决策项（D-1~D-8）见 `docs/PRIVACY-REVIEW-PRE-RELEASE.md` 第 5-7 节；`private:true` 未改公开。

## G. 发布决策建议（任务书 §十三-G）

| # | 问题 | 建议 |
| --- | --- | --- |
| 1 | 是否 push `feat/v3.0.0`？ | **暂不**：本轮已本地提交（21 个），push 需维护者明确批准；push 前建议先决定历史改写方案（否则 C=1 随 push 进入远端） |
| 2 | 是否打 tag / 发 Release？ | **暂不**：`private:true` 私有分发；真实设备只读验证与干净机安装未完成前不建议 Release |
| 3 | 是否改写 Git 历史去实名？ | **需维护者单独决策**：方案 A（保留，README/SECURITY 声明旧测试名）风险=永久暴露；方案 B（局部改写 `9db6c5b`/`42a3caa` + 重建 v0.2.8 tag + rebase 重放本地提交，需 force push）影响缓存/fork；本报告不执行改写 |
| 4 | 是否适合真实设备只读测试？ | **适合（代码层隔离已证明）**，但依赖维护者批准时间窗口 + 测试小号 + 按 `docs/OCR-REAL-DEVICE-TEST-PLAN.md` 执行；未批准不执行 |
| 5 | 距正式发布还缺什么？ | ①真实设备只读验证（任务书 §六）；②干净机安装复验（§十一）；③历史实名决策；④发布说明（含 P1 标注：真实环境未验证、fusion/align/tracker 未接线、阈值未标定）；⑤维护者对 push/tag/Release 的明确批准 |

### 需要维护者拍板的决策清单

- **D-1**：是否 push 本地 21 个提交（分支 `feat/v3.0.0`，无 upstream）。
- **D-2**：是否打 tag `v3.0.0` / 发 GitHub Release（`private:true` 建议不发）。
- **D-3**：Git 历史实名残留：保留 / 局部改写（方案 B，需 force push）/ 仅发布前清理工作区。
- **D-4**：是否授权真实设备只读验证（时间窗口 + 测试小号；本轮零发送、只读，方案已就绪）。
- **D-5**：`.dsh-tmp/`（≈24.9MB 真机截图）、`dev-notes/`、`backups/` 如何处置（删除/移出 OneDrive/加密归档）。
- **D-6**：发布包构建方式：按 `docs/RELEASE-CHECKLIST.md` §6.4 用受跟踪文件制包（推荐，不用 `npm pack` 直接从开发目录打）。
- **D-7**：是否在下一版强制 API token 并补设置页 token 输入（本轮为兼容默认关闭）。
- **D-8**：是否把 `ocrPipelineMode` 默认值保持 `v3`（当前）或发布时保险起见改为 `legacy` + 文档指引手动开启。

## 附录 A：本轮实际执行的验证命令与真实输出

```powershell
npm run typecheck        # exit 0
npm run test:sandbox     # Test Files 41 passed (41) / Tests 678 passed (678)，1.58s
npm run build            # exit 0（dist 已按最终 src 重建）
node scripts/check-sensitive.mjs  # 扫描 212 个受跟踪文本文件，0 命中，exit 0
node scripts/check-package.mjs    # 189 个候选 0 违规，exit 0（8 条 gitignore 垃圾警告，不入包）
npm run verify:api       # 共 25 项，通过 25，失败 0，exit 0
npm pack --dry-run       # 189 文件 / 699,321 B / unpacked 2,105,482 B；0 bak、0 pyc
```

## 附录 B：本轮新增/更新的文档

`docs/V3-PRE-RELEASE-REVIEW.md`（本报告）、`docs/READ-ONLY-MODES.md`、`docs/OCR-REAL-DEVICE-TEST-PLAN.md`、`docs/PRIVACY-REVIEW-PRE-RELEASE.md`、`docs/SECURITY-REVIEW-PRE-RELEASE.md`、`docs/PRE-RELEASE-INSTALL.md`、`docs/OCR-ERROR-ANALYSIS.md`；同步更新 `README.md`、`CHANGELOG.md`、`docs/RELEASE-CHECKLIST.md`、`docs/SPEC-COMPLIANCE.md`。

## 附录 C：本轮提交清单（本地，未 push）

- `6b3b81a` feat: v3.0.0 发布前复核 - 只读测试模式四层阻断与 OCR 流水线受控回退
- `4fe7cfe` fix: v3.0.0 发布前复核 - verify:api 适配发送频控门禁并补 OCR 误差归因工具
- 文档提交：`docs: v3.0.0 发布前复核 - 独立复核报告与数字口径同步`（见 `git log --oneline -1`）

> 诚实声明：本报告所有结论均基于本机自动化与 mock/合成数据验证；**真实微信上的只读验证尚未执行**，因此真实环境下的 OCR 归属/身份/ack、PS1 只读阻断、安装包行为仍属未验证范围，发布说明必须保留该限定。

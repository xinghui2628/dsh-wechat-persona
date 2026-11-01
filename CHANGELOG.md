# 更新记录（Changelog）

本项目的所有重要变更都记录在这里。

- 格式参考 [Keep a Changelog（中文）](https://keepachangelog.com/zh-CN/1.1.0/)。
- 版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
- 最新版本：**3.0.0**（2026-10-31，开发中/未公开发布）。安装/更新/卸载与排障见 [docs/使用说明.md](docs/使用说明.md)，从 0.2.8 升级见 [docs/MIGRATION-v3.md](docs/MIGRATION-v3.md)，发布门槛见 [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md)。

## [3.0.0] - 2026-10-31

> 开发版本：代码、测试与文档已完成，**未推送远程、未打 tag、未发布 Release**（`private: true` 保持不变）。

### 隐私与合规（阶段 A/E）

- 清除 `docs/ACCEPTANCE.md` 残留的真实中文姓名（改为「测试甲」），泛化 `docs/HANDOFF-0.3.0.md` 中的本机环境指纹；`.gitignore` 增补本地数据/截图/环境文件规则。
- 新增 `scripts/check-sensitive.mjs` 与 `npm run check:sensitive`：对受跟踪文本文件做姓名/wxid/路径/邮箱/手机号/密钥扫描（脱敏输出，命中 exit 1），当前 0 命中。
- API 鉴权加固：除回环 socket + `x-dsh-wechat-persona` 头外，新增 Host/Origin/Sec-Fetch-Site 校验、可选 Bearer token（`config.apiToken`，SHA-256 + `timingSafeEqual` 恒定时间比较，可落盘到 dataDir 0600 文件）、进程内限速（240 次/分）、请求体 10s 超时、Content-Type 校验。
- 人格导入安全：schema 白名单 + 深度/数组/字符串长度上限、拒绝原型污染键与路径穿越 id、错误信息不回显原值；新增 `docs/SECURITY.md`（威胁模型/鉴权矩阵/残余风险）。

### AI 身份透明（任务书 10.4）

- 人设不再声称「不是 AI」：系统提示词最高优先级规则新增「AI 身份透明」（被直接问是不是 AI/机器人/模型时如实说明，不冒充真人、不声称是具体的人、不诱导敏感信息），默认人格兜底、内置人格 systemPrompt 与示例对话、人格导入转换约束、`persona/persona.md`、`persona/examples.md` 全部同步。
- 相应更新 `test/core/persona.test.ts`、`test/core/persona-library.test.ts` 断言（内置人格提示词长度仍在 200-500 区间）。

### OCR 流水线重构（阶段 B/C）

- 纯逻辑抽离到 `src/core/ocr/*`：`types/geometry/normalize/correction/vote/bubbles/baseline/pipeline`，可单测、无 IO；`src/channels/pc/desktop.ts` 移除 `// @ts-nocheck` 与全部 `any`，改为强类型（`tsc --noEmit` 0 错）。
- **同帧约束**：一次 `Get-WindowShot` 保存 PNG 后，Windows OCR 与 RapidOCR 都识别同一帧（`-KeepImage`），输出行/消息带 `captureId`，不再二次截图错并。
- **基线不丢消息**：脚本 pending 队列 + `-Ack <captureId>` 水位线，先原子保存（temp+rename）后输出、读取不再截断；TS 侧透传 ack、成功投递后提交水位线并持久化到 dataDir（`desktop-ack.json`），插件重启后不重放已处理帧；消息 id 跨帧稳定。
- **气泡归属**：`bubbles.ts` 按几何判定 inbound/outbound/uncertain（长气泡越线判 uncertain），投递前拒投 uncertain/outbound 并计数，不再猜。
- 纠错分级：受控词典只做同长度近形替换，「更长才替换」门槛与姓名/金额/验证码等敏感区段保护；双引擎融合仅对可疑行触发。
- 合成 OCR 语料 + 基准：`scripts/ocr/*`（语料生成、WinRT/RapidOCR 引擎适配、v0.2.8 baseline 逐行转写、v3 管线离线等价）、`test/fixtures/ocr-corpus/`（60 张合成截图 + manifest + results）、`docs/OCR-BENCHMARK.md`、`docs/OCR-DESIGN.md`。

### 发送可靠性（阶段 D）

- `AbortController`：`pause()`/`stop()`/熔断/`/stop` 立即打断在飞生成与发送；拟人延迟后、每个 part 发送前、每次重试前都复查 `canSend()`；多 part 中途暂停不再继续发。
- `SendResult.delivery` 三态（`sent` / `not-sent` / `unknown`）：`unknown` 绝不自动重发并计数/审计；PS1 两处「已回车但未确认气泡」回传 `unknown`；`/status` 暴露三态计数。
- 取消 `trustedOpen` 快发送旁路：桌面发送不再信任 180s 内的 `lastActiveContact`，没有行坐标一律拒绝发送（避免用户切换聊天后发错人）；取消跨联系人误发路径。
- 暂停期间入站消息 `deferred` 持久化、恢复后按序补处理；启动时检查 paused/breaker；`/test/send` 统一走白名单/暂停/预算/熔断门禁。

### 安全运行模式与体验（阶段 F）

- `safeMode` 安全运行模式（默认 `false`，首次向导引导开启）：真实通道拒绝发送并返回 `not-sent` + 明确原因 + 审计 `safe-mode`，mock 通道照常空转。
- 只读 OCR 诊断中心：`GET /diagnostics/ocr`（白名单字段、不可用时给原因、无敏感内容）+ 设置页面板。
- 首次配置向导（默认 mock + 安全模式，只存配置不发送）；人格模拟器入口（`/test/send` 支持 `mockOnly`，非 mock 通道 409）。

### 文档与 CI（阶段 G）

- README 重写为 12 节（含 Mermaid 架构图、配置表、OCR 说明与限定、隐私边界）；新增 `docs/PRIVACY.md`、`docs/MIGRATION-v3.md`（含回滚）、`docs/TROUBLESHOOTING.md`、`docs/CONTRIBUTING.md`、`docs/RELEASE-CHECKLIST.md`；更新 `docs/ARCHITECTURE.md`。
- CI（`.github/workflows/ci.yml`）：Windows 跑 typecheck → test:sandbox → check-sensitive → build → OCR 冒烟；Linux 显式标记跳过 WinRT 相关项。

### 逐项差距补齐（任务书复核，2026-11-01）

- **发送状态机（9.1）**：新增 `src/core/send-state.ts`（received→validated→generating→draft→ready→sending→confirmed/failed/unknown/cancelled 10 态 + 合法转换表），engine 按真实阶段推进并写 audit `send-state`。
- **sendOperationId 幂等（9.4）**：新增 `src/core/send-ledger.ts`（dataDir/`send-ledger.json`，每逻辑发送唯一 opId，terminal 不重发，multi-part 按 partIndex，`shouldRetry` 仅 failed+not-sent 且 attempts<3；unknown 永不自动重发）。
- **草稿/人工确认模式（13.4）**：`config.sendMode: 'auto'|'draft'|'confirm'`（默认 auto，可迁移）；draft/confirm 写 dataDir/`drafts.json`（上限 50、24h TTL），API `GET /drafts`、`POST /drafts/approve|reject`（approve 重走 `canSend()` 全部门禁 + 同 opId），UI 有「待发送草稿」面板。
- **多引擎融合/对齐/置信度（6.2–6.5）**：新增 `src/core/ocr/fusion.ts`（几何一对一匹配）、`align.ts`（Levenshtein 序列对齐，跨气泡禁配）、`confidence.ts`（可解释评分 + accept/verify/reject，联系人验证失败硬否决）、`tracker.ts`（LCS 跨帧 replay/ocr-changed/insert/scroll/duplicate/reset）；desktop read 接入置信度门禁（low-confidence 不投递、verify 用同帧第二引擎二次验证、低置信不推进 ack 留在 pending 下次重放）；PS1 删除「谁更长谁用谁」，改分层决策（overlap≥0.90 agree / 0.35–0.90 conflict 且第二引擎原生 score≥0.85 才替换）。
- **稳定消息身份（8.2/8.3）**：PS1 pending id 去文本哈希，改为 `pc-<captureSeq>-<messageSeq>-<几何hash>`（连发同文本算两条、跨帧重放 id 稳定）；新增 `tracker.ts` 与重复文本/滚动/插入/OCR 变化/切联系人测试。
- **市场 SSRF 加固（10.3）**：`src/core/persona-market.ts` 仅 http/https、拒绝内网/回环/链路本地/`.local`、`redirect:'manual'` 最多 2 跳且每跳重校验、Content-Type 必须 JSON、2MB 双限、错误不回显 URL。
- **诊断字段（13.2）**：`GET /diagnostics/ocr` 白名单补齐 15 字段（captureId/engines/lines/uncertainCount/rejectCount/durationMs/lastReadAt/lastError/dpi/scale/screenshotMode/engineVersion/conflictCount/secondOcrUsed/qualityStatus），缺失安全忽略、越界钳制、不含聊天内容。
- **预处理 A–H 与 A/B 六组（4.4/12.1–12.3）**：语料扩到 30 场景×2=60 张（旧 40 张 SHA256 不变）；A–H 实测（upscale3x 最优，裁剪单用不优于全窗放大）；A/B 六组消融（A v0.2.8 → F 完整 v3：eval 集 CER 35.59%→22.07%、整句 30.30%→51.52%）；12.2 事件/资源统计（双引擎冲突 42.42%、不确定 18.18%、误改 0、重复 0）。
- **RapidOCR 双路径（5.2）与 Worker 评估（5.3）**：`scripts/py/rapid_ocr.py` 支持统一 `rapidocr` 包（boxes/txts/scores）与旧 `rapidocr_onnxruntime` 自动检测（本机仅旧包，新路径代码就绪未实测，如实标注）；`scripts/ocr/worker-eval.mjs` 量化常驻 Worker（稳态 1323ms/图 vs 现状 3130ms/图，结论「值得做、本期不接线」）。
- **CI 十项与发布准备（14.4/14.5）**：`.github/workflows/ci.yml` 覆盖 typecheck/单测/集成/OCR 冒烟/Windows 兼容/build/API 验证/依赖审计/敏感扫描/发布包检查；新增 `scripts/check-package.mjs`；`docs/RELEASE-CHECKLIST.md` 增发布说明/可复现构建/SHA256/干净发布包/回退 v0.2.8/批准边界。
- **合规清单**：新增 `docs/SPEC-COMPLIANCE.md`（任务书十六部分逐项状态/证据/残余风险/待维护者决定）。

### 测试与基准

- `npm run typecheck` 0 错；`npm run test:sandbox` **40 个文件 / 648 个用例**全部通过；`node scripts/check-sensitive.mjs` 157 个受跟踪文件 0 命中；`node scripts/check-package.mjs` 167 候选 0 违规；`npm run build` 通过；`npm run verify:api` 24/24。
- OCR 基准（60 图合成语料、离线等价口径）：A–H 中 `upscale3x` 最优（tune 集 CER 17.66%/整句 53.85%，eval 集 25.68%/51.52%）；A/B 六组 eval 集：A v0.2.8 35.59%→B 预处理 22.82%→C 换引擎 2.25%→D 新对齐 24.47%→E 新融合 12.91%→F 完整 v3 **22.07%**（整句 30.30%→51.52%，CER −13.52pp、整句 +21.22pp）；两轮 eval 结论一致（相对 v0.2.8 有可测量改善），达成任务书 12.4 门槛第 2 条（**限定「合成语料 + 离线等价」**）。真实微信窗口未验证（需真机授权后按 `docs/TEST-PLAN.md` 复测）。

### 未做 / 风险

- 未用真实微信联系人做任何发送或端到端测试；PS1 的 DPI/双引擎阈值（0.90/0.85）/气泡边距/几何 id 需真机校准；置信度阈值 0.75/0.45 为规则初值，未用标注集校准。
- fusion/align/tracker 是核心库 + 单测，**未接入生产 read 路径**（生产用 PS1 几何匹配 + pending/ack 跨帧重放），如实标注。
- RapidOCR 统一 `rapidocr` 包本机未安装，双路径只实测旧包路径；Worker 评估结论为「值得做、未接线」。
- 市场 SSRF 防护基于主机名字符串判定，未做 DNS 解析后二次校验（DNS rebinding 仍有残余面），已在 `docs/SECURITY.md` 标注。
- 未推送远程、未打 tag、未创建 Release（需维护者明确批准）；`private: true` 保持不变。
- v0.2.8 历史提交中残留的实名（已在当前工作树修复）是否改写 git 历史由维护者决定（公开仓库不可逆）。

## [0.2.8] - 2026-10-31

### OCR 识别再降误读（双引擎投票 + 常用词字典纠错）

- **双引擎投票**：读取聊天时若系统 OCR 结果可疑，脚本会把同一张窗口截图交给第二引擎
  （RapidOCR，PaddleOCR 家族的 ONNX 版本；本机未安装时静默跳过）独立识别，两路结果按
  字符重合度 + 坐标行对齐投票，重合度高且更完整的一方胜出。对应业界「多份 OCR 转录字符级
  对齐投票」的做法，两套模型同时认错的概率远低于单引擎。
- **常用词字典纠错**：内置离线词典（人格名/高频口语/常用术语，可追加白名单联系人名），
  对长度 ≥3 的常用词做「同长度只差一个字」的受控替换（例如 大吧鱼→大肥鱼、幽黑度→幽默度），
  2 字词不做模糊替换，避免误伤正常文本。
- 新增脚本 `scripts/py/rapid_ocr.py`（可选依赖 `rapidocr_onnxruntime`），输出逐行文本+坐标 JSON。
- 测试：新增「200 种形近字字典纠错」「200 种双引擎投票」「200 次 -SecondOcr 集成」
  等循环用例；全量 30 文件 / 416 用例通过。

## [0.2.7] - 2026-10-31

### OCR 识别兜底（多通道投票 + 二次放大读取）
- 读取结果可疑时（命中残缺偏旁 讠/刂/亻/扌、中文里混入孤立字母等）自动用 `-Upscale 4` 再读一次，按噪声分投票选更可信的一份（对应业界的多帧 OCR 投票思路）。
- 脚本 `read` 新增 `-Upscale` 参数，读取默认放大到 3 倍最近邻，二次识别时用 4 倍。
- 提示词补充：读到 OCR 残片时按最接近的常见词补全、不复述错字、不借机吐槽对方打错字。
- 测试：新增 200 种变体的「乱码→二次识别→选优」循环用例，以及「文本干净不触发二次读取」用例；全量通过。

## [0.2.6] - 2026-10-31

### 一遍看懂 + 一次最多两条

- 读取聊天记录时 OCR 放大倍数提高一档（最近邻放大），减少「大肥鱼→大吧鱼」这类形近字误读。
- 提示词新增：形近字/同音错字按上下文纠正（把自己的名字认歪当成在叫自己）、暗号/接话游戏直接配合、
  第一遍就顺着最可能的意思接话（不说「没看懂/键盘进水」）、一次只发 1–2 条短消息。
- 默认最多拆 2 条发送（`reply.maxSplitParts` 默认 3→2），说一句只回一条或两条，不刷屏不浪费 token。
- 测试：新增 200 种文本变体拆条上限用例；桌面截断补全 100 次循环用例保留；全量 30 文件 / 409 用例通过。

## [0.2.5] - 2026-10-31

### 理解与预览完整性修复

- 列表预览先读全文校验：预览只是 OCR 片段，消息稍长会被截断（实测「我想拉高你的幽默度」只读到「我想拉高你的幽」）；
  未读预览现在会先用 read 读一次窗口全文，读到更完整文本就用全文，读不到才退回预览，避免对着半句话回复。
- 提示词新增「听懂人话」规则：先理解意图与常见口语/热词，不装傻、不逐字反问，遇到疑似半句按能懂的部分自然回应。
- 测试：桌面通道截断补全新增 100 次循环用例 + 预览回退用例；全量 30 个测试文件 / 407 用例通过。

## [0.2.4] - 2026-10-31

### 修复自言自语（自回声）
- 通道层：列表「预览变化兜底」不再把绿底选中行（当前打开的会话）标成未读——机器人自己刚发的消息会让预览变化，但不会产生未读，这一步从源头切断了自回声。
- 通道层：已发送文本改为保留每个联系人最近 5 条，并加入 OCR 容错比对（截断/漏字/形近字）；窗口 read 返回的内容若命中自己的话直接丢弃。
- 引擎层：新增 `self-echo` 闸门——入站文本与最近对话里自己的话高度相似时直接跳过（审计 reason=self-echo），**即使通道漏过滤也不会自问自答**。
- 测试：新增 100 种 OCR 变体自回声用例 + read 自回声用例 + 引擎 100 次自回声重复投递用例（30 文件 / 405 用例全过）。

## [0.2.3] - 2026-10-31

### 读取聊天记录更安全（不串聊）
- 桌面脚本读取聊天记录前增加「列表预览交叉验证」：标题栏 OCR 识别不稳定时（如「张伟」被 OCR 认成「张，伟」），用左侧会话列表里该联系人的最新消息预览与当前聊天内容比对，对不上就拒绝读取（`ok:false`），绝不把别人的聊天当成目标联系人的消息。
- 去掉「标题首字相同就算命中」的宽松匹配兜底：它曾把「张，伟」误认成「张磊」，导致读错聊天。现在只接受「名字像」或「长度相同且只差一个字」的容错。

### 表情能力降级
- `Channel` 接口新增可选 `capabilities` 能力声明；桌面视觉通道声明 `stickers/images/voice: false`。引擎在通道发不出表情时自动把表情概率降为 0，不再出现「抽到表情 → 发送被拒 → 错误计数」的噪音。

### 读取窗口几何
- 聊天记录读取的聊天面板左边界默认值从 0.40 收到 0.30（会话列表右边界约 0.26），减少「对方左侧气泡被过滤掉」导致的漏读。

### 测试
- `npm run typecheck`、`npm run test:sandbox`（30 文件 / 400 用例）、`npm run build` 通过。
- 脚本层 10 轮 list+send 压测：list 10/10、send 10/10，list P50/P95 = 1977/2071 ms，send P50/P95 = 2763/3475 ms（见 docs/ACCEPTANCE.md §13）。

### 开源与社区文件（发布准备）
- 新增 `DISCLAIMER.md`（完整免责声明：与腾讯无关、账号风险、无担保、数据流向、禁止用途）、`SECURITY.md`（数据存储/流向、安全使用建议、私密漏洞报告渠道、支持范围）、`CONTRIBUTING.md`（开发环境/提交规范/PR 流程/隐私红线）、`CONTRIBUTORS.md`（第一作者/第二作者/贡献者署名）、`CITATION.cff`（学术引用与作者列表）。
- 新增 `.github/`：Bug/Feature Issue 模板、Issue 配置（引导先读 FAQ、漏洞走私密渠道）、PR 模板（测试与隐私检查清单）、CI（Windows 上 typecheck + test:sandbox + build）。
- 新增 `docs/RELEASE-GUIDE.md`：GitHub 玩法、发布检查清单、标签/Release/Topics/分支保护、第二作者与 `Co-authored-by` 协作方式、防利益损失与备份建议。
- README 顶部「重要声明」补充：免费开源/不收费/与腾讯无关系/数据流向；新增「作者与贡献者」章节与免责/安全/贡献/发布指南链接。

## [0.2.2] - 2026-10-31

### 提示词与拟人体验优化

- system 提示词新增「像真人聊天」规则：先接住对方的情绪/重点再回应内容；不复述对方原话、不用客服式附和；
  对方连着发多条短消息时合起来理解、只回一条；回复长短自然变化；允许口语省略和语气词；没听懂就自然追问一句；
  不承诺做不到的事（语音/图片/表情包/见面/转账）；不重复自己最近说过的句式；不连续反问、不追问审问。
- 不改 API / 配置结构，升级无需迁移；`npm run test:sandbox` 基线 30 个测试文件 / 399 个用例。

## [0.2.1] - 2026-10-31

桌面通道稳定性与可发布质量（方案 C 阶段）：

- 读取：改为「会话列表扫描」优先——一次截图 + OCR 拿到未读行与预览文字，
  不再逐个打开聊天；列表未命中/预览为空时回退 `read`，减少漏回与窗口闪烁。
- 发送：新增「会话行坐标」快路径与「当前已打开聊天」路径，实测发送 2.6–4.3 秒；
  失败不再回退到按名字搜索的旧路径，避免点错人/重复发送。
- 安全：新增发送定位硬门——没有行坐标且不是当前会话时返回 `ok:false` 并拒绝发送；
  只信任 180 秒内自己打开过的会话；发送成功后更新当前会话记录。
- 读取循环修复：列表识别失败时按 whitelist 逐个 read 兜底（needRead），
  避免「预览读不到就漏回」。
- 修复会话列表 OCR 放大倍率裁剪 bug、标题判定阈值、行点击 X 坐标、
  名字匹配同首字歧义（LISTSCORE）等问题。
- 新增 `scripts/pwsh/selfcheck.ps1` 一键环境自检（Windows/微信窗口/OCR/构建产物/API）。
- 新增 `AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/TEST-PLAN.md`、`docs/PROMPTS.md`。
- 已知限制：desktop 通道暂不支持发送表情包；OCR 对形近字仍偶有误差，依赖 read 兜底。

### 2026-10-31 可发布质量收尾（同属 0.2.1）

- 发送判定：快发送气泡校验失败时，新增「输入框已清空」像素 ink 兜底判定（深色像素 <20 视为已清空），
  避免气泡 OCR 漏行导致成功发送被误判为失败；判定失败仍绝不重发，宁可 ok:false 也不重复发。
- 会话列表：行锚点改为「绿底选中行 + 固定行距」推算；整栏 OCR 漏名字时按行裁「名字条」二次 OCR；
  放大改为 4x 最近邻插值，显著降低形近字（如「浩→旧」）乱码。
- 抢前台：截图默认 `auto`（PrintWindow 优先），仅窗口被遮挡时才回退屏幕截图，不再每 2 秒抢微信前台。
- 已打开会话：Enter-Chat 增加宽松标题匹配分支，OCR 形近字（如三字名被认成两个字）不再触发 Ctrl+F 搜索。
- 通道轮询：list 未找到行时不再触发 read（避免 Ctrl+F 抢前台、乱开聊天）。
- 自问自答：`isOwnPreview()` 增加 OCR 形近字容错（字符重合率 ≥0.8），发送成功后持久化 lastSentText；
  list 未找到行的联系人不再每轮 read。
- 未读判定：红点检测区域避开头像；预览变化兜底只在旧预览存在时生效（首轮不再全员 unread）。
- 实测（脚本层，文件传输助手）：10 轮 list+send 成功率 100%，list P50/P95=1970/2051ms，
  send P50/P95=2743/3440ms；发送三路径（单字、强制气泡失败、强制未回车）行为符合预期（负例 ok:false）。


## [0.2.0] - 2026-10-30

第二轮迭代：新增「微信分身」设置界面、人格库与人格广场、Host HTTP API、配置持久化，并重写桌面通道脚本。

### 新增

- **设置界面（Web）**：DSH 设置页出现「微信分身」独立分区（`settings.section`），Plugins 页的 bundle 卡片里也有同一套配置页（`plugins.bundle.config`）。纯 JS 客户端插件 `client/client.js`（由宿主 `window.__ModuleLoader__` 加载，不需要重新构建 DSH），共 10 个标签页：
  1. **概览**：引擎/通道状态、今日统计（模型调用、token、搜索、发送、草稿、跳过）、暂停/恢复/一键测试。
  2. **人格**：内置与外装人格列表、查看人格详情、切换当前人格、导入/导出、安装/卸载。
  3. **白名单**：增删联系人（`id`、`name`、`aliases`、备注）、是否只回复白名单。
  4. **在线时段**：工作日/周末时段、每周低活跃日、在线时段外是否暂停。
  5. **回复策略**：字数、温度、思考等级、拆条概率、表情概率、拟人节奏、上下文条数、群聊/单聊开关等。
  6. **表情包**：按情绪查看、上传、删除；可设概率、单条上限、最近不重复数。
  7. **预算与安全**：每日 token 预算、草稿模式比例、摘要调用上限、敏感关键词、风控熔断开关。
  8. **日志与测试**：最近审计日志、写一条模拟入站、发一条测试消息、清空记忆/审计。
  9. **人格广场**：远程人格索引浏览与一键安装（索引不可达时回退内置人格）。
  10. **帮助**：使用说明、更新记录、常用命令与 FAQ 入口。
- **Host HTTP API**：统一前缀 `/dsh-wechat-persona/api/`，仅回环地址可访问，并要求请求头 `x-dsh-wechat-persona: 1`；返回统一 `{ok:true,...}` / `{ok:false,error}`。端点：
  - GET `health` / `status` / `config` / `personas` / `market` / `stickers` / `sticker-file` / `logs` / `help`
  - POST `config` / `personas/install` / `personas/import` / `personas/activate` / `personas/export` / `market/install` / `stickers/upload` / `test/inbound` / `test/send` / `pause` / `resume` / `memory/clear` / `audit/clear`
  - DELETE `personas/{id}` / `stickers`
- **配置持久化**：设置界面保存时经宿主 `ctx.configEditor.edit(...)` 写回 profile 的 `cordis.patch.yml`，重启 DSH 不丢失；宿主未提供 configEditor 时界面自动转为只读并给出提示。
- **人格库**：`personas/builtin/` 内置 4 个人格 —— **小号**（`builtin-small`）、**大肥鱼**（`builtin-dafeiyu`）、**老周**（`builtin-senior`）、**阿码**（`builtin-geek`）。人格包为 v2 格式（`id`/`name`/`avatar`/`style`/`catchphrases`/`systemPrompt`/`examples`/`taboo`/`stickers`/`author`/`description`/`tags`/`packVersion`），并兼容 SillyTavern 角色卡（`char_name` 等字段自动映射）。
- **人格广场**：远程索引 + 一键安装；`market.indexUrl`、`market.builtinOnly`、`market.timeoutMs` 可配置。
- **表情包管理**：界面内按情绪目录查看/上传/删除表情包。
- **联系人偏好记忆（0 token）**：从对方消息里按规则提取称呼/忌口/共同话题等稳定偏好，落盘到该联系人记忆，并在系统提示词中渲染成一行背景；不额外调用模型、不额外花 token。
- **表情包多来源**：插件包内置 + 用户上传目录 + 当前人格包自带；全局 id 采用 `<来源>:<情绪>/<文件名>`，同名文件跨来源不冲突；设置界面按情绪与来源分组展示。
- **配置迁移（v1 → v2）**：`migrateConfig()` 自动把旧 `schedule.onlineStart/onlineEnd` 补成工作日/周末时段，并补齐 `persona.activeId`/`persona.enabled`、`whitelistOnly`、`reply.groupChatEnabled`/`privateChatEnabled`/`maxContextTurns`；旧 `reply.personaDir` 只提示不删除，迁移幂等且不动数据。
- **文档**：新增本文件（项目根 `CHANGELOG.md`）与全中文用户手册 [`docs/使用说明.md`](docs/使用说明.md)；设置页「帮助」标签与 `GET /help` 直接读取这两份文件。
- **桌面通道脚本重写为视觉驱动**：`scripts/pwsh/wechat-uia.ps1` 改为「窗口区域截图 + Windows OCR + 坐标点击/Unicode 键入」，不再依赖 UIA 控件树；支持 PrintWindow 后台截图、空白检测回退、焦点/光标位置恢复。

### 变更

- 版本号 **0.1.0 → 0.2.0**；`package.json` 增加 `dsh.client`（`platform: web`、`immediately: true`、inject locale/settings/plugin-manager）、`exports["./client"]`，`files` 增加 `client`/`personas`/`docs`/`CHANGELOG.md`。
- README 增补：设置界面入口、人格市场、使用说明、配置迁移、dataDir 实机说明、安装/更新/测试命令、版本记录与第二轮验收对账。
- `docs/CHANNELS.md` 的 desktop 段按真实实现重写，并新增「真实环境验证清单」（明确哪些行为尚未在真实微信窗口上验证）。
- 桌面通道的时间闸门不再由脚本硬编码：脚本只在显式设置 `WXUIA_ACTIVE_HOURS` 时限时，在线时段统一由插件配置 `schedule` 管理。

### 修复

- **桌面通道 read 永远返回空数组（两个根因）**：
  1. 旧脚本用 `$geo2.right` 取聊天分栏右边界，但窗口几何里没有 `right` 字段 → `$null`；PowerShell 中 `$x -gt $null` 恒为 `True`，所有 OCR 行都被当成“自己发的”跳过。新版窗口几何包含 `right`/`bottom`，分栏左边界按窗口宽度比例（默认 62%）计算。
  2. `Merge-OcrLines` 返回值被一元逗号与调用点 `@()` 双重包装成“数组套数组”，随后 `[int]$c.top` 抛 `Cannot convert the "System.Object[]" value of type "System.Object[]" to type "System.Int32"`，read 整体失败。已改为返回扁平数组。
- **桌面通道 send 假成功**：旧脚本在用户键鼠空闲不足时直接返回 `{"ok":true}` 但根本没发送；新版明确返回 `{"ok":false,"error":"…放弃发送…"}`。
- **硬编码“夜里不读消息”闸门**：旧脚本 `hour < 8 或 >= 21` 直接返回空，导致夜间完全静默且原因不明；已改为可选 `WXUIA_ACTIVE_HOURS`。
- **x64 `INPUT` 结构体大小错误**：旧结构 32 字节，Windows 要求 40 字节，`SendInput` 的 `cbSize` 校验失败导致键入（尤其是中文）可能从未生效；重写为 `INPUT { type; INPUTUNION }`（`MOUSEINPUT`/`KEYBDINPUT` 共用偏移），实测 40 字节。
- **基线去重从未生效**：旧版基线保存裸 hash 数组，比较时却用 `pc-<hash>-<n>` 格式；新版 state v2 `{texts, updatedAt}` + 尾部对齐算法，基线对不上时重建而不是把历史消息当新消息投递。
- **发送后不校验**：新版发送后截图 OCR 确认气泡出现在聊天区（容错匹配），最多重试 3 次，仍失败返回错误，不误报成功。
- **OCR 汉字间空格**：Windows OCR 常在汉字间插空格（`你 好 ， 在 吗`），投递前会清理为 `你好，在吗`，避免污染模型上下文与记忆。
- **找不到联系人时不再“按回车碰运气”**：搜索框定位 → 左栏搜索结果 → 回车 → 会话列表首项四重回退，且必须通过聊天标题校验；确认不了就返回读取失败，避免读错/发错人。
- 桌面通道结束时恢复光标位置、前台窗口与最小化状态；窗口被遮挡时才临时前置。

### 测试与验证

- 单元 + 集成测试：**29 个测试文件 / 388 个用例**；`npm run typecheck` 0 错误；受限沙箱用 `npm run test:sandbox`（直接 `npm test` 在受限沙箱会因 esbuild 受限失败，属预期）。
- 桌面通道脚本：Windows PowerShell 5.1 语法解析 **0 错误**、保持 **UTF-8 BOM**；结构体实测 `INPUT=40`/`KEYBDINPUT=24`/`MOUSEINPUT=32`。
- 自建假微信窗口端到端集成测试（5 个用例全部通过）：首次无基线读取 → 建立基线并返回空 → 新增一条消息只回报 1 条 → 发送后 OCR 校验成功 → 错误联系人明确失败。
- **未在真实微信窗口上验证**：真实微信的 OCR 识别率、搜索框/发送按钮位置、分栏比例、消息气泡合并、被踢登录、休眠唤醒、多显示器/缩放等，详见 [docs/CHANNELS.md](docs/CHANNELS.md) 的「真实环境验证清单」。

## [0.1.0] - 2026-10-30

首个可用版本（MVP）：把微信小号做成有人格的 AI 聊天分身，全程本地规则控成本、控风险。

### 新增

- Cordis 插件入口（`src/index.ts`）与 schemastery 配置 schema（`src/config.ts`），配置可在 DSH「插件配置」表单中编辑，也支持写入 profile 的 `cordis.patch.yml`。
- 回复引擎：白名单 → 在线时段 → 限频 → 预算 → 去重/过滤 → 记忆 → （按需）搜索 → 生成 → 拟人化拆条/延迟/表情包 → 通道发送。
- 0-token 本地判断（`src/core/gate.ts`）：白名单、时段、群聊、纯表情/无意义消息、重复消息、敏感关键词全部本地拦截。
- 每联系人记忆：最近 30 条 + 长期摘要（每 50 条压缩一次），JSON 本地落盘，可一键清空。
- 拟人节奏：0.8–5 秒随机“正在输入”、按概率拆 2–3 条、表情包按情绪随机且最近 8 次不重复。
- 每日 token 预算：默认 5 万，达 85% 切草稿模式（只生成不发），超限停止；审计日志记录每条消息的 token 用量。
- 按需联网搜索：仅天气/新闻/新梗/地点/价格等意图触发，失败自动降级。
- 风控熔断：验证码、异常登录、限制提示等文案命中 → 1 秒内暂停全部自动化并通知，不自动重试、不自动恢复。
- 一键停止：DSH 工具 `wechat_persona_pause` / `wechat_persona_resume`，聊天内 `/stop` 指令，状态落盘重启后保持。
- 四个可插拔通道：
  - `mock`（默认）：读 `inbound.jsonl` / 写 `outbox.jsonl`，不碰真实微信，适合验收；
  - `phone-adb`（推荐）：`dumpsys notification` 读通知 + `adb input`/ADBKeyboard 发送；
  - `windows-vm`：JSON-lines over TCP（默认 `127.0.0.1:47653`）对接 VM 内参考 agent；
  - `desktop`（默认关闭）：当前桌面通过 PowerShell 脚本驱动微信 PC。
- DSH 运维工具 6 个：`wechat_persona_status` / `pause` / `resume` / `send_test` / `clear_memory` / `clear_audit`。
- 审计日志 `audit.jsonl`（0-token 跳过原因、token 用量、搜索、发送、草稿），可清空、按大小滚动。
- 文档：`README.md`、`docs/ACCEPTANCE.md`、`docs/CHANNELS.md`、`persona/` 与 `stickers/` 样例、`cordis.patch.yml`。
- 测试基线：22 个测试文件 / 204 个用例；`npm run typecheck` 0 错误；`npm run build` 产出 `dist/` 70 个文件；本机 DSH 桌面版 0.2.1-rc.3 安装、工具注入、实机 pause/resume、状态与审计落盘均已验证。

### 说明

- 本插件通过自动化方式操作微信客户端/手机通知，**违反《微信软件许可及服务协议》**，账号可能被限制或封禁，风险由使用者自行承担；请只使用自己注册的小号，并遵守当地法律法规。
- 只处理白名单单聊；支付、转账、红包、验证码、密码等敏感话题被本地规则拦截并暂停；不注册账号、不自动加好友、不群发、不进群。

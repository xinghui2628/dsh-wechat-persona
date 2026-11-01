# 排障指南（v3.0.0）

本指南针对 dsh-wechat-persona 在 Windows + PC 微信 + DSH 桌面版下的常见故障。所有命令都在仓库根目录执行；路径中的 `<dataDir>` 指插件数据目录（默认 `<DSH 默认工作区>\.dsh-wechat-persona\`，可用配置 `dataDir` 覆盖）。

先记住三个原则：

1. **先看状态，再看日志，最后才改配置**。绝大多数「没回复 / 发不出」在状态里已有原因。
2. **宁可不发也不发错人**：插件在定位不到聊天、识别不确定、结果未知时会主动拒绝发送，这通常不是 bug，而是保护。
3. **不要用真实好友做压力测试**。用 mock 通道或 `POST /test/inbound` 注入测试消息。

## 0. 30 秒定位法

按顺序执行，哪一步异常就跳到对应章节：

```powershell
# 1) 插件与通道状态（DSH 工具，或设置页「概览」）
wechat_persona_status

# 2) 本机 API 是否活着（把 <DSH端口> 换成实际端口）
curl.exe -s -H "x-dsh-wechat-persona: 1" http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api/health

# 3) 一键自检（Windows/微信/DSH/OCR/构建产物/API/数据目录）
powershell -ExecutionPolicy Bypass -File scripts/pwsh/selfcheck.ps1 -Port <DSH端口>

# 4) 最近日志
Get-Content "$env:TEMP\dsh-wechat-persona-debug.log" -Tail 50
Get-Content "$env:TEMP\wxuia-engine-debug.log" -Tail 80
Get-Content "<dataDir>\audit.jsonl" -Tail 20
# 5) 桌面通道 OCR 诊断（只读，不截图、不含聊天正文）
curl.exe -s -H "x-dsh-wechat-persona: 1" http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api/diagnostics/ocr
```

`wechat_persona_status` 会直接给出：暂停/原因、通道状态与 detail、熔断、预算与今日统计、投递三态计数（`delivery.sent / notSent / unknown`）、暂存条数（`deferredCount`）、安全运行模式（`safeMode`）、发送模式（`sendMode`）、待批准草稿数（`pendingDrafts`）与最近一次发送状态（`sendState`）。**先读它，再做别的。**

## 1. 插件 API 404 / 设置页空白 / 改代码不生效

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| `GET /dsh-wechat-persona/api/health` 返回 404 | 插件没启动、DSH 端口变了、路径拼错 | 确认设置页插件开关为开启；用 `selfcheck.ps1 -Port` 拿真实端口；路径必须精确到 `/dsh-wechat-persona/api` |
| 设置页「微信分身」页空白或一直加载 | 设置页 API 没挂载成功 | 看 `%TEMP%\dsh-wechat-persona-debug.log` 里 `bootDebug` 输出的挂载失败原因；常见是宿主版本较老，缺少 `webServer` / `configEditor` 服务 |
| `POST /config` 返回 403 | 缺 `x-dsh-wechat-persona: 1` 请求头（或值不是 `1`） | 所有 API 必须带该头；若启用了 API token，还要按 [docs/SECURITY.md](SECURITY.md) 带 `Authorization` |
| 改了 `src/` 但行为没变 | 运行的是旧 `dist/`，或插件未重载 | `npm run build`，然后在 DSH 插件页把本插件**关 2 秒再开**（或重启 DSH） |
| 改了 `client/` 但设置页没变 | 浏览器/设置页缓存 | 刷新设置页；`client/` 无需构建 |
| 设置页能看不能改 | 宿主没有 `configEditor` 服务 | 界面只读属预期；直接改 profile 的 `cordis.patch.yml` 后重启 DSH |
| API 能通但数据目录不对 | `dataDir` 相对路径按「默认工作区」解析 | 用绝对路径填 `dataDir`，或确认 DSH 当前默认工作区；启动日志会打印解析后的数据目录 |

插件启动日志的位置与内容：`src/index.ts` 的 `bootDebug` 会把「设置页 API 挂载失败、工具注册失败、通道启动失败」等写入 `%TEMP%\dsh-wechat-persona-debug.log`。如果设置页整体打不开，先确认插件是否出现在 DSH 插件列表里——插件加载失败时 DSH 自身日志会报错。

## 2. 403 / 鉴权相关

当前版本的 API 鉴权分两层：

1. **来源限制**：只接受本机回环地址（`127.0.0.1` / `::1`）的请求，局域网来源一律 403（`src/server/api.ts`）。
2. **请求头**：必须带 `x-dsh-wechat-persona: 1`，否则 403。

如果之后按 [docs/SECURITY.md](SECURITY.md) 启用了可选 API token，还需要带 token；token 缺失/错误同样是 403，但**不会触发发送**。排查 403 时先看响应 JSON 的 `error` 字段——它写的是哪一层拒绝（来源 / 请求头 / token / 方法不允许）。

> 注意：本文不把任何 token 写进命令行历史或文档；设置页与 `cordis.patch.yml` 里的配置项以 [docs/SECURITY.md](SECURITY.md) 为准。

## 3. 为什么没回复（入站被跳过）

引擎的入站判断集中在 `src/core/gate.ts` 的 `evaluateInbound()`（纯本地、0 token），命中后写审计日志（`type: "skip"`，带 `reason`）。按优先级从高到低：

| `reason` | 含义 | 处理 |
| --- | --- | --- |
| `disabled` | 插件总开关 `enabled=false` | 设置页开启 |
| `breaker` | 风控熔断已触发 | 人工确认微信安全后 `wechat_persona_resume`（见 §6） |
| `paused` | 手动暂停 / 聊天内 `/stop` / 命中禁止话题 | 查 `pauseReason`；`/resume` 或工具恢复 |
| `group-chat` | 群聊默认不回复 | 需要时显式开 `reply.groupChatEnabled` 且发送者在白名单 |
| `self-message` | 自己发的消息（通道能区分时） | 正常 |
| `not-whitelisted` | 对方不在白名单 | 加白名单；确认 `whitelistOnly` 是否符合预期 |
| `empty-message` | 空消息 | 正常 |
| `noise` | 纯标点/空白（如「。。。」） | 正常 |
| `pure-sticker` | 纯表情/非文本，且 `reply.ignorePureSticker=true`（默认） | 想回就把它设为 `false` |
| `duplicate` | 同一联系人同一消息 id 已处理过（防通道重投） | 正常 |
| `offline-hours` | 不在作息在线时段 | 见 `schedule`；低活跃日也受限制 |
| `rate-hour-limit` | 每人每小时回复上限（默认 10） | 等下一小时，或调 `rateLimit.perContactPerHour` |
| `rate-day-limit` | 每人每天回复上限（默认 60） | 次日恢复，或调 `rateLimit.perContactPerDay` |
| `rate-interval` | 距上次回复小于最小间隔（默认 30s） | 正常 |
| `low-activity-day-limit` | 每周低活跃日每人每日上限（默认 5） | 见 `schedule.lowActivityWeekday` |
| `forbidden-content` | 命中禁止话题（转账/验证码/博彩等），默认直接暂停引擎 | **人工查看**后决定是否恢复；不要一恢复就继续同一话题 |
| `persona-disabled` | 人格关闭或人格 systemPrompt 为空 | 检查 `persona.enabled` / `persona.activeId` |
| `private-chat-disabled` | `reply.privateChatEnabled=false` | 单聊开关打开 |
| `self-echo` | 识别到「自己刚说过的话」被回读成入站（防自言自语） | 正常保护 |
| `budget-hard-stop` | 当日 token 预算已用尽 | 见 §6；次日自动恢复 |
| `engine-exception` / `model-failed` | 引擎异常 / LLM 调用失败 | 看 `audit.jsonl` 与 DSH 日志；检查模型服务配置与网络 |
| `empty-reply` | 模型返回空内容 | 偶发可忽略；频繁出现看 prompt/模型输出 |

查看最近跳过：

```powershell
Get-Content "<dataDir>\audit.jsonl" -Tail 200 | Select-String '"type":"skip"' | Select-Object -Last 10
```

通道层还有一层过滤：桌面通道会把「列表预览变化」当作新消息候选，读取不完整/疑似串聊时会退回预览或丢弃，宁可漏回也不回错。这类消息可能**根本没有进入 gate**，因此在桌面通道下看到「有消息但无 skip 记录」时，看 `%TEMP%\wxuia-engine-debug.log` 的 OCR/读取记录。

## 4. OCR 乱码 / 识别差

### 4.1 先确认 WinRT OCR 是否可用

```powershell
powershell -ExecutionPolicy Bypass -File scripts/pwsh/ocr-winrt.ps1 -Path .\test\fixtures\ocr-corpus\images\clear-00.png
```

- 输出单行 JSON，`{"ok":true,...,"lines":[...]}` 表示 OCR 引擎正常；`{"ok":false,"error":"..."}` 表示不可用（脚本会以 exit code 1 结束）。
- 常见错误「WinRT OCR 引擎创建失败：语言 zh-Hans-CN 不可用且系统语言也不可用」→ 在 Windows「设置 → 时间和语言 → 语言」安装**中文（简体）**语言包（含 OCR/手写组件），装完重启。
- 非 Windows 系统没有 WinRT OCR，桌面通道不可用，只能跑 mock 通道与单元测试。

### 4.2 已知的识别特性（不是 bug）

- **中文字间空格**：Windows OCR 常把一行中文识别成「今 天 大 肥 鱼」。v3.0.0 的 `src/core/ocr/normalize.ts` 会在展示前去掉 CJK 字符之间的空格；比较时用更严格的 `compareKey`（去空白/标点、全角转半角、小写）。不要把原始 OCR 空格当成故障。
- **形近字**：如「己/已」「未/末」「0/O」等，OCR 本身分辨不了。受控纠错只做「同长度、至多差一字、命中高频词」的替换，且**敏感区段（wxid/手机号/金额/日期/邮箱/URL/订单号/验证码/密码/身份证）一律跳过**（`src/core/ocr/correction.ts`）。因此你看到敏感数字没被"纠正"是设计如此。
- **表情包、图片、语音、视频消息**：桌面通道能力声明为 `stickers:false / images:false / voice:false`，不会识别，也不会回复（纯表情默认被 gate 忽略）。
- **深色主题、缩放、模糊、遮挡、窗口过小**：识别率明显下降。桌面通道连续失败 6 次后会进入 `degraded`（`detail` 会显示「连续失败 N 次，已停摆；请重载插件恢复」）。恢复方法：关掉再开插件（或重启 DSH），并保证微信窗口可见、未被遮挡、分辨率 ≥1366×768。
- **长消息/多行气泡**：可能被截断。插件会优先用「列表预览 → 读取校验」交叉比对；校验失败时退回预览或不投递，因此可能出现「对方发了长消息，这边没回」。
- **同一帧的稳定性**：v3.0.0 的读取是「同一次读取的所有行来自同一帧截图」（`captureId`），并配合 `ack` 水位线防止重放/漏读。Phase C 已双向接线：`desktop.ts` 的 read 传 `-Ack`，`wechat-uia.ps1` 回传 `captureId/pane/lines[].side/box/messages[]`，对未确认行重放；消息 id 是 `pc-<帧号>-<消息序号>-<几何哈希>`（不含 OCR 文本，跨帧稳定），TS 侧 `planInboundDispatch` 拒投 `uncertain` 行并把 ack 落 `desktop-ack.json`。
- **置信度门禁（v3.0.0）**：每条消息会按置信度评估分三路——`accept` 正常投递；`verify` 会用同一张截图再跑一次第二引擎（`-SecondOcr`）复评；`reject`（含 `contactVerified=false` 硬否决、极低分）**不投递、不推进 ack**，脚本 pending 会在下次读取时重放，不会永久吞消息。你可以在 `GET /diagnostics/ocr` 看到 `rejectCount`、`uncertainCount`、`conflictCount` 与 `secondOcrUsed`。
- **双引擎分层决策**：第二引擎（RapidOCR）与 WinRT 行重叠 ≥0.90 记为 `agree` 并采用其置信度；0.35–0.90 记为 `conflict`（计入 `conflictCount`），只有第二引擎 score ≥0.85 才替换文本；匹配不到记为 `single`。**不再是「谁更长谁赢」**；第二引擎缺失时静默回退为单引擎。
- **真实微信窗口下尚未端到端验证**（见 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) 门槛 2）；旧脚本输出按 legacy 分支处理；`fusion/align/tracker` 目前只在单测中使用，未接入生产读取路径。

### 4.3 想量化识别质量

```powershell
# 只跑 1 张 clear 场景的原图（不联网、不截图）
node scripts/ocr/bench.mjs --engine=winrt --limit=1 --scenario=clear --pipeline=raw
# 全量基准（需要 Windows OCR 语言包；RapidOCR 需要 Python 依赖）
node scripts/ocr/bench.mjs --engine=all --out-dir=test/fixtures/ocr-corpus/results
```

当前基准数字、指标定义与环境见 [docs/OCR-BENCHMARK.md](OCR-BENCHMARK.md)。v3 发布门槛的离线等价 A/B 结论：eval 集（tune/eval 不重叠）v3 CER **21.38%** / 整句 **47.83%**，同集 v0.2.8 为 37.37% / 28.26%（详见 OCR-BENCHMARK.md §6.5）。注意：bench 只读合成语料，数字用于比较方案，不代表你在任意主题/缩放下都有同样准确率；真实微信截图需授权后自行采样对照。

### 4.4 排障日志

- `%TEMP%\wxuia-engine-debug.log`：每次自动化调用的 OCR 行、REGION、点击/发送决策。搜索关键词 `OCR`、`REGION`、`send`、`captureId`。
- `<dataDir>\audit.jsonl`：`type:"skip"`（被判定跳过）、`type:"send"` / `"send-fail"`（发送结果与 `delivery`）。
- `GET /diagnostics/ocr`：只读返回桌面通道最近一次读取的诊断元数据（`captureId`、引擎列表、行数、`uncertainCount`/`rejectCount`/`conflictCount`、耗时、`lastReadAt`、`lastError`、`dpi`/`scale`、`screenshotMode`、`engineVersion`、`secondOcrUsed`、`qualityStatus`）；不触发截图、不含正文、不落盘。
- 桌面通道 `channelState=degraded` 时看 `channelDetail`。

## 5. 发送被拒原因表

自动回复与手动发送（`wechat_persona_send_test` / `POST /test/send`）共用同一套门禁 `canSend()`（`src/engine/engine.ts`）。被拒时会返回中文原因，并写 `send-fail` 审计（`delivery` 多为 `not-sent`）。

### 5.1 门禁层（与通道无关）

| reason | 文案（示例） | 处理 |
| --- | --- | --- |
| `paused` | 引擎已暂停或停止，等待恢复后再发送；引擎已暂停：`<reason>` | 恢复后用；`/test/send` 此时会直接 409 |
| `breaker` | 熔断已触发：`<reason>` | 人工确认微信安全后再恢复 |
| `safe-mode` | 安全模式已开启：禁止向真实通道发送，仅允许 mock 空转 | 确认要真实发送后，在设置页「预算与安全」关闭 `safeMode`（或改配置） |
| `budget-hard-stop` | 今日 token 预算已用尽 | 次日自动恢复，或调整 `budget.dailyTokens` |
| `not-whitelisted` | 联系人 `<id>` 不在白名单内 | 手动发送只允许白名单联系人 |
| `rate-hour-limit` | 每小时上限 10 条（本小时已 N 条） | 等下一小时 |
| `rate-day-limit` | 每日上限 60 条（今日已 N 条） | 次日恢复 |
| `rate-interval` | 距上次回复 Ns，小于最小间隔 30s | 稍等 |
| `low-activity-day-limit` | 低活跃日每日上限 N 条 | 低活跃日限制 |

### 5.2 桌面通道层

| 文案 | 含义 / 处理 |
| --- | --- |
| `桌面通道已禁用` / `driver disabled` / `通道未启动` | 检查三重开关：插件 `enabled`、`channels.desktop.enabled`、`channels.desktop.driverEnabled`；通道 `state` 必须是 `running` |
| `桌面通道暂不支持发送表情（UIA 表情面板未实现）` | 桌面通道只能发文本；不要指望它发表情包 |
| `空消息不发送` | 文本为空 |
| `缺少聊天定位信息（会话列表里没有 <联系人> 的行坐标），已拒绝发送以避免发错人` | 微信会话列表里没有该联系人，或列表没被成功读取。打开微信让该聊天出现在会话列表，或手动点开该聊天后再试。**这是防跨联系人误发的保护，不要绕过** |
| `用户正在使用电脑，暂停发送中（剩余 N 秒）` | 检测到你正在操作键鼠，让路中；等待或调 `channels.desktop.userActivityIdleMs` / `pauseSeconds` |
| `无法确认用户键鼠空闲状态，已拒绝发送（user-activity 读取失败）` | `scripts/pwsh/user-activity.ps1` 调用失败；桌面通道进入 `degraded`。重载插件后重试，仍失败看 `%TEMP%\wxuia-engine-debug.log` |
| `发送脚本失败 code=...` | 脚本层错误，透传原因在脚本 stdout 的 `error` 字段；常见于微信窗口标题不匹配（`channels.desktop.windowTitle`）、输入框未清空、目标聊天未确认 |

### 5.3 三态投递（v3.0.0 关键行为）

发送结果分三态（`src/types.ts` 的 `SendDelivery`）：

- `sent`：确认已发出（脚本确认回车并看到消息气泡）。
- `not-sent`：确认**没发出去**（如缺少定位、被拒绝、输入框异常）——可以安全重试。
- `unknown`：脚本执行了但无法确认（如已回车但气泡未确认）——**绝不重试**，避免重复发送。

因此你偶尔会看到「消息可能发重/状态 unknown」的告警，但**不会看到因为结果未知而自动重发**。`wechat_persona_status` 的 `delivery` 计数可直接看到三类结果数量。若 `notSent` 持续增长，按 §5.2 对照文案处理。

**发送幂等账本（v3.0.0）**：每次生成/发送前会创建 `sendOperationId`，引擎在 `canSend` 之后、`channel.send` 之前查 `<dataDir>\send-ledger.json`：同一个 `opId + partIndex` 只执行一次；`confirmed/cancelled/unknown` 是终态，不会再次发送；`failed` 只有在账本证明 `not-sent` 且尝试次数 <3 时才允许重试。账本只存文本哈希、不存正文，上限 200 条。若看到 `send-ledger` 相关的跳过审计（`skip-duplicate`），说明该操作已终结，属预期保护。

### 5.4 草稿模式（`sendMode=draft/confirm`）

`src/config.ts` 的 `sendMode` 有三级：`auto`（默认，生成后自动发送）、`draft`（只生成草稿、需设置页人工批准）、`confirm`（生成草稿、人工确认后发送）。**`safeMode=true` 优先级最高**：无论 `sendMode` 是什么都只生成草稿。

| 现象 | 原因 / 处理 |
| --- | --- |
| 有回复但不发送、`pendingDrafts` 增加 | 当前是 `draft`/`confirm`/`safeMode`/预算草稿模式；到设置页「日志与测试 → 待发送草稿」或 `GET /drafts` 查看 |
| `POST /drafts/approve` 返回 404 | 草稿 id 不存在或已被清理 |
| `POST /drafts/approve` 返回 409 | 草稿已处理（approved/rejected/expired）、或批准时门禁拒绝（暂停/熔断/预算/白名单/频控/safeMode）、或引擎未启动；响应 message 会给出具体原因 |
| 批准后返回 `unknown` | 结果无法确认，**不会自动重发**；先到微信客户端人工确认，再决定是否重新生成 |
| 草稿一直不出现 | `sendMode=auto` 且未触发预算/safeMode；或引擎未启动 |
| 想直接放弃草稿 | 设置页「拒绝」或 `POST /drafts/reject`；删除 `<dataDir>\drafts.json` 等于放弃全部未批准草稿（不会发送） |

草稿存于 `<dataDir>\drafts.json`（上限 50 条、24 小时 TTL、只保留 pending/已处理记录）；批准会**重新走一遍 `canSend` 全部门禁**并复用同一 `opId`，因此同一草稿不会被批准两次。

## 6. 预算 / 草稿模式 / 熔断 / 暂停与恢复

### 6.1 预算三阶段（`src/core/budget.ts`）

| `budgetPhase` | 条件 | 行为 |
| --- | --- | --- |
| `ok` | 已用 < `dailyTokens × draftModeRatio` | 正常生成并发送 |
| `draft` | 已用 ≥ 85%（默认 `draftModeRatio=0.85`） | 仍生成，但**只写草稿不发送**；草稿写入 `<dataDir>\drafts.json`（审批队列，上限 50、24h TTL）并兼容追加 `<dataDir>\drafts.jsonl`，审计 `reason=budget-draft` |
| `exhausted` | 已用 ≥ `dailyTokens`（默认 50000） | 硬停：不再调模型、不发送；次日按 `dayKey` 自动清零 |

- `/status` 里 `budget` + `budgetPhase` + `today.llmTokens` 可判断当前阶段。
- 想恢复发送：等次日，或调高 `budget.dailyTokens`。不要通过反复暂停/恢复绕过预算。
- 摘要调用另有 `budget.maxSummaryCallsPerDay`（默认 4）限制。

### 6.2 熔断（风控）

- 触发：入站消息命中风控信号（验证码/异常登录/限制提示等，`src/core/breaker.ts` 的 `detectRisk`）。触发后：写熔断状态 → 暂停引擎 → `abort` 打断在飞回复 → 停通道 → 发 critical 通知 → 落盘。
- 已触发时 `wechat_persona_status` 显示「熔断：已触发（原因, 时间）」，`audit.jsonl` 有 `type:"risk"`。
- **恢复前置条件**：必须先在微信客户端人工确认账号安全（能正常收发、没有验证码/限制弹窗）。然后 `wechat_persona_resume`——它会清暂停 + 清熔断 + 重建 AbortController + 重启通道。
- `safety.circuitBreakerEnabled=false` 只关闭「自动熔断暂停」，仍会记录风险与通知；不建议关闭。

### 6.3 暂停与恢复

- 暂停入口：聊天内 `/stop`（仅白名单联系人）、`wechat_persona_pause`、`POST /pause`、禁止话题触发、熔断。
- 暂停状态**持久化**（`state.json` 的 `paused/pauseReason/pausedAt`），重启 DSH 后仍是暂停；`engine.start()` 发现暂停/熔断会保持不启动通道（预算耗尽不会阻止启动，否则次日无法自愈）。
- 恢复入口：`wechat_persona_resume` 工具或 `POST /resume`（二者等价：清暂停 + 清熔断 + 重启通道）。
- 聊天内目前只有 `/stop` 生效；`src/core/stop.ts:17` 定义了 `isResumeCommand`（`/resume`、`/start`）但当前版本**尚未接入引擎**——暂停后发聊天命令不会恢复，请用工具或 API。等该能力接入后本文会更新。
- 暂停期间白名单入站消息**不丢**：写入 `<dataDir>\deferred-inbound.json`（最多 50 条），恢复后按顺序补处理；恢复中途再次暂停则剩余继续保留。`wechat_persona_status` 的 `deferredCount` 可看暂存数量。
- 草稿模式产生的草稿**不会自动补发**：预算草稿与 `sendMode=draft/confirm` 的草稿都在 `<dataDir>\drafts.json`，需要人工在设置页或 `POST /drafts/approve` 批准（批准时重走全部门禁）；`safeMode` 下即使批准也会被拒。历史追加文件 `<dataDir>\drafts.jsonl` 仅作兼容记录，不参与审批。

### 6.4 安全运行模式与发送模式

- `safeMode`（设置页「预算与安全 → 安全运行模式（禁止真实发送）」，默认 `false`）：开启后 `mock` 以外的真实通道一律拒发（`reason=safe-mode`），但草稿仍会生成，适合先观察效果再决定是否放行。
- `sendMode`（设置页「预算与安全 → 发送模式」）：`auto` 自动发送 / `draft` 只生成草稿 / `confirm` 生成草稿待确认；默认 `auto` 以保持旧行为。
- 优先级：预算草稿/超限 > `safeMode` > `sendMode`（例如 `safeMode=true` 时即使 `auto` 也只出草稿）。任何模式下都受 §5.1 门禁与 §5.3 幂等账本约束。

## 7. 通道专项

| 通道 | 启动前置 | 常见问题 |
| --- | --- | --- |
| `mock` | 无（默认通道） | 无入站时不会回复；需要 `channels.mock.inboundFile` 指向 JSON 文件，或 `POST /test/inbound` 注入；只写 `outbox.jsonl`，不碰真实微信 |
| `phone-adb` | `adb` 可用、设备已连接、微信已登录、中文输入法方案就绪 | 先 `adb devices` 确认 serial；中文输入建议 ADBKeyboard（`channels.phoneAdb.inputMethod=adb-keyboard` 且 IME 已安装）；坐标类兜底项（`sendButton`/`stickerGrid`）需按设备分辨率自行标定 |
| `windows-vm` | VM/独立会话里的 `vm-agent` 已监听、token 一致 | 看 `channels.windowsVm.host/port/token`；token 不一致会被 agent 拒绝；连接失败在 `channelDetail` 里 |
| `desktop` | Windows + PC 微信 + 中文 OCR 语言包 + `channels.desktop.enabled=true`（默认 `false`）+ `driverEnabled=true`（默认 `false`） | 见 §4、§5；窗口标题默认「微信」，被改过要同步 `windowTitle`；不要在微信窗口被最小化/遮挡/远程桌面缩放下跑 |

> 桌面通道的能力边界：只读屏幕像素做 OCR，不读微信聊天数据库；只操作微信窗口与本仓库脚本；不主动加好友、不群发、不点陌生链接。详见 [docs/ARCHITECTURE.md](ARCHITECTURE.md) 与 [docs/SECURITY.md](SECURITY.md)。

## 8. 日志与数据位置

| 位置 | 内容 |
| --- | --- |
| `%TEMP%\dsh-wechat-persona-debug.log` | 插件启动、设置页 API 挂载、工具注册、通道启停 |
| `%TEMP%\wxuia-engine-debug.log` | 自动化脚本 OCR/点击/读取/发送决策 |
| `<dataDir>\state.json` | 暂停/熔断/预算/频控/去重指纹/统计 |
| `<dataDir>\drafts.json` | v3 草稿队列（正文、24h TTL、上限 50，供人工批准） |
| `<dataDir>\send-ledger.json` | 发送幂等账本（opId/partIndex、状态、尝试次数、文本哈希；上限 200） |
| `<dataDir>\desktop-ack.json` | 桌面通道每个联系人的 ack 水位线（captureId），跨重启防重放 |
| `<dataDir>\audit.jsonl`（历史轮转 `audit.1.jsonl`） | llm / send / send-fail / skip / risk / search / draft / send-state 事件与耗时 |
| `<dataDir>\alerts.jsonl` | 通知/告警记录 |
| `<dataDir>\memory\` | 每联系人记忆 |
| `<dataDir>\drafts.jsonl` | 预算草稿模式下的旧追加记录（兼容格式） |
| `<dataDir>\deferred-inbound.json` | 暂停期间暂存的入站消息 |
| `<dataDir>\outbox.jsonl` | mock 通道的模拟出站 |

清空数据：`wechat_persona_clear_memory`（清记忆）、`wechat_persona_clear_audit`（清审计）；彻底清理时停插件后删除 `<dataDir>`（会丢失状态、记忆、审计与草稿，不可恢复）。

## 9. 提问题前请收集（并脱敏）

1. `wechat_persona_status` 输出（可把联系人名替换为 `A/B/C`）。
2. `channelState` / `channelDetail` / `budgetPhase` / `delivery` / `deferredCount` / `safeMode` / `sendMode` / `pendingDrafts` / `sendState`。
3. 相关时间段的 `audit.jsonl` 片段（**先删除/替换真实联系人名与消息内容**）。
4. `%TEMP%\wxuia-engine-debug.log` 对应时间片段（同样脱敏；不要附真实聊天截图）。
5. 版本：`package.json` 版本、DSH 版本、Windows 版本、微信 PC 版本、是否安装中文 OCR 语言包。

禁止在 issue / 聊天中粘贴真实好友名、wxid、手机号、邮箱、API key、本机绝对路径或真实聊天截图——仓库有 `node scripts/check-sensitive.mjs` 扫描，维护者也会按 [docs/SECURITY.md](SECURITY.md) 处理敏感报告。

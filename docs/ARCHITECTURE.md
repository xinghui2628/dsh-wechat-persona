# 架构说明（v3.0.0）

> 适用版本：**3.0.0（开发中，未公开发布）**；上一已发布版本 v0.2.8。
> 本文按当前 `feat/v3.0.0` 分支的真实代码结构编写；文中标注「未验证」的能力表示代码与单测已落地但**真实微信环境尚未验证**，不要按“已在真机生效”理解。
> 相关文档：[使用说明](使用说明.md)｜[通道说明](CHANNELS.md)｜[OCR 设计](OCR-DESIGN.md)｜[OCR 基准](OCR-BENCHMARK.md)｜[安全说明](SECURITY.md)｜[发布门槛](RELEASE-CHECKLIST.md)。

## 1. 定位与约束

dsh-wechat-persona 是 DSH（DeepSeek Harness）的插件：把一个**微信小号**变成有固定人格的 AI 聊天分身，被动回复白名单好友。

硬约束（架构层面的“不可协商项”）：

| 约束 | 含义 |
| --- | --- |
| 只跑在 DSH 宿主内 | 通过宿主提供的 `llm`、`web.search`、`webServer`、`tools`、`configEditor` 等结构化服务工作，不直接读宿主内部文件 |
| 只支持 Windows + 微信 PC | 真实通道（phone-adb / windows-vm / desktop）都是 Windows 上的自动化；mock 通道全平台可用 |
| 默认不碰真实微信 | 默认 `activeChannel: "mock"`、白名单为空、desktop 默认关闭 |
| 数据只在本机 | 无遥测、无自建服务端；外发只有你配置的 LLM、搜索、以及你手动填写的人格广场 URL（见 [PRIVACY.md](PRIVACY.md)） |
| 宁可失败也不发错人 | 定位不确定时返回 `{ok:false}`；发送结果分三态，`unknown` 绝不自动重试 |

## 2. 设计原则

1. **引擎与通道解耦**：引擎只依赖 `Channel` 接口，切换通道不改变人格、记忆与安全逻辑。
2. **纯逻辑可单测**：网关、预算、频控、OCR 文本处理等关键逻辑抽成无副作用纯函数（`src/core/**`），复杂 I/O 留在通道/宿主边界。
3. **失败安全优先**：任何不确定都走“拒绝/降级/暂停”，绝不“猜一个目标继续发”。
4. **结构化输出**：脚本与插件之间只传单行 JSON；通道发送结果带投递三态。
5. **可清理可回滚**：所有资源注册在 `ctx.effect`；状态文件可归一化/回退默认；不提交 `dist/`。

## 3. 系统上下文

```mermaid
flowchart LR
  U[用户 / 设置页浏览器] -->|HTTP 127.0.0.1| H[DSH 宿主 webServer]
  H --> API[src/server/api.ts<br/>鉴权 + 路由]
  API --> ENG[src/engine/engine.ts]
  ENG --> CH[src/channels/*<br/>mock / phone-adb / windows-vm / desktop]
  CH --> WX[微信 PC（真实通道时）]
  ENG --> LLM[DSH 宿主 ctx.llm<br/>→ 你配置的 LLM 服务商]
  ENG --> WEB[DSH 宿主 ctx.web.search<br/>→ 搜索服务商]
  ENG --> MEM[src/core/memory.ts]
  MEM --> DATA[(dataDir<br/>state / memory / audit / drafts)]
  CH --> PS[scripts/pwsh/*.ps1<br/>PowerShell 子进程]
  PS --> WX
  T[DSH 工具面板] --> TOOLS[src/tools.ts<br/>wechat_persona_*]
  TOOLS --> ENG
```

数据外发边界只有三处：LLM 服务商（对话内容）、搜索服务商（查询词）、人格广场 URL（手动配置时）。截图/OCR 图像不上传。

## 4. 运行时装配（`src/index.ts`）

插件入口不 import 宿主包类型，只用结构化接口（`Plugin`/`Context` 形状自声明），避免宿主版本耦合。

```mermaid
sequenceDiagram
  participant DSH as DSH 宿主
  participant P as src/index.ts
  participant E as engine
  participant A as api.ts
  participant T as tools.ts
  DSH->>P: apply(ctx, rawConfig)
  P->>P: migrateConfig(rawConfig) 幂等迁移
  P->>P: 解析 dataRoot（dataDir 或 默认工作区/.dsh-wechat-persona）
  P->>P: createFileStore(dataRoot) + StateManager + AuditLog
  P->>E: 创建并启动引擎（mock/真实通道由配置决定）
  P->>A: mountSettingsApi（宿主 webServer 可用后注册路由）
  P->>T: registerPersonaTools（宿主 tools 服务可用时注册 6 个工具）
  P->>DSH: ctx.provide('wechatPersona', service)
  P->>DSH: ctx.effect(...) 注册清理函数
```

要点：
- 数据目录在 boot 时解析：`dataDir` 留空 → 宿主默认工作区下 `.dsh-wechat-persona/`；失败回退进程工作目录。
- 设置页 API 依赖宿主的 `webServer`/`library`/`stickersCatalog`/`memoryStore`；boot 结束时试挂一次，并在 `ctx.inject(['webServer'])` 后补挂一次。挂载失败写 `%TEMP%\dsh-wechat-persona-debug.log`（只含启动诊断，不含聊天正文）。
- 引擎、审计、Api 路由都用 `ctx.effect` 注册 dispose，插件停用/重载时清理定时器与监听。
- 配置保存走宿主 `configEditor.edit` 写入 profile 的 `cordis.patch.yml`；宿主无 configEditor 时设置页只读。

## 5. 模块地图

```
src/
├─ index.ts            插件入口/装配/设置页 API 挂载/工具注册
├─ config.ts           schemastery 配置 schema + 默认值 + migrateConfig
├─ types.ts            全部对外/对内接口与领域类型（SendDelivery、Channel、EngineStatus…）
├─ tools.ts            6 个 wechat_persona_* 运维工具
├─ server/api.ts       设置页 HTTP API（鉴权、路由、参数校验、限流）
├─ engine/
│  ├─ engine.ts        引擎：门禁→预算→上下文→LLM→拟人化→发送→记账
│  └─ summarizer.ts    长期摘要（按轮数/预算触发）
├─ channels/
│  ├─ channel.ts       按 activeChannel 装配通道
│  ├─ mock.ts          空转通道：读写本地 JSON，不碰微信
│  ├─ phone-adb.ts     Android 通知监听 + adb 输入
│  ├─ windows-vm.ts    TCP 桥到独立 VM/会话里的 agent
│  ├─ risk.ts          风控文案识别（验证码/异常登录/限制登录…）
│  └─ pc/desktop.ts    本机桌面自动化（截图 + WinRT OCR + 坐标操作）
├─ core/
│  ├─ gate.ts          入站门禁（白名单/去重/时段/频控/禁用词…）
│  ├─ budget.ts        每日 token 预算三阶段（ok/draft/exhausted）
│  ├─ breaker.ts       风控熔断（trip/reset + 持久化）
│  ├─ rate-limit.ts    每联系人时/日/间隔限制 + 低活跃日
│  ├─ schedule.ts      在线时段/低活跃日/下次在线时间
│  ├─ humanize.ts      拟人化：拆条、输入中延迟、表情概率
│  ├─ emotion.ts       入站情绪分类（选表情包用）
│  ├─ memory.ts        每联系人记忆（最近消息/摘要/偏好）
│  ├─ preferences.ts   偏好抽取/合并/格式化
│  ├─ stickers.ts      表情目录扫描与选择（去连续重复）
│  ├─ persona.ts       旧版 persona.md/examples.md 加载
│  ├─ persona-library.ts 多套人格库（安装/导入/导出/映射角色卡）
│  ├─ persona-market.ts 人格广场（远程索引，可选）
│  ├─ search-intent.ts 是否需要联网搜索 + 生成查询词
│  ├─ stop.ts          聊天内 /stop 识别与暂停/恢复辅助
│  ├─ state.ts         运行状态持久化（逐字段归一、串行写）
│  ├─ audit.ts         审计 JSONL（滚动/汇总/清空）
│  ├─ notifier.ts      通知（alerts.jsonl + 宿主通知）
│  └─ ocr/             OCR 纯逻辑层（v3.0.0 新增，见 §7）
├─ llm/
│  ├─ client.ts        包装宿主 ctx.llm 流式接口（usage 统计）
│  ├─ prompt.ts        构造系统提示词与对话上下文
│  └─ search.ts        包装宿主 ctx.web.search
├─ util/               fs-store / host / logger / misc / time
└─ client/client.js    设置页前端（纯 JS，无需构建）
```

## 6. 通道层

```ts
interface Channel {
  readonly id: ChannelId
  start(handler: InboundHandler, onRisk: RiskHandler): Promise<void>
  stop(): Promise<void>                         // 幂等
  send(contactId: string, part: OutboundPart, signal?: AbortSignal): Promise<SendResult>
  status(): ChannelStatus
  readonly capabilities?: ChannelCapabilities   // stickers/images/voice
  scanRisk?(): Promise<RiskSignal[]>
}
```

| 通道 | 原理 | 默认 | 能力 | 关键限制 |
| --- | --- | --- | --- | --- |
| `mock` | 入站从本地文件/测试注入，出站写 `outbox.jsonl` | ✅ 默认 | 文本 | 不接触微信，适合验收全流程 |
| `phone-adb` | 监听 Android 微信通知 + adb 输入 | 关闭 | 文本（表情需坐标配置） | 需要 USB/无线调试、坐标校准 |
| `windows-vm` | 插件 ↔ VM 内 agent 的 TCP 桥 | 关闭 | 文本/表情（由 agent 决定） | 需要在独立 VM/会话部署 agent |
| `desktop` | 只截微信窗口 → WinRT OCR → 点击/键入 | 关闭（风险最高） | 文本 | 无表情；依赖 OCR 与窗口几何；真实环境未充分验证 |

通道状态机：`stopped → starting → running → degraded / error`；连续失败 6 次进入停摆（`MAX_CONSECUTIVE_FAILURES=6`），需重载插件恢复。风控信号（验证码/异常登录/限制登录）由通道上报或在桌面通道轮询截图时识别，交给引擎熔断。

**桌面通道（`src/channels/pc/desktop.ts`，v3.0.0 强类型化）**：
- 轮询列表（约 2s）→ 会话行预览 → 对候选先 `read` 校验完整性与防串聊 → OCR 二次校验/双引擎投票 → 去重后 `emit`。
- 发送：必须从最近一次列表拿到该联系人的**行坐标**；没有行坐标直接拒绝（不再用“最近活跃会话”兜底）。发送前检查用户键鼠空闲（`user-activity.ps1`），忙则让路；向脚本传 `-RowTop/-RowLeft/-RowHeight`，**不传 `-CurrentContact`**，避免脚本走“标题可信直开”分支造成跨联系人误发。
- 脚本契约：stdout 单行 JSON；`send` 成功 `{ok:true}`，不确定时 `{ok:false,error,delivery:'unknown'}`。脚本内部不再自动重试不确定的发送。

## 7. 引擎：一次入站消息的处理

```mermaid
flowchart TD
  I[通道 emit InboundMessage] --> Q{暂停/熔断?}
  Q -->|暂停| D[暂存 deferred-inbound.json ≤50 条<br/>写 skip 审计]
  Q -->|熔断| X[skip + 通知/保持熔断]
  Q -->|正常| G[evaluateInbound 门禁]
  G -->|skip| S[写 skip 审计，结束]
  G -->|halt| H[handleRisk：暂停+abort+停通道+通知]
  G -->|pass| B[预算阶段判定]
  B -->|exhausted| E1[硬停，不生成]
  B -->|draft| E2[生成后写 drafts.jsonl，不发送]
  B -->|ok| C[记忆/上下文/人格/摘要]
  C --> L[LLM 生成]
  L --> P[拟人化：拆条/延迟/表情]
  P --> SN[逐条发送：每次发送前重跑 canSend]
  SN --> AC[成功 sent 才记账/写记忆]
```

**入站门禁顺序**（`src/core/gate.ts` 的 `evaluateInbound`）：
disabled → breaker → paused（只 skip 不 halt）→ group-chat → self-message → not-whitelisted → empty-message → noise（纯标点）→ pure-sticker → duplicate（`contactId:msgId` 指纹，6h TTL）→ offline-hours → 低活跃日/频控 → forbidden-content（默认 halt 并暂停，可配置只记录）。通过后记录指纹。

**统一发送门禁** `engine.canSend()`：AbortSignal 已中止 → `paused`；`state.paused` → `paused`；`breaker.tripped` → `breaker`；安全运行模式且非 mock 通道 → `safe-mode`；预算 `exhausted` → `budget-hard-stop`；白名单不匹配 → `not-whitelisted`；频控 → 对应 reason。手动发送（`send_test`、`/test/send`）走同一门禁，暂停时返回 409；`engine.start()` 传 `checkSafeMode:false`（接收消息是安全的，safeMode 只拦发送）。

**发送循环**：每个 part 发送前、每次重试前都重新跑 `canSend()`；最多 2 次尝试；只有 `delivery === 'not-sent'` 才重试；`unknown` 一律不重试；任一部分失败即中止本批（避免半截刷屏）。成功写 `send` 审计，失败写 `send-fail`，`/status` 暴露 `delivery: {sent, notSent, unknown}`。

**暂停/恢复**：暂停会 abort 在飞请求并停通道；暂停期间入站消息暂存 `deferred-inbound.json`（最多 50 条），恢复后按序补处理（中途再次暂停则剩余保留）。恢复会清熔断、重建 `AbortController`、重启通道并 flush 积压。聊天内 `/stop` 可暂停（仅白名单）；`/resume` 相关函数已定义但**尚未接入引擎**，恢复请用工具或 `POST /resume`。

**预算**：`budgetPhase` 三态；`spent >= dailyTokens * draftModeRatio(0.85)` 进入草稿模式（只生成不发，写 `drafts.jsonl`）；`spent >= dailyTokens` 硬停。预算不阻止 `engine.start()`（否则重启后通道永远起不来）。

**风控熔断**：`handleRisk` 在 `safety.circuitBreakerEnabled=true`（默认）时 `tripBreaker` + 暂停 + abort + 停通道 + critical 通知 + 持久化；关闭时只记录和通知。

## 8. OCR 子系统

### 8.1 v3.0.0 分层

v0.2.8 把 OCR 文本处理都写在 `desktop.ts` 里（带 `@ts-nocheck`）。v3.0.0 抽出纯逻辑模块并强类型化：

| 文件 | 职责 |
| --- | --- |
| `src/core/ocr/types.ts` | OCR 领域类型：`OcrBox/FrameMeta/OcrLine/OcrResult`、`BubbleSide`、`BubbleOwnership/BubblePane`、`SendDelivery/SendResult`、`OcrEngine` 接口 |
| `src/core/ocr/geometry.ts` | 纯几何：`iou`、`intersectionBox`、`unionBox`、`groupLinesIntoRows`、`toLogicalBox/fromLogicalBox`（跨帧坐标必须换算） |
| `src/core/ocr/normalize.ts` | 文本归一：展示用 `normalizeOcrText`（去 CJK 字间空格等）、比较用 `compareKey`（去空白标点/全角转半角/小写）；相似度与 CER |
| `src/core/ocr/correction.ts` | 质量评估 `noiseScore/looksGarbled/pickBetterText` + 受控纠错（同长度、至多差一字、敏感区段跳过） |
| `src/core/ocr/vote.ts` | 双引擎投票 `mergeEngineVote`（重合度 <0.35 信任系统 OCR；更完整/噪声更低者胜） |
| `src/core/ocr/baseline.ts` | **Phase C 新增**：基线尾对齐、pending 队列、captureId/ack 水位线、稳定消息 id |
| `src/core/ocr/bubbles.ts` | **Phase C 新增**：按聊天面板几何做气泡归属（inbound/outbound/uncertain），不确定不投递 |
| `src/core/ocr/pipeline.ts` | **Phase C 新增**：把一次 read 输出变成“可投递消息”的决策（过滤/去重/兼容旧脚本输出） |

> 状态（Phase C 已实现，真实环境未验证）：`baseline/bubbles/pipeline` 有单测（`test/core/ocr-{baseline,bubbles,pipeline}.test.ts`），`desktop.ts` 与 `scripts/pwsh/wechat-uia.ps1` 已双向接线——read 时脚本输出 `captureId/pane/lines[].side/box/messages[]`，调用方下次读取回传 `-Ack <上次成功投递的 captureId>`，脚本只丢弃 ≤ 水位线的 pending 行并对未确认行重放（id 稳定，TS 侧按 id 去重）；`desktop.ts` 用 `planInboundDispatch` 拒绝 `uncertain/outbound` 并 `commitAck`。旧脚本输出（无这些字段）走 legacy 兼容分支全部接受。**真实微信窗口下的端到端效果仍需用户授权后验证**（见 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) 门槛 2）。

### 8.2 桌面通道读写路径

```mermaid
flowchart LR
  L[list 会话列表] --> R[read 当前聊天]
  R --> W[多倍放大 + WinRT OCR]
  W --> N[normalize 文本]
  N --> C[受控纠错 + 二次识别/第二引擎投票]
  C --> V{与列表预览交叉校验}
  V -->|通过| EM[emit 入站消息]
  V -->|不通过| PV[退回预览文本或丢弃]
```

- 引擎：Windows 自带 WinRT OCR（`scripts/pwsh/ocr-winrt.ps1`，zh-Hans-CN，只读图片、不启动微信）。截图先按 `WXUIA_UPSCALE`（默认 2 倍）最近邻放大再 OCR；单帧约 70–120ms（见 [OCR-BENCHMARK.md](OCR-BENCHMARK.md)）。
- 同帧约束：一次 read 只拍一帧（`-KeepImage` 保留该 PNG），WinRT 与第二引擎都识别**同一个文件**，不再另拍一帧（`wechat-uia.ps1` 的 `LastSnapshotImage` / `readImage`）；输出所有行共享同一 `captureId`。
- 气泡归属：脚本按聊天面板几何（上方 10% 标题/工具栏、下方 15% 输入框）提取候选行，`Get-BubblePane/Get-BubbleSide` 判 `left/right/unknown`；明确为右侧（自己）的行直接跳过，`unknown`（长气泡越线、两侧都不贴、越出面板）随 `box/pane` 输出，TS 侧 `planInboundDispatch` 拒投并计数。
- 基线不丢：脚本先保存（临时文件 + rename 原子写）再输出；新行进入 pending 队列，输出含本次新行与上次未确认行的重放；ack 水位线只丢弃 ≤ 已确认帧的行；消息 id = 文本哈希 + 持久化递增序号，跨帧重放保持不变，TS 侧 `inFlight` 按 id 去重。
- 纠错边界：只做“同长度、至多差一个高频词”的替换，且跳过 wxid/手机号/金额/日期/邮箱/URL/订单号/验证码/密码/身份证等敏感区段，变更明细写审计。
- 双引擎投票：RapidOCR（Python）是**可选**第二引擎——`desktop.ts` 在系统 OCR 结果可疑时给脚本传 `-SecondOcr`，脚本调用 `scripts/py/rapid_ocr.py` 识别同一帧截图再按重合度/完整度/噪声投票；Python 或依赖缺失时静默回退单引擎，不是必需依赖。
- 表情/图片/语音：桌面通道 `capabilities` 为 false，不发送表情（设置页会降级）。

### 8.3 脚本契约

- `scripts/pwsh/wechat-uia.ps1`：`-Action send|read|list|shot`，stdout 只输出一行 JSON；`send` 成功 `{ok:true}`；失败 `{ok:false,error}`；不确定投递时带 `delivery:'unknown'`。`read` 接受 `-Ack <captureId>`（确认水位线）与 `-SecondOcr`（同帧第二引擎），输出 `{ok,captureId,engines,pane,lines[],messages[]}`；`messages[]` 含 `id/text/captureId/seq/side/box/receivedAt`，本次新行与 pending 重放行混排、id 稳定。只截微信窗口区域、不读剪贴板内容（发送时临时借用剪贴板粘贴中文并恢复）、不联网。
- 调试：`WXUIA_DEBUG`/`WXUIA_SHOT_DIR` 等环境变量可控（见 [CHANNELS.md](CHANNELS.md)）；默认日志 `%TEMP%\wxuia-engine-debug.log` 含 OCR 行文本，敏感环境请自行清理。
- `scripts/pwsh/ocr-winrt.ps1`：`-Path <png> [-Language zh-Hans-CN]`，输出单行 JSON（含 lines/elapsedMs/width/height），失败 exit 1。
- `scripts/ocr/bench.mjs`：离线基准 CLI（只读 `test/fixtures/ocr-corpus` 合成图，不截图、不启动微信、不发送）。

## 9. LLM、搜索、人格、记忆与通知

- **LLM**（`src/llm/client.ts`）：包装宿主 `ctx.llm` 流式接口；默认跟随 DSH 当前默认模型，兜底 `deepseek-account / deepseek-flash`；统计 token 与缓存读 token，写入状态与审计。
- **提示词**（`src/llm/prompt.ts`）：系统提示词 = 人格（名字/风格/系统设定/口头禅/示例/禁忌） + 插件规则；上下文 = 最近对话（`memory.contextMessages`） + 长期摘要 + 联系人偏好记忆 + 当次搜索结果。
- **搜索**（`src/llm/search.ts`）：包装宿主 `ctx.web.search`；由 `search-intent.ts` 判断是否需要搜；失败降级（不阻塞回复）。
- **人格库**（`core/persona-library.ts`）：内置 4 套人格 + 导入/安装/导出；支持映射 SillyTavern 角色卡；非法 id 与路径做校验。
- **人格广场**（`core/persona-market.ts`）：仅在 `market.indexUrl` 非空时工作，默认只用内置人格。
- **记忆**（`core/memory.ts`）：每联系人一个 JSON（文件名为 `sha1(contactId)` 前 16 位），存最近消息、长期摘要、偏好、最近表情 id；所有读写串行。
- **表情**（`core/stickers.ts`）：扫描贴纸目录、防止连续重复；按通道能力降级。
- **通知**（`core/notifier.ts`）：写 `alerts.jsonl` 并调用宿主通知；含熔断/预算/自检等事件。

## 10. 数据与持久化

```
<dataDir>/
├─ state.json              运行状态（暂停/熔断/预算/频控/去重指纹/统计）
├─ memory/<hash>.json      每联系人记忆
├─ audit.jsonl             审计（滚动到 audit.1.jsonl）
├─ alerts.jsonl            通知记录
├─ drafts.jsonl            预算草稿
├─ deferred-inbound.json   暂停期间积压的入站消息（≤50）
├─ outbox.jsonl            mock 通道输出
├─ api-token               API 运维参考 token（0600，非强制）
├─ desktop-ack.json        桌面通道 ack 水位线（每联系人最近已确认的 captureId，跨进程重启读回）
├─ stickers/               上传的表情
└─ personas/               自定义人格包
```

- `FileStoreLike` 是注入的文件抽象（相对 dataDir），单测用内存 store；写入串行，失败只 warn 不阻塞主流程。
- `desktop-ack.json` 由桌面通道懒加载（首次 read 前）并在每次 `commitAck` 后串行落盘；写失败只记 debug，不阻塞读取。删除它只会让下一次 read 从 0 水位线开始（脚本按稳定 id 去重，不会重复投递已处理消息）。
- `state.json` 读取时**逐字段归一**：缺字段补默认、损坏回退默认并 warn、去重指纹有界（2000 条/6h TTL）。
- 配置不写在 dataDir，而是宿主 profile 的 `cordis.patch.yml`（见 §4）。

## 11. HTTP API 与鉴权

基址：`http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api`。

**鉴权链**（`src/server/api.ts` 的 `checkAuth`，顺序固定）：
1. 来源必须是回环地址（`127.0.0.1` / `::1`），否则 403；
2. 必须带 `x-dsh-wechat-persona: 1`，否则 403；
3. 浏览器请求的 `Host` 必须是回环主机名（防 DNS rebinding）；带 `Origin` 时必须是本机回环来源（防 CSRF）；`Sec-Fetch-Site: cross-site` 直接拒绝；
4. 若配置了 `apiToken`，还必须带 `Authorization: Bearer <token>`（或 `x-dsh-persona-token`），否则 401；
5. 进程内限速：每来源 240 次/分钟，超出 429。

**接口分组**：

| 分组 | 路由 |
| --- | --- |
| 健康/状态 | `GET /health`、`GET /status`（含 `safeMode` 与 `security.rateLimitPerMinute`） |
| 诊断 | `GET /diagnostics/ocr`（只读：通道最近一次 OCR 读取的 captureId/引擎/行数/uncertain 数/耗时/最后错误，不触发截图、不含聊天正文） |
| 配置 | `GET /config`（隐藏 `apiToken`，返回 `apiTokenConfigured`）、`POST /config`（`{config}`） |
| 人格 | `GET /personas`、`POST /personas/install|import|activate|export` |
| 人格广场 | `GET /market`、`POST /market/install` |
| 表情 | `GET /stickers`、`POST /stickers/upload`、`GET /sticker-file` |
| 日志 | `GET /logs` |
| 自测 | `POST /test/inbound`、`POST /test/send` |
| 运维 | `POST /pause`、`POST /resume`、`POST /memory/clear`、`POST /audit/clear` |
| 帮助 | `GET /help`（读 docs/使用说明.md 与 CHANGELOG.md） |

请求体上限 4MB（贴纸 2MB；导入人格 JSON 2MB；读 body 超时 10s）。所有出口都包在 `try/catch` 里，最差返回 500，不崩宿主。

## 12. 安全边界

1. **不发错人**：桌面发送只认会话列表行坐标 + 标题/内容交叉校验；没有定位信息直接拒绝；发送脚本不再信任“当前会话标题”捷径。
2. **不重复发**：投递三态；`unknown` 不重试；部分失败中止整批。
3. **不越权**：API 仅回环 + 请求头 +（可选）token + Host/Origin 校验；非授权请求不能触发发送。
4. **不读微信数据**：不读聊天数据库、不解密；桌面通道只读屏幕像素。
5. **不静默外发**：LLM/搜索/人格广场三条外发路径在 [PRIVACY.md](PRIVACY.md) 逐项列出；无遥测。
6. **风控优先**：验证码/异常登录/限制登录等信号触发熔断与暂停，需人工确认安全后恢复。
7. **安全运行模式**：`safeMode`（默认 `false`，保持升级兼容）开启后，所有非 mock 通道的发送在门禁层被拒（`safe-mode`），只允许 mock 空转；设置页「预算与安全」可切换，首次配置向导默认建议开启。

## 13. 测试与验证

| 层级 | 位置 | 说明 |
| --- | --- | --- |
| 单元/集成测试 | `test/**/*.test.ts`（vitest） | core 纯逻辑、通道、引擎验收、server API、client 冒烟；`test:sandbox` 用 `--pool=threads` 适配受限环境 |
| 安全/诊断专项 | `test/server/api.test.ts`、`test/engine/acceptance.test.ts` | 鉴权矩阵、限速、safeMode 拒发（真实通道 0 次 `channel.send`、审计 `safe-mode`、sendTest 返回 `not-sent`）、`GET /diagnostics/ocr` 只读白名单字段与降级 |
| 离线 API 验收 | `scripts/verify-api.mjs` | 假宿主 ctx + 真实 dist + 真 HTTP，不联网、不碰微信 |
| OCR 基准 | `scripts/ocr/bench.mjs` + `test/fixtures/ocr-corpus/` | 20 场景 ×2 变体合成语料，可复现实验，只读样本 |
| 环境自检 | `scripts/pwsh/selfcheck.ps1` | Windows/微信/DSH/OCR/构建/API/数据目录，JSON + 人话结论 |
| CI | `.github/workflows/ci.yml` | Windows：typecheck → test:sandbox → 敏感扫描 → build → OCR bench 冒烟；Linux：typecheck + 敏感扫描，OCR 冒烟显式 marked skip |

当前测试规模与结果见 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) 的记录（以真实运行输出为准）。

## 14. 已知限制与未完成

- **仅 Windows + PC 微信**；桌面通道依赖中文 OCR 语言包与窗口几何，窗口极小/遮挡时进入 degraded。
- **OCR 准确率**：v3 管线离线等价 A/B（tune/eval 不重叠，只报 eval 集 46 条消息）CER **21.38%**、整句 **47.83%**，同集 v0.2.8 为 37.37% / 28.26%，跨口径也满足发布门槛（CER ≤ 28.09% / 整句 ≥ 32.95%）；**限定合成语料 + 离线等价口径**，第二引擎融合与受控纠错在该语料几乎未触发，真实微信截图需用户授权后复测。详见 [OCR-BENCHMARK.md](OCR-BENCHMARK.md) §6.5。
- **Phase C**（同帧/基线/captureId/ack/气泡归属）：纯逻辑 + `desktop.ts` + `wechat-uia.ps1` 已双向接线并有单测（ack 水位线、pending 重放、稳定 id、uncertain 拒投）；**真实微信窗口下的端到端效果未验证**，见 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) 门槛 2。
- **Phase F**（安全运行模式、OCR 诊断、首次配置向导、mock 模拟器）：已实现——`safeMode` 配置（默认 `false`）在门禁层拦截真实通道发送；`GET /diagnostics/ocr` 只读透出通道 OCR 状态（不截图、不含正文）；设置页含首次配置向导（写入 `onboardingDone`）与 mock 测试入口；均有单测，**真实环境未验证**。
- **真实微信环境**：桌面通道发送可靠性等需用户单独授权后才能实机验证；未验证项在 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) 标注。
- 本仓库 `private: true`，不对外发布、不承诺 API 稳定性。

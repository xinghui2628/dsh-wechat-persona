# HANDOFF-0.3.0 — 交接文档（给新会话 / 未来的自己）

> 目的：让一个**零上下文的新会话**（AI 或人）读完这一份文档，就能在 `dsh-wechat-persona` 上安全地开发 **0.3.0 大版本**（重点是提示词改造）。本文档写于 2026-10-31 晚，基于 v0.2.8 的实际代码与运行状态。
>
> **新会话第一条消息建议直接发：**
>
> ```text
> 你是接手 dsh-wechat-persona 的开发代理。先完整读 docs/HANDOFF-0.3.0.md、AGENTS.md、docs/ARCHITECTURE.md，再读 src/llm/prompt.ts 和 src/config.ts。
> 任务是做 0.3.0 大版本（提示词架构改造为主）。先输出方案和改动清单给我确认，不要直接动手改代码；
> 所有测试按文档里的 test:sandbox 跑，改完发版前必须 typecheck + test + build + 插件重载 + /health 验证。
> ```
>
> 本项目规则、命令、坑都在本文档里，**不要凭 0.2.x 的记忆想当然**，以代码和本文档为准。

---

## 0. 一句话现状

- 项目：DSH（DeepSeek Harness）插件 `dsh-wechat-persona` —— 把**自己的微信小号**变成「有人格的 AI 聊天分身」，被动回复白名单好友。
- 当前版本：**v0.2.8**（2026-10-31 发布），已推送 GitHub 公开仓库：`https://github.com/<维护者账号>/dsh-wechat-persona`
- 代码状态：`master` 最新提交 `9db6c5b`，工作树 clean；**416 个单测全绿**（30 个测试文件）；CI 最近三次全绿。
- 生产配置已恢复（每日 5 万 token、白名单 3 人、08:00–21:00）；当前是晚上，引擎 `online=false`、`budgetPhase=exhausted`，**明早 08:00 自动上线**。
- 用户意图：**下一个大版本 0.3.0，提示词改动会很多**，希望新会话接手；用户是纯 GitHub 新手，解释要一步一步、给按钮级指引。
- 写本文档时插件 API 返回 404（DSH 当晚重启过一次，插件可能处于未挂载/开关关闭状态）。**新会话先确认**：DSH 插件页开关是否打开、`%TEMP%\dsh-wechat-persona-debug.log` 最后是否有 `attached /dsh-wechat-persona/api`，再用运行时 context 的端口访问 `/health`。

---

## 1. 仓库与交付物

| 项 | 值 |
|---|---|
| 本地路径 | `C:\Users\<用户名>\OneDrive\文档\deepseek-harness\default-workspace\dsh-wechat-persona` |
| 远程 | `https://github.com/<维护者账号>/dsh-wechat-persona.git`（origin，Public） |
| master HEAD | `9db6c5b feat: OCR 双引擎投票（RapidOCR）+ 常用词字典纠错，版本 0.2.8` |
| 历史 | 20 个提交，单线历史（曾用 orphan 重建以清除个人数据） |
| tag | `v0.2.8`（最新）、`v0.2.3` |
| GitHub Release | 只有 `v0.2.3`（Pre-release）；**v0.2.8 还没建 Release**（0.3.0 发版时一并处理或补一个） |
| 提交作者 | 统一为维护者账号 + GitHub noreply 邮箱（`<维护者账号> <noreply@users.noreply.github.com>`；不写真名/真实邮箱） |
| Collaborator | `<协作者账号>`（第二作者，邀请 pending，对方接受后生效） |
| CI | `.github/workflows/ci.yml`：windows-latest + Node 22 + `TZ: Asia/Shanghai`；`npm ci --ignore-scripts \|\| npm install --ignore-scripts` → typecheck → test:sandbox → build |

**重要**：`dist/` 不提交（gitignore），安装/运行前必须 `npm run build`；DSH 里跑的是构建后的 dist，改完 `src/` 必须重载插件。

---

## 2. 运行环境（本机）

| 项 | 值 |
|---|---|
| DSH | 桌面版 0.2.1-rc.3（GUI 端口每次重启可能变化，**以运行时 context 的 Web GUI URL 为准**，本次是 `http://127.0.0.1:<DSH端口>`） |
| 插件 API 基址 | `http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api`，**必带请求头 `x-dsh-wechat-persona: 1`** |
| 插件安装方式 | `C:\Users\<用户名>\.dsh\profiles\desktop\package.json` 里 `link:` 指向本仓库，`node_modules/dsh-wechat-persona` 是 Junction |
| Node | 本机 v26.13.0（CI 用 22；package.json `engines.node >= 22`） |
| 微信 | PC 微信 4.1.x，`<微信安装目录>\Weixin.exe`（默认安装在 `Program Files\Tencent\Weixin`），窗口标题「微信」，Qt 自绘窗口 |
| 屏幕 | 逻辑 2048×1152，125% 缩放；OCR 语言包 `zh-Hans-CN` |
| Python | `<本机 Python 路径>\python.exe`（3.14），已装 `rapidocr_onnxruntime 1.2.3`、`onnxruntime 1.31.1`、`opencv-python 5.0.0.93`、`numpy 2.5.4`（**这些不是仓库依赖**，见 §9 第 8 条） |
| 网络 | 系统代理 `127.0.0.1:<本地代理端口>`（Clash 类）；git push 需要 `git -c http.proxy=http://127.0.0.1:<本地代理端口> push ...` |
| 数据目录 dataDir | `C:\Users\<用户名>\.dsh\profiles\desktop\.dsh-wechat-persona\`（**不入库、不打包、不泄露**） |
| 日志 | 插件启动日志 `%TEMP%\dsh-wechat-persona-debug.log`；脚本调试日志 `%TEMP%\wxuia-engine-debug.log`；审计 `dataDir\audit.jsonl` |

dataDir 内容（了解结构即可，不要提交）：`state.json`、`audit.jsonl`、`drafts.jsonl`、`list-preview.json`、`uia-state.json`、`memory/`（每联系人 JSON，含摘要/最近消息/偏好）、`personas/`（导入的人格）、`stickers/`（上传表情包）。

---

## 3. 目录地图（src / client / scripts / docs）

```text
src/
  index.ts              插件入口：注册工具、接线、boot/attach；PLUGIN_VERSION 常量也在这里
  config.ts             配置 schema（schemastery）+ 类型 + defaultConfig + migrateConfig（迁移逻辑）
  types.ts              公共类型：Channel/ChannelStatus/ChannelCapabilities/OutboundPart/
                        SkipReason/InboundMessage/PersonaPack……
  tools.ts              暴露给 DSH 的工具（wechat_persona_status 等）
  engine/
    engine.ts           引擎核心：handleInbound→process→processInner 闸门流水线、上下文组装、
                        LLM 调用（含 reasoningEffort 自动降级）、拟人化防抖、逐条发送、审计、
                        自回声保护、摘要触发
    summarizer.ts       长期摘要（system prompt + 摘要生成）
  core/                 纯逻辑模块（都有单测）：
    gate.ts             入站闸门：在线时段/白名单/群聊/禁词/风控/熔断等
    schedule.ts         在线时段（workday/weekend/lowActivity）
    rate-limit.ts       限频计数器
    budget.ts           每日 token 预算（ok/draft/exhausted 相位）
    breaker.ts          风控熔断
    stop.ts / state.ts  暂停与状态
    humanize.ts         planHumanReply：拆条/typing 时长/表情包概率
    memory.ts           记忆存储（recent/summary/profile/最近表情）
    emotion.ts          情绪识别
    persona*.ts         人格包加载/内置人格/人格市场
    preferences.ts      联系人偏好提取与格式化
    stickers.ts         表情包目录与分类
    search-intent.ts    按需联网搜索触发判断（engine 里还调 llm/search.ts）
  llm/
    prompt.ts           ★ 提示词组装（0.3.0 的主要改造面）
    client.ts           LLM 调用封装（reasoningEffort 透传）
    search.ts           联网搜索客户端
  channels/
    channel.ts          通道接口/工具
    mock.ts             空转通道（安装默认）
    pc/desktop.ts       ★ 桌面通道（截图+PowerShell 驱动），0.2.x 改动最多
    phone-adb.ts        安卓手机通道（adb 通知轮询 + ADBKeyboard）
    windows-vm.ts       独立 Windows 会话通道
    risk.ts             通道风控信号
  server/api.ts         插件 HTTP API（设置页/外部脚本用），含路由白名单
  util/                 fs-store / host / logger / misc / time

client/                 设置页前端（纯 JS，无构建）
  client.js / lib.js    设置页 UI 逻辑（DSH 插件页里加载）

scripts/pwsh/
  wechat-uia.ps1        ★ 桌面自动化脚本（截图→Windows OCR→点击/输入；UTF-8 BOM！）
  user-activity.ps1     读用户键鼠空闲（GetLastInputInfo）
  selfcheck.ps1         一键自检（JSON + 人话结论；退出码 0/1）

scripts/py/
  rapid_ocr.py          ★ 第二 OCR 引擎（RapidOCR/onnxruntime），双引擎投票用

scripts/dev/            开发辅助（可提交）：wx_probe.py、stress-script.py、
                        test-send-fallback.py、plugin_api.py（注意 DEFAULT_BASE 还是旧端口 53905）

personas/builtin/       内置人格 4 个：大肥鱼/极客/长辈/小号（JSON，schema v2）
personas/builtin/builtin-dafeiyu.json   当前生产人格（大肥鱼）

docs/                   已有：ARCHITECTURE / CHANNELS / TEST-PLAN / PROMPTS / ACCEPTANCE /
                        PLAN(历史) / RELEASE-GUIDE / QA-RELEASE-AUDIT / 使用说明 / 本文件
```

---

## 4. 核心数据流（必读）

```text
微信消息
  │  桌面通道每 2s tick（POLL_INTERVAL_MS=2000）
  ▼
desktop.ts readInboundOnce()
  ├─ 调 wechat-uia.ps1 -Action list（截图+OCR 左侧会话列表，返回每行 name/found/unread/preview/selected/top/left/height）
  ├─ 自己发的预览过滤（lastSentText 每联系人最近 5 条 + 模糊匹配 isOwnText）
  ├─ 有预览的未读：先用 read 校验全文（previewRows，最多 2 行/轮）
  ├─ 无预览的未读：走 read
  ├─ 当前打开会话（selected 行）：每 8s 用 `read -NoSearch -CurrentContact` 低频轮询（修复「已打开聊天漏回」）
  ├─ 读出文本先过 OCR 质量启发式（looksGarbled）→ 可疑则 4x/2x 重读投票 → 仍可疑则 -SecondOcr（RapidOCR）
  └─ 文本过 correctOcrText 字典纠错 → emitMessage/emitPreview
  ▼
engine.handleInbound()（串行队列）
  └─ process()
      ├─ matchWhitelist（id/name/aliases 精确匹配）
      ├─ stop 指令检测（「闭嘴」等）
      ├─ 自回声保护（近 12 条 assistant 文本比对，命中 skip reason=self-echo）
      ├─ gate.evaluateInbound（在线时段/群聊/禁词/风控等）→ skip 时 audit
      ├─ persona.enabled / privateChat / groupChat 判定
      ├─ 预算硬停检查（budget-hard-stop）
      ├─ 限频（rate-limit）
      ├─ 按需联网搜索（可选）
      ├─ 组装上下文：memory.summary + 联系人偏好 + 最近 N 条 + （搜索结果）+ 新消息
      ├─ buildSystemPrompt(persona, config) + buildMessages(ctx)  ← ★0.3.0 主战场
      ├─ LLM 调用：默认 reasoningEffort=low；若 provider 报 "does not support reasoning effort" 自动去掉参数重试一次
      ├─ sanitizeReply + clampText(maxChars)
      ├─ budget 记录 token；预算相位 draft/exhausted 决定只生成不发
      ├─ planHumanReply（拆条 ≤maxSplitParts=2、typing 延迟、表情概率；通道 capabilities.stickers=false 强制表情概率 0）
      └─ 逐条 channel.send(contactId, {kind:'text',text})；每条最多重试 1 次（共 2 次），失败 audit send-fail 后 break
```

### 4.1 桌面通道关键常量与安全规则（`src/channels/pc/desktop.ts`）

- `POLL_INTERVAL_MS = 2000`、`SCRIPT_TIMEOUT_MS = 90000`、`MAX_CONSECUTIVE_FAILURES = 6`
- `MAX_SENT_HISTORY = 5`；`SENT_STATE_PATH = %TEMP%\dsh-wechat-persona-sent.json`
- 发送前必须能**定位聊天**：有 `row`（list 返回的行坐标）或 `lastActiveContact`（180s 内）才允许发；否则返回 `ok:false`（缺定位拒发）。
- 用户活跃闸门：`userActivityIdleMs`（生产 1500ms）；非「回复期」且用户正在用电脑 → 暂停 `pauseSeconds`。
- 发送脚本失败**绝不重发**（防止重复刷屏）。

### 4.2 脚本层（`scripts/pwsh/wechat-uia.ps1`）要点

- 入口：`param(Action: send|read|list|shot, WindowTitle, Contact, Contacts, CurrentContact, TextBase64, MaxMessages, RowTop, RowLeft, RowHeight, PaneLeftRatio, NoSearch, Upscale, SecondOcr, OutPath)`
- 环境变量：`WXUIA_DEBUG`、`WXUIA_SHOT_DIR`（绝对路径！相对路径子进程不落盘）、`WXUIA_FORCE`、`WXUIA_NOBASELINE`、`WXUIA_ACTIVE_HOURS`、`WXUIA_IDLE_MS`、`WXUIA_PANE_LEFT_RATIO`（默认 **0.30**）、`WXUIA_SEND_WAIT_MS`、`WXUIA_CAPTURE`（auto/printwindow/screen，默认 auto=PrintWindow 优先，不抢前台）、`WXUIA_STATE_PATH`、`WXUIA_UPSCALE`（1–4，list/read 内部会至少 3/4）
- 输出：单行 JSON；失败也是 `{"ok":false,"error":"<中文原因>"}` 且 exit 0。
- 发送的可靠性设计（0.2.x 血泪）：
  - 快发送：title 区域 OCR 校验目标聊天（trustedOpen 快捷路径 / 行坐标点选 + 绿底校验）
  - 输入：**Set-Clipboard + Ctrl+V 粘贴**（一次性 SendInput 会丢字/重复标点！），粘贴后 OCR 回读覆盖率 <0.8 才清空重打；回车后恢复原剪贴板
  - 发送判定：气泡出现 → ok；气泡没出现但**输入框已清空**（ink 像素判定 + 占位提示过滤）→ ok；否则 ok:false 且不回退保守路径（避免重复发送）
  - 读取：`-NoSearch` 只读当前打开的聊天，绝不 Ctrl+F；标题严格/宽松校验 + 左侧列表预览交叉验证，对不上拒读（防串聊）
- **改 .ps1 必须 UTF-8 BOM**；用 Python 读写并保留 BOM；改完用 `[System.Management.Automation.Language.Parser]::ParseFile` 验证 PARSE-OK；不要用 PowerShell 5.1 的 `Get-Content|-replace|Set-Content`（GBK 读坏中文）。
- 脚本 0.2.8 后大小约 112KB；改前先备份到 `.dsh-tmp/wechat-uia.ps1.<时间>.bak`。

---

## 5. 提示词系统（0.3.0 的重点）

### 5.1 现状：提示词分布

| 位置 | 内容 | 备注 |
|---|---|---|
| `src/llm/prompt.ts` `buildSystemPrompt()` | 身份句 + `persona.systemPrompt` + `# 输出规则（最高优先级）` + `# 像真人聊天（重要）` + `# 听懂人话（重要）` + `# 风格样例（只学语气和长度，不要照抄内容）` | **system 前缀，全联系人共享**，故意保持稳定以命中 provider 前缀缓存 |
| `src/llm/prompt.ts` `buildMessages()` | summary（user 消息框）→ 联系人偏好 → recent 对话 → 搜索结果 → 本次新消息 | 每次请求动态变，不污染 system 前缀 |
| `personas/builtin/*.json` | `systemPrompt`（462 字左右）、`style`、`catchphrases`、`examples`（10 条）、`taboo`、`stickers`、`tags` | 人格包 schema v2；`test/core/persona-library.test.ts` 断言内置人格 `systemPrompt` 长度 **200–500 字** |
| `src/engine/engine.ts` `sanitizeReply()` | 生成后清洗：trim / 去代码围栏 / 去引号 / 去「你：」前缀 / 去 markdown | 不添加内容 |
| `src/engine/summarizer.ts` | 长期摘要用的系统/用户提示词 | 摘要也花 token，预算单独限次 |
| `docs/PROMPTS.md` | 给用户看的提示词定制说明 | 0.3.0 需同步更新 |

### 5.2 已验证有效的提示词内容（不要轻易删）

- 「听懂人话」段（0.2.5/0.2.6 加入）：先判意图、口语/热词按日常含义理解、别装傻、只问没懂的词、疑似半句按能懂部分回、形近字按上下文纠正、OCR 残片按常见词补全、暗号/接话游戏直接配合、**第一遍就顺着最可能意思接话**、一次只发 1–2 条。
- 「像真人聊天」段（0.2.2 加入）：接情绪/重点、不复述、多条合起来理解、长度自然变化、口语优先、不承诺做不到的事、不重复最近句式、别连续追问、对不熟的人别自来熟。
- 输出规则（最早）：只输出微信内容、不加引号/markdown/列表/动作、口语短句 ≤maxChars、禁客服腔/说教/总结/列点、绝不暴露 AI、拒绝转账红包验证码、不编造实时信息、不用书面连接词。

### 5.3 0.3.0 提示词改造建议（供用户确认方案）

目标：**让提示词可维护、可版本化、可回归测试、可按人格/通道/场景组合**，而不是继续往一个函数里堆规则。推荐架构：

1. **拆分模块**：`src/llm/prompt/` 下拆 `identity.ts`、`rules-output.ts`、`rules-human-like.ts`、`rules-comprehension.ts`、`rules-safety.ts`、`examples.ts`、`context.ts`、`render.ts`；或改用 `prompts/*.md` 模板 + `{{变量}}` 插值（`{{personaName}}`、`{{maxChars}}`、`{{capabilities}}`、`{{maxParts}}`）。
2. **提示词版本号**：`PROMPT_VERSION = '3.0.0'`，写进 `audit` 的 `llm` 事件（`promptVersion` 字段），方便出问题回溯「哪版提示词」。
3. **人格 schema v3**：增加可组合的「语气参数」（`verbosity: 'short'|'normal'|'chatty'`、`humor: 0-3`、`emoji: 'never'|'rare'|'normal'`、`formality`），由 `renderSystemPrompt` 组合成段；保留旧 `systemPrompt` 作为覆盖/兜底，`migrateConfig` 做兼容迁移。
4. **通道能力感知**：把「发不了语音/图片/表情包」这类规则从静态文案改为按 `channel.capabilities` 生成（phone-adb 支持表情包时提示词就不该说「发不了表情」）。
5. **长度与拆条联动**：`maxChars`/`maxSplitParts`/`splitProbability` 已是配置；提示词里「一次只发 1–2 条」建议改成由配置渲染（如 `{{maxParts}}`）。
6. **提示词回归测试**：
   - 纯函数单测：section 是否存在、变量是否插值、长度是否超预算、是否含敏感词；
   - 快照测试：对同一输入生成稳定文本（避免逐字断言导致脆弱，建议按 section 断言 + 关键句包含）；
   - **200 次循环测试**沿用 0.2.x 风格（fake LLM / fake runner 循环 200 个变体），满足用户「反复测试」的要求；
   - 更新 `test/core/persona-library.test.ts` 的长度断言（如果改内置人格结构）。
7. **文档**：更新 `docs/PROMPTS.md`、`docs/ARCHITECTURE.md`（提示词章节）、`docs/ACCEPTANCE.md`（新增 0.3.0 证据小节）、`CHANGELOG.md`、`README.md`、`docs/使用说明.md`。
8. **不要破坏**：system 前缀稳定性（缓存）、`sanitizeReply`、自回声/防串聊/发送安全规则、`buildMessages` 的上下文顺序、`reasoningEffort` 降级逻辑。

### 5.4 0.3.0 建议范围（可再和用户确认）

必做（用户点名）：提示词架构重构 + 提示词质量提升 + 测试（含 200 次循环）+ 文档 + 发版。

可选加分（按性价比）：
- `audit` 增加提示词版本与长度统计（可观测性）；
- 设置页（`client/client.js`）增加「提示词风格档位」选择（走配置字段，不改代码）；
- 人格 JSON schema v3 与内置 4 人格升级；
- 30 条真实好友测试脚本化（需要用户在场，见 §12）。

**不建议**把 0.3.0 同时塞进高风险通道改动（如手机 UIA 新能力）；大版本先把提示词线做稳。

---

## 6. 配置系统（`src/config.ts`）

- schemastery schema `Config`，`defaultConfig()` 生成默认值；`migrateConfig(input)` 做旧→新迁移（幂等），运行时有二次 clamp。
- 字段分组：`enabled`、`activeChannel`、`dataDir`、`ownerName`、`whitelist[]`、`whitelistOnly`、`persona{activeId,dir,builtinDir,enabled}`、`schedule{onlineStart/End, workday*, weekend*, lowActivityWeekday, pauseOutsideHours}`、`rateLimit{perContactPerHour, perContactPerDay, minReplyIntervalSec, lowActivityDailyLimit}`、`reply{maxChars,temperature,reasoningEffort,maxTokens,splitProbability,maxSplitParts,stickerProbability,stickerNoRepeatCount,typingMinMs,typingMaxMs,ignorePureSticker,groupChatEnabled,privateChatEnabled,maxContextTurns,personaDir(旧),personaName(旧)}`、`stickers{enabled,dir,maxPerReply}`、`memory{recentKeep,contextMessages,summaryEveryTurns,autoSummary,maxSummaryChars}`、`budget{dailyTokens,draftModeRatio,maxSummaryCallsPerDay}`、`search{enabled,maxPerDay,maxResults,extraKeywords}`、`safety{forbiddenKeywords,riskKeywords,pauseOnForbiddenInbound,blockTransfers,blockSuspiciousLinks,circuitBreakerEnabled}`、`market{indexUrl,builtinOnly,timeoutMs}`、`channels{mock,phoneAdb,windowsVm,desktop{enabled,windowTitle,userActivityIdleMs,pauseSeconds,driverEnabled}}`、`logging{auditEnabled,maxAuditMb,recentLimit,level}`。

### 6.1 当前生产配置（2026-10-31 晚恢复，明早 08:00 自动生效）

```text
enabled=true
activeChannel=desktop
whitelist=3 人（真实好友名，不写入仓库/文档）
whitelistOnly=true
persona.activeId=builtin-dafeiyu
schedule.onlineStart=08:00 / onlineEnd=21:00 / pauseOutsideHours=true
rateLimit={10, 60, 30, 5}
reply.reasoningEffort=low / maxChars（以 GET /config 为准）/ maxSplitParts=2 / stickerProbability=0
memory.contextMessages=10 / recentKeep=30 / summaryEveryTurns=50
budget.dailyTokens=50000
channels.desktop={enabled:true, windowTitle:微信, userActivityIdleMs:1500, pauseSeconds:10, driverEnabled:true}
logging={auditEnabled:true, level:debug}
```

### 6.2 0.3.0 若新增配置字段

- 必须改 `src/config.ts` 的接口 + schema（含 description，设置页表单直接用）；
- 在 `migrateConfig` 里补默认值/迁移说明（老用户配置不能坏）；
- 同步 `test/core/config-migration.test.ts`；
- 若涉及行为开关，README「配置说明」与 `docs/使用说明.md` 同步。

---

## 7. 测试体系

### 7.1 命令

```powershell
npm run typecheck       # tsc --noEmit
npm run test:sandbox    # 推荐：沙箱测试（30 文件 / 416 用例，约 1.5s + 启动开销）
npm run build           # tsc → dist/
npm run verify:api      # 需要插件在跑；校验 24 条 API 路由
npm run verify:all      # typecheck + test:sandbox + build + verify:api
powershell -ExecutionPolicy Bypass -File scripts/pwsh/selfcheck.ps1 -Port <DSH端口>   # 一键自检
```

### 7.2 当前基线（v0.2.8，2026-10-31 实测）

```text
Test Files  30 passed (30)
Tests       416 passed (416)
CI          windows-latest / Node 22 / TZ=Asia/Shanghai / 绿
```

关键测试文件（改提示词/桌面通道前先看）：
- `test/channels/desktop.test.ts`（27 用例）：list/read 协议、自回声、预览校验、OCR 二次识别投票、双引擎投票、当前会话轮询等
- `test/engine/acceptance.test.ts`：端到端验收（限频/预算/搜索/表情/自回声/提示词注入等）
- `test/core/persona-library.test.ts`：内置人格 schema 与 `systemPrompt` 长度 200–500
- `test/server/api.test.ts`（83 用例）：API 路由
- `test/core/humanize.test.ts`：拆条/typing/表情
- `test/core/config-migration.test.ts`：配置迁移

### 7.3 「200 次测试」惯例

用户要求「反复测试 N 次」时，用**单测循环**满足（不要真的骚扰好友 200 次）：fake LLM/fake runner/clock 循环 N 个变体，断言每次行为正确。0.2.x 已多次这么做过（OCR 变体 200、字典纠错 200、双引擎 200、拆条 200、自回声 100 等），0.3.0 提示词改造建议同样做 200 次变体循环 + 快照。

### 7.4 真实链路验证（不骚扰好友）

`POST /dsh-wechat-persona/api/test/inbound`（body `{"text":"...","contactId":"<白名单 id>"}`，header 必带）会走 `engine.handleInbound`；然后看 `dataDir/audit.jsonl` 里 `llm` / `send` / `skip` 事件与耗时。生产测试注意先把 `budget.dailyTokens` 临时调高、测试完恢复。

---

## 8. 发版流程（v0.3.0 照此执行）

1. 确认 `git status` clean，先 commit 进行中的改动。
2. bump 版本（三处 + 文档）：
   - `package.json` `version`
   - `src/index.ts` `const PLUGIN_VERSION = '0.x.y'`
   - `README.md`（「当前版本」两处 + 版本记录）
   - `docs/使用说明.md`（版本行 + 版本记录）
   - `CHANGELOG.md` 新增 `## [0.x.y] - YYYY-MM-DD` 小节
   - `docs/ACCEPTANCE.md` 追加证据小节
   > 历史做法：写 `.dsh-tmp/bump-0xx.py` 一次性脚本批量改（避免手工漏改）。
3. `npm run typecheck && npm run test:sandbox && npm run build`（全绿才继续）。
4. 提交：Conventional Commits 中文，例如 `feat: ...，版本 0.3.0`。
5. 推送（**必须走代理**）：
   ```powershell
   git add -A
   git commit -m "feat: ...，版本 0.3.0"
   git -c http.proxy=http://127.0.0.1:<本地代理端口> push origin master
   git tag -a v0.3.0 -m "v0.3.0 - 一句话摘要"
   git -c http.proxy=http://127.0.0.1:<本地代理端口> push origin v0.3.0
   ```
   （PowerShell 会把 git 的 stderr 显示成 NativeCommandError 并 exit 1，**只要看到 `master -> master` 就是成功**。）
6. 重载插件，让新 dist + 新 API 生效：
   - **方式 A（推荐）**：DSH GUI → 插件 → 已安装插件 → 「微信小号人格分身」开关 **关 4 秒再开**；看 `%TEMP%\dsh-wechat-persona-debug.log` 出现 `apply → boot start → mount → attached /dsh-wechat-persona/api`。
   - **方式 B**：`POST /config`（完整 config，值改一下再改回，如 idle 1→2→1）触发 reconcile；**不保证重新 import 模块**，以 `/health` 的 version 为准。
7. 验证：
   ```text
   GET /health  → {"ok":true,"version":"0.3.0",...}
   GET /status  → paused=false、channelState=running、lastError=null
   ```
8. GitHub Release（网页）：Releases → Draft a new release → 选 tag v0.3.0 → 标题/说明 → **0.3.0 是正式版就不要勾 Pre-release**（可和用户确认）→ Publish。0.2.3 的 Release 说明可作为模板。
9. 发版后：`docs/ACCEPTANCE.md` 打勾、通知用户版本与升级方式（`npm run build` 后重载插件）。

---

## 9. 已知限制（写进 README/使用说明时保持诚实）

1. 仅 **Windows PC 微信 4.x**（实测 4.1.x）；3.x/手机/网页/ Mac 不支持（手机通道 phone-adb 是另一条路径，走通知，不是桌面视觉）。
2. 桌面通道 **不支持发送表情包/图片/语音**（`capabilities` 声明 false，引擎自动把表情概率降 0）。
3. OCR 对生僻字/形近字仍可能认错（现有多帧投票 + RapidOCR 第二引擎 + 字典纠错 + 提示词容错，但无法 100%）；建议给好友设 OCR 友好的备注名。
4. 已打开的聊天靠「selected 行 + 8s 低频 NoSearch 读取」补漏；若 Windows 焦点/窗口被抢，可能按安全设计拒发。
5. 群聊默认不回复；白名单外不回复；禁词/风控命中会暂停。
6. 读取依赖截图 OCR，窗口被完全遮挡/最小化时可能降级或拒读。
7. 单机单引擎串行回复（2s 轮询 + 每条 2–4s 发送），高频消息场景有排队延迟。
8. `scripts/py/rapid_ocr.py` 的 RapidOCR 依赖是**本机额外安装**的，不在 package.json；没装时 PS1 会静默回退 Windows OCR（日志「SecondOcr 不可用」）。

---

## 10. 坑与教训（重要，能省一整天）

### 10.1 PowerShell / 编码
- `.ps1` 必须 **UTF-8 BOM**；改文件用 Python 或 edit 工具，**禁止** PS5.1 `Get-Content|-replace|Set-Content`。
- 改完必须 `Parser::ParseFile` 验证 PARSE-OK。
- PowerShell 5.1 双引号里反引号是转义符：含反引号/`$` 的文本替换写成 Python 脚本再跑。
- 脚本里给 `WXUIA_SHOT_DIR` 用**绝对路径**，相对路径在子进程里不落盘。

### 10.2 插件运行 / API
- DSH 重启后 **GUI 端口会变**：API 基址 = `<运行时 context 的 Web GUI URL>/dsh-wechat-persona/api`。
- 插件 API 必须带 header `x-dsh-wechat-persona: 1`；`POST /config` body 必须是 `{"config": {...完整对象...}}`，否则 400。
- API 404 = 插件没挂载（GUI 开关可能被关了）；403/401 = 鉴权问题；先看 `%TEMP%\dsh-wechat-persona-debug.log` 有没有 `attached`。
- `scripts/dev/plugin_api.py` 的 `DEFAULT_BASE` 还是旧端口（53905），**用前改端口或用环境变量**。
- `POST /config` 只改配置，不一定重载模块；`/health` 的 version 才是「新代码是否生效」的证据。
- DSH 宿主可能会反复 apply/重载插件（0.2.x 期间见过），表现为 audit 里 `start/stop` 交替；排查时看 debug log 的 apply 时间。

### 10.3 微信 / 自动化
- 微信窗口被拖窄/最大化异常会导致列表消失/点击错位（脚本有 1200×830 钳制）。
- 一次性 `SendInput` 输入中文会丢字/重复标点（**已改剪贴板粘贴**，不要回退）。
- 空输入框有灰色占位「长按鼠标 语音输入」，OCR 会把它当一行；发送判定用 ink 像素（dark<20 视为已清空）。
- 微信列表选中行绿底白字 OCR 极差；靠绿底锚点 + 行距（约 82px）+ 名字条二次识别 + 标题/预览交叉验证。
- `PANE_LEFT_RATIO` 默认 0.30（聊天区大约从 0.30w 开始），不是 0.40。
- 自己的长消息左边缘能到 0.55w，判断自话用**中心点**（paneCenter）比右边缘更稳。

### 10.4 git / GitHub
- `git push` 直连常失败（`Connection was reset`），必须 `-c http.proxy=http://127.0.0.1:<本地代理端口>`；或看系统代理是否在跑。
- 历史上用 orphan 分支重建过 history（清个人数据）；提交作者已统一为维护者账号 + GitHub noreply 邮箱；**不要 push 旧 archive 分支**。
- 仓库 Public；`release` 只有 v0.2.3（pre-release）；tag 有 v0.2.3/v0.2.8；协作者邀请（`<协作者账号>`）是 pending invite。
- 隐私红线见 §11。

### 10.5 0.2.x 已修复的 bug 根因速查（防止回归）
| 症状 | 根因 | 修复位置 |
|---|---|---|
| 自言自语/自问自答 | 列表预览变化把自话标 unread + 自话 OCR 与 lastSent 匹配失败 + 引擎不识别自回声 | PS1 预览兜底排除 selected；desktop lastSent 5 条+模糊匹配；engine self-echo 保护（三层） |
| 打字少字/多标点 | `WXDriver.TypeText` 一次性 SendInput | PS1 快发送/保守发送改剪贴板粘贴 + 回读校验；`WXDriver.CtrlV()` |
| 读别人聊天（串聊） | 标题 OCR 宽松匹配「首字相同」兜底误判 | 去掉首字兜底；read 前标题严格/宽松 + 列表预览交叉验证，对不上拒读 |
| 已打开聊天不回 | 对方在已打开聊天里发消息没有未读红点 | desktop 每 8s `-NoSearch` 低频读当前会话 |
| 列表名字/预览错乱 | 3x 放大+绿底白字 OCR 差 | 4x 最近邻 + 绿底行锚点/行距 + 名字条二遍 + 红点区域避开头像 |
| 抢前台/搜索框乱跳 | 默认 screen 截图 + IsOccluded 时 ForceForeground | CaptureMode 默认 auto（PrintWindow 优先）；Enter-Chat 宽松匹配；list `found:false` 不触发 read |
| 思考等级选择「中」不回 | deepseek-flash 不支持 `reasoningEffort=medium` | engine 捕获错误后去掉参数重试（a00bb80） |
| OK1 被当新消息 | `isOwnPreview` 只记最后一条 + OCR 容错不足 | lastSent 历史 5 条 + 字符重合率 ≥0.6 模糊匹配 |
| CI 只有 UTC 失败 | 在线时段/预算/限频按本地时区 | CI `env: TZ: Asia/Shanghai` |
| OCR 认错字（幽/幽默度） | 预览截断 + 单引擎小字误读 | 预览先 read 校验全文；多帧投票；RapidOCR 双引擎；字典纠错；提示词容错 |

---

## 11. 安全与隐私红线（不可破）

1. **只改本仓库**：不碰用户其它文件/系统设置/代理/证书/微信数据目录；删除文件先改名 `*.bak-<时间>`。
2. **真实好友名、wxid、token、真实邮箱、本机路径（C:\Users\<用户名>）** 不写进任何仓库文件、日志、文档、示例、提交信息。
3. 发消息**宁可失败也不发错人**：无法定位聊天 → `ok:false`；任何不确定 → 拒发。
4. 不在测试里真的群发/骚扰好友；用 `/test/inbound` 注入或白名单本人。
5. 生产 dataDir 不提交、不打包；发版前跑隐私扫描：
   ```powershell
   # 把下面 <关键字> 换成你要检查的东西：测试好友真名片段、本机用户名、私人邮箱域名等
   # （不要把真实姓名/用户名写进仓库文件）
   git grep -nE '<测试好友真名片段>|<本机用户名>|<私人邮箱域名>|C:\\Users\\[^<]'
   git log --all -p | Select-String '<测试好友真名片段>|<本机用户名>'
   ```
6. 提交前 `git status --short` 确认没有 `audit.jsonl`、`state.json`、`.dsh-tmp/`、`dev-notes/`、`dist/` 混入。

---

## 12. 当前待办 & 未完成事项（0.3.0 前/后可做）

| 事项 | 状态 | 说明 |
|---|---|---|
| **0.3.0 提示词大版本** | 待做（本文档目的） | 见 §5.3 方案 |
| v0.2.8 GitHub Release | 未建 | tag 已推；可在 0.3.0 发布时顺带补，或单独建一个 `v0.2.8` Release |
| 30 条真实好友测试 | 未完成 | 需用户在场配合；合规要求：用白名单 3 人、手机微信发消息、看 audit；临时调高预算/限频 |
| 协作者 GitHub 邀请 | pending | 对方需在 GitHub 接受邀请 |
| 手机通道（phone-adb） | 代码有但近年未重点验证 | 0.3.0 若做「能力感知提示词」需确认其能力声明 |
| 表情包/图片/语音发送 | 桌面通道明确不支持 | 0.3.0 可只在提示词/文档层面说明，不做 UIA 实现 |
| 可选：RapidOCR 依赖安装脚本 | 未做 | 0.3.0 可加 `scripts/setup-ocr.ps1` 或写进首检提示 |
| 可选：设置页提示词档位 | 未做 | 需 client/client.js + 配置字段 |
| 每周低活跃日 | 配置项已有（周一） | 生产环境目前 offline 不影响 |

**注意**：明早 08:00 引擎会自动上线（生产配置：08:00–21:00、5 万 token/天）。如果 0.3.0 开发需要长时间跑真实微信测试，先跟用户确认临时调高预算/缩短时段，测完恢复；**不要让插件在用户不知情时给真实好友发消息**。

---

## 13. 常用命令 / API / 排查速查

```powershell
# 开发
npm run typecheck; npm run test:sandbox; npm run build
# 自检（需要 DSH 端口）
powershell -ExecutionPolicy Bypass -File scripts/pwsh/selfcheck.ps1 -Port <port>
# 直接跑插件 API
curl -s -H "x-dsh-wechat-persona: 1" http://127.0.0.1:<port>/dsh-wechat-persona/api/health
# 注入测试消息（不骚扰好友；会真的回复白名单好友，谨慎）
python -X utf8 - <<'PY'
import json,urllib.request
BASE='http://127.0.0.1:<port>/dsh-wechat-persona/api'
data=json.dumps({'text':'在吗，测试一下','contactId':'<白名单 id>'},ensure_ascii=False).encode('utf-8')
req=urllib.request.Request(BASE+'/test/inbound',data=data,method='POST',
  headers={'x-dsh-wechat-persona':'1','Content-Type':'application/json; charset=utf-8'})
print(urllib.request.urlopen(req,timeout=15).read().decode())
PY
# 看审计
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\.dsh-wechat-persona\audit.jsonl" -Tail 10
# 看脚本日志
Get-Content "$env:TEMP\wxuia-engine-debug.log" -Tail 40 -Encoding UTF8
```

API 路由（`src/server/api.ts`，前缀 `/dsh-wechat-persona/api`）：
`GET /health`、`GET /status`、`GET|POST /config`、`GET /personas`、`POST /personas/{install,import,activate,export}`、`GET /market`、`POST /market/install`、`GET /stickers`、`POST /stickers/upload`、`GET /logs`、`POST /test/inbound`、`POST /test/send`、`POST /pause`、`POST /resume`、`POST /memory/clear`、`POST /audit/clear`。

---

## 14. 文件行号索引（2026-10-31，代码会变，用前先确认）

| 位置 | 内容 |
|---|---|
| `src/llm/prompt.ts:28-78` | `buildSystemPrompt`（输出规则/像真人/听懂人话/风格样例） |
| `src/llm/prompt.ts:94-119` | `buildMessages`（summary→偏好→recent→搜索→新消息） |
| `src/config.ts:255-402` | 配置 schema（设置页字段 description 来源） |
| `src/config.ts:422-501` | `migrateConfig` |
| `src/engine/engine.ts:42` | `sanitizeReply` |
| `src/engine/engine.ts:63-92` | 自回声文本归一/匹配 |
| `src/engine/engine.ts:304-430` | handleInbound/process/processInner 前半（白名单/stop/自回声/闸门） |
| `src/engine/engine.ts:523-570` | 提示词/上下文/LLM 调用 + reasoningEffort 降级 |
| `src/engine/engine.ts:596-729` | 清洗/预算/拟人化/逐条发送 |
| `src/channels/pc/desktop.ts:23-28` | 轮询/超时/自话历史常量 |
| `src/channels/pc/desktop.ts:61-165` | OCR 噪声评分/字典纠错/双引擎合并 |
| `src/channels/pc/desktop.ts:441-577` | `readInboundOnce`（list→预览校验→NoSearch→OCR 复核） |
| `src/channels/pc/desktop.ts:608-678` | `send`（定位/闸门/脚本参数） |
| `scripts/pwsh/wechat-uia.ps1:38-58` | param 定义（Action/NoSearch/Upscale/SecondOcr/OutPath） |
| `scripts/pwsh/wechat-uia.ps1:1641/1753` | read 的放大倍数（≥3）与 -Upscale 覆盖 |
| `scripts/py/rapid_ocr.py` | 第二引擎入口（JSON 输出） |

---

## 15. 0.3.0 启动清单（新会话第一批动作）

1. 读：`AGENTS.md` → 本文档 → `docs/ARCHITECTURE.md` → `src/llm/prompt.ts` → `src/config.ts`。
2. 检查环境：`npm run typecheck && npm run test:sandbox`（基线 30 文件/416 用例）；`git status` clean；确认 DSH 端口与插件 `/health` 版本。
3. 和用户确认 0.3.0 范围（§5.4）与提示词改造方案（§5.3），产出**改动清单 + 迁移/测试计划**，等用户点头。
4. 实施顺序建议：提示词模块拆分 + 单元测试 → 人格 schema/配置字段与迁移 → 引擎接线（audit 加 promptVersion）→ 200 次循环测试 → 文档 → typecheck/test/build → 发版（bump 0.3.0 + CHANGELOG/README/使用说明/ACCEPTANCE）→ 重载 + `/health` 验证 → commit/tag/push → GitHub Release。
5. 用户是新手：每一步给「按钮级」操作说明；GitHub 操作涉及密码/2FA/PAT 的一律让用户自己做，不接受聊天里发凭据。
6. 若用户要「真机测 30 条」：先确认在场、临时调预算/限频、只对白名单 3 人、测完恢复生产配置（本文档 §6.1）。

---

## 16. 给用户的极简升级说明（发版后可直接发给他）

```text
升级方法：
1) 在项目目录运行：npm run typecheck && npm run test:sandbox && npm run build
2) 打开 DSH → 插件 → 已安装插件 → 「微信小号人格分身」开关：关 4 秒，再打开
3) 打开后确认版本：插件页显示的版本 = 0.3.0；或访问 /health 看 version
4) 新版提示词会自动生效，无需改配置；旧配置会自动迁移
```

---

**文档维护约定**：0.3.0 完成后，把本文档移到 `docs/HISTORY/` 或更新「现状」章节；新增的坑继续往 §10 里补。本文档不写真实姓名、账号、路径用户名、token。

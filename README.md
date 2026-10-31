# dsh-wechat-persona

把**你自己注册的微信小号**做成一个有人格、会发图、能联网查资料、省 token、低封号风险的 AI 聊天分身。

> 📖 **新手先看 [docs/使用说明.md](docs/使用说明.md)**：安装/更新/卸载、扫码登录、被踢重登、白名单、在线时段、防封建议、桌面通道前置、FAQ 都在里面；版本更新记录见 [CHANGELOG.md](CHANGELOG.md)。当前版本 **0.2.2**。
>
> 🛠 **环境自检**：`powershell -ExecutionPolicy Bypass -File scripts/pwsh/selfcheck.ps1 -Port <DSH端口>`（检查 Windows/微信窗口/OCR/构建产物/插件 API）。
> 📚 进阶文档：[架构](docs/ARCHITECTURE.md) · [测试计划](docs/TEST-PLAN.md) · [提示词模板](docs/PROMPTS.md) · [验收标准](docs/ACCEPTANCE.md) · [开发规则](AGENTS.md)。

> ⚠️ **重要声明（请先读完再装）**
> 1. 本插件通过自动化方式操作微信客户端/手机通知，**违反《微信软件许可及服务协议》**，账号可能被限制、封禁，**风险由使用者自行承担**。
> 2. **只建议用自己注册的小号**运行，不要用主号、不要用于任何商业导流、加好友、群发、刷单或诈骗。
> 3. 插件不做身份冒充的欺骗性用途；对外回复会尽可能体现“AI 助手/小号”的设定边界，**不得用于假装真人骗取信任、钱财或隐私**。
> 4. 插件只处理配置中的**白名单单聊**，不读取、不存储、不转发任何非白名单内容；支付、转账、验证码、登录凭据等敏感话题会被本地规则拦截并暂停。
> 5. 使用前请自行确认所在地区法律法规与平台规则允许的范围。

---

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 人格化回复 | `persona/persona.md` 定义性格/价值观/口癖/幽默/边界，`examples.md` 提供 few-shot 风格样例 |
| 拟人化节奏 | 随机“正在输入”0.8–5 秒、按概率拆成 2–3 条、按情绪插表情包（最近 8 次不重复、不刷屏） |
| 每联系人记忆 | 最近 30 条 + 长期摘要（每 50 条压缩），JSON 存本地工作区，可一键清空 |
| 0-token 本地判断 | 白名单、免打扰时段、限频、日上限、群聊过滤、纯表情/无意义消息过滤、去重、禁止话题，全部本地规则完成 |
| 严格省 token | 命中才调模型；上下文只带人格摘要 + 最近 10 条 + 新消息 + 必要时搜索结果；人格提示词稳定前缀利于缓存 |
| 每日 token 预算 | 默认 5 万；85% 切草稿模式（只生成不发），超限停止；每条消息 token 用量写审计日志 |
| 按需联网搜索 | 天气/新闻/新梗/地点/价格才搜，其余不搜；失败自动降级 |
| 作息与限频 | 在线时段默认 08:30–23:00；每人每小时 10 条、每日 60 条；每周 1 天低活跃 |
| 风控熔断 | 验证码/异常登录/限制提示 → 1 秒内暂停全部自动化并通知，不自动重试 |
| 一键停止 | DSH 工具 `wechat_persona_pause` / `wechat_persona_resume`，聊天内 `/stop` 指令；状态落盘，重启后仍暂停 |
| 可插拔通道 | `mock`（默认空转）/ `phone-adb`（推荐）/ `windows-vm` / `desktop`（默认关闭，必须让出键鼠） |
| 防干扰 | 后台优先通知/无障碍/区域截图；不做全屏截图、不抢前台、不碰剪贴板；desktop 模式检测用户键鼠活动自动让出 30 秒 |
| 异常隔离 | 通道/LLM/搜索/记忆/审计全部失败降级，单条消息异常不会影响 DSH 主进程；重试 ≤ 2 次 |
| 可视化设置界面（v0.2.0） | DSH 设置页出现「微信分身」独立分区，10 个标签页：概览/人格/白名单/在线时段/回复策略/表情包/预算与安全/日志与测试/人格广场/帮助 |
| 人格库与人格市场（v0.2.0） | 内置 4 个人格；人格包 v2 格式并兼容 SillyTavern 角色卡；远程索引一键安装，索引不可达时回退内置 |
| 联系人偏好记忆（v0.2.0） | 从消息里 0-token 规则提取称呼/忌口/共同话题等偏好，写入该联系人记忆并注入提示词背景，不额外调用模型 |
| 多来源表情包（v0.2.0） | 插件包内置 + 用户上传 + 人格包自带，同名文件按来源前缀区分；设置界面按情绪/来源管理 |

## 设置界面（v0.2.0 新增）

安装后有两个入口，界面相同：

- **设置页**：DSH 左栏设置 →「微信分身」；
- **插件页**：Plugins → `dsh-wechat-persona` 卡片 → 配置页。

界面由纯 JS 客户端插件 `client/client.js` 提供（宿主 `window.__ModuleLoader__` 加载，改界面不需要重编 DSH），10 个标签页：

| 标签页 | 你能做什么 |
| --- | --- |
| 概览 | 看引擎/通道状态与今日统计，暂停/恢复，一键发测试消息 |
| 人格 | 查看/切换内置与外装人格，导入（JSON/角色卡/链接）、导出、安装、卸载 |
| 白名单 | 增删联系人（`id`/`name`/`aliases`/备注），控制是否只回白名单 |
| 在线时段 | 工作日/周末时段（可跨零点）、每周低活跃日、时段外是否暂停 |
| 回复策略 | 字数、温度、思考等级、拆条/表情概率、拟人节奏、上下文条数、单聊/群聊开关 |
| 表情包 | 按情绪查看/上传/删除，设置概率、单条上限、最近不重复数 |
| 预算与安全 | token 预算、草稿模式比例、摘要上限、敏感关键词、风控熔断 |
| 日志与测试 | 最近审计日志、写模拟入站、发测试消息、清空记忆/审计 |
| 人格广场 | 浏览远程人格索引并一键安装（不可达时回退内置） |
| 帮助 | 直接展示使用说明与更新记录 |

保存经宿主 `ctx.configEditor.edit(...)` 写回 profile 的 `cordis.patch.yml`，**重启 DSH 不丢失**；宿主未提供配置编辑能力时界面自动只读并提示。


## 目录结构

```
dsh-wechat-persona/
├── client/                 # v0.2.0 Web 设置界面（纯 JS，宿主模块加载器加载，改界面不用重编 DSH）
│   └── client.js           # 设置页「微信分身」：10 个标签页 + Host API 调用
├── src/
│   ├── index.ts            # Cordis 插件入口（apply + Config + provide('wechatPersona')）
│   ├── config.ts           # schemastery 配置 schema + 类型 + defaultConfig() + migrateConfig()
│   ├── types.ts            # 全部数据契约（通道/LLM/搜索/记忆/审计/状态…）
│   ├── tools.ts            # DSH 运维工具注册（status/pause/resume/send_test/clear_*）
│   ├── server/             # v0.2.0 Host HTTP API（设置界面后端）
│   │   └── api.ts          # /dsh-wechat-persona/api/*（配置/人格/市场/表情包/日志/测试）
│   ├── util/               # logger / fs-store / misc（id、时间、随机）
│   ├── core/               # 0-token 判断与基础设施
│   │   ├── schedule.ts     # 在线时段 / 低活跃日
│   │   ├── gate.ts         # 本地规则引擎（命中才调模型）
│   │   ├── rate-limit.ts   # 每人每小时/每天限频
│   │   ├── budget.ts       # token 预算 / 草稿模式 / 超限停止
│   │   ├── breaker.ts      # 风控检测与熔断
│   │   ├── stop.ts         # 一键停止 / 聊天内 /stop
│   │   ├── search-intent.ts# 搜索意图识别（5 类）
│   │   ├── emotion.ts      # 情绪识别（6 类）
│   │   ├── humanize.ts     # 拟人化：拆条 + 随机延迟 + 表情包不重复
│   │   ├── audit.ts        # 审计日志（0-token 跳过 / token 用量 / 搜索 / 发送）
│   │   ├── state.ts        # 运行状态持久化（暂停/熔断/预算/限频）
│   │   ├── memory.ts       # 每联系人记忆 JSON
│   │   ├── persona.ts      # 人格加载（缺失自带兜底）
│   │   ├── persona-library.ts  # v0.2.0 人格库（安装/切换/导入/导出/卸载，v2 包）
│   │   ├── persona-market.ts   # v0.2.0 人格市场（索引拉取/安装/回退内置）
│   │   ├── stickers.ts     # 表情包目录加载与随机不重复选择
│   │   └── notifier.ts     # 通知（alerts.jsonl + stderr + Windows toast）
│   ├── llm/                # HostLlm(ctx.llm) / HostSearch(ctx.web) / 提示词组装
│   ├── engine/             # 回复引擎（编排）+ 长期摘要
│   └── channels/           # mock / phone-adb / windows-vm / desktop + 风控扫描
├── persona/                # 人格样例（persona.md / examples.md）
├── personas/               # v0.2.0 人格库
│   ├── builtin/            # 内置 4 个 v2 人格包（builtin-small / builtin-dafeiyu / builtin-senior / builtin-geek）
│   └── packages/           # 安装/导入的人格包（运行时生成）
├── stickers/               # 表情包样例（<emotion>/*.png|gif|webp）
├── scripts/                # gen-stickers.mjs、vm-agent.mjs、verify-api.mjs、pwsh/wechat-uia.ps1（桌面通道脚本）与 selfcheck.ps1
├── test/                   # 单元 + 集成验收测试（vitest）
├── docs/                   # 文档
│   ├── 使用说明.md          # 面向使用者的完整中文手册（安装→防封）
│   ├── ARCHITECTURE.md      # 架构与脚本契约
│   ├── TEST-PLAN.md         # 分层测试与 12 个必查场景
│   ├── PROMPTS.md           # 给 AI/贡献者的提示词模板
│   ├── CHANNELS.md          # 四通道配置与风险
│   ├── ACCEPTANCE.md        # 验收对账（含 0.2.2 证据）
│   └── PLAN.md              # 历史实现计划（部分项未实现，最新进展见 CHANGELOG）
├── CHANGELOG.md            # 更新记录（Keep a Changelog 中文）
├── LICENSE                 # MIT
├── cordis.patch.yml        # bundle 注册补丁
├── locale/                 # zh/en 展示元数据
└── icon.svg
```

## 快速开始（构建 → 安装 → mock 空转 → 选通道）

### 1. 构建

```powershell
cd dsh-wechat-persona
npm install --ignore-scripts --no-audit --no-fund
npm run build            # tsc -> dist/（v0.2.0 起还需 client/client.js 随包发布，构建不处理它）
npm run test:sandbox     # 受限沙箱环境用这个命令；普通环境也可以直接用 npm test
```

> 为什么用 `--ignore-scripts`：本仓库无需要执行的安装脚本；在受限沙箱里带脚本安装可能因 spawn 受限而失败。
> 测试命令区别：`npm run test:sandbox` 会加载 `test/core/sandbox-preload.mjs` 兼容层，**在受限沙箱里可正常运行**；直接 `npm test` 在受限沙箱中会因 esbuild/vitest 的进程限制（EPERM）失败，这属于预期，不是代码问题。

当前版本 **0.2.2**（2026-10-31：提示词新增「像真人聊天」规则，回复更自然；0.2.1：设置界面、人格库/人格市场、桌面脚本视觉驱动重写与稳定性修复），从 0.1.0 升级请先看 [CHANGELOG.md](CHANGELOG.md) 与[配置迁移](#配置迁移)一节。

### 2. 安装到 DSH 桌面版 profile

**前置条件**：

- Node.js ≥ 22（含 npm）；
- DSH 桌面版 ≥ 0.2.1-rc.3；
- Windows 10/11 x64（desktop 通道仅支持 Windows）；
- 中文（简体）OCR 语言包（desktop 通道读取/发送需要，见[常见问题](#常见问题)）；
- 微信 PC 版 4.x（desktop 通道）。

> 本仓库不提交 `dist/` 构建产物：从源码安装时先在本目录执行 `npm install --ignore-scripts --no-audit --no-fund && npm run build`；用发布包安装时同样需要能解析依赖。

DSH 因安全策略**不会**自动加载工作区里的任意代码，需要显式安装到 profile。任选其一：

**方式 A：链接安装（开发调试推荐）**

1. 先确保 `dsh-wechat-persona/` 下已 `npm install`（`node_modules` 必须存在，否则 linked 包解析不到 `@deepseek-ai/schemastery`，插件会静默加载失败）。
2. 编辑 `C:\Users\<你>\.dsh\profiles\desktop\package.json`：
   - `dependencies` 增加 `"dsh-wechat-persona": "link:C:/Users/<你>/.../dsh-wechat-persona"`；
   - `dsh.profile.bundles` 数组增加 `"dsh-wechat-persona"`。
3. 重启 DSH 桌面版（或等宿主重载）。确认「插件配置」里出现 **微信小号人格分身**。

**方式 B：plugin_manager 安装（发布/正式环境）**

```text
plugin_manager action=install_bundle target=C:/Users/<你>/.../dsh-wechat-persona
```

安装后重启 DSH，在「插件配置」中启用。

### 3. 先用 mock 通道空转验证

配置 `activeChannel: "mock"`（默认）。此时插件**不会触碰真实微信**：
- 只从 `<dataDir>/inbound.jsonl`（或配置的 `channels.mock.inboundFile`）读取测试消息；
- 回复写入 `<dataDir>/outbox.jsonl`；
- 所有判断/预算/审计照常运行 —— 适合验收与调试。

`<dataDir>` 默认为 **DSH 数据目录下的 `.dsh-wechat-persona/`**。本机实测落点为
`C:\Users\<你>\.dsh\profiles\desktop\.dsh-wechat-persona\`（插件是后台服务、没有会话上下文，
拿不到“当前会话工作区”；`workingDirectory.defaultDirectory` 只是部署回退目录）。
想固定存到某个目录（例如工作区），在插件配置里把 `dataDir` 填成**绝对路径**，如
`C:/Users/<你>/Documents/wechat-persona-data`。该目录包含：

```
.dsh-wechat-persona/
├── state.json      # 暂停/熔断/预算/限频/统计（重启恢复）
├── memory/         # 每联系人记忆 JSON
├── audit.jsonl     # 审计日志（可清空）
├── alerts.jsonl    # 风控/敏感话题通知记录
├── drafts.jsonl    # 草稿模式生成但未发送的内容
└── outbox.jsonl    # mock 通道回复记录
```

### 4. 切换到手机通道（phone-adb，推荐）

1. 安卓手机/云手机开启 **开发者选项 → USB 调试**，`adb devices` 能看到设备；
2. 安装 **ADBKeyboard** 并设为当前输入法（用于中文输入），或先只用 `tap-keys` 模式；
3. 手机装微信、登录**小号**；保持屏幕常亮/允许通知；
4. 配置：

```yaml
activeChannel: phone-adb
whitelist:
  - id: "对方微信备注名"      # 精确匹配通知标题
    name: "对方昵称"
channels:
  phoneAdb:
    adbPath: "adb"            # 或 adb.exe 绝对路径
    serial: "设备号"           # 多设备必填
```

5. 点击「测试通道」：用 `wechat_persona_send_test` 工具先发一条测试文本；确认对方能收到、回复能被读到后，再打开自动回复。

> 详细配置、坐标获取、风险说明见 [docs/CHANNELS.md](docs/CHANNELS.md)。

### 5. 打开设置界面（v0.2.0，推荐）

安装并重启 DSH 后：

1. 打开 DSH **设置**（左栏齿轮）→ 找到 **「微信分身」** 分区；也可以从 **Plugins** 页 → `dsh-wechat-persona` 卡片进入配置页；
2. 先在「概览」确认状态，在「日志与测试」发一条**模拟入站**验证整条链路（不碰真实微信）；
3. 按需在「人格」「白名单」「在线时段」「回复策略」里配置——保存会自动写回 profile 配置，**重启不丢**；
4. 通道与桌面脚本相关的高级参数仍在[配置说明](#配置说明)里，设置界面没覆盖到的字段可写进 `cordis.patch.yml`。

> 完整图文步骤（含扫码、被踢重登、白名单 id 怎么填）见 [docs/使用说明.md](docs/使用说明.md)。

### 6. 更新与卸载

**更新**：

```powershell
cd dsh-wechat-persona
npm install --ignore-scripts --no-audit --no-fund
npm run build
# 重启 DSH 桌面版（宿主会重新加载 bundle）
```

更新后旧配置会被自动迁移（见[配置迁移](#配置迁移)），数据目录、记忆、审计日志都保留在 `<dataDir>`，不会丢。

**卸载**：

1. 在「设置 → 微信分身」或直接编辑 `C:\Users\<你>\.dsh\profiles\desktop\package.json`，从 `dsh.profile.bundles` 移除 `"dsh-wechat-persona"`、从 `dependencies` 移除该依赖；
2. 重启 DSH；确认插件配置与工具消失；
3. 可选：删除 `<dataDir>`（默认 `C:\Users\<你>\.dsh\profiles\desktop\.dsh-wechat-persona\`）清空记忆/日志；删除前先备份需要的审计记录。

## 数据目录与 dataDir（实机说明）

- **默认位置**：`<DSH 数据目录>/.dsh-wechat-persona/`。本机实测为
  `C:\Users\<你>\.dsh\profiles\desktop\.dsh-wechat-persona\`。
  插件是常驻后台服务，**拿不到“当前会话工作区”**，所以不要指望它把数据写到你打开的项目目录里（`workingDirectory.defaultDirectory` 只是部署回退目录）。
- **固定位置**：把配置项 `dataDir` 填成**绝对路径**（例如 `C:/Users/<你>/Documents/wechat-persona-data`），所有数据都会存到那里；相对路径不建议使用。
- **备份**：直接复制整个 `<dataDir>` 即可；`state.json`（暂停/预算/限频）、`memory/`、`audit.jsonl`、`alerts.jsonl`、`drafts.jsonl`、`outbox.jsonl`、桌面通道的 `uia-state.json` 都在里面。升级前建议备份。
- **权限**：目录属当前 Windows 用户；DSH 以该用户运行时无需额外配置。若把 `dataDir` 指到需要管理员权限的目录，插件会因写入失败降级并报警。
- **清理**：设置界面「日志与测试」可清空审计/记忆；彻底清理请先 `wechat_persona_pause` 再删目录。

## 配置说明

所有配置都在 DSH「插件配置 → 微信小号人格分身」中以表单呈现（字段说明即表单提示），也可以写进 profile 的 `cordis.patch.yml`。完整 schema 见 [`src/config.ts`](src/config.ts)，关键项：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `activeChannel` | `mock` | `mock` / `phone-adb` / `windows-vm` / `desktop` |
| `dataDir` | `""` | 留空 = DSH 数据目录 `.dsh-wechat-persona`；可填绝对路径固定位置 |
| `whitelist` | `[]` | 白名单联系人（`id` 精确匹配 + `aliases`）；**为空不回复任何人** |
| `schedule.onlineStart/End` | `08:30` / `23:00` | 在线时段（本地时区，可跨零点）；时段外 0 次生成 |
| `schedule.lowActivityWeekday` | `1`（周一） | 每周低活跃日：`0` 关闭，`1`=周一…`7`=周日 |
| `rateLimit.perContactPerHour` | `10` | 每人每小时回复上限 |
| `rateLimit.perContactPerDay` | `60` | 每人每天回复上限 |
| `rateLimit.minReplyIntervalSec` | `30` | 两次回复最小间隔（秒） |
| `reply.maxChars` | `60` | 单条回复最大字符数 |
| `reply.temperature` | `1.1` | 采样温度 |
| `reply.reasoningEffort` | `low` | 思考等级（省 token） |
| `reply.maxTokens` | `160` | 单次生成 token 上限 |
| `reply.splitProbability` | `0.35` | 拆成 2–3 条的概率 |
| `reply.stickerProbability` | `0.25` | 追加表情包的概率 |
| `reply.stickerNoRepeatCount` | `8` | 最近 N 次不重复同一表情包 |
| `reply.typingMinMs/MaxMs` | `800` / `5000` | “正在输入”随机范围 |
| `memory.recentKeep` | `30` | 每联系人保留最近消息数 |
| `memory.contextMessages` | `10` | 每次请求携带最近消息数 |
| `memory.summaryEveryTurns` | `50` | 每 50 条压缩一次长期摘要 |
| `budget.dailyTokens` | `50000` | 每日 token 预算 |
| `budget.draftModeRatio` | `0.85` | 达到预算比例切草稿模式 |
| `budget.maxSummaryCallsPerDay` | `4` | 每日摘要调用上限（摘要也花 token） |
| `search.enabled` | `true` | 按需联网搜索 |
| `search.maxPerDay` | `20` | 每日搜索次数上限 |
| `safety.forbiddenKeywords` | 转账/红包/验证码/密码… | 命中即暂停 + 通知（0 token） |
| `channels.desktop.enabled` | `false` | 桌面通道必须显式开启 |

## 人格定制

- `persona/persona.md`：性格、价值观、说话方式、口癖、幽默方式、边界话题与拒绝方式。建议 300–600 字，写“人”不写“客服”。
- `persona/examples.md`：8–12 条 few-shot 风格样例，格式：

```markdown
### 例1 被问在干嘛
用户：在干嘛
小号：刚洗完澡瘫着呢，你呢
```

- `stickers/<emotion>/`：按情绪分类的 `png`/`gif`/`webp`，情绪目录名固定为 `happy` `playful` `shy` `comfort` `curious` `neutral`。放你自己的表情包时**只用有授权/无版权风险**的图片。
- 自定义目录：`reply.personaDir` 指到你的绝对路径；`reply.personaName` 用于审计。

## 人格库与人格市场（v0.2.0）

除 `persona/` 里的样例文件外，v0.2.0 起使用**人格包（v2）**管理人格，默认内置 4 个：

| id | 名字 | 风格 |
| --- | --- | --- |
| `builtin-small` | 小号 | 默认，克制、生活化、不客服腔 |
| `builtin-dafeiyu` | 大肥鱼 | 抽象玩梗、欠揍但可爱 |
| `builtin-senior` | 老周 | 中年大叔、稳重、爱讲道理 |
| `builtin-geek` | 阿码 | 程序员梗、冷幽默 |

人格包字段（`pack.json` / `personas/builtin/*.json`，`version: 2`）：
`id` `name` `avatar` `style` `catchphrases` `systemPrompt` `examples[{user,reply}]` `taboo` `stickers` `author` `description` `tags` `packVersion`。

- **兼容 SillyTavern 角色卡**：导入时会自动映射 `char_name → name`、`description/personality → style`、`mes_example → examples` 等常见字段；
- **切换**：设置界面「人格」页选择并启用（`persona.activeId`），引擎下一次生成即生效，无需重启；
- **安装/导入/导出/卸载**：支持安装本地人格包目录、导入 JSON/角色卡文件、导出当前人格、卸载外装人格（内置不可卸载）；
- **人格市场**：「人格广场」页从 `market.indexUrl` 拉取远程索引并一键安装；索引不可达/超时（`market.timeoutMs`，默认 8000ms）时**回退为内置 4 个人格**，不影响使用；`market.builtinOnly: true` 可强制只用内置。

## 配置迁移

从 0.1.0 升级到 0.2.0 时，插件启动会调用 `migrateConfig()` 自动补齐/迁移旧配置（幂等，多次执行结果一致）：

| 旧配置 | 迁移后 |
| --- | --- |
| `schedule.onlineStart` / `schedule.onlineEnd` | 保留，同时补出工作日 `workdayStart/workdayEnd` 与周末 `weekendStart/weekendEnd`（空值才补，已有值不覆盖） |
| 无 `persona.activeId` | 补 `builtin-small`；补 `persona.enabled: true` |
| 无 `whitelistOnly` | 补 `true` |
| 无 `reply.groupChatEnabled/privateChatEnabled/maxContextTurns` | 分别补 `false` / `true` / `6` |
| 旧 `reply.personaDir` 非空 | 只提示「建议改用人格库」，**不自动删除**旧字段 |

迁移只改配置、不动数据；迁移结果与提示会写进审计日志。若设置界面保存不生效，见[故障排查](#故障排查)。

## 日常运维（DSH 工具）

| 工具 | 作用 |
| --- | --- |
| `wechat_persona_status` | 通道状态、暂停/熔断、预算与今日统计（排查“为什么没回复”先看它） |
| `wechat_persona_pause` | **一键停止**（暂停并落盘） |
| `wechat_persona_resume` | 恢复（清熔断并重启通道；风控后必须人工确认微信安全再恢复） |
| `wechat_persona_send_test` | 向白名单联系人发测试文本（不触发 LLM） |
| `wechat_persona_clear_memory` | 清空某联系人/全部记忆 |
| `wechat_persona_clear_audit` | 清空本地审计日志 |

聊天内也可发 `/stop`（仅白名单联系人有效）暂停全部自动化。

> v0.2.0 起，人格切换、白名单、在线时段、回复策略、表情包、预算、日志查看等日常操作也可以直接在**设置界面「微信分身」**完成（见[设置界面](#设置界面v020-新增)），不必再改配置文件；DSH 工具仍然是排查问题最快的入口。

## 已完成的真实验证（本机 DSH 桌面版 0.2.1-rc.3）

### v0.2.0 第二轮验证

| 项目 | 结果 |
| --- | --- |
| 单元 + 集成验收测试 | **30 个测试文件 / 399 个用例全部通过**（受限沙箱用 `npm run test:sandbox`；含 Host API 83、人格库 26、人格市场 22、引擎验收 26、客户端 25 等） |
| 类型检查 | `npm run typecheck` → 0 错误 |
| 构建 | `npm run build` → `dist/`（78 个文件）；`node -e "import('./dist/index.js')"` → 命名导出 `Config/apply/inject/name/provide` |
| 离线接口验收 | `npm run verify:api` → **24/24 通过**：用假宿主 ctx + 真实 `dist` 代码 + 真实 HTTP 端口，覆盖鉴权 403、`/health`、`/status`、`/config` 读写（走 `configEditor.edit`）、`/personas` 4 个人格 + 切换、`/market` 回退内置、`/stickers` 18 张、`/logs`、`/help`（说明书 13649 字）、`/test/inbound`、`/test/send`、`/pause`、`/resume`、404 统一错误体 |
| 安装 | `plugin_manager action=install_bundle target=<本目录>` → `applied`；重启后加载为 entry `include:dsh-wechat-persona` |
| 工具注入 | 6 个 `wechat_persona_*` 工具（status/pause/resume/send_test/clear_memory/clear_audit） |
| 设置界面 | 设置页「微信分身」+ Plugins 卡片两个入口，10 个标签页；保存经 `ctx.configEditor.edit()` 写回 profile 的 `cordis.patch.yml`（重启不丢）；Host API 端点由 `src/server/api.ts` 提供并有 83 个用例覆盖 |
| 人格库 / 人格市场 | 内置 4 个人格（small/dafeiyu/senior/geek）；v2 人格包安装/切换/导入/导出/卸载有 26 + 22 个用例覆盖；远程索引失败回退内置 |
| 桌面通道脚本 | PowerShell 5.1 语法解析 **0 错误**、UTF-8 BOM 正常；`INPUT` 结构体实测 40 字节（旧版 32 字节导致 `SendInput` 失败）；用自建**模拟微信窗口**跑通 5 个端到端用例（首次无基线读取 → 基线去重 → 仅回报新消息 → 发送后 OCR 校验 → 错误联系人明确失败） |
| 配置迁移 | `migrateConfig()` 补齐工作日/周末时段与 0.2.0 新增字段，幂等；旧 `personaDir` 仅提示不删除 |

### v0.1.0 阶段已完成（历史记录）

| 项目 | 结果 |
| --- | --- |
| 单元 + 集成验收测试 | 22 个测试文件 / 204 个用例全部通过（`npm test`；受限沙箱用 `npm run test:sandbox`） |
| 实机运行 | `wechat_persona_status` 返回「运行中；通道 mock/running；在线；预算 0」；`pause(reason=live-verify)` → 「已暂停」；`resume` → 「已恢复」 |
| 落盘 | `<dataDir>/state.json` 与 `audit.jsonl` 生成，audit 实测内容：`{"type":"start","detail":"channel=mock",...}`、`{"type":"stop","reason":"live-verify","detail":"manual-pause",...}`、`{"type":"resume",...}` |

> 说明：当前 profile 的默认模型为 `deepseek-flash`（provider `deepseek-account`），联网搜索走
> `deepseek-search-api`，插件直接复用这两项宿主能力；mock 通道默认空转，因此“装上即生效”但
> **不会碰真实微信**——要真正上线必须显式切换 `activeChannel` 并填 `whitelist`。
>
> 桌面通道（desktop）**没有在真实微信窗口上验证**：开发环境无可自动化操作的真实微信窗口，最终用模拟窗口验证脚本本身。首次启用前请按 [docs/CHANNELS.md](docs/CHANNELS.md) 的「真实环境验证清单」逐项确认。

## 验收对账

| 验收标准 | 证据 |
| --- | --- |
| 白名单外/免打扰时段 0 次 LLM 调用 | `audit.jsonl` 中对应 `skip` 事件（`reason=not-whitelisted/offline-hours/...`），`llmCalls` 不增加；`test/core/gate.test.ts`、`test/engine/acceptance.test.ts` |
| 命中消息 10 秒内生成并按配置发送 | 集成测试用假时钟断言 `发送时刻-入站时刻 ≤ 10_000ms`（随机延迟被限制在 0.8–5s） |
| 表情包随机且不连续重复 | `test/core/humanize.test.ts`、`test/core/stickers.test.ts`（最近 8 次不重复） |
| 能按规则触发一次搜索 | `test/core/search-intent.test.ts` + `test/engine/acceptance.test.ts`（天气/新闻等触发，闲聊不触发） |
| 每日 token 不超预算、超了转草稿 | `test/core/budget.test.ts` + 集成测试（`drafts.jsonl` 有内容、`outbox` 无新增） |
| 风控提示 1 秒内停止并通知 | `test/core/breaker.test.ts` + `test/engine/acceptance.test.ts`（熔断 → 通道 stop、`alerts.jsonl`、后续消息 0 token） |
| 断线恢复 / 异常隔离 / 一键停止 | `test/channels/*.test.ts`（重连、无设备降级）+ `test/core/stop.test.ts` + 引擎异常隔离测试 |
| **v0.2.0** 设置页可改人格/加白名单/设时段/装人格包 | Host API 用例（`test/server/*`，83 个）+ 客户端 10 标签页；接口统一 `{ok:true,...}` / `{ok:false,error}` |
| **v0.2.0** 人格库与人格市场 | `test/core/persona-library.test.ts`（26）、`test/core/persona-market.test.ts`（22）；远程索引不可达回退内置 |
| **v0.2.0** 配置持久化与迁移 | `ctx.configEditor.edit()` 写回 `cordis.patch.yml`；`migrateConfig()` 幂等补齐工作日/周末时段等新字段 |
| **v0.2.0** 桌面通道脚本可解析、契约正确、有集成测试 | PowerShell 5.1 parse 0 错误 + UTF-8 BOM；模拟窗口 5 用例通过（见 [CHANNELS.md](docs/CHANNELS.md)）；失败场景返回 `ok:false` 不假成功 |
| **v0.2.0** 文档齐全且同步 | `README.md`、`docs/使用说明.md`、`CHANGELOG.md`（0.2.0/0.1.0）、`docs/CHANNELS.md`（desktop 段）与本仓库同版 |
| **v0.2.0** 不改 DSH 本体/其他插件、不删用户数据 | 只新增 `client/`、`src/server/`、`personas/`、`docs/使用说明.md`、`CHANGELOG.md`；升级前备份位于 `backups/pre-iter2/` |

运行全部验证（受限沙箱环境用 `npm run test:sandbox`，它加载了 esbuild 兼容层）：

```powershell
npm run typecheck        # 0 错误
npm run test:sandbox     # 30 个测试文件 / 399 用例（沙箱可用）
npm run build            # 产出 dist/（78 个文件）
npm run verify:api       # 24 项离线接口验收（真实 HTTP 端口 + 真实 dist 代码）
# 普通非沙箱环境可直接：npm test

# 重启 DSH 桌面端之后（设置界面已加载时）：
node scripts/verify-live.mjs   # 探测运行中宿主的设置界面 API；404 会提示需要重启
```

> 在受限沙箱里直接 `npm test` 会因 esbuild/vitest 的进程限制（EPERM）失败，属于预期；请用 `npm run test:sandbox`。
>
> **本地插件代码更新后必须完全退出并重开 DSH 桌面端**：运行中的宿主进程按 Node ESM 模块缓存旧 `dist`，`plugin_manager` 的重载只是重新实例化 `apply()`，不会重新 import 新代码（官方文档原话：“rebuilding and restarting remain necessary after code changes”）。设置界面与新版行为都要等重启后才出现；`verify:api` 在没有重启的情况下也能独立验证接口逻辑。

更详细的验收步骤见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 三通道风险说明（摘要）

| 通道 | 与电脑解耦 | 抢键鼠/前台 | 主要风险 | 建议 |
| --- | --- | --- | --- | --- |
| `phone-adb`（推荐） | ✅ 手机/云手机独立 | ❌ 不抢 | 需 USB/无线调试；通知读取依赖系统；ADBKeyboard 输入法可能被微信检测到输入法切换；手机端操作仍属自动化 | 固定设备 + 固定网络；只做被动回复 |
| `windows-vm` | ✅ 独立会话/虚拟机 | ⚠️ 仅 VM 内 | 需自己维护 VM 内 agent；微信 PC 登录环境与真实设备不同；VM 若用代理/频繁换 IP 风险高 | 固定 VM、固定网络；不建议挂代理 |
| `desktop`（默认关闭） | ❌ 与本机共用 | ⚠️ 必须自动让出 | 直接操作用户桌面；误操作/抢焦点/剪贴板风险最高；会被用户活动打断 | 只在小号 + 用户不用的时段；开启前务必读懂让出逻辑 |

**共同要求（防封）**：固定设备与网络，**不要频繁切 IP、不要挂代理/VPN 换区**；不要主动加好友、群发、导流、发链接轰炸；表情包别连刷；出现验证码/异常登录/限制提示立即停手人工处理。详见 [docs/CHANNELS.md](docs/CHANNELS.md)。

## 安全与合规边界

- 仅白名单单聊；群聊、非白名单消息一律不读不存不回。
- 支付、转账、红包、验证码、密码、银行卡等敏感话题：本地关键词命中即暂停 + 通知主人，不调用模型。
- 回复不涉及冒充身份欺骗、不索要隐私、不引导转账。
- 本地审计日志（含 token 用量）可一键清空；记忆与状态都存在本地（默认 DSH 数据目录，可用 `dataDir` 指定）。
- 插件不注册账号、不自动加好友、不群发、不进群。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 插件列表里没有/配置项空白 | 确认 profile 里 bundle 安装成功、`npm install` 已执行、重启 DSH；检查 `node_modules/@deepseek-ai/schemastery` 是否存在 |
| 工具里没有 `wechat_persona_*` | tools 服务未就绪时插件会降级跳过（不影响回复引擎）；重启 DSH 后再看 |
| 消息不回 | 先调 `wechat_persona_status`：是否暂停/熔断/超预算/不在线/白名单 id 不匹配；再看 `audit.jsonl` 的 skip reason |
| 手机通道收不到消息 | 确认通知权限、`adb devices`、通知标题=白名单 id；`dumpsys notification` 能否读到 |
| 发送失败 | 检查输入法/坐标/无障碍；先 `wechat_persona_send_test` 验证通道 |
| 出现验证码/限制提示 | 全自动化已自动暂停；**人工处理微信**，确认安全后 `wechat_persona_resume` |
| 设置页看不到「微信分身」 | 确认 bundle 已安装且重启 DSH；Plugins 页 `dsh-wechat-persona` 卡片也可进入；检查 `dsh.client` 配置与 `client/client.js` 是否存在 |
| 设置保存不生效 / 界面只读 | 宿主未提供 `configEditor` 时界面只读；确认 DSH 版本 ≥ 0.2.1-rc.3，保存后重启 DSH 再看 `cordis.patch.yml` |
| 桌面通道读不到消息 | 确认微信 PC 已登录小号且窗口可见、装了中文 OCR 语言包、`channels.desktop.enabled` 与 `driverEnabled` 都为 true；设 `WXUIA_DEBUG=1` 看日志；用 `WXUIA_NOBASELINE=1` 测试；确认白名单 `id` 是微信里可搜索到的备注名/昵称 |
| 桌面通道发送失败 | 先看返回的 `error`（常见：未确认打开聊天、未在聊天区看到气泡、用户键鼠不空闲）；确认窗口没被最小化、分栏比例需校准（`WXUIA_PANE_LEFT_RATIO`）；OCR 缺字导致误判时调大 `WXUIA_SEND_WAIT_MS` |
| OCR 不可用 | 安装中文（简体）OCR 语言包：设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 光学字符识别；`Get-WindowsCapability -Online -Name "Language.OCR*"` 确认 `zh-Hans-CN` 为 `Installed` |

## 开发

```powershell
npm run typecheck     # tsc --noEmit（0 错误）
npm run test:sandbox  # 受限沙箱环境可用；30 个测试文件 / 399 用例
npm test              # 普通环境用；受限沙箱会因 esbuild EPERM 失败（预期）
npm run build         # tsc -> dist/
```

- 运行时零第三方依赖；`@deepseek-ai/schemastery` 由 DSH 宿主环境解析。
- 引擎与通道都是纯依赖注入实现，测试用假时钟/假随机/假 LLM/假通道证明验收标准。
- 客户端设置界面 `client/client.js` 是纯 JS（宿主 `window.__ModuleLoader__` 加载），改界面后重启 DSH 即可，不需要重编；Host API 在 `src/server/api.ts`。

## 路线图

- [x] MVP：单白名单联系人 + 文本/表情包 + 手机通道 + 本地判断 + 审计 + 紧急停止
- [x] 多联系人、记忆摘要、联网搜索、token 预算统计
- [x] windows-vm 通道（IPC 参考 agent）
- [x] 通道 Web 控制面板 → 已由 v0.2.0 设置界面「微信分身」实现（10 标签页 + Host API）
- [x] 人格库与人格市场（v0.2.0：4 个内置人格、v2 人格包、SillyTavern 角色卡导入、远程索引）
- [x] 桌面通道（desktop）视觉驱动脚本重写（截图 + OCR + 坐标操作；真实微信待实机校准）
- [ ] 表情包情绪识别模型（当前为规则 + 关键词）

## 版本与更新记录

- 当前版本：**0.2.2**（2026-10-31）
- 完整更新记录：[CHANGELOG.md](CHANGELOG.md)（含 0.2.0 新增/变更/修复与 0.1.0 MVP 基线）
- 面向使用者的完整手册：[docs/使用说明.md](docs/使用说明.md)
- 通道配置与风险：[docs/CHANNELS.md](docs/CHANNELS.md) · 验收对账：[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)

升级步骤见上文[更新与卸载](#6-更新与卸载)；配置差异见[配置迁移](#配置迁移)。

## License

[MIT](LICENSE) © 2026 dsh-wechat-persona contributors

本插件通过自动化方式操作微信客户端/手机通知，**违反《微信软件许可及服务协议》**，账号可能被限制、封禁，风险由使用者自行承担；详见文首「重要声明」。

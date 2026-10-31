# 更新记录（Changelog）

本项目的所有重要变更都记录在这里。

- 格式参考 [Keep a Changelog（中文）](https://keepachangelog.com/zh-CN/1.1.0/)。
- 版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
- 最新版本：**0.2.2**（2026-10-31）。安装/更新/卸载与排障见 [docs/使用说明.md](docs/使用说明.md)。

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

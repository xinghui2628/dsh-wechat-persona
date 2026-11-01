# 隐私说明（PRIVACY）

> 版本：3.0.0（开发中，未公开发布）｜上一已发布版本：0.2.8
> 本文只描述**本插件**的行为；插件运行在 DSH 宿主内，宿主自身的隐私行为以 DSH 的说明为准。
> 安全机制（鉴权、token、数据保护边界）见 [SECURITY.md](SECURITY.md)。

## 0. 一句话结论

本插件是**本机优先**的：聊天记录、记忆、审计、配置都只写本机磁盘，作者与插件自身**没有服务器、没有遥测**。
唯一会离开本机的数据是：**你配置的 LLM 服务商**收到的对话内容、**你启用联网搜索时**搜索服务商收到的查询词、以及**你手动填写人格广场 URL 时**该 URL 的请求。截图与 OCR 图像**不会**上传。

## 1. 设计原则

1. **最小化**：只处理白名单单聊里回复所需的消息；不读微信聊天数据库、不解密、不导出通讯录。
2. **可开关**：`mock` 通道默认空转，不接触真实微信；`desktop` 通道默认关闭；搜索、摘要、审计、表情都可以关。
3. **可删除**：记忆、审计各有清除入口；删掉数据目录即清空插件在本机保存的个人数据。
4. **无遥测**：不向作者或任何第三方发送使用统计、崩溃上报、设备指纹。
5. **发内容前先说清楚**：涉及外发的功能（LLM、搜索、人格广场）在本文逐项列出。

## 2. 本机保存了什么（在哪里、留多久）

数据目录 `<dataDir>` 默认是 **DSH 默认工作区下的 `.dsh-wechat-persona/`**（`src/index.ts` 中按 `workingDirectory.defaultDirectory || process.cwd()` 解析；可用 `dataDir` 配置改成绝对路径）。下面路径都相对于 `<dataDir>`：

| 数据 | 文件 / 目录 | 内容 | 保留策略 |
| --- | --- | --- | --- |
| 每联系人记忆 | `memory/<sha1(contactId) 前 16 位>.json` | 最近消息（`memory.recentKeep`，默认 30 条）、长期摘要（`memory.maxSummaryChars`，默认 400 字）、累计轮数、最近表情 id、偏好记忆（称呼、忌讳、最近话题） | 每联系人一个文件，持续更新；删除对应文件即清除该联系人 |
| 运行状态 | `state.json` | 是否暂停及原因、熔断状态、当日 token 消耗、频控计数、消息去重指纹（`contactId:msgId`，最多 2000 条、6 小时 TTL）、统计计数 | 持续更新；`clear_memory` 不清此项 |
| 审计日志 | `audit.jsonl`、滚动文件 `audit.1.jsonl` | 事件类型、联系人 id/昵称、消息 id、跳过原因、LLM/搜索/发送的**元数据**（token 数、耗时、字符数、投递三态） | 默认单文件上限 `logging.maxAuditMb=10`，超出时主文件搬为 `audit.1.jsonl` 再清空主文件 |
| 草稿（历史） | `drafts.jsonl` | 预算进入草稿模式后**生成但未发送**的回复正文（旧追加格式，保留兼容） | 持续追加，直到手动清理数据目录 |
| 草稿队列（v3） | `drafts.json` | `sendMode=draft/confirm`、`safeMode` 或预算草稿模式下生成的回复正文，含联系人 id、生成时间、过期时间（24h TTL）、状态（pending/approved/rejected/expired）、原因；上限 50 条 | 批准/拒绝后保留一段时间以便追溯；过期或超过 24h 的非待处理草稿会被清理；删除文件即放弃所有未批准草稿（**不会发送**） |
| 发送幂等账本 | `send-ledger.json` | `sendOperationId` + `partIndex` 对应的发送状态、尝试次数、投递三态、**文本哈希（不存正文）**；上限 200 条 | 终态记录保留到被上限挤出；删除会失去“防重放/防重复发送”的历史（不建议在发送中途删除） |
| 通知记录 | `alerts.jsonl` | 熔断/异常/预算等通知文本（可能含联系人昵称） | 持续追加 |
| mock 通道记录 | `outbox.jsonl` | mock 通道“发出”的假消息，便于离线调试 | 持续追加 |
| 暂停期间积压 | `deferred-inbound.json` | 暂停期间收到、恢复后待处理的入站消息（最多 50 条） | 处理完即清空 |
| 贴纸 | `stickers/` | 你上传的表情包图片（png/gif/webp，单张 ≤2MB） | 直到手动删除 |
| 自定义人格 | `personas/` | 导入/安装的人格包 JSON 及其自带贴纸 | 直到手动删除 |
| API token | `api-token` | 插件启动时自动生成、供运维参考的共享 token 原文（`config.apiToken` 留空时也会写，供本机参考；不强制使用） | 直到手动删除；建议限制文件权限 |
| 桌面通道 ack 水位线 | `desktop-ack.json` | 每个联系人最近一次成功投递的帧号（形如 `cap-12`），用于跨进程重启后不重放已处理帧；**含联系人名称**，不含聊天正文 | 每次成功读取后更新；删除只会让下一轮从 0 水位线重读（脚本按稳定 id 去重） |

**配置**保存在 DSH profile 的 `cordis.patch.yml`（由宿主管理），包括：白名单备注/别名、人格设置、在线时段、回复策略、预算与安全设置、`sendMode`、`market.indexUrl`、以及可选的 `apiToken`。`GET /config` 不会回显 `apiToken` 明文。API 设置页与配置不会写入微信账号密码。

**OCR 诊断不落盘**：`GET /diagnostics/ocr` 与 `desktop.status().ocr` 只返回最近一次读取的**元数据**（frame/captureId、引擎名、行数、uncertain/reject/conflict 计数、耗时、最后错误、DPI/scale、截图方式、引擎版本、是否二次识别、质量状态），**不含聊天正文、不含截图路径、不保存截图**，也不会触发新的截图。

**桌面通道脚本（`scripts/pwsh/wechat-uia.ps1`）自己的数据**不在 `<dataDir>` 里：

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| UI 基线状态 | `%USERPROFILE%\.dsh\profiles\desktop\.dsh-wechat-persona\uia-state.json`（可用环境变量 `WXUIA_STATE_PATH` 覆盖；插件当前不自动改这个路径） | 保存“已读过的历史文本行”与窗口基线，以及 Phase C 的 pending 队列（含待重放的聊天文本片段）、`captureId`/ack 水位线、气泡 `side/box`，用于去重、补读和「不丢消息」；属于敏感落盘，删除该文件会丢失去重基线（会重建） |
| 列表预览缓存 | 同目录 `list-preview.json` | 会话列表预览文本，便于下一轮读取 |
| OCR 临时截图 | `%TEMP%\wxuia-*.png` | 正常流程在 OCR 后**立即删除**（`Get-WindowSnapshot` 的 `finally` 分支） |
| 坐标校准截图 | 由 `WXUIA_SHOT_DIR` 指定（默认不设=不保存） | 仅人工排障/校准坐标时开启，会保留截图，**需自行清理** |
| 引擎调试日志 | `%TEMP%\wxuia-engine-debug.log`（默认；`WXUIA_DEBUG=<文件>` 可改） | 含 OCR 识别到的**聊天文本片段**（行坐标 + 文本），超过 2MB 自动清空重写；不随插件数据清理删除，需手动删 |
| 插件启动日志 | `%TEMP%\dsh-wechat-persona-debug.log` | 仅启动/挂载/API 注册等诊断信息，不含聊天正文 |

> `.dsh-tmp/`、`dev-notes/`、`backups/` 等目录是开发过程产物，不提交到仓库，也不在发布包内。

## 3. 什么数据会离开本机

| 目的地 | 何时 | 发什么 | 如何关闭 |
| --- | --- | --- | --- |
| 你配置的 LLM 服务商（经 DSH 宿主 `ctx.llm` 调用，默认走宿主当前默认模型） | 每次要生成回复时 | 人格系统提示词（人格名、性格、风格、口头禅、示例、禁忌与拒绝规则）、最近对话上下文（`memory.contextMessages`，默认 10 条）、长期聊天摘要、联系人称呼/偏好记忆、当次触发的搜索结果（如有）、以及待回复的消息文本 | 暂停/停止插件、把 `persona.activeId` 置空（本地拦截不调模型）、或用宿主配置换成本地模型服务 |
| 搜索服务商（经 DSH 宿主 `ctx.web.search`） | `search.enabled=true` 且判定该消息需要联网时 | 搜索查询词（由消息内容生成）；返回结果会进入同一次 LLM 请求 | `search.enabled=false` |
| 人格广场 URL | `market.indexUrl` 非空且拉取/安装人格时 | 该 URL 的 GET 请求（仅索引与人格包）。插件只允许 `http/https`，拒绝回环/内网/链路本地主机与内嵌凭据，重定向最多 2 跳且每跳重新校验，响应必须是 JSON 且 ≤2MB（详见 [SECURITY.md](SECURITY.md)） | 保持 `market.indexUrl` 为空（默认），只用内置人格 |
| 微信 / 腾讯服务器 | 插件操作真实微信时 | 你本来就会通过微信发出的内容与登录行为；插件不额外注入流量 | 不用真实通道（保持 `mock`） |

明确**不会**外发的内容：截图和 OCR 图像、`audit.jsonl`/`alerts.jsonl`/`memory/`/`state.json`、本机路径、API token、以及任何遥测/统计。

## 4. 明确不采集的数据

- 微信聊天数据库、聊天文件、通讯录、群成员列表；插件只读屏幕像素（desktop）或通道自身提供的事件（mock/phone-adb/windows-vm），不读微信本地库。
- 剪贴板内容（**不采集、不记录、不落盘**；但发送时为了把中文完整粘进微信输入框，脚本会先把待发文本写入剪贴板、粘贴后再恢复原来的剪贴板内容——原内容只在脚本进程内存中短暂持有）、键盘记录、全屏截图（桌面脚本只截微信窗口自身区域）。
- 支付信息、红包/转账内容：`safety.blockTransfers=true` 时拒绝转账/红包类请求并通知。
- 密码、验证码、身份证号等敏感信息：提示词与本地规则会拦截相关请求（`src/core/ocr/correction.ts` 的受控纠错还会跳过这些敏感区段，避免把敏感数字“纠”错或扩散）。
- 设备指纹、使用统计、崩溃上报：**没有任何遥测**。

## 5. 数据保留与删除

| 想做什么 | 操作 |
| --- | --- |
| 查看/导出某联系人记忆 | 打开 `<dataDir>/memory/` 下对应 JSON（文件名是联系人 id 的哈希，不是明文） |
| 清空全部记忆 | 工具 `wechat_persona_clear_memory`，或设置页「日志与测试」里的清空入口，或删除 `<dataDir>/memory/` |
| 清空审计 | 工具 `wechat_persona_clear_audit`，或 `POST /audit/clear`，或删除 `audit*.jsonl` |
| 清掉草稿/积压/通知 | 删除 `drafts.jsonl`、`drafts.json`、`send-ledger.json`、`deferred-inbound.json`、`alerts.jsonl`（删除 `send-ledger.json` 只是丢失去重记忆，不会发送任何内容） |
| 彻底清空本插件数据 | 先暂停插件，再删除整个 `<dataDir>`（以及桌面通道的 `uia-state.json`/`list-preview.json`） |
| 删除临时截图/日志 | 删除 `%TEMP%\wxuia-*.png`、`%TEMP%\wxuia-*.log`、`%TEMP%\dsh-wechat-persona-debug.log`；关闭 `WXUIA_SHOT_DIR` 后重删该目录 |
| 卸载 | 从 profile 的 `package.json` dependencies 与 `dsh.profile.bundles` 移除插件，重启 DSH；再按需删除数据目录 |

## 6. 你的控制权（开关速查）

- **不接触真实微信**：保持 `activeChannel: "mock"`（默认），白名单为空时也不回复任何人。
- **只回指定人**：`whitelist` + `whitelistOnly: true`（默认）。
- **不主动外发**：`search.enabled: false`、`market.indexUrl: ""`、`persona.activeId: ""` 可分别关掉搜索、人格广场、模型生成。
- **随时停手**：`wechat_persona_pause` 工具 / `POST /pause`；desktop 通道还会在你使用电脑时自动让路（键鼠空闲阈值 `userActivityIdleMs`）。
- **数据不想被同步到云**：如果 `<dataDir>` 位于 OneDrive/网盘同步目录下（DSH 默认工作区可能就在同步目录里），云盘客户端可能把记忆/审计/草稿上传到你自己的云账号。需要避免时，把 `dataDir` 配成非同步目录的绝对路径。

## 7. 风险与边界

- **微信自动化本身有协议风险**：本插件用键鼠/截图方式操作微信，可能触发腾讯风控（限制登录、封号等）。请只用自己的**小号**，风险自担；详见根目录 [DISCLAIMER.md](../DISCLAIMER.md)。
- **LLM 服务商**：消息内容一旦发给 LLM，就受该服务商的隐私政策与数据保留策略约束；请自行选择可信服务商，不要把验证码/密码/身份证等敏感信息交给它（插件的本地拦截不能覆盖所有情况）。
- **共用电脑**：数据以你的 Windows 用户身份保存在本机磁盘，未加密。同一台电脑的其他账户/管理员、以及恶意软件仍可能读取；请自行做好账户与磁盘保护。
- **备份与排查材料**：提交 issue / 发给他人日志前，请先删除联系人昵称、wxid、手机号、截图与 token（`scripts/check-sensitive.mjs` 的思路可参考）。
- **未经真实验证的功能**：v3.0.0 中 Phase C（同帧/基线去重/captureId/ack/气泡归属）已双向接线并有单测，但真实微信环境未端到端验证；Phase E 的鉴权加固已落地并有单测但未在真实环境验证；Phase F 的 safeMode/OCR 诊断/首次配置向导已落地并有单测，同样未在真实环境验证；发送状态机/幂等账本/`draft`/`confirm` 模式已实现并有单测（同一 `opId` 只发一次、`unknown` 不自动重发、草稿批准重走门禁），但 DSH 重启/脚本超时等真实故障路径未实机演练；`fusion/align/tracker` 有单测但未接入生产读取路径。`GET /diagnostics/ocr` 只返回帧号/引擎/行数等元数据，不截图、不含聊天正文、不落盘。真实环境行为以 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) 的标注为准。

## 8. 变更与联系

- 本文随版本更新；隐私相关行为变化会写进 [CHANGELOG.md](../CHANGELOG.md) 的「隐私/安全」条目。
- 发现隐私或安全问题：请按 [SECURITY.md](SECURITY.md) 的方式**私密**报告，不要在公开 issue 里贴聊天记录、wxid、截图或 token。

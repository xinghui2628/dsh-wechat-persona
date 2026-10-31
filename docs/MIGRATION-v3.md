# 从 v0.2.8 迁移到 v3.0.0

> 适用版本：上一个已发布版本 **v0.2.8** → 当前开发版 **v3.0.0（开发中，未公开发布）**。
> 本文面向已安装 v0.2.8、希望升级到 v3.0.0 的使用者与二次开发者；包含**回滚步骤**。
> 安装/更新的一般流程见 [使用说明.md](使用说明.md)；隐私与数据位置见 [PRIVACY.md](PRIVACY.md)。

## 0. 升级前先看结论

| 项目 | 结论 |
| --- | --- |
| 配置文件 | ✅ 兼容：字段只增不减，`migrateConfig()` 自动补默认值并记迁移日志，旧配置无需手改 |
| 数据目录 / 记忆 | ✅ 兼容：`state.json`（version 1）、`memory/*.json`（version 1）、`audit.jsonl` 格式未变 |
| 脚本 | ✅ 兼容：`scripts/pwsh/*.ps1` 对 v0.2.8 的调用方式保持兼容；v3.0.0 的 `-Ack`/captureId 协议已双向接线（`desktop.ts` ↔ `wechat-uia.ps1`），旧调用不传 `-Ack` 时按 0 水位线处理（见 §7） |
| HTTP API | ⚠️ 默认仍兼容；但鉴权更严（回环 + 请求头 + Host/Origin/Sec-Fetch-Site 校验），填了 `apiToken` 则必须带 token |
| 桌面通道发送 | ⚠️ 行为收紧：不再把“最近活跃会话”当发送目标，必须能在会话列表定位到该联系人；`unknown` 不自动重试 |
| 公开 API/数据格式 | ⚠️ 仓库 `private: true`，不对外承诺兼容；以本文和 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) 为准 |

## 1. 升级前准备（5 分钟）

1. **暂停插件**：工具 `wechat_persona_pause`，或设置页「概览 → 一键停止」。确认 `GET /status` 的 `paused=true`。
2. **备份数据目录**：把 `<dataDir>`（默认是 DSH 默认工作区下的 `.dsh-wechat-persona/`）整目录复制一份，例如
   `<dataDir>.bak-<YYYYMMDD-HHMMSS>`。**不要删除原目录**。
   - 桌面通道额外备份 `%USERPROFILE%\.dsh\profiles\desktop\.dsh-wechat-persona\`（`uia-state.json`、`list-preview.json`）。
3. **记录配置**：设置页截图或复制 profile 的 `cordis.patch.yml` 中本插件段落；至少记下 `activeChannel`、`whitelist`、`dataDir`、`channels.desktop.enabled`。
4. **确认运行环境**：Node ≥ 22、DSH 桌面版、Windows 10/11 + 中文（简体）OCR 语言包（desktop 通道需要）、微信 PC 4.x。
5. **留好回滚包**：记住当前插件目录的 git 提交（`git -C <插件目录> rev-parse --short HEAD`）；如非 git 安装，先整目录复制一份。

## 2. 升级步骤

```powershell
# 0) 已暂停插件并备份数据目录
cd <插件目录>

# 1) 拉取/覆盖 v3.0.0 代码（git 安装用 git pull；压缩包安装则覆盖文件，保留 .dsh-wechat-persona 数据目录）
git fetch --all
git checkout feat/v3.0.0   # 或维护者指定的 3.0.0 提交

# 2) 安装依赖并构建（本仓库不提交 dist，必须 build）
npm install --ignore-scripts --no-audit --no-fund
npm run build

# 3) 重启 DSH（或重载插件：DSH → 插件 → 本插件开关关 2 秒再开）
```

**为什么必须 `npm run build`**：插件运行的是 `dist/`，不同步构建产物会出现“代码是新的、行为是旧的”。只改 `client/` 时可只刷新设置页，但 v3.0.0 改动在 `src/`，必须重启/重载。

## 3. 升级后自检

```powershell
# 健康检查：确认 version=3.0.0（需要请求头；填了 apiToken 再加 Authorization: Bearer <token>）
curl.exe -H "x-dsh-wechat-persona: 1" "http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api/health"

# 运行状态：确认 paused / channel / budget / delivery 计数
curl.exe -H "x-dsh-wechat-persona: 1" "http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api/status"
```

然后在**不接真实微信**的情况下做一次冒烟：

1. 保持 `activeChannel: "mock"`，白名单里放一个测试联系人；
2. 设置页「日志与测试」→ 注入一条入站测试消息（`POST /test/inbound`），确认能生成回复（mock 输出到 `outbox.jsonl`，不碰微信）；
3. 若用 desktop 通道：先只开「驱动只读」（`driverEnabled=false`），确认能 `list`/`read`；再按 [CHANNELS.md](CHANNELS.md) 校准并小范围开启发送。

## 4. 配置迁移细节

- **自动迁移**：插件启动时 `migrateConfig(raw)` 会补默认值、迁移旧版 `schedule.onlineStart/onlineEnd` 到工作日/周末字段、给 `persona.activeId` 补 `builtin-small`、`whitelistOnly` 补 `true` 等（实现见 `src/config.ts` 的 `migrateConfig`）。迁移是**幂等**的：第二次启动不会重复改。迁移结果会写日志，方便核对。
- **旧字段仍生效**：`reply.personaDir` / `reply.personaName` 仍可用，但会在迁移提示里建议改用人格库（`persona.*`）以支持多套人格。
- **新增可选字段**：`apiToken`（默认空字符串 = 兼容模式）、`safeMode`（默认 `false`，开启后拒绝向真实通道发送）、`onboardingDone`（默认 `false`，首次配置向导完成后写 `true`）。填写 `apiToken` 后所有 API 请求必须额外带 `Authorization: Bearer <token>`（或 `x-dsh-persona-token: <token>`），否则 401。插件启动时会自动把生成的参考 token 写到 `<dataDir>/api-token`（权限尽量收紧），但**只有你在配置里填了 `apiToken` 才会强制校验**。
- **建议顺手核对的配置**：
  - `dataDir`：v3.0.0 下保持“留空 = 工作区 `.dsh-wechat-persona`”的语义；如果 v0.2.8 时用的绝对路径，继续保留即可。
  - `channels.desktop.enabled`：默认 `false`，升级不会自动打开。
  - `search.enabled` / `market.indexUrl`：涉及外发，按 [PRIVACY.md](PRIVACY.md) 确认是否符合预期。
  - `safety.circuitBreakerEnabled`：保持 `true`（默认）；关闭后风控触发只记录不熔断，不建议。

## 5. 行为变化（升级后可能“感觉不一样”的地方）

| 变化 | v0.2.8 | v3.0.0 | 对你的影响 |
| --- | --- | --- | --- |
| 桌面发送定位 | 180 秒内最近活跃联系人曾被当作发送目标 | 只认会话列表里该联系人的行坐标；定位不到直接 `{ok:false, error:"缺少聊天定位信息…已拒绝发送以避免发错人"}` | 联系人必须出现在会话列表；不会“猜一个当前聊天”发出去 |
| 发送结果 | 主要看 `ok` | 三态 `delivery: sent / not-sent / unknown` | `unknown` 时插件**不会**自动重发；请人工看一眼聊天窗口再处理 |
| 重试 | 失败可能重试 | 只有 `not-sent` 允许重试；`unknown` 一律不重试（防重复） | 假失败不再刷屏 |
| 暂停语义 | 暂停主要影响新回复 | 暂停后**任何**发送（含 `/test/send`）都会被门禁拒绝；暂停期间的入站消息暂存到 `deferred-inbound.json`（最多 50 条），恢复后补处理 | 恢复后可能集中处理少量积压消息 |
| 状态可见性 | `/status` 无投递计数 | `/status` 新增 `delivery: {sent, notSent, unknown}` 与 `deferredCount` | 可在设置页/接口直接看到投递质量 |
| API 鉴权 | 回环 + 请求头 | 回环 + 请求头 + Host/Origin/Sec-Fetch-Site 校验；可选 `apiToken`；进程内限速 240 次/分钟/来源（超出 429） | 用浏览器从非本机页面调 API 会被拒（预期行为）；本机设置页不受影响 |
| OCR 处理 | 读取/纠错逻辑混在 `desktop.ts` | 纯逻辑抽到 `src/core/ocr/`（`normalize/correction/vote/geometry` + Phase C 的 `baseline/bubbles/pipeline`），`desktop.ts` 强类型化 | 行为不变；同帧读取、气泡归属、ack 水位线生效（真实环境未验证） |
| 安全模式 | 无 | 新增 `safeMode`（默认 `false`）：开启后所有非 mock 通道发送被门禁拒绝（`safe-mode`）；设置页「预算与安全」可切换，首次配置向导默认建议开启 | 升级不会自动打开；建议在第一次接真实微信前手动开启并做 mock 冒烟 |
| 诊断/向导 | 无 | 新增只读 `GET /diagnostics/ocr`（不截图、不含正文）与设置页首次配置向导、mock 测试入口 | 升级后按向导确认配置；诊断用于排查 OCR 读取状态 |

## 6. 数据文件变化

| 文件 | 变化 | 迁移动作 |
| --- | --- | --- |
| `state.json` | 版本仍为 1，字段只增不减；读取时逐字段归一（缺字段补默认、损坏回退默认） | 无需动作 |
| `memory/*.json` | 仍为 version 1；文件名为联系人 id 的 sha1 前 16 位 | 无需动作 |
| `audit.jsonl` | 事件格式不变；`send` 事件增加 `delivery` 字段（旧读者可忽略） | 无需动作 |
| `deferred-inbound.json` | v3.0.0 新增，暂停期间积压的入站消息 | 旧版本不接受该文件但也不会读它；回滚时可直接忽略 |
| `api-token` | v3.0.0 新增，运维参考 token 文件 | 回滚后可删除；旧版不会读 |
| `desktop-ack.json` | v3.0.0 新增，桌面通道每个联系人最近已确认的 ack 水位线（形如 `cap-12`，含联系人名称，不含正文） | 回滚到 v0.2.8 时旧版不读，可保留也可删除；删除后首次读取从 0 水位线开始（脚本按稳定 id 去重） |
| `drafts.jsonl` | 预算草稿模式输出（v0.2.8 已有则不变） | 无需动作 |
| `uia-state.json`（不在 `dataDir`，位于 `%USERPROFILE%\.dsh\profiles\desktop\.dsh-wechat-persona\`） | v3.0.0 起除窗口基线外还保存 pending 队列（含聊天文本片段）、`captureId`/ack 水位线、`side/box`；属于敏感落盘，见 [PRIVACY.md](PRIVACY.md) | 升级后首次读取会重建基线；回滚到 v0.2.8 时该文件会被旧脚本忽略，可保留也可删除 |

## 7. 尚未完成 / 未验证（升级时不要按“已在真机生效”理解）

以下能力在代码与单测层面已落地，但**真实微信环境尚未验证**，升级时请按“可选/待验证”对待：

- **Phase C 的 captureId/ack 协议**：`src/core/ocr/{baseline,bubbles,pipeline}.ts` 已实现并单测覆盖（pending 队列 + ack 水位线 + 稳定消息 id + 气泡几何归属）；`desktop.ts` 与 `wechat-uia.ps1` 已双向接线——read 传 `-Ack` 水位线，脚本回传 `captureId/pane/lines[].side/box/messages[]` 并对未确认行重放，TS 侧 `planInboundDispatch` 拒投 `uncertain` 行；脚本旧输出走 legacy 兼容分支。**真实微信窗口下的端到端效果未验证**，见 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) 门槛 2。
- **OCR 准确率**：v3.0.0 管线相对 v0.2.8 的离线等价 A/B 已在独立 eval 集上出结论（CER 21.38% / 整句 47.83%，同集 v0.2.8 为 37.37% / 28.26%，跨口径满足发布门槛）；但结论限定**合成语料 + 离线等价**，第二引擎融合/受控纠错几乎未触发，**真实微信截图未验证**。详见 [OCR-BENCHMARK.md](OCR-BENCHMARK.md) §6.5 与 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) §3。
- **安全运行模式与诊断（Phase F）**：`safeMode`、`GET /diagnostics/ocr`、首次配置向导、mock 测试入口均已实现并有单测（`test/engine/acceptance.test.ts`、`test/server/api.test.ts`），但**未在真实 DSH + 真实微信环境做端到端验证**；升级后建议先开 `safeMode` 跑 mock 冒烟。
- **真实微信环境验证**：桌面通道的发送可靠性与跨联系人安全改进有单测与离线验收，但**真实设备测试需要你单独授权**，未授权前不应视为已验证。

## 8. 回滚步骤（v3.0.0 → 返回 v0.2.8）

1. **暂停插件**：`wechat_persona_pause` 或设置页一键停止；确认 `paused=true`。
2. **备份 v3 数据**：把当前 `<dataDir>` 复制为 `<dataDir>.v3-bak-<时间>`（保留现场便于排查）。
3. **恢复旧代码**：
   ```powershell
   cd <插件目录>
   git checkout v0.2.8            # 或旧提交 / 恢复升级前的目录副本
   npm install --ignore-scripts --no-audit --no-fund
   npm run build
   ```
4. **恢复数据**：用升级前备份覆盖数据目录（推荐，最稳）：
   ```powershell
   # 先确认目标路径正是插件数据目录，再操作；不要用 /s 之类批量删除
   Rename-Item <dataDir> <dataDir>.v3-keep-<时间>
   Copy-Item <dataDir>.bak-<升级前时间戳> <dataDir> -Recurse
   ```
   同时把 `%USERPROFILE%\.dsh\profiles\desktop\.dsh-wechat-persona\` 恢复为备份版本（如升级期间被写过）。
5. **重启 DSH / 重载插件**，确认 `GET /health` 的 `version` 回到 0.2.8。
6. **验证**：mock 通道注入一条入站测试消息；用 desktop 的“只读”模式确认能 `list/read`；确认设置页可打开。
7. **保留现场**：确认稳定后再删除 `.v3-bak-*` 目录；遇到问题请连同脱敏日志一起反馈。

> 回滚注意：v3.0.0 写入过的 `state.json`/`audit.jsonl` 含新增字段，旧版本读取这些文件的兼容性**未验证**。因此回滚数据时优先整目录替换为升级前备份，而不是“只换代码不换数据”。`api-token`、`deferred-inbound.json` 可以直接删除。

## 9. 常见升级问题

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 设置页打不开、API 404 | 插件没挂上 webServer，或版本旧 | 看 `%TEMP%\dsh-wechat-persona-debug.log`；重载插件；确认 `dist/` 已构建 |
| API 403「缺少或错误的 x-dsh-wechat-persona 请求头」 | 请求没带 `x-dsh-wechat-persona: 1` | 加上请求头 |
| API 403「Host 不是本机回环 / Origin 不是本机回环 / cross-site」 | 从非本机页面或代理调用 | 从 `http://127.0.0.1:<DSH端口>` 调用，或按需在配置中调整 |
| API 401 | 填了 `apiToken` 但没带 token | 加 `Authorization: Bearer <token>` |
| API 429 | 进程内限速（240 次/分钟/来源） | 降低轮询频率；设置页正常使用不会触发 |
| desktop 发送被拒「缺少聊天定位信息」 | 会话列表里找不到该联系人 | 让对方发一条消息/刷新会话列表，或调大列表可见范围 |
| desktop 连续失败 6 次停摆 | 连续异常触发保护 | 看 `%TEMP%\wxuia-engine-debug.log`，修复后重载插件恢复 |
| 恢复后收到“积压”回复 | v3.0.0 暂停暂存了入站消息 | 预期行为；可在 `deferred-inbound.json` 查看，或清理该文件后重载 |

更多排查见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

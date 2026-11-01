# 验收说明（Acceptance）

本文件把需求里的验收标准逐条映射到**可复现的证据**：测试用例 + 运行期日志（`audit.jsonl`）。
所有命令都在项目根执行。

```powershell
npm run typecheck   # 类型检查
npm test            # 单元 + 集成验收测试（普通环境）
# 受限沙箱（禁止 pipe spawn）：
npm run test:sandbox
```

> 沙箱说明：本机 DSH 沙箱禁止 node 用默认管道 stdio spawn 子进程，vitest 的 Vite/esbuild
> 链路会因此 EPERM。`npm run test:sandbox` 通过 `test/core/sandbox-preload.mjs` 做兼容
> （exec/execFile 桩 + 进程内 esbuild 替身），不改变被测代码行为。普通电脑上用 `npm test` 即可。

## 1. 白名单外 / 免打扰时段：0 次 LLM 调用

**要求**：本地规则直接跳过，日志能证明没有调用模型。

**测试**：
- `test/core/gate.test.ts`
  - 非白名单 id → `Decision.skip`，`reason='not-whitelisted'`；调用计数为 0；
  - 群聊消息 → `group-chat`（且引擎侧还有一层防御）；
  - 自己发的消息 / 纯表情包 / 无意义消息（`hhh`、`…`）/ 重复消息 → 对应 skip reason；
  - 在线时段外 → `offline-hours`；低活跃日超量 → `low-activity-day-limit`。
- `test/engine/acceptance.test.ts`
  - 用假 LLM（记录调用次数）跑完整引擎：白名单外消息、时段外消息走完后
    `llm.calls === 0`，且 `audit` 中记录 skip 事件、`state.stats.llmCalls` 不增加。

**运行期证据**：`<dataDir>/audit.jsonl` 中
`{"type":"skip","reason":"not-whitelisted",...}`、`{"type":"skip","reason":"offline-hours",...}`，
且同时间段没有任何 `{"type":"llm",...}` 记录。

## 2. 命中消息：本地判断后 10 秒内生成并按配置发送

**要求**：从入站到第一条发送 ≤ 10 秒（随机“正在输入”被限制在 0.8–5 秒）。

**测试**：`test/engine/acceptance.test.ts`
- 使用**假时钟**（记录 sleep 调用）跑一条命中消息：总 `sleep` 时长 = typing delay（0.8–5s）+ 分条间隔；
- 断言 `发送时间戳 - 入站时间戳 ≤ 10_000ms`；
- 断言发送顺序与配置一致（文本/表情包、分条数量 ≤ `maxSplitParts`）。

## 3. 表情包随机且不连续重复

**测试**：
- `test/core/stickers.test.ts`：目录按情绪分类加载；`pick(category, recentIds)` 排除
  `recentIds` 中的 id；候选为空时回退 `pickAny`；`recentStickerIds` 只保留最近 N 个。
- `test/core/humanize.test.ts`：`planHumanReply` 在配置 `stickerProbability=1` 时必然追加表情包；
  连续多次调用不会选中最近 8 次用过的 id。
- `test/engine/acceptance.test.ts`：连续两条回复的 `outbox` 表情包 id 不同。

## 4. 按规则触发一次搜索

**测试**：
- `test/core/search-intent.test.ts`
  - 触发：天气（"明天会下雨吗"）、新闻（"今天有什么新闻"）、新梗（"最近有什么梗"）、
    地点（"附近有什么好吃的"）、价格（"这个多少钱"）；
  - 不触发：普通闲聊、纯表情、已含链接的消息；
  - `search.enabled=false` 时任何消息都不触发；
  - `extraKeywords` 可追加触发。
- `test/engine/acceptance.test.ts`：
  - 命中搜索意图且 `search` 假实现返回结果 → `llm` 收到的上下文中含搜索结果；
  - 搜索抛错时仍正常生成并发送（降级），审计中 `search.ok=false`。

## 5. 每日 token 预算：不超预算，超了自动转草稿

**测试**：
- `test/core/budget.test.ts`
  - `addUsage` 跨日滚动（日期变化自动清零）；
  - `budgetPhase`: `< draftModeRatio` → `ok`；`≥ draftModeRatio` → `draft`；`≥ dailyTokens` → `exhausted`；
  - 边界值：恰好等于阈值、`dailyTokens=0`。
- `test/engine/acceptance.test.ts`
  - 预算充足：正常发送；
  - 预算进入 draft 区间：`drafts.jsonl` 有内容、`outbox` 无新增、审计 `type='draft'`；
  - 预算 exhausted：直接 `skip reason='budget-hard-stop'`，LLM 调用次数不再增加。

## 6. 风控提示出现时 1 秒内停止并通知

**要求**：检测到验证码/异常登录/限制提示 → 立即暂停所有自动化并通知，不自动重试。

**测试**：
- `test/core/breaker.test.ts`：`detectRisk` 对验证码/异常登录/限制/频繁操作文案命中；
  `tripBreaker` 记录状态；熔断后 `evaluateInbound` 返回 `halt.type='breaker'`。
- `test/engine/acceptance.test.ts`
  - 通道回调 `onRisk(...)` → 断言 `channel.stop()` 被调用、`notifier` 收到 critical、
    `state.paused` 为真、审计 `type='risk'`；
  - 熔断后的入站消息：`llm.calls` 不增加（0 token）、不再发送；
  - 全程使用假时钟断言停止动作发生在同一逻辑时刻（≤1 秒要求由“同步暂停 + 通道 stop”保证）。
- `test/channels/risk.test.ts`：通道侧文案扫描（`channels/*` 的风控关键词）。

## 7. 断线恢复 / 异常隔离 / 一键停止

**测试**：
- `test/channels/windows-vm.test.ts`：断线后按 `reconnectIntervalMs` 重连，恢复后收发正常；
- `test/channels/phone-adb.test.ts`：无设备时 `start` 不抛、状态 `degraded`，命令失败不崩；
- `test/channels/mock.test.ts`：轮询文件 → 入站回调；发送写 `outbox.jsonl`；
- `test/core/stop.test.ts`：`/stop` 命令识别（仅白名单）、`pauseEngine/resumeEngine` 状态迁移；
- `test/engine/acceptance.test.ts`：
  - 单条消息处理中抛异常（假 LLM 抛错）→ 引擎捕获，后续消息仍能正常处理，`stats.errors` 增加；
  - `engine.pause('x')` 后入站一律 skip；`resume()` 后恢复；
  - 状态落盘：暂停/熔断写入 `state.json`，重建引擎后仍保持暂停。

## 8. 审计可对账

**测试**：`test/core/audit.test.ts`
- `record` 追加 JSONL、`recent(n)` 取最近 n 条、`summary()` 按日聚合
  `llmCalls/llmTokens/cacheReadTokens/searches/sends/drafts/skips`；
- `clear()` 清空后重新记录；
- 超过 `maxAuditMb` 滚动到 `audit.1.jsonl`（不丢旧文件）。

## 9. 安装/加载验证（已在本机 DSH 桌面版 0.2.1-rc.3 实测）

自动化基线：**22 个测试文件 / 204 个用例通过**（v0.1.0 基线；v0.2.0 已扩到 30 文件 / 399 用例，见 §11），`npm run typecheck` 0 错误，`npm run build` 产出 `dist/` 70 个文件。

| 步骤 | 实测结果 |
| --- | --- |
| 1. `npm run build` | `dist/index.js`、`dist/index.d.ts` 生成；`node -e "import('./dist/index.js')"` 输出 `Config,apply,inject,name,provide` |
| 2. `plugin_manager action=install_bundle target=<插件目录>` | `application: applied`；loader entry `include:dsh-wechat-persona` |
| 3. 「插件配置」出现 **微信小号人格分身** | ✅（locale/zh.json 提供标题与描述；表单字段与 `src/config.ts` 一致） |
| 4. 调用 `wechat_persona_status` | ✅ 返回：运行中；通道 mock/running；人格 小号；在线；预算 0；今日 0 |
| 5. `wechat_persona_pause(reason=live-verify)` → `resume` | ✅ 分别返回「已暂停（live-verify）」/「已恢复，通道 mock/running」 |
| 6. 状态/审计落盘 | ✅ `<dataDir>/{state.json,audit.jsonl}`；audit 含 `start` / `stop`（manual-pause）/ `resume` 事件 |
| 7. mock 通道端到端灌消息 | 需先配置：`whitelist` 填一个 `id`、`channels.mock.inboundFile` 指向 `inbound.jsonl`；然后写一行入站 JSON、看 `outbox.jsonl` 与 `audit.jsonl`（`skip` 有 reason、`llm` 有 token 用量）。默认 `whitelist=[]` 时插件空转，是安全默认 |

> `<dataDir>` 默认是 **DSH 数据目录下的 `.dsh-wechat-persona/`**（本机实测为
> `C:\Users\<你>\.dsh\profiles\desktop\.dsh-wechat-persona\`）。插件是后台服务，没有会话上下文，
> `workingDirectory.defaultDirectory` 只是部署回退目录；要固定存到工作区，请在配置里把
> `dataDir` 设为绝对路径（示例见 README）。

## 10. 安全/合规检查

- 群聊/非白名单消息不落记忆、不进上下文（`gate` 在写记忆之前返回 skip）。
- 敏感关键词（转账/红包/验证码/密码…）→ 暂停 + 通知，不调用模型（`safety.forbiddenKeywords`）。
- 审计日志、记忆、草稿都可用工具一键清空（`wechat_persona_clear_audit`、`wechat_persona_clear_memory`）。
- 三通道风险与防封建议见 [CHANNELS.md](CHANNELS.md)。

## 11. v0.2.0 第二轮验收证据（2026-10-30）

### 11.1 自动化基线

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 0 错误 |
| 全量测试 | `npm run test:sandbox` | **30 个测试文件 / 399 个用例全部通过**（受限沙箱可用；普通环境 `npm test`） |
| 构建 | `npm run build` | `dist/` 78 个文件；`node -e "import('./dist/index.js')"` → `Config/apply/inject/name/provide` |
| 离线接口验收 | `npm run verify:api` | **25/25 通过**（v3.0.0 复核，2026-11-01；见下） |

### 11.2 离线接口验收（`scripts/verify-api.mjs`）

用「假宿主 ctx + 真实 `dist` 代码 + 真实 HTTP 端口」模拟重启后的完整链路，不依赖 DSH 进程、不联网、不碰真实微信：

- `dist/index.js` 导出正确；假装 profile 的旧配置（`onlineStart/End`）经 `migrateConfig` 正确迁移为工作日/周末时段，且再次迁移幂等；
- API 前缀路由 `/dsh-wechat-persona/api/` 已注册、`wechatPersona` 服务已 provide；
- 鉴权：缺 `x-dsh-wechat-persona: 1` 头 → 403；
- `GET /health`、`/status`（engine mock 通道 running）、`/config`（`persist.editable=true`）；
- `POST /config` → 202 且真实调用 `configEditor.edit()`（配置会写回 profile 的 `cordis.patch.yml`）；
- `GET /personas` → 4 个内置人格、activeId 正确；`POST /personas/activate` → 202 且再次写入配置；
- `GET /market` → 远程索引不可达时回退内置 4 条；`GET /stickers` → 18 张内置表情包；`GET /logs` → 审计事件；`GET /help` → 使用说明书 13649 字；
- `POST /test/inbound` → 202（走本地规则）；`POST /test/send` → 通道发送成功；
- `POST /pause` / `POST /resume` → 状态正确；未知路由 → 404 统一错误体。

### 11.3 设置界面（客户端半）

- `client/client.js`（10 个标签页：概览/人格/白名单/在线时段/回复策略/表情包/预算与安全/日志与测试/人格广场/帮助）通过 `node --check`；
- `test/client/` 25 个用例覆盖 pure 逻辑与模块骨架（factory/apply 注册 style/locale/两个入口槽、bundle 卡片 summary 返回 null、错误处理）；
- 纯逻辑放在 `client/lib.js`（可被 Node 直接 require 测试）。

### 11.4 人格库 / 人格市场 / 桌面脚本 / 文档

- 人格库 26 用例 + 人格市场 22 用例；内置 4 个人格（小号/大肥鱼/老周/阿码）；兼容 SillyTavern 角色卡导入；
- `scripts/pwsh/wechat-uia.ps1`：PS 5.1 语法解析 0 错误、UTF-8 BOM 正常、`INPUT` 结构体 40 字节（旧版 32 导致键入失败）；自建模拟微信窗口端到端 5 用例通过；`read` 空数组两个根因（`$geo2.right` 为 null + 数组套数组）已修；
- `README.md` / `docs/使用说明.md` / `CHANGELOG.md` / `docs/CHANNELS.md` 已同步（桌面段含「真实环境验证清单」）。

### 11.5 需要重启 DSH 后才能做的人工验证

本地插件代码已更新，但运行中的 DSH 进程按 Node ESM 模块缓存**旧的 `dist`**；`plugin_manager` 的关闭/启用只是重新实例化 `apply()`，不会重新 import 新代码（官方文档：“rebuilding and restarting remain necessary after code changes”）。因此以下项必须**完全退出并重开 DSH 桌面端**后确认：

1. 侧栏 Plugins → **微信小号人格分身**卡片，或 设置 → **微信分身**，能看到 10 个标签页；
2. 在设置页改人格 / 加白名单 / 设在线时段 / 装一个内置人格 → 保存 → 提示保存成功，配置写入 profile 的 `cordis.patch.yml`，重启不丢；
3. 截图/录屏留存（验收要求）；
4. 若启用 desktop 通道：先按 [CHANNELS.md](CHANNELS.md) 的 13 项清单逐项人工确认，并随时用 `/pause` 或设置页暂停。

## 12. v0.2.1 桌面通道稳定性收尾证据（2026-10-31）

### 12.1 自动化基线

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 0 错误 |
| 构建 | `npm run build` | `dist/` 重新生成成功 |
| 桌面脚本语法 | `[System.Management.Automation.Language.Parser]::ParseFile(...)` | PARSE-OK；UTF-8 BOM 保留 |
| 会话列表识别 | `wechat-uia.ps1 -Action list`（4 位联系人） | 4/4 found，约 1.9–2.3 秒 |
| 一键自检 | `scripts/pwsh/selfcheck.ps1 -Port 53905` | fail 0 / warn 1（多微信窗口提示）；插件 API 0.2.1 正常 |
| 宿主 API 离线验收 | `npm run verify:api` | 25/25 通过（v3.0.0 复核，2026-11-01） |
| 沙箱测试 | `npm run test:sandbox` | 30 个测试文件 / 399 个用例全部通过 |

### 12.2 脚本层压测（`scripts/dev/stress-script.py`，文件传输助手）

- 10 轮 list + send：**list 10/10、send 10/10（成功率 100%）**，
  list P50/P95 = 1970/2051 ms，send P50/P95 = 2743/3440 ms。
- 100 轮 list + send：**list 100/100、send 100/100（成功率 100%）**，list P50/P95 = 1988/2353 ms，send P50/P95 = 2759/3496 ms，单轮 list+send 平均 5006.5 ms（报告：`stress-script-144155.json`）。

### 12.3 发送判定三路径（`scripts/dev/test-send-fallback.py`）

| 用例 | 预期 | 实测 |
| --- | --- | --- |
| 1. 单字「好」（气泡 OCR 天然失败） | 输入框清空兜底 → `ok:true` | `ok:true`（2673ms） |
| 2. `WXUIA_FORCE_BUBBLE_FAIL=1` 强制气泡校验失败 | 输入框清空兜底 → `ok:true` | `ok:true`（3579ms） |
| 3. 再叠加 `WXUIA_SKIP_ENTER=1`（未真正回车） | 负例：`ok:false` 且**不重发** | `ok:false`（3679ms，error=「快发送已回车但气泡未确认且输入框未清空，已跳过保守重发以免重复」） |
| 4. 正常发送清理消息 | `ok:true` | `ok:true`（2711ms） |

判定依据：`Get-RegionSnapshot -Ink` 统计输入框区域的深色像素——空输入框（含灰色占位「长按鼠标 语音输入」）dark=0，
键入后 dark≈268；因此「键入有深色像素 + 回车后输入框深色像素<20」即判发送成功，OCR 行数只作辅助。

### 12.4 列表识别修复要点（可复现）

- 行锚点优先用「绿底选中行高度 = 行距」推算，再用 `pitch` 枚举整栏行位置；取不到绿底才回退时间戳锚点。
- 整栏 OCR 漏名字（头像/绿底白字）时，按行裁「名字条」（y∈[anchor-30, anchor+30]）用 4x 最近邻放大单独 OCR。
- 未读红点检测区域避开头像（x∈[nx-62, nx-14]）；预览变化兜底只在旧预览存在且变化时置 unread。
- 已打开聊天：Enter-Chat 严格标题匹配失败后先做宽松匹配（`Test-IsTargetChatLoose`），不再盲目 Ctrl+F 搜索。

### 12.5 30 条真实好友测试（待用户配合）

真实好友（3 位白名单测试好友 A/B/C）的 30 条端到端测试需要在真人好友配合下进行（发消息、打扰对方），
已准备好执行方法：

```powershell
# 由好友发消息触发回复；观察 dataDir/audit.jsonl 的 llm/send 事件耗时与内容，逐条核对错发 0
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\.dsh-wechat-persona\audit.jsonl" -Encoding UTF8 -Tail 30
```

本机已完成的等价验证：mock 单元/集成测试 + 脚本层 110 轮真实发送（文件传输助手）+ 三路径兜底负例 + 白名单/时段/预算的 0-token skip 用例。
待用户确认好友在线后补齐 30 条真实样本截图与 audit 摘要。

### 12.6 发布检查表（对应 `docs/QA-RELEASE-AUDIT.md` 阻塞项）

- [x] 真名/用户名从 git 跟踪文件移除（敏感 patch/recover 脚本移出仓库；`git grep` 无命中）
- [x] 历史备份文件（`*.broken-*`、`*.exp-fast-*`、`*.bak-send-*`）移出仓库
- [x] 硬编码 `C:\Users\<用户名>` 的一次性脚本移出仓库
- [x] 根目录新增 `LICENSE`（MIT）
- [x] README / 使用说明 版本号统一为 0.2.1；用例数统一为 30/399
- [x] ARCHITECTURE 路由列表与 `src/engine/engine.ts` 路径修正
- [x] 安装前置条件（Node 22+/DSH/Win10-11/中文 OCR 语言包/微信 PC 4.x）补齐
- [x] `package.json` 增加 `engines.node >= 22` 与 keywords
- [x] git 历史清理：**master 现为单提交 `ba606a4`（131 个跟踪文件）**，`git log -p master` 无真实昵称/用户名命中；旧历史仅保留在本地分支 `archive/pre-release-20261031`（不推送、可自行删除）
- [ ] 30 条真实好友测试（待用户配合）

### 12.7 生产配置恢复（2026-10-31 14:50）

- 插件已按最终 `dist/` 重载：`/health` version=0.2.1、`/status` channelState=running。
- 生产配置恢复：`budget.dailyTokens=50000`、`channels.desktop.userActivityIdleMs=1500`、白名单 3 人、
  在线时段 08:00–21:00、人格 `builtin-dafeiyu`、`channels.desktop.enabled=true`。
- 暂停开关保持用户原来的手动状态（`paused=true, pauseReason=manual`）——插件不会自动回复，需在设置页手动开启。
- 通道恢复后 2 秒轮询正常：列表 3/3 命中、`unread=false`、无 Ctrl+F 搜索框闪烁（`auto` 截图 + 宽松标题匹配生效）、无前台抢占。

> 注（2026-10-31）：为进行真实好友 30 条测试，日预算曾临时调高到 120000 tokens（当日已消耗 67856）；
> 收尾时已通过 `/config` 改回 **50000**（2026-10-31 15:50 复核：dailyTokens=50000）。其余生产项（白名单 3 人、08:00–21:00、
> userActivityIdleMs=1500、builtin-dafeiyu、桌面通道 enabled=true）保持生产值；插件已重载到 0.2.3（`/health` version=0.2.3）。

## 13. v0.2.3 四项限制修复证据（2026-10-31）

本轮按用户反馈处理四个已知限制，结论：**两个必须修（已修）、两个按设计保留并文档化**。

### 13.1 读取聊天记录：左侧气泡过滤偏严 + 防串聊（必须修，已修）

- 默认分栏比例 `WXUIA_PANE_LEFT_RATIO` 从 0.40 调到 **0.30**（微信 1200 宽窗口会话列表右边界约 315px≈0.26w，聊天区从约 0.30w 开始），原先左侧对方气泡可能被误裁。
- 自己/对方消息判定改用**行中心点**（对方气泡文字从 0.40w 起、自己的绿气泡右缘约 0.90w），避免把左侧长消息误当自己消息。
- **防串聊**：标题栏 OCR 变成「张，伟」这类形近字时，旧逻辑的「首字相同」兜底会把「张伟」的聊天当成「张磊」读取（实测串聊）。现在去掉首字兜底，并新增 `Test-ChatByListPreview`：用左侧会话列表里目标联系人的最新消息预览与当前聊天区候选消息交叉验证；两路都确认不了就拒绝读取，返回 `ok:false`「无法确认当前聊天是「X」……已跳过读取以避免读错人」。
- 实测（真实微信 4.1.x）：`read 张伟` → ok 7 条（经列表预览验证，日志「列表预览交叉验证命中: 修问题」）；`read 李四` → ok 1 条；`read 文件传输助手` → ok 0 条；`read 王五` → 拒绝（其列表行名字 OCR 成「张，」拿不到预览，安全第一）。

### 13.2 表情包/图片/语音（必须修“假发送/反复报错”，已修）

- 通道能力声明：`src/types.ts` 新增 `ChannelCapabilities { stickers?, images?, voice? }`，`Channel` 接口加 `capabilities?`；桌面通道声明 `{ stickers: false, images: false, voice: false }`（桌面视觉驱动只能发文本）。
- 引擎降级：`src/engine/engine.ts` 在 channel 不支持表情时把 `stickerProbability` 强制置 0、`planParts` 跳过 sticker，**不再产生无谓的 send-fail 与错误计数**；图片/语音同样不经桌面通道发送。
- 新增单测覆盖能力降级（`test/engine` 相关用例），`test:sandbox` 30 文件 **400 用例全过**。

### 13.3 遮挡/被抢占时拒发（按设计保留，文档化）

- 安全原则：宁可失败，绝不发错人/发错窗口。窗口被其他窗口完全遮挡、无法确认前台时，脚本返回 `ok:false` 并跳过发送；不自动重试。
- 已在 docs/使用说明.md「10.4 已知限制」与 FAQ Q5 说明；默认截图改为 PrintWindow 优先（`WXUIA_CAPTURE=auto`），正常使用不会反复抢前台。

### 13.4 OCR 形近字（按设计保留，已有三层兜底 + 文档化）

- 三层兜底：整栏 OCR → 名字条 4x 最近邻二次 OCR → 列表预览交叉验证（读取）/气泡+输入框清空判定（发送）。
- 文档给出实用缓解：**给 OCR 不稳的好友设简单微信备注名**（使用说明 10.4 与 FAQ Q14）；读取拒绝场景见 FAQ Q15。

### 13.5 本轮测试记录

- `npm run typecheck` 通过；`npm run test:sandbox` 30 文件 / 400 用例通过；`npm run build` 通过；脚本 `Parser::ParseFile` PARSE-OK（UTF-8 BOM 保留）。
- 发送三路径回归：单字兜底 ok:true 2754ms、强制气泡失败兜底 ok:true 3605ms、SKIP_ENTER 负例 ok:false 3661ms（未误判成功、未重发）、清理 ok:true 2842ms。
- 10 轮 list+send 压测：list 10/10、send 10/10；list P50/P95 = 1977/2071ms，send P50/P95 = 2763/3475ms，单轮平均 5013ms。
- 40 轮 list+send 压测：**list 40/40、send 40/40**；list P50/P95 = 1980/2054ms，send P50/P95 = 2822/3461ms，单轮平均 5013ms（`.dsh-tmp/stress-script-154558.json`）。累计本轮压测 50 轮，send 全部成功、无重复、无错发。

## 14. v0.2.8 OCR 双引擎投票 + 字典纠错证据（2026-10-31）

### 14.1 常用词字典纠错（离线，不联网）
- 实现：`src/channels/pc/desktop.ts` 的 `DEFAULT_OCR_DICT` + `correctOcrText(text, extraWords)`；只对长度 ≥3 的常用词做「同长度只差一个字」替换，2 字词不模糊替换（避免把「今天」误改成「聊天」）。
- 测试：`test/channels/desktop.test.ts`「200 种形近字变体循环」+「普通文本不误改」 → 全过。

### 14.2 双引擎 OCR 投票（系统 OCR + RapidOCR）
- 实现：`scripts/py/rapid_ocr.py`（可选依赖 `rapidocr_onnxruntime`，未安装时安静失败回退）；`wechat-uia.ps1` 新增 `-Action shot` 与 `-SecondOcr`（截图 → 第二引擎识别 → 按行 y 坐标 + 字符重合度与系统 OCR 候选投票合并）；`desktop.ts` 多帧放大仍可疑时自动追加 `-SecondOcr`，`mergeEngineVote` 再做最后一轮投票。
- 测试：`test/channels/desktop.test.ts`「200 种双引擎变体」+「200 次 -SecondOcr 集成循环」→ 全过。
- 本机实测：`python scripts/py/rapid_ocr.py <窗口截图>` 识别出 33 行中文（含「测试甲」「文件传输助手」「压测#100」等），耗时约 6.3s（含首次模型加载）；脚本 read 日志出现「SecondOcr 完成 merged=N」。

### 14.3 自动化基线
- `npm run typecheck` 通过；`npm run test:sandbox` → 30 文件 / **416 用例**全过；`npm run build` 通过。
- 插件重载后 `/health` = `{"ok":true,"version":"0.2.8"}`。

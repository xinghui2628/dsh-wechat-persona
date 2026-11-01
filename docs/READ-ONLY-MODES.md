# 只读模式与读取副作用（v3.0.0 发布前验收）

本文说明「只读测试模式」的代码层实现、允许/禁止的读取模式，以及它与 OCR 质量阈值的区别。
对应任务书第五部分（只读测试模式）与第四部分 4.2（阈值区分）。

## 1. 开关：`config.readOnlyTestMode`

| 项目 | 值 |
| --- | --- |
| 类型 | `boolean` |
| 默认 | `false`（升级用户与正常使用不受影响） |
| 配置位置 | `src/config.ts` 的 `WechatPersonaConfig.readOnlyTestMode` 与其 schema/migrate 规则 |
| 持久化 | 通过 `POST /config` 保存后写入宿主插件配置（`cordis.patch.yml`），重启后仍生效；若宿主未提供 `configEditor` 服务则保存会返回错误（平台能力限制，不是只读模式降级） |
| 暴露 | `GET /status` 顶层 `readOnlyTestMode`、`security.readOnlyTestMode`、`status.readOnlyTestMode`；`GET /config` 的 `config.readOnlyTestMode`；`DesktopChannel.status().readOnlyTestMode` |
| 设置页 | 顶部全局 Banner + 标题栏 Badge；「安全红线」卡提供开启按钮，开启后本页不提供关闭按钮（防止误操作绕过） |

只读测试模式不是「安静模式」，也不承诺 exactly-once：它只保证**真实发送路径在代码层不可达**。

## 2. 四层硬阻断（代码层证据）

只读模式下，真实发送在四个层次分别被拒绝，任一层单独都能阻止发送：

1. **引擎层（所有发送入口共用门禁）**
   - `src/engine/engine.ts` `processInner()`：门禁通过（`validated`）后、任何外部副作用（LLM / 联网搜索 /
     消息记忆写入）之前，若 `config.readOnlyTestMode === true && channel.id !== 'mock'`，推进状态机到
     `cancelled` 并 `skip(reason='read-only-mode')` 直接返回——**真实私人聊天默认不应进入云端 LLM**；
   - `src/engine/engine.ts` `canSend()`：在 `paused/breaker` 之后、`safeMode` 之前检查
     `config.readOnlyTestMode === true && channel.id !== 'mock'`，返回 reason `read-only-mode`；
     作为二道防线覆盖发送循环（自动回复/重试）、`sendTest()`、`approveDraft()`，被拒时调用
     `recordSendBlocked()` 写 `audit type=skip reason=read-only-mode`；
   - `engine.start()` 在只读模式下先写一条 `audit type=config reason=read-only-mode`，便于验收脚本检索；
   - 启动不会因为重启而恢复真实发送：每次启动都以持久化配置为准重新执行上述检查。
2. **通道层（桌面视觉通道自己再拒绝一次）**
   - `src/channels/pc/desktop.ts` `send()` 的第一条语句就是只读判断，直接返回
     `{ ok: false, delivery: 'not-sent', error: '只读测试模式：已禁止一切真实发送…' }`；
     此时**不调用任何 PowerShell 脚本、不做任何键鼠模拟**（测试断言脚本调用数为 0）。
3. **HTTP API 层**
   - `POST /test/send` → `409`，`detail: 'read-only-mode'`，不调用 `engine.sendTest`；
   - `POST /drafts/approve` → `409`，`detail: 'read-only-mode'`，不调用 `engine.approveDraft`；
     草稿本身仍可生成、`POST /drafts/reject` 仍可用（只读模式禁的是「真实发送」，不是人工处理草稿）。
4. **PowerShell 脚本层**
   - `scripts/pwsh/wechat-uia.ps1` 新增 `-ReadOnly`（也可用环境变量 `WXUIA_READ_ONLY=1`）：
     `send` 在脚本入口直接 `Fail-With`（在找窗口之前，不点击、不粘贴、不回回车）；
     `read` 只接受 `-NoSearch`；只读模式下不恢复/移动/置顶窗口、不切换前台，
     截图被遮挡时直接拒绝而不是抢前台。

桌面通道在只读模式下会给脚本追加 `-ReadOnly -NoSearch`，因此读取不会 Ctrl+F 搜索、不会点击会话行。

## 3. 四种读取模式与副作用

只读 ≠ 无副作用。验收区分以下四类读取：

| 读取模式 | 是否会改变微信/系统状态 | 只读模式 |
| --- | --- | --- |
| ① 完全离线截图回放（合成图 / 已保存 PNG） | 无 | 允许 |
| ② 真实微信窗口被动截图（PrintWindow/屏幕截图，不点击、不切前台） | 无（仅读像素） | 允许（窗口被遮挡时拒绝而不是抢前台） |
| ③ 会主动打开会话的读取（Ctrl+F 搜索、点击会话行、悬浮预览） | 会改变已读状态、焦点、窗口层级 | **禁止**（脚本要求 `-NoSearch` 并明确报错说明） |
| ④ 会改变应用状态的自动化（发送、批准草稿、模拟回车/粘贴） | 会改变聊天内容 | **禁止**（脚本入口/通道/引擎/API 四层拒绝） |

脚本在只读模式被要求做 ③/④ 时的明确报错：

- `只读测试模式：已拒绝发送（PS1 只读模式禁止一切键鼠模拟，未执行点击/粘贴/回车提交）`
- `只读测试模式：read 需要 -NoSearch（只允许被动读取已打开的聊天；主动搜索/点击会改变已读状态与焦点，已被禁止）`
- `只读测试模式：微信窗口不可见或已最小化；恢复/显示窗口会改变窗口状态，已拒绝（请先手动打开微信窗口后重试）`
- `只读测试模式：微信窗口被遮挡，需要切换前台才能截图；已拒绝（请先手动把微信窗口置于前台再读取）`

## 4. 只读模式下的其他行为（task-22 修订）

- **真实通道下，只读模式不调用云端 LLM、不联网搜索、不写消息记忆**：引擎在门禁通过后、
  LLM/搜索/记忆之前即跳过（`skip reason='read-only-mode'`），这是对「默认诊断不得对私人聊天
  调用云端 LLM」的代码层落实；审计/配置/状态落盘仍会写入（诊断与验收所需，不含聊天正文）。
- 只读模式**不生成草稿**（只读不是 draft 模式），`sendTest`/`approveDraft` 仍会走 `canSend` 二道防线拒发。
- `mock` 通道豁免（仅空转，不会触达真实微信），便于公开 CI / 无微信环境跑验收；offline-replay 允许
  mock 通道完整跑 LLM 与发送链路。
- 消息去重与水位线（`desktop-ack.json`、`desktop-delivered.json`）继续工作，
  重启后已投递 id 不会重复投递；但只读模式不改变「不承诺 exactly-once」的总体契约。
- OCR 诊断（`status().ocr`）是只读数据：不含聊天正文，只有引擎名/耗时/计数/质量状态等。

## 5. 阈值区分：OCR 质量分 vs 双引擎相似度（任务书 4.2）

| 数值 | 归属 | 含义 | 量纲 |
| --- | --- | --- | --- |
| `CONFIDENCE_HIGH = 0.75` | `src/core/ocr/confidence.ts` | 多因子加权**规则评分**的高可信线：`accept` 才进入正常投递流程 | 规则评分（非概率、未做概率校准） |
| `CONFIDENCE_LOW = 0.45` | 同上 | 中间线：`verify`（同帧第二引擎/二次验证），低于它 `reject`（不自动投递，保留待下次） | 规则评分（非概率） |
| `0.90` | `scripts/pwsh/wechat-uia.ps1`（SecondOcr 融合） | 两引擎**文本重合度**达到该值判 `agree`（保留系统 OCR 文本） | 文本相似度 |
| `0.85` | 同上 | 第二引擎**原生 score** 达到该值才采纳其文本（覆盖系统 OCR） | 引擎原生置信度（不同模型，不可与规则分互换） |

三者不可互相替代或比较；代码注释与文档均不得把 `0.75/0.45` 描述为概率。
`confidence.ts` 的 `explain` 首行明确写「规则评分 x（非概率）」。

## 6. 已知限制（task-22 审计更新）

- `readOnlyTestMode` 的跨重启保留依赖宿主 `configEditor` 能力；宿主不支持时 `POST /config` 会报错，
  此时请用插件配置文件设置。
- **`POST /config` 本身可以关闭只读模式**：这是配置管理（管理员能力），不是未授权的发送旁路——
  关闭后仍需重启插件/重新 apply 才会加载新配置，且关闭动作会进入配置历史。威胁模型里「能改宿主配置
  的同用户进程」本就等价于管理员，无法用本插件代码防住。
- Windows 上没有可靠的 Unix `0600` 语义：`dataDir/api-token` 的权限依赖目录 ACL（默认继承用户目录 ACL），
  建议用 `icacls <dataDir>\api-token /inheritance:r /grant:r "<username>:R"` 收紧或使用独立账户运行宿主；
  代码不会自动修改 ACL（避免破坏用户环境）。
- 宿主若前置反向代理，`remoteAddress` 可能变成回环地址，只读/鉴权的「本机来源」判定会失真；
  此时应以 `config.apiToken` 强制 Bearer 作为主要凭据（在代理后仍需宿主正确传递来源头，未在本插件验证）。
- 真实微信窗口的被动截图仍可能因窗口遮挡/最小化而失败，这是有意的保守行为（宁可失败，不抢前台）。
- 脚本层只读校验通过 Windows PowerShell 5.1 `ParseFile` 与单元/集成测试验证，未在真实微信上实操
  （发布前验收禁止操作真实微信）；阈值仍需实机校准。

## 7. 四种模式定义与授权状态（任务书 §5）

| 模式 | 定义 | 会改变微信/系统状态 | 真实微信授权状态 | 本轮允许的验证方式 |
| --- | --- | --- | --- | --- |
| `offline-replay` | 只使用合成数据/已保存截图回放，不触碰微信窗口，不调用真实通道 | 无 | 不需要（默认允许） | mock 通道 + 合成 fixture + 单测/集成测试 |
| `passive-capture` | 只对「用户已明确授权的测试窗口区域」做被动截图/OCR，不点击、不粘贴、不回车、不切前台 | 仅读取像素；窗口被遮挡时拒绝 | **未授权**（需用户单独书面授权并提供专用测试账号/窗口） | 仅代码路径与脚本参数校验（未在真实微信验证） |
| `interactive-read` | 会切换会话/点击会话行/Ctrl+F 搜索/悬浮预览等可能改变已读状态与焦点的读取 | 可能改变已读状态、焦点、窗口层级 | **未授权** | 只验证「被拒绝」的代码路径（脚本 `-ReadOnly` 强制 `-NoSearch`） |
| `draft-confirm-auto` | 生成草稿/人工确认/自动回复等一切会向真实微信写入消息的模式 | 会改变聊天内容 | **未授权**（真实环境一律不授权） | mock 通道全链路 + safeMode/readOnly/sendMode 门禁测试 |

> 本轮（task-22）只在隔离本地环境用 mock / 注入式测试证明逻辑；**没有**打开真实微信、没有采集真实
> 聊天窗口、没有发送任何真实消息。上述「未授权」模式必须在用户单独授权后、按实机验收清单另行验证。

## 8. 只读模式副作用表（task-22 审计结论）

「禁止发送」不等于「无任何副作用」。下表逐项区分（✅ 允许 / ❌ 禁止 / ⚠️ 需单独授权）：

| 副作用 | offline-replay（mock） | 真实通道 + readOnlyTestMode | passive-capture | interactive-read | draft/confirm/auto |
| --- | --- | --- | --- | --- | --- |
| 向真实微信发送消息 | ❌（mock 不发真实消息） | ❌（引擎 `canSend` + 通道层 + API 409 + PS1 `-ReadOnly` 四层） | ❌ | ❌ | ❌（真实环境未授权） |
| 键鼠输入 / 回车提交 | ❌ | ❌ | ❌ | ❌ | ❌（未授权） |
| 调用云端 LLM | ✅（合成/测试联系人） | ✅ 允许 mock；**真实通道 ❌**（validated 后早退） | ❌（未授权） | ❌（未授权） | ✅（mock 验证） |
| 联网搜索 | ✅（mock 下可验证降级） | **真实通道 ❌** | ❌ | ❌ | ✅（mock 验证） |
| 写入消息记忆（`dataDir/memory`） | ✅ | **真实通道 ❌**（早退发生在记忆写入之前） | ❌ | ❌ | ✅（mock 验证） |
| 写审计日志 / 配置 / 状态（不含聊天正文） | ✅ | ✅（诊断必需） | ⚠️ 需授权范围 | ⚠️ | ✅ |
| 截图 / 像素读取 | ❌（用已存 PNG） | ❌ | ⚠️ 需授权窗口 | ⚠️ | ❌ |
| 切换会话 / 改变已读状态 / 抢焦点 | ❌ | ❌（脚本 `-NoSearch`，被遮挡不抢前台） | ❌ | ❌ | ❌ |

代码证据：`src/engine/engine.ts` `processInner()`（validated 之后、预算/搜索/LLM/记忆之前的只读早退）；
`canSend()` 的 `checkReadOnly` 分支（sendTest/approveDraft/重试）；`src/server/api.ts` `/test/send` 与
`/drafts/approve` 的 409；`src/channels/pc/desktop.ts` `send()` 首行只读判断（pipeline-fixer 实现）。

## 9. 只读绕过测试矩阵（task-22）

测试文件：`test/engine/acceptance.test.ts`（引擎层 mock 证明）、`test/server/api.test.ts`（HTTP 层）、
`test/core/persona-market.test.ts`（SSRF/DNS rebinding）。下表中的「结果」均为本地 mock 测试结论。

| 潜在绕过入口 | 期望行为 | 证据（测试 / 代码） | 结果 |
| --- | --- | --- | --- |
| 自动回复正常路径 | 真实通道不调 LLM/不发送/不写记忆 | `task-22 只读模式绕过路径审计（mock 证明）`、`发布前验收：只读测试模式`；engine `processInner` 早退 | ✅ 通过 |
| 直接 `channel.send` | 全仓仅 engine 三处（sendTest/approveDraft/自动回复），都在 `canSend` 之后 | `src/engine/engine.ts`；测试断言 `channel.sent`/`sendSignals` 为空 | ✅ 通过 |
| `POST /test/send` | 只读 409，不调 engine.sendTest | api.test `发布前验收：只读测试模式`、`task-22 ...` | ✅ 通过 |
| `POST /drafts/approve` | 只读 409，不调 approveDraft；reject 可用 | api.test 同上；acceptance 草稿队列用例 | ✅ 通过 |
| 插件工具 `wechat_persona_send_test` | 统一走 `engine.sendTest` → `canSend` | `src/tools.ts:182` → `src/index.ts:321-323` | ✅ 通过（代码路径审计） |
| 旧任务队列（deferred 重放） | 重启后 `flushDeferred` 也经 `processInner` 只读早退 | acceptance 「deferred 旧队列重放」用例 | ✅ 通过 |
| 定时器 | 无独立发送定时器；`flushDeferred` 只经由 `handleInbound` | 代码审计 | ✅ 通过 |
| 重启 + 旧状态/旧账本/旧草稿 | 只读配置持久化，重启后仍拒绝；旧账本 unknown 不补发；旧草稿不能批准 | acceptance 三条重启/旧账本/旧草稿用例 | ✅ 通过 |
| 错误参数 | 400，不会触达发送 | api.test `/test/send` 缺参 400 | ✅ 通过 |
| 配置切换组合（safeMode/sendMode/ocrPipelineMode） | 任意组合下真实通道零 LLM/零发送/零草稿 | acceptance 配置组合矩阵用例 | ✅ 通过 |
| UI 点击确认 | 批准按钮禁用 + API 409（双保险） | `client/client.js`（禁用 + title 提示）；api.test 409 | ✅ 通过（无浏览器实机验证） |
| 运行期切换 readOnly false→true | 下一条消息立即跳过 | acceptance 运行期切换用例 | ✅ 通过 |
| 重启后 resume | 只读配置持久化，resume 不恢复真实发送 | acceptance 重启用例；`canSend` 的 aborted/paused 复查 | ✅ 通过 |

## 10. 本轮未修复 / 无法在本环境消除的限制（诚实记录）

1. **DNS rebinding 的 TOCTOU 窗口**：`persona-market.ts` 已做「字符串校验 + DNS 解析后全部 IP 校验 +
   每跳重定向重新校验」，但校验与真正建连之间仍有 DNS 再次解析的时间窗。彻底消除需要连接层 IP pinning
   （自定义 `lookup`/`Agent` 或连接后校验 `socket.remoteAddress`），本轮未实现（需要替换 fetch 传输层，
   超出本轮写域且可能影响宿主网络行为），记录为 **P1 限制**；可验证修复方案见
   `docs/SECURITY-REVIEW-PRE-RELEASE.md` 第七节。
2. **`/personas/install {url}` 已统一校验**（复用 `fetchRemoteJson`：协议/内网/DNS/重定向/JSON/2MB/超时），
   但与本机 `PersonaLibrary.importJson` 的差异（例如压缩包、多文件包）不支持——只支持单个 JSON 对象。
3. **Windows ACL**：Bearer token 文件权限无法用 Unix `0600` 语义保证，需用户/部署方用 `icacls` 或独立账户
   收紧；代码不自动修改 ACL。
4. **宿主反向代理**：若宿主把外部请求以回环连接转发进来，来源判定会失真，只能依赖 `config.apiToken`
   强制 Bearer；未在真实代理环境验证。
5. **设置页无 token 输入入口**：启用 `apiToken` 后设置页自身请求需要带 Bearer，当前 UI 未提供输入框
   （迁移步骤见 `docs/SECURITY.md`），属于可用性限制而非发送旁路。
6. **真实微信未验证**：本轮全部结论来自代码审计 + mock/注入式单测；`interactive-read` /
   `passive-capture` / 真实发送模式均未在真实微信环境执行（发布前验收禁止）。

## 11. 验证命令与数字（本轮）

- `npm run typecheck` → 0 错误。
- 定向：`node --import ./test/core/sandbox-preload.mjs ./node_modules/vitest/vitest.mjs run --pool=threads
  test/engine/acceptance.test.ts test/server/api.test.ts test/core/persona-market.test.ts`
  → 3 文件 / 270 用例全部通过（acceptance 77、api 148、persona-market 45）。
- 全量：`npm run test:sandbox` 见本轮完成报告（基线 41 文件 / 678 用例）。

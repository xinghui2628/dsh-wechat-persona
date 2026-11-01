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
   - `src/engine/engine.ts` `canSend()`：在 `paused/breaker` 之后、`safeMode` 之前检查
     `config.readOnlyTestMode === true && channel.id !== 'mock'`，返回 reason `read-only-mode`；
   - 发送循环（自动回复）与 `sendTest()`、`approveDraft()` 都先调用 `canSend()`，
     被拒时调用 `recordSendBlocked()` 写 `audit type=skip reason=read-only-mode`；
   - `engine.start()` 在只读模式下先写一条 `audit type=config reason=read-only-mode`，便于验收脚本检索；
   - 启动不会因为重启而恢复真实发送：每次启动都以持久化配置为准重新进入 `canSend()` 门禁。
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

## 4. 只读模式下的其他行为

- 自动回复仍可能调用 LLM 生成文本（这不触达微信），但发送循环的 `canSend()` 会拒绝，
  `channel.send` 一次都不会调用；不会生成草稿（只读不是 draft 模式）。
- `mock` 通道豁免（仅空转，不会触达真实微信），便于公开 CI / 无微信环境跑验收。
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

## 6. 已知限制

- `readOnlyTestMode` 的跨重启保留依赖宿主 `configEditor` 能力；宿主不支持时 `POST /config` 会报错，
  此时请用插件配置文件设置。
- 只读模式不阻止 LLM 调用（只阻止真实发送）；如需完全离线，请同时断网或使用 mock 通道。
- 真实微信窗口的被动截图仍可能因窗口遮挡/最小化而失败，这是有意的保守行为（宁可失败，不抢前台）。
- 脚本层只读校验通过 Windows PowerShell 5.1 `ParseFile` 与单元/集成测试验证，未在真实微信上实操
  （发布前验收禁止操作真实微信）；阈值仍需实机校准。

# Beta 快速开始（v3.0.0-beta.1）

> 目标：在**不接触真实微信**的前提下，5 分钟走通 mock 通道，确认安装正确。
> 适用：`3.0.0-beta.1` 开发者预览。真实微信能力**未实机验收**，请以 [BETA-LIMITATIONS.md](BETA-LIMITATIONS.md) 为准。

## 1. 前置检查

| 项目 | 要求 |
| --- | --- |
| Windows | 10/11（mock 验证不需要微信；desktop 通道才需要） |
| Node.js | ≥ 22（`node -v` 确认） |
| DSH 桌面版 | 0.2.1-rc.3+ |
| PowerShell | Windows PowerShell 5.1（脚本使用 `-NoProfile`） |
| 可选 Python | 仅 RapidOCR 第二引擎/OCR 基准需要，mock 不需要 |

## 2. 获取与构建

```powershell
git clone https://github.com/xinghui2628/dsh-wechat-persona.git
cd dsh-wechat-persona
git switch feat/v3.0.0        # beta 分支；正式 beta 构建以维护者指定 commit 为准
npm ci --ignore-scripts --no-audit --no-fund
npm run build                 # 构建 dist；构建后 dist 内版本号才会显示 3.0.0-beta.1
```

先跑离线自检（不需要微信、不需要 LLM）：

```powershell
npm run typecheck
npm run test:sandbox
npm run verify:api
node scripts/check-sensitive.mjs
```

> 以上命令应在当前 beta 分支上通过；如果出现失败，请**记录完整命令与输出**再反馈，**不要在测试失败时启用真实通道**。
> beta 改动并行进行时测试/验收脚本可能短暂未同步（见 [BETA-LIMITATIONS.md](BETA-LIMITATIONS.md) 与 Release 说明）。

## 3. 以开发方式接入 DSH（干净 profile 演练）

在 DSH 的 profile 配置里把本仓库作为本地插件链接进来（路径用你自己的绝对路径）：

1. 打开 DSH 的 profile 目录（本机自定；可用 `plugin_manager` 工具查看）。
2. 在 profile 的 `package.json` → `dependencies` 增加：`"dsh-wechat-persona": "link:<本仓库绝对路径>"`。
3. 在 `dsh.profile.bundles` 数组增加 `"dsh-wechat-persona"`。
4. 重启 DSH；设置页应出现「微信分身」。
5. 若宿主无 configEditor，设置页为只读属正常（由宿主能力决定）。

> **练手建议**：用一个新的/干净的 profile 做 beta 验证，不要直接在你日常 profile 上开启真实通道。

## 4. 五分钟 mock 走通

1. 设置页 → 微信分身 → 通道选 `mock`。
2. 白名单只加一个**虚构**联系人（如 `张三`；不要用真实好友）。
3. 启动插件；确认 `/status` 里 `channel= mock`、`paused=false`、`betaSafeMode` 相关保护开启（beta 构建应为默认安全）。
4. 注入入站消息（`<DSH端口>` 换成你本机 DSH 的端口）：

```bash
curl -X POST http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api/test/inbound \
  -H "x-dsh-wechat-persona: 1" -H "Content-Type: application/json" \
  -d "{\"text\":\"在吗\",\"contactId\":\"张三\"}"
```

5. 查看结果：`GET /status`；`<dataDir>/outbox.jsonl`（mock 发送记录）；`<dataDir>/audit.jsonl`（审计事件）。
6. 草稿模式演练：设置 `sendMode=draft` → 再注入一条 → `GET /drafts` → `POST /drafts/approve`（或 `/drafts/reject`）。
7. 暂停/恢复：`POST /pause` 后注入应被跳过并（视配置）暂存；`POST /resume` 恢复。

## 5. 诊断与日志

- `GET /diagnostics/ocr`：只读 OCR 诊断（引擎/行数/冲突数/耗时等元数据，**不含聊天正文**）。
- `GET /status`：通道状态、暂停、预算、`sendMode`、`pendingDrafts`、`readOnlyTestMode`/安全模式等。
- 日志：`%TEMP%\dsh-wechat-persona-debug.log`（插件启动）、`%TEMP%\wxuia-engine-debug.log`（桌面脚本 OCR/点击，仅 desktop 通道）。
- 数据目录：`<dataDir>`（默认 `<工作区>/.dsh-wechat-persona/`），文件清单见 [PRIVACY.md](PRIVACY.md)。

## 6. 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 设置页空白/404 | API 未挂载或插件未加载 | 看启动日志；确认版本/重载插件；缺请求头时返回 403 而非 404 |
| `GET /status` 403 | 缺少 `x-dsh-wechat-persona: 1` 或非回环访问 | 加上请求头，只从本机访问 |
| 修改代码不生效 | 运行的是旧 `dist` | `npm run build` 后重载插件 |
| 草稿批准 409 | 已被处理/门禁拒绝/只读或安全模式 | 看返回 `error` 与 `detail`；beta 默认安全模式会拒绝真实发送 |
| mock 收不到回复 | 白名单/时段/频次/预算/去重拦截 | 看 `audit.jsonl` 的 skip reason，排查见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

## 7. 升级、备份与卸载

- **升级**：拉取新代码 → `npm ci --ignore-scripts` → `npm run build` → 重载插件/重启 DSH。升级前备份 `<dataDir>`（含记忆）。
- **卸载**：从 profile `dependencies` 与 `dsh.profile.bundles` 移除本插件 → 重启 DSH。是否删除 `<dataDir>` 由你决定（删除=清空记忆/审计/草稿/账本，**不可恢复**）。
- **回滚**：切回 `v0.2.8` tag（见 [MIGRATION-v3.md](MIGRATION-v3.md) §8）→ 构建 → 重启 → 用升级前备份恢复数据。
- **不要**删除或手改正在使用的数据目录，除非你确认不需要历史记忆。

## 8. 反馈

- 先搜 Issue；提交时用模板，提供版本/环境/复现步骤/mock 结果，并**脱敏**（不要贴真实好友名、wxid、手机号、聊天截图、API Key、含用户名的完整路径）。
- 安全问题请走私密披露（见 [../SECURITY.md](../SECURITY.md)）。

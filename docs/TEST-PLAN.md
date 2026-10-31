# 测试计划（TEST-PLAN）

目标：用可复现的分层测试，保证「收到白名单好友消息 → 分身 5–8 秒内回复且不骚扰、不发错人」。

## 0. 测试环境前提
- Windows 10/11，微信 PC 4.x，DSH 桌面版（0.2.1-rc.x）。
- DSH 插件页已启用本插件，通道 `desktop`，白名单 2–3 人。
- 微信主窗口保持打开（可被最小化，但不要退出登录）；**不要**在测试时手动点微信。
- 关闭微信「搜一搜/搜索聊天记录」独立窗口，避免遮挡会话列表。

## 1. 分层策略
| 层级 | 频率 | 条数 | 目的 |
|---|---|---|---|
| L1 环境自检 | 每次改动 | 1 | `scripts/pwsh/selfcheck.ps1` 全绿 |
| L2 脚本单测 | 每次改脚本 | 3–5 | list / read / send 三条命令直接跑 |
| L3 注入端到端 | 每次改代码 | 3 | `/api/test/inbound` 注入 → 看 llm+send 事件 |
| L4 真实好友回归 | 每天 | 10–15 | 真人对发，统计成功率/延迟 |
| L5 压力测试 | 发布前 | 100 | 连续注入 + 混合真实消息，统计 P50/P95 |

## 2. 必查场景（每次发布）
1. 正常回复：好友发「在吗」→ ≤8s 回复，内容符合人格。
2. 多人群发：两人先后发消息 → 各回各的，无串聊。
3. 重复消息：同一条消息不应被回复两次（幂等/去重）。
4. 自己发的消息：分身不会回自己的消息（自问自答检测）。
5. 用户正在用电脑：`userActivityIdleMs` 内不发消息（让路），空闲后补发。
6. 微信窗口被最小化：能自动恢复/识别，仍能回复。
7. 窗口被其它程序抢占：拒绝发送（`ok:false`），不点错窗口。
8. 白名单外联系人：不回复（skip 记录 `not-whitelisted`）。
9. 在线时段外：不回复（skip 记录 `offline`）；到点自动上线。
10. 预算/限流：超预算转草稿或 skip（`budget-*`/`rate-*`），不崩溃。
11. 微信退出登录：engine 进 degraded，重新登录后重载插件可恢复。
12. 重启 DSH/重载插件：配置保留、白名单不丢、不重复回复历史消息。

## 3. 验收指标（发布门槛）
- 成功率 ≥ 95%（成功回复数 / 应回复数）。
- 延迟 P95 ≤ 8s（从消息到达列表可见 → 发送成功，取 audit 时间差）。
- 错发 0（reply 的 contactId 必须等于消息源）。
- 崩溃/卡死 0；出现 degraded 后可人工重载恢复。
- 连续 100 条压力测试无重复回复、无串聊。

## 4. 如何采集指标
- 审计日志：`%USERPROFILE%\.dsh\profiles\desktop\.dsh-wechat-persona\audit.jsonl`
  - `llm.durationMs`（生成）+ `send.durationMs`（发送）+ `skip.reason`（未回原因）
- 脚本调试日志：`%TEMP%\wxuia-engine-debug.log`（OCR/点击细节）
- 插件 API：`GET /status`、`GET /logs`（需 `x-dsh-wechat-persona: 1`）

统计脚本（示例，PowerShell）：
```powershell
$audit = "$env:USERPROFILE\.dsh\profiles\desktop\.dsh-wechat-persona\audit.jsonl"
Get-Content $audit | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object type -in 'llm','send','send-fail','skip' |
  Group-Object type | Select-Object Name,Count
```

## 5. 回归记录模板
| 日期 | 版本 | 场景 | 应回 | 实回 | 成功率 | P50 | P95 | 错发 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| | | L3 注入 | 3 | | | | | 0 | |

## 6. 已知限制（写进 README）
- 仅 Windows + PC 微信；手机/云手机通道见 `docs/CHANNELS.md`。
- OCR 对形近字/绿色选中行较弱，已用「行坐标 + 当前会话」快路径规避；偶发需 read 兜底。
- 表情包发送在 desktop 通道暂不支持（返回明确错误）。
- 微信主窗口极小/被遮挡时，自检会尝试恢复，仍失败则 degraded。

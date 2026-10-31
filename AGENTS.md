# AGENTS.md — dsh-wechat-persona 开发规则（给 AI/贡献者）

## 项目是什么
DSH（DeepSeek Harness）插件：把你自己的微信小号变成有「人格」的 AI 聊天分身。
被动回复白名单好友、拟人节奏、表情包、按需联网搜索、严格 token 预算与防封熔断。

仓库结构：
- `src/` TypeScript 源码（通道、引擎、人格、服务端 API、配置 schema）
- `client/` 设置页 Web 前端（纯 JS，无需构建）
- `scripts/pwsh/` Windows 自动化脚本（UTF-8 **必须带 BOM**，PowerShell 5.1 运行）
- `docs/` 文档（使用说明 / 通道 / 验收 / 架构 / 测试计划）
- `dist/` 构建产物（tsc 输出；**本仓库不提交 dist**，安装/发布前执行 `npm run build`；运行中的 DSH 需重载插件才会加载新代码）

## 硬性约束（违反会破坏用户环境）
1. **只改本仓库目录**，不碰用户其它文件、系统设置、代理/证书、微信数据目录。
2. 删除任何文件前先改名为 `*.bak-<时间>`；不执行 `rmdir /s`、`del /s` 之类批量删除。
3. `.ps1` 文件写入必须 UTF-8 **带 BOM**；禁止用 PowerShell 5.1 的
   `Get-Content | -replace | Set-Content` 做文本替换（会按 GBK 读坏 UTF-8 中文）。
   改脚本用 `edit` 工具或 Python（显式 `encoding='utf-8'`）。
4. 不在日志、文档、示例中写真实好友名字、wxid、token；个人数据目录：
   `%USERPROFILE%\.dsh\profiles\desktop\.dsh-wechat-persona\`（不要提交）。
5. 自动化**宁可失败也不发错人**：发送前必须能定位聊天（当前会话或会话行坐标）；
   任何不确定情况返回 `{ok:false,error:...}`，不允许盲目搜索后发送。

## 开发流程
1. 改代码 → `npm run typecheck` → `npm run build`。
2. 改 `client/` 时直接在 DSH 插件页刷新即可；改 `src/` 后需要重载插件
   （DSH → 插件 → 本插件开关 关 2 秒再开），否则运行的是旧 dist。
3. 改完必须更新 `CHANGELOG.md`；过程记录放本地 `dev-notes/`（不入库）。
4. 提交前跑 `npm run test:sandbox`（若环境支持）；真实微信测试用
   `/dsh-wechat-persona/api/test/inbound` 注入，避免骚扰好友。

## 调试入口（本机）
- 插件 API 基址：`http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api`
  必带请求头 `x-dsh-wechat-persona: 1`；POST /config 需 `{"config": ...}` + UTF-8 字节。
- 引擎脚本调试日志：`%TEMP%\wxuia-engine-debug.log`（每次自动化调用的 OCR/点击记录）。
- 插件启动日志：`%TEMP%\dsh-wechat-persona-debug.log`。
- 审计日志：`dataDir/audit.jsonl`（llm / send / skip 事件，含耗时与原因）。

## 常用命令
```powershell
npm run typecheck      # tsc --noEmit
npm run build          # tsc -p tsconfig.json → dist/
npm run test:sandbox   # 沙箱测试（推荐）
powershell -File scripts/pwsh/selfcheck.ps1   # 一键环境自检（JSON+人话）
```

## 诊断与错误码
- 一键自检：`powershell -ExecutionPolicy Bypass -File scripts/pwsh/selfcheck.ps1 [-Port <DSH端口>]`，输出 JSON + 人话结论；退出码 0=通过，1=critical 失败。
- 脚本层统一返回 `{ok:true,...}` / `{ok:false,error:"<中文原因>"}`，`send` 失败时 `error` 即错误原因（如「无法确认目标聊天窗口，已拒绝发送以避免发错人」「缺少聊天定位信息」「输入框未清空」）。
- 常见失败定位顺序：先看脚本返回的 `error`，再看 `%TEMP%\wxuia-engine-debug.log`（OCR/点击/REGION 日志），最后看 `dataDir/audit.jsonl`（skip reason / llm / send 耗时）。
- 已知错误语义见 `docs/CHANNELS.md`「失败与降级」与 `docs/ACCEPTANCE.md`。

## 发布规则
- 版本语义：修 bug → patch；行为/配置变更 → minor；破坏兼容 → major。
- 发布前：README 安装说明可用、`docs/ACCEPTANCE.md` 全部勾选、
  清理个人数据（dataDir 不打包）、CHANGELOG 写好。
- 不代用户发布到 npm/GitHub；由维护者手动执行并在 CHANGELOG 记录。

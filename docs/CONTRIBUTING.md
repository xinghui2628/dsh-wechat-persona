# 贡献指南（dsh-wechat-persona v3.0.0）

本文件面向要改代码、改脚本、改文档的贡献者。仓库**不是**一个通用聊天机器人，而是「把用户自己的微信小号变成有人格的 AI 聊天分身」的 DSH 插件，所有自动化操作都发生在本机 Windows 桌面上。改动前请先读：

- [README.md](../README.md)：功能、边界、安装与配置
- [docs/ARCHITECTURE.md](ARCHITECTURE.md)：真实代码结构
- [docs/SECURITY.md](SECURITY.md)：威胁模型与 API 鉴权
- [AGENTS.md](../AGENTS.md)：仓库级硬性约束（与本文冲突时以 AGENTS.md 为准）

> 仓库 `package.json` 标记 `"private": true`，**不公开发布、不发布到 npm、不对外提供下载**。贡献者不要执行 `npm publish`，也不要 `git push` 到远端；提交与发布由维护者统一处理。

## 1. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10 / 11（桌面通道必需） | 纯逻辑与单元测试可在其他系统跑，但桌面通道依赖 PowerShell + UIA + WinRT OCR |
| Node.js | ≥ 22（`engines.node`） | 与 DSH 宿主一致 |
| npm | 随 Node 自带 | 依赖安装用 `npm install --ignore-scripts`，不要依赖 postinstall |
| PowerShell | Windows PowerShell 5.1 | `scripts/pwsh/*.ps1` 只保证 PS 5.1 兼容，不写 PowerShell 7 专属语法 |
| 微信 | PC 版 4.x（仅桌面通道联调时需要） | 不要求贡献者用自己的微信做发送测试 |
| OCR | Windows 中文（简体）OCR 语言包 | WinRT OCR 依赖；没有语言包时只能跑单元测试与 mock 通道 |

## 2. 第一次拉取与构建

```powershell
git clone <仓库地址> dsh-wechat-persona
cd dsh-wechat-persona
npm install --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run test:sandbox
npm run build
```

- 本仓库**不提交 `dist/`**，运行中的 DSH 加载的是 `dist/`，因此改 `src/` 后必须 `npm run build` 并重载插件。
- 只改 `client/`（设置页前端）时不需要构建，在 DSH 设置页刷新即可。
- 不要把个人数据、日志、截图、`dev-notes/`、`.dsh-tmp/`、`backups/` 提交进仓库（这些目录已被 `.gitignore` 忽略）。

## 3. 目录结构（改哪里）

```text
src/
  index.ts            插件入口：配置迁移、数据目录、服务与工具注册
  types.ts            跨模块公共类型（SendResult 三态投递等）
  config.ts           Schemastery 配置 schema、默认值、旧配置迁移
  engine/            回复引擎：门禁、生成、拟人延迟、发送、暂存补处理、摘要
  channels/          通道实现：mock / phone-adb / windows-vm / pc(desktop)
  core/              纯逻辑：gate、budget、rate-limit、breaker、memory、audit、
                     OCR 纯模块（core/ocr/*）等
  llm/               LLM 客户端、prompt、联网搜索
  server/api.ts      设置页与自动化用的本机 HTTP API
  tools.ts           6 个运维工具（wechat_persona_*）
client/client.js     设置页（纯 JS，无需构建）
scripts/pwsh/        Windows 自动化（wechat-uia.ps1 等，UTF-8 带 BOM）
scripts/ocr/         离线 OCR 基准（bench.mjs / engines.mjs / baseline-v028.mjs）
scripts/            敏感信息扫描、API 验证、VM agent 等
test/               Vitest 用例与 OCR 合成语料（test/fixtures/ocr-corpus）
docs/               设计、验收、基准、迁移、排障等文档
```

改动落点建议：

- 纯业务逻辑（阈值、判定、格式化）优先放 `src/core/`，保持无副作用、可单测。
- OCR 相关的纯函数必须放 `src/core/ocr/`（`types` / `geometry` / `normalize` / `correction` / `vote` 等），`src/channels/pc/desktop.ts` 只做编排与 I/O。
- 发送门禁只允许有一个入口：`src/engine/engine.ts` 的 `canSend()`。不要在通道层另开「绕过门禁直接发」的路径。
- 桌面通道的 PowerShell 脚本接口是契约：`scripts/pwsh/wechat-uia.ps1` 向 stdout 输出**单行 JSON**，TypeScript 侧按 `src/channels/pc/desktop.ts` 的解析逻辑读取。改脚本返回结构时必须同步改 TS 与测试。

## 4. 常用命令

```powershell
npm run typecheck        # tsc --noEmit，必须 0 错误
npm run test:sandbox     # 推荐：沙箱兼容的完整测试（npm test 的受限环境版本）
npm run test             # 普通环境等价跑法
npm run build            # tsc emit 到 dist/
npm run check:sensitive  # 敏感信息扫描（0 命中、exit 0 才算过）
node scripts/check-sensitive.mjs   # 同上，直接跑脚本
npm run verify:api       # 离线验证本机 API（真实 dist + 假宿主，不碰 DSH 进程）
npm run verify:all       # 组合验证（以 package.json 为准）
powershell -ExecutionPolicy Bypass -File scripts/pwsh/selfcheck.ps1   # 一键环境自检
```

测试基线：提交前 `npm run test:sandbox` 必须全绿，且**用例数只增不减**。新增纯逻辑要配 `test/core/*.test.ts`；新增通道行为要配 `test/channels/*.test.ts`；新增 API 行为要配 `test/server/api.test.ts`。

### 4.1 离线 OCR 基准（可选）

```powershell
node scripts/ocr/bench.mjs --engine=winrt --limit=1 --scenario=clear --pipeline=raw
node scripts/ocr/bench.mjs --engine=all --limit=40 --out-dir=test/fixtures/ocr-corpus/results
```

- 基准只读 `test/fixtures/ocr-corpus/images` 下的**合成图**，不截图、不启动微信、不联网。
- WinRT 结果需要 Windows OCR 语言包；RapidOCR 结果需要 Python + `rapidocr_onnxruntime` + Pillow。
- 环境不满足时 bench 会打印警告并让对应结果失败；CI 中的 bench 冒烟会在探测到环境缺失时**显式 marked skip**，不算失败。
- 改动 OCR 后处理逻辑时，用同一套语料对 v0.2.8 baseline 与 v3 方案跑 A/B，禁止只改数字不跑证据。当前基准数字见 [docs/OCR-BENCHMARK.md](OCR-BENCHMARK.md)。

## 5. 编码约定

### TypeScript

- 开启严格模式，**禁止** `// @ts-nocheck`、`// @ts-ignore` 和 `as any` 绕过类型检查；确实无法建模的边界数据在模块入口做一次 `unknown` → 显式校验（见 `src/core/ocr/types.ts` 的领域类型）。
- 对外部输入（配置文件、脚本 stdout、HTTP body、人格 JSON）一律按不可信数据处理：先校验、再使用，错误信息回中文原因，不把原始值直接拼进日志。
- 时间、随机、文件系统尽量通过依赖注入（`src/index.ts` 装配时钟/随机），便于测试。
- 注释用中文，解释**为什么**而不是复述代码；涉及安全决策的代码（门禁、重试、去重）要有简短理由注释。

### PowerShell

- `scripts/pwsh/*.ps1` 必须是 **UTF-8 带 BOM**（前 3 字节 `EF BB BF`），否则 PS 5.1 会把中文读坏。
- 修改前先把原文件改名为 `*.bak-<yyyymmddHHMMSS>`，不要直接删除；改完做一次 PS 5.1 语法检查（parse errors = 0）。
- **禁止**用 PS 5.1 的 `Get-Content | -replace | Set-Content` 做文本替换（按 GBK 读 UTF-8 会坏中文）。用 `edit` 工具，或用 Python 显式 `encoding='utf-8-sig'` 读写。
- 脚本层统一返回 `{ok:true,...}` / `{ok:false,error:"<中文原因>"}`；发送结果需要三态时带 `delivery: "sent" | "not-sent" | "unknown"`。
- 自动化宁可不发也不能发错人：定位不到聊天（没有会话行坐标）时必须 `ok:false`，不允许盲目搜索后发送。

### 数据与隐私（提交前必查）

- 代码、注释、文档、测试夹具里**不得出现**真实好友名、wxid、手机号、邮箱、API key/token、本机绝对路径（`C:\Users\<用户名>\...`）、真实微信截图。示例一律用虚构值：`张三` / `李四` / `wxid_alice` / `13800000000` / `<dataDir>`。
- 新增文档或夹具后跑 `node scripts/check-sensitive.mjs`，0 命中且 exit 0 才能提交。
- 测试只允许使用合成语料（`test/fixtures/ocr-corpus`）与假通道（`test/core/fakes.ts`），不要用真实聊天记录做夹具。

## 6. 提交与分支

- 分支：从 `main`（或当前开发分支）切 `feat/<主题>`、`fix/<主题>`、`docs/<主题>`；不直接在 `main` 上开发。
- 提交信息：Conventional Commits，中文 subject 即可，例如：
  - `fix(engine): 暂停后不再重发 unknown 结果`
  - `docs(readme): 补齐 v3.0.0 配置表`
  - `test(ocr): 增加同帧 captureId 用例`
- 每个提交聚焦一件事；格式化/重排与功能改动分开提交。
- **不要**自行 `git push`、打 tag、创建 Release、改仓库可见性（`private:true` 保持不变）。

## 7. Pull Request 检查清单

提交 PR 前逐条自查（并在 PR 描述里贴出真实输出，不要只写"已通过"）：

- [ ] `npm run typecheck` 0 错误
- [ ] `npm run test:sandbox` 全绿，用例数不少于基线（当前基线：**43 文件 / 725 用例**，2026-11-01 实测；以你本地输出为准）
- [ ] `node scripts/check-sensitive.mjs` 0 命中（exit 0；2026-11-01 实测扫描 222 个受跟踪文本文件，0 命中）
- [ ] `node scripts/check-package.mjs` 0 违规（发布相关改动时必跑）
- [ ] `npm run build` 成功（若改了 `src/`）
- [ ] 改了 `scripts/pwsh/*.ps1`：UTF-8 BOM、PS 5.1 语法检查通过
- [ ] 新增/修改的行为有对应用例；修复 bug 时先加失败用例再修
- [ ] 没有提交 `dist/`、`dev-notes/`、`.dsh-tmp/`、`backups/`、日志、截图、个人数据
- [ ] 文档与代码一致：涉及配置项、API、错误文案的改动同步更新 README / docs
- [ ] 没有引入绕过发送门禁、跳过白名单、忽略暂停/熔断的代码路径

CI（`.github/workflows/ci.yml`）会在 Windows 上跑上述门禁，并在 Ubuntu 上跑类型检查与敏感扫描；WinRT OCR 冒烟在 Linux 或无 OCR 语言包时显式 marked skip。

## 8. 调试入口

| 用途 | 位置 |
| --- | --- |
| 插件启动日志 | `%TEMP%\dsh-wechat-persona-debug.log` |
| 引擎/OCR/点击调试日志 | `%TEMP%\wxuia-engine-debug.log` |
| 审计日志（llm / send / skip） | `<dataDir>\audit.jsonl` |
| 运行时状态（暂停、熔断、预算、频控） | `<dataDir>\state.json` |
| 草稿（v3 待批准队列） | `<dataDir>\drafts.json` |
| 草稿（旧追加记录，兼容） | `<dataDir>\drafts.jsonl` |
| 发送幂等账本 | `<dataDir>\send-ledger.json` |
| 桌面通道 ack 水位线 | `<dataDir>\desktop-ack.json` |
| 暂停期间暂存的入站消息 | `<dataDir>\deferred-inbound.json` |
| 设置页 API 基址 | `http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api`（需带请求头 `x-dsh-wechat-persona: 1`） |

排障流程与常见错误见 [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md)。API 鉴权细节见 [docs/SECURITY.md](SECURITY.md)。

## 9. 发布相关（维护者）

贡献者不需要发布。维护者发布前按下述文件逐条执行：

- [docs/RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)：v3.0.0 发布门槛 10 条逐条证据
- [docs/MIGRATION-v3.md](MIGRATION-v3.md)：0.2.8 → 3.0.0 迁移与回滚
- [docs/RELEASE-GUIDE.md](RELEASE-GUIDE.md)：历史公开发布指南（本仓库为 `private:true`，仅作流程参考，不实际公开发布）

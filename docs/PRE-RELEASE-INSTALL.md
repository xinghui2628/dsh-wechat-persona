# 发布前安装与迁移验收（v3.0.0，干净模拟环境）

本文记录 v3.0.0 发布前（任务书第十一部分）在**本机、离线、干净临时目录**中完成的安装包 / 安装 / 配置迁移 / mock 与草稿模式 / 版本一致性验收。

> 结论先行：**发布包内容、包结构、版本、配置迁移、mock 启动与草稿模式均通过**；但存在 3 个明确限制——
> ①真实 DSH profile 安装与真实微信环境**未验证**（用户未授权，本轮也不应触碰）；
> ②工作树在验收期间有其他队友并行修改，**当前 `dist/` 构建早于 `readOnlyTestMode` 集成**，
> 因此只读模式相关行为**待最终代码重建后复验**；
> ③`npm install <tarball>` 在离线环境下因依赖未命中缓存而失败（网络限制），改用「解包 + 复用宿主依赖」模拟安装并验证通过。

## 0. 验收快照

| 项目 | 值 |
| --- | --- |
| 验收日期 | 2026-11-01 10:35–10:50（Asia/Shanghai） |
| 仓库 | `dsh-wechat-persona`（分支 `feat/v3.0.0`） |
| HEAD | `c05a24a`（验收开始时工作树干净；验收期间其他队友开始改代码） |
| 本地提交数 | `git rev-list --count HEAD` = **39** |
| tag | `v0.2.3`、`v0.2.8`（回退目标 tag 存在） |
| 版本 | `package.json` / `src/index.ts` / `dist/index.js` 均为 **3.0.0** |
| 工作树漂移 | 验收过程中出现 6 个修改文件 + 3 个未跟踪文件（详见 §9.3），全部为其他队友/Lead 的并行工作；本验收未改动任何 `src/**`、`scripts/**` |
| 工具链 | Node **v26.13.0**、npm **11.20.0**、Windows 11 本机 |
| `dist/` 构建时间 | 2026-11-01 10:33:26（**早于** 10:39 后对 `src/config.ts`、`src/engine/engine.ts`、`src/server/api.ts` 的只读模式改动） |
| 数据目录 | 全程使用系统临时目录，验收后已清理；未接触用户真实 dataDir |
| 网络 | 全程未访问外网；`npm install` 使用本地 tarball + `--offline` |

> ⚠️ 由于 `dist/` 未在最终代码上重建，本报告中的「安装包」与「mock/草稿」验证反映的是 **10:33:26 构建产物**；
> 发布前必须在最终代码上 `npm run build` 后重跑本清单（尤其 §5.3 的只读模式复验）。

## 1. 方法与边界

- 只读验收：不 commit、不 push、不 tag、不创建 Release、不改写历史；**只新增本文档**。
- 不碰真实微信：mock 通道 + 假宿主 + 真实 `dist` 代码；入站消息用 `POST /test/inbound` 注入。
- 不安装新依赖：仅使用仓库已有 `node_modules` 与本地 tarball；`npm pack` / 本地 tarball 视为打包而非依赖安装。
- 临时目录：`%TEMP%\dsh-v3-pkg-verify-*`、`%TEMP%\dsh-v3-sim-*`、`%TEMP%\dsh-v3-install-*`、`%TEMP%\dsh-v3-head-clone-*` 均已用后清理；
  临时验收脚本（草稿模式 harness）也已删除，其命令与输出见 §6.2、附录 A。
- 说明：真正「干净机器」需要一台无本仓库 `node_modules`、无微信、可联网或带完整 npm 缓存的机器；本机只能做到
  「干净临时目录 + 离线依赖复用」的模拟，限制见 §9。

## 2. 逐项结果总表

| # | 验收项 | 命令 / 方法 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 发布包内容检查（仓库口径） | `node scripts/check-package.mjs` | **PASS** | 候选 181 文件，0 违规；1 条警告（7 个 gitignore 垃圾，仅警告不阻断） |
| 2 | npm 打包内容（dry-run） | `npm pack --dry-run --json` | **PASS（有警示）** | 188 文件、762,683 B（打包后）/ 2,339,176 B（解包后）；含 7 个被 `.gitignore` 忽略的调试垃圾 → 发布包**不应**直接 `npm pack` |
| 3 | 实际打包 + 解包核对 | `npm pack` → 解包到临时目录 | **PASS** | 188 文件 / 2,339,176 B，与 dry-run 一致；`version=3.0.0`、`private=true`；dist 106 文件（53 `.js` + 53 `.d.ts`）；无 `node_modules`、无运行时数据、无 `.env`、无截图 |
| 4 | 干净目录模拟安装 | 解包到临时 `node_modules/` + 复用宿主依赖后 `import` | **PASS（模拟）** | `import dist/index.js` 成功：`name=dsh-wechat-persona`、`provide=["wechatPersona"]`、`apply`/`migrateConfig` 可用；`node --check client/client.js` PASS |
| 4b | 真正 `npm install <tarball>`（离线） | `npm install <tarball> --offline` | **限制** | `ENOTCACHED`：依赖 `@deepseek-ai/schemastery` 未在本机 npm 缓存；未联网重试，符合本轮约束 |
| 5 | 配置迁移（v0.2.8 → v3.0.0） | `npx vitest run test/core/config-migration.test.ts` | **PASS** | 10/10 用例通过 |
| 5b | 迁移字段探针（dist 构建） | 直接 import `dist/config.js` 调用 `migrateConfig()` | **PASS** | `sendMode='auto'`、`safeMode=false`、`onboardingDone=false`、`apiToken=''`；旧字段与未知字段保留；二次迁移幂等 |
| 5c | 迁移字段探针（工作树源码） | 直接 import `src/config.ts` 调用 `migrateConfig()` | **PASS（未进 dist）** | 追加 `readOnlyTestMode=false`（默认关闭）、`ocrPipelineMode='v3'` 迁移；见 §5.3 与任务书预期差异 |
| 6 | mock 启动 + API 冒烟 | `npm run verify:api`（假宿主 + 真实 dist + 真实 HTTP 端口） | **PASS** | 25/25 项通过（鉴权 403、health、status、config、日志、人格、市场、表情、help、test/send 成功、频控拒绝、test/inbound、pause/resume、404） |
| 7 | 安全草稿模式（sendMode=draft） | 临时 harness（同 verify-api 思路，见 §6.2） | **PASS** | 13/13 项通过：草稿生成但不发送、批准后才发送、重复批准 409、不存在 404 |
| 7b | 只读测试模式（readOnlyTestMode）行为 | 源码已接线、`dist` 未重建 | **未验证（待集成后复验）** | 见 §9.2 |
| 8 | 卸载步骤 | 文档化（不实际卸载用户 profile） | **文档完成 / 未实机执行** | 见 §7.1 |
| 9 | 回退 v0.2.8 | 文档化（不实际切换版本） | **文档完成 / 未实机执行** | tag `v0.2.8` 存在；见 §7.2 |
| 10 | 版本一致性 | 三处比对 | **PASS** | `package.json` / `src/index.ts:83` / `dist/index.js:41` 均 `3.0.0`（实际行号 83，非任务书早前记录的 82） |
| 11 | 隐私文件不带入包 | 解包文件遍历 + 内容检查 | **PASS** | 无 `.env`、`state.json`、`*.log`、截图、`audit*.jsonl` 等运行时数据；图片仅 18 张内置表情 |
| 12 | 敏感信息扫描 | `node scripts/check-sensitive.mjs` | **HEAD PASS；工作树的 2 处误报已在本轮最终复核前修复（最终 212 文件 0 命中）** | 干净 clone（HEAD `c05a24a`）扫描 203 个受跟踪文本文件 **0 命中**；当前工作区因队友未提交的 SSRF 测试夹具命中 2 处（非本文档、不在我的写域），见 §9.4 |

## 3. 发布包内容核对

### 3.1 仓库口径：`check-package.mjs`

```text
$ node scripts/check-package.mjs
候选文件：181 个
[check-package] 警告（1 条，不阻断）：
  ! 发现 7 个本地忽略垃圾（不会进入 git 发布包；但用 npm pack 直接从开发目录打包会带进去…）
[check-package] 结论：通过。发布包内容干净（private 仓库，不发布 npm）。
exit 0
```

- 校验内容：`private:true`、无 `publishConfig`、`main`/`types` 产物存在、`dist/` 非空、无运行时数据/日志/备份/截图、
  敏感串扫描（本机路径/手机号/邮箱/wxid/密钥）。
- 7 个垃圾文件（仅警告）：`scripts/pwsh/wechat-uia.ps1.bak-*` ×3、`scripts/dev/__pycache__/*.pyc` ×2、
  `scripts/ocr/__pycache__/*.pyc` ×1、`scripts/py/__pycache__/*.pyc` ×1。

### 3.2 `npm pack --dry-run --json`

| 指标 | 值 |
| --- | --- |
| 包名 / 版本 | `dsh-wechat-persona` `3.0.0`（`private:true`） |
| 文件数 | **188** |
| tarball 大小 | **762,683 B**（约 745 KiB） |
| 解包大小 | **2,339,176 B**（约 2.23 MiB） |
| dist 产物 | 106 文件（53 `.js` + 53 `.d.ts`，与 `src/**/*.ts` 的 53 个源文件一一对应） |
| `node_modules` | 未打入（依赖声明在 `package.json`，由安装方解析） |

内容分组（按 188 个文件统计）：

| 分组 | 文件数 | 说明 |
| --- | --- | --- |
| `dist/` | 106 | 运行时代码 + 类型声明 |
| `docs/` | 20 | 全部文档（含本文件所在目录，安装后可通过 `GET /help` 读取使用说明） |
| `scripts/` | 28 | 含运行时脚本、OCR/验收脚本；**也包含 `scripts/dev/*.py` 开发探针脚本**（受 git 跟踪、敏感扫描 0 命中，但非运行必需，可按需修剪） |
| `stickers/` | 18 | 内置表情 PNG（唯一图片类内容） |
| `personas/` + `persona/` | 6 | 4 个内置人格 + 旧版 persona 模板 |
| `locale/` | 2 | 中/英文案 |
| `client/` | 2 | 设置页（纯 JS，无需构建） |
| 根文件（npm 默认随包） | 4 | `package.json`、`LICENSE`、`README.md`、`CHANGELOG.md` |
| 根文件（`files` 字段显式声明） | 2 | `cordis.patch.yml`、`icon.svg` |

> 计数口径说明：以上为打包时快照。**本文件**（`docs/PRE-RELEASE-INSTALL.md`）在打包时尚未被 git 跟踪，
> 因此未计入 181/188；它被提交后 `check-package` 候选数 +1（182），`npm pack` 文件数 +1（189）。

**发现（警示，不阻断）**：`npm pack` 会把 `scripts/` 下 7 个被 `.gitignore` 忽略的调试垃圾一并打入
（3 个 `*.bak-*` + 4 个 `__pycache__/*.pyc`）。因此发布包应按
[RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) §6.4 用「git 受跟踪文件 + 本次 `dist/` 构建产物」制作，
**不要直接分发 `npm pack` 产物**；预期干净包文件数 = `check-package` 候选 **181**（= 188 − 7）。

### 3.3 实际打包与解包核对

```powershell
npm pack --pack-destination <临时目录>
tar -xzf dsh-wechat-persona-3.0.0.tgz -C <临时目录>   # 解包为 package/...
```

| 检查项 | 结果 |
| --- | --- |
| tarball SHA256 | `dc44d76802bc0ca811d315da7933c6b22b25cc6ee0262cb3797b8ec4160714e0`（**仅本次构建，非发布值**） |
| 解包文件数 / 字节数 | 188 / 2,339,176（与 dry-run 完全一致） |
| `package/package.json` | `name=dsh-wechat-persona`、`version=3.0.0`、`private=true`、`main=dist/index.js`、`types=dist/index.d.ts`、`files` 12 项、`engines.node>=22` |
| 关键产物 | `dist/index.js`、`dist/index.d.ts`、`dist/config.js`、`client/client.js`、`client/lib.js`、`personas/builtin/*.json`、`locale/zh.json`、`icon.svg`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE`、`scripts/check-package.mjs`、`docs/RELEASE-CHECKLIST.md` 均存在 |
| dist 版本常量 | `dist/index.js` 中 `PLUGIN_VERSION = '3.0.0'` |
| `node --check client/client.js` | PASS（exit 0） |
| 运行时数据 / 私密文件 | 无 `state.json`、`audit*.jsonl`、`drafts*`、`desktop-ack.json`、`api-token`、`uia-state.json`、`*.log`、`*.tmp`、`.env` |
| 截图/聊天图片 | 无；图片仅 18 张 `stickers/*.png` |
| 测试/夹具 | 无 `test/**`、`test/fixtures/**`（`files` 未包含 `test`） |
| `dist/` 脏数据 | 无（`dist` 仅 53 js + 53 d.ts） |

## 4. 干净临时目录「模拟安装」

### 4.1 真正的 `npm install <tarball>`（离线）

```powershell
# 全新临时项目
npm init -y
npm install <tarball> --no-audit --no-fund --ignore-scripts --offline
```

结果：**FAIL（环境限制，非包问题）**

```text
npm error code ENOTCACHED
npm error request to https://registry.npmjs.org/@deepseek-ai%2fschemastery failed:
npm error   cache mode is 'only-if-cached' but no cached response is available.
# 另有 peer 警告：@deepseek-ai/cordis@^4.0.1-rc.4（由宿主提供）
```

- 根因：插件依赖 `@deepseek-ai/schemastery`（peer `@deepseek-ai/cordis` 由 DSH 宿主提供）本机 npm 缓存未命中；
  本轮不联网、不安装新依赖，故**未**重试联网安装。
- 影响：无法在本机验证「从 tarball 执行 npm install 后由 DSH 加载」的完整链路；安装文档中的推荐方式
  （profile `link:` 依赖 + `plugin_manager`）同样未在真实 profile 中执行。

### 4.2 解包 + 复用宿主依赖的模拟安装（已执行）

```powershell
# 1) 解包到临时 node_modules/dsh-wechat-persona（模拟安装位置）
# 2) 依赖用仓库已有 node_modules（离线；不新增依赖）
#    node_modules/@deepseek-ai -> <仓库目录>/node_modules/@deepseek-ai
node -e "import('file:///<临时项目>/node_modules/dsh-wechat-persona/dist/index.js')
  .then(m => console.log(m.name, m.provide, typeof m.apply))"
```

结果：**PASS**

```text
IMPORT_OK name=dsh-wechat-persona provide=["wechatPersona"] apply=function migrate=function
```

- 证明：tarball 解包后的 `dist/` 能在独立 `node_modules` 布局下被 ESM `import`，入口导出完整；
  `dist/config.js` 的 `migrateConfig/defaultConfig` 可加载；`client/client.js` 语法检查通过。
- 不证明：DSH 宿主 context 注入、真实 profile 解析、真实微信通道（这些需要真实 DSH/微信环境，见 §9）。

## 5. 配置迁移（v0.2.8 → v3.0.0）

### 5.1 迁移测试

```text
$ npx vitest run test/core/config-migration.test.ts
✓ test/core/config-migration.test.ts (10 tests) 8ms
Test Files  1 passed (1)   Tests  10 passed (10)   exit 0
```

覆盖：v0.2.8 旧配置补齐 `sendMode/safeMode/onboardingDone/apiToken`、显式 `sendMode` 保留、非法值回落 auto、
旧字段保留、二次迁移幂等、未知字段保留。

### 5.2 迁移探针（dist 构建，`migrateConfig(default legacy)`）

构造 v0.2.8 形态配置（`schedule.onlineStart/onlineEnd = 08:00/21:00`，**无** `sendMode/safeMode/onboardingDone/apiToken/readOnlyTestMode/ocrPipelineMode`）：

| 字段 | 迁移后 | 说明 |
| --- | --- | --- |
| `sendMode` | `auto` | 新增，保持旧版自动发送行为；notes 有迁移提示 |
| `safeMode` | `false` | 新增，默认关闭（升级兼容） |
| `onboardingDone` | `false` | 新增 |
| `apiToken` | `''` | 新增，空=兼容模式（仅回环 + 请求头） |
| `schedule.onlineStart/onlineEnd` | `08:00` / `21:00` | **保留** |
| `schedule.workdayStart/workdayEnd` | `08:00` / `21:00` | 从 onlineStart/End 沿用（notes 4 条） |
| `ownerName` / `activeChannel` / `persona.activeId` / `reply.maxChars` / `budget.dailyTokens` | `主人` / `mock` / `builtin-dafeiyu` / `80` / `20000` | **保留** |
| 未知字段 `legacyUnknownField` | `{"nested":[1,2,3]}` | **保留**（不丢配置） |
| 二次迁移 | `changed=false` | 幂等 |

> 说明：配置内没有独立的 `model` 字段（模型由 DSH 宿主默认模型选择，插件读宿主 `agentDefaultModel`）；
> 因此「model 不丢」在迁移层的等价验证是「未知/旧字段原样保留」，上表已覆盖。

### 5.3 只读模式（任务书预期 vs 实际实现，重要差异）

- **任务书第五部分设想**：配置字段 `readOnlyMode`，迁移后**默认 true**（默认只读、真实发送被禁用）。
- **当前代码（工作树，未提交）实际**：字段名为 **`readOnlyTestMode`**，`src/config.ts:326` 的 schema 默认 **`false`**，
  迁移在 `src/config.ts:548-551` 补 `false` 并提示「只读测试模式默认关闭」；设计说明为「发布前验收专用，
  开启后代码层拒绝真实通道发送与键鼠模拟，重启后保持；默认关闭以保持升级兼容」。
- 已在源码接线（`dist` 尚未重建，故本次安装包不含该逻辑）：
  - `src/engine/engine.ts:235`（start 时只读不启动真实通道发送）、`:369`（status 暴露）、
    `:501`（发送门禁 `checkReadOnly`，`mock` 通道放行）；
  - `src/server/api.ts:1299/1304/1312`（status/config 暴露）、`:1752`（`/test/send` 拒绝）、`:1809`（`/drafts/approve` 拒绝）。
- 另新增 `ocrPipelineMode: 'legacy' | 'v3'`（默认 `v3`，可一键回退 v0.2.8 OCR 行为），见 `src/config.ts:37/96/327/553-556`。
- 迁移探针（直接 import 工作树 `src/config.ts`）：`readOnlyTestMode=false`、`ocrPipelineMode='v3'`，迁移 notes 增加两条；
  旧字段与未知字段同样保留、二次迁移幂等。
- **待办（发布前必须决策/复验）**：任务书要求「默认只读」与代码「默认关闭」不一致——若发布前真实微信只读测试需要
  默认隔离，必须显式开启 `readOnlyTestMode`（并重建 dist）；`readOnlyTestMode` 的拒绝行为需在最终构建上复验。

## 6. mock 启动与安全草稿模式

### 6.1 `npm run verify:api`（假宿主 + 真实 dist + 真实 HTTP 端口）

```text
PASS  GET /health → 200
PASS  GET /status → 200
PASS  GET /config → 200 且 persist.editable
PASS  POST /config → 202 且走 configEditor.edit
PASS  GET /logs / GET /personas / POST /personas/activate / GET /market / GET /stickers / GET /help
PASS  POST /test/send → 200 且通道发送成功
PASS  POST /test/send 在最小回复间隔内被拒绝（not-sent，不绕过频控）
PASS  POST /test/inbound → 202
PASS  POST /pause / POST /resume / 未知路由 404 / 暂停恢复后 status 正常
共 25 项，通过 25，失败 0        exit 0
```

覆盖点：鉴权缺失 403、`/health` 版本、迁移、mock 通道、配置写回、日志、人格、市场回退、表情、帮助、频控不绕过、暂停/恢复。
（stderr 的 `state.json ENOENT` 是临时目录收尾清理竞态，不影响结论。）

### 6.2 草稿模式专项 harness（临时脚本，已删除）

用与 `verify-api` 相同的假宿主方式启动插件（`activeChannel=mock`、`sendMode='draft'`、白名单 1 个虚构联系人），
经真实 HTTP 路由验证「草稿生成 → 未发送 → 批准后才发送」：

```text
PASS  API 前缀路由已注册（插件已 boot）
PASS  mock 通道启动：GET /health 200 且 version=3.0.0
PASS  GET /status：channel=mock、sendMode=draft、暂停=false
PASS  GET /drafts：初始为空队列
PASS  POST /test/inbound → 202（mock 入站）
PASS  sendMode=draft：生成草稿且未发送（drafts 队列非空）
PASS  草稿状态为 pending 且 reason=draft-mode
PASS  批准前 outbox.jsonl 不存在（未真实发送）
PASS  POST /drafts/approve → 200 且 result.ok=true（mock 通道放行）
PASS  批准后 outbox.jsonl 出现（mock 通道完成发送）
PASS  批准后草稿状态更新（approved）
PASS  重复批准同一草稿 → 409「草稿已处理（approved），不能重复操作」
PASS  批准不存在草稿 → 404
共 13 项，通过 13，失败 0
```

- 说明：批准路径会重走暂停/熔断/预算/白名单/频控/安全模式/幂等账本门禁，并复用草稿的 `opId`；
  以上验证的是「未开启只读模式」时 mock 通道可批准发送。**只读模式下 `/drafts/approve` 必须被拒绝**（`api.ts:1809`），
  因 `dist` 未重建，列入 §9.2 待复验。

## 7. 卸载与回退步骤（文档化，未实机执行）

### 7.1 卸载插件（不删除个人数据）

参考 [docs/使用说明.md](使用说明.md) §3.3：

1. 在设置页暂停/停止插件（`wechat_persona_pause` 或 `POST /pause`），确认微信无在途自动操作；
2. 编辑 DSH profile（默认 `%USERPROFILE%\.dsh\profiles\desktop\package.json`）：
   - 从 `dependencies` 删除 `"dsh-wechat-persona": "link:<插件目录>"`；
   - 从 `dsh.profile.bundles` 删除 `"dsh-wechat-persona"`；
   - （或使用宿主 `plugin_manager` 的移除功能）；
3. 重启 DSH 桌面端；
4. 可选清理：删除插件数据目录（默认 `<DSH 工作区>/.dsh-wechat-persona/`，含 `state.json`、`memory/`、`audit.jsonl`、
   `drafts.json`、`send-ledger.json`、`desktop-ack.json`、`stickers/`、`personas/` 等）。**卸载插件不会自动删除数据目录**，
   需手动处理；删除前建议先备份。

本轮**未实际卸载**用户 profile，步骤为文档化；真实卸载后的 DSH 行为（插件目录残留、配置残留）未验证。

### 7.2 回退到 v0.2.8

前提：升级前已备份**整个数据目录**（另存 `uia-state.json` 与配置原文）。tag `v0.2.8` 已确认存在（`git tag -l v0.2.8`）：

```powershell
# 0) 停：设置页暂停/停止引擎，确认微信无在途自动操作
# 1) 备份 v3 数据目录与配置（整目录改名，不原地覆盖）
# 2) 切回旧版
git switch --detach v0.2.8
# 3) 安装旧版依赖并构建
npm ci --ignore-scripts --no-audit --no-fund   # 旧 lockfile 不兼容时 npm ci 会明确报错，才允许改用 npm install --ignore-scripts
npm run build
# 4) 重启 DSH（或关 2 秒再开插件开关），验证 GET /health 的 version 回到 0.2.8
# 5) 用升级前备份「恢复数据目录」（v3 新增文件/字段不保证被 v0.2.8 识别；以整目录替换最稳）
```

- 预期降级：v0.2.8 无 `safeMode`、`/diagnostics/ocr`、`desktop-ack.json` 持久化、draft/confirm 队列等；功能降级属预期。
- **未演练**：本轮未实际切换版本、未跑旧版构建、未做真实微信回退；不得对外承诺「无痛回退」。
  详细回退与数据文件说明见 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) §6.5、[MIGRATION-v3.md](MIGRATION-v3.md) §8。

## 8. 版本号一致性

| 位置 | 值 | 证据 |
| --- | --- | --- |
| `package.json` | `3.0.0` | `"version": "3.0.0"`、`"private": true` |
| `src/index.ts` | `3.0.0` | `src/index.ts:83 const PLUGIN_VERSION = '3.0.0'`（任务书早前记录为 `:82`，行号因新增 import/注释后移） |
| `dist/index.js` | `3.0.0` | `dist/index.js:41`；tarball 内同一常量一致 |
| tarball `package.json` | `3.0.0` | 解包后核对 |

`GET /health` 运行期也返回 `version: "3.0.0"`（见 §6.1 / §6.2 输出）。

## 9. 未验证项与限制

### 9.1 环境类（本轮做不到）

1. **真实 DSH profile 安装**：未修改用户 profile、未重启 DSH；`link:` 安装 / `plugin_manager` 安装未实机执行。
2. **真正干净机器**：无独立无 `node_modules`、无微信的机器；本机为「干净临时目录 + 复用宿主依赖」模拟。
3. **联网 `npm install <tarball>`**：依赖 `@deepseek-ai/schemastery` 未命中本机 npm 缓存（`ENOTCACHED`），
   未联网安装（不新增依赖、遵守不联网约束）。真实安装时该依赖来自 registry 或用户已有安装。
4. **真实微信**：未启动微信、未读取真实聊天、未做真实发送；桌面通道/只读真实设备验收需用户单独授权后另行进行。
5. **跨平台**：仅 Windows 本机验证；Linux/macOS 未验证（CI 的 linux-guard 只跑类型检查/单测/敏感扫描，不跑安装）。

### 9.2 代码状态类（发布前必须复验）

1. **`dist/` 早于源码**：验收用 `dist` 构建于 10:33:26，而 `src/config.ts`（10:39）、`src/engine/engine.ts`（10:41）、
   `src/server/api.ts`（10:41）之后加入 `readOnlyTestMode` / `ocrPipelineMode` 逻辑。因此：
   - 本次 tarball **不含**只读模式与 OCR 流水线开关；
   - `readOnlyTestMode` 下 `/test/send`、`/drafts/approve` 是否被拒绝 → **待最终代码 `npm run build` 后复验**；
   - 发布前必须重建 `dist` 并重跑本清单（包内容、版本、mock、草稿、只读）。
2. **只读模式默认值差异**：任务书设想 `readOnlyMode` 默认 `true`；实际字段 `readOnlyTestMode` 默认 `false`（升级兼容）。
   若发布前真实设备只读测试要求默认隔离，需显式开启并复验（见 §5.3）。
3. **`ocrPipelineMode` 生产路径**：默认 `v3`，`legacy` 回退分支本次未在真实读取路径验证（仅迁移层验证存在性）。
4. **工作树并行修改**：验收期间其他队友/Lead 仍在改 `src/engine/engine.ts`、`src/server/api.ts`、`scripts/**`、
   `test/**`，并新增 `docs/OCR-REAL-DEVICE-TEST-PLAN.md`、`scripts/ocr/analyze-errors.mjs`、
   `test/channels/desktop-id-stability.test.ts` 等；最终发布包必须基于最终代码重新构建与复验。

### 9.3 工作树漂移记录（验收快照）

验收开始时 `git status --short` 为空（HEAD `c05a24a`）。验收结束时（约 10:52）HEAD 未变，工作树已有多处其他队友的并行改动：

```text
 M client/client.js
 M scripts/ocr/engines.mjs
 M scripts/verify-api.mjs
 M src/config.ts
 M src/engine/engine.ts
 M src/server/api.ts
 M test/core/persona-market.test.ts
 M test/server/api.test.ts
?? docs/OCR-REAL-DEVICE-TEST-PLAN.md
?? docs/PRE-RELEASE-INSTALL.md          # 本文件
?? scripts/ocr/analyze-errors.mjs
?? test/channels/desktop-id-stability.test.ts
```

本验收未修改上述任何 `src/**`、`scripts/**`、`test/**`、`client/**` 文件（仅新增本文档）；
`verify-api.mjs` 的频控用例修复（`/test/send` 成功 + 立即第二次被 `not-sent` 拒绝）在本次运行中已生效（25/25 PASS）。

### 9.4 敏感信息扫描

- **HEAD `c05a24a`（干净 clone）**：`node scripts/check-sensitive.mjs` 扫描 **203** 个受跟踪文本文件，**0 命中**，exit 0。
- **当前工作树**：当时扫描 203 个文件命中 **2 处**（均在 `test/core/persona-market.test.ts:825`，夹具邮箱域名不在示例白名单）；本轮已改为 `example.com` 并复扫 **212 文件 0 命中**。
  （队友未提交的 SSRF 测试夹具，URL userinfo 被 [真实邮箱] 规则误判/待脱敏），该文件**不在本任务写域**，
  未改动；发布前需由作者改为虚构占位并重跑扫描（与 §8 门槛 8 相关）。
- **本文档提交后的预演**：在临时 clone（HEAD `c05a24a`）中把本文档 `git add` 后复跑
  `node scripts/check-sensitive.mjs` → 扫描 **204** 个受跟踪文本文件，**0 命中**，exit 0（证明本文件本身可过扫描）；
  同时 `check-package` 候选数会由 181 变为 182、`npm pack` 文件数由 188 变为 189（见 §3.1 注）。
- 发布包（tarball）内已确认无运行时隐私数据（见 §3.3）。

## 10. 发布前建议

1. 在**最终代码**上 `npm run build`，然后重跑本清单（尤其 §3 包内容、§4 模拟安装、§6 mock/草稿、§5.3 只读模式复验）。
2. 按 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) §6.4 用「git 受跟踪文件 + 本次 dist」制作干净发布包（**不要直接 `npm pack`**），
   并同步更新其中「期望文件数」（现为旧值 **167**；本次实测 `check-package` 候选 **181**，重构建后以最新为准）。
3. 修复 §9.4 的敏感扫描命中后重跑 `node scripts/check-sensitive.mjs`。
4. 明确 `readOnlyTestMode` 的发布默认值：若需要「默认只读」的真实设备验收，显式开启并在最终构建上验证
   `/test/send`、`/drafts/approve` 均被拒绝、重启后仍保持只读。
5. 若希望发布包更小，可在维护者批准下从 `files` 中排除 `scripts/dev/**`、`scripts/ocr/**`、`scripts/py/**`
   等非运行必需内容（本轮未改 `package.json`）。
6. 真实 DSH profile 安装与真实微信只读验收仍需用户单独授权，另立任务执行。

## 附录 A：命令清单（可复现）

```powershell
# 0) 快照
git rev-parse HEAD; git rev-list --count HEAD; git status --short
node --version; npm --version

# 1) 仓库口径包检查
node scripts/check-package.mjs

# 2) npm 打包内容
npm pack --dry-run --json | Set-Content "$env:TEMP\dry.json"
npm pack --pack-destination "$env:TEMP\pkg"
tar -xzf "$env:TEMP\pkg\dsh-wechat-persona-3.0.0.tgz" -C "$env:TEMP\pkg"
node --check "$env:TEMP\pkg\package\client\client.js"

# 3) 模拟安装（解包 + 复用宿主依赖）
#    将解包内容复制为 <临时项目>/node_modules/dsh-wechat-persona
#    并将 @deepseek-ai 目录 junction 到仓库 node_modules/@deepseek-ai
node -e "import('file:///<临时项目>/node_modules/dsh-wechat-persona/dist/index.js').then(m=>console.log(m.name,m.provide,typeof m.apply))"

# 4) 配置迁移
npx vitest run test/core/config-migration.test.ts
node --input-type=module -e "import { migrateConfig } from 'file:///<仓库>/dist/config.js'; ..."   # 见 §5.2
node --input-type=module -e "import { migrateConfig } from 'file:///<仓库>/src/config.ts'; ..."   # 见 §5.3（Node 26 TS 支持）

# 5) mock + API
npm run verify:api

# 6) 敏感扫描（HEAD 干净 clone 与当前工作树分别执行）
node scripts/check-sensitive.mjs
```

## 附录 B：关键 file:line 索引

| 内容 | 位置 |
| --- | --- |
| `PLUGIN_VERSION = '3.0.0'` | `src/index.ts:83`、`dist/index.js:41` |
| `readOnlyTestMode` 字段 / schema 默认 false / 迁移补齐 | `src/config.ts:89`、`:326`、`:548-551` |
| `ocrPipelineMode` 类型 / schema / 迁移 | `src/config.ts:37`、`:327`、`:553-556` |
| `sendMode` 类型与默认 auto / 迁移 | `src/config.ts:34`、`:304-306`、`:519-523` |
| 只读模式发送门禁 | `src/engine/engine.ts:501`（canSend 的 `checkReadOnly`）、`:235`（start） |
| 只读模式 API 拒绝 | `src/server/api.ts:1752`（`/test/send`）、`:1809`（`/drafts/approve`） |
| 草稿队列 / 批准 / 拒绝 | `src/engine/engine.ts:723`（createDraft）、`:800-866`（approveDraft）、`:781-792`（rejectDraft） |
| 幂等账本 | `src/core/send-ledger.ts`（`sendOperationId`、`shouldSend`、上限 200） |
| 草稿 API | `src/server/api.ts`：`GET /drafts`、`POST /drafts/approve|reject` |
| 安装说明 | `docs/使用说明.md` §3（安装/更新/卸载）、`README.md` §5 |
| 发布包制作与回退 | `docs/RELEASE-CHECKLIST.md` §6.2–§6.5 |
| 包内容检查脚本 | `scripts/check-package.mjs` |
| 离线验收脚本 | `scripts/verify-api.mjs`（25 项检查） |

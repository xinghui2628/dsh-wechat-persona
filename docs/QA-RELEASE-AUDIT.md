# dsh-wechat-persona 0.2.1 发布就绪审计报告

> 审计类型：发布前只读审计（文档完整性 · 个人数据 · 安装兼容性 · 仓库卫生 · 命令一致性）
> 审计人：docs-auditor（DSH 团队文档/发布审计员）
> 审计时间：2026-10-31（Asia/Shanghai）
> 审计对象：`dsh-wechat-persona` 工作树（含 2 个未提交修改文件）+ git 索引，版本 **0.2.1**（`package.json:3`）
> 输出文件：本文件（本次审计唯一新建文件；未修改/删除任何其它文件）

## 0. 范围、方法与结论

**检查覆盖**（逐文件/逐目录）：

| 范围 | 方式 | 结果概况 |
| --- | --- | --- |
| `src/`（39 个 .ts + 2 个 .py）、`client/`（2 文件）、`locale/`（2 文件）、`persona/`（2 文件）、`personas/`（4 个内置人格） | 全量 grep（真名/wxid/手机号/token/绝对路径）+ 抽样通读关键文件 | 2 个 `src/*.py` 与 1 个 `client` 侧均无真名；`src/*.py` 含本机绝对路径 |
| `dist/`（78 文件） | 全量 grep（先以 `wechat` 验证扫描有效） | 无隐私命中 |
| `scripts/`（pwsh/dev/根 .mjs） | 全量 grep + 逐文件定位 | **隐私命中集中在 `scripts/`（真实昵称 7 行 / 绝对路径 36 个 tracked 文件）** |
| `docs/`（7 篇 .md）、`README.md`、`CHANGELOG.md`、`AGENTS.md`、`LICENSE` | 逐篇通读/关键节核对 + 文档间交叉引用核对 | 文档齐全但 LICENSE 缺失；4 处版本号过期；2 处统计数字过期；3 处内容与代码不符 |
| `package.json`、`.gitignore`、`cordis.patch.yml`、`tsconfig.json`、`package-lock.json` | 逐行通读 + `git ls-files` / `git status` / `git check-ignore` 核对 | `files` 字段会把个人数据/开发脚本打进发布包（见 M1）；`.gitignore` 缺 Python 产物规则 |
| `test/`（30 个 `*.test.ts`） | 抽查 + grep | 仅虚构人名/wxid（`wxid_alice`/`张三` 等），无真实数据 |
| `backups/`、`dev-notes/`（仅存在性） | 目录存在性 + 是否入库 | 均被 `.gitignore` 排除、未跟踪；但**本地内容含真名/真实聊天**（见 M1 风险提示） |
| 本机已安装实例（只读） | 读 `~/.dsh/profiles/desktop/package.json`、link 元数据 | 用于核对 README 安装方式是否与真实安装一致（见 P5） |

**限制**：本次为只读审计——未运行 `npm run build/test/verify:*`，未安装插件、未重启 DSH、未操作微信。因此「`verify:api` 24/24」「本机 DSH 桌面版 0.2.1-rc.3」「宿主 `plugin_manager action=install_bundle` 的动作名」等运行时声明未能独立复核（详见附录 C）。文中所有行号均来自本次实际读取的文件。

**结论：NO-GO（不建议直接发布到 GitHub）**。共 **2 个 P0**、**5 个 P1**、**4 个 P2** 必须修复项；另有 15 条建议改进。阻塞项里有 2 项是一经公开即不可逆的（真实好友昵称、真实姓名映射文件进入 git 历史），必须在首次 push 前处理。全部修复以文档/脚本清理为主，预计 1–2 小时。

## 1. 结论摘要（先看这 6 条）

1. **【P0 隐私】真实好友昵称已进入 git 跟踪**：好友A/好友B/好友C共 7 行、4 个文件（含一个「真名→化名」映射脚本 `scripts/dev/sanitize.py:3`），且 `package.json:33` 的 `files` 含 `scripts`，打包会带上这些文件。
2. **【P0 隐私】本机绝对路径 `C:\Users\<用户名>\...` 出现在 36 个已跟踪文件**（`scripts/pwsh/*.py`、`scripts/dev/*.py`、`src/*.py`），会暴露用户名与本机目录结构。
3. **【P0 许可】根目录没有 LICENSE**：`package.json:6` 声明 MIT、README 全文无许可声明；同学拿到的代码法律上是「保留所有权利」。
4. **【P1 版本】4 处仍写 0.2.0**：`README.md:134`、`README.md:464`、`docs/使用说明.md:11`、`docs/使用说明.md:454`（而 `README.md:5` 已是 0.2.1、`CHANGELOG.md:9` 已有 0.2.1 条目）。
5. **【P1 安装】README 安装节（`README.md:136-154`）没有任何环境前提**：Node 22+/DSH ≥0.2.1-rc.3/Windows 10-11/中文 OCR 语言包/微信 PC 4.x 只在 `docs/使用说明.md:51-57` 与 `docs/TEST-PLAN.md:6` 出现；从 GitHub clone 后没有 `dist/`（`.gitignore:2` 排除），方式 B 未提醒「先构建」。
6. **【P1 文档准确性】`docs/ARCHITECTURE.md:8` 列出了不存在的 API `/list` `/send`**（实际路由见 `src/server/api.ts:786-1333`），`:9` 把 `src/engine/engine.ts` 写成 `core/engine.ts`，`:50` 的 `schedule` 字段还是 v1 旧结构。

## 2. 必须修复（发布阻塞项）

### M1 【P0 · 隐私】真实好友昵称 + 真名映射脚本进入 git 跟踪

**证据**（`git ls-files` 确认均在库；`grep` 于工作树命中 7 行）：

| 文件:行 | 内容 |
| --- | --- |
| `scripts/dev/sanitize.py:3` | `repl = {"好友A":"好友A","好友B":"好友B","好友C":"好友C","<用户名>":"user"}`（**真名→化名映射字典**；`:2` 同时含本机绝对路径） |
| `scripts/pwsh/patch-list-score.py:12` | `# 同首字多联系人时（如好友A/好友B），按字符重合数打分裁决，避免歧义全丢。` |
| `scripts/pwsh/wechat-uia.ps1.broken-20261031-1248:12` | `#   -Action send -WindowTitle 微信 -Contact 好友A -TextBase64 <b64>` |
| `scripts/pwsh/wechat-uia.ps1.broken-20261031-1248:14` | `#   -Action read -WindowTitle 微信 -Contact 好友A -MaxMessages 20` |
| `scripts/pwsh/wechat-uia.ps1.broken-20261031-1248:640` | 同首字注释（同 `patch-list-score.py:12` 内容） |
| `scripts/pwsh/wechat-uia.ps1.exp-fast-20261031-1036:12` | `-Contact 好友A` 示例 |
| `scripts/pwsh/wechat-uia.ps1.exp-fast-20261031-1036:14` | `-Contact 好友A` 示例 |

**影响**：GitHub 一旦公开，即使随后删除文件，git 历史中仍永久可查（可通过 commit 历史/存档服务恢复）。`sanitize.py` 本身就是一份「好友A=好友A…」的对照表，属最敏感文件。`package.json:33` 的 `files` 含 `"scripts"`，npm pack（或未来任何打包方式）也会把它带进发布包。

**建议改法**：
1. 删除 `scripts/dev/sanitize.py`（脱敏已完成，脚本本身不应入库）与 3 个 tracked 备份脚本：`scripts/pwsh/wechat-uia.ps1.bak-send-20261031-1031`、`wechat-uia.ps1.broken-20261031-1248`、`wechat-uia.ps1.exp-fast-20261031-1036`；`src/channels/pc/desktop.ts.broken-20261031-1300` 同样删除。
2. `scripts/pwsh/patch-list-score.py:12` 注释泛化为「同首字多联系人时按字符重合数打分」。
3. 清 git 历史：仓库目前只有 3 个提交（最新 `8d521d1`）。若远端尚未公开，最省事且最彻底的做法是**新建干净仓库首推 0.2.1**（或 `git filter-repo --replace-text`）；不要只做一次 `git rm` 后继续推旧历史。
4. 发布前自检（只读）：`git grep -nE '好友A|好友B|好友C|<用户名>'` 必须无输出；`git log -p --all | grep -nE '好友A|好友B|好友C'` 也应无输出（历史清理后）。
5. 本地 `backups/`、`dev-notes/` 虽已被 `.gitignore:21-25` 排除且未跟踪，但内容含真名与真实聊天（`backups/pre-iter2/profile-cordis.patch.yml:86-95`、`dev-notes/cfg-current.json:1`、`dev-notes/dbg-send*.txt`）；发布前请在本机删除或移到仓库外，避免误压包。

### M2 【P0 · 隐私】36 个已跟踪文件写死本机绝对路径 `C:\Users\<用户名>\...`

**证据**（`git ls-files` 确认在库；完整清单见附录 A）：
- `src/recover-encoding.py:2` → `p=r"C:\Users\<用户名>\OneDrive\文档\deepseek-harness\default-workspace\dsh-wechat-persona\src\channels\pc\desktop.ts"`
- `src/restore-desktop.py:2-3` → 同前缀的 `dist/channels/pc/desktop.js` 与 `src/channels/pc/desktop.ts`
- `scripts/pwsh/patch-list-score.py:2`、`scripts/pwsh/recover.py:2`、`scripts/dev/patch-v4.py:3`、`scripts/dev/sanitize.py:2` 等，共 36 个 tracked 文件（另有 2 个未跟踪文件同样含路径）。

**影响**：泄漏 Windows 用户名 `<用户名>`、OneDrive 中文路径与仓库本机位置；同学复制这些脚本运行必然失败（路径不存在），且 `src/` 下的两个一次性脚本会被误当成源码发布。

**建议改法**：
1. 一次性补丁/恢复脚本已把逻辑合并进 `scripts/pwsh/wechat-uia.ps1`/`src/channels/pc/desktop.ts`，建议整体删除：`scripts/pwsh/patch-*.py`（21 个）、`scripts/pwsh/recover*.py`（3 个）、`scripts/dev/`（除保留少量真正对贡献者有用的脚本外）、`src/recover-encoding.py`、`src/restore-desktop.py`；或移到仓库外 `../dev-tools/` 并加入 `.gitignore`。
2. 若要保留个别工具脚本：改用相对路径（PowerShell：`$PSScriptRoot`；Python：`Path(__file__).resolve().parents[2]`），禁止硬编码 `C:\Users\<用户名>`。
3. 同步收窄 `package.json:21-34` 的 `files`：把 `"scripts"` 改为仅发布运行/文档所需项（例如 `scripts/pwsh/wechat-uia.ps1`、`scripts/pwsh/user-activity.ps1`、`scripts/pwsh/selfcheck.ps1`、`scripts/verify-api.mjs`、`scripts/verify-live.mjs`、`scripts/gen-stickers.mjs`、`scripts/vm-agent.mjs`），不要整目录发布。**注意不要整个删除 `scripts/pwsh/`**——运行时 `src/channels/pc/desktop.ts:86-87` 通过 `new URL('../../../scripts/pwsh/${name}.ps1', import.meta.url)` 定位 `wechat-uia.ps1`/`user-activity.ps1`，缺一不可。

### M3 【P0 · 许可】根目录缺 LICENSE，README 无许可声明

**证据**：
- `glob **/LICENSE*` 仅命中 `node_modules/`（仓库根目录无 LICENSE；`git ls-files` 亦无）。
- `package.json:6`：`"license": "MIT"`。
- `README.md` 全文 grep `LICENSE|MIT|许可|License` 只命中 `README.md:11`（微信协议风险声明），**没有任何 MIT/许可说明**。

**影响**：GitHub 公开仓库若无 LICENSE，默认「保留所有权利」，同学不能合法复制/修改/再分发；与 `package.json` 声明 MIT 不一致。

**建议改法**：根目录新增 `LICENSE`（MIT 全文，`Copyright (c) 2026 dsh-wechat-persona contributors`），README 末尾（`README.md:462-469` 版本节之后）加 `## License` 一节指向 `LICENSE`；GitHub 仓库 About 设为 MIT。LICENSE 需提交进仓库（npm 打包会自动包含根 LICENSE，无需加入 `files`）。

### M4 【P1 · 版本一致性】4 处文档仍写 0.2.0

**证据**：
- `README.md:5`：当前版本 **0.2.1**（正确）。
- `README.md:134`：`当前版本 **0.2.0**（含设置界面…）`。
- `README.md:464`：`当前版本：**0.2.0**（2026-10-30）`；`:465` 更新记录也只提 0.2.0/0.1.0。
- `docs/使用说明.md:11`：`本手册对应版本：**0.2.0**（2026-10-30）`。
- `docs/使用说明.md:454`：`当前版本：**0.2.0**（2026-10-30）——…`。

**影响**：同学看到的版本号自相矛盾，无法判断自己装的是不是 CHANGELOG 里的 0.2.1。

**建议改法**：4 处统一改为 `0.2.1`（日期 2026-10-31），`README.md:134` 句子改成「本版本 0.2.1…」并把「从 0.1.0 升级」保留；`docs/使用说明.md:454` 同步追加 0.2.1 的变更摘要（可摘 `CHANGELOG.md:11-25`）。

### M5 【P1 · 统计数字】测试文件/用例数两套说法（29/388 vs 30/396）

**证据**：
- 正确值：`README.md:343`「30 个测试文件 / 396 个用例」、`docs/ACCEPTANCE.md:145`「30 文件 / 396 用例」，与实测一致（`test/**/*.test.ts` = 30 个）。
- 过期值：`README.md:443`「29 个测试文件 / 388 用例」；`CHANGELOG.md:81`「29 个测试文件 / 388 个用例」。

**建议改法**：两处改 30/396；若不想手改，以后发布前由 `npm test` 输出更新。附带：`README.md:345-346` 的「`verify:api` 24/24」本次无法离线复核（脚本 `scripts/verify-api.mjs` 存在且会打印「共 N 项，通过 N-失败」，见 `:218`），发布前请重跑一次并按实际输出填写。

### M6 【P1 · 安装】README 安装节缺环境前提；方式 B 未提醒先构建

**证据**：
- `README.md:136-154`（`### 2. 安装到 DSH 桌面版 profile`）直接从「编辑 profile/package.json」开始；`README.md:148-154` 方式 B 只有一条 `plugin_manager action=install_bundle target=...` + 「重启 DSH」。
- 环境要求只出现在 `docs/使用说明.md:51-57`（表：`:53` DSH 0.2.1-rc.3+、`:54` Node.js 22+、`:57` desktop 需 Win10/11 + 中文 OCR + ≥1366×768）和 `docs/TEST-PLAN.md:6`（微信 PC 4.x）。
- 插件运行依赖 `dist/`（`package.json:9` main = `dist/index.js`），但 `dist/` 被 `.gitignore:2` 排除且**未入库**（`git ls-files dist` = 0 个文件），所以从 GitHub clone 后必须先 `npm run build`；方式 B 章节没有这句话。

**验收项⑤逐条对照**（README 能否被同学照做）：

| # | 检查点 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | Node 版本要求 | ⚠️ README 缺 | `docs/使用说明.md:54`（Node 22+）；`package.json` 无 `engines` 字段 |
| 2 | DSH 版本要求 | ⚠️ README 安装节缺 | `docs/使用说明.md:53`、`README.md:434`（FAQ 里才出现 ≥0.2.1-rc.3） |
| 3 | Windows 10/11 | ✅ 有 | `docs/使用说明.md:57`、`docs/TEST-PLAN.md:6` |
| 4 | PowerShell 5.1 | ⚠️ 准备表未列 | `docs/CHANNELS.md:180` 用 `powershell.exe` 调用；Win10/11 自带，但未说明 |
| 5 | Windows OCR 中文语言包 | ✅ 有 | `docs/使用说明.md:292-296`、`README.md:435-437`、`docs/CHANNELS.md:232-235` |
| 6 | 微信 PC 4.x | ⚠️ 仅在测试计划 | `docs/TEST-PLAN.md:6`；安装文档只写「微信 PC 小号」 |
| 7 | 插件安装方式 | ✅ 两方式都有 | `README.md:140-146`（link:+bundles）、`README.md:148-154`（install_bundle） |
| 8 | 安装后重载/重启 | ✅ 有 | `README.md:146`、`:154`、`:399-401`、`docs/ACCEPTANCE.md:177` |
| 9 | dataDir 说明 | ✅ 有 | `README.md:163-167`、`:231-239`、`docs/使用说明.md:393-399` |

**建议改法**：
1. 在 `README.md:136` 前加「环境要求」小表（摘 `docs/使用说明.md:51-57` + 微信 PC 4.x + 系统自带 PowerShell 5.1）。
2. 方式 B（`README.md:148-154`）补两句话：「方式 B 前同样需先完成 §1 构建（`dist/` 不入库）」「若 install_bundle 不可用/失败，回退方式 A」。
3. 建议同时给 `package.json` 加 `"engines": { "node": ">=22" }`，让包管理器在 Node 版本不符时给出提示。

### M7 【P1 · 文档准确性】`docs/ARCHITECTURE.md` 与代码不符（虚构路由 + 错误文件路径 + 旧配置字段）

**证据**：
- `docs/ARCHITECTURE.md:8` 写 `server/api.ts` 路由为「`/health /status /config /list /send /test/inbound ...`」——`src/server/api.ts` 中**不存在** `/list`、`/send`；实际路由（`src/server/api.ts:786-1333`）为：GET `/health`(:786)、`/status`(:797)、`/config`(:830)、`/personas`(:861)、`/personas/install`(:872)、`/personas/import`(:901)、`/personas/activate`(:917)、`/personas/export`(:943)、`/market`(:957)、`/market/install`(:982)、`/stickers`(:998)、`/stickers/upload`(:1042)、`/sticker-file`(:1113)、`/logs`(:1145)、`/test/inbound`(:1168)、`/test/send`(:1203)、`/pause`(:1222)、`/resume`(:1243)、`/memory/clear`(:1255)、`/audit/clear`(:1276)、`/help`(:1289)、DELETE `/personas/{id}`(:1310)、DELETE `/stickers`；前缀 `src/server/api.ts:47` = `/dsh-wechat-persona/api`。
- `docs/ARCHITECTURE.md:9` 写「`core/engine.ts`」——实际是 `src/engine/engine.ts`。
- `docs/ARCHITECTURE.md:50` 配置关键项仍写 `schedule(onlineStart,onlineEnd)`——`src/config.ts:278-283` 已是 `onlineStart/onlineEnd + workdayStart/workdayEnd/weekendStart/weekendEnd`（v2）。

**影响**：贡献者/同学照文档写 API 调用会 404；架构文档是 `AGENTS.md`/`docs/PROMPTS.md:10` 要求先读的输入，错误会继续扩散。

**建议改法**：按上表重写 `:8` 路由行（标注「完整列表见 `src/server/api.ts`」避免再次过期）；`:9` 改为 `src/engine/engine.ts`；`:49-53` 补 v2 时段字段并注明「留空回退 `onlineStart/onlineEnd`」。

### M8 【P2 · 文档】README 截图占位未替换

**证据**：`README.md:65`：`界面截图：请在本机安装后于设置页「微信分身」截图，替换此占位。截图目录约定 docs/images/settings-overview.png`——`docs/images/` 目录不存在（`docs/` 下无 `images/`）。

**影响**：发布版 README 直接带着「请替换此占位」的安装指示，观感差且不专业。

**建议改法**：发布前补 1–2 张截图到 `docs/images/` 并替换该行；若不便截图，删除该行占位说明。

### M9 【P2 · 文档】README 目录树（`README.md:69-118`）与仓库实际不符

**证据**：
- 整棵树漏了 `AGENTS.md`、`.gitignore`、`LICENSE`（应新增）、`package.json`、`tsconfig.json`、`package-lock.json`。
- `README.md:72` 只列 `client/client.js`，实际 `client/` 还有 `lib.js`。
- `README.md:105` 写 `personas/packages/`（运行时装包目录）——仓库中不存在；实际内置人格在 `personas/builtin/*.json`（4 个），安装根是 `<dataDir>/personas`（`src/core/persona-library.ts:451`）。
- `README.md:107` 的 `scripts/` 只列 `gen-stickers.mjs`、`vm-agent.mjs`、`pwsh/wechat-uia.ps1`；实际还有 `verify-api.mjs`、`verify-live.mjs`、`pwsh/selfcheck.ps1`、`pwsh/user-activity.ps1` 等。
- `README.md:109-113` 的 docs 只列 `使用说明/CHANNELS/ACCEPTANCE/PLAN`，漏 `ARCHITECTURE.md`、`TEST-PLAN.md`、`PROMPTS.md`（虽然 `README.md:8` 有链接，但目录树里没有）。

**建议改法**：按实际 `git ls-files` 重画目录树；一次性个人开发脚本清理（M1/M2）后再画，避免树里出现不该发布的东西。

### M10 【P2 · 文档】AGENTS.md / PROMPTS.md 引用不存在的 `docs/STATUS-*.md`

**证据**：
- `AGENTS.md:29`：「改完必须更新 `docs/STATUS-*.md` 与 `CHANGELOG.md`」。
- `docs/PROMPTS.md:17`：「…并更新 CHANGELOG.md 与 docs/STATUS-*.md」。
- 实际 `docs/` 无任何 `STATUS-*.md`（只有 ACCEPTANCE/ARCHITECTURE/CHANGELOG/CHANNELS/PLAN/PROMPTS/TEST-PLAN/使用说明）。

**影响**：AI 会话与贡献者按规则找不到文件，会反复「创建新 STATUS 文件」或报错；与 `AGENTS.md` 自身「发布前 CHANGELOG 写好」的要求重复。

**建议改法**：两处改为「更新 `CHANGELOG.md`（过程记录放本地 `dev-notes/`，不入库）」；或真的新增 `docs/STATUS.md` 模板并纳入版本管理（二选一，别悬空）。

### M11 【P2 · 文档】`docs/PROMPTS.md:24` 给出错误的人格文件路径

**证据**：`docs/PROMPTS.md:24`：「给 dsh-wechat-persona 新增人格角色卡，文件放 `personas/<id>.json`」。实际：内置人格是 `personas/builtin/<id>.json`（4 个文件），用户导入/安装的人格包落在 `<dataDir>/personas/<id>/pack.json`（`src/core/persona-library.ts:451`），并无 `personas/<id>.json` 这一约定。

**建议改法**：写清三种入口——内置：`personas/builtin/<id>.json`；导入：设置页「人格广场 → 导入」写入 dataDir；v2 包：`<dataDir>/personas/<id>/pack.json`。

## 3. 建议改进（不阻塞发布，建议 0.2.1 内顺手做掉）

### S1 `.gitignore` 缺 Python 产物与实验备份规则
**证据**：`git status` 显示未跟踪 `scripts/dev/__pycache__/`、`scripts/dev/patch-bubble2.py`、`patch-clamp.py`、`wx_probe.py`；`git check-ignore` 对这些路径均无输出。`.gitignore:21-25` 只有 `*.bak`、`*.bak-*`，不覆盖 `.broken-*`、`.exp-*`（因此 M1 中三份实验脚本是被显式 `git add` 进去的）。
**建议**：追加 `__pycache__/`、`*.pyc`、`*.broken-*`、`*.exp-*`、`*.bak-send-*`。

### S2 `dist/` 的三条规则互相矛盾（打包风险）
**证据**：`.gitignore:2` 忽略 `dist/`；`package.json:22` 的 `files` 却含 `"dist"`；`AGENTS.md:12` 称「dist/ 构建产物（tsc 输出，提交前必须与 src 同步）」。实际 `git ls-files dist` = 0，且提交 `6bb7a41`（message：「build: 0.2.1 版本号与 dist 重新构建」）实际只改了 `src/index.ts`。
**建议**：二选一：①保留「dist 不入库」→ 删除 `AGENTS.md:12` 的「提交前必须与 src 同步」措辞，并把 `package.json:22` 的 dist 说明为构建产物（npm pack 前运行 `npm run build`）；②让 dist 入库（去掉 `.gitignore:2`）。推荐 ①，并在 README 安装节强调「clone 后先 build」。

### S3 仓库卫生：移除 tracked 的一次性备份/调试文件，提交未提交改动
**证据**：tracked 垃圾：`scripts/pwsh/wechat-uia.ps1.bak-send-20261031-1031`、`scripts/pwsh/wechat-uia.ps1.broken-20261031-1248`、`scripts/pwsh/wechat-uia.ps1.exp-fast-20261031-1036`、`src/channels/pc/desktop.ts.broken-20261031-1300`、`scripts/dev/distline.txt`。`git status --porcelain`：`M scripts/pwsh/wechat-uia.ps1`、`M src/channels/pc/desktop.ts`（共 +50/−2 未提交）。
**建议**：发布前 `git rm` 上述垃圾文件（已按 AGENTS.md 要求改名 `.bak`，可安全删除），并提交工作树改动，确保发布的 commit 与验收过的代码一致。

### S4 `CHANGELOG.md` 的 0.2.1 条目缺少分类
**证据**：`CHANGELOG.md:9` `## [0.2.1] - 2026-10-31`，`:11-25` 是平铺 bullet，无 `### 新增/变更/修复` 小节；而 0.2.0（`:27` 起）是按分类写的。`:23` 记「新增 scripts/pwsh/selfcheck.ps1」、`:24` 记「新增 AGENTS.md、docs/ARCHITECTURE.md、TEST-PLAN.md、PROMPTS.md」。
**建议**：按 0.2.0 风格补 `### 新增 / ### 修复 / ### 文档` 分类；补一句「发布 0.2.1：桌面通道稳定性 + 文档/自检补齐」。

### S5 `docs/TEST-PLAN.md` 的 PowerShell 示例在 PS5.1 下会乱码
**证据**：`docs/TEST-PLAN.md:49-52`：`$audit = "$env:USERPROFILE\...\audit.jsonl"; Get-Content $audit | ForEach-Object ...`——未加 `-Encoding UTF8`，而 `audit.jsonl` 的 reason 含中文路径时 PS5.1 默认按 ANSI 读会乱码（与 `AGENTS.md:22-23` 的硬性约束 3 同源）。
**建议**：改为 `Get-Content $audit -Encoding UTF8`；`:42` 的硬编码 dataDir 路径建议加一句「自定义 dataDir 时替换为配置值」。

### S6 使用说明 FAQ 链接锚点与 README 不一致
**证据**：`docs/使用说明.md:9`：`完整声明见 [README 的「重要声明」](../README.md#dsh-wechat-persona)`；README 的「重要声明」标题在 `README.md:10`（`> ⚠️ **重要声明（请先读完再装）**`），`#dsh-wechat-persona` 实际指向 H1 页首。
**建议**：链接改为 `../README.md#重要声明请先读完再装`（GitHub 生成的中文锚点），或把该块提成独立 `## 重要声明` 标题。

### S7 安装/使用文档缺「微信 PC 4.x」与「PowerShell 5.1」两条前提
**证据**：微信客户端版本只在 `docs/TEST-PLAN.md:6` 出现；`docs/使用说明.md:51-57` 准备表只写「微信 PC 小号已登录」（`docs/使用说明.md:292-296`），未写版本；PowerShell 5.1 只在 `docs/CHANNELS.md:180`、`AGENTS.md:22-23` 间接提到。
**建议**：在 `docs/使用说明.md:51-57` 表里补两行：「微信 PC 客户端 4.x」「Windows 自带 Windows PowerShell 5.1（scripts 由 powershell.exe 调用）」，并与 M6 的 README 环境要求表保持一致。

### S8 `dataDir` 默认值表述在代码注释与文档间不一致
**证据**：`src/config.ts:38`/`:260` schema description：「留空 = 工作区下的 `.dsh-wechat-persona`」；`README.md:163-167`：「DSH 数据目录下的 `.dsh-wechat-persona/`…`workingDirectory.defaultDirectory` 只是部署回退目录」；实际 `src/index.ts:329-331`：`workspace = workingDirectory.defaultDirectory || process.cwd()`，随后 `resolve(workspace,'.dsh-wechat-persona')`（`defaultDirectory` 是**首选**，只有取不到才回退 `process.cwd()`）。
**建议**：统一措辞为「留空 = 当前 DSH 工作区根目录（desktop 实测为 `profiles/desktop`）下的 `.dsh-wechat-persona/`」，并把 README 里「只是部署回退目录」改为「dataDir 相对路径基于它解析」。

### S9 `docs/PLAN.md` 属过程性文件，会被随 `docs/` 一起发布
**证据**：`docs/PLAN.md:5`（备份到 `backups/pre-iter2/`）、`:52`（计划新增 `wechat_persona_personas`/`wechat_persona_market` 工具，实际未实现——`src/tools.ts` 仍是 6 个工具）、`:101-109`（分阶段记录）。`package.json:32` 的 `files` 含 `"docs"`。
**建议**：发布前把 `docs/PLAN.md` 移到 `dev-notes/`（不入库）或顶部标注「历史计划，部分项未实现」。

### S10 README 快速开始标题与构建注释过期
**证据**：`README.md:120` 标题「快速开始（MVP：单联系人 + 文本/表情包 + 手机通道）」——当前已支持多联系人、四通道（`docs/使用说明.md:271-282`）；`README.md:127` 注释「v0.2.0 起还需 client/client.js 随包发布，构建不处理它」——版本措辞过期且 `client/` 实际还有 `lib.js`。
**建议**：标题改为「快速开始（构建 → 安装 → mock 空转 → 选通道）」；注释改为「`client/` 为纯 JS 源码，tsc 不处理，随包发布」。

### S11 安装方式 A 未说明 Windows 下 link 会生成 junction
**证据**：实测本机 `~/.dsh/profiles/desktop/node_modules/dsh-wechat-persona` 的 `LinkType = Junction`、`Target = 仓库目录`（由 `~/.dsh/profiles/desktop/package.json:11` 的 `"link:C:/..."` 产生）。README `:140-146` 只写「link:」，未说明它不需要管理员权限。
**建议**：在 `README.md:140-146` 补一句「pnpm 在 Windows 上会创建 junction（目录联接），无需管理员权限；删除该依赖即可解除链接」。

### S12 `verify:api`/验收数字建议随发布重跑并留痕
**证据**：`README.md:345-346`「`verify:api` 24/24」、`docs/ACCEPTANCE.md:147`「verify:api 24/24」；`scripts/verify-api.mjs:218` 打印「共 N 项，通过 N-失败」。本次为只读审计，未运行该脚本。
**建议**：发布前跑 `npm run verify:all`，把实际输出（测试数、dist 文件数）写进 CHANGELOG 0.2.1 与 ACCEPTANCE §11，避免下次再出现 29/388、24/24 这类对不上的历史数字。

### S13 版本记录节缺 0.2.1 摘要
**证据**：`README.md:464-465` 版本节与 `docs/使用说明.md:452-457` 版本记录都停在 0.2.0（见 M4）。
**建议**：两处各加一行 0.2.1 摘要（桌面通道稳定性、selfcheck 自检、文档补齐），与 `CHANGELOG.md:9` 对齐。

### S14 建议增加「验收项④文档清单」到发布检查
**证据**：`docs/ACCEPTANCE.md` 无 0.2.1 验收节（最新为 §11「v0.2.0 第二轮验收证据」`:138-182`），也没有「8 份文档存在性/版本一致性」检查项。
**建议**：在 `docs/ACCEPTANCE.md` 增加 §12（0.2.1）：逐项勾选 AGENTS/README/ARCHITECTURE/TEST-PLAN/PROMPTS/ACCEPTANCE/LICENSE/CHANGELOG 存在且版本=0.2.1；把本报告 M1–M11 作为发布门禁清单。

### S15 `package.json` 缺 `engines`/`repository` 等元数据
**证据**：`package.json:59-71` 无 `engines`、`repository`、`homepage`、`author`、`keywords`。
**建议**：至少加 `"engines": {"node": ">=22"}` 与 `"repository"`（GitHub 地址）；`keywords` 便于同学搜索（`dsh-plugin`、`wechat`、`persona`）。注意 `private: true`（`package.json:4`）保持现状即可（不发布 npm）。

## 4. 通过项（已验证，无需修改）

### P1 关键文档齐全，仅缺 LICENSE
`AGENTS.md`（52 行）、`README.md`（469 行）、`CHANGELOG.md`（114 行）、`docs/使用说明.md`（457 行）、`docs/CHANNELS.md`（312 行）、`docs/ARCHITECTURE.md`（58 行）、`docs/TEST-PLAN.md`（64 行）、`docs/PROMPTS.md`（46 行）、`docs/ACCEPTANCE.md`（182 行）、`docs/PLAN.md`（120 行）均存在且非空；`README.md:8` 已链接 ARCHITECTURE/TEST-PLAN/PROMPTS/ACCEPTANCE/AGENTS。唯一硬缺失是 LICENSE（M3）。

### P2 文档中所有命令/脚本真实存在，未发现编造命令
- `README.md:7` 的 `selfcheck.ps1 -Port` 参数存在：`scripts/pwsh/selfcheck.ps1:9-14`（`param([int]$Port = 0)`），`:119-125` 在 `-Port > 0` 时请求 `/health` 并带 `x-dsh-wechat-persona` 头。
- `README.md:396` 的 `node scripts/verify-live.mjs`：文件存在；`scripts/verify-api.mjs` 存在。
- `package.json:49-58` 的 `build/typecheck/test/test:sandbox/test:watch/verify/verify:api/verify:all` 与文档中出现的 `npm run …` 全部一一对应（README:126-128、:442-446，AGENTS.md:42-45，ACCEPTANCE:3-15，使用说明:96-98）。
- 文档未使用不存在的端口/端点命令（API 基址统一 `http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api`，与 `src/server/api.ts:47` 一致）。

### P3 可离线核对的数字全部吻合
- 测试文件：实测 `test/**/*.test.ts` = **30** → 与 `README.md:343`、`docs/ACCEPTANCE.md:145` 一致（M5 中的 29 为过期值）。
- `dist/`：实测 **78** 个文件 → 与 `README.md:345`、`README.md:391`、`docs/ACCEPTANCE.md:146` 一致。
- 使用说明字数：实测 **13649** 字符 → 与 `docs/ACCEPTANCE.md:159`「`/help` 使用说明书 13649 字」一致。
- 内置表情包：实测 **18** 个文件（与 README/ACCEPTANCE 的说法一致）。

### P4 个人数据目录已隔离，公开面内容洁净
- `.gitignore:6-15` 覆盖 `.dsh-wechat-persona/`、`inbound.jsonl`、`outbox.jsonl`、`audit.jsonl`、`audit.1.jsonl`、`alerts.jsonl`、`drafts.jsonl`、`state.json`、`memory/`；`:17-20` 覆盖 `.dsh-tmp/`、`*.log`；`:21-25` 覆盖 `backups/`、`dev-notes/`。
- 实测 `backups/`、`dev-notes/` 未被 git 跟踪（真名内容仅在本机，见 M1 第 5 条）。
- `dist/`（78 文件，已用 `wechat` 验证扫描有效）、`client/`、`locale/`、`persona/`、`personas/`、`docs/`、`README/CHANGELOG/cordis.patch.yml` 均无真实昵称/真实 wxid/手机号/token/apikey 命中；`test/` 只用虚构名（`wxid_alice`/`wxid_bob`/`wxid_zhangsan`/`张三`）。

### P5 安装方式 A 与真实安装一致、可照做
- 实测 `~/.dsh/profiles/desktop/package.json:11`：`"dsh-wechat-persona": "link:C:/Users/<用户名>/OneDrive/…/dsh-wechat-persona"`；`:35` 的 `dsh.profile.bundles` 含 `"dsh-wechat-persona"` —— 与 `README.md:142-146` 完全对应。
- 实测 `~/.dsh/profiles/desktop/node_modules/dsh-wechat-persona` 为 **Junction** 指向仓库目录 → README 的 link 安装方式在 Windows 下实际可用。
- 实测 `~/.dsh/profiles/desktop/.dsh-wechat-persona/` 存在 → `README.md:163-167` 的 dataDir 实测落点真实。

### P6 「重载 vs 重启」要求有三处一致说明
`README.md:399-401`（本地代码更新后必须完全退出重开 DSH）、`docs/ACCEPTANCE.md:177`（`plugin_manager` 开关/启用不等于重新 import）、`AGENTS.md:28`（改 src 后插件开关关 2 秒再开以加载新 dist）三处一致，且与 Node 无热重载的宿主行为相符。安装/改配置后「重启 DSH」（`README.md:146`、`:154`、`docs/使用说明.md:96-98`）与调试期「完全退出重开」的区分也已写明。

### P7 数据落点与安全边界实现与文档一致
- `src/index.ts:329-331`（`workingDirectory → workspace → dataDir` 解析）、`src/core/persona-library.ts:451`（`join(dataDir,'personas')` 安装根）、`docs/ARCHITECTURE.md:57`、`README.md:163-167`、`docs/使用说明.md:395` 相互印证（仅措辞需统一，见 S8）。
- API 请求头 `x-dsh-wechat-persona: 1`：文档（`AGENTS.md:34`、`docs/ARCHITECTURE.md:58`、`docs/TEST-PLAN.md:45`）与 `src/server/api.ts` 实现一致；「不暴露局域网/仅回环」的安全边界在文档中明确（`docs/ARCHITECTURE.md:55-58`、`docs/ACCEPTANCE.md:131-136`）。

### P8 CHANGELOG 结构正确、0.2.1 条目存在
`CHANGELOG.md:7`「最新版本 0.2.1（2026-10-31）」、`:9` `## [0.2.1] - 2026-10-31`，与 `package.json:3` 一致；0.2.0（`:27`）按 Added/Changed/Fixed 分类，0.1.0（`:86`）为 MVP 基线；`:114` 含违规风险声明。仅 0.2.1 小节缺分类（S4）。

### P9 桌面通道前置条件文档齐全且三处一致
Windows 10/11、中文 OCR 安装与 `Get-WindowsCapability` 验证、≥1366×768 / 100%–150% 缩放、窗口标题「微信」、只开一个小号窗口、用户键鼠占用时让出（默认 5 秒）、`WXUIA_*` 调参表 —— `docs/CHANNELS.md:229-255`、`docs/使用说明.md:286-331`、`README.md:435-437` 三处内容一致；默认值 `userActivityIdleMs 5000`（`src/config.ts:389`）、`pauseSeconds 30`（`:390`）、`windowTitle '微信'`（`:388`）、`driverEnabled false`（`:391`）与文档写法一致。

### P10 风险与隐私边界声明完整、无鼓励违规表述
`README.md:10-15`（重要声明：违反微信协议、风险自担、仅小号、不做冒充/群发）、`docs/使用说明.md:5-9`、`:361-399`（防封 / 必须人工操作 / 数据隐私，含 `SHOT_DIR` 截图需清理）、`docs/CHANNELS.md:297-312`、`docs/ACCEPTANCE.md:131-136` 均有明确声明；未发现「绕过风控」「批量加好友」类表述。

## 附录 A：本机绝对路径泄漏完整清单（M2）

前缀均为 `C:\Users\<用户名>\OneDrive\文档\deepseek-harness\default-workspace\dsh-wechat-persona`。

**`scripts/pwsh/`（23 个 tracked .py）**：`patch-clickx.py:3`、`patch-cropdbg.py:2`、`patch-cropdbg2.py:2`、`patch-default.py:3`、`patch-gate.py:3`、`patch-guard-fix.py:2`、`patch-list-fallback.py:2`、`patch-list-retry.py:2`、`patch-list-scale.py:2`、`patch-list-score.py:2`、`patch-listpx.py:2`、`patch-namefilter.py:3`、`patch-opt.py:3`、`patch-send3.py:3`、`patch-title.py:3`、`patch-v41.py:3`、`patch-v42.py:3`、`patch-v4b.py:3`、`patch-v4c.py:3`、`patch-window-guard.py:2`、`recover.py:2`、`recover2.py:2`、`recover3.py:2`。

**`scripts/dev/`（11 个 tracked，另 2 个未跟踪）**：`fix-fallback-type.py:2`、`patch-current-chat.py:2`、`patch-current-chat2.py:2`、`patch-current-chat3.py:2`、`patch-engine-rows.py:3`、`patch-engine-trust.py:2`、`patch-preview-fallback.py:2`、`patch-stagger.py:2`、`patch-v4.py:3`、`sanitize.py:2`、`show-anchor.py:2`；未跟踪：`patch-bubble2.py:2`、`patch-clamp.py:2`。

**`src/`（2 个 tracked）**：`recover-encoding.py:2`、`restore-desktop.py:2-3`。

**合计：36 个 tracked 文件 + 2 个未跟踪文件。**

## 附录 B：发布前建议执行的自检（全部只读，不发消息/不装插件）

```powershell
cd dsh-wechat-persona
git grep -nE '好友A|好友B|好友C|<用户名>'          # 期望：无输出
git log -p --all -- . | Select-String -Pattern '好友A|好友B|好友C' -Encoding utf8   # 历史清理后应为空
git status --porcelain                              # 期望：无未提交改动（或确认已提交）
git ls-files | Select-String -Pattern '\.(bak|broken|exp|pyc)'                       # 期望：无实验产物
Test-Path LICENSE; Test-Path dist\index.js          # 期望：True / True（构建后）
Select-String -Path README.md,docs\使用说明.md -Pattern '0\.2\.0' -Encoding utf8    # 期望：无输出（M4）
Select-String -Path README.md,CHANGELOG.md -Pattern '29 个测试文件|388' -Encoding utf8 # 期望：无输出（M5）
```

> 注意：在 PowerShell 5.1 下读取 UTF-8 无 BOM 文件请显式加 `-Encoding UTF8`（本次审计即用 read 工具/显式 UTF-8 读取，避免 GBK 乱码）。

## 附录 C：本次未复核项（不构成通过结论）

1. `verify:api` 24/24、`docs/ACCEPTANCE.md` 中的人工验收勾选 —— 未运行测试/构建。
2. 「本机 DSH 桌面版 0.2.1-rc.3」（`README.md:337`、`docs/ACCEPTANCE.md:112`）—— 宿主在 `app.asar` 内，无法离线读取实际版本；`<DSH 安装目录>\version` 显示 `44.7.0`（Electron 壳版本，与 DSH 语义版本不同），未能佐证。
3. 宿主 `plugin_manager action=install_bundle` 的动作名与参数 —— 宿主代码在 asar 内不可读；`~/.dsh/profiles/desktop/.plugin-manager/logs/` 可证明 plugin_manager 确实执行过 git/pnpm 安装操作，但未记录动作名。
4. 桌面通道的真实微信发送/OCR 全链路 —— 按审计约束未操作微信。
5. `docs/CHANNELS.md:268-293` 的「真实环境验证清单 13 项」中标注 ⚠️ 的部分是否已实机验证 —— 无法从代码侧确认，建议维护者在发布说明中明确「哪些场景已实测、哪些仍是预期」。

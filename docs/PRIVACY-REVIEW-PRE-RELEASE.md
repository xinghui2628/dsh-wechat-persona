# 隐私与 Git 历史审计（发布前只读复核）

> 任务：task-18「隐私与 Git 历史审计」（发布前验收阶段）
> 仓库：`dsh-wechat-persona`（本地根目录以 `<REPO-ROOT>` 表示；origin 为公开 GitHub 仓库，URL 以 `<MASKED-REPO-URL>` 表示）
> 审计快照：分支 `feat/v3.0.0`，HEAD `c05a24a`（18 个本地未推送提交；master / origin/master 均为 `42a3caa`）
> 审计时间：2026-11-01 10:19–10:43（+08:00）
> 只读声明：本审计只使用 git 读取命令与只读扫描脚本；**未执行** `git add/commit/checkout/rewrite/filter-*/force-push/push`，未联网上传，未修改除本文件之外的任何文件。文中所有敏感值均打码为 `<MASKED-…>`，不出现真实原文。

---

## 0. 结论摘要（TL;DR）

1. **当前受跟踪工作树（281 个文件）**：真实姓名、含真实用户名的本机路径、真实手机号、真实邮箱、真实 wxid、密钥 —— **0 命中**。6 处邮箱均为 GitHub noreply 或 `example.com` 占位；手机号与 wxid 全部为合成样例。
2. **Git 历史（39 个可达提交 = 已推送 21 + 仅本地 18）**：唯一**确认敏感**项为 C-1 —— 1 个真实感中文姓名 `<MASKED-姓名>`，仅出现在 `docs/ACCEPTANCE.md` 的 1 行历史文本中，涉及 **2 个已推送提交**：`9db6c5b`（引入，且是 `v0.2.8` tag 的目标）与 `42a3caa`（master 最新）。当前工作树已替换为虚构名「测试甲」，但历史内容无法通过修改当前文件消除。
3. **已推送历史**中另有 1 项 **B-1**：`42a3caa` 版 `docs/HANDOFF-0.3.0.md` 含本机环境指纹（安装路径、屏幕分辨率、Node/Python 版本、代理端口、公开仓库/协作者状态）。当前 HEAD 版已泛化为占位符，但旧版本在历史中仍可读。
4. **已推送提交中不含**手机号、真实邮箱、真实 wxid、密钥、真实用户名路径；commit author/committer 全部为 GitHub noreply 身份。
5. **本地未跟踪真实数据（C 类，未入库）**：`.dsh-tmp/`、`dev-notes/`、`backups/` 含真实好友昵称、真实用户名与 **181 张真机聊天截图**。`.gitignore` 已覆盖、`git log` 证明从未提交；但仓库位于 OneDrive 同步目录，发布/备份/分享前必须清理或移出。
6. **关键判断**：C-1 已随提交进入公开仓库历史，**公开不可逆**——即使现在改写并 force push，旧提交仍可能通过 GitHub 缓存/搜索、其他克隆、OneDrive 版本历史、本机备份 bundle 被读到。是「保留历史 + 不再扩大暴露」还是「处理历史（局部重写）」，属于用户拍板事项（见 §6）。

---

## 1. 审计范围与方法

### 1.1 范围

| 对象 | 说明 |
|---|---|
| 当前工作树 | 全部 `git ls-files`（281 个）+ 未跟踪文件；排除 `.git/`、`node_modules/` |
| 全部 git 历史 | `git cat-file --batch-all-objects` 全对象（477 blob / 250 tree / 39 commit / 3 tag 对象，约 12.0 MB），含不可达对象 |
| refs | `refs/heads/*`、`refs/remotes/*`、`refs/tags/*`、packed-refs、reflog、stash（空） |
| 本地忽略目录 | `.dsh-tmp/`、`backups/`、`dev-notes/`、`dist/`（抽查 PII 类别与文件数，不逐条展开） |
| 备份 | `%TEMP%` 下的 git bundle（路径以 `<TEMP-PLACEHOLDER>/dsh-wp-backup/...` 表示） |

### 1.2 方法

- **字节级扫描**：Python 遍历文件 / `cat-file` 流，UTF-8 + GBK 双解码；分类正则：已知姓名值、引号内 2–4 字中文 + 上下文关键词（好友/昵称/姓名/备注等）、手机号、邮箱、wxid、`C:\Users\<段>`、私盘路径、密钥/token 形态。
- **可达性判定**：`git rev-list --all`（可达）、`git rev-list origin/master`（已推送）、逐提交 `git grep -l`；`git log -S` 定位引入/移除提交。
- **现有工具实测（只读）**：`node scripts/check-sensitive.mjs`、`node scripts/check-package.mjs`；已确认 `check-sensitive.mjs` 只调用 `git rev-parse/ls-files`，无写操作。
- **备份验证**：`git bundle verify`（通过，含完整历史）。

### 1.3 审计快照与动态性（重要）

审计期间仓库有**其他并行工作**在持续写入，工作树非干净，且快照在审计过程中变化。截至 2026-11-01 10:42 的快照：

```
HEAD c05a24a (feat/v3.0.0)   local_unpushed=18   tracked=281
 M client/client.js
 M scripts/ocr/engines.mjs
 M scripts/verify-api.mjs
 M src/config.ts
 M src/engine/engine.ts
 M src/server/api.ts
 M test/core/persona-market.test.ts
?? docs/OCR-REAL-DEVICE-TEST-PLAN.md
?? docs/PRE-RELEASE-INSTALL.md
?? scripts/ocr/analyze-errors.mjs
?? test/channels/desktop-id-stability.test.ts
```

本审计**不评估**这些并行改动的内容，也**不触碰**它们。任何 git 改写方案必须在**冻结状态**下执行（见 §5.2 前置条件）。另：用户任务书写「19 个本地提交」，实测为 **18** 个（`git rev-list origin/master..HEAD`），以实测为准。

---

## 2. 分类标准

| 等级 | 定义 | 处置 |
|---|---|---|
| **A 虚构 / 公开可保留** | 明确合成样例、占位符、公开署名（GitHub handle/noreply 邮箱）、白名单域名 | 保留；发布前复跑扫描确认 |
| **B 疑似真实、需用户判断** | 真实感环境信息/配置（安装路径、屏幕、版本、端口、仓库可见性/协作者状态），非直接身份标识 | 用户判断是否可接受；优先泛化 |
| **C 确认敏感、建议处理** | 真实姓名、真实好友昵称、私聊内容/截图、真实账号或含真实用户名的路径 | 必须处置（当前文件改 + 评估是否处理历史） |

判断口径（依任务书 2.1）：**无法确认是否虚构的，按可能的真实个人信息处理。**

---

## 3. 当前工作树结果（tracked 281）

扫描统计：772 个文件（tracked 281 / 未跟踪文本 305 / 本地忽略 302 等，二值文件 264）；tracked 文本合计约 5.44 MB。

| 编号 | 类别 | 等级 | 位置（file:line） | 现状 | 处置建议 |
|---|---|---|---|---|---|
| T-1 | 邮箱 | A | `CONTRIBUTORS.md:27`、`docs/HANDOFF-0.3.0.md:38`、`docs/RELEASE-GUIDE.md:76`、`test/core/ocr-pure.test.ts:170`、`test/core/persona-market.test.ts:583,713` | 2 处 `users.noreply.github.com`、4 处 `example.com`/URL userinfo 测试占位 | 保留 |
| T-2 | 手机号 | A | `docs/CONTRIBUTING.md:114`、`docs/OCR-BENCHMARK.md:43`、`scripts/check-package.mjs:342-347`、`scripts/check-sensitive.mjs:67-68`、`scripts/ocr/gen_corpus.py:9,564`、`test/core/ocr-pure.test.ts:167`、`test/fixtures/ocr-corpus/manifest.json:2573,2582` 及 `results/*.json` | 仅 5 种形态：`138****00/11`、`139****00`、`188****00/88`（全零/顺序占位） | 保留 |
| T-3 | wxid | A | `docs/QA-RELEASE-AUDIT.md:20,263`、`scripts/vm-agent.mjs:29,252`、`test/` 下 30 个测试文件（`wxid_alice/bob/zhangsan/stranger/unknown/place` 等） | 全部合成；另有 6 处 `wxid_unknown` 为代码常量 `WXID_ALLOW` 误报 | 保留 |
| T-4 | 本机路径占位 | A | `docs/HANDOFF-0.3.0.md:32`、`docs/PRIVACY.md:94`、`docs/QA-RELEASE-AUDIT.md:65,267,289` | 均为 `<用户名>` / `<你>` 占位 | 保留 |
| T-5 | 非用户目录路径 | A | `src/tools.ts:12`（他盘插件路径）、`docs/CHANNELS.md:79`（adb 示例）、`test/channels/helpers.ts:94`、`test/core/persona-market.test.ts:487` | 示例/假路径 | 保留 |
| T-6 | 虚构姓名 | A | `docs/ACCEPTANCE.md:269` 等 | 「测试甲」「张伟」「张三」类示例 | 保留 |
| T-7 | 环境配置（当前 HEAD） | A | `docs/HANDOFF-0.3.0.md`（当前版本） | 已泛化为占位符 | 发布包建议剔除该文件 |

- 当前 tracked 树 **C = 0，B = 0**（HANDOFF 当前版已泛化）。
- 现有扫描器实测：`node scripts/check-sensitive.mjs` → **212 个受跟踪文本文件，0 命中，exit 0**；`node scripts/check-package.mjs` → 通过，exit 0，但警告 7 个本地垃圾文件（`__pycache__/*.pyc`、`*.bak-*`）会被 `npm pack` 从开发目录带入，发布前需清理。
- 注意：`docs/RELEASE-CHECKLIST.md:33` 记录的「157 个文件」已过期（现为 212），建议更新。

---

## 4. Git 历史结果

### 4.1 历史构成

- 39 个可达提交：已推送 **21**（origin/master 祖先）+ 仅本地 **18**。
- reflog-only 提交 0；不可达对象仅 1 个 annotated tag 对象 `e79f420`（旧 `v0.2.3` tag 遗留；tagger 为 noreply，message 无敏感内容）。
- 39/39 提交 author/committer 均为同一 GitHub noreply 身份（公开昵称 Cosmo w，邮箱 `<MASKED-AUTHOR-EMAIL>`）；commit message 中无敏感信息。
- 对象规模：477 blobs / 250 trees / 39 commits / 3 tag objects，共 11,999,204 字节。

### 4.2 命中总表

| 编号 | 类别 | 等级 | 位置 | 涉及提交 | 推送状态 | 处置 |
|---|---|---|---|---|---|---|
| H-1 | 真实感姓名 | **C** | `docs/ACCEPTANCE.md` 历史行（对应当前树 :304 附近），见 §4.3 | `9db6c5b`（引入）、`42a3caa`（同内容） | **已推送** | 当前树已改「测试甲」；历史需用户决策 |
| H-2 | 环境指纹 | B | `docs/HANDOFF-0.3.0.md`（42a3caa 版）:20、:32-39、:53-57、:324-326、:380-382、:425 | `42a3caa` | 已推送 | 用户判断；当前版已泛化 |
| H-3 | 手机号 | A | 148 blob 命中 / 60 blob，均为 5 种合成形态 | 全部在仅本地提交 | 未推送 | 保留 |
| H-4 | wxid | A | 249 blob 命中 / 31 blob，全部合成 | 全部在仅本地提交 | 未推送 | 保留 |
| H-5 | 邮箱 | A | 11 blob 命中 / 10 blob：noreply、`example.com`；其余为 commit 对象 author 行 | 已推送（author 身份） | 已推送 | 保留 |
| H-6 | 真实好友名×2 / 真实用户名 / 疑似微信 ID / 密钥 | — | **0 命中**（全库字节级扫描） | — | — | 无需处置 |
| H-7 | tag 对象 | A | `v0.2.3`=`3565940`→`09512ed`；`v0.2.8`=`062aa10`→`9db6c5b`；tagger 均 noreply | 已推送（推断） | tag message 无敏感 | 见 §4.4 |
| H-8 | 不可达 tag | A | `e79f420`（旧 tag 对象，无敏感） | — | 本地 | 可在清理时删除 |

补充：全历史「引号内 2–4 字中文 + 好友/昵称/姓名/备注上下文」的广谱扫描（含不可达对象）候选 **0**。当前 tracked 树同类广谱扫描仅 1 个候选，为 `docs/ACCEPTANCE.md:269` 的虚构名（A 类）。即历史中除 C-1 外**无其他真实人名**。

### 4.3 C-1 详述（脱敏）

- **内容**：`docs/ACCEPTANCE.md` 在 `9db6c5b` 版本中有一段 v0.2.8 OCR 实测记录，其中原样写出 1 个真实感中文全名 `<MASKED-姓名>`（与「文件传输助手」「压测#100」等出现在同一段）。当前 HEAD 版本该处已替换为虚构名「测试甲」。
- **传播链**：`9db6c5b`（v0.2.8，tag 目标）→ `42a3caa`（master 最新；该提交只新增 HANDOFF，未改 ACCEPTANCE，故同 blob）→ 仅本地 18 提交以 `42a3caa` 为基；直到本地最老提交 `6eceaff` 才把姓名改成虚构名。
- **命中规模**：全对象扫描中，含该姓名的 blob **恰好 1 个**（即该文件当时版本），映射到且仅映射到上述 **2 个提交**；两者均为 origin/master 祖先。
- **为何「改当前文件」不够**：git 历史对象不可变；任何 clone、GitHub 旧提交/旧代码视图、按 SHA 直链都能读到旧内容；`v0.2.8` tag 直接指向含姓名的 `9db6c5b`。
- **公开性推断**：`master` 与 `origin/master` 同 SHA、且 HANDOFF 记录了 push/`git push origin v0.2.8` 流程，推断含姓名提交**已公开**；tag 是否已推送到 GitHub 无法离线确认（需联网 `git ls-remote` 或查 GitHub tags 页）。

### 4.4 暴露面分析

| 渠道 | 分析 | 离线可确认 |
|---|---|---|
| git push / 公开仓库 | 已推送分支历史含 H-1；任何访客可 clone/浏览 | 是 |
| tag / Release | `v0.2.8` tag（若已推送）指向含姓名提交；**不要**为 v0.2.8 创建 Release；`v0.2.3` pre-release 指向 `09512ed`（不含姓名，安全） | tag 推送状态**否**，需用户核实 |
| fork / clone | 任何历史 fork 永久保留旧历史；本机其他 clone 同样；无法离线枚举 | 否 |
| PR / issue 缓存 | 仓库当前无本地 PR refs；若曾从含姓名提交开过 PR，关闭后 diff 缓存仍可能保留 | 否（需 GitHub UI） |
| GitHub 缓存 / 搜索 | force push 后旧提交仍可能通过 SHA 直链访问，直到 GitHub 清理；GitHub 文档对敏感数据（尤其凭据）提供联系 Support 清除缓存视图的协助，**个人姓名是否受理需 Support 确认，无保证** | 部分 |
| Actions / artifact | CI 无 `upload-artifact`，无数据外带 | 是 |
| npm registry | `package.json` `private: true`，未发布 npm；无 registry tarball 风险（若曾手动发布需另行确认） | 是 |
| 本机 / OneDrive | 仓库在 OneDrive 同步目录，OneDrive **版本历史**可能保留旧 `.git` 副本；`%TEMP%` 备份 bundle 同样含含姓名旧历史（2.43 MB，`verify` 通过） | 是（建议清理） |
| 第三方镜像 | Software Heritage / GH Archive 等可能已抓取（GH Archive 只记录事件/SHA，不含内容；镜像是否抓取未知） | 否 |
| 其他克隆 | 用户其他机器/协作者 clone 无法控制 | 否 |

---

## 5. 方案对比：保留历史 vs 处理历史

### 5.1 方案 A —— 保留历史（不 rewrite）

**做法**：当前及未来版本保持脱敏（已做）；不推 `v0.2.8` tag（若未推）、不为旧版本建 Release、发布说明不引用旧 SHA；如需，将仓库转 Private / 改名（仅减少新增暴露，**不消除**已公开缓存/克隆）。

**风险**：`<MASKED-姓名>` 永久留在公开 git 历史，可被 clone、搜索、镜像；若属真实第三方好友的 PII，伦理与合规风险持续存在。

**影响**：0 操作风险；18 个本地提交不受影响；无需 GitHub Support；不阻塞 v0.3.0 发布。适用条件：用户确认该姓名非真实/已获同意，或明确不愿 force push。

### 5.2 方案 B —— 处理历史（局部重写 master 之上 2 个提交 + 重建 tag + rebase 本地 18 提交）

> 以下仅为**预案**，本审计不执行。所有命令中的 `<MASKED-姓名>` 指代真实值，实际执行时由用户填入。

**前置条件（缺一不可）**
1. 用户确认拥有仓库 force push 权限并接受改写公开历史；
2. 工作树冻结：当前有并行未提交改动（§1.3），必须先完成或 stash（stash 仅本地，勿推送）；
3. 备份：复制现有 bundle 到离线安全位置并 `git bundle verify`；建议同时生成新的 `git bundle create <路径> --all`；
4. 确认 `v0.2.8` tag 是否已推送（决定 tag 强制更新范围）；
5. 通知协作者/其他 clone 在改写后重新 clone（旧 clone 的推送会造成旧历史回流）。

**步骤（预案）**
1. 冻结并记录基线：`git rev-parse HEAD`（应为 `c05a24a`）、`git rev-parse master origin/master`、`git rev-parse v0.2.8^{commit}`（应为 `9db6c5b`）；
2. 本地保护引用（仅本地、事后删除）：`git branch backup/pre-rewrite-master master`、`git branch backup/pre-rewrite-feat feat/v3.0.0`、`git tag backup/pre-rewrite-v0.2.8 v0.2.8`；
3. 重写 master 顶部 2 个提交：`git switch -c tmp/rewrite master`；`git rebase -i f285c05`（`9db6c5b` 的父提交），在 `9db6c5b` 处 `edit`，把 `docs/ACCEPTANCE.md` 中 `<MASKED-姓名>` 改为「测试甲」，`git commit --amend --no-edit`，`git rebase --continue`（`42a3caa` 无冲突自动重放）；
   - 备选：`git filter-repo --path docs/ACCEPTANCE.md --replace-text`（影响面更大，本方案不推荐；如用需先装工具并先做 dry-run）；
4. 重建 tag（保留原 message 与 noreply tagger）：`git tag -f -a v0.2.8 <新9db6c5b> -m "v0.2.8 - OCR 双引擎投票（RapidOCR）+ 常用词字典纠错"`；
5. 重放本地 18 提交：`git rebase --onto master 42a3caa feat/v3.0.0`；**冲突仅 `6eceaff`**（该提交把 ACCEPTANCE 中姓名改为虚构名，基线已是虚构名）。解决方式：保留 rebase 基线中已脱敏的文本，其余 6 个文件的 hunk 正常保留 → `git add docs/ACCEPTANCE.md` → `git rebase --continue`；
6. 只读验证：旧姓名 `git grep -F '<MASKED-姓名>' $(git rev-list --all)` 应为空；`git log --oneline origin/master..feat/v3.0.0` 仍 18 条；`git diff c05a24a feat/v3.0.0` 应为空（证明代码内容零丢失）；`git rev-parse v0.2.8^{commit}` = 新 `9db6c5b'`；
7. 本地验证：`npm run typecheck` / `npm run test:sandbox`（按发布流程，可选）；
8. 发布（**用户操作**）：先 `git push --force-with-lease origin master`，再 `git push --force origin refs/tags/v0.2.8`，确认 GitHub 显示正确后，最后 `git push origin feat/v3.0.0`（首次推送本地 18 提交）。
   - **顺序关键**：绝不可先推 `feat/v3.0.0` —— 其父链仍含 `42a3caa`，会把姓名重新推回远端；
9. 善后：删除 `backup/*` 本地引用；`git reflog expire --expire=now --all && git gc --prune=now`；清理 `%TEMP%` bundle 与 OneDrive 版本历史；如需清除 GitHub 缓存/搜索索引，由用户联系 Support（附旧 SHA 列表与说明）。

**会改变哪些提交**
- master 侧：`9db6c5b`、`42a3caa` 共 **2 个**（SHA 全变）；其祖先 `f285c05` 及更早 19 个提交不变（含 `v0.2.3` tag 的 `09512ed`）。
- `v0.2.8` tag 对象 `062aa10` 重建（指向新提交）。
- feat 侧：18 个本地提交因父链改变**全部获得新 SHA**；仅 `6eceaff` 需人工解决冲突，其余自动重放；新 tip 树与 `c05a24a` 树应完全一致（验证命令见第 6 步）。

**风险**
- force push 覆盖远端 master：若有协作者基于旧 master 工作，其后续 push 会把旧历史带回；
- tag 强制更新：旧 clone 中的旧 tag 不再匹配；
- GitHub 缓存/搜索仍可见旧内容，需 Support（且不保证）；
- 操作失误可能损坏本地历史 —— bundle + 本地备份分支兜底；
- 审计期间工作树有并行改动，必须在冻结后执行。

**回滚**
- 本地：`git reset --hard c05a24a`；`git branch -f master 42a3caa`；`git tag -f v0.2.8 062aa10`；或从 bundle 恢复 `git fetch <bundle> refs/heads/feat/v3.0.0:refs/heads/feat/v3.0.0 --force`；
- 远端：再次 force push 回旧 SHA（若 GitHub 尚未 GC 旧对象；否则用 bundle push 恢复）。

**不丢代码的恢复手段**
- 现有 bundle（含完整历史，`git bundle verify` 通过）+ 步骤 2 的本地备份分支/tag + 步骤 6 的树等价验证；建议改写前在独立临时目录 `git clone <repo> <tmp>` 并验证 bundle 可读。

### 5.3 两方案对比

| 维度 | A 保留历史 | B 局部重写 |
|---|---|---|
| 隐私暴露 | 永久保留（可 clone/搜索） | 分支/tag 视图清除；旧对象仍可能被缓存/克隆读到 |
| 操作风险 | 极低 | 中（force push、tag 强制更新、冲突解决） |
| 操作复杂度 | 无 | 中高（需冻结、备份、验证、协调） |
| 对 18 本地提交影响 | 无 | SHA 全变，内容不变（1 处冲突解决） |
| 对公开仓库影响 | 无 | 改写 2 个已推送提交 + tag；需 force push |
| GitHub Support | 不需要 | 建议联系清除缓存（不保证） |
| 回滚难度 | — | 低（bundle/备份分支） |
| 是否阻塞发布 | 否 | 是（须在推 v3.0.0 前完成） |

### 5.4 其他可选动作（非二选一）

- 仓库转 Private / 改名 / 删库重建：均**不能**收回已被克隆/缓存的内容；删库重建还会丢失 issue/PR/star 等；效果有限，仅减少后续曝光。
- 联系 GitHub Support：可请求清除旧提交缓存/搜索索引；是否受理（尤其非凭据类个人数据）由 GitHub 决定，无离线保证。
- 第三方镜像移除：如 Software Heritage 抓取过，需按其流程申请。

---

## 6. 需用户拍板事项

| 编号 | 事项 | 选项 | 建议 | 影响 |
|---|---|---|---|---|
| D-1 | 是否处理历史 | A 保留 / B 局部重写 | 若 `<MASKED-姓名>` 属真实第三方好友的 PII → **建议 B**；若为本人姓名或已获同意 → A 可接受 | 决定是否 force push |
| D-2 | 若 B：是否接受 force push + tag 强制更新 | 接受 / 不接受 | 接受前先确认协作与备份 | 公开历史改写 |
| D-3 | `v0.2.8` tag 是否已推送 | 是 / 否 / 待查 | 用户联网查 GitHub tags 页或 `git ls-remote origin` | 决定 tag 暴露面与是否强制更新 |
| D-4 | 本地真实数据处置 | 移出/删除/保留 | 发布前移出仓库目录或加密单存；清理 OneDrive 版本历史 | `.dsh-tmp/`（107 文件 PII + 181 截图）、`dev-notes/`、`backups/` |
| D-5 | 是否联系 GitHub Support 清缓存 | 是 / 否 | 若选 B 且在意残留 → 是 | 不保证受理 |
| D-6 | 是否将仓库转 Private/改名 | 是 / 否 | 如需减少后续曝光可考虑，但不替代 B | 不消除旧历史 |
| D-7 | 发布门禁：v0.3.0 是否必须先完成 D-1 | 是 / 否 | 建议是（否则 v3.0.0 会继续携带旧父链） | 发布时序 |
| D-8 | 全局 git 配置中的真实个人邮箱 | 维持 / 修改 | 该邮箱仅在本机全局配置，未入本仓库历史（repo 级 noreply 覆盖生效）；发布提交前再次确认 author 为 noreply 即可 | 后续提交匿名性 |

---

## 7. 加固建议

1. **发布前复扫**：冻结后复跑 `node scripts/check-sensitive.mjs`（212 文件）与 `node scripts/check-package.mjs`，并清理其警告的 7 个本地垃圾文件（`__pycache__/*.pyc`、`*.bak-*`），避免 `npm pack` 带入。
2. **扫描规则**：现有 `scripts/check-sensitive.mjs` 已覆盖 wxid/路径/手机/邮箱/密钥/疑似姓名；建议 CI 增加 gitleaks 作为第二道门禁；`.gitignore` 已含 v3 增补（`data/`、`shots/`、`*.sent.json`、`*uia-state.json`、`.env*`、`coverage/`、`*.zip`、`*.7z`、`test/fixtures/ocr-corpus/results/derived/` 等），可再补 `*.bundle`、`*.orig`、`*.rej`、`*.tmp`、`npm-debug.log*`、`*.pem`、`*.key`。
3. **发布包**：`package.json` 的 `files` 含 `docs`，会打包 `docs/HANDOFF-0.3.0.md`（当前版本已泛化，但含运营信息）——发布前评估是否剔除该文件。
4. **本地真实数据**：`.dsh-tmp/`（PII 文件 107 个、真机聊天截图 181 张、约 24.9 MB）、`dev-notes/`（5 个含真实名）、`backups/`（2 个含真实名/用户名）从未入库，但位于 OneDrive 同步目录；发布/分享/备份前清理或移出。
5. **文档 SHA 引用**：若执行方案 B，需同步更新 `docs/HANDOFF-0.3.0.md:21,34`、`docs/SPEC-COMPLIANCE.md:32,172,178`、`docs/V3-AUDIT.md:63`、`docs/RELEASE-CHECKLIST.md:33`（157→212）中的旧 SHA/数字。
6. **工具与流程**：`check-sensitive.mjs` 输出已打码，保持该约定；发布清单增加「git 历史敏感复核」勾选项（本报告 §4 可作为基线）。

---

## 8. 审计局限与不确定性

- 未联网：**无法**确认 `v0.2.8`/`v0.2.3` tag 是否已推送到 GitHub、是否存在 fork/PR、Release 资产内容、GitHub 缓存与搜索索引状态。需用户用 GitHub UI 或 `git ls-remote origin` 核实。
- GitHub 缓存/搜索清理行为随时间与策略变化；Support 是否受理个人数据请求未知。
- 审计期间工作树非干净且持续变化（§1.3）；所有数字基于 2026-11-01 10:42 快照，发布前需在冻结状态复扫。
- 未审计 `dataDir` 运行时真实数据内容（按 `docs/PRIVACY.md` 属本地个人数据、不入库）；如需清点可另做只读检查。
- 用户任务书写「19 个本地提交」，实测 18。

---

## 9. 证据索引（file:line）与数字汇总

**证据（均为脱敏描述）**
- `docs/ACCEPTANCE.md`: 当前树 :302（OCR 实现说明）、:304（已改为「测试甲」）、:269（虚构名）；历史版本 :304 对应 C-1。
- `scripts/check-sensitive.mjs`（只读扫描器）；`scripts/check-package.mjs`；`test/fixtures/ocr-corpus/gen_corpus.py:3-9,979,986`（合成声明与固定 seed）。
- `docs/RELEASE-CHECKLIST.md:33`（157 文件，过期）；`docs/V3-AUDIT.md:63`（已脱敏记录 9db6c5b 姓名问题）；`docs/SPEC-COMPLIANCE.md:172,178`（残余风险与决策项）。
- `docs/HANDOFF-0.3.0.md`（42a3caa 版）:20、:32-39、:53-57、:324-326、:380-382、:425。
- `docs/PRIVACY.md:94,101`；`CONTRIBUTORS.md:27`；`docs/RELEASE-GUIDE.md:76`；`docs/QA-RELEASE-AUDIT.md:20,65,263,267,289`。
- `src/tools.ts:12`；`docs/CHANNELS.md:79`；`test/channels/helpers.ts:94`；`test/core/persona-market.test.ts:487,583,713`；`test/core/ocr-pure.test.ts:167,170`。
- `.gitignore`（v3 增补项 + 原有忽略项）；`package.json`（`private:true` 与 `files` 列表）。

**数字汇总**
- 当前树：`git ls-files`=281；扫描文件 772；tracked 文本约 5.44 MB；tracked PII 命中 C/B=0；邮箱 6 处（全 A）；`check-sensitive` 212 文件 0 命中。
- git：可达提交 39（已推送 21 / 本地 18）；blob 477；tree 250；tag 对象 3；reflog-only 提交 0；不可达对象 1。
- 历史命中：C=1 项（1 个姓名 / 1 个 blob / 2 个已推送提交）；B=1 项（42a3caa 版 HANDOFF）；A≈4 类（合成手机号 148 blob、合成 wxid 249 blob、白名单邮箱、占位路径/虚构名/合成语料）；真实好友名、真实用户名、微信 ID、密钥、真实手机号、真实邮箱均为 0。
- 本地未跟踪 C 类：`.dsh-tmp/`（107 文件 PII、181 张真机截图、约 24.9 MB）、`dev-notes/`（5 文件）、`backups/`（2 文件）——均未入库。
- tag：`v0.2.3`=`3565940`→`09512ed`（无敏感）；`v0.2.8`=`062aa10`→`9db6c5b`（C-1 目标）；两者 tagger 均为 noreply。

---

*本报告为只读审计产物，未提交、未推送；审计员：privacy-auditor（task-18）。*

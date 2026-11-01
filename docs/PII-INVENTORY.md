# PII 去向盘点与本地数据处置建议（v3.0.0 发布前只读审计）

> 关联任务：task-21（隐私整改轮 A/C 前置盘点）。关联文档：[HISTORY-PRIVACY-ANALYSIS.md](HISTORY-PRIVACY-ANALYSIS.md)、[PRIVACY.md](PRIVACY.md)、[PRIVACY-REVIEW-PRE-RELEASE.md](PRIVACY-REVIEW-PRE-RELEASE.md)。
> 审计性质：**只读**。未删除/移动/重命名/上传/同步任何文件；未读取或输出聊天正文、截图内容、联系人姓名；只统计元数据（数量/大小/类型/时间/忽略状态/校验和）。
> 敏感值一律以 `<MASKED-…>` 表示；仓库内路径为相对路径，仓库外路径使用占位目录。

## 0. 结论摘要

1. **受跟踪工作树（tracked）当前干净**：290 个文件 / 5,945,423 B；自带扫描器 `scripts/check-sensitive.mjs` 扫描 212 个受跟踪文本文件，**0 命中**（exit 0）；`check-package` 通过（exit 0）。当前 tracked 树无真实姓名、真实用户名路径、真实手机号、真实邮箱、密钥。
2. **真实 PII 集中在未跟踪/仓库外位置**：`.dsh-tmp/`（181 张真机聊天截图 + 含真实姓名的配置/脚本）、`%TEMP%`（7,722 张微信截图，约 2.38 GB；22 个日志）、运行数据目录（聊天记忆/审计日志/未发送草稿/共享 token）、备份 bundle（含“含姓名旧历史”）。
3. **仓库位于 OneDrive 同步根内**：`.gitignore` 只能阻止 git 跟踪，**不能阻止 OneDrive 同步**；`.dsh-tmp/`、`dev-notes/`、`backups/` 在同步范围内。离线无法确认云端副本、版本历史、回收站与共享链接；**删除本地 ≠ 删除云端**。
4. 建议按 A（保留并安全隔离）/ B（脱敏后保留）/ C（经用户批准后删除）分类处置；本轮只出方案，**不执行**。待用户拍板事项见 §8。

## 1. 快照与方法

- 仓库根：`<REPO-ROOT>`（位于 OneDrive 同步根 `<ONEDRIVE-ROOT>` 之下；`OneDrive`/`OneDriveConsumer` 环境变量均指向该根）。
- 采样时间：2026-11-01 11:24–11:32（Asia/Shanghai）。HEAD=`2823439`（分支 `feat/v3.0.0`）；本地未推送提交 21 个；`origin/master`=`42a3caa`；tracked 290 文件 / 5,945,423 B。
- 工作树为**动态快照**（其他成员在并发修改）：采样期间出现过未提交改动 `M CHANGELOG.md`、`M README.md`、`M src/core/persona-market.ts`、`M src/engine/engine.ts`、`M src/server/api.ts`，以及未跟踪文件 `docs/V3-PRIVACY-AND-DEVICE-READINESS.md`。本文数字为采样值。
- 方法：Git plumbing 只读命令（`rev-parse`/`rev-list`/`ls-files`/`cat-file`/`fsck`/`bundle verify`）；`Get-ChildItem` 仅取元数据；Python 逐字节扫描（UTF-8 / GBK / UTF-16LE 三种解码）；SHA-256；运行仓库自带且已核只读的 `scripts/check-sensitive.mjs`、`scripts/check-package.mjs`。
- 隐私边界：**未打开任何聊天截图、未读取聊天记录/联系人姓名/日志正文**；运行数据目录只列文件名与大小（其中 `api-token` 未读取内容）。

## 2. 盘点总表

| 编号 | 位置（脱敏） | 文件数 | 大小 | git 跟踪 | .gitignore | 在 OneDrive 同步范围 | 敏感内容类别 | 处置等级 |
|---|---|---:|---:|---|---|---|---|---|
| L-1 | 仓库受跟踪工作树 | 290 | 5,945,423 B | 全部 tracked | — | 是 | 无真实 PII（仅 A 类合成占位） | **A** |
| L-2 | `<REPO-ROOT>/.dsh-tmp/` | 361 | 26,141,720 B | 0 | `.gitignore:18` | 是 | 真机聊天截图 181 张；真实姓名/用户名/wxid 的配置与脚本 | **C**（或 A，须移出同步范围） |
| L-3 | `.dsh-tmp/shots/` | 173 | 24,816,919 B | 0 | `.gitignore:18` 覆盖 | 是 | 微信窗口截图（OCR 输入） | **C** |
| L-4 | `<REPO-ROOT>/dev-notes/` | 6 | 20,509 B | 0 | `.gitignore:23` | 是 | 真实姓名/用户名（调试日志与配置） | **C/B** |
| L-5 | `<REPO-ROOT>/backups/` | 11 | 68,609 B | 0 | `.gitignore:22` | 是 | 真实姓名/用户名（补丁与包快照） | **C/B** |
| L-6 | `<TEMP-DIR>/wxuia-list-*.png` | 7,722 | 2,375,968,808 B | 否 | — | **否** | 真机微信会话列表/聊天窗口截图 | **C** |
| L-7 | `<TEMP-DIR>/wxuia-*.log` | 22 | 391,573 B | 否 | — | 否 | OCR/执行日志（可能含聊天文本） | **C** |
| L-8 | `<TEMP-DIR>/wxuia-*.{ps1,cjs,mjs}` | 14 | 95,049 B | 否 | — | 否 | 本地自动化/补丁脚本（可能含路径/会话） | **B** |
| L-9 | `<TEMP-DIR>/wxuia-*.png`（非列表截图） | 1 | 1,101,632 B | 否 | — | 否 | 单张微信截图 | **C** |
| L-10 | `<TEMP-DIR>/dsh-wechat-persona-debug.log` | 1 | 64,890 B | 否 | — | 否 | 插件调试日志（OCR/点击记录） | **C** |
| L-11 | `<TEMP-DIR>/dsh-wechat-persona-sent.json` | 1 | 373 B | 否 | — | 否 | 发送去重状态（联系人 id 指纹/时间） | **B** |
| L-12 | `<USER-HOME>/.dsh/profiles/desktop/.dsh-wechat-persona/` | 14 | 137,624 B | 否 | n/a（仓库外） | **否** | 聊天记忆、审计日志（联系人 id/昵称）、未发送草稿、uia 状态（含待重放聊天片段）、共享 token | **A**（运行必需；访问控制） |
| L-13 | `<TEMP-DIR>/dsh-wp-backup/` | 3 | 2,434,908 B | 否 | — | **否** | 备份 bundle：含 master 旧历史（含 `<MASKED-NAME>` 的公开提交）+ 18 个本地提交 | **A**（恢复用；按敏感备份保管） |
| L-14 | `.git` 历史（42 可达提交） | — | 对象 518 blob/275 tree/43 commit/3 tag | 是（历史） | — | 是（随 .git 同步可能） | 1 个 blob / 2 个已推送提交含 `<MASKED-NAME>`；无真实好友名/用户名/wxid/密钥 | 见 HISTORY 文档（**B/决策**） |

> 等级定义：**A**=保留并安全隔离；**B**=脱敏后保留可作测试样本；**C**=经用户单独批准后删除（先备份再删）。C/B 表示“建议以 C 为主，若确有测试价值可降为 B”。

## 3. 逐项说明

### 3.1 仓库受跟踪工作树（L-1，A）
- `node scripts/check-sensitive.mjs`：**212 个受跟踪文本文件，0 命中，exit 0**（与任务书 §0 的 212 口径一致）。
- 合成占位实测（仅分类计数，不展开原值）：手机号 71 处（全零/顺序占位）、wxid 108 处（`wxid_alice`/`wxid_bob` 类合成值）、邮箱 8 处（`example.com` 与 GitHub noreply 白名单）、Windows 用户路径 1 处（用户名段为占位符）、虚构名「测试甲」10 处；`CITATION.cff`/`CONTRIBUTORS.md` 含公开 GitHub 署名（公开身份，非隐私泄漏）。
- 结论：tracked 树 **C=0、B=0**，可保留（A）。发布包检查：`check-package` 通过（exit 0），仅告警 8 个本地忽略垃圾（4 个 `__pycache__/*.pyc` + 4 个 `scripts/pwsh/wechat-uia.ps1.bak-*`）；`npm pack` 直接从开发目录打包会带入，须按 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) §6.4 用 git 受跟踪文件建包。

### 3.2 `.dsh-tmp/`（L-2/L-3，建议 C；若保留则必须移出 OneDrive）
- 元数据：361 文件 / 26,141,720 B（约 24.9 MiB）；扩展名 `.png:181`、`.py:117`、`.ps1:29`、`.json:17`、`.bak:7`、`.txt:2`、其他 8；顶层 `shots/` 173 文件（24,816,919 B）、`dev-scratch/` 45、`memory-backup/` 5、`local-backups/` 4，根级 2 个文件（截图 + 探针脚本）。
- 内容类别（依据同会话早前的只读元数据扫描 2026-11-01 10:42/11:24）：107 个文件命中 PII 类别（本机用户名 73、真实姓名 44、疑似微信号 2、白名单邮箱 5）；含 181 张真机聊天窗口截图；`dev-scratch/` 中 `sanitize*.py`、`filter-names.py`、`fix-handoff-scan.py` 等脚本引用真实好友名、本机用户名与疑似微信 ID；`memory-backup/*.json` 含 `contactId`/`contactName`；`config-before*.json`、`config-prod-*.json` 的白名单是真实好友名。
- 风险：虽被 `.gitignore:18` 排除，但目录位于 OneDrive 同步根内 → 有被云同步/版本历史保留的可能。
- 建议：优先 **C**（经批准后删除）；若要保留研究价值则 **A**：整体移到非同步、受控的离线目录（加密更佳），移出后本仓库不再持有；`dev-scratch` 脚本如保留则先按 **B** 脱敏。

### 3.3 `dev-notes/`（L-4，C/B）
- 6 文件 / 20,509 B：`STATUS-20261031.md`、`STATUS-scheme-C.md`、`stress-20261031.json`、`cfg-current.json`、`dbg-send.txt`、`dbg-send2.txt`；其中 5 个在早前扫描命真实姓名/用户名（调试发送记录、当前配置快照）。
- 建议：日志类 **C**；配置类如确需保留先脱敏（**B**）并移出同步范围。

### 3.4 `backups/`（L-5，C/B）
- 11 文件 / 68,609 B，全部在 `pre-iter2/`（`.json:4`、`.ts:3`、`.yml:2`、`.jsonl:1`、`.md:1`）；`pre-iter2/profile-cordis.patch.yml:94` 与 `pre-iter2/profile-package.json` 含真实姓名/用户名。
- 建议：**B**（脱敏后保留）或 **C**（删除）；不要留在 OneDrive 同步范围。

### 3.5 `%TEMP%` 截图与日志（L-6~L-11，C）
- `wxuia-list-*.png`：**7,722 张 / 2,375,968,808 B（约 2.21 GiB）**，mtime 2026-10-31 12:49 – 2026-11-01 11:05（自动化实机验证期生成）。这些是真实微信会话列表/聊天窗口截图（OCR 输入）；[PRIVACY.md](PRIVACY.md):66 明确“截图和 OCR 图像不对外发送”，但本机仍需清理。
- `wxuia-*.log`：22 个 / 391,573 B（其中 `wxuia-test.log` 135,718 B），可能含 OCR 结果与聊天文本。
- `dsh-wechat-persona-debug.log`：64,890 B，OCR/点击调试记录。
- `dsh-wechat-persona-sent.json`：373 B，发送去重状态（含联系人 id 指纹与时间）。
- 建议：**C**（确认无自动化任务后删除，或移入离线加密盘）；`dsh-wechat-persona-sent.json` 可归 **B**；删除不可回滚（截图不可再生），删除前须用户确认。

### 3.6 运行数据目录（L-12，A 保留、访问控制）
- 位置 `<USER-HOME>/.dsh/profiles/desktop/.dsh-wechat-persona/`（**不在** OneDrive、不在仓库）。
- 14 文件 / 137,624 B：根 8 文件（`api-token` 33 B、`audit.jsonl` 116,944 B、`state.json` 5,873 B、`uia-state.json` 1,052 B、`drafts.jsonl` 913 B、`send-ledger.json` 282 B、`desktop-ack.json` 29 B、`list-preview.json` 27 B）+ `memory/`、`personas/` 子目录共 6 文件 / 14,471 B。
- 依据 [PRIVACY.md](PRIVACY.md):26-38、:48-49：`memory/` 每联系人记忆（最近消息/摘要/称呼偏好）、`audit.jsonl` 联系人 id/昵称与消息**元数据**、`uia-state.json` 含待重放聊天文本片段、`drafts.jsonl` 未发送回复正文、`desktop-ack.json` 含联系人名称、`api-token` 为共享 token 原文（secret）。
- 建议：**A** 保留（插件运行必需）；同时：(i) 不整体打包/上传/截图外发（PRIVACY.md:66 的外发白名单）；(ii) 若 `api-token` 曾出现在截图/共享文档/云端，应轮换（用户操作）；(iii) 不需要历史时可用插件清空入口清理 `memory/`、`audit.jsonl`。

### 3.7 备份 bundle（L-13，A 保留；按敏感备份管理）
- `<TEMP-DIR>/dsh-wp-backup/`：`v3.0.0-20261101-103304.bundle` 2,432,226 B、`manifest-20261101-103304.json` 461 B、`log-20261101-103304.txt` 2,221 B。
- SHA-256 `DB89EAB638B7A07A360300E0ABA038D0D2077F09D639A110E8F59AE17CFFB7D3`，与 manifest 记录一致；`git bundle verify` 通过（“The bundle records a complete history”）；list-heads 仅 `c05a24a`（feat/v3.0.0）；log 的 25 行 = 18 个本地提交 + 7 个 master 提交 → **含 master 祖先（因此含 9db6c5b 的姓名内容），这个备份本身属于敏感材料**。
- 缺口：bundle 创建于本地 18 提交时点（2026-11-01 10:33）；当前 HEAD `2823439` 已有 21 个本地提交，**bundle 比当前 HEAD 少 3 个本地提交**（`2823439`、`4fe7cfe`、`6b3b81a`；`6b3b81a` 由 unreachable 的 `8d6c92f` amend 而来）→ 现有备份**不能**完整恢复到当前 HEAD。
- 建议：**A** 保留用于回滚；不得上传/随发布包分发；任何历史重写前必须先经用户授权做新的全量镜像备份（见 HISTORY 文档 §7/§8）。

### 3.8 git 历史（L-14）
详见 [HISTORY-PRIVACY-ANALYSIS.md](HISTORY-PRIVACY-ANALYSIS.md)。本盘点只记录：全对象扫描中 `<MASKED-NAME>` 命中 **1 个 blob**，映射到且仅映射到 **2 个已推送提交**（`9db6c5b`、`42a3caa`，路径 `docs/ACCEPTANCE.md`）；真实好友名、本机用户名、疑似微信 ID、真实邮箱、密钥在**全部 git 对象**中均为 0 命中。

## 4. OneDrive 与云端副本分析

- 环境事实：`OneDrive`=`OneDriveConsumer`=`<ONEDRIVE-ROOT>`；仓库路径为其子目录；采样时 **OneDrive 进程数 = 0**；仓库文件属性为 `Archive`（普通本地文件，非云端占位/按需取回），目录属性 `Directory`。
- 判断：文件当前是**本地完整副本**；但
  1. 仓库处于同步范围，OneDrive 恢复运行/同步时会把仓库内容（含 `.git/` 旧历史、含 `.dsh-tmp/` 等被 git 忽略但未被 OneDrive 忽略的目录）上传；
  2. `.gitignore` 对 OneDrive 无效——发布前“清理工作树”不能替代“移出同步范围”；
  3. 离线**无法确认**：是否已同步过、云端版本历史/回收站/共享链接是否存在、删除本地后云端保留多久（常见版本历史保留约 30 天，取决于账户策略）。
- 结论：按“**可能有云端副本**”处理。用户须在 OneDrive 网页端核查（本任务不授权操作云端）；如云端已有含姓名的旧 `.git` 历史或截图，删除本地目录不等于删除云端副本。

## 5. check-sensitive / check-package 实测与盲区

### 5.1 实测（2026-11-01 11:31 左右）
- `node scripts/check-sensitive.mjs` → **扫描 212 个受跟踪文本文件，0 命中，exit 0**（任务书 §0 声称 212 文件 0 命中，复核一致）。
- `node scripts/check-package.mjs` → **通过，exit 0**；告警 8 个本地忽略垃圾（4 个 `__pycache__/*.pyc` + 4 个 `scripts/pwsh/wechat-uia.ps1.bak-*`）。包内容记录见 [PRE-RELEASE-INSTALL.md](PRE-RELEASE-INSTALL.md):46（188 文件 / 2,339,176 B；`private:true`）。

### 5.2 覆盖范围（代码级，`scripts/check-sensitive.mjs` 共 405 行）
- 扫描对象：仅 `git ls-files` 受跟踪文件；跳过前缀 `node_modules/`、`dist/`、`test/fixtures/ocr-corpus/images/`；跳过图片/压缩包/字体/媒体/二进制扩展名；前 8192 字节含 NUL 的文件跳过；>8MB 跳过；缺失文件跳过；**只按 UTF-8 解码**。
- 规则：`[wxid]`（白名单内放行）、`[本机路径]`（`X:\Users\<用户名>`，用户名以 `<`/`{`/`%`/`[` 开头视为占位放行）、`[手机号]`（`1[3-9]\d{9}`，白名单 6 个合成号）、`[真实邮箱]`（白名单 `users.noreply.github.com`/`noreply.github.com`/`example.com|org|net`）、`[密钥/Token]`（`sk-`、`ghp_`、`github_pat_`、`AKIA`、`BEGIN PRIVATE KEY`，占位放行）、`[疑似真实姓名]`（引号内 2–3 字中文+常见姓氏+上下文词 / 行内代码 `read X`/`-Contact X` / 关键词紧邻引号名）。
- 输出：maskSecret 打码 + 140 字符截断；exit 0/1/2；仅调用 `git rev-parse`、`git ls-files`（已核只读）。

### 5.3 盲区（本盘点结论，按风险排序）
1. **不扫 git 历史**：旧提交/旧 tag/不可达对象完全盲区——本次真实姓名问题正落在该盲区。
2. **不扫未跟踪/被忽略位置**：`.dsh-tmp/`、`dev-notes/`、`backups/`、`%TEMP%`、运行 `dataDir` 全部不扫，而本次最敏感的本地数据都在这些位置。
3. **图片全部跳过**：无法发现截图内 PII（联系人昵称、聊天正文、头像、二维码）、截图 EXIF、文件名中的姓名。
4. **压缩包与 >8MB 文件跳过**：zip/7z/大日志/大 JSON 可能携带 PII。
5. **仅 UTF-8**：GBK/UTF-16 编码文本或粘贴日志会漏。
6. **文件名不扫**：路径/文件名中的 wxid、姓名、手机号不检查。
7. **姓名启发式窄**：仅 2–3 字 + 引号 + 上下文 + 常见姓氏；4 字姓名、英文名、拼音、昵称、无引号名字会漏。
8. **路径只认 `X:\Users\`**：漏 `D:\...`、UNC `\\host\share`、`/home/user`、`%USERPROFILE%` 等。
9. **不扫 commit/tag message 与 author/committer 身份**；不扫 `.env`（未跟踪即不扫）。
10. **白名单依赖**：邮箱白名单若加入真实域名会漏；手机号白名单需持续维护；合成/真实值只有白名单区分。

### 5.4 建议（草案，本轮不改代码）
- 增加 `--all`（untracked + ignored，显式排除 `node_modules`）与 `--history`（`git rev-list --all` 逐提交扫描）模式；发布门禁两个模式都跑。
- 增加“文件名 + 尺寸 + 截图特征”启发式（如 ≥800×600 且 >50KB 的 png 列入待审清单）；压缩包只读清单扫描（不解压）。
- 增加 GBK/UTF-16 回退解码；扫描 EXIF/PNG 文本块。
- 姓名规则扩展到 4 字姓名、拉丁名/拼音与“文件中的联系人列表”上下文；路径规则补 UNC、`%USERPROFILE%`、`/home/`、盘符根下个人目录。
- CI 增加 `fetch-depth: 0` 的全历史扫描（`.github/workflows/ci.yml` 当前仅扫工作树）。
- 在发布清单中加入“截图/日志清理”手动步骤（见 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)）。

## 6. 处置方案 A/B/C（本轮只出方案，不执行）

### 6.1 定义
- **A 保留并安全隔离**：内容保留、功能不受影响，但移出同步/共享范围或做权限限制，内容不变。
- **B 脱敏后保留**：删除/替换真实姓名、wxid、本机路径、密钥等，保留结构与测试价值。
- **C 经用户单独批准后删除**：先做离线备份（加密），再删除；删除后核对 git/云端状态。

### 6.2 分项步骤/验证/回滚（草案）

| 对象 | 等级 | 前置条件 | 步骤 | 验证 | 回滚 |
|---|---|---|---|---|---|
| `.dsh-tmp/` | C（或 A） | 无自动化/引擎在运行；插件已暂停 | 整体移到非同步离线目录（加密）→ 确认无工具引用 → 经批准后删除 | `git status` 不变；目录计数归零；OneDrive 网页端未见残留（用户操作） | 从离线目录原样恢复 |
| `.dsh-tmp/shots/` 173 张截图 | C | 同上 | 同上（可先只移走截图） | 截图计数归零；插件回归测试不受影响 | 从离线备份恢复 |
| `dev-notes/` | C/B | 同上 | 日志类删除；配置类脱敏后保留 | 目录内无真实姓名（复扫） | 离线备份恢复 |
| `backups/` | C/B | 同上 | 同上 | 同上 | 离线备份恢复 |
| `%TEMP%/wxuia-list-*.png` 7,722 张 | C | 无引擎/自动化任务运行 | 删除（或整体移入离线加密盘） | 计数归零；微信自动化回归可重新生成合成截图 | 不可回滚（截图不可再生），删除前需用户确认 |
| `%TEMP%/wxuia-*.log`、`dsh-wechat-persona-debug.log` | C | 同上 | 删除 | 文件不存在 | 不可回滚 |
| `%TEMP%/wxuia-*.{ps1,cjs,mjs}`、`sent.json` | B | 同上 | 保留或删除；如保留先确认不含真实路径/姓名 | 复扫无 PII | 离线备份恢复 |
| 运行 `dataDir` | A | 插件运行中 | 不打包/不上传/不截图外发；限制目录权限；`api-token` 视暴露情况轮换 | 发布包（`npm pack`/`check-package`）不含 dataDir | 无需回滚（未改动） |
| 备份 bundle | A | 用户授权后可做新备份 | 保留旧 bundle；授权后新建全量镜像备份；旧 bundle 在确认新备份可用后再议清理 | `git bundle verify`、新备份 `git fsck` | 旧 bundle 保留即回滚源 |
| git 历史 | 见 HISTORY | 用户对历史方案拍板 | 见 HISTORY 文档 §6/§7（保留 vs 隔离镜像重写） | 见 HISTORY 文档 §7 | 见 HISTORY 文档 §8 |

### 6.3 本轮不执行声明
本轮**未删除、未移动、未重命名、未上传、未同步任何文件**；未触碰真实微信；未访问云端。§6.2 的所有删除/移动动作都需要用户逐项授权后另行执行。

## 7. 防复发加固建议（不改代码）

- `.gitignore` 建议增补（若未来可能入仓）：`*.bundle`、`*.orig`、`*.rej`、`*.tmp`、`*.sqlite*`、`*.eml`、`*.mbox`、`captures/`、`screenshots/`、`exports/`、`ocr-output/`。注意 `.gitignore` 不能解决 OneDrive 同步问题。
- **发布门禁**：发布前手动步骤加入“清理 `%TEMP%` 截图/日志、集中清理 `.dsh-tmp`”；发布包继续使用 git 受跟踪文件构建（`RELEASE-CHECKLIST` §6.4），避免 `npm pack` 从开发目录带入 `.pyc`/`.bak`。
- **CI**：`check-sensitive` 增加 `--history` 与 `--all` 两模式（另任务实现），并以 `fetch-depth: 0` 拉全历史；新增提交做增量扫描。
- **运行数据**：维持“数据在 `dataDir`、截图在 `%TEMP%`、发布包白名单”的隔离；把“截图/日志保留期限与清理”写入用户手册。

## 8. 待用户授权动作清单

| 编号 | 待拍板事项 | 建议 |
|---|---|---|
| D-1 | `<MASKED-NAME>` 是否为真实个人信息（确认后决定历史处理力度） | 按“疑似真实”先按 C 对待；确认虚构则降为 A 并记录依据 |
| D-2 | git 历史处理：方案 A（保留历史，仅当前树已修正）还是方案 B（隔离镜像演练重写，不推送） | 见 HISTORY 文档 §6；先演练、后决定 |
| D-3 | `.dsh-tmp/`（361 文件，含 181 张截图与真实姓名脚本）如何处置 | C（推荐）或 A（移出 OneDrive 并受控保留） |
| D-4 | `%TEMP%` 7,722 张截图 + 22 个日志 + debug.log 如何处置 | C（推荐）：确认后删除 |
| D-5 | `dev-notes/`、`backups/` 如何处置 | C 删除；如保留先脱敏（B）并移出同步范围 |
| D-6 | 运行 `dataDir`：是否清理 `memory/`、`audit.jsonl`、`drafts.jsonl`；`api-token` 是否需轮换 | 保留运行数据（A）；若曾外发则轮换 token |
| D-7 | 是否核查 OneDrive 云端副本/版本历史/回收站/共享链接 | 用户在网页端自行核查（本任务不操作云端） |
| D-8 | 是否授权新建全量镜像备份（当前 bundle 落后 3 个本地提交） | 任何历史操作前必须先做 |
| D-9 | 是否把“全历史扫描 + `--all` 本地扫描”纳入发布门禁/CI | 建议纳入（另任务实现） |

## 9. 局限与无法离线确认的事项

- 无法离线确认：GitHub 仓库当前可见性、tag 是否已推送、fork/PR/clone/第三方缓存、OneDrive 云端副本与版本历史、回收站是否清空；相关推断与证据强度见 HISTORY 文档。
- 工作树在采样期内被其他成员并发修改，数字为采样值；本盘点不改变任何文件。
- 未读取聊天正文/截图像素/日志文本，“敏感内容类别”依据文件名、目录语义与既有文档（[PRIVACY.md](PRIVACY.md)）判断；存在个别误判可能（例如某些截图可能来自合成语料——但按“无法确认即按可能真实处理”的原则，本次全部按真实 PII 对待）。
- 部分本地目录的 PII 明细计数引自此会话早前的只读扫描（2026-11-01 10:42/11:24），已在正文标注。

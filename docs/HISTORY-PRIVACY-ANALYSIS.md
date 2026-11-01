# Git 历史实名公开性分析与处置预案（v3.0.0 发布前只读审计）

> 关联任务：task-21（§2 历史实名公开性分析）。关联文档：[PII-INVENTORY.md](PII-INVENTORY.md)、[PRIVACY-REVIEW-PRE-RELEASE.md](PRIVACY-REVIEW-PRE-RELEASE.md)、[PRIVACY.md](PRIVACY.md)。
> 审计性质：**只读**。未执行任何 git 改写、force push、push、tag、reflog expire、gc；未访问云端、未联网；未删除/移动/重命名任何文件。
> 敏感值以 `<MASKED-…>` 表示；提交/对象标识只给短 SHA（SHA 本身不是秘密，但为最小化扩散，正文不展示敏感原文）。仓库外路径用占位目录。

## 0. 结论摘要

1. **唯一的历史实名命中**：`<MASKED-NAME>`（真实感中文姓名）出现在 **1 个 blob** 中，路径 `docs/ACCEPTANCE.md:304`，映射到**且仅映射到 2 个提交**：`9db6c5b`（引入）与 `42a3caa`（其后继，树中继承该 blob）。
2. 这 2 个提交**均已推送到 `origin/master`**（`git merge-base --is-ancestor` 判定为祖先）；且 **annotated tag `v0.2.8`（`062aa10`）指向 `9db6c5b`**——若该 tag 已推送，公开面从“commit 视图”扩大到“tag 视图”。
3. **当前工作树已修复**：本地提交 `6eceaff`（“docs: v3.0.0 阶段 A - 审计报告与隐私脱敏”）把该行改为虚构名「测试甲」；当前 HEAD `2823439` 的全对象/树扫描中该姓名 **0 命中**；`2823439` 对 `docs/ACCEPTANCE.md` 仅 ±2 行（4 行变更，未回填姓名）。
4. 分类：该姓名按 **C（确认敏感，按可能真实个人信息处理）** 对待——证据是行文为“本机实测：… 识别出 33 行中文（含「<MASKED-NAME>」「文件传输助手」「压测#100」等）”的 OCR 实机验收记录；但离线无法证明它是真实联系人、测试夹具还是虚构名，故按任务书原则“无法确认即按可能真实处理”。
5. 历史中**没有**其他真实人名/好友名/本机用户名/wxid/真实邮箱/手机号/密钥命中（全对象多编码字节扫描：上述类别 0 命中；合成手机号与合成 wxid 全部落在仅本地提交，且属 A 类占位）。
6. 建议：**先补建当前 HEAD 的全量备份**（现有 bundle 落后 3 个本地提交），**方案 B（隔离镜像重写）只作本地演练、不推送**，是否真正清洗远端由用户拍板（方案 A 也可发布，但公开仓库内姓名仍可被追溯到旧 SHA）。

## 1. 证据链（全部只读复核）

### 1.1 仓库与引用快照
- 仓库根 `<REPO-ROOT>`；remote origin `https://github.com/<维护者账号>/dsh-wechat-persona`；工作分支 `feat/v3.0.0`，HEAD **`2823439`**。
- refs：`refs/heads/feat/v3.0.0=2823439`、`refs/heads/master=42a3caa`、`refs/remotes/origin/master=42a3caa`、`refs/tags/v0.2.3=3565940`（annotated tag object → commit `09512ed`）、`refs/tags/v0.2.8=062aa10`（annotated tag object → commit `9db6c5b`）；无其他 refs、无 stash、无 notes。
- 提交规模：可达提交 **42**（已推送 21 + 仅本地 21）；全部对象：blob **518**、tree **275**、commit **43**（42 可达 + 1 unreachable `8d6c92f`）、annotated tag 对象 **3**（`3565940`、`062aa10`、dangling `e79f420`）；对象总字节 11,999,204。
- 签名：`tag_sig_hits=0`、`commit_signed_count=0`——**tag 与提交均未签名**（因此重写不会破坏签名验证）。
- `.git/packed-refs` 残留过期条目：`3b5b603 refs/heads/master`（旧 master tip；当前 master=42a3caa；`3b5b603` 仍是 HEAD 祖先——历史曾用 orphan 方式重建，见 HANDOFF:381）。
- reflog 34 条；不可达对象 `git fsck --unreachable --no-reflogs` = 11 行：blob 9 + commit 1（`8d6c92f`，即 `6b3b81a` amend 前的版本）+ tag 1（`e79f420`，旧 v0.2.3 tag 对象，指向 `3b5b603`）。
- 备份：`<TEMP-DIR>/dsh-wp-backup/v3.0.0-20261101-103304.bundle`（2,432,226 B，SHA-256 `DB89EAB6…`，`git bundle verify` 通过，heads 仅 `c05a24a`）——**只含到 `c05a24a` 的 18 个本地提交，落后当前 HEAD 3 个提交**（`2823439`、`4fe7cfe`、`6b3b81a`），且含 master 旧历史（因此含姓名），属敏感备份。

### 1.2 姓名命中的精确定位
| 项目 | 结果 |
|---|---|
| 命中 blob 数 | **1** |
| 命中内容 | `docs/ACCEPTANCE.md:304` 的 OCR 验收记录（v0.2.8 节），敏感原文已掩码：`- 本机实测：\`python scripts/py/rapid_ocr.py <窗口截图>\` 识别出 33 行中文（含「<MASKED-NAME>」「文件传输助手」「压测#100」等），耗时约 6.3s…` |
| 引入提交 | `9db6c5b`（提交说明：“feat: OCR 双引擎投票（RapidOCR）+ 常用词字典纠错，版本 0.2.8”） |
| 继承该 blob 的提交 | `42a3caa`（其树包含同一 blob；该提交本身只改 `docs/HANDOFF-0.3.0.md` +511 行） |
| 移除/替换提交 | `6eceaff`（本地最老提交：`.gitignore +11`、`docs/ACCEPTANCE.md ±2`、`HANDOFF 28`、`QA-RELEASE-AUDIT +1`、`V3-AUDIT +94`、`package.json 3`、`check-sensitive.mjs +398`；说明“v3.0.0 阶段 A - 审计报告与隐私脱敏”） |
| 当前 HEAD 树 | 0 命中；`ACCEPTANCE.md:304` 为「测试甲」版本 |
| 已推送判定 | `9db6c5b`、`42a3caa` 均为 `origin/master` 祖先（True）；`6eceaff` 及其后 21 个本地提交**未推送** |

### 1.3 逐提交扫描（`git grep -l` + `git ls-tree` 反查）
- 遍历全部 42 个可达提交的 tree：含该姓名的提交**恰好只有 2 个**（`9db6c5b`、`42a3caa`），其余 40 个提交（含全部本地提交）均 0 命中。
- 反查 blob→path→commit：该 blob 只对应 `docs/ACCEPTANCE.md` 一个路径；无第二份副本、无其他文件名/其他文档副本。
- `git log -S '<MASKED-NAME>'`：引入= `9db6c5b`；移除= `6eceaff`。commit message 中该姓名 0 命中。

### 1.4 全对象多编码字节扫描（UTF-8 / GBK / UTF-16LE）
- `<MASKED-NAME>`：仅 1 blob；commit/tree/tag 对象 0。
- 两位真实好友名（掩码 `<MASKED-FRIEND-A>`、`<MASKED-FRIEND-B>`）：**0**。
- 本机 Windows 用户名（掩码 `<MASKED-WIN-USER>`）：**0**（任何对象、任何编码）。
- 疑似微信 ID（掩码 `<MASKED-WX-GUESS>`）：**0**。
- 真实个人邮箱域名（outlook/163 等）：**0**。
- 密钥/Token（`sk-`/`ghp_`/`github_pat_`/`AKIA`/PRIVATE KEY/Bearer 长串）：**0**。
- 手机号：62 个 blob 命中，全部为合成占位（`138…00`、`188…88` 等 5 种），**全部落在仅本地提交**（已推送历史 0 个 blob 含手机号）。
- wxid：35 个 blob 命中，全部合成（`wxid_alice`/`wxid_bob`/`wxid_zhangsan` 类），其中 15 个在已推送历史、20 个仅本地——属 A 类（白名单合成值，非真实微信号）。
- 真实邮箱：12 个 blob 命中，域名分布为 `users.noreply.github.com`（GitHub noreply）、`example.com` 与保留测试域，全部白名单/合成；已推送的命中均为作者身份行（noreply）。
- 本机路径 `X:\Users\<真实用户名>`：2 个 blob 命中——1 个已推送的为**占位符**（`<用户名>`），1 个仅本地的为审计文档中展示的正则示例，均无真实用户名。
- 公开 handle（维护者/协作者 GitHub 账号，掩码 `<MASKED-HANDLE>`）：已推送历史 12 个 blob 命中、当前树 2 个文件——属公开署名（CITATION.cff、CONTRIBUTORS.md、HANDOFF 作者信息），非隐私泄漏。

### 1.5 tag 影响
- `refs/tags/v0.2.8` = annotated tag 对象 `062aa10` → target commit `9db6c5b`（**含姓名提交**）。若该 tag 已推送到 GitHub，则 tag 页面、`/releases/tag` 或 tag 的 commit 视图会直接呈现含姓名的文件内容。
- `refs/tags/v0.2.3` = annotated tag 对象 `3565940` → target commit `09512ed`（**不含姓名**，不受影响）。
- 两者 tag message 均无敏感内容；tagger 身份为 GitHub noreply（全历史 author/committer 统一为 `<MASKED-AUTHOR-EMAIL>`，无真实邮箱）。
- 离线无法确认 tag 是否已推送：HANDOFF:423 自述“tag 已推”、:326 记录了 `git push origin v0.2.8` 流程；GitHub 上 v0.2.3 有 pre-release 记录——按“**tag 很可能已公开**”处理（无法离线核实）。

### 1.6 不可达对象与旧引用
- `8d6c92f`（unreachable commit，`6b3b81a` 的 amend 前版本）：属本地开发产物，无姓名；除非未来做 `reflog expire --expire-unreachable=now && gc --prune=now`，否则不会被自动清理——**与历史清洗无关**，但排查时不要误以为它含敏感内容（扫描 0 命中）。
- `e79f420`（dangling tag 对象，旧 v0.2.3）：target `3b5b603`（旧 master tip，HEAD 祖先）；扫描 0 命中；不应对其做任何操作。
- `packed-refs` 过期 `3b5b603 refs/heads/master`：旧引用残留，不属于公开面（`3b5b603` 在新历史中仍是祖先，属正常 commit），无需处理。

### 1.7 文档中的旧 SHA 引用（若重写历史需同步更新）
- 引用 `9db6c5b` 的已跟踪文档：`docs/HANDOFF-0.3.0.md`、`docs/PRIVACY-REVIEW-PRE-RELEASE.md`、`docs/SPEC-COMPLIANCE.md`、`docs/V3-AUDIT.md`、`docs/V3-PRE-RELEASE-REVIEW.md`。
- 引用 `42a3caa`：`docs/PRIVACY-REVIEW-PRE-RELEASE.md`、`docs/SPEC-COMPLIANCE.md`、`docs/V3-AUDIT.md`、`docs/V3-PRE-RELEASE-REVIEW.md`。
- 引用 tag 对象 `062aa10`/`3565940`：`docs/PRIVACY-REVIEW-PRE-RELEASE.md`。
- 说明：这些引用是**说明性文本**，不是代码依赖；重写后若保留旧 SHA 会造成“文档引用一个已不存在的提交”，需改成新 SHA 或改为“旧 SHA 已废弃”的表述。

## 2. 分类与证据强度

### 2.1 分类标准（沿用任务书）
- **A（虚构/公开可保留）**：合成值、公开署名、白名单占位、无识别个人能力的内容。
- **B（疑似真实，需用户判断）**：可能对应真实个人/真实机器的信息，但识别性弱、无法离线证实。
- **C（确认敏感，建议处理）**：明确可能指向真实个人信息，且已进入公开面或高可识别。

### 2.2 分类结果
| 编号 | 对象 | 类别 | 证据强度 | 结论 |
|---|---|---|---|---|
| H-1 | `docs/ACCEPTANCE.md:304` 的 `<MASKED-NAME>`（1 blob / 2 已推送提交 / v0.2.8 tag 视图） | **C** | 强：明确姓名文本 + “本机实测”OCR 上下文 + 已推送 | 按可能真实个人信息处理；当前树已替换为虚构名；历史是否清洗待拍板 |
| H-2 | 已推送 `42a3caa:docs/HANDOFF-0.3.0.md` 的环境指纹（本机安装路径、屏幕 2048×1152 125%、Node/Python 版本、代理端口、仓库 Public/Collaborator 状态等） | **B** | 中：指向真实机器与真实维护流程，但非直接身份信息 | 当前 HEAD 版已泛化为占位符；历史版本仍可读；是否处理由用户判断 |
| H-3 | 公开 GitHub handle（`<MASKED-HANDLE>` 等）出现在 CITATION/contributor 文档与历史 | A | — | 公开署名，保留 |
| H-4 | 合成手机号（62 blob）、合成 wxid（35 blob）、白名单邮箱（12 blob）、占位路径 | A | — | 合成/白名单，保留 |
| H-5 | 真实个人邮箱仅出现在全局 git config（未入本仓库历史） | A（不入库） | — | 提醒：不要删除 repo 级覆盖（repo `user.email`=noreply）；未来提交前确认 `git config --local user.email` 生效 |
| H-6 | 历史中的作者/提交者身份全部为 noreply | A | — | 无真实邮箱泄漏 |

**历史侧计数**：C=1 项（H-1）；B=1 项（H-2）；A=4 类（H-3~H-6）；当前 tracked 树 C=0、B=0。命中 blob 总数=1（姓名），已推送提交=2，受影响 tag=1（v0.2.8）。

### 2.3 证据强度与“无法断定”的原因（诚实披露）
- 姓名文本本身不附带任何联系方式或身份证明；它出现在“本机实测 OCR 识别结果”的示例中，可能是：真实好友昵称、测试聊天对象、微信传输助手会话中的某条显示名，或作者为测试而写的虚构名。**离线无法证明是真实个人**，也无法证明已获得公开授权。
- 无法离线核实：GitHub 仓库当前可见性（HANDOFF 自述 Public，但 README 等文档强调的 `private:true` 仅指 npm 包，不指 GitHub）；v0.2.8/v0.2.3 tag 是否已推送；fork/PR/clone/第三方缓存/搜索引擎索引的现状。
- 因此：按“最保守假设”分类为 C，但用户若确认该名字为虚构（或已获本人同意公开），可降级为 A 并在发布说明中记录依据——**降级必须由用户书面确认，不由审计员自行决定**。

## 3. 公开面分析（push / tag / fork / PR / 缓存 / GitHub Support）

### 3.1 已确认的公开可达路径（离线可证）
- `9db6c5b`、`42a3caa` 是 `origin/master` 祖先 → 若远端是 public，则：
  1. 仓库提交历史/commit 页面可浏览；
  2. 任意持有该仓库读权限（public 即所有人）可 `git clone` 后 `git log -S` 检索；
  3. 通过旧 SHA 直接访问文件内容：`https://github.com/<owner>/<repo>/blob/<sha>/docs/ACCEPTANCE.md`（及 `raw.githubusercontent.com` 对应地址）——**即使当前分支已修复，旧 SHA 仍可解析**（直到对象被 GC 且无人引用）；
  4. GitHub 网页的“提交历史/blame/查看该提交的文件”视图同样呈现。
- 当前默认分支（若 master 公开且仍指向 `42a3caa`）的文件树**仍包含**该姓名——注意：当前工作树“已修复”只发生在 `feat/v3.0.0`（未推送）上；**远端 master 的 HEAD 仍是 `42a3caa`**，其 `docs/ACCEPTANCE.md` 含姓名。这是比“仅历史”更直接的暴露：**公开仓库的默认分支当前内容未修复**。
- tag：若 `v0.2.8` 已推送，tag 页/Release 关联视图指向 `9db6c5b`，同样可读。
- npm：`private:true`，未发布到 npm registry（发布包检查亦无 `.npmignore` 泄漏）；GitHub Releases 仅 v0.2.3 pre-release（HANDOFF:382），未含 v0.2.8 资产。

### 3.2 无法离线确认的公开面
- fork：public 仓库可被任何人 fork；fork 是**独立副本**，即使 upstream 改写历史/删除提交，fork 仍保留旧对象与旧 SHA。无法枚举 fork（需联网 GitHub API）。
- PR：无法离线确认是否存在来自该仓库分支的 PR/PR refs；若存在，PR 的 head/base 提交可能缓存旧提交。
- clone：任何曾 clone 的人/CI/镜像（含 OneDrive 云端版本历史里的 `.git`）都持有旧历史。
- 第三方缓存：GitHub 自身缓存、搜索引擎快照、Software Heritage、archive.org、代码搜索服务、AI 训练数据抓取等——**不可撤回**。
- GitHub Support 能力（据公开文档，需用户自行核实最新政策）：
  - 可协助“清除敏感数据的缓存视图”（如对旧 SHA 的页面缓存）——通常在**仓库改为 private 或删除敏感提交后**提出请求；处理范围与时限由 GitHub 裁量。
  - **不能**删除 fork、clone、第三方副本；**不能**保证搜索引擎/归档站已抓取副本被清除。
  - 对个人身份信息（PII），可通过 GitHub 的敏感数据移除流程/Support 工单申请；对“已公开的个人姓名”是否受理，取决于具体情形与当地法规（如适用）。
  - 结论：**GitHub Support 只能降低不能消除**公开面；若用户的核心诉求是“可检索性最小化”，必须同时评估仓库可见性（private/迁移/删库重建）。

### 3.3 结论
- 姓名已进入**已推送的公开历史**（且很可能进入 tag 视图）；当前工作树修复**不足以**从公开面移除它——除非改写历史并 force push（且接受 fork/clone/cache 残留）或改变仓库可见性/删除重建仓库。
- 若用户接受“历史保留、仅当前树修复”，必须明确记录残余风险：任何知道旧 SHA 或曾 clone 的人仍可读到姓名；默认分支（master）当前内容含姓名的情况应优先处理（例如让 master 也包含 `6eceaff` 的修复，可通过合并/推送保守操作实现——但 push 本身本轮未授权）。

## 4. 方案 A：保留历史（当前树已修复）

**内容**：不重写历史；保持 `9db6c5b`/`42a3caa`/v0.2.8 tag 原样；已完成的 `6eceaff` 修复随 `feat/v3.0.0` 保留；发布 v3.0.0 时以“当前树不含真实 PII”为口径。

**优点**：零历史风险操作；不破坏 clone/fork/链接/CI；工作量最小；与“未授权改写历史”的约束一致。

**残余风险**：公开仓库历史中姓名永久可检索；旧 SHA/raw URL/tag 视图可读；若远端 master 仍是 `42a3caa`，默认分支当前内容也含姓名（风险等级高于“仅历史”）。用户选择本方案时建议至少：修复 master 上的该行（普通提交/合并，不 force push）；或把仓库改为 private；或删除含旧历史的仓库重建。

**执行步骤（供用户决策后另派）**：无操作（本轮不 push）→ 如用户批准修复远端默认分支：常规提交 + `git push origin master`（**本轮未授权，不执行**）。

## 5. 方案 B：隔离镜像历史重写（仅演练、绝不推送）

> 本方案的目标是**验证“彻底移除姓名”的可行性并产出可执行的演练结论**；所有改写仅发生在**本地隔离镜像目录**，不触碰 `origin`、不改变当前仓库、不 push/tag。本轮未执行任何步骤（未授权），仅列出预案。

### 5.1 前置条件（缺一不可）
1. 用户书面授权“在隔离目录演练历史重写”（不改远端）。
2. **新建当前 HEAD 的全量备份**：现有 bundle 只到 `c05a24a`（18 本地提交），落后当前 HEAD 3 个提交；重写前必须在非 OneDrive 目录生成新的 `git bundle create <新备份> --all`，校验 `git bundle verify` 并记录 SHA-256；同时保留仓库目录副本与 `.git` 归档。
3. 镜像目录位于**非 OneDrive、非仓库工作树**的本地路径。
4. 冻结写入：演练期间其他成员不提交、不 push；记录当前 `git status`。

### 5.2 步骤（仅预案）
1. **冻结与取证**：`git status --porcelain`、`git for-each-ref`、`git rev-parse HEAD origin/master` 记录；记录 21 个本地提交与 2 个 master 提交的 SHA 清单（写进演练报告）。
2. **新全量备份**：`git bundle create <BACKUP-DIR>/v3.0.0-pre-rewrite-<ts>.bundle --all`；`git bundle verify`；SHA-256 记录；另建 `git clone --mirror <REPO-ROOT> <MIRROR-DIR>`（本地文件系统，仍属只读式复制）。
3. **镜像内定位**：在镜像 `git log --all -S '<MASKED-NAME>' --oneline` 确认仅命中 `9db6c5b`、`42a3caa`；`git ls-tree -r <commit> | grep ACCEPTANCE` 确认路径。
4. **重写最小改动点**：在镜像中从 `9db6c5b` 的父提交 `f285c05` 开始 `git rebase -i f285c05`，仅编辑 `9db6c5b`：把 `docs/ACCEPTANCE.md:304` 的姓名替换为「测试甲」（与 `6eceaff` 的当前树一致），保存后继续 rebase，重放 `42a3caa`。此步骤产生新的 `9db6c5b'`、`42a3caa'`（以及其后所有提交的新 SHA）。
5. **重建 tag**：`git tag -f -a v0.2.8 <new-9db6c5b'> -m "<原 tag message>"`（保留原 tag message；tagger 身份沿用现有 noreply 配置）；确认 v0.2.3 不重建（其 target `09512ed` 未变）。
6. **重放本地分支**：`git rebase --onto <new-master-tip'> 42a3caa feat/v3.0.0`（21 个本地提交；预期冲突点：`6eceaff` 与 `2823439` 都改过 `docs/ACCEPTANCE.md`，需手工解冲突并按 `6eceaff` 的意图保留「测试甲」）。
7. **更新旧 SHA 引用**：把 §1.7 列出的 5 个文档中的 `9db6c5b`/`42a3caa`/`062aa10` 引用改为新 SHA（或改为“见 H-1 旧 SHA 已废弃”的说明）；此更新在镜像内作为新提交存在，是否进入真实仓库由用户决定。
8. **验证**：
   - 全对象重扫：镜像 `git cat-file --batch-all-objects` + 多编码扫描，姓名命中必须为 **0**；`git grep -l '<MASKED-NAME>' $(git rev-list --all)` 为 0；
   - 语义等价：`git range-diff` 或对每个新/旧提交树做 `git diff --stat`，确认差异**仅** `docs/ACCEPTANCE.md` 该行（及 §1.7 的 SHA 文本行）；代码树、测试、依赖保持不变；
   - 提交数、文件数、tree 哈希（除被改文件外）与旧历史一致；
   - 分支/tag 指向正确；`git fsck` 无新异常。
9. **产出**：演练报告（新旧 SHA 映射表、冲突解决记录、验证数字、恢复步骤），**不推送**。
10. **决策点（用户）**：若认可演练结果，才讨论是否 `push --force-with-lease`（master + tag 需分别 force）+ 是否提交 GitHub Support 缓存清理请求；若拒绝，放弃方案 B，回到方案 A。

### 5.3 影响清单（若真正执行）
| 对象 | 影响 |
|---|---|
| 提交 SHA | `9db6c5b` 及 master 侧其后继 `42a3caa` 改写；21 个本地提交经 rebase 全部重写 → **23 个提交 SHA 变化**（2 个 master 侧 + 21 个本地） |
| tag | `v0.2.8`（`062aa10` → `9db6c5b`）需重建为新 tag 对象；`v0.2.3` 不变；旧 tag 对象/旧 commit 保留在 reflog/本地对象直到 gc |
| 签名 | 全部未签名 → 无签名失效问题 |
| git 身份 | 保持 repo 级 noreply 身份，author/committer 不变 |
| fork/clone/PR | fork 与 clone 保留旧历史；PR 若不指向这些分支则不受影响；外部旧 SHA 链接失效（GitHub 可能缓存一段时间） |
| 文档 | §1.7 的 5 个文档需同步更新 SHA 引用 |
| 发布流程 | 发布记录/CHANGELOG 中的旧 SHA 引用需核对；GitHub Release 无 v0.2.8 资产（仅 v0.2.3 pre-release），无附件重建 |
| CI/外部集成 | 如有基于 SHA 的 badge/流水线记录，会显示旧 SHA；无已知依赖 |
| pack-refs | 过期 `3b5b603 refs/heads/master` 可顺手清理（`git pack-refs --all`/`git update-ref -d`），非必须 |
| 不可达对象 | `8d6c92f`、`e79f420` 与本次无关；不建议清理（可能丢失可恢复信息） |

### 5.4 风险与代价
- **高**：向公开远端 force push 会重写公开历史——已 clone 的人会分叉；旧 SHA 可能短期仍可访问（缓存）；无法保证 fork/第三方副本消失。
- **中**：tag 需 force 更新；若他人基于 v0.2.8 引用，链接/校验会失效；GitHub Support 处理范围不保证。
- **低**：本地镜像演练本身对真实仓库零影响（只读 clone + 隔离目录操作）；验证充分后可回滚。
- 若用户诉求是“公开面最小化”，更彻底且低风险的替代是：把仓库改为 private、或删除现有公开仓库后重建（会损失星标/issue/PR/链接；需用户评估）。

### 5.5 回滚与“不丢代码”恢复
- 演练阶段：镜像目录可整目录删除/重建；真实仓库不受影响。
- 真实改写阶段（如未来用户授权）：
  1. 改写前记录 `git rev-parse HEAD`、完整 SHA 清单、备份 bundle（§5.1 第 2 条）；
  2. 本地建保护引用：`git branch backup/pre-rewrite <旧 tip>`、`git tag backup/pre-rewrite-tag v0.2.8`（本地即可，不推送）；
  3. 若出错：`git reset --hard backup/pre-rewrite` / `git checkout -B feat/v3.0.0 backup/pre-rewrite`；tag 用 `git tag -f v0.2.8 <旧 tag object>` 恢复本地 tag；
  4. 远端未 push 前，origin 仍是旧历史，随时可重新 clone 恢复；
  5. 已 force push 后：必须从备份 bundle/backup refs/clone 恢复；GitHub Support 缓存清理不可逆，故执行前必须用户书面确认。
- 不可达 commit `8d6c92f` 已由 reflog 持有；如需找回：`git fsck --lost-found` 或 `git reflog`（当前 34 条），不影响主历史。
- **当前备份缺口**：现有 bundle 不含 `2823439`/`4fe7cfe`/`6b3b81a`；在补建新全量备份之前，不得进行任何历史改写操作（否则可能丢失最近 3 个提交）。

## 6. 两方案对比

| 维度 | 方案 A：保留历史 | 方案 B：隔离镜像重写（演练/后续推送） |
|---|---|---|
| 当前树脱敏 | 已完成（`6eceaff` 起） | 同样（并额外改写历史） |
| 公开历史中的姓名 | 永久保留，可被检索 | 镜像内验证 0 命中；是否公开取决于是否 force push |
| 默认分支 master 现状 | 仍含姓名（需另行普通修复/改可见性） | 推送后 master 指向新历史（不含） |
| 需要 force push | 否 | 是（master + tag）；高风险、需用户书面授权 |
| 影响提交 | 0 | 23 个 SHA（2 master 侧 + 21 本地） |
| tag | 保留 v0.2.8 旧对象 | 重建 v0.2.8 tag 对象 |
| 文档旧 SHA 引用 | 无需改 | 5 个文档需更新 |
| clone/fork 残留 | 没有新增，但旧 clone/fork 存在 | 同样无法清除既有 clone/fork |
| GitHub 缓存/第三方 | 不涉及 | 需 GitHub Support 协助，且不保证彻底 |
| 回滚难度 | 无需回滚 | 中（备份 + backup refs 可回滚；已 force push 后较难） |
| 工作量 | 0（可选修复 master/改可见性） | 中高（演练约数小时 + 验证） |
| 与“未授权操作”约束 | 完全符合 | 演练符合；真实推送需额外授权 |
| 风险等级 | 低（除非用户不接受历史残留） | 演练低；真实推送高 |

**建议路径**：① 先补建全量备份（必须）；② 在隔离镜像完成方案 B 演练并出验证报告（零风险、只读仓库）；③ 用户根据“公开历史残留是否可接受”决定：接受→方案 A +（可选）修复 master/改可见性；不接受→授权 force push 窗口 + GitHub Support 缓存清理，并接受 clone/fork 不可追回；④ 无论选哪个，发布前把“历史扫描”纳入门禁。

## 7. 待用户拍板事项（历史相关，与 PII 文档 D 清单互补）

| 编号 | 事项 | 建议 |
|---|---|---|
| H-D1 | `<MASKED-NAME>` 是否为真实个人信息（或已获授权的测试名） | 若无书面依据，按 C 处理；如确认虚构，可降级 A 并记录 |
| H-D2 | 选择方案 A（保留历史）还是方案 B（重写） | 先演练 B，再定 |
| H-D3 | 是否授权在隔离镜像中执行历史改写演练（不推送） | 建议授权；零风险 |
| H-D4 | 是否授权补建当前 HEAD 全量备份（现有 bundle 落后 3 个提交） | 必须，任何历史操作前 |
| H-D5 | 若选方案 B：是否授权最终 force push（master + v0.2.8 tag） | 需单独、明确、书面授权 |
| H-D6 | 是否向 GitHub Support 申请缓存/敏感数据清理；是否把仓库改 private 或删除重建 | 与公开面诉求联动 |
| H-D7 | 是否修复远端 master 的当前文件内容（当前默认分支仍含姓名） | 建议修复（普通提交/合并，不 force push） |
| H-D8 | 是否把“全历史扫描”加入 CI/发布门禁 | 建议（另任务） |

## 8. 局限与无法离线确认

- 无法离线核实：GitHub 仓库当前可见性、tag 是否已推送、fork/PR/clone/第三方缓存/搜索引擎索引、GitHub Support 的具体处理范围与时限。
- 姓名真实性无法离线判定（见 §2.3）；本分析按保守原则处理。
- 快照期间工作树被并发修改，HEAD 与 refs 数字为采样值（2026-11-01 11:24–11:32）；本分析未改变任何文件。
- 本分析不构成法律意见；是否构成“个人数据/隐私”问题、是否需要本人同意，请用户结合所在地法规与本人意愿判断。

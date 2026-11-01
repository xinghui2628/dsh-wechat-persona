# GitHub 发布与维护指南（Release Guide）

> 面向：项目第一作者 / 第二作者。
> 目标：把仓库安全地公开发布、讲清楚玩法、保护自己、并让第二作者体面地署名。

## 1. GitHub 的「玩法」是什么

- **仓库（Repository）**：代码 + 文档 + 历史记录的家。公开仓库任何人可看、可 Fork（复制一份）、可提 Issue/PR。
- **README.md**：门面。别人 30 秒内决定装不装、敢不敢用，靠它。
- **License**：决定别人能怎么用你的代码。没有 License 默认「保留所有权利」，别人不敢用；**有 MIT/Apache** 才叫真开源。
- **Star**：点赞/收藏，是传播力。
- **Fork**：别人复制走改，合法（按 License）。**你无法阻止别人 Fork，但可以要求保留版权声明（MIT 要求保留）。**
- **Issue**：问题/bug/需求；**Discussions**：闲聊、问答、分享。
- **Pull Request（PR）**：别人改完请求合并；你 review 后 merge。
- **Release + Tag**：每次发布打 `v0.2.3` 标签并写 Release Notes，别人能下载固定版本。**建议先标 "Pre-release"**（实验性项目降低预期）。
- **Actions（CI）**：每次 push 自动跑测试/构建，README 上显示绿色徽章，增加可信度。
- **Contributors**：按真实 commit 自动统计；`Co-authored-by` 可让两个账号出现在同一条提交里。
- **主线与分支**：`master` 是发布线；开发用短分支 + PR，保护线不被直接 push（Settings → Branches → Branch protection）。

## 2. 发布前检查清单

- [ ] `git status` 干净；`git log` 只有干净提交（无敏感文件历史）
- [ ] `git grep -nE '真实好友名|wxid|手机号|API Key|C:\\\\Users\\\\<用户名>'` 无命中
- [ ] `README` / `SECURITY` / `DISCLAIMER` / `LICENSE` / `CONTRIBUTORS` 齐全
- [ ] `package.json` 版本 = 最新 tag；`CHANGELOG` 有对应条目
- [ ] `npm run typecheck && npm run test:sandbox && npm run build` 全绿
- [ ] `.gitignore` 排除 `dataDir`、`dist/`（本仓库不提交 dist）、`__pycache__`、截图目录、`.dsh-tmp`
- [ ] 没有提交任何真实聊天记录/截图/Key

## 3. 首次发布步骤（第一作者执行）

```bash
# 1) 在 GitHub 网页新建空仓库（不要勾选 README/.gitignore/License，避免冲突）
#    仓库名建议：dsh-wechat-persona （或加前缀，如 yourname-dsh-wechat-persona）

# 2) 关联远端并推送（只推 master）
git remote add origin https://github.com/<你>/dsh-wechat-persona.git
git push -u origin master

# 3) 打标签 + 建 Release
git tag -a v0.2.3 -m "v0.2.3: 读取防串聊 + 通道能力降级"
git push origin v0.2.3
# 网页 → Releases → Draft a new release → 选 v0.2.3
#   ✅ 勾选 "Set as a pre-release"（实验性项目）
#   Release notes 用 CHANGELOG 的 0.2.3 段
```

**仓库设置**（网页 Settings）：

- Description：一句话（中文 + 英文关键词）；Topics：`dsh`、`deepseek-harness`、`wechat`、`persona`、`ai-chat`、`windows-automation`、`ocr`、`plugin`
- 勾选 Issues / Discussions / Private vulnerability reporting（Security 页）
- Social preview 图（可先用 `icon.svg` 导出 PNG）
- 若担心误推：先设为 **Private**，同学内测稳定后再转 Public

## 4. 免责声明与安全声明的摆放（重要）

三层摆放，越靠近用户越显眼：

1. **README 顶部**（30 秒内能看到）：账号风险 + 只用自己的小号 + 与腾讯无关 + 免费无付费服务
2. **本仓库 [DISCLAIMER.md](../DISCLAIMER.md) / [SECURITY.md](SECURITY.md)**：完整条款、数据流向、安全报告渠道
3. **Release 说明与 Issue 模板**：再次提示先读文档、脱敏日志

> 参考做法：微信自动化项目普遍在 README 顶部写「仅供学习和技术研究、免费开源、作者不承担任何责任」，并用自定义 License 限制非商业用途（如 [wechat-use 的非商业学习许可](https://github.com/leeguooooo/wechat-use/blob/HEAD/LICENSE)）；也有项目被腾讯投诉/下架或作者主动归档（如 [XYBotV2](https://github.com/HenryXiaoYang/XYBotV2) 已归档并停止维护）。**建议你自己先 Fork 一份备份到别的账号/本地。**

## 5. 第二作者 / 共同作者怎么玩

### 方式 A（推荐）：真实协作 + 共同署名

1. 对方注册 GitHub 账号，并把自己的邮箱绑定到账号（Settings → Emails）。
2. 网页 Settings → Collaborators → Add people → 输入对方用户名 → 给对方 **Write** 权限（只能 push/PR，不能删仓库/转移/改设置；仓库 Owner 仍是你）。
3. 之后对方真实提交会出现在 Contributors；关键提交可加共同作者 trailer：

```bash
git commit -m "feat: 桌面通道真机测试与文档

Co-authored-by: 第二作者 <coauthor@example.com>"
```

- 多个共同作者：每人一行 `Co-authored-by:`，行间不要空行。
- 邮箱必须是对方 GitHub 账号已绑定的邮箱，GitHub 才会把该 commit 计入对方贡献并显示双头像。
- 也支持 GitHub 网页提交时在 commit 信息里手写同样的 trailer。

### 方式 B：仅署名（没有代码提交）

在 [CONTRIBUTORS.md](../CONTRIBUTORS.md) 与 README「作者与贡献者」中写明：第一作者 / 第二作者及贡献内容；并保留 [CITATION.cff](../CITATION.cff) 的作者列表。**注意**：GitHub Contributors 统计不受影响（按 commit 算），所以「第二作者」的身份主要靠 CONTRIBUTORS/README/CITATION 体现。

### 给权限的边界

- 不给 **Admin**；不开 **Force push**；保护 master（需要 PR）。
- 对方加的不是你 → 别加；不熟悉的 PR 先看 diff。
- 任何一个人都能 Fork，所以「共同作者」不等于「共同所有者」，你仍是 owner。

## 6. 「不能有利益损失」怎么做

- **License 是防线**：目前是 MIT（最宽松），它包含「免责/无担保」条款，能挡掉大部分索赔；但 MIT **允许别人商用/闭源分发**。如果你不想别人拿它赚钱或二次售卖，需要换成**非商业许可**（如 wechat-use 的 Non-Commercial Learning License 思路）——但那样它**不是 OSI 开源项目**，GitHub 也不显示开源标签、传播会变差。二选一，没有两全：**要传播用 MIT + 免责声明；要防商用用自定义非商业许可。**
- **不收费、不接单、不承诺 SLA**：项目免费，README 写明「不提供付费服务/商业定制/技术支持保证」，避免被当成服务商索赔。
- **不收集数据、不内置遥测**：减少隐私责任（见 SECURITY.md）。
- **商标/合规**：项目名避免直接用「腾讯/微信」Logo 做标识，README 声明与腾讯无关；不发布破解/逆向协议代码，只用系统辅助功能/OCR，把「是否违反微信协议」明确写成用户自担。
- **保留版权署名**：MIT 要求保留 copyright 声明，你的名字会随分发保留（这本身就是一种署名保护）。
- **备份**：腾讯投诉或 GitHub 政策变化可能导致仓库不可见。**本地 + 另一账号各留一份完整 `git clone`（含 .git）**，并保留 Release 资产。
- **预期管理**：Release 标 Pre-release；README 写「实验性项目，可能有 bug，欢迎 Issue 但按兴趣维护」——这比"保证稳定"安全得多。

## 7. 发布后

- 关注 Issues/Discussions，每周固定时段处理；回复模板：「先按 FAQ 自查 → 贴脱敏日志 → 若复现我开个 issue 跟进」。
- 打新版本：改版本号 + CHANGELOG → `git tag` → Release；破坏性变更写明迁移。
- 想收贡献：在 Issue 里标 `good first issue`。
- 定期跑 `npm audit`、更新依赖、检查 Actions 是否绿。

## 8. 常见坑

| 坑 | 规避 |
|---|---|
| 把 `dataDir`/截图/真实好友名推上去 | 先 `git grep` 检查；`.gitignore` 兜底；用占位名 |
| 把 API Key 写进 README/示例 | 示例一律 `<YOUR_KEY>`；配置走本机 |
| 误把 dist 提交（体积大、易冲突） | `.gitignore` 排除；README 说明「先 build」 |
| 打 tag 打错 | `git tag -d v0.2.3 && git push origin :refs/tags/v0.2.3` 重来 |
| 同学克隆后跑不起来 | README 里 Node/DSH/微信/OCR 前置条件写全；提供 selfcheck 脚本 |
| 被投诉下架 | 提前备份；免责声明清楚；避免商标与破解内容 |

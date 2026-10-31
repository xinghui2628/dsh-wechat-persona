# 贡献指南（Contributing）

感谢你对 **dsh-wechat-persona** 的兴趣！这是一个面向个人学习/研究的小项目，欢迎 Issue、PR、文档修正和人格包投稿。

## 开始之前

1. 先读 [README.md](README.md)、[DISCLAIMER.md](DISCLAIMER.md)、[AGENTS.md](AGENTS.md)（开发规则）。
2. 不要提交任何**真实好友名、wxid、手机号、API Key、本机用户名路径、聊天截图**。
3. 涉及微信自动化的改动，必须保持「**宁可失败，绝不发错人/读错人**」的安全原则。

## 开发环境

```bash
# 需要 Node.js >= 22、Windows 10/11（桌面通道）
npm install --ignore-scripts
npm run build
npm run typecheck
npm run test:sandbox
```

- 受限沙箱里用 `npm run test:sandbox`；直接 `npm test` 可能因 esbuild/vitest 进程限制失败（属预期）。
- 改 `.ps1` 脚本必须保留 **UTF-8 BOM**，改完用 `Parser::ParseFile` 验证（见 AGENTS.md）。

## 提交规范

参考 Conventional Commits：

```
feat: 新功能
fix: 修复 bug
docs: 文档
test: 测试
refactor: 重构
perf: 性能
chore: 构建/工具
```

- 一个 PR 只做一件事；修复 bug 请附复现步骤/测试。
- 改行为请同步更新 `CHANGELOG.md`、相关文档与测试。
- 提交前请跑：`npm run typecheck && npm run test:sandbox && npm run build`。

## PR 流程

1. Fork 仓库 → 新建分支（`feat/xxx`、`fix/xxx`）。
2. 提交改动，写清动机、方案与验证方式（贴测试输出更好）。
3. 开 PR，关联 Issue（如有）；收到 review 后按讨论修改。
4. 合并后你的 GitHub 账号会自动出现在 Contributors 列表；重要贡献会记录到 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

## 不想写代码？

也欢迎：报告 bug（附日志/截图前先脱敏）、改进文档、投稿人格包（`personas/`）、贴纸包、在 Discussions 分享使用心得。

## 安全与合规

- 不提交任何绕过风控、批量注册、群控、破解类代码。
- 不把本项目用于商业导流、骚扰、诈骗等用途（见 [DISCLAIMER.md](DISCLAIMER.md)）。
- 安全问题请走私密报告渠道（见 [SECURITY.md](SECURITY.md)）。

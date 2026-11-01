## 这个 PR 做了什么？

<!-- 一句话说明；关联 Issue：Closes #123 -->

## 为什么需要

## 怎么验证的

- [ ] `npm run typecheck` 通过
- [ ] `npm run test:sandbox` 通过（贴文件数/用例数）
- [ ] `npm run build` 通过
- [ ] `npm run verify:api` 通过（涉及 API/mock/草稿时）
- [ ] `node scripts/check-sensitive.mjs` 0 命中
- [ ] 改了桌面脚本：PowerShell 语法检查通过、`.ps1` 保留 UTF-8 BOM
- [ ] 只涉及 mock/离线；如涉及真实通道，已说明为何需要、如何避免误发（beta 默认禁用真实发送）

## 安全与隐私检查

- [ ] 没有提交真实好友名/wxid/手机号/API Key/含用户名的完整路径/聊天截图
- [ ] 没有把真实聊天内容、截图或私人数据作为测试夹具提交
- [ ] 保持了「宁可失败，不发错人/读错人」的安全原则
- [ ] 更新了 CHANGELOG 与相关文档（行为/配置/版本变化时）

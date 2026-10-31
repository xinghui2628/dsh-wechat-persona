# 提示词模板（PROMPTS）

> 用途：让「创造模式」或其它 AI 会话按照统一需求修改/生成插件功能。
> 复制下面整段发给 AI 即可；把【】里的内容替换成你的具体需求。

## 模板 A：修改插件功能（推荐）

```
你是 DSH 插件 dsh-wechat-persona 的开发者。项目目录：<工作区>/dsh-wechat-persona。
先阅读 AGENTS.md、docs/ARCHITECTURE.md、docs/TEST-PLAN.md，再动手。

本次需求：【用一句话写清楚，例如：列表识别失败时自动重试一次并记录诊断】。
约束：
1. 只改本仓库；删除文件先改名 .bak-<时间>；不碰系统设置/代理/证书/微信数据。
2. .ps1 文件必须 UTF-8 with BOM；不要用 PowerShell 5.1 的 -replace 改写文本文件。
3. 自动化宁可返回 ok:false，也不允许发错人；涉及发送的改动必须保留「定位信息校验」。
4. 改完必须：npm run typecheck && npm run build，并更新 CHANGELOG.md（过程记录放本地 dev-notes/，不入库）。
5. 输出：改了哪些文件、每处改动的目的、如何验证（命令+预期结果）。
```

## 模板 B：新增一个人格（角色卡）

```
给 dsh-wechat-persona 新增人格角色卡（三种入口：内置放 personas/builtin/<id>.json；
用户导入经设置页「人格广场 → 导入」写入 dataDir；v2 人格包放 <dataDir>/personas/<id>/pack.json）。
参考 SillyTavern 角色卡 v2 字段：name、description、personality、scenario、
first_mes、mes_example、system_prompt、post_history_instructions、tags。
要求：中文口语化、回复 60 字内、可自然发表情包、不主动提敏感话题。
写完后说明如何在设置页「人格广场 → 导入」使用。
```

## 模板 C：写测试/复现

```
在当前环境复现 dsh-wechat-persona 的问题：【现象描述】。
步骤：1) 运行 scripts/pwsh/selfcheck.ps1；2) 用 -Action list/read/send 直接跑脚本；
3) 查看 %TEMP%\wxuia-engine-debug.log 与 dataDir/audit.jsonl；
4) 给出根因假设（最多 3 条，按可能性排序）和最小修复方案。不要直接改代码。
```

## 模板 D：发布前检查

```
对 dsh-wechat-persona 做发布前审查：按 docs/TEST-PLAN.md 检查 12 个必查场景，
核对 README 安装说明是否可独立完成安装，检查是否有个人数据/密钥进入仓库。
输出：通过项、阻塞项（必须修）、建议项（可延后）。
```

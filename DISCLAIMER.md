# 免责声明（Disclaimer）

> **dsh-wechat-persona** 是一个**个人独立开发、免费开源、实验性**的 DSH 插件，当前版本 `3.0.0-beta.1`（开发者预览）。
> 使用本项目即表示你已阅读并同意本文件与仓库根目录 [LICENSE](LICENSE) 的全部内容；不同意请立即停止使用并删除本项目。

## 1. 与腾讯 / 微信官方无关

- 本项目**不是腾讯官方产品**，与腾讯公司、微信团队**没有任何隶属、合作、赞助、授权或背书关系**。
- 「微信 / WeChat」是腾讯公司的商标，本项目仅为说明兼容对象而提及，**不使用腾讯任何商标、Logo、图标作为项目标识**。
- 本项目**不提供**微信客户端破解、协议逆向、账号注册/解封、外挂、群控或批量营销功能。

## 2. 使用范围：只用于你自己的小号、自担风险

- **只允许使用你本人注册的小号**；禁止用于主号、他人账号或任何你不拥有的账号。
- 禁止用于：诈骗、敲诈、骚扰、冒充真人骗取信任/钱财、群发广告、导流、刷单、赌博、色情、涉政等违法或违反平台规则的用途。
- 本项目不是生产级产品，不承诺稳定、持续维护或向后兼容。

## 3. 账号与平台规则风险由使用者承担

- 通过自动化方式操作微信客户端/手机通知，**可能违反《微信软件许可及服务协议》**；账号可能被限制、封禁、降权或触发异常登录验证。
- 本项目**不承诺规避平台风控**，也不建议用本项目绕过任何平台限制。
- 因使用本项目导致的账号封禁、消息发错/漏发、数据丢失、设备损坏、第三方索赔等，**作者与贡献者不承担任何责任**。

## 4. 准确性不保证（含 OCR 与 AI 生成内容）

- OCR 识别、消息归属、AI 生成的回复均**可能出错**；本项目采取「宁可失败也不乱发」的策略，但**不保证零漏读、零误发、零重复**。
- 不要把本项目的输出当作事实、法律、医疗、金融或投资建议。
- 真实微信环境下的读取/OCR/发送**尚未完成实机验收**；beta 默认关闭真实通道发送，相关能力以发布说明与 [docs/BETA-LIMITATIONS.md](docs/BETA-LIMITATIONS.md) 为准。

## 5. 隐私与云端 LLM 数据流

- 插件在本机运行；配置、记忆、审计日志默认保存在本机 `dataDir`（详见 [docs/PRIVACY.md](docs/PRIVACY.md)）。
- **生成回复所需的聊天内容、最近上下文、联系人偏好会发送给你自己配置的 LLM 服务商**（以及可选的搜索服务）；请自行阅读其隐私政策并评估敏感信息风险。
- 项目**不内置遥测、统计上报或第三方数据收集**；API Key 只保存在本机配置中，请勿提交到公开仓库。
- 不要用本项目处理验证码、密码、支付、身份证件、他人隐私等敏感信息。

## 6. AI 身份透明与他人权益

- 本项目要求 AI 在被直接问及身份时**如实说明是 AI**，不冒充真人、不声称是某个具体真实的人。
- 禁止用本项目冒充他人骗取信任、伪造身份、骚扰他人或侵犯他人的名誉权、隐私权、肖像权等合法权益。
- 你应对 AI 生成的每一条消息的后果负责。

## 7. 安全披露

- **请勿在公开 Issue / PR / 讨论区披露安全漏洞的可利用细节或隐私数据。** 请使用 GitHub 仓库 Security 页的 **Private vulnerability reporting** 私密报告（见 [SECURITY.md](SECURITY.md)）。
- 维护者会尽力处理，但不承诺响应时限；不接受以漏洞换取报酬的要求。

## 8. 无担保（AS IS）与许可

- 本项目按「现状」提供，**不提供任何明示或暗示的担保**（包括适销性、特定用途适用性、可靠性、准确性、不侵权）。
- 代码以 **MIT** 许可证发布；你可以在遵守许可证的前提下使用、修改、分发，但需保留版权与许可声明。
- 项目可能随时修改、暂停或停止维护，不承诺版本兼容、问题响应时间或长期可用性。
- 本项目不构成任何法律、医疗、金融、投资建议。

## 9. 费用

- **本项目免费**，不收费、不接商业定制、不提供付费服务。
- 你自行配置的 LLM 服务商、云手机/虚拟机、代理等**可能产生费用**，由你自行承担。
- 请勿以本项目名义向他人收费或承诺服务。

## 10. 不收集私人调试材料

- 维护者**不会主动索要**真实聊天截图、聊天记录、好友名单、wxid、手机号、API Key 或个人数据目录。
- 提交 Issue / PR 前请先脱敏（虚构值、打码、去 Key、去含用户名的完整路径）；如必须提供日志，请只保留相关片段并脱敏。
- 你主动上传到公开 Issue 的内容视为公开信息，维护者不承担因此产生的隐私泄漏责任。

---

## English Summary

This is a free, open-source, **experimental personal project**, **not affiliated with Tencent or WeChat**. Automating WeChat may violate its Terms of Service and can lead to account restrictions; use it **only with your own secondary account**, at your own risk, and never for spam, fraud, impersonation, harassment, commercial marketing, or accessing others' data. OCR and AI outputs may be wrong; the software is provided **"AS IS"** without warranty of any kind. Messages you configure may be sent to your own LLM provider. Do not upload private chat content, screenshots, keys, or personal identifiers to public issues. By using this project you agree to this disclaimer.

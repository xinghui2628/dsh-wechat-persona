# dsh-wechat-persona

> 一个**个人独立开发、免费开源、实验性**的 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 插件：
> 让它按你配置的人格，在你指定的微信小号**白名单单聊**里，以拟人节奏被动回复消息。
> **与腾讯 / 微信官方没有任何关系。**
>
> **当前版本**：`3.0.0-beta.1`（**开发者预览版 / Developer Preview**，2026-11-01）
> **上一个已发布版本**：`0.2.8`
> **仓库属性**：GitHub 仓库是 **public（公开可见）**；`package.json` 的 `private: true` **仅表示不发布到 npm**，不改变仓库公开、也无法撤回公开的历史提交。历史隐私审计见 [docs/PRIVACY-REVIEW-PRE-RELEASE.md](docs/PRIVACY-REVIEW-PRE-RELEASE.md)。
>
> ⚠️ 使用前请先读 [DISCLAIMER.md](DISCLAIMER.md)：自动化操作微信客户端**违反《微信软件许可及服务协议》**，可能导致账号被限制或封禁，风险由你自行承担；请只用**你自己注册的小号**，切勿用于主号、冒充真人、群发、营销、诈骗或读取他人数据。

---

## 1. 简介（beta 是什么、不是什么）

**是什么**

- 一个运行在**你自己电脑上**的 DSH 插件；配置、记忆、审计日志默认只存本机 `dataDir`。
- 只处理你在白名单里配置的单聊：非白名单、免打扰时段、超频、敏感话题都会在本地规则层被拦截，**不花 token、不发消息**。
- 回复由你在 DSH 里配置的 LLM 服务生成；插件不绑定任何模型厂商，也不含遥测。

**不是什么**

- ❌ 不是微信官方功能，也不是破解/协议逆向/外挂/群控；桌面通道模拟人在 Windows 客户端上的操作。
- ❌ 不是「稳定可用产品」：`3.0.0-beta.1` 是**开发者预览**，真实微信环境的读取/OCR/发送**尚未实机验收**。
- ❌ 不保证账号安全、不规避平台风控；本项目只把行为做得更像人、频率压到最低。
- ❌ 不帮你注册账号、加好友、进群、群发、导流，也不代做扫码/验证码/解封。

## 2. 实验性警示（beta 必读）

1. `3.0.0-beta.1` 的代码、单元测试和离线验收已就绪，但**真实微信窗口未实机验收**：
   OCR 准确率只有合成语料数据，真实聊天里的字体/DPI/遮挡/多显示器表现未知。
2. beta 默认安全策略：**真实通道的自动发送被关闭**（`betaSafeMode` 默认 `true`），`mock` 通道可完整走通；
   真实通道相关能力请视为「预览，未验证」。
3. 使用 LLM 会产生**费用**（由你的 DSH 模型配置决定），插件本身不收费。
4. 仓库是公开的：**不要**在 Issue/PR/日志里贴真实好友名、wxid、手机号、聊天截图、API Key、含用户名的完整路径。

## 3. 功能矩阵（beta 状态）

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| mock 通道（入站模拟 / 草稿 / 审计） | ✅ 可用 | 不接触真实微信，适合体验与开发 |
| DSH LLM 生成回复 | ✅ 可用（需你配置模型） | 费用由你的模型/服务商决定 |
| 人格库（4 个内置 + 自定义/导入） | ✅ 可用 | 内置人格含「AI 身份透明」规则 |
| 白名单 / 在线时段 / 频控 / 预算 / 熔断 | ✅ 可用 | 本地规则先拦截，再决定是否调用模型 |
| 发送可靠性（10 态状态机 + `sendOperationId` 幂等账本） | ✅ 已实现 | 真实故障路径（重启/超时）未实机演练 |
| `sendMode`（`auto` / `draft` / `confirm`，草稿人工批准） | ✅ 可用 | beta 默认受安全模式限制 |
| OCR 流水线（WinRT 主引擎 + 同帧约束 + 基线/ack + 置信度门禁） | ⚠️ 离线验证 | 真实微信窗口未实机验收 |
| RapidOCR 第二引擎（可选） | ⚠️ 未实测新包 | 缺失时静默跳过，不阻断主流程 |
| desktop 桌面通道自动发送 | ⛔ beta 默认禁用 | `betaSafeMode` / `safeMode` 之下拒绝真实发送 |
| phone-adb / windows-vm 通道 | 🧪 代码保留 | 本轮未实机验证，按「实验」对待 |
| 表情包 / 人格广场 / 记忆摘要 | ✅ 可用 | 表情仅部分通道支持，见 [docs/BETA-LIMITATIONS.md](docs/BETA-LIMITATIONS.md) |
| 融合/对齐/跨帧差分（fusion/align/tracker） | 🧪 离线实验 | 已实现+单测，**未接入生产读取路径** |
| 插件市场 / 长期记忆 / 视觉模型 | ⚠️ 未来规划 | **不是** beta 功能 |

完整矩阵与已知问题见 [docs/BETA-LIMITATIONS.md](docs/BETA-LIMITATIONS.md)。

## 4. 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11（desktop 通道）；mock 验证在任何平台均可 |
| Node.js | **22 及以上**（构建与测试） |
| DSH 桌面版 | 0.2.1-rc.3 及以上 |
| 微信 PC | 仅 desktop 通道需要，4.x（未验证更早版本） |
| 中文 OCR | Windows「中文（简体）」OCR 语言包 + 分辨率 ≥ 1366×768（desktop） |
| PowerShell | Windows PowerShell 5.1（脚本用 `-NoProfile` 调用） |
| Python | 可选，仅 RapidOCR 第二引擎与 OCR 基准需要 |

## 5. 五分钟 mock 快速开始（不碰真实微信）

```powershell
git clone https://github.com/xinghui2628/dsh-wechat-persona.git
cd dsh-wechat-persona
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run verify:api        # 离线 harness：鉴权 / 配置 / mock / 草稿 / 暂停恢复
```

把插件以开发方式链接进 DSH profile（详见 [docs/BETA-QUICKSTART.md](docs/BETA-QUICKSTART.md)），启动后：

1. 设置页 → 微信分身 → 通道选 `mock`、白名单加一个**虚构**联系人（如 `张三`）。
2. 注入一条消息：

```bash
curl -X POST http://127.0.0.1:<DSH端口>/dsh-wechat-persona/api/test/inbound \
  -H "x-dsh-wechat-persona: 1" -H "Content-Type: application/json" \
  -d "{\"text\":\"在吗\",\"contactId\":\"张三\"}"
```

3. 查看结果：`GET /status`、`<dataDir>/outbox.jsonl`（mock 发送记录）、`<dataDir>/audit.jsonl`（审计）。
4. 草稿模式：设置 `sendMode=draft`，重复第 2 步 → `GET /drafts` 查看草稿 → `POST /drafts/approve` 人工批准后再发送。

> 没有真实 LLM 也能完成 mock 验证（默认回复只走本地规则/persona 流程可选）；需要模型时使用你 DSH 里已配置的模型，并自行承担费用。

## 6. 安装、配置与运行

- 安装/更新/卸载/首次配置：见 [docs/使用说明.md](docs/使用说明.md) 与 [docs/BETA-QUICKSTART.md](docs/BETA-QUICKSTART.md)。
- 配置项、10 个设置标签页、6 个运维工具（`wechat_persona_status/pause/resume/send_test/clear_memory/clear_audit`）：见使用说明。
- 安全模式（`safeMode`）与只读测试模式（`readOnlyTestMode`）：设置页可切换；只读模式下发送在 **引擎 / 桌面通道 / HTTP API / PowerShell 脚本** 四层被拒，mock 不受影响。详见 [docs/READ-ONLY-MODES.md](docs/READ-ONLY-MODES.md)。
- 从 `0.2.8` 升级：见 [docs/MIGRATION-v3.md](docs/MIGRATION-v3.md)。
- 排障：见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## 7. 隐私与费用

- **本机数据**：`<dataDir>`（默认 `<工作区>/.dsh-wechat-persona/`）保存 `state.json`、`memory/`、`audit.jsonl`、`drafts.json`、`send-ledger.json`、`desktop-ack.json` 等；
  详细清单与保留期见 [docs/PRIVACY.md](docs/PRIVACY.md) 与 [docs/PII-INVENTORY.md](docs/PII-INVENTORY.md)。
- **会离开本机的数据**：只有「生成回复所需的消息内容 + 最近上下文 + 联系人偏好」会发给你自己配置的 LLM 服务商（以及可选的搜索服务）；不发送完整聊天历史、不发送截图。
- **无遥测**：项目不包含统计上报/跟踪。
- **费用**：插件免费；LLM 调用按你的模型服务商计费。
- **不要**用本项目处理验证码、密码、支付、他人隐私等敏感信息；敏感话题会被本地规则拦截。

## 8. 已知问题与限制

- 真实微信环境（读取/OCR/发送）**未实机验收**；OCR 数字来自**合成语料 + 离线等价**，不代表真实聊天准确率。
- `betaSafeMode` 默认开启：真实通道发送被拒；mock 正常。
- `fusion/align/tracker` 未接入生产路径；`rapidocr` 新包未实测。
- 4 个通道中仅 mock 在本轮做过完整离线验收；phone-adb / windows-vm 未验证。
- 完整列表见 [docs/BETA-LIMITATIONS.md](docs/BETA-LIMITATIONS.md) 与 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## 9. 发布说明

- 当前为 **v3.0.0-beta.1 开发者预览**：**未打 tag、未在 npm 发布、未创建正式 Release**（发布动作需维护者批准，见发布草稿 [docs/releases/v3.0.0-beta.1.md](docs/releases/v3.0.0-beta.1.md)）。
- 版本语义：修 bug → patch；行为/配置变化 → minor；破坏兼容 → major。
- 发布门槛与四类状态（已验证 / 待验证 / 需用户授权 / 不得发布）：见 [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md)。
- 变更记录：见 [CHANGELOG.md](CHANGELOG.md)。

## 10. 贡献与安全反馈

- 欢迎 Issue / PR；提交前请先看 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。
- **安全漏洞请勿公开披露**：使用 GitHub 的 Private vulnerability reporting（仓库 Security 页），说明见 [SECURITY.md](SECURITY.md)。
- 反馈时请遵守模板：不要贴真实好友名/wxid/手机号/聊天截图/API Key/含用户名的完整路径。

## 11. 许可与免责

- 代码以 **MIT** 许可证开源（见 [LICENSE](LICENSE)）。
- 使用即表示你已阅读 [DISCLAIMER.md](DISCLAIMER.md)：非官方、账号风险自担、AS IS 无担保、禁止诈骗/冒充/群控/营销等用途。

---

### 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/使用说明.md](docs/使用说明.md) | 安装、配置、登录、白名单、通道选择、卸载 |
| [docs/BETA-QUICKSTART.md](docs/BETA-QUICKSTART.md) | beta 五分钟快速开始（mock / 干净 profile 演练） |
| [docs/BETA-LIMITATIONS.md](docs/BETA-LIMITATIONS.md) | beta 功能矩阵、已知限制、公开问题 |
| [docs/BETA-FAQ.md](docs/BETA-FAQ.md) | 常见问题（封号/费用/数据/卸载） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、模块、数据布局、HTTP API |
| [docs/OCR-DESIGN.md](docs/OCR-DESIGN.md) | OCR 设计、融合/置信度、纠错边界 |
| [docs/OCR-BENCHMARK.md](docs/OCR-BENCHMARK.md) | OCR 合成语料基准数字与限定 |
| [docs/PRIVACY.md](docs/PRIVACY.md) | 数据流、存储、删除 |
| [docs/SECURITY.md](docs/SECURITY.md) | 威胁模型、鉴权、SSRF、残余风险 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 排障手册 |
| [docs/MIGRATION-v3.md](docs/MIGRATION-v3.md) | 从 0.2.8 升级与回滚 |
| [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) | 发布门槛与状态表 |
| [docs/releases/v3.0.0-beta.1.md](docs/releases/v3.0.0-beta.1.md) | beta 发布草稿 |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 开发与 PR 规范 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

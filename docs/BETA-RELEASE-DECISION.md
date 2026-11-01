# v3.0.0-beta.1 发布决策报告（Go/No-Go）

> 生成时间：2026-11-01（本地）。本轮按任务书《v3.0.0-beta.1 低成本、安全、诚实的 GitHub 公开测试版发布任务书》执行：**只做本地安全收尾、范围冻结、安装验收与发布素材准备；未 push、未打 tag、未创建 Release、未重写历史、未碰真实微信。**
>
> **更新（2026-11-01 晚，最终发布阶段）**：经用户一次性授权，本报告后续动作已全部执行——token 已完成文件层轮换并擦除旧备份、历史姓名已在本地重写替换为虚构文本、API 安全字段已加保护、`v3.0.0-beta.1` 已作为 GitHub Pre-release 发布（附件 tgz + SHA256SUMS）。本报告正文保留发布准备阶段快照，相关章节已加「后续更新」说明。
>
> 结论：**本地候选已就绪，但远程公开为 NO-GO（等待用户最少授权与两项 P0 用户侧动作）。**

## 0. 结论先行（Go / No-Go）

| 项 | 结论 | 说明 |
| --- | --- | --- |
| 本地发布候选（代码/文档/包） | **READY** | 见 B/C 节门禁实测 |
| 远程 push / 打 tag / 创建 Draft Release | **已执行（2026-11-01）** | 经用户授权：feat 普通 push、master 受控 force-with-lease、v0.2.8 tag 受控更新、新 tag `v3.0.0-beta.1` |
| 公开 beta.1 是否可发布 | **已发布（Pre-release）** | 两项 P0 已清：token 已轮换、历史姓名已本地重写替换；另完成 API 安全字段保护修复 |
| 是否建议先小范围技术同学预览 | 已作为 Pre-release 公开 | 面向技术同学的开发者预览；真实微信/GUI 仍未实机验收（属预期范围） |

## 1. Git 状态与备份（A 阶段）

- 分支：`feat/v3.0.0`；HEAD（本轮开始）：`22ce21e`（`docs: 交付报告门禁终值刷新`）；`git status` 干净；无 upstream；`origin` 为 public GitHub 仓库；`origin/master` = `42a3caa`。
- 相对基线 `42a3caa`：**25 个本地提交**；本地 tag：`v0.2.3`、`v0.2.8`（远端是否有同名 tag 未联网核实）。
- 备份：已创建**新的全量 bundle**（非 OneDrive 同步目录）：
  - 位置：`%TEMP%\dsh-wp-backup\v3.0.0-beta.1-prep-20261101-120157.bundle`
  - 大小：2,611,490 B；SHA256：`E814688753DE06780658B49663E606A072621FB828C858AA3B0312DB746F28CD`
  - 内容：`refs/heads/feat/v3.0.0`（22ce21e）、`master`、`origin/master`、`v0.2.3`、`v0.2.8`；`git bundle verify` 通过。
  - **敏感性**：该 bundle 含已公开 Git 历史（其中含 1 个疑似真实姓名 blob），属敏感备份；仅本地受限目录保存，不入 Git、不进 Release、不上传。
- 旧备份 `v3.0.0-20261101-103304.bundle`（2,432,226 B，HEAD 落后 7 个提交）保留，不再作为唯一备份。

## 2. 曾外发 `api-token`：发布前必须处理（P0，用户执行）

**事实（不输出明文）**：
- 运行态 token 文件：`<DSH profile>\desktop\.dsh-wechat-persona\api-token`（32 字符，2026-11-01 10:32:49 生成，权限意图 0600）。
- 该 token **不在 Git 受跟踪树、也不在 Git 历史**（全库检索命中 0）；只存在于上述运行时数据目录。
- 当前 profile 配置**未设置** `config.apiToken`（兼容模式）：该文件只是「运维参考 token」，API 当前仅校验回环地址 + `x-dsh-wechat-persona: 1` 请求头；只有把 token 填入配置后才强制 `Authorization: Bearer`。
- 按任务书口径：曾流出可信边界的 token 一律按**已泄露**处理；即使当前未强制校验，也不得再被用作安全凭据。

**用户本机最少操作（DSH 不执行，避免动用户 profile）**：
1. 轮换：关闭插件 → 删除上述 `api-token` 文件（或把它改名 `.old`）→ 重新启用插件，插件会重新生成新的随机 token；若使用强制鉴权，请在配置里把 `apiToken` 设为**新值**（新值不要发到聊天/日志/Issue）。
2. 验证失效：用旧 token 调 `GET /dsh-wechat-persona/api/status`（或任意受保护接口），期望 **401**；新 token 期望 200。
3. 若曾把旧 token 用于其他服务/脚本，请一并更换并检查日志。
4. 完成后只需回复「已轮换并验证旧 token 401」，**不必展示新 token**。

> **后续更新（2026-11-01 下午）**：该文件层轮换已完成——旧 token 备份用 `crypto.randomBytes(96)` 覆盖 4 轮后删除、目录/临时目录残留扫描 0 命中、新 token 33 B（`randomBytes(24).toString('base64url')` 格式）；**兼容模式仍不强制 Bearer**（见 SECURITY.md 残余风险 #1）。

## 3. Git 历史中的疑似真实姓名（P0，用户决定）

- 结论（来自 `docs/HISTORY-PRIVACY-ANALYSIS.md` 与 `docs/V3-PRIVACY-AND-DEVICE-READINESS.md` C 节）：**C=1** —— 1 个 blob、2 个已推送提交（`9db6c5b` 引入、`42a3caa` 仍包含）关联 1 个疑似真实姓名；当前 HEAD 树已改为虚构占位，但**历史仍可被公开检索**；全对象多编码扫描未发现其他真实姓名/用户名/wxid/邮箱/密钥。
- 两套方案（详见 `docs/HISTORY-PRIVACY-ANALYSIS.md`）：
  - **A 保留历史**：零操作、零风险操作；代价是姓名永久可检索（公开仓库）。
  - **B 隔离镜像重写**：在完全隔离的临时克隆/镜像中试演最小范围脱敏，需重写 2 个已推送提交及所有后代（25 个本地提交重放、`v0.2.8` tag 重建），影响 SHA/分支/fork/PR/CI 缓存；**强制 push 需用户单独书面授权**，且无法保证第三方副本/缓存消失。
**后续更新（2026-11-01 晚）**：经用户授权已按方案 B 在本地执行历史重写（测试记录姓名替换为虚构文本；feat 分支与 master 已重写、`v0.2.8` tag 重建指向脱敏提交、旧 SHA 不再可达；`v0.2.3` 标签对象未变）。详细证据见 `docs/HISTORY-PRIVACY-ANALYSIS.md` 与最终发布报告。

## 4. 默认安全：旧版/新版行为与 beta 闸门（B 阶段，见实现报告）

- 目标：**v3.0.0-beta.1 全新安装默认安全（mock + 真实发送禁用），旧配置升级也不默默提升权限**。
- 实现：`config.betaSafeMode` 默认 `true`；真实通道发送在 `engine.canSend` / `engine.processInner` 早退 / `desktop.send()` 首行 / `/test/send` / `/drafts/approve` / PS1 `-NoRealSend` 多层拒绝；mock 体验与只读诊断不受影响。
- 证据与数字：见 §6 与 `docs/READ-ONLY-MODES.md`。
- 说明：`readOnlyTestMode` 仍默认 `false`（只读测试模式是另一独立开关）；beta 的「默认不发真实消息」由 `betaSafeMode` 保证，不依赖任何 UI 开关。

## 5. 真实功能边界（B 阶段）

- 对外定位：`v3.0.0-beta.1 — Developer Preview / 开发者预览版`，面向技术同学的公开测试版，不是稳定版。
- 已可用且本次验证：mock 入站与人格模拟、本地零 token 规则、DSH LLM 生成（依赖宿主所选模型，可能产生费用）、本地记忆与摘要、草稿/confirm 模式、OCR 纯函数与离线合成语料基准、诊断、只读测试模式、鉴权与发布包检查。
- **未经本次实机验收**：真实微信 desktop 读取/气泡归属/联系人关联/发送/GUI 自动化；PS1 仅在静态 + mock 语义上验证；OCR 准确率只在合成语料上测得（CER 22.07%/整句 51.52%，限定口径，不可外推真实微信）。
- 未接入生产：`fusion.ts` / `align.ts` / `tracker.ts`（离线实验 + 单测）。
- 可选未实测：RapidOCR 新 `rapidocr` 包（本机未安装，仅适配代码 + stub 测试）；Worker 未接线。
- 未来规划（非 beta）：插件市场、长期关系记忆、云端多模态。

## 6. 门禁实测（真实命令与结果）

（2026-11-01 12:15–12:25，无并发顺序执行；工作树含本轮未提交改动）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错（exit 0） |
| `npm run test:sandbox` | **43 文件 / 729 用例全过**（含 beta 闸门 16 条，exit 0） |
| `npm run build` | exit 0（`dist/index.js:41` PLUGIN_VERSION=`3.0.0-beta.1`） |
| `node scripts/check-sensitive.mjs` | **222 个受跟踪文本文件 0 命中**（exit 0） |
| `node scripts/check-package.mjs` | **197 候选 0 违规**（exit 0，1 条本地垃圾警告，不入包） |
| `npm run verify:api` | **25/25**（exit 0；脚本显式 `betaSafeMode:false` 以覆盖发送链路） |
| 本机 API 安全字段保护（回归） | 兼容模式下 `POST /config` 显式变更 `betaSafeMode` / `apiToken` → 403 `safety-fields-require-auth`；未变更安全字段保存 → 202；已配置 token + Bearer → 202（4 条新用例） |
| 发布候选 tgz | 199 文件（历史重写后最终树重建）；SHA256 见 Release 附件 `SHA256SUMS.txt` |

## 7. 发布候选包与安装验收（C 阶段）

- 候选附件：`dsh-wechat-persona-3.0.0-beta.1.tgz`（按 RELEASE-CHECKLIST §6.4 用受跟踪文件 + dist 制作），SHA256 见 Release 附件 `SHA256SUMS.txt`。
- 干净模拟安装（`%TEMP%` 独立目录 + 宿主依赖 junction，不联网）：**19/19 通过** —— 默认 `activeChannel=mock`、`betaSafeMode=true`；`GET /config` 确认默认值；mock 入站 202 且 audit 出现 send 事件；`POST /test/send` 409、`DesktopChannel.send` 返回 `delivery=not-sent` 且 `runScript` 0 次调用、`betaSafeScriptArgs()=["-NoRealSend"]`；包内 PS1 BOM 正常且 `-NoRealSend` 硬阻断行号正确；回滚演练后安装目录与临时 dataDir 均删除、仓库与 `dist/` 完好。
- **未执行且如实标注**：真实 DSH profile 安装/卸载/回滚、跨 OS、真实微信；第三方同学真实安装未做过（只能称「内部干净模拟」）。
- 安装/回滚步骤见 `docs/BETA-QUICKSTART.md`；已知限制见 `docs/BETA-LIMITATIONS.md`。

## 8. 隐私与 PII（不展示原文）

- 工作树：`check-sensitive` 扫描结果见 §6；无真实姓名/联系人/wxid/邮箱/密钥命中（扫描器 12 条盲区见 `docs/PII-INVENTORY.md`）。
- 未跟踪但本地存在（**本轮未删除/未移动/未上传**）：`.dsh-tmp/`（361 文件/≈24.9MB，含真机截图，OneDrive 同步范围内）、`dev-notes/`（6 文件）、`backups/`（11 文件）、`%TEMP%` 下 wxuia 截图 7,722 张（≈2.38GB，非 OneDrive）。
- 处置建议（按最小影响排序，需用户逐项确认后执行）：① 补建的新全量备份已完成，旧敏感备份可择机加密/移除；② `.dsh-tmp/`/`dev-notes/`/`backups/` 移入非同步受限目录或加密归档（不删除）；③ `%TEMP%` 截图按需清理（不影响发布物，发布物已排除）；④ OneDrive 云端历史版本/回收站需用户在网页端确认。
- 发布候选 tree/包/Release 附件**不含**上述私人文件（由 check-package 与包内清单保证）。

## 9. 微信实机 / 算法 / 通道未验证事项

- 真实微信窗口读取、气泡归属、联系人验证、发送、GUI 自动化：**未实机验收**（本轮任务书禁止操作真实微信）。
- PS1：静态检查（ParseErrors=0、BOM、无 LF）+ mock 语义 + 6 组滚动场景模拟；未在真实微信窗口跑过。
- OCR：合成语料离线口径；真实微信字体/DPI/主题/遮挡/滚动未测；错误联系人率未测量（未知）。
- 只读模式：engine/API/desktop/PS1 四层代码证据 + 12 入口 mock 测试；真实微信下未验证。

## 10. 是否符合 beta.1 有限预览发行要求

| 要求 | 结论 |
| --- | --- |
| 目标版本 = v3.0.0-beta.1，Pre-release 而非稳定版 | ✅（版本一致性见 §6） |
| 默认 mock + 真实发送默认关闭，且代码层多门禁 | ✅（§4） |
| 不把未验证能力宣传为可用 | ✅（docs/BETA-LIMITATIONS.md + README 首屏） |
| README/免责声明/发布说明/隐私边界一致 | ✅（task-27 文档集） |
| 包可用、可校验、安装步骤可复现 | ✅（本地模拟；真实 DSH 安装未做） |
| P0：token 已轮换 | ❌ 待用户执行 |
| P0：历史实名处理决定 | ❌ 待用户决定 |

## 11. 发布前用户最少操作（必须用户亲自做，DSH 不代做）

1. 轮换 `api-token` 并验证旧 token 401（§2）。
2. 对历史实名给出 A/B 决定（§3）。
3. 复核 `docs/releases/v3.0.0-beta.1.md` 与 `README.md` 首屏，确认无夸大口径。
4. 明确授权：`git push origin feat/v3.0.0`（或合并到发布分支）+ 创建 tag `v3.0.0-beta.1` + 创建 **Draft → Pre-release**（勾选 Pre-release，不勾 Latest）。
5. 如需真正的第三方安装验收，可自行找一位同学按 `docs/BETA-QUICKSTART.md` 试装并回传脱敏结果。

## 12. GitHub Release 具体操作步骤（授权后）

1. `git push origin feat/v3.0.0`（用户确认后；无 force）。
2. `git tag -a v3.0.0-beta.1 -m "v3.0.0-beta.1 — Developer Preview"` → `git push origin v3.0.0-beta.1`（同样需明确授权）。
3. GitHub → Releases → Draft a new release：
   - Choose tag：`v3.0.0-beta.1`；
   - Target：发布分支（建议 `master` 先合并，或按用户选择）；
   - Title：`v3.0.0-beta.1 — Developer Preview / 开发者预览版`；
   - 勾选 **Set as a pre-release**；**不要**勾 Latest；
   - 正文：粘贴 `docs/releases/v3.0.0-beta.1.md`；
   - 附件：`dsh-wechat-persona-3.0.0-beta.1.tgz` + `SHA256SUMS`（不要上传 bundle/备份/截图）；
   - 确认自动 Source code (zip/tar.gz) 只是源码归档，不是可直接安装的插件包，正文中已注明。
4. Publish（用户点击；DSH 不代为发布）。
5. 发布后检查：附件可下载、SHA256 匹配、Release 页面无敏感信息、Issue 模板可用。

---

**最终一句话**：v3.0.0-beta.1 的本地候选、文档与发布素材已备齐且门禁可复现；远程发布只差用户的 5 项最少操作，其中「token 轮换」与「历史实名处理」是 P0 阻断。

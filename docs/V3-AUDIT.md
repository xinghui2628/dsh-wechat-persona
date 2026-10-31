# v3.0.0 审计与基线报告（Phase A）

> 本文所有结论来自只读审计（三名并行审计员 + Lead 复核）、代码行号与真实命令输出；
> 不包含任何真实好友名 / wxid / 本机绝对路径 / 令牌。示例联系人均为虚构（好友 A/B/C）。

## 1. 审计范围与方法

| 项 | 内容 |
| --- | --- |
| 仓库基线 | `feat/v3.0.0` 分支（自 `master` HEAD `42a3caa` 切出）；审阅时工作树 clean |
| 审计方式 | 只读；每名审计员输出「file:line + 证据 + 严重度」，Lead 对关键路径逐行复核 |
| 审计员 | ①OCR 流水线（`scripts/pwsh/wechat-uia.ps1`、`scripts/py/rapid_ocr.py`、`src/channels/pc/desktop.ts`）②可靠性与发送安全状态机（`src/engine/engine.ts`、`src/core/*`、`src/server/api.ts`）③隐私与敏感信息（全仓库 + git 历史，脱敏输出） |
| 未做的事 | 未用真实微信联系人做任何发送/截图操作；未修改任何被审计文件；未联网 |

## 2. 基线数据（真实命令输出）

- 工具链：Node `v26.13.0`、npm `11.20.0`、TypeScript `5.9.3`、vitest `3.2.7`，`engines.node >= 22`。
- `npm run typecheck`：0 错误（基线）。
- `npm run test:sandbox`：**30 个测试文件 / 416 个用例全部通过**，约 1.5s。
- OCR 运行环境（本机实测，仅用于 benchmark，不接生产流程）：
  - Windows.Media.Ocr：可用，语言 `zh-Hans-CN`，单帧约 70–120ms（合成图 480×200 / 1200×830）。
  - RapidOCR（`rapidocr_onnxruntime 1.2.3` + `onnxruntime 1.31.1` + `Pillow 13.0.0`，Python 3.14.2）：可用；单进程 import 约 0.24s、模型初始化约 0.66s；1200×830 冷约 3.3s / 热约 2.0s；3 倍放大对行数无收益。
  - 新的统一包 `rapidocr` **未安装**（`ModuleNotFoundError`），迁移需单独评估（见 Phase C）。
  - 结论：合成语料 + 双引擎离线 benchmark 在本机可跑；生产链路仍只走 PowerShell OCR（不新增 Python 运行时依赖）。

## 3. 缺陷清单

严重度定义：P0 = 可能丢消息 / 发错人 / 重复发送 / 隐私泄露；P1 = 可靠性或可解释性明显不足；P2 = 维护性问题。

### 3.1 OCR 与读取流水线

| ID | 严重度 | 位置 | 问题 |
| --- | --- | --- | --- |
| OCR-H1 | P0 | `scripts/pwsh/wechat-uia.ps1:1925-1980` | 基线**先消费后输出**：新行先全部并入 baseline（`:1956-1962`），最后才截断输出（`:1978`）。上游一旦丢弃/异常，这些消息永久丢失，且重读拿不到。 |
| OCR-H2 | P0 | `wechat-uia.ps1:1957-1959`、`desktop.ts:515/551` | 截断丢消息：输出只保留最后 10 条，其余直接并进基线。 |
| OCR-H3 | P0 | `wechat-uia.ps1:1841` | 双引擎投票**另拍一帧**：第二引擎的截图与第一帧不是同一时刻，仅按 y±26px + 无序重合度匹配，滚动时会把两行错拼。 |
| OCR-H4 | P1 | `desktop.ts:622-624`、`wechat-uia.ps1:1596-1604/:1617-1619` | 发送定位可能过期：180s 内 `lastActiveContact` 被当作「当前会话」；脚本 trustedOpen 分支跳过标题 OCR，点行后只验证绿底。 |
| OCR-M1 | P1 | `wechat-uia.ps1:716-736` | 气泡左右归属只按单个中点 + 硬编码窗格比例；他人长气泡越线会被误判成自己发的而丢弃。 |
| OCR-M2 | P1 | `wechat-uia.ps1:1873`、`desktop.ts:160` | 双引擎融合偏向「更长」的文本，长文本里多出的噪声会被当成更完整。 |
| OCR-M3 | P1 | `desktop.ts:108-134`（v0.2.8） | 词典纠错无保护：3–6 字、同长度、差 1 字即替换；词表含高频词，存在误改风险。 |
| OCR-M4 | P1 | `wechat-uia.ps1:1719-1737/:1826` | 发送后气泡确认弱（`typedSeen` + 输入框 ink<20）；「已回车但没读到气泡」时返回 `ok:false`，上层会重试 → 重复发送。 |
| OCR-M5 | P1 | `scripts/py/rapid_ocr.py:27` | 每次调用都重建 RapidOCR 模型（单次 4–7s），加上 2s 轮询与 90s 脚本上限，第二引擎在真实窗口上很难稳定参与。 |
| OCR-M6 | P2 | `wechat-uia.ps1:1133` | 基线文件非原子写，强杀进程可能留下半截 JSON。 |
| OCR-L1 | P2 | `wechat-uia.ps1:1148` | `Wait-TextVisible` 为死代码。 |
| OCR-L2 | P2 | `wechat-uia.ps1:1840/:1883` | 双引擎临时 PNG 无 `finally` 清理。 |

### 3.2 消息可靠性与发送安全

| ID | 严重度 | 位置 | 问题 |
| --- | --- | --- | --- |
| REL-P0-1 | P0 | `engine.ts:142-146/:400/:656-709`、`gate.ts:152` | 任务书 9.2 成立：`pause()` 只改状态；paused 只在生成前判一次；拟人延迟结束后直接进入发送循环，**发送前不复查**；多 part 中途暂停也继续发。`types.ts:93` 的 `AbortSignal` 声明从未使用。 |
| REL-P0-2 | P0 | `wechat-uia.ps1:1735/:1826`、`engine.ts:668-676` | 三态缺失：脚本「已回车但未确认气泡」返回 `ok:false` 且声明已跳过重发，engine 却对 `ok:false` 无条件重试 → 可能重复发送；90s 超时同样返回 `ok:false`（`desktop.ts:286-289`）。 |
| REL-P0-3 | P0 | `desktop.ts:623-624/:641-648/:655`、`wechat-uia.ps1:1596-1604/:1643-1665` | 跨联系人误发：180s 内 `lastActiveContact` 被信任、trustedOpen 跳过标题 OCR、回复窗口 120s 内跳过用户活跃保护；用户切聊天后回复会发错会话，且气泡检测仍返回成功。 |
| REL-P1-4 | P1 | `gate.ts:152-155` | 暂停期间入站消息丢失：skip 不写指纹，但脚本基线已前进、inFlight 已占位，恢复后不会补处理。 |
| REL-P1-5 | P1 | `api.ts:1203-1215`、`engine.ts:229-237` | `/test/send` 与 `send_test` 绕过门禁：不经暂停/熔断/预算/频控/白名单，直调 `channel.send`。 |
| REL-P1-6 | P1 | `desktop.ts:580/:584-589` | 去重 id 不稳定：同文本同哈希，6 小时内重复内容会被误当重复；预览 id 含分钟桶导致同一消息跨分钟出现两次；inFlight > 200 整体清空。 |
| REL-P1-7 | P1 | `engine.ts:111-129/:677-722`、`desktop.ts:394-399` | 重启后重复回复（成功后才 persist）；`engine.start` 不检查 paused/breaker；`desktop.stop` 不终止在飞发送脚本。 |

### 3.3 隐私与敏感信息

| 严重度 | 位置 | 问题与处置 |
| --- | --- | --- |
| 高 | `docs/ACCEPTANCE.md:304` | v0.2.8 OCR 实测记录中残留一处真实感中文全名（随 `9db6c5b` 进入 `origin/master`，公开不可逆）。v3.0.0 起替换为虚构名；是否改写历史由维护者决定。 |
| 中 | `docs/HANDOFF-0.3.0.md:32-40,50-58` | 本机环境指纹（安装路径、代理/DSH 端口、GitHub 账号、屏幕/Node 版本）→ 泛化；发布包 `files` 剔除该文件。 |
| 中 | `.dsh-tmp/`、`dev-notes/`、`backups/` | 本地忽略但位于仓内：含真机聊天截图（约 23.7MB）与用户名。禁止入库，发布前由维护者手动清理；CI 增加敏感信息扫描。 |
| 低 | `docs/QA-RELEASE-AUDIT.md:20/:263` | wxid 均为合成值；其「真名已清」结论已过期 → 追加更正说明，不改历史结论原文。 |

其余检查（Token/私钥/手机号/真实邮箱/C:\Users 路径）0 命中；git 历史为单作者 noreply 身份，无日志/截图/数据文件入库。

### 3.4 测试覆盖缺口

- `test/engine/acceptance.test.ts:94-113` 的 FakeChannel 恒返回 `{ok:true}`，无法覆盖「暂停后不发」「unknown 不重试」。
- `/stop` 只验证不再调模型（`:467`），不验证在飞发送被打断。
- `test/channels/desktop.test.ts:239` 只测 `ok:false` 透传；`test/server/api.test.ts:1085` 只断言透传，未断言门禁。
- OCR 侧缺少纯函数单测与离线 benchmark：v0.2.8 的 OCR 逻辑全部内联在 `desktop.ts`（含 `// @ts-nocheck`），无法单独回归。

## 4. 分阶段计划与验收

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| A | 审计基线（本文）+ 隐私脱敏 + 敏感信息扫描门禁 + 合成 OCR 语料 | `npm run check:sensitive` 0 命中；`typecheck` 干净；416 用例仍全绿 |
| B | OCR 纯逻辑抽取到 `src/core/ocr/*`；`desktop.ts` 去掉 `@ts-nocheck` 与 `any` | 新模块单测通过；`typecheck` 干净；`desktop.test.ts` 27 用例不变绿 |
| C | 同帧截图 + 双引擎融合 + 受控纠错；离线 benchmark 做 v0.2.8 vs v3.0.0 A/B | benchmark 报告有真实数字；关键指标不低于 baseline（除明确记录的回退项） |
| D | 发送可靠性 P0-1/P0-2/P0-3、P1-4/5/6/7；三态发送结果 | 新增回归用例全绿；`unknown` 不自动重发；暂停后 0 次发送 |
| E | API 鉴权加固（不再仅依赖单一请求头）、`/test/send` 走门禁、人格导入安全 | api 回归用例覆盖越权/绕过路径 |
| F | 首次配置向导、OCR 诊断中心、人格模拟器、安全运行模式 | 默认不真实发送；诊断数据可解释 |
| G | 文档（README/ARCHITECTURE/OCR-DESIGN/PRIVACY/SECURITY/MIGRATION/RELEASE-CHECKLIST）、CI、发布准备 | 发布门槛 10 条逐条有证据；未获批准不 push/不发布 |

## 5. 风险与缓解

1. **窗口 OCR 依赖真实像素**：所有算法改进必须在合成语料上先证明可测，再谈真实窗口；真实环境只做只读验证。
2. **同帧约束需要改 PS1**：`wechat-uia.ps1` 编辑有硬性规则（先改名备份、UTF-8 带 BOM、禁止 PS5.1 管道替换），由 Lead 统一把关。
3. **发送安全修复不能只加测试**：每条 P0 必须有「门禁 + 状态机 + 回归用例」三件套，且默认配置下宁可拒发。
4. **公开仓库不可逆**：隐私修复后仍需维护者决定是否改写历史；本文与所有提交信息均不含敏感值。

## 6. 实施进度快照（2026-10-31 交付时）

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| A 审计基线 + 隐私脱敏 + 扫描门禁 + 合成语料 | 已完成 | 本文；`scripts/check-sensitive.mjs`（0 命中）；`test/fixtures/ocr-corpus/`；`docs/OCR-BENCHMARK.md` |
| B OCR 纯逻辑抽取 + desktop 强类型化 | 已完成 | `src/core/ocr/{types,geometry,normalize,correction,vote}.ts`；`test/core/ocr-pure.test.ts`；`desktop.ts` 无 `@ts-nocheck`/`any` |
| C 同帧/基线不丢/气泡归属/原子写 + 离线 A/B | 已完成 | `e8316b2`（PS1 同帧、`-Ack` 水位线、pending、原子 Save-State；`core/ocr/{bubbles,baseline,pipeline}.ts`；ack 持久化到 dataDir）；`docs/OCR-BENCHMARK.md §6.5` |
| D 发送可靠性 P0-1/P0-2/P0-3、P1-4/5/6/7 | 已完成 | `dfbc9c1`；`test/engine/acceptance.test.ts`、`test/server/api.test.ts`、`test/channels/desktop.test.ts` 回归 |
| E API 鉴权/导入安全 | 已完成 | `364c57b`；`docs/SECURITY.md`；`test/server/api.test.ts` 鉴权/导入用例 |
| F safeMode/诊断/向导/模拟器 | 已完成 | `f63decc`；`client/client.js`、`src/engine/engine.ts:406-423`、`GET /diagnostics/ocr` |
| G 文档/CI/发布准备 | 已完成 | `646a2ba`；README 12 节、6 份新文档、`ci.yml` 两 job、`docs/RELEASE-CHECKLIST.md` |

**门禁真数**：`npm run typecheck` 0 错；`npm run test:sandbox` 34 文件 / 548 用例全过；`node scripts/check-sensitive.mjs` 0 命中；`npm run build` 通过。

**OCR 发布门槛第 2 条（可测量改善）**：eval 集（20 图 / 46 条消息，离线等价）v3 CER 21.38% / 整句 47.83% vs v0.2.8 baseline 37.37% / 28.26% → 达成；限定「合成语料 + 离线等价」，真实微信未验证，不得据此宣称真实环境已可靠。

### 残余风险（交付时如实记录）

1. 未用真实微信联系人做端到端/发送验证；PS1 同帧与气泡边距阈值需真机校准（`WXUIA_UPSCALE`/`-PaneLeftRatio` 可调）。
2. 第二引擎（RapidOCR）在 eval 集上 0 次替换：增益主要来自 WinRT 2x + CJK 归一；融合空间存在（vote-all 上界）但在线 1.4–2.1s/帧不可行。
3. 真实环境未验证项：safeMode/诊断/向导的实机效果、插件在宿主中「重启后 ack 持久化」的实际行为。
4. 未 push / 未打 tag / 未发 Release；v0.2.8 历史提交中的实名残留是否改写历史由维护者决定。

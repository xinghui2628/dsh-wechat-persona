# v3.0.0 隐私整改与实机验收准备报告（Round 3）

> 对应任务书：`DSH_v3.0.0_隐私整改与实机验收准备_完整提示词.md`（282 行）。
> 本轮原则：**不 push、不发 Release、不改历史、不动任何 PII 目录、不碰真实微信**；只做只读审计、本地修复、离线/mock 验证与准备。
> 状态：已完成，本报告为 Lead 主笔并已并入 5 份队友专项报告（task-21~25）。基线：`feat/v3.0.0`，HEAD `2823439`（本轮改动提交前），相对 `42a3caa` 21 个本地提交，未 push。

## 结论先行

| 问题 | 结论 |
| --- | --- |
| 仓库公开状态 | **public**：`https://github.com/xinghui2628/dsh-wechat-persona`；`package.json` 的 `private:true` 只影响 npm 发布，**不代表仓库私有**（README/CHANGELOG/ARCHITECTURE/RELEASE-* 文档已按此纠正） |
| 本地 Git 状态 | `feat/v3.0.0`，HEAD `2823439`，相对 `42a3caa` **21 个本地提交**（此前曾写 19/18，本报告统一为此数）；无 upstream；本地 tag `v0.2.3`/`v0.2.8`；远端是否有同名 tag 需联网核实 |
| 备份 | `%TEMP%\dsh-wp-backup\v3.0.0-20261101-103304.bundle` 2,432,226 B，SHA256 `DB89EAB638B7A07A360300E0ABA038D0D2077F09D639A110E8F59AE17CFFB7D3`（校验一致；目录非 OneDrive）；**但该 bundle 的 head 为 c05a24a，落后当前 HEAD 3 个提交，且含公开历史** → 不是历史处置前的唯一备份，处置前须先补新备份（D-8） |
| PII 目录 | `.dsh-tmp/` 361 文件/26,141,720 B、`dev-notes/` 6 文件/20,509 B、`backups/` 11 文件/68,609 B，均未跟踪、已被 .gitignore 覆盖、位于 OneDrive 同步路径；另有 `%TEMP%` 下 7,722 张 wxuia 截图（2,375,968,808 B）与运行 dataDir —— **本轮只做盘点与方案，未做任何处置** |
| 历史实名 | C=1（`docs/ACCEPTANCE.md` 历史 blob 内的真实姓名，当前树已改「测试甲」，`9db6c5b` 引入、`42a3caa` 可达、已公开）；B=1（旧版本地环境指纹，当前树已泛化）；A=4 类合成数据；全对象多编码扫描好友名/本机用户名/疑似 wxid/真实邮箱/密钥均 0 命中；**无已泄露密钥** |
| 只读隔离 | 代码层四层硬阻断（engine.canSend / desktop.send 首行 / API 409 / PS1 -ReadOnly）+ 只读副作用修复（真实通道下不再调用云端 LLM、联网搜索、写消息记忆）；**未在真实微信上执行** |
| 当前门禁 | `npm run test:sandbox` = 42 文件/709 用例全过；typecheck 0 错；build exit 0；check-sensitive 0 命中；check-package 0 违规；verify:api 25/25；`npm pack` 192 文件/749,729 B（解包 2,233,778 B，0 垃圾）；PS1 5.1 ParseErrors=0、BOM 正确 |
| 发布状态 | **不发布**：push/tag/Release/历史改写/真机只读均未获授权 |

## A. 真实代码与 Git 状态

- 分支：`feat/v3.0.0`（无 upstream）；HEAD `2823439`（本轮代码/文档改动在其上，未提交）。
- 提交数：`git rev-list --count 42a3caa..feat/v3.0.0` = **21**。
- 标签：本地存在 `v0.2.3`、`v0.2.8`；远端是否已有同名 tag 需联网确认（本轮未联网）。
- 远程：`origin = https://github.com/xinghui2628/dsh-wechat-persona.git`（public）。
- 版本：`package.json` 3.0.0、`src/index.ts:83` 3.0.0、`dist/index.js:41` 3.0.0；`private: true` 未改。
- 构建：`npm run build` exit 0（dist 按最终源码重建）。

## B. 本地 PII 盘点（只读元数据，不读取内容）

| 目录 | 文件数 | 大小 | 类型 | Git 跟踪 | 忽略规则 | OneDrive | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `.dsh-tmp/` | 361 | 26,141,720 B | png 181 / py 117 / ps1 29 / json 17 / bak 7 / txt 2 / 其它 2 | 0 | `.gitignore:18` | 是 | 真机调试残留（截图含 173 张/24.8MB，C 类）；未读取内容 |
| `dev-notes/` | 6 | 20,509 B | md/txt/json | 0 | `.gitignore:23` | 是 | 开发笔记（C/B 类） |
| `backups/` | 11 | 68,609 B | json/ts/yml/jsonl/md | 0 | `.gitignore:22` | 是 | 旧版文件备份（C/B 类） |
| `%TEMP%\wxuia-*` | 7,722 | 2,375,968,808 B | png + 日志 | 0（仓库外） | — | 否 | C 类；运行期临时文件 |
| 运行 dataDir | 14 | 137,624 B | json/jsonl/记忆/token | 0（仓库外） | — | 否 | 含 api-token、audit.jsonl、uia-state.json、drafts.jsonl、memory/（A 类保留+访问控制；token 曾外发需轮换） |

- 处置方案（本轮均未执行，等用户批准）：
  - **A 保留并隔离**：本地保留；确认 `.gitignore`/发布包排除；不进入提交或分发物。风险=日后误 `git add -f` 或手工打包可能泄露。
  - **B 脱敏保留样本**：仅抽取无个人信息文件作测试夹具（人工检查后）；原目录仍本地保存。
  - **C 经用户单独批准后删除**：需明确指令并按「先备份→确认→删除」流程。
- `check-sensitive.mjs` 盲区：不扫描二进制图片、压缩包、`.dsh-tmp/` 等未跟踪目录、Git 历史、`.bak`/`.pyc`；只覆盖 `git ls-files` 受跟踪文本文件。本轮建议：把历史扫描与二进制/压缩包规则纳入 CI 或独立门禁（未实现，列为待授权项）。
- OneDrive 云端/回收站/版本历史/在线引用：无法离线确认，需用户在其账号内核查。

## C. Git 历史隐私问题（只给证据与预案，不执行改写）

| 类别 | 内容（脱敏） | 位置 | 可达性 | 建议 |
| --- | --- | --- | --- | --- |
| C 确认敏感 | 真实感中文姓名 `<MASKED-姓名>`（仅历史 blob，当前树已是「测试甲」） | `docs/ACCEPTANCE.md`；`9db6c5b` 引入、`42a3caa`（origin/master）可达 | 已推送、公开可达、不可撤回 | 需用户拍板：保留（永久暴露）或隔离镜像试验重写（不推送）+ 必要时 GitHub Support |
| B 疑似/需判断 | 旧版本地环境指纹（安装路径/端口/handle 等，当前树已泛化） | `42a3caa` 版 `docs/HANDOFF-0.3.0.md` | 已推送 | 影响面较小，同 C 处置 |
| A 虚构/合成 | 合成手机号、wxid、白名单邮箱、占位路径、虚构名、合成语料 | 全仓库 | — | 无需处理 |

- 影响清单（若做历史重写）：21 个本地提交需 rebase 重放（预计仅 `6eceaff` 冲突）；`v0.2.8` tag 需重建；已推送分支需 force push（未授权）；fork/PR/clone/缓存/旧 SHA 引用可能继续暴露；GitHub Support 只能缓解。
- 方案对比：**保留历史**（0 操作风险，暴露不可逆） vs **隔离镜像局部重写**（需 force push + 通知协作者 + 备份回滚；本轮只做预案，不推送）。
- 已泄露密钥：无（全对象扫描 0 命中）；未来若发现应优先轮换而非仅改历史。

## D. 真实生产调用链矩阵（以代码为准，pipeline-fixer 复核）

| 模块 | 使用状态 | 生产调用者 / 证据 |
| --- | --- | --- |
| PS1 `scripts/pwsh/wechat-uia.ps1` | 已接入 | desktop `runScript`(:432) → powershell -File；截图 `Get-WindowShot:492`；OCR `Get-OcrLines:554`（Windows OCR 无原生 confidence）；候选/归属 `Get-InboundCandidates:802`/`Get-BubblePane:756`/`Get-BubbleSide:775`；read 主体 `:1964+`；同帧第二引擎 `-SecondOcr :1986-2050`（复用 `$script:LastSnapshotImage`，不二次截图）；pending/ack `:2096-2256`（captureSeq/messageSeq、`^cap-(\d+)` ack、先 Save-State 后输出）；异常统一 `{ok:false,error}` |
| `pipeline.ts planInboundDispatch:112` | 已接入（唯一生产消费者） | `desktop.planRead:663`；输入 captureId/ack/pane/messages → accepted/rejected/nextAck/counts；纯函数不抛 |
| `confidence.ts evaluateConfidence:103` | 已接入（有证据时） | `desktop.evaluateMessage:820`（planRead 之后、emit 之前）；缺证据→null（legacy/旧脚本兼容）；reject/verify 不投递且不推进 ack |
| `bubbles.ts classifyBubble:82` | 已接入（间接） | 由 pipeline 几何归属调用；纯函数 |
| `baseline.ts stableMessageId:221 / seqFromCaptureId:65` | 已接入（间接） | 仅给缺 id 的 legacy 消息兜底 + nextAck 解析 |
| `correction.ts correctOcrText:174` | 已接入 | `desktop.recheckGarbledText:502`（含 contactNames 词典纠错） |
| `fusion.ts matchLines:126` | **未接入生产** | `grep "from '.*fusion.ts'" src` 无匹配；仅离线 bench/单测 |
| `align.ts alignLineSequences:75` | **未接入生产** | 同上 |
| `tracker.ts classifyFrameDelta:97` | **未接入生产** | 同上（跨帧跟踪未接入；PS1 用基线尾对齐+锚点，desktop 用 pending/ack+deliveredIds） |
| `desktop.ts` | 已接入（编排） | `readInboundOnce:886`、`planRead:663`、`planReadLegacy:717`、`emitMessage:1112`、`wasDelivered:811`、`evaluateMessage:820`、`rememberDelivered:367`、`loadDeliveredState:353`、`commitAck:759`、`send:1138`、`status:592` |
| `engine.ts` | 已接入（决策/发送） | `handleInbound:967`→`process:976`→`processInner:997`；`canSend:486`（read-only:501）；只读早退 `:1114-1133`；发送循环 `channel.send:1418`；暂停入队 `deferInbound:581`；草稿 `approveDraft:830` |
| `api.ts` | 已接入 | `/diagnostics/ocr:1301`+`normalizeOcrDiagnostics:1064`；`/status:1249`；`/test/send:1722`；`/drafts/approve:1779` |

**结论**：生产读取路径 = 「PS1 截图/OCR/候选 → `pipeline.ts`（归属/拒绝）+ `confidence.ts`（有证据时）+ `correction`/`vote`/`normalize` → desktop 去重/ack → engine」。`fusion/align/tracker` 是离线实验能力，**不得当作线上收益**；`confidence` 为部分接入。

### D.1 消息 ID 稳定性结论（14 条端到端离线用例）

- 身份 = `pc-<captureSeq>-<messageSeq>-<几何hash>`（PS1 `:2109/:2230`），**不含文本**。
- 连续截图：同一消息只首次进 pending；后续帧基线已含其文本→不新增；重放输出保持存储 id → desktop `inFlight`+`deliveredIds` 去重 ✓（场景 1：10 次读取只投 1 次）。
- 同文连发两条：同帧 `messageSeq` 不同→id 不同 ✓（场景 2）。
- OCR 文本变化：id 不变 ✓（场景 3）。
- 滚动：原 PS1 尾对齐缺陷已修（`:2181-2205` 新增锚点对齐：尾对齐失败→从基线末尾最多 20 条找锚点，只取锚点之后为新行；滚到已知历史 newLines 为空、不重置基线；完全无锚点才按设计重置）；场景 4 验证旧消息不再投递。
- 重启：PS1 state + `desktop-ack.json` + `desktop-delivered.json` 三重持久化；场景 5 第二实例 0 重复投递 ✓。
- 实际消重层（强→弱）：①PS1 pending 存储 id + ack 水位线；②desktop `inFlight`（进程内）+ `deliveredIds`（跨重启，FIFO 500）；③pipeline duplicate（仅同帧同 id）；④engine `send-ledger`（防重复发送，非投递去重）；⑤engine seen/频控。

## E. 只读安全边界与副作用

- 四层硬阻断（代码层）：
  1. engine `canSend`：`reason='read-only-mode'`（mock 通道豁免；覆盖自动回复/重试/sendTest/草稿批准）；
  2. desktop `send()` 首行拒绝（不依赖 engine、不调脚本）；
  3. API：`POST /test/send` 与 `/drafts/approve` 只读 409（reject 放行）；
  4. PS1：`-ReadOnly`/环境变量入口硬阻断（send 在找窗口前 Fail-With；read 非 `-NoSearch` 直接失败；不抢前台/不切窗口）。
- **副作用已收窄**（task-22）：`engine.processInner:1114-1133` 在 `validated` 之后、预算/频率/搜索/记忆/LLM 之前对真实通道早退（skip reason `read-only-mode`，detail 说明「未授权对真实聊天调用云端 LLM、联网搜索或写入消息记忆」）→ 真实通道下 `llm.calls=0`、`search.queries=0`、不写消息记忆；`canSend` 只读门禁保留为二道防线（sendTest/草稿/重试等入口）。审计/状态落盘仍写入（诊断必需）。
- 只读下仍可能发生：审计/状态/日志写入（本地，诊断必需）；mock 通道正常走 LLM（用于测试）；这些已在 `docs/READ-ONLY-MODES.md` §8 副作用表列明。
- 绕过路径矩阵（12 入口，mock/单测证据）：engine 正常路径、直接 `channel.send`（全仓仅 engine 三处，均在门禁后）、`/test/send`、`/drafts/approve`、插件工具接口、旧队列/定时器、重启读旧状态/账本/草稿、PS1 直调/错误参数、配置组合（safeMode/sendMode/readOnlyTestMode/ocrPipelineMode）、运行期切换、UI 点击确认 → 全部拒绝；`sent=0`、`sendCalls=0`、recorder 无 `-Action send`、audit skip 记录正确。
- 14 条端到端离线用例（`test/channels/desktop-e2e.test.ts`）覆盖：同一消息识别 10 次只交付 1 次、同文两条算两条、OCR 错→对不重复、滚动旧消息不投递、重启不重放、相似昵称/长消息/左右气泡不误归属、多联系人不串、置信度冲突拒投、unknown 不重发、暂停/只读不发送、只读全接口拒绝、依赖失败降级。
- 模式定义：`docs/READ-ONLY-MODES.md` 定义四模式（offline-replay / passive-capture / interactive-read / draft-confirm-auto）与授权状态；本轮只做 mock/注入测试，真实微信四种模式**一律未授权、未执行**。

## F. OCR 指标与渐进方案

- 语料口径（bench-builder 复核）：60 图 = 30 场景 × 2 变体；tune/eval 各 15 模板/30 图，**场景零重叠**；eval 66 条消息/666 GT 字符/70 GT 行；29/30 场景两变体文本不同；全语料唯一 GT 文本 137/144；tune∩eval 的共享文本只有 2 条常见寒暄（2 字与 3 字各一条）。**合成语料 ≠ 真实微信，绝对 CER 不可外推**。
- A/B 六组（eval，CER/整句准确率）：A v0.2.8 baseline 35.59%/30.30%；B 仅预处理（winrt 3x）22.82%/51.52%；C 仅引擎（rapid 首读）2.25%/84.85%；D B+新对齐 24.47%/51.52%；E D+消息级全融合 12.91%/63.64%；F B+投票/纠错（**不含 align**）22.07%/51.52%。→ 相对 A：CER −13.52pp、整句 +21.22pp；E 不是「孤立融合」、F 不是「完整 v3」（口径已更正）；增益主要来自 WinRT 2x/3x + CJK 空格归一，融合/对齐贡献在噪声内。
- PS1 新门槛离线复算（非生产收益）：旧门槛 CER 22.07%/整句 51.52% → 新门槛 19.82%/63.64%（11 条替换，8 改善/3 变差，变差均为「单行替换整条多行消息」丢尾部）→ 建议保持当前保守门槛，先做阈值标定实验。
- 九类误差再分类（eval 66 条消息）：截图失真 gaussian 88.89%、stretched 90.00%；错误裁剪 2 张图 GT bbox 越界；漏行 11/70=15.71%；形近字 4.76%；行合并 eval 0（tune 1.23%）；跨气泡**未知**（语料单会话）；消息位置归属 110/144=76.39%、uncertain 23.6%；词典误改 3 条/误改 0；候选冲突 28/66=42.42%；错误联系人关联**未测量（未知）**。
- 阈值语义：TS `confidence.ts` 0.75/0.45 是规则加权分区间（**不是概率**）；PS1 0.90 是同帧双引擎文本重合度、0.85 是 RapidOCR 原生 score 采纳线；三者量纲不同，文档与代码注释已明确「不得称 75%/90% 正确概率」。
- `fusion/align/tracker` 四阶段渐进接入计划（`docs/OCR-BENCHMARK.md` §6.10）：S0 离线 shadow（同输入比较 legacy/v3，不影响投递）→ S1 受控 Feature Flag + 保守拒绝（验收：重复事件下降、零新增错投、延迟不显著升；回退 flag/legacy）→ S2 纯虚构端到端 → S3 用户授权后真实设备只读回归（关闭 flag 即回退）。现状三者仅测试引用，生产未接。
- RapidOCR：适配代码就绪（双路径 auto/unified/legacy，boxes/txts/scores 映射有 stub 覆盖），**本机未安装新包、未实测**；旧包 1.2.3 Apache-2.0 已回归。Worker 评估（稳态 1323ms/图 vs 现状 3130ms/图，可省≈1807ms/帧、常驻 100–243MB）→ 本期不接线。

## G. 安全问题分级

- **P0 = 0**。
- 本轮已修复（task-22）：①SSRF/DNS rebinding 主要面——`persona-market.ts` 每跳重定向都重做 URL+DNS 解析后全 IP 校验（IPv4/IPv6/mapped/NAT64/私有/回环/链路本地/组播/文档段）、JSON Content-Type、Content-Length+流式 2MB 双限、超时；②UI `personas/install {url}` 改为复用同一校验（`api.ts:827-859`）；③只读副作用（见 §E）；④只读绕过矩阵 12 入口全部拒绝。
- **P1（未完全消除）**：①DNS rebinding 的「校验→建连」TOCTOU 窗口（未做连接层 IP pinning，需替换传输层，已给方案）；②兼容模式默认不强制 token（同机同用户进程可调 API；设置页也无 token 输入入口）；③同用户本机进程威胁边界需文档化；④历史实名 C 类（公开仓库，见 §C）。
- **P2**：IPv6 字面量边界情况、Windows ACL 与 Unix 0600 语义差异、限速重启重置/无轮换、兼容模式告警易忽略、宿主反代下回环判定失真、预览兜底 `emitPreview` 分钟桶 id 跨分钟可能再投一次（既有行为）、`correction.ts` 白名单模糊纠错可能误改含联系人名的文本（本轮不修，列风险）。
- 未验证：真实 DNS rebinding 无法沙箱演练；真实微信/键鼠按任务书禁止；Windows ACL、宿主反代、token 轮换、安装发布包、长期运行压力。

## H. 自动化测试与门禁真数（Lead 统一复跑）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错（exit 0） |
| `npm run test:sandbox` | **42 文件 / 709 用例全过**（2.55s，exit 0） |
| `npm run build` | exit 0 |
| `node scripts/check-sensitive.mjs` | 216 个受跟踪文本文件 0 命中（4 份本轮新文档 `git add` 后扫描；此前快照为 212） |
| `node scripts/check-package.mjs` | 189 候选 0 违规（9 条 gitignore 垃圾仅警告，不进 git 包） |
| `npm run verify:api` | 25 项 / 25 通过（含频控拒绝正期望） |
| `npm pack --dry-run` | 192 文件 / 749,729 B / 解包 2,233,778 B；0 `.bak-*`、0 `.pyc`（发布包建议按 RELEASE-CHECKLIST §6.4 用受跟踪文件制作） |
| PS1 5.1 `[Parser]::ParseFile` | ParseErrors=0、BOM=EF BB BF、LoneLF=0 |
| 文档相对链接 | 102 条，0 缺失；ci.yml YAML 可解析（jobs=verify-windows,linux-guard） |

## I. 发布阻断清单（解决前不得发布）

1. **未获授权**：push / tag / Release / force push / 历史改写（本轮只准备）。
2. 真实设备只读验证未执行（只有代码层 + mock + 离线证据）——不得宣称「实机验证通过」。
3. 历史实名 C 类未处置（公开仓库，暴露不可逆，需用户拍板）。
4. `fusion/align/tracker` 未接入生产（不得当发布卖点）；`confidence` 部分接入（依赖脚本证据）。
5. DNS rebinding 的 TOCTOU 窗口未消除；SSRF 只能说「主要面已加固」。
6. 阈值未标定（0.75/0.45 仅为规则评分）；不得宣称概率意义。
7. RapidOCR 新包未安装未实测；Worker 未接线（仅评估）。
8. 安装/卸载/升级/回退仅离线模拟（无联网安装、无真实 profile 验证）；PS1 锚点/门槛改动仅静态检查 + mock 语义测试。
9. 只读模式在真实微信上未执行；LLM/搜索副作用已收窄但需真机确认。

## J. 最少量授权事项（请用户逐项决定）

| 编号 | 事项 | 建议 |
| --- | --- | --- |
| D-1 | 是否 push `feat/v3.0.0`（21 提交）到 origin | 建议先不 push，等历史与真机验证决定 |
| D-2 | 是否 tag v3.0.0 / 发 Release / npm publish | 建议在真机只读验证 + 隐私拍板后再定 |
| D-3 | 历史实名 C 类：保留 vs 隔离镜像重写（不推送） | 需用户选择；重写需额外批准 force push 与 GitHub Support 方案 |
| D-4 | 真实设备只读验收授权（测试小号 + 虚构会话 + 只读模式，L1→L3 逐层） | 批准前先看 `docs/OCR-REAL-DEVICE-TEST-PLAN.md` |
| D-5 | 本地 PII 目录处置：A 保留隔离 / B 脱敏样本 / C 批准删除（`.dsh-tmp/`、`dev-notes/`、`backups/`、`%TEMP%` 7,722 张截图） | 建议 A 或 B；删除需单独批准 |
| D-6 | 运行 dataDir 的 api-token 是否需要轮换（曾外发到会话输出） | 建议轮换并确认 ACL |
| D-7 | 是否补建含当前 HEAD 的全量备份 bundle（现有 bundle 落后 3 提交） | 建议立即补建（仅本地） |
| D-8 | OneDrive 云端/回收站/版本历史/在线引用核查（需用户账号） | 建议用户在 OneDrive 网页确认 |
| D-9 | 是否把历史扫描/二进制/压缩包规则纳入 CI 门禁 | 建议纳入（需改 CI，未做） |
| D-10 | 是否允许安装 `rapidocr` 新包做真机验证（需联网/装依赖） | 建议等授权后单独进行 |
| D-11 | 是否允许真实设备只读回归与阈值标定（S3） | 建议放在 D-4 之后 |

## 四类状态表

| 状态 | 内容 |
| --- | --- |
| **已验证（本地，可复现）** | 42/709 测试、typecheck 0、build 0、check-sensitive 0 命中、check-package 0 违规、verify:api 25/25、pack 无垃圾；只读四层阻断 + 12 入口绕过矩阵 + 14 条端到端离线用例；生产调用链矩阵与 ID 稳定性结论；21 提交可恢复备份（bundle 校验一致，但落后 HEAD 3 提交） |
| **待验证（需真实环境/授权）** | 真实微信只读验收（未执行）、PS1 锚点/门槛实机校准、安装/卸载/回退实机演练、RapidOCR 新包、Worker 收益、Windows ACL、宿主反代、跨 OS、DSH 重启/脚本超时故障路径 |
| **需用户授权** | D-1 push；D-2 tag/Release/publish；D-3 历史改写；D-4 真机只读；D-5 PII 处置；D-6 token 轮换；D-7 补建全量备份；D-8 OneDrive 核查；D-9 CI 历史扫描；D-10 安装新依赖；D-11 真机回归与阈值标定 |
| **不得发布** | 未获 §J 授权前一律不得 push/tag/Release；不得宣称「已实机验证 / OCR 已完全修复 / 隐私已无风险 / 只读已实机验证」；不得把 fusion/align/tracker 当线上能力宣传 |

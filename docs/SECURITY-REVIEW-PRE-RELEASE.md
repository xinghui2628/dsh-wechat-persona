# 发布前安全复核报告（Pre-Release Security Review）— v3.0.0

- 仓库/分支：`dsh-wechat-persona` / `feat/v3.0.0`（复核时 HEAD `c05a24a`，18 个本地提交未 push；本报告不 push、不 tag、不 Release）
- 复核人：reliability-fixer（task-17）
- 复核方式：只读静态审计 + 注入式单元测试（fake clock/store/fetch/llm/channel），**未接触真实微信、未发送真实消息、未采集聊天内容**
- 本报告对应改动：仅「只读测试模式」的 engine/api/client 侧实现与测试追加（`src/config.ts` 由 Lead 提供，本轮未改；desktop 通道侧归 pipeline-fixer）

---

## 一、结论摘要

| 项目 | 结论 | 等级 |
| --- | --- | --- |
| P0（发布阻断） | **0 个** | — |
| P1（发布前应处理/明确说明） | **4 个**：兼容模式默认不强制 token、DNS rebinding 未处理、设置页无 token 输入入口、同用户本机进程威胁边界 | P1 |
| P2（可后续修复/已文档化） | **6 个**：`/personas/install {url}` 仅协议校验、IPv6 IPv4-compatible/NAT64 未拦截、token 文件 Windows 权限语义、限速重启重置/无 token 轮换、兼容模式告警易忽略、宿主反代下回环判定失真 | P2 |
| 只读测试模式（任务书第五部分） | engine/api/client 三层已实现并通过测试；desktop 通道侧需与 pipeline-fixer 联合复验 | 通过（附未验证项） |
| 暂停拒绝 / unknown 不重发（9.2/9.3/9.4） | 通过 | 通过 |
| SSRF（10.3，常规攻击面） | 通过；DNS rebinding 与两处字面量缺口见下 | P1/P2 |

**发布建议：有条件通过。** 若发布前只做一件事，建议在首次配置向导中默认引导开启 API token（或把 `market.builtinOnly` 默认置真），并把本报告「P1」写入发布说明；DNS rebinding 与 `/personas/install` 内网地址问题列为下一个修复批次。

---

## 二、只读测试模式（任务书第五部分）实现与证据

### 2.1 代码层 8 条对照

| 任务书要求 | 实现 | 证据 |
| --- | --- | --- |
| 1. 任何发送函数只读模式下拒绝执行 | 统一门禁 `canSend({checkReadOnly})`：真实通道（非 mock）返回 `{reason:'read-only-mode', detail:'只读测试模式：已禁止一切真实发送…'}` | `src/engine/engine.ts:486-507` |
| 2. `/test/send` 不得绕过 | API 层在处理引擎之前硬拒绝（409，detail `read-only-mode`），不进入 `engine.sendTest` | `src/server/api.ts:1751-1753` |
| 3. `/drafts/approve` 不得触发真实发送 | API 层批准分支硬拒绝（409）；`reject` 只改状态、不发送，仍放行；引擎 `approveDraft` 内 `canSend` 兜底 | `src/server/api.ts:1798-1810`、`src/engine/engine.ts:828-846` |
| 4. LLM 工具调用不能通过其他路径触发发送 | `wechat_persona_send_test` → `PersonaService.sendTest` → `engine.sendTest`（同一 `canSend`）；全仓 `channel.send(` 调用点仅 `engine.ts` 三处，均在门禁之后 | `src/tools.ts:182`、`src/index.ts:321-323`、`src/engine/engine.ts:442/859/1393` |
| 5. 禁止模拟键盘回车/点击发送/粘贴提交 | engine 层不产生任何键鼠动作；desktop/PS1 层的键鼠路径不在本轮改动范围，由 pipeline-fixer 负责（见 §八未验证项） | 本轮 engine 无键鼠代码 |
| 6. 测试错误时保持禁止发送 | 门禁是**拒绝型**（fail-closed）：`canSend` 每 part 前、每次重试前、手动发送/草稿批准前都重新检查，任一异常不会放行 | `engine.ts:1362-1377`、`engine.ts:408`、`engine.ts:846` |
| 7. 重启后不得自动恢复真实发送 | `readOnlyTestMode` 是持久化配置；`start()` 只在 `checkReadOnly:false` 下启动通道接收，并写一条配置态审计；自动发送仍走 `canSend` 拒绝 | `engine.ts:223-245`、`config.ts:326` |
| 8. 只读 UI/日志明确显示状态 | 设置页「安全红线」横幅（不可在本页跳过）、草稿卡横幅 + 批准按钮禁用 | `client/client.js:3556-3571`、`client/client.js:3990-4037` |

### 2.2 入口 → 拒绝分支证据清单（本报告核心交付）

| 发送入口 | 调用链 | 只读模式下的拒绝点 | 证据（file:line） | 回归测试 |
| --- | --- | --- | --- | --- |
| 入站自动回复 | `handleInbound → processInner → 拟人延迟 → 发送循环 preSend` | `canSend()` 返回 `read-only-mode` → `recordSendBlocked`（audit `type:'skip'`, `reason:'read-only-mode'`），`channel.send` 0 次 | `engine.ts:1362-1364`、`engine.ts:501-507`、`engine.ts:559` | `test/engine/acceptance.test.ts:1237` |
| 自动回复重试 | 发送循环每次重试前 | 同上（同一门禁重查），不会因重试绕过 | `engine.ts:1370-1377` | 同上（断言 `channel.sent` 为 0） |
| 手动发送（宿主工具 `wechat_persona_send_test`） | `tools.ts → service.sendTest → engine.sendTest` | `canSend` 拒绝 → 返回 `{ok:false, delivery:'not-sent', error:'已拒绝发送：只读测试模式…'}` | `engine.ts:405-442` | `acceptance.test.ts:1258` |
| 手动发送（HTTP `POST /test/send`） | `api.handle → /test/send` | API 层直接 409，**不调用引擎**（双重保险：即使引擎缺失也拒绝） | `api.ts:1751-1753` | `test/server/api.test.ts:1965-1980` |
| 草稿批准（`POST /drafts/approve`） | `api.handle → /drafts/approve` | API 层直接 409；引擎 `approveDraft` 内 `canSend` 再兜底 | `api.ts:1808-1810`、`engine.ts:846` | `api.test.ts:1983-1995`、`acceptance.test.ts:1258` |
| 草稿拒绝（`POST /drafts/reject`） | `api.handle → /drafts/reject` | 允许（只改状态，不发送） | `api.ts:1798`、`engine.ts:811` | `api.test.ts:1983` |
| 重启/恢复运行 | `engine.start()/resume()` | 配置保持 `readOnlyTestMode=true`；`start()` 写配置态审计；后续发送仍被 `canSend` 拒绝 | `engine.ts:235-242`、`engine.ts:223-245` | `acceptance.test.ts:1274` |
| mock 通道 | 任意发送入口 | 不受只读限制（mock 空转，不触达真实微信） | `engine.ts:501` | `acceptance.test.ts:1252` |

结论：**只读模式下，engine 层所有真实发送入口都必须在 `canSend` 处被拒绝，API 层对 `/test/send`、`/drafts/approve` 另有前置 409 硬拒绝；两者叠加后，代码层不存在可触达真实通道发送的路径。** 键鼠模拟（desktop/PS1）不在 engine 层，需 §八 的联合复验。

### 2.3 只读模式已知边界

- 只读模式仍允许 desktop 通道的**被动读取**（窗口枚举、OCR 读取、扫描风控），这是「只读验收」需要的；engine 不产生键鼠动作。
- 只读模式是普通配置项：能改配置的用户就能关闭它（无独立密码/两阶段确认）。这是设计取舍（P2-5）。
- `start()` 不因只读而拒绝启动通道（否则无法接收消息做只读回归）；它只保证不发送。

---

## 三、Bearer 鉴权真实强度（P1：有效但默认不强制）

### 3.1 实现

- token 解析：`Authorization: Bearer <token>`（大小写不敏感）或备选 `x-dsh-persona-token`（`api.ts:280-291`）。
- 比较：先 sha256 定长再 `timingSafeEqual`，恒定时间比较（`api.ts:294-299`）。
- 校验顺序（`api.ts:325-355`）：
  1. 回环来源（`remoteAddress`，非回环 403）
  2. `x-dsh-wechat-persona: 1` 请求头（403）
  3. Host 必须是回环主机名（防 DNS rebinding，403）
  4. Origin 若存在必须是回环 http(s)（防 CSRF，403）
  5. `Sec-Fetch-Site: cross-site` 拒绝（403）
  6. 若配置了 token：校验 Bearer/备选头（401）
- token 生效方式：`deps.apiToken()` 只返回 **显式配置** 的 `config.apiToken.trim()`；默认 `''` 时服务端只告警一次（兼容模式），`index.ts:198-215` 仅在数据目录生成/复用 `api-token` 文件（0600）作为「启用材料」，不强制。

### 3.2 结论矩阵

| 场景 | 兼容模式（默认） | 已配置 token |
| --- | --- | --- |
| 浏览器跨站请求（恶意页面） | 拒绝（Host/Origin/Sec-Fetch-Site） | 拒绝（且 token 也拿不到） |
| 浏览器同源（DSH 设置页） | 允许 | **401**（设置页当前不带 token → P1-3） |
| 非回环来源 | 拒绝 | 拒绝 |
| 同机同用户任意进程 | **允许全部 API（含 /test/send、/drafts/approve）** | 需读 `dataDir/api-token` 或用户配置值（同用户可读） |
| 宿主反向代理把远端转为回环 | 仅剩 Host/Origin/token | 需 token |

**判定**：token 实现本身没有绕过路径（恒定时间比较、六层顺序、错误不回显 token）；但默认配置下它**不生效**，所以「Bearer 提供真实认证」只在显式开启后成立。同机同用户进程威胁模型见 §五。

---

## 四、凭据泄露面（P2：未见泄漏；可用性问题）

| 检查点 | 结论 | 证据 |
| --- | --- | --- |
| `GET /config` 是否回显 token | 否，返回 `apiToken:''` + `apiTokenConfigured:boolean` | `api.ts:1346` |
| `POST /config` 空值行为 | 提交空 token 时保留现有值，不会误清空 | `api.ts:1288-1361` |
| 错误响应是否回显 token/提交值 | 否，`validateConfigString` 只回显字段路径与允许值 | `api.ts:610-640` |
| 日志是否出现明文 | 未发现：启动日志只提示 token 文件路径/已启用，不含值 | `index.ts:198-215`、`index.ts:367-374` |
| 审计事件是否含配置值 | 否（审计只记 reason/detail/kind 等） | `src/core/audit.ts` |
| 前端是否持有 token | 否：`client/client.js` 无 `Authorization`/`apiToken` 相关代码 | 全文件 grep |
| token 文件权限 | 写入 `mode:0o600`；Windows 上 POSIX mode 语义有限，实际依赖目录 ACL（P2-3） | `index.ts:198-215` |
| 设置页在启用 token 后 | 401（无输入入口）→ 功能不可用，需后续 UI 支持（P1-3） | 上述鉴权矩阵 |

---

## 五、API 对本地恶意进程的保护边界（P1：设计边界，需文档化）

- L1 回环限制只防非本机来源；纯逻辑直调（`remoteAddress` 缺失，如宿主内部调用）视为本机。
- Host/Origin/Sec-Fetch-Site 只防**浏览器**（CSRF/DNS rebinding），不构成调用方身份——非浏览器客户端可任意伪造。
- 兼容模式（默认）下，**同用户同机任意进程可调用全部 API**，包括 `/test/send`、`/test/inbound`、`/drafts/approve`、`/config`、`/pause`。
- 启用 token 后，攻击者仍需拿到 token 文件内容；同用户进程可读该文件（0600 只隔离其他 OS 用户）。因此 token 模式的真实边界是「防其他用户/低权限进程 + 防浏览器」，不是「防同用户恶意程序」。
- `src/tools.ts` 的 `wechat_persona_*` 工具直接调 `engine` 方法，不经 HTTP 鉴权（宿主进程内信任）；审计可控。
- 能修改配置文件的用户可直接关闭 `safeMode`/`readOnlyTestMode`（P2-5），这是本机用户权限的固有限制。

**建议**：在 `docs/SECURITY.md` 与 README 中明确「本插件假设本机同用户进程可信」；如需更强隔离，后续可加「token 强模式 + 设置页 token 输入 + 独立 OS 账户运行」。

---

## 六、草稿批准 / 暂停 / unknown 不重发（通过）

### 6.1 草稿批准接口权限

- 与所有写操作同一 `checkAuth`（`api.ts:1798-1832`）；`POST` only；`id` 非空 ≤128；无引擎 409；引擎不支持 409；异常 500。
- 引擎 `approveDraft`（`engine.ts:828-870`）：
  - 过期/已处理校验；
  - `ledger.shouldSend(opId,0)`：confirmed/cancelled/unknown 终态 → 拒绝（unknown 绝不重发）；
  - `canSend` 全量门禁（暂停/熔断/只读/safeMode/预算/白名单/频控）；
  - 同一 `sendOperationId` 落账本，批准一次后不可重复批准。
- 测试：`test/server/api.test.ts:1856-2004`（鉴权 + 只读 + 草稿权限）；`test/engine/acceptance.test.ts` task-12 的 13.4/9.4 用例。

### 6.2 暂停后拒绝发送

- `pause()`/`stop()`/熔断/重启都会 `abortController.abort()`；`canSend` 第一层就是 `signal.aborted`（`engine.ts:486-495`）。
- 自动回复在拟人延迟后、每 part 前、每次重试前重查（`engine.ts:1347-1377`）；`sendTest`/`approveDraft` 同门禁。
- 测试：Phase F 与 task-12 用例（`acceptance.test.ts` 667-1000 区间多个 describe）、`api.test.ts` 的 `/test/send` 暂停 409。

### 6.3 unknown 不重发

- `send-ledger`：`isTerminal`（confirmed/failed/unknown/cancelled，`send-ledger.ts:272-284`）、`shouldRetry` 仅 `failed + not-sent + attempts<3`（:286-301）、`shouldSend` 对终态返回 false（:303-312）。
- 账本只存 `textHash`（FNV-1a），不落明文；文件 `dataDir/send-ledger.json`，上限 200 条。
- 测试：`test/core/send-ledger.test.ts`（13 条）、`acceptance.test.ts` 9.4/13.4（同一 opId 只 send 一次、重启后不再发、multi-part 部分成功、unknown 后二次批准被拒）。

---

## 七、SSRF（10.3）：现状、缺口与修复方案

### 7.1 攻击面汇总表

| 攻击面 | 当前行为 | 证据 | 等级 |
| --- | --- | --- | --- |
| IPv4 回环/内网/链路本地（含十进制 `2130706433`、十六进制 `0x7f000001`、短点分 `127.1`、前导零、尾点） | 拒绝（URL 归一化 + `isPrivateMarketHost`） | `persona-market.ts:120-169`；测试 `test/core/persona-market.test.ts:793+` | 通过 |
| `localhost` / `.local` / `.internal` / `.home.arpa` | 拒绝 | 同上 | 通过 |
| IPv6 回环/映射(`::ffff:*`)/ULA(`fc00::/7`)/链路本地(`fe80::/10`)/未指定 | 拒绝 | 同上 | 通过 |
| 内嵌用户名密码 / 非 http(s) 协议 | 拒绝，错误不回显原始 URL | `assertSafeMarketUrl` `:151-169` | 通过 |
| 302 重定向到内网 | 拒绝：`redirect:'manual'`，最多 2 跳，每跳重新 `assertSafeMarketUrl` | `persona-market.ts:400-438`；测试 :860+ | 通过 |
| Content-Type 非 JSON | 拒绝 | `:442-445` | 通过 |
| 超大响应（Content-Length + 流式双限 2MB） | 拒绝 | `:447-478` | 通过 |
| IPv4-compatible IPv6 `[::127.0.0.1]` / NAT64 `[64:ff9b::127.0.0.1]` | **当前放行**（字符串校验不覆盖） | 测试 `:841`（记录缺口） | **P2** |
| 公网域名 DNS 解析到内网（DNS rebinding） | **当前放行**（只做 URL 字符串校验，不解析 DNS、不校验实际连接 IP） | 测试 `:848`（注入 fetch 证明请求发出） | **P1** |
| `/personas/install {url}`（`downloadPersonaPack`） | **仅校验 http/https**；无内网拒绝、无 redirect 手动、无 Content-Type、无流式 2MB | `api.ts:827-859`；测试 `api.test.ts:1946`（stub fetch 捕获内网 URL） | **P2** |

### 7.2 DNS rebinding 可验证修复方案

任务书要求「先制定可验证的修复方案和测试，不要凭字符串检查就宣称彻底解决」。以下方案均可在 `test/core/persona-market.test.ts` 用注入的 `dnsLookup`/`fetch` 做**离线可验证**测试。

**方案 A（推荐）：解析后固定 IP + 连接期 IP pinning**
1. `dns.lookup(host, {all:true})` 取所有地址；对任一地址跑 `isPrivateMarketHost(ip)`，命中即拒绝（错误不回显解析结果）。
2. 连接使用**已校验的 IP**：`http(s).request({lookup})` 或 `undici.Agent({connect:{lookup}})` 让 connect 直接返回该 IP；TLS SNI / `Host` 头仍用原主机名。这是防「校验时公网、连接时内网」TOCTOU 的关键。
3. 每跳重定向重新解析 + 重新校验（保留现有 `redirect:'manual'` 循环）。
4. 解析失败 → `fetchIndex` 回退内置人格；`install` 给清晰错误（不含内网信息）。

**方案 B（组合）：连接后校验 `socket.remoteAddress`**
建立 TCP/TLS 连接后、写出请求数据前检查 `socket.remoteAddress`；命中私网立即 `destroy()`，不发送请求。可与 A 叠加（A 为主，B 兜底）。

**方案 C（收窄攻击面，最快落地）**
把 `market.builtinOnly` 默认改为 `true`，或只允许用户显式确认的域名白名单；远程市场默认关闭，需要时用户手工开启。可从根上消除该攻击面（但放弃远程市场默认能力）。

**测试设计（修复验收标准）**
1. 注入 `dnsLookup` 返回 `127.0.0.1` → 抛错，且 `fetch` **0 次**被调用。
2. 返回 `10.0.0.5` / `::ffff:127.0.0.1` / `fe80::1` → 同一断言。
3. 返回公网 IP → 请求发出，且连接使用的 IP 等于解析结果（断言 `lookup` 调用次数为 1，防二次解析）。
4. 重定向链第一跳公网、第二跳公网域名解析到内网 → 第二跳拒绝。
5. 解析失败 → `fetchIndex` 回退内置并带 warning；`install` 返回明确错误。
6. 把本报告 §7.1 中「当前放行」的 3 条测试从「记录缺口」改为「拒绝」，否则不得宣称 DNS rebinding 已修复。
7. `/personas/install {url}` 改为复用同一套 URL/重定向/Content-Type/2MB 校验（或直接复用 `PersonaMarket.fetchJson`），并加内网 URL 拒绝用例。

---

## 八、本轮新增测试与运行结果

### 8.1 新增测试（全部为追加，不改既有用例语义）

| 文件 | 数量 | 位置 | 覆盖 |
| --- | --- | --- | --- |
| `test/core/persona-market.test.ts` | +6 | `:791-886` | SSRF 边界：IPv4/IPv6/凭据/协议/重定向拦截；2 条已知缺口证据（[::127.0.0.1]、NAT64）；DNS rebinding 证据（公网域名可发出请求） |
| `test/server/api.test.ts` | +11 | `:1856-2004` | 鉴权强度（兼容模式可伪造头、非回环 403、Host/Origin/cross-site 先于 token）、token 不回显、配置错误不回显、`/drafts/approve` 鉴权、`/personas/install` SSRF 证据、只读模式 4 条（`/test/send` 409、`/drafts/approve` 409 且 reject 放行、`/status`/`/config` 暴露、关闭后回归） |
| `test/engine/acceptance.test.ts` | +4 | `:1228-1289` | 只读模式：真实通道 LLM 生成但 send 0 次 + audit `read-only-mode`；mock 不受影响；sendTest/approve 走同一门禁返回 not-sent；重启仍拒绝 + 启动配置态审计 |

### 8.2 验证命令与真实结果

```powershell
npm run typecheck                 # 0 错误
node --check client/client.js     # OK
# 定向：test/engine/acceptance.test.ts、test/server/api.test.ts、test/core/persona-market.test.ts
#   → 3 文件 / 254 用例全部通过（acceptance 72、api 143、persona-market 39）
npm run test:sandbox              # 41 文件 / 675 用例全部通过
```

> 全量基线为 40 文件 / 648 用例；本轮新增 21 条（+6 market、+11 api、+4 acceptance），另有队友新增的 `test/channels/desktop-id-stability.test.ts`（6 条）计入 41 文件/675 用例。以上为本地 sandbox 真实数字，未跑真实微信。

---

## 九、未验证项（诚实标注）

1. **真实 DNS rebinding**：本沙箱不能真实做域名解析/重绑定实验；上述 P1 结论与修复方案基于代码审计 + 注入式证据，修复后需用注入 `dnsLookup` 的测试验证。
2. **真实微信 / 真实键鼠**：按任务书禁止，未做任何真实发送、截图或键鼠操作。
3. **desktop 通道侧只读**：键鼠模拟、被动截图/离线回放由 pipeline-fixer 负责；本轮只覆盖 engine/api/client 层，**「只读模式完全禁用键鼠」需与其联合复验**（任务书第五部分副作用四分类）。
4. **Windows 文件 ACL**：token 文件 0600 在 Windows 的实际权限语义未实测，依赖目录 ACL。
5. **宿主反向代理**：若 DSH web server 被反代，`remoteAddress` 可能恒为回环，L1 失效；取决于宿主实现，未验证。
6. **token 轮换 / 热更新**：目前改 token 需重载插件；无轮换 API。
7. **设置页 token 输入**：未实现（启用 token 后设置页 401 的已知可用性问题）。
8. **安装/发布包验证**：不在本轮范围（参见 `docs/PRE-RELEASE-INSTALL.md` 与发布检查清单）；648/675 条单测通过不代表用户安装成功。
9. **长期运行**：账本 200 条上限、审计日志大小、进程内限速在真实并发下的行为未做压力测试。

---

## 十、发布前建议动作（按优先级）

1. 首次配置向导默认引导开启 API token（或发布说明明确「兼容模式」含义与开启步骤）。
2. 远程市场：默认 `market.builtinOnly=true`，或把 DNS rebinding 修复（方案 A）排入下一批次。
3. `/personas/install {url}` 复用 persona-market 的 SSRF 校验（P2）。
4. 设置页支持 token 输入/保存（P1-3）。
5. 与 pipeline-fixer 联合跑「只读测试模式 + desktop 通道」的 8 条验收（键盘/鼠标/截图副作用）。
6. 把本报告 P2 项写入 `docs/SECURITY.md`「残余风险」并持续跟踪。

---

## 附录：复核证据索引

- 只读模式：`src/engine/engine.ts:486-507/1362-1377`、`src/server/api.ts:1751-1753/1798-1810`、`client/client.js:3556-3571/3990-4037`、`src/config.ts:326/548-551`
- 鉴权：`src/server/api.ts:280-355/1241`、`src/index.ts:198-215/367-374`
- 凭据：`src/server/api.ts:1346`、`src/config.ts:610-640`（`validateConfigString` 在 api.ts）
- 草稿/账本：`src/core/send-ledger.ts:272-312`、`src/engine/engine.ts:797-870`
- SSRF：`src/core/persona-market.ts:68-169/261/298/400-500`、`src/server/api.ts:827-859`
- 测试：`test/core/persona-market.test.ts:791-886`、`test/server/api.test.ts:1856-2004`、`test/engine/acceptance.test.ts:1228-1289`

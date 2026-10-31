# 安全说明（Phase E：API 鉴权与远程人格导入加固）

> 适用版本：v3.0.0（Phase E）。本文件描述插件 HTTP API 的鉴权模型、人格包导入边界、默认值与迁移方式，以及**已知残余风险**。
> 代码位置：`src/server/api.ts`（API 与传输层）、`src/config.ts`（`apiToken` 配置）、`src/index.ts`（token 生成与注入）。
> 回归测试：`test/server/api.test.ts` 中的「鉴权加固」「人格包导入安全」两个 describe（含传输层 Content-Type 用例）。

## 一、威胁模型

| 威胁 | 场景 | 当前防线 |
| --- | --- | --- |
| 远程直接访问 API | 宿主把 HTTP 端口暴露到局域网/公网 | 仅接受**回环 socket**（`127.0.0.1`、`::1`、`::ffff:127.0.0.1`）；非回环直接 403 |
| DNS rebinding | 恶意网页把自己的域名解析到 127.0.0.1，再借浏览器打 API | 校验 `Host` 必须是回环主机名（`127.0.0.1` / `localhost` / `::1`），否则 403 |
| CSRF | 任意网页携带用户 cookie/凭据跨站调用 API | 校验 `Origin`（若存在）必须是回环 http(s) 来源；`Sec-Fetch-Site: cross-site` 一律 403；另有自定义请求头 `x-dsh-wechat-persona: 1`（跨站请求无法静默伪造） |
| 非浏览器本机进程/脚本误调 | 同机其它程序调用 API | 必须带 `x-dsh-wechat-persona: 1`；启用共享 token 后还必须带 `Authorization: Bearer <token>` |
| 恶意/损坏的人格包（含 SillyTavern 角色卡） | 从互联网下载的 JSON 含路径穿越文件名、可执行 URL、超深嵌套、超长字段、原型污染键 | API 层 dry-run 结构校验 + 消毒 + 顶层字段白名单；路径穿越/危险 URL/危险键直接 400，未知字段丢弃；校验失败不落盘、不回显原文内容 |
| 大请求体 / 慢速请求 / 请求风暴 | 本机恶意进程刷 API | 请求体 ≤ 4MB（413）、请求体读取 10s 超时（408）、`POST/PUT/PATCH` 带体时 Content-Type 必须是 `application/json`（415）、进程内限速 240 次/分钟/IP（429） |
| 密钥泄漏 | 配置文件/状态接口被读取 | `GET /config` 永远返回 `apiToken: ''`（只返回 `apiTokenConfigured` 布尔值）；token 文件权限 `0600` |

## 二、鉴权矩阵

所有 `/dsh-wechat-persona/api/**` 请求按以下顺序校验，任一失败即拒绝：

| 层 | 校验 | 失败响应 |
| --- | --- | --- |
| L1 | socket `remoteAddress` 属于回环地址（纯逻辑直调未传地址时视为本机） | 403「只允许从本机回环地址访问（127.0.0.1 / ::1）」 |
| L2 | 请求头 `x-dsh-wechat-persona: 1`（值必须为字符串 `1`） | 403「缺少或错误的 x-dsh-wechat-persona 请求头（应为 1）」 |
| L3 | `Host`（若存在）是回环主机名（端口忽略） | 403「Host 不是回环地址…」（防 DNS rebinding） |
| L4 | `Origin`（若存在）是回环 http(s) 来源；`null`/空串视为跨站 | 403「Origin 不是回环来源…」（防 CSRF） |
| L5 | `Sec-Fetch-Site` 不是 `cross-site` | 403「拒绝跨站请求…」 |
| L6 | 仅当配置了 `apiToken`：`Authorization: Bearer <token>`（或备选头 `x-dsh-persona-token`）。使用 SHA-256 摘要 + 恒定时间比较（`timingSafeEqual`），避免时序侧信道 | 401「缺少或错误的 API token」 |

说明：

- L6 是**显式启用制（opt-in）**：`config.apiToken` 留空时不会强制 token（见「默认配置与兼容模式」），但 L1–L5 始终生效。
- 纯逻辑直调（`createPersonaApi(...).handle(...)` 且不传 `remoteAddress`）仍视为本机调用，主要用于设置页与测试；HTTP 传输层始终传入 socket 地址。
- 所有响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。

## 三、默认配置与兼容模式

```yaml
# DSH 插件配置（profile/cordis.patch.yml）或设置页
dsh-wechat-persona:
  apiToken: ''   # 默认空 = 兼容模式
```

- **默认 `apiToken: ''`（兼容模式）**：只做 L1–L5；服务端在首次请求时 `warn` 一次「API 未配置共享 token…」，不硬失败。这样升级后旧设置页、旧脚本、旧工具（只带 `x-dsh-wechat-persona: 1`）仍可工作，避免升级即断。
- 插件启动时会在数据目录生成/复用 **运维参考 token**：`<dataDir>/api-token`（默认 `<工作区>/.dsh-wechat-persona/api-token`），权限 `0600`。**该文件内容默认不强制生效**，仅作为启用材料；把它填入配置 `apiToken` 即切换为强制 Bearer 校验（重启插件后生效）。
- 若你**已显式配置** `apiToken`：所有 API 调用（含设置页、`wechat_persona_*` 工具、调试脚本）都必须携带 `Authorization: Bearer <token>`，否则 401。

### 启用/迁移步骤

1. 读取 `<dataDir>/api-token`（不存在则重启一次插件让它生成），或自行生成一个 ≥16 字符的随机串。
2. 写入配置 `apiToken: <该 token>` 并保存（或用 profile 的 `cordis.patch.yml`）。
3. 重启插件（DSH → 插件 → 本插件开关关 2 秒再开）。
4. 所有调用方补 `Authorization: Bearer <token>` 头；确认无误后，若将来版本改为默认强制，无需再次迁移。
5. 轮换 token：改配置 `apiToken` → 保存 → 重启插件（当前没有热更新/撤销接口，见残余风险）。

## 四、请求限制与传输层

| 项 | 值 | 行为 |
| --- | --- | --- |
| 请求体大小上限 | 4MB（`MAX_API_BODY_BYTES`） | 413「请求体超过 4MB 上限」 |
| 请求体读取超时 | 10s（`REQUEST_BODY_TIMEOUT_MS`） | 408「读取请求体超时」，断开连接 |
| Content-Type | `POST/PUT/PATCH` 且带请求体时为 `application/json` | 415「请求 Content-Type 必须是 application/json」 |
| 进程内限速 | 240 次/60s（`API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW_MS`），按 `remoteAddress` 分桶 | 429「请求过于频繁，请稍后再试（进程内限速）」 |
| JSON 解析 | 请求体非空且非法 JSON | 400「请求体不是合法 JSON」 |
| 未捕获异常 | 任何 handler 抛错 | 500「服务器内部错误」（详情只进宿主日志，不回显） |

## 五、人格包导入安全（dry-run + 消毒）

适用入口：`POST /personas/import`（`json` 字段）、`POST /personas/install`（`pack` 或下载 `url` 分支）。校验在**落盘/安装之前**完成（dry-run），失败不写任何文件。

1. **规模限制**：JSON 文本 ≤ 2MB；最大嵌套深度 6；单数组 ≤ 500 项；单对象 ≤ 200 键；总节点 ≤ 20000；普通字符串 ≤ 20000 字符；`avatar`/贴图 `data` 等大字段 ≤ 2MB。
2. **结构白名单**：顶层只允许 `PersonaPackV2` 字段与常见 SillyTavern 角色卡字段（`spec`、`spec_version`、`data`、`char_name`、`char_id`、`personality`、`scenario`、`first_mes`、`mes_example`、`system_prompt`、`character_book` 等）；未知顶层字段**丢弃**并写入 debug 日志（不回显给请求方）。
3. **危险内容拒绝**：`__proto__`/`constructor`/`prototype` 键（400，防原型污染）；控制字符；含 `..`、`/`、`\` 的标识符字段（`id`、`name`、`char_id`、`char_name`、贴图 `name` 等，防路径穿越）；非白名单 URL 协议（仅允许 `http:`/`https:`/`data:image/` 与相对路径）。
4. **Identifier 消毒**：`id` 转小写、非法字符折叠为 `-`、去首尾、截断 64；`name` 为空则删除。
5. **其它 id 入口**：`/personas/activate`、`/personas/export`、`DELETE /personas/:id`、`/market/install` 统一走 `isSafePersonaRef`（仅 `[A-Za-z0-9_.:-]`、≤128、无 `..`/路径分隔符/控制字符），拒绝路径穿越。
6. **错误信息**：仅返回字段路径与原因（如「stickers[0].name 含非法字符…」），**不回显字段原值**，避免把恶意载荷回显到日志/前端。

## 六、配置接口的密钥处理

- `GET /config`：返回的配置对象里 `apiToken` 恒为 `''`，另给顶层 `apiTokenConfigured: boolean`，设置页据此显示「已启用」而不接触明文。
- `POST /config`：若提交的 `apiToken` 为空，**保留现有值**（否则设置页回写空串会把 token 清掉）；`apiToken` 长度上限 256。
- `/status`：只暴露 `security: { apiTokenEnabled, rateLimitPerMinute }`，不含 token。

## 七、残余风险与已知未做项（诚实标注）

1. **默认不强制 token**：兼容模式下，任何能访问本机回环端口的**本机进程**只要带 `x-dsh-wechat-persona: 1` 就能调用 API。这是为升级兼容有意保留的过渡态，不是最终形态。
2. **无 TLS**：HTTP 只监听宿主回环，依赖 socket 地址与 Host/Origin 校验；如果宿主未来把插件 HTTP 暴露到非回环网卡，当前代码会直接拒绝（不是加密），需要另行设计。
3. **同用户可以读取 token 文件**：`<dataDir>/api-token` 权限 `0600` 只防其它系统用户；同一用户的其它进程仍可读取。token 无法对抗已在本机以相同用户身份运行的恶意程序。
4. **无 token 轮换/撤销 API**：只能改配置 + 重启；已发放 token 在重启前一直有效。
5. **限速是进程内**：重启即清零，且不是抗 DDoS 方案（本机场景足够）；不区分接口权重。
6. **slowloris**：只对请求体读取加了 10s 超时，未限制连接建立/头部阶段。
7. **远程市场安装**：`/market/install` 按 id 交给 `PersonaMarket`，API 层只校验 id 合法性，市场内容本身的信任边界在 `PersonaMarket` 与内置目录；`/personas/install` 的下载分支已做 API 层消毒，但「下载 URL 指向内网」的 SSRF 面仍存在（仅 http/https，无 IP 限制），配置 `market` 时需自行确认 URL 可信。
8. **人格包语义校验交给 PersonaLibrary**：API 层只做结构与危险内容校验（dry-run），字段含义/提示词质量仍由 `src/core/persona-library.ts` 的 `normalizePack` 等逻辑负责。
9. **未做**：token 的按请求头/来源分权（读写分级）、`GET /config` 之外的其它接口脱敏统一封装、CORS 头（当前不需要跨域场景）。

## 八、验证与回归

- `npm run typecheck` 干净。
- `npm run test:sandbox` 全量通过；Phase E 新增用例位于 `test/server/api.test.ts`：
  - 「鉴权加固（token / Host / Origin / 限速）」13 条：token 缺失/错误/正确、`x-dsh-persona-token` 备选头、兼容模式告警一次、Host/Origin/Sec-Fetch-Site 拒绝、回环放行、限速 429、`/config` 脱敏与空 token 回填。
  - 「人格包导入安全（校验 / 消毒 / dry-run）」14 条：非法 JSON、2MB 上限、非对象、`__proto__` 原型污染、路径穿越贴图名、`javascript:` 头像、允许 `https`/`data:image`、8 层嵌套、超长字段、无可识别字段、未知字段丢弃、install 分支同样校验、路径穿越 id 的 activate/export/delete、market id 穿越。
  - 传输层 1 条：非 `application/json` 的 `POST` → 415。

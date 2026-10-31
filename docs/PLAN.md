# 第二轮迭代 · 文件级实现计划

> **历史计划**：本文件记录 0.2.0/0.2.1 初期的实现计划，部分项未实现或已调整；最新进展与验收证据见 [CHANGELOG.md](../CHANGELOG.md) 与 [ACCEPTANCE.md](ACCEPTANCE.md)。

> 目标：把 dsh-wechat-persona 从“能用”升级成“用户自己可配置的产品”。
> 原则：增量修改、保留既有 6 个工具与 204 个测试；不重写、不删用户数据、不动 DSH 本体与其他插件。
> 本轮开始时已备份：`backups/pre-iter2/`（插件 package.json/cordis.patch.yml/README/tsconfig/config.ts/index.ts/types.ts + profile 的 package.json/cordis.patch.yml/.dsh-wechat-persona 数据）。

## 0. 落地方式（先说结论）

- **设置界面**：插件新增浏览器半（`client/client.js`，纯手写 JS，无需构建）。同时注册两个入口：
  1. `plugins.bundle.config`（key = 包名 `dsh-wechat-persona`）：点开 Plugins 页里的本插件就能看到配置页；
  2. `settings.section`：「设置 → 微信分身」独立设置页（同一套 UI）。
- **配置持久化**：Host 半通过 `ctx.configEditor.edit(entry, ...)` 把完整 config 写回 profile 的 `cordis.patch.yml`（Loader reconcile 后插件按新 config 重载，重启不丢）；无 configEditor 时降级为只读提示。
  读配置用 `configEditor.configuration()`；HTTP 层用 `webServer.register({kind:'prefix',path:'/dsh-wechat-persona/api/'})` 暴露给浏览器半。
- **安全边界**：HTTP API 只接受回环地址 + 自定义请求头 `x-dsh-wechat-persona: 1`；写操作校验 JSON 体积；所有错误回 `{ok:false,error}` 不抛到宿主。
- **人格市场**：人格包 = `pack.json`（扩展字段兼容 SillyTavern 角色卡）+ 可选 stickers。内置 4 个人格随包分发；远程索引可配置（默认 GitHub raw），失败回退内置列表并提示，不白屏。
- **桌面通道修复**：只改 `scripts/pwsh/wechat-uia.ps1` 内部实现（read 搜索框/联系人/分栏 paneLeft≈0.62；send 发送后 OCR 校验气泡，失败重试 3 次），不改上层 JSON 契约与 WXUIA_* 开关。

## 1. 新增/修改文件清单

### 1.1 配置与类型（Lead）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/config.ts` | 改 | v2 schema：`persona{activeId,dir,builtinDir,enabled}`、`whitelistOnly`、`schedule.workday*/weekend*`、`reply.groupChatEnabled/privateChatEnabled/maxContextTurns`、`stickers{enabled,dir,maxPerReply}`、`safety.blockTransfers/blockSuspiciousLinks/circuitBreakerEnabled`、`market{indexUrl,builtinOnly,timeoutMs}`、`logging.recentLimit`；新增 `migrateConfig(raw): {config, changed:boolean, notes:string[]}`（旧 onlineStart/End → workday/weekend；补默认 persona.activeId；兼容旧 `reply.personaDir`） |
| `src/types.ts` | 改 | 追加 `PersonaPackV2`、`PersonaSummary`、`MarketEntry`、`MarketResult`、`StickerSummary`、`UiLogEvent`、`ControlApi`（Host API 的纯函数契约，便于测试） |
| `src/engine/engine.ts` | 改 | 新增 `setPersona(pack)`、`setStickers(catalog)`、`status()` 增加 `nextOnlineAt` 字段；白名单开关 `whitelistOnly===false` 时允许非白名单单聊；`persona.enabled===false` 或 activeId 为空 → 本地 skip（0 token） |
| `src/core/schedule.ts` | 改 | 支持工作日/周末分别配置（新字段留空回退 onlineStart/End），跨午夜保持；`nextOnlineAt(now, config)` 供“下次上线倒计时” |
| `src/core/stickers.ts` | 改 | 多根目录（包内 `stickers/` + `dataDir/stickers/` + 当前人格 stickers 目录）合并；`reload()`、`list()`；上传/删除由 Host API 落盘后调用 reload |
| `src/core/preferences.ts` | 新增 | 从入站文本提取“称呼/忌口/最近话题”轻量规则（0 token），合并进 MemoryRecord.profile；供 prompt 使用 |

### 1.2 人格库与市场（teammate：persona-market）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/core/persona-library.ts` | 新增 | `PersonaLibrary`：list/get/install/update/uninstall/importJson/exportPack/activePack/toEnginePack；内置人格只读；安装目录 `dataDir/personas/<id>/pack.json`；id/文件名消毒防路径穿越 |
| `src/core/persona-market.ts` | 新增 | `PersonaMarket`：`fetchIndex()`（可留空/超时/失败回退内置）、`install(id)`（下载 pack.json → PersonaLibrary.install）、SillyTavern 字段兼容映射 |
| `personas/builtin/*.json` | 新增 | 4 个内置人格：`builtin-small.json`（小号）、`builtin-dafeiyu.json`（大肥鱼风格）、`builtin-senior.json`、`builtin-geek.json`；字段：id/name/avatar/style/catchphrases/systemPrompt/examples/taboo/tags/author/description/packVersion |
| `test/core/persona-library.test.ts`、`test/core/persona-market.test.ts` | 新增 | 安装/卸载/更新/导出/内置只读/路径穿越防护/SillyTavern 导入/索引失败回退 |

### 1.3 Host HTTP API（Lead 定义契约 + teammate：server-api）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/server/api.ts` | 新增 | `createPersonaApi(deps)` 返回纯 `{handle(method,path,body,headers): Promise<ApiResponse>}`（可单测）+ `attachPersonaRoutes(webServer, api, logger)` 注册前缀路由。端点见 §2 |
| `test/server/api.test.ts` | 新增 | 纯假依赖：设置读写（configEditor.edit 被调用、非法 config 拒绝）、人格安装/卸载、白名单/时段/表情包/日志/测试发送、鉴权（非回环、缺请求头 403） |

### 1.4 Host 装配（Lead）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/index.ts` | 改 | boot 后创建 `PersonaLibrary/PersonaMarket/api`；把 `engine` 以引用方式交给 api（`() => engine`）；`persona.activeId` 切换需要 `engine.setPersona`；`webServer` 缺失时只警告不启动 API；configEditor entry 查找（`entries()` 按 `options.name === 'dsh-wechat-persona'` 或 id） |
| `src/tools.ts` | 改 | 新增 `wechat_persona_personas`（列出/切换/安装/卸载/导入/导出人格）与 `wechat_persona_market`（索引/安装）两个工具（保留原 6 个） |
| `package.json` | 改 | `dsh.client = {platform:'web', inject:[client-locale, client-ui-settings, client-ui-plugin-manager]}`；`exports` 增 `"./client":"./client/client.js"`；`files` 增 `client`、`personas`、`docs` |

### 1.5 浏览器半（teammate：client-ui）

| 文件 | 动作 | 内容 |
|---|---|---|
| `client/client.js` | 新增 | 单文件纯 JS：`window.__ModuleLoader__.load({id:'dsh-wechat-persona', factory(require){...}})`；React 来自模块表；`inject:['slots','locale']`；注册 `plugins.bundle.config`（key `dsh-wechat-persona`）与 `settings.section`（「微信分身」）；Tab：概览 / 人格 / 白名单 / 在线时段 / 回复策略 / 表情包 / 预算与安全 / 日志与测试 / 人格广场 / 帮助；中文说明 + 默认值 + 悬停解释；保存/放弃；保存后轮询生效；API 失败友好提示 |
| `client/locale-zh.js` 或内联 | 新增 | 中文文案表（可内联，避免额外文件） |
| `test/client/*`（可选） | 新增 | 可把纯逻辑（diff/校验/格式化）抽到 `client/lib.js`（UMD 风格）写 node 测试；不强制 |

### 1.6 桌面通道修复 + 说明文档（teammate：docs-desktop）

| 文件 | 动作 | 内容 |
|---|---|---|
| `scripts/pwsh/wechat-uia.ps1` | 改 | read：搜索框/联系人点击/分栏判断修正（paneLeft ≈ 窗口宽 62%）；send：发送后 OCR 校验气泡出现，失败重试 3 次并回错误；保持 WXUIA_FORCE/WXUIA_NOBASELINE/WXUIA_DEBUG；不改 JSON 契约（read→{ok,messages}，send→{ok}|{ok:false,error}） |
| `docs/使用说明.md` | 新增 | 安装/更新/卸载、手机扫码、被踢重登、分身/双开、白名单、在线时段、防封参数、FAQ（掉登录/OCR/发送失败/休眠唤醒/成本）、版本记录（引用 CHANGELOG）、哪些必须用户手动 |
| `CHANGELOG.md` | 新增 | 0.2.0（本轮）+ 0.1.0（上一轮）；设置页从 CHANGELOG 渲染 |
| `README.md` | 改 | 新增“设置界面/人格市场/使用说明”章节与截图占位、dataDir 实机说明、安装/更新步骤、版本说明；保留风险声明 |

## 2. Host API 契约（/dsh-wechat-persona/api/）

统一响应 `{ok:true,...}` / `{ok:false,error:string,detail?:string}`；全部要求回环地址 + `x-dsh-wechat-persona: 1` 请求头。

| 方法/路径 | 请求 | 响应 |
|---|---|---|
| GET `/health` | - | `{ok,version,pid,uptime}` |
| GET `/status` | - | `{ok,status:EngineStatus,channel:{id,state,detail},configSummary}` |
| GET `/config` | - | `{ok,config,persist:{editable:boolean,reason?,lastSavedAt?,lastError?}}` |
| POST `/config` | `{config}` | 202 `{ok,accepted:true}`；异步 `configEditor.edit`（失败写 lastError + 审计 + alerts） |
| GET `/personas` | - | `{ok,activeId,personas:PersonaSummary[]}` |
| POST `/personas/install` | `{pack}` 或 `{url}` | `{ok,persona,updated:boolean}` |
| POST `/personas/import` | `{json}` | 同上（兼容 SillyTavern） |
| POST `/personas/activate` | `{id}` | 202 `{ok,accepted}`（写 config.persona.activeId；'' = 关闭） |
| DELETE `/personas/{id}` | - | `{ok}`（内置只读 → 400） |
| GET `/market` | - | `{ok,source:'remote'\|'builtin',entries:MarketEntry[],warning?}` |
| POST `/market/install` | `{id}` | `{ok,persona}` |
| GET `/stickers` | - | `{ok,items:StickerSummary[]}` |
| POST `/stickers/upload` | `{emotion,filename,dataBase64}` | `{ok,item}`（≤2MB，写入 dataDir/stickers/<emotion>/） |
| DELETE `/stickers` | `{id}` | `{ok}`（只允许删除上传目录内文件） |
| GET `/sticker-file?id=...` | - | 图片二进制（只允许包内 stickers/ 与 dataDir/stickers/ 内） |
| GET `/logs?limit=50` | - | `{ok,events,summary}`（audit 最近 N 条） |
| POST `/test/inbound` | `{text,contactId?}` | `{ok,accepted}` 或 `{ok:false,error}`（真实走本地规则/引擎） |
| POST `/test/send` | `{contactId,text}` | `{ok,result:SendResult}` |
| POST `/pause` / POST `/resume` | `{reason?}` | `{ok}` |
| POST `/memory/clear` | `{contactId?}` | `{ok}` |
| POST `/audit/clear` | - | `{ok}` |
| GET `/help` | - | `{ok,usage:string,changelog:string}`（读 docs/使用说明.md、CHANGELOG.md） |

## 3. 分阶段实施顺序（每阶段末必须 `npm run typecheck` + `npm run test:sandbox`）

1. **P0 配置地基（Lead）**：config v2 + migrateConfig + types 追加 + schedule 工作/周末 + engine persona/stickers setter + preferences 模块与测试；全部旧测试保持绿。
2. **P1 人格库/市场（teammate persona-market）**：persona-library + market + 4 内置人格 + 测试（与 P0 并行，只依赖 types/config 契约）。
3. **P2 Host API（Lead 定义契约，teammate server-api）**：src/server/api.ts + 测试（假 deps；不依赖真实 webServer）。
4. **P3 浏览器半（teammate client-ui）**：client/client.js + package.json dsh.client（Lead 改 package.json）；用 Host API 契约；注册两个入口。
5. **P4 装配 + 工具（Lead）**：index.ts 接 API/persona library/market + tools 新增人格/市场工具；构建 dist。
6. **P5 桌面上修复 + 文档（teammate docs-desktop）**：PS 脚本 + 使用说明 + CHANGELOG + README。
7. **P6 集成验收（Lead）**：typecheck、test:sandbox、build、安装到 profile（plugin_manager set_plugin 重载）、真实 HTTP 冒烟（/status、/config、/personas、/stickers、/logs、/test/send）、浏览器打开设置页截图/录屏证据、更新验收文档。

## 4. 验收对账（对应任务书第 6 条）

| 验收项 | 证据 |
|---|---|
| `npm run typecheck` 通过 | 命令输出 0 错误 |
| `npm run test:sandbox` 全过且新增测试 | vitest 用例数 ≥ 原 204 + 新增（设置读写/人格安装卸载/配置迁移） |
| `npm test` 不因沙箱 EPERM 失败 | 保留 test:sandbox 方案，README 说明 |
| 设置页能改人格/加白名单/设时段/装人格包 | GUI 截图或录屏 + `/api/config`、`/api/personas` 返回 |
| README + 使用说明 + CHANGELOG | 文件存在且内容同步 |
| 不改 DSH 本体/其他插件/不删数据 | 改动仅在 dsh-wechat-persona/ 与 profile 本插件配置；备份在 backups/ |

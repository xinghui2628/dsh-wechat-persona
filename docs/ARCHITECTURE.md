# 架构（ARCHITECTURE）

## 总览
```
DSH 插件宿主
 ├─ client/            设置页（Web，直接 fetch 插件 API）
 └─ src/index.ts       注册插件、服务端路由、工具（wechat_persona_*）
      ├─ server/api.ts     设置页/诊断 REST API（/health /status /config /personas* /market /stickers /logs /audit/clear /memory/clear /pause /resume /test/inbound /test/send ...）
      ├─ engine/engine.ts  引擎：轮询通道 → 入站消息 → 门禁/预算 → LLM → 通道发送
      ├─ core/*            人格、记忆、搜索、限流、熔断、预算、审计、在线时段
      ├─ llm/*             deepseek-account 客户端 + prompt + 搜索意图
      └─ channels/         通道实现
           ├─ channel.ts       工厂：mock / phone-adb / windows-vm / desktop
           ├─ mock.ts          空转测试通道（默认，不碰真实微信）
           ├─ phone-adb.ts     安卓手机 ADB（推荐长期方案，见 docs/CHANNELS.md）
           ├─ windows-vm.ts    独立 Windows 会话
           └─ pc/desktop.ts    本机桌面自动化（当前主力，视觉驱动）
```

## desktop 通道（本机微信）设计
核心原则：**宁可少回、慢回，也绝不发错人。**

1. **读取**：每 ~2s 调一次 `wechat-uia.ps1 -Action list`
   - 一次截图 + Windows OCR 扫描左侧会话列表，返回
     `rows: [{name, found, unread, preview, top, left, height}]`
   - 会话列表用 4x 最近邻放大 OCR；行锚点优先「绿底选中行 + 固定行距」推算，
     漏名字时按行裁「名字条」二次 OCR（bicubic 放大对形近字更差）
   - 截图默认 `auto`（PrintWindow 优先，不抢前台）；窗口被遮挡时才回退屏幕截图
   - `unread && preview` 非空 → 直接把预览文字当作入站消息（不打开聊天，快）
   - 未匹配 / preview 为空 → 回退 `-Action read`（打开聊天 OCR 读取）
   - 去重：消息 id = 预览/文本 hash；自问自答：发送后记录 lastSentText/preview 跳过
2. **发送**：`wechat-uia.ps1 -Action send`
   - 优先「行坐标快路径」：用 list 得到的 `top/left/height` 直接点会话行 → 校验标题 →
     输入 → 回车 → 区域快照校验气泡
   - 已有当前会话（180s 内自己打开过）时走「已打开聊天」分支
   - **没有定位信息 → 直接返回 ok:false**（`缺少聊天定位信息…已拒绝发送以避免发错人`）
   - 失败不回退到「搜索名字」的旧路径，避免点错人/重复发送
3. **让路**：发送前调 `user-activity.ps1` 读空闲毫秒；用户正在用电脑则暂缓
   （`channels.desktop.userActivityIdleMs`）。
4. **状态机**：`stopped → starting → running → degraded/error`；
   连续失败 6 次转 degraded，需重载插件恢复。

## 脚本契约（stdout 单行 JSON）
- `wechat-uia.ps1 -Action list -WindowTitle 微信 -Contacts "A,B,C" -CurrentContact X`
  → `{"ok":true,"rows":[{name,found,unread,preview,top,left,height}]}`
- `wechat-uia.ps1 -Action read -Contact A -MaxMessages 10`
  → `{"ok":true,"messages":[{id,text}]}`
- `wechat-uia.ps1 -Action send -Contact A -TextBase64 <b64> [-RowTop -RowLeft -RowHeight -CurrentContact]`
  → `{"ok":true}` 或 `{"ok":false,"error":"..."}`
- `user-activity.ps1` → `{"idleMs":12345}`

## 配置（profile cordis.patch.yml → 插件 config）
关键项：`enabled / activeChannel / whitelist / schedule(onlineStart,onlineEnd，工作日/周末分字段
留空时回退 onlineStart/onlineEnd) /
rateLimit / reply(温度/字数/表情率) / budget(dailyTokens) / channels.desktop{enabled,
windowTitle,userActivityIdleMs,pauseSeconds,driverEnabled}`。
默认 `activeChannel=mock`、`desktop.enabled=false`，用户手动开启后才碰真实微信。

## 安全边界
- 只操作微信窗口与本仓库脚本；不写注册表/系统设置；不读聊天记录数据库（只读屏幕像素）。
- 个人数据只在 `dataDir`（默认 `~/.dsh/profiles/desktop/.dsh-wechat-persona/`）。
- 所有对外 API 必须带 `x-dsh-wechat-persona: 1` 头；不暴露到局域网。

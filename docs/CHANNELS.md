# 三通道配置与风险说明

`dsh-wechat-persona` 的「回复引擎」与「通道」完全解耦：引擎只处理
`InboundMessage → 判断 → 生成 → OutboundPart`，通道负责把消息从微信搬进来、把回复搬出去。
通过配置 `activeChannel` 选择通道，切换通道不需要改人格/记忆/预算/风控逻辑。

| 通道 | 运行位置 | 与电脑解耦 | 抢键鼠/前台 | 需要 | 风险等级 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| `mock`（默认） | 插件进程内 | — | 否 | 无 | 无（不碰微信） | 安装后先用它验收 |
| `phone-adb` | 一台安卓手机/云手机 | ✅ 手机独立 | 否 | USB 调试 + ADBKeyboard | 中 | **推荐**：小号 + 备用机 |
| `windows-vm` | 虚拟机/独立 Windows 会话 | ✅ 独立会话 | 仅 VM 内 | 自建 VM + vm-agent | 中高 | 有 VM 条件时用 |
| `desktop`（默认关闭） | 用户当前桌面 | ❌ 共用 | ⚠️ 会打断用户 | 微信 PC + 中文 OCR 语言包 | 最高 | 只在小号 + 无人使用时临时开 |

> ⚠️ 无论哪个通道：**自动化操作微信违反微信协议，封号风险自担；只用小号。**
> **固定设备 + 固定网络**：不要频繁切 IP、不要挂代理/VPN 换区、不要多设备轮流登录同一小号，
> 这些是风控最敏感的信号。不要主动加好友、群发、导流、发链接轰炸。

---

## 通用：先在 mock 通道验收

```yaml
activeChannel: mock
```

- 入站：读 `<dataDir>/<channels.mock.inboundFile>`（默认 `inbound.jsonl`），每行一个 JSON：

```json
{"id":"m1","contactId":"张三","contactName":"张三","chatType":"single","kind":"text","text":"在干嘛","receivedAt":1700000000000}
```

- 出站：回复追加到 `<dataDir>/outbox.jsonl`；
- 允许带 `"risk":{"kind":"captcha","text":"..."}` 条目模拟风控熔断；
- 该通道不会访问任何真实微信，适合先验证白名单/时段/预算/表情包/审计。

---

## 1. phone-adb（推荐）

### 原理

- **收**：`adb shell dumpsys notification --noredact` 轮询微信通知，解析标题（联系人/群名）与正文；
  按 `postedTime + 标题 + 正文` 去重；群聊与非白名单在通道层丢弃（引擎还有第二道防线）。
- **发**：`adb shell input` 点击聊天输入框 → 用 ADBKeyboard 广播输入中文 → 点击发送；
  表情包按配置的格子坐标点击表情面板发送。
- **风控**：对通知/界面文案做关键词扫描，命中验证码/异常登录/限制提示 → 回调 `onRisk` 熔断。

### 前置条件

1. 安卓手机（或云手机）一台，登录**小号**微信；屏幕常亮、微信允许通知、聊天消息通知开启。
2. 开发者选项 + USB 调试开启；电脑 `adb devices` 能看到设备（首次需在手机上确认授权）。
3. 安装 [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard) 并启用输入法：

```powershell
adb install ADBKeyboard.apk
adb shell ime enable com.android.adbkeyboard/.AdbIME
adb shell ime set com.android.adbkeyboard/.AdbIME
```

4. 确认能读到微信通知：

```powershell
adb shell dumpsys notification --noredact | Select-String -Pattern "com.tencent.mm" -Context 0,6
```

> 注意：`dumpsys notification` 在部分 ROM 上被裁剪/需要额外权限；读不到时该通道不可用，
> 请换 ROM/云手机，或改用 windows-vm。**不要**为此去 root 或装 Xposed（风险更高）。

### 配置

```yaml
activeChannel: phone-adb
whitelist:
  - id: "张三"          # 必须与通知标题完全一致（备注名/昵称）
    name: "张三"
    aliases: ["阿三"]    # 可选：通知标题可能是昵称
channels:
  phoneAdb:
    adbPath: "adb"                  # 或 C:\platform-tools\adb.exe
    serial: ""                      # 多设备时填 adb devices 的第一列
    packageName: "com.tencent.mm"
    pollIntervalMs: 3000            # 通知轮询间隔
    inputMethod: "adb-keyboard"     # 中文用 ADBKeyboard；tap-keys 为逐字点按兜底
    adbKeyboardIme: "com.android.adbkeyboard/.AdbIME"
    sendButton: null                # 兜底坐标（UIA 找不到时用）
    stickerButton: null             # 表情面板按钮坐标
    stickerGrid: []                 # 表情格子坐标数组
    allowScreenshot: false          # 仅排障时临时开启
    commandTimeoutMs: 15000
```

### 坐标校准（需要一次）

手机分辨率不同，发送按钮/表情按钮/表情格子的坐标需要按你的手机校准：

```powershell
# 1) 打开与小号的聊天窗口，dump 当前界面
adb shell uiautomator dump /sdcard/ui.xml
adb pull /sdcard/ui.xml .
# 2) 在 ui.xml 里找“发送”按钮的 bounds="[x1,y1][x2,y2]"，中心点即坐标
# 3) 同样找“表情”按钮；点开表情面板后再 dump 一次，得到表情格子坐标
```

把坐标填进 `sendButton` / `stickerButton` / `stickerGrid`。校准后再用
`wechat_persona_send_test` 工具发一条测试消息确认。

### 风险点

- 输入法切换（ADBKeyboard）在个别机型/微信版本可能被检测到异常输入行为；
- 云手机本身可能是“共享 IP/虚拟设备”，风控风险高于真实备用机；
- ADB 连接断开（锁屏、USB 松动、省电策略）→ 通道 degraded，恢复后自动重试（≤2 次）；
- 通知里能看到**所有**微信通知，但插件只处理白名单，非白名单第一时间丢弃、不写记忆。

---

## 2. windows-vm（独立虚拟机/会话）

### 原理

微信 PC 登录在一台 **Windows 虚拟机**（VMware/VirtualBox/Hyper-V）或本机的**另一个登录会话**里；
VM 内运行参考 agent `scripts/vm-agent.mjs`，用 Windows UI Automation（PowerShell UIA）读写微信窗口；
本插件通过 `127.0.0.1:47653` 的 **JSON-lines over TCP** 与 agent 通信。

协议（每行一个 JSON）：

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| client → server | `{"type":"hello","token":"<共享密钥>"}` | 连接后立即发送；token 错误服务端直接断开 |
| client → server | `{"type":"send","reqId":"...","contactId":"...","part":{...}}` | 发送文本/表情包 |
| client → server | `{"type":"ping"}` | 心跳（15s） |
| server → client | `{"type":"inbound","message":{...}}` | 入站消息（同 InboundMessage 结构） |
| server → client | `{"type":"risk","kind":"captcha","text":"..."}` | 风控信号 |
| server → client | `{"type":"send-result","reqId":"...","ok":true}` | 发送结果 |

- 只监听回环地址，**不要**把端口暴露到局域网/公网；
- 断线自动重连（`reconnectIntervalMs`），重连后继续工作；
- 白名单/群聊过滤与 mock 通道同语义。

### 前置条件与配置

1. 建一台 Windows VM（建议 Win10/11，固定分辨率），安装微信并登录**小号**，保持登录；
2. 把 `scripts/vm-agent.mjs` 拷进 VM，装 Node.js；
3. VM 内启动 agent（示例）：

```powershell
$env:VM_AGENT_TOKEN='换成随机长字符串'
node vm-agent.mjs --port 47653 --token $env:VM_AGENT_TOKEN
```

4. 本机配置：

```yaml
activeChannel: windows-vm
channels:
  windowsVm:
    host: "127.0.0.1"
    port: 47653
    token: "换成随机长字符串"   # 必须与 agent 一致
    connectTimeoutMs: 5000
    reconnectIntervalMs: 3000
```

> 参考 agent 的 UIA 驱动部分是**半成品占位**：真实微信 PC 版本 UI 结构会变，
> 需要按你的微信版本校准控件选择（详见 `scripts/vm-agent.mjs` 顶部注释）。
> 本项目的验收与自动化测试不依赖真实 VM。

### 风险点

- VM 的 IP/时区/语言/硬件指纹与日常设备不同，频繁重建 VM 或换 IP 是高风险信号；
- VM 若走 NAT 后被宿主代理/VPN 影响，等同“挂代理”，**不要**；
- 微信 PC 多端登录有设备管理，VM 设备会长期出现在登录设备列表；
- 驱动依赖 UIA，微信更新可能让 agent 失效（表现为收不到/发不出 → 检查 `wechat_persona_status`）。

---

## 3. desktop（默认关闭，风险最高）

### 实际实现：视觉驱动（窗口截图 + OCR + 坐标操作）

桌面通道**不是** UI Automation 控件树驱动，而是视觉驱动，由 `scripts/pwsh/wechat-uia.ps1` 实现（Windows PowerShell 5.1，插件用 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File` 调用）：

- **截图**：只截**微信窗口区域**（`GetWindowRect` 取窗口矩形），优先用 `PrintWindow` 后台渲染；检测到全黑/全白（部分显卡/主题下 `PrintWindow` 不可用）时回退为窗口区域的屏幕拷贝；**不做全屏截图**；
- **识别**：Windows 内置 OCR（WinRT `Windows.Media.Ocr`，中文简体语言包），把 OCR 行按坐标分成“搜索框/左栏会话/右栏聊天区/输入区/发送按钮”；
- **操作**：`SetCursorPos` + `mouse_event` 点击；`SendInput` 以 Unicode 方式逐字符键入（**不碰剪贴板**、不用 `SendKeys`）；`INPUT` 结构体按 x64 40 字节对齐（旧版 32 字节会被系统拒绝，键入其实不生效）；
- **防干扰**：操作前用 `GetLastInputInfo` 判断键鼠空闲（脚本 15s + 插件 5s 双闸门）；结束后恢复最小化状态、原前台窗口与鼠标位置；只有窗口被其他窗口遮挡、需要真实点击时才临时前置。

### 读写流程

**读（read）**

1. 按标题找微信主窗口；窗口最小化则恢复（找错/找不到 → `ok:false`）；
2. 先判断右栏标题是否已是目标聊天 → 是则直接读，不点击、不抢前台；
3. 否则定位左上角搜索框 → 点击 → `Ctrl+A`/`Backspace` 清空 → Unicode 键入联系人名 → 在左栏搜索结果里点击命中项 → 未命中则回车 → 再未命中则点左栏会话列表首项（三级回退）→ 每次都用右栏标题校验；**校验不过直接返回失败，不读错聊天**；
4. 聊天区截图 OCR → 过滤时间戳/系统消息/纯标点等噪声行 → 多行气泡合并（行距 + 左对齐）→ 剔除右侧“自己发的”消息；
5. 与本地基线（`<dataDir>/uia-state.json`，按联系人保存最近 200 条文本）做尾部对齐，**只输出新消息**；对不上基线时视为滚动/OCR 抖动 → 重建基线且不输出（宁可不回，也不把旧消息当新消息）。

**写（send）**

1. 打开目标聊天并校验（同 read）；**校验不通过直接失败，绝不向错误联系人发送**；
2. 点击输入框 → `Ctrl+A`/`Backspace` 清残留 → Unicode 键入文本 → 找“发送”按钮（找不到则回车）；
3. 等 `WXUIA_SEND_WAIT_MS`（默认 900ms）后截图 OCR 校验气泡出现在聊天区（容错匹配，容忍 OCR 少量缺字）；
4. 未确认则**最多重试 3 次**（重试前先补一次校验，尽量避免重复发送）；仍失败返回 `{"ok":false,"error":"发送后未在聊天区看到消息气泡（已重试 3 次）…"}`。

**JSON 输出契约**（插件取 stdout 中第一行以 `{` 开头的 JSON）

| 场景 | 输出 |
| --- | --- |
| read 成功 | `{"ok":true,"messages":[{"id":"pc-<hash>-<n>","text":"…","receivedAt":1700000000}]}`（`messages` 可为空数组） |
| send 成功 | `{"ok":true}` |
| 任意失败 | `{"ok":false,"error":"具体原因"}` |

用户键鼠不空闲、窗口找不到、OCR 不可用、联系人无法确认、发送未确认……都返回 `ok:false` 并写明原因，**不会假成功**。

### 启用

```yaml
activeChannel: desktop
channels:
  desktop:
    enabled: true              # 通道开关
    windowTitle: "微信"        # 微信主窗口标题
    userActivityIdleMs: 5000   # 用户空闲 5s 才动手
    pauseSeconds: 30           # 检测到用户活动就让出 30s
    driverEnabled: true        # 允许脚本真正发送（第二个开关）
```

> `enabled` 与 `driverEnabled` 是**双开关**：都开才会真正驱动微信，避免误开。

### 前置条件（桌面通道特有）

1. Windows 10/11，微信 PC 已登录**小号**且保持登录，窗口标题默认「微信」；
2. 已安装**中文（简体）OCR 语言包**（缺了脚本会明确提示）：
   - 设置 → 时间和语言 → 语言和区域 → 添加「中文(简体，中国)」→ 语言选项 → 勾选“光学字符识别”；
   - 或管理员 PowerShell：`Get-WindowsCapability -Online -Name "Language.OCR*" | Add-WindowsCapability -Online`；
   - 验证：`Get-WindowsCapability -Online -Name "Language.OCR*"` 中 `zh-Hans-CN` 为 `Installed`；
3. 屏幕分辨率 ≥ 1366×768，缩放建议 100%–150%（脚本会声明 DPI 感知，但过高缩放会让坐标比例漂移）；
4. 只开一个可见微信窗口（多开工具可能让脚本找错窗口）；
5. 你别在用电脑：脚本检测到键鼠活动会放弃本轮并让出，回复延迟因此不可控（可能超过 10 秒验收预期）。

### 校准与环境变量

脚本按窗口内比例定位：聊天区分栏左边界默认占窗口宽度的 **62%**。位置不准时用环境变量微调（在启动 DSH 的环境里设置后重启 DSH）：

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `WXUIA_PANE_LEFT_RATIO` | `0.62` | 聊天分栏左边界占窗口宽度比例（也可用脚本参数 `-PaneLeftRatio`） |
| `WXUIA_SEND_WAIT_MS` | `900` | 点发送后等待 OCR 校验的毫秒数（限制在 500–1200） |
| `WXUIA_IDLE_MS` | `15000` | 脚本自身的键鼠空闲闸门（独立于插件 `userActivityIdleMs`） |
| `WXUIA_ACTIVE_HOURS` | 不设 = 不限 | 如 `22:00-02:00`（支持跨午夜）；**在线时段建议交给插件 `schedule`**，脚本层只作兜底 |
| `WXUIA_DEBUG` | 不设 | `1` = 写调试日志到临时目录；也可给一个日志文件路径 |
| `WXUIA_SHOT_DIR` | 不设 | 保存每次截图（排障用，含聊天内容，用完删除） |
| `WXUIA_FORCE` | 不设 | `1` = 忽略空闲/时间闸门（**仅在你盯着排障时用**） |
| `WXUIA_NOBASELINE` | 不设 | `1` = 不做基线去重，每次输出全部可见消息（测试用） |
| `WXUIA_CAPTURE` | `auto` | 截图方式：`printwindow` / `screen` / `auto`（默认先 PrintWindow，空白则回退屏幕） |
| `WXUIA_STATE_PATH` | `<dataDir>/uia-state.json` | 基线状态文件路径 |

### 风险点（为什么默认关闭）

- 与你共用桌面：会真实移动鼠标、点击、键入，误点击/抢焦点代价最高；
- 微信 PC 窗口被遮挡或在后台时最不稳定，脚本可能临时前置窗口打扰你；
- OCR 有盲区：可能“已发出但报失败”，极端情况下重试会重复发送（插件有消息去重，但没有事务保证）；
- 与日常主号共用设备时，自动化行为更容易被关联；
- 微信客户端更新可能改变界面布局/字体，脚本需要重新校准；
- 你正在用电脑时插件频繁让出 → 回复延迟不可控。

**建议**：除非你没有手机/VM，且只在无人时段临时使用，否则不要启用；第一次开务必在旁边盯着，先只发测试消息。

### 真实环境验证清单（尚未在真实微信上验证的事项）

> 说明：开发环境没有可自动化操作的真实微信窗口，最终用**自建模拟微信窗口**（WinForms，含搜索框/左栏会话/聊天标题/消息气泡/输入框/发送按钮）完成了端到端集成测试。以下行为**尚未在真实微信 PC 窗口上验证**，首次启用桌面通道时请逐项确认。

| 待验证项 | 当前状态 | 说明 |
| --- | --- | --- |
| 真实微信窗口 OCR 识别率（字体/主题/缩放） | ⚠️ 未验证 | 模拟窗口 OCR 正常；真实微信字体可能误识，影响消息文本与去重 |
| 搜索框自动定位 | ⚠️ 未验证 | 先按左上角“搜索/搜一搜”文本定位，找不到用固定比例兜底；真实版本位置需确认 |
| 左栏搜索结果点击 / 会话列表首项 | ⚠️ 未验证 | 模拟窗口通过；真实微信“搜索到的聊天”布局可能不同 |
| 分栏比例 0.62 | ⚠️ 未验证 | 按微信默认三栏布局估算，可用 `WXUIA_PANE_LEFT_RATIO` 校准 |
| 发送按钮识别 | ⚠️ 未验证 | 模拟窗口未识别到按钮、回车兜底成功；真实微信需确认回车不会触发换行 |
| 多行气泡合并 | ⚠️ 未验证 | 仅用单行消息测试；长消息多行合并规则需实机确认 |
| 剔除自己发的消息（右侧判定） | ⚠️ 未验证 | 逻辑按“中心点在分栏中线右侧”判定，需真实聊天验证 |
| 中文键入（SendInput 40 字节结构） | ⚠️ 部分验证 | 结构体已实测 40 字节，模拟窗口键入/发送成功；真实微信输入框未验证 |
| 被踢登录 / 窗口最小化 / 被遮挡恢复 | ⚠️ 部分验证 | 最小化恢复、前台/光标恢复逻辑在模拟窗口跑通；被踢与多窗口未验证 |
| 多显示器 / DPI 缩放 / 分辨率切换 | ⚠️ 未验证 | 单显示器 2560×1440、未设自定义缩放环境下验证 |
| 真实风控提示识别 | ⚠️ 未验证 | 依赖插件层通道文案扫描，桌面通道未接真实提示 |
| 表情包发送 | ❌ 不支持 | 桌面通道会明确返回错误，不会假装发送 |
| 群聊 | ❌ 不支持 | 群聊一律不回 |

**已完成的验证**（可作为最低信心保障）：

- Windows PowerShell 5.1 语法解析 **0 错误**，脚本保持 **UTF-8 BOM**（中文不乱码）；
- 结构体实测：`INPUT=40`、`KEYBDINPUT=24`、`MOUSEINPUT=32`（旧版 INPUT=32，x64 上 `SendInput` 必失败）；
- 模拟窗口端到端 5 个用例全部通过：首次无基线读取 2 条 → 建立基线返回空 → 新增 1 条只回报 1 条 → 发送后 OCR 校验成功 → 错误联系人明确失败；
- 发送失败/联系人无法确认/空闲不足等场景都返回 `ok:false`（不假成功），且窗口恢复前台/光标位置。

---

## 防封清单（所有通道通用）

- ✅ 只用自己注册的**小号**，头像/昵称/简介手动设置成普通人；
- ✅ 固定设备 + 固定网络（同一 Wi-Fi/同一出口 IP），**不要频繁切 IP、不要挂代理/VPN 换区**；
- ✅ 只被动回复白名单单聊；不主动加好友、不群发、不进群、不导流；
- ✅ 拟人节奏：不秒回（0.8–5s 随机“正在输入”）、偶尔分条、表情包不连刷；
- ✅ 作息：在线时段外完全静默；每周留 1 天低活跃；
- ✅ 限频：每人每小时 10 条、每天 60 条（可再收紧）；
- ✅ 出现验证码/异常登录/限制提示：**立即停手**（插件会自动熔断），人工处理，不自动重试；
- ❌ 不要用主号、不要多设备轮流登录、不要用自动化做营销/诈骗/刷单。

## 风险提示（照抄给使用者）

> 本插件通过自动化方式操作微信客户端/手机通知，违反《微信软件许可及服务协议》，
> 账号可能被限制或封禁，风险由使用者自行承担。请仅使用自己注册的小号，并遵守当地法律法规。
> 插件不注册账号、不自动加好友、不群发、不进群、不涉及支付/转账/验证码/登录凭据。

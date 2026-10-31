# 视觉驱动版 PC 微信脚本（desktop 通道专用）。
#
# 微信 4.x 是 Qt 自绘窗口，UIA 控件树不可用；本脚本改为「窗口区域截图 + Windows OCR + 点击/键入」：
#   - 只截微信窗口自身区域（优先 PrintWindow 后台截图；拿到全黑/全白图时回退窗口区域 CopyFromScreen），
#     不做全屏截图、不读剪贴板、不联网、不下载任何东西；
#   - 尽量不抢前台：当前聊天已经是目标联系人时，仅后台截图读取，不点击、不切窗口；
#     只有在“进入聊天 / 发送”这两类必须键鼠操作时才短暂切到前台，结束后恢复原前台窗口、最小化状态与鼠标位置；
#   - 发送后必须用 OCR 在聊天区看到刚发的气泡才算成功，最多重试 3 次，仍看不到就返回 ok:false，
#     不再出现“没发出去却报成功”的假成功。
#
# 参数/输出契约与 src/channels/pc/desktop.ts 保持一致（stdout 只输出单行 JSON；退出码 0 表示脚本正常执行，成败看 ok）：
#   -Action send -WindowTitle 微信 -Contact 好友A -TextBase64 <b64>
#       => {"ok":true}  或  {"ok":false,"error":"..."}
#   -Action read -WindowTitle 微信 -Contact 好友A -MaxMessages 20
#       => {"ok":true,"messages":[{"id":"pc-xxxx-1","text":"...","receivedAt":1700000000}]}
#
# 环境变量（都可不设；desktop.ts 不会传，供人工排障/校准用）：
#   WXUIA_FORCE=1                跳过脚本内置的空闲/时段闸门（调试用；插件层仍有自己的闸门）
#   WXUIA_NOBASELINE=1           read 不做首次基线，直接输出当前聊天窗口里可见的对方消息
#   WXUIA_DEBUG=1|<日志文件>      调试日志（1 = 写到 %TEMP%\wxuia-debug.log；否则当作日志文件路径）
#   WXUIA_SHOT_DIR=<目录>         可选：把每次 OCR 用到的截图另存一份，便于实机校准坐标（默认不存）
#   WXUIA_ACTIVE_HOURS=8-21      可选：脚本级工作时段硬闸门（支持跨午夜，如 22-6；默认不设=不限制，
#                                在线时段由插件 schedule 管理）
#   WXUIA_IDLE_MS=15000          键鼠空闲阈值：低于该值不操作微信（read 返回空、send 直接失败）
#   WXUIA_PANE_LEFT_RATIO=0.62   右侧聊天面板起点占窗口宽度的比例（分栏/缩放与默认不同时校准）
#   WXUIA_SEND_WAIT_MS=900       发送后等待 OCR 校验的毫秒数（自动夹在 500-1200）
#   WXUIA_CAPTURE=auto|printwindow|screen  截图方式（auto=先 PrintWindow，空白再回退）
#   WXUIA_STATE_PATH=<文件>       基线状态文件（默认 %USERPROFILE%\.dsh\profiles\desktop\.dsh-wechat-persona\uia-state.json）
#   WXUIA_SKIP_ENTER=1           测试用：快发送分支跳过回车（验证“输入框未清空”时返回 ok:false、不误报成功）
#   WXUIA_FORCE_BUBBLE_FAIL=1    测试用：强制气泡校验失败，走“输入框已清空”兜底判定
#
# 已知限制（无真实微信环境无法验证，见 docs/CHANNELS.md 的「桌面通道真实环境验证清单」）：
#   - 依赖 Windows 10/11 自带 OCR 并已安装“中文（简体）”OCR 语言包；
#   - OCR 对气泡文字的分行、形近字有误差：已做行合并/系统消息过滤/相似度容错，但仍需实机校准；
#   - 分栏比例、输入框/发送按钮位置随微信版本、窗口尺寸、显示缩放变化，可用上面的环境变量调整。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('send', 'read', 'list')][string]$Action,
    [string]$WindowTitle = '微信',
    [string]$Contact = '',
    [string]$Contacts = '',
    [string]$CurrentContact = '',
    [string]$TextBase64 = '',
    [int]$MaxMessages = 20,
    [int]$RowTop = 0,
    [int]$RowLeft = 0,
    [int]$RowHeight = 0,
    # 可选：右侧聊天面板起点占窗口宽度比例；0 = 用环境变量/默认 0.62。
    [double]$PaneLeftRatio = 0,
    # 可选：read 时只读“当前已打开的会话”，标题/CurrentContact 都对不上时绝不 Ctrl+F 搜索（避免抢前台、搜索框闪烁）。
    [switch]$NoSearch
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ── 基础输出与通用小工具 ─────────────────────────────────────────────────
function Write-Result([hashtable]$Payload) { $Payload | ConvertTo-Json -Compress -Depth 6 }
function Fail-With([string]$Message) {
    Write-Debug-Log ("FAIL: " + $Message)
    Write-Result @{ ok = $false; error = $Message }
    exit 0
}
function Now-Id() { [DateTimeOffset]::Now.ToUnixTimeSeconds() }

function Test-TruthyEnv([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $v = $Value.Trim().ToLowerInvariant()
    return -not ($v -eq '0' -or $v -eq 'false' -or $v -eq 'no' -or $v -eq 'off')
}
function Get-Env-Int([string]$Name, [int]$Default, [int]$Min, [int]$Max) {
    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    $value = 0
    if (-not [int]::TryParse($raw.Trim(), [System.Globalization.NumberStyles]::Integer, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$value)) { return $Default }
    if ($value -lt $Min) { return $Min }
    if ($value -gt $Max) { return $Max }
    return $value
}
function Get-Env-Ratio([string]$Name, [double]$Default) {
    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    $value = 0.0
    if (-not [double]::TryParse($raw.Trim(), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$value)) { return $Default }
    if ($value -le 0 -or $value -ge 1) { return $Default }
    return $value
}

# 归一化：去空白/零宽字符、全角转半角、转小写，用于 OCR 文本比较。
# 会话行被选中时微信会画绿色底：用屏幕像素颜色判断点击是否选中了目标行（比 OCR 稳）。
function Test-GreenSelection([int]$X, [int]$Y) {
    # 沿行横向采 6 个点（绿底很长，点偏移也不会全落空），任一偏绿即算选中；同时记 RGB 便于校准。
    $offsets = @(0, 60, 120, 180, 240, 300)
    $firstRgb = ''
    foreach ($off in $offsets) {
        try {
            $bmp = New-Object System.Drawing.Bitmap(1, 1)
            try {
                $g = [System.Drawing.Graphics]::FromImage($bmp)
                try { $g.CopyFromScreen($X + $off, $Y, 0, 0, (New-Object System.Drawing.Size(1, 1))) } finally { $g.Dispose() }
                $px = $bmp.GetPixel(0, 0)
                if (-not $firstRgb) { $firstRgb = ("{0},{1},{2}" -f $px.R, $px.G, $px.B) }
                if ($px.G -gt 90 -and $px.G -gt $px.R -and $px.G -ge $px.B) { return $true }
            } finally { $bmp.Dispose() }
        } catch {}
    }
    Write-Debug-Log ("PIX 非绿色 @ " + $X + "," + $Y + " rgb=" + $firstRgb)
    return $false
}
function Normalize-Text([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $s = $Text -replace '\s+', ''
    $s = $s -replace '[\u00A0\u200B\u200C\u200D\uFEFF]', ''
    try { $s = $s.Normalize([System.Text.NormalizationForm]::FormKC) } catch {}
    return $s.ToLowerInvariant()
}
# OCR 常在汉字之间插空格（字体渲染导致），投递前清理：连续空白折叠为一个空格，
# 汉字/全角标点相邻的空格去掉，ASCII 单词之间的空格保留。
function Get-CleanText([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $t = [regex]::Replace($Text, '\s+', ' ').Trim()
    if (-not $t) { return '' }
    $cjk = '[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]'
    $t = [regex]::Replace($t, "(?<=$cjk)\s+(?=$cjk)", '')
    $t = [regex]::Replace($t, "(?<=$cjk)\s+", '')
    $t = [regex]::Replace($t, "\s+(?=$cjk)", '')
    return $t
}
function Get-Hash([string]$Text) {
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([System.BitConverter]::ToString($sha1.ComputeHash($bytes)) -replace '-', '').Substring(0, 12).ToLowerInvariant()
    } finally { $sha1.Dispose() }
}
function Char-IsAsciiWord([char]$Ch) { return ([int]$Ch -lt 128 -and [char]::IsLetterOrDigit($Ch)) }

# ── 脚本级配置 ───────────────────────────────────────────────────────────
$script:Force = Test-TruthyEnv ([Environment]::GetEnvironmentVariable('WXUIA_FORCE'))
$script:NoBaseline = Test-TruthyEnv ([Environment]::GetEnvironmentVariable('WXUIA_NOBASELINE'))
$script:IdleThresholdMs = Get-Env-Int 'WXUIA_IDLE_MS' 1500 0 3600000
$script:SendWaitMs = Get-Env-Int 'WXUIA_SEND_WAIT_MS' 900 500 1200
$script:PaneLeftRatio = if ($PaneLeftRatio -gt 0 -and $PaneLeftRatio -lt 1) { $PaneLeftRatio } else { Get-Env-Ratio 'WXUIA_PANE_LEFT_RATIO' 0.30 }
# 微信是 Qt/GPU 渲染窗口，PrintWindow 偶尔抓到旧帧，但默认屏幕截图会在微信被遮挡时抢前台
# （用户可见窗口/搜索框每 2 秒抖动一次）。默认 auto：先 PrintWindow（不抢前台，轮询场景内容稳定），
# 抓不到内容再回退屏幕截图（此时才短暂切前台，由 finally 恢复）。
$script:CaptureMode = 'auto'
$captureRaw = [Environment]::GetEnvironmentVariable('WXUIA_CAPTURE')
if (-not [string]::IsNullOrWhiteSpace($captureRaw)) {
    $captureRaw = $captureRaw.Trim().ToLowerInvariant()
    if ($captureRaw -eq 'screen' -or $captureRaw -eq 'printwindow' -or $captureRaw -eq 'auto') { $script:CaptureMode = $captureRaw }
}
$script:FocusStolen = $false
$script:TargetHwnd = [IntPtr]::Zero
# OCR 前把窗口截图放大，能明显改善微信小字号气泡的识别率；点击坐标会按比例缩回去。
$script:Upscale = Get-Env-Int 'WXUIA_UPSCALE' 2 1 4

# 联系人名/标题的宽松匹配：OCR 常把“件”认成“亻牛”这类形近字，整串相等时容易失败。
function Test-NameLike([string]$Text, [string]$Needle) {
    $t = Normalize-Text $Text
    $n = Normalize-Text $Needle
    $t = ($t -replace '[^\u4e00-\u9fa5A-Za-z0-9]', '')
    $n = ($n -replace '[^\u4e00-\u9fa5A-Za-z0-9]', '')
    if (-not $t -or -not $n) { return $false }
    if ($t.Contains($n)) { return $true }
    if ($n.Length -ge 2 -and $n.Contains($t) -and $t.Length -ge 2) { return $true }
    # 形近字/漏字容错：标题经常少一个字（如「张，伟」），按字符覆盖率兜底。
    if ($t.Length -ge 2) {
        $matched = 0
        foreach ($ch in $t.ToCharArray()) { if ($n.Contains([string]$ch)) { $matched++ } }
        Write-Debug-Log ("COV t=" + $t + " n=" + $n + " m=" + $matched + " tl=" + $t.Length + " nl=" + $n.Length)
        if ($matched -ge 2 -and ($matched / $t.Length) -ge 0.6 -and ($matched / $n.Length) -ge 0.5) { return $true }
    }
    if ($n.Length -lt 4) { return $false }
    # 取 Needle 的 4 字滑窗（从长到短兜底）看是否出现在 Text 里。
    for ($len = [math]::Min($n.Length, 6); $len -ge 4; $len--) {
        for ($i = 0; $i -le ($n.Length - $len); $i++) {
            $seg = $n.Substring($i, $len)
            if ($t.Contains($seg)) { return $true }
        }
    }
    return $false
}

$statePath = [Environment]::GetEnvironmentVariable('WXUIA_STATE_PATH')
if ([string]::IsNullOrWhiteSpace($statePath)) {
    $statePath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\.dsh-wechat-persona\uia-state.json'
}
$script:StatePath = $statePath.Trim()

$script:DebugPath = $null
$debugRaw = [Environment]::GetEnvironmentVariable('WXUIA_DEBUG')
if (Test-TruthyEnv $debugRaw) {
    $candidatePath = $debugRaw.Trim()
    if ($candidatePath -eq '1') { $candidatePath = Join-Path $env:TEMP 'wxuia-debug.log' }
    try {
        $debugDir = Split-Path $candidatePath -Parent
        if ($debugDir -and -not (Test-Path $debugDir)) { New-Item -ItemType Directory -Path $debugDir -Force | Out-Null }
        $script:DebugPath = $candidatePath
    } catch { $script:DebugPath = $null }
}
$script:DefaultDebugPath = Join-Path $env:TEMP 'wxuia-engine-debug.log'
function Write-Debug-Log([string]$Line) {
    if (-not $script:DebugPath) { $script:DebugPath = $script:DefaultDebugPath }
    try { if ((Test-Path $script:DebugPath) -and (Get-Item $script:DebugPath).Length -gt 2MB) { Remove-Item $script:DebugPath -Force -ErrorAction SilentlyContinue } } catch {}
    try {
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
        [System.IO.File]::AppendAllText($script:DebugPath, ("[" + $stamp + "] " + $Line + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
}

$script:ShotDir = $null
$shotRaw = [Environment]::GetEnvironmentVariable('WXUIA_SHOT_DIR')
if (-not [string]::IsNullOrWhiteSpace($shotRaw)) {
    try {
        $script:ShotDir = $shotRaw.Trim()
        if (-not (Test-Path $script:ShotDir)) { New-Item -ItemType Directory -Path $script:ShotDir -Force | Out-Null }
    } catch { $script:ShotDir = $null }
}

if ($MaxMessages -lt 1) { $MaxMessages = 1 }
if ($MaxMessages -gt 200) { $MaxMessages = 200 }

function Test-AllowedHours {
    $spec = [Environment]::GetEnvironmentVariable('WXUIA_ACTIVE_HOURS')
    if ([string]::IsNullOrWhiteSpace($spec)) { return $true }
    if ($spec.Trim() -notmatch '^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$') { return $true }
    $start = [int]$Matches[1]; $end = [int]$Matches[2]
    if ($start -lt 0 -or $start -gt 23 -or $end -lt 0 -or $end -gt 23) { return $true }
    if ($start -eq $end) { return $true }
    $hour = (Get-Date).Hour
    if ($start -lt $end) { return ($hour -ge $start -and $hour -lt $end) }
    # 跨午夜，例如 22-6：hour>=22 或 hour<6 都算在线时段。
    return ($hour -ge $start -or $hour -lt $end)
}

# ── Win32 封装（x64 关键：INPUT 必须 40 字节，否则 SendInput 的 cbSize 校验失败，键入实际不生效） ──
try {
    if (-not ('WXDriver' -as [type])) {
        Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class WXDriver {
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool repaint);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        public const uint SWP_NOMOVE = 0x0002; public const uint SWP_NOSIZE = 0x0001; public const uint SWP_NOACTIVATE = 0x0010;
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    // x64 下 INPUT = 40 字节（type 4 + 对齐 4 + union 32）；union 的 32 字节由 MOUSEINPUT 撑出来。
    // 旧实现用 [FieldOffset(8)] 只放 KEYBDINPUT，Marshal.SizeOf 只有 32，SendInput 会返回 0，中文根本发不出去。
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    static string WindowTitleOf(IntPtr h) {
        int len = GetWindowTextLength(h);
        var sb = new StringBuilder(len + 2);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static IntPtr FindWindowByTitle(string title) {
        IntPtr exact = IntPtr.Zero; IntPtr partial = IntPtr.Zero;
        EnumWindows((h, p) => {
            if (!IsWindowVisible(h)) return true;
            if (IsIconic(h)) return true;
            RECT r; GetWindowRect(h, out r);
            int w = r.Right - r.Left, hh = r.Bottom - r.Top;
            if (w < 700 || hh < 450) return true;
            string t = WindowTitleOf(h);
            if (t.IndexOf("DeepSeek Harness", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (t == title) { if (exact == IntPtr.Zero) exact = h; return true; }
            if (t.Contains(title) && partial == IntPtr.Zero) partial = h;
            return true;
        }, IntPtr.Zero);
        return exact != IntPtr.Zero ? exact : partial;
    }

    // 最小化/隐藏状态也能找到窗口（优先 Qt 类名、优先面积大的），找到后由 PowerShell 侧 ShowWindow 恢复。
    public static IntPtr FindWindowAnyState(string title) {
        IntPtr found = IntPtr.Zero; long bestScore = -1;
        EnumWindows((h, p) => {
            // 允许隐藏/托盘的窗口：微信被收进托盘时 IsWindowVisible=false，但句柄仍有效。
            if (WindowTitleOf(h) != title) return true;
            var cn = new StringBuilder(256); GetClassName(h, cn, 256);
            string cls = cn.ToString();
            if (cls == "ConsoleWindowClass") return true;
            RECT r; GetWindowRect(h, out r);
            long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            long score = area + (cls.StartsWith("Qt") ? 1000000000L : 0);
            if (score > bestScore) { bestScore = score; found = h; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(30);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }

    static INPUT KeyInput(ushort vk, bool up) {
        var i = new INPUT();
        i.type = 1;
        i.u.ki.wVk = vk;
        i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0u;
        return i;
    }
    static void SendKeys(INPUT[] arr) { SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))); }

    public static void KeyTap(ushort vk) { SendKeys(new INPUT[] { KeyInput(vk, false), KeyInput(vk, true) }); }
    public static void CtrlA() { SendKeys(new INPUT[] { KeyInput(0x11, false), KeyInput(0x41, false), KeyInput(0x41, true), KeyInput(0x11, true) }); }
    public static void CtrlF() { SendKeys(new INPUT[] { KeyInput(0x11, false), KeyInput(0x46, false), KeyInput(0x46, true), KeyInput(0x11, true) }); }
    public static void CtrlV() { SendKeys(new INPUT[] { KeyInput(0x11, false), KeyInput(0x56, false), KeyInput(0x56, true), KeyInput(0x11, true) }); }
    public static void PressBackspace() { KeyTap(0x08); }
    public static void PressEnter() { KeyTap(0x0D); }
    public static void PressEsc() { KeyTap(0x1B); }

    // 逐 UTF-16 code unit 用 KEYEVENTF_UNICODE 输入中文/emoji，不经过剪贴板。
    public static void TypeText(string text, int delayMs = 12) {
        if (string.IsNullOrEmpty(text)) return;
        // 逐字符发送并留出间隔：一次性灌入整串时，微信输入框会丢字、重复标点。
        foreach (char ch in text) {
            var list = new List<INPUT>(2);
            var down = new INPUT(); down.type = 1; down.u.ki.wScan = ch; down.u.ki.dwFlags = KEYEVENTF_UNICODE; list.Add(down);
            var up = new INPUT(); up.type = 1; up.u.ki.wScan = ch; up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP; list.Add(up);
            SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);
        }
    }

    // 尽力把目标窗口切到前台。SetForegroundWindow 受前台锁限制时，用一次 Alt 键解除限制再试。
    public static bool ForceForeground(IntPtr h) {
        if (GetForegroundWindow() == h) return true;
        if (IsIconic(h)) ShowWindow(h, 9);
        ShowWindow(h, 5);
        if (SetForegroundWindow(h)) {
            System.Threading.Thread.Sleep(150);
            if (GetForegroundWindow() == h) return true;
        }
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        System.Threading.Thread.Sleep(100);
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(200);
        return GetForegroundWindow() == h;
    }

    // 窗口是否被别的窗口挡住（用于决定窗口区域截图前是否需要短暂切前台）。
    public static bool IsOccluded(IntPtr h) {
        if (IsIconic(h)) return false;
        if (GetForegroundWindow() == h) return false;
        RECT r; GetWindowRect(h, out r);
        var pt = new POINT(); pt.X = r.Left + (r.Right - r.Left) / 2; pt.Y = r.Top + (r.Bottom - r.Top) / 2;
        IntPtr at = WindowFromPoint(pt);
        if (at == IntPtr.Zero) return true;
        return GetAncestor(at, 2) != h;
    }

    public static uint IdleMs() {
        var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        GetLastInputInfo(ref info);
        return (uint)Environment.TickCount - info.dwTime;
    }
}
'@
    }
} catch { Fail-With "加载 Win32 封装失败: $($_.Exception.Message)" }

# ── WinRT OCR 初始化 ──────────────────────────────────────────────────────
$script:OcrEngine = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    function Await($WinRtTask, [Type]$ResultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRtTask))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
    [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
    Add-Type -AssemblyName System.Drawing | Out-Null
    $lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'
    $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if (-not $script:OcrEngine) { $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if (-not $script:OcrEngine) { Fail-With '系统 OCR 引擎不可用：请安装“中文（简体）”OCR 语言包（设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 可选语言功能/OCR）' }
} catch { Fail-With "初始化 Windows OCR 失败: $($_.Exception.Message)" }

# ── 截图 ─────────────────────────────────────────────────────────────────
function Test-BitmapBlank($Bitmap) {
    try {
        $w = $Bitmap.Width; $h = $Bitmap.Height
        $min = 255; $max = -1
        for ($gy = 1; $gy -le 4; $gy++) {
            for ($gx = 1; $gx -le 6; $gx++) {
                $x = [int]([double]$w * $gx / 7.0); $y = [int]([double]$h * $gy / 5.0)
                if ($x -ge $w) { $x = $w - 1 }
                if ($y -ge $h) { $y = $h - 1 }
                if ($x -lt 0 -or $y -lt 0) { continue }
                $c = $Bitmap.GetPixel($x, $y)
                $b = [int](($c.R + $c.G + $c.B) / 3)
                if ($b -lt $min) { $min = $b }
                if ($b -gt $max) { $max = $b }
            }
        }
        if ($max -lt 0) { return $false }
        # 全黑/全白/几乎无颜色变化 => 认定为 PrintWindow 没抓到内容，需要回退。
        return (($max - $min) -lt 8)
    } catch { return $false }
}

function Get-WindowShot([IntPtr]$Hwnd, [string]$OutPath) {
    $rect = New-Object 'WXDriver+RECT'
    [WXDriver]::GetWindowRect($Hwnd, [ref]$rect) | Out-Null
    $w = [int]($rect.Right - $rect.Left)
    $h = [int]($rect.Bottom - $rect.Top)
    if ($w -lt 120 -or $h -lt 120) { throw "窗口尺寸异常 ${w}x${h}（微信窗口可能已最小化或不可见）" }
    $size = New-Object System.Drawing.Size($w, $h)
    $source = 'printwindow'
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    if ($script:CaptureMode -ne 'screen') {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $ok = $false
        try {
            $hdc = $g.GetHdc()
            try { $ok = [WXDriver]::PrintWindow($Hwnd, $hdc, 2) } finally { $g.ReleaseHdc($hdc) }
        } finally { $g.Dispose() }
        if (-not $ok -or (Test-BitmapBlank $bmp)) { $source = 'screen' }
    } else { $source = 'screen' }

    if ($source -eq 'screen') {
        $bmp.Dispose()
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        # 被别的窗口挡住时，窗口区域截图会拍到遮挡物：短暂切前台再截图，结束后由 finally 恢复前台。
        if ([WXDriver]::IsOccluded($Hwnd)) {
            [WXDriver]::ForceForeground($Hwnd) | Out-Null
            $script:FocusStolen = $true
            Start-Sleep -Milliseconds 150
        }
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try { $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $size) } finally { $g.Dispose() }
    }
    # OCR 前放大截图：微信气泡字号小，直接识别误差很大（形近字、整行乱码）。
    $scale = 1.0
    if ($script:Upscale -gt 1) {
        try {
            $sw = [int]($w * $script:Upscale); $sh = [int]($h * $script:Upscale)
            $scaled = New-Object System.Drawing.Bitmap($sw, $sh)
            $sg = [System.Drawing.Graphics]::FromImage($scaled)
            try {
                # 最近邻放大：保留字形边缘，Windows OCR 对小字更准（bicubic 会糊掉「思/琦」等笔画）
                $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
                $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $sg.DrawImage($bmp, 0, 0, $sw, $sh)
            } finally { $sg.Dispose() }
            $bmp.Dispose()
            $bmp = $scaled
            $scale = [double]$script:Upscale
        } catch { }
    }
    try { $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bmp.Dispose() }
    return @{
        left = [int]$rect.Left; top = [int]$rect.Top
        width = $w; height = $h
        right = [int]($rect.Left + $w); bottom = [int]($rect.Top + $h)
        source = $source; scale = $scale
    }
}

function Get-OcrLines([string]$Path, [double]$Scale = 1.0) {
    $lines = @()
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await ($script:OcrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        foreach ($line in $result.Lines) {
            $text = [string]$line.Text
            if ([string]::IsNullOrWhiteSpace($text)) { continue }
            $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
            foreach ($word in $line.Words) {
                $r = $word.BoundingRect
                if ($r.Left -lt $minX) { $minX = $r.Left }
                if ($r.Top -lt $minY) { $minY = $r.Top }
                if (($r.Left + $r.Width) -gt $maxX) { $maxX = $r.Left + $r.Width }
                if (($r.Top + $r.Height) -gt $maxY) { $maxY = $r.Top + $r.Height }
            }
            if ($Scale -ne 1.0) { $minX /= $Scale; $minY /= $Scale; $maxX /= $Scale; $maxY /= $Scale }
            $lines += @{ text = $text.Trim(); left = $minX; top = $minY; right = $maxX; bottom = $maxY }
        }
    } finally {
        try { $stream.Dispose() } catch {}
    }
    return $lines
}

# 一次“截图 + OCR”，返回窗口几何（含 right/bottom，修复旧脚本读取不存在的 right 键导致
# `-gt $null` 恒为 True、把所有行都跳过、read 永远空数组的 bug）与 OCR 行。
function Get-WindowSnapshot([IntPtr]$Hwnd, [string]$Tag) {
    $png = Join-Path $env:TEMP ("wxuia-{0}-{1}.png" -f $Tag, [Guid]::NewGuid().ToString('N'))
    try {
        $geo = Get-WindowShot $Hwnd $png
        if ($script:ShotDir) {
            try {
                $copy = Join-Path $script:ShotDir ("{0}-{1}.png" -f $Tag, (Get-Date).ToString('HHmmssfff'))
                Copy-Item -LiteralPath $png -Destination $copy -Force
            } catch {}
        }
        $lines = @(Get-OcrLines $png ([double]$geo.scale))
    } finally {
        Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
    }
    Write-Debug-Log ("SHOT " + $Tag + " geo=" + ($geo | ConvertTo-Json -Compress) + " lines=" + $lines.Count)
    foreach ($l in $lines) {
        Write-Debug-Log ("  LINE x=" + [int]$l.left + " y=" + [int]$l.top + " w=" + [int]($l.right - $l.left) + " t=" + $l.text)
    }
    return @{ geo = $geo; lines = $lines }
}

function Get-RegionSnapshot([IntPtr]$Hwnd, [string]$Tag, [double]$rx0, [double]$ry0, [double]$rx1, [double]$ry1, [switch]$Ink) {
    $png = Join-Path $env:TEMP ("wxuia-r-{0}-{1}.png" -f $Tag, [Guid]::NewGuid().ToString('N'))
    $crop = Join-Path $env:TEMP ("wxuia-rc-{0}-{1}.png" -f $Tag, [Guid]::NewGuid().ToString('N'))
    $lines = @()
    try {
        $geo = Get-WindowShot $Hwnd $png
        $bmp = [System.Drawing.Bitmap]::FromFile($png)
        try {
            $x0 = [int]($bmp.Width * $rx0); $y0 = [int]($bmp.Height * $ry0)
            $w = [int]($bmp.Width * ($rx1 - $rx0)); $h = [int]($bmp.Height * ($ry1 - $ry0))
            $rect = New-Object System.Drawing.Rectangle($x0, $y0, [Math]::Max(1, $w), [Math]::Max(1, $h))
            $c = $bmp.Clone($rect, $bmp.PixelFormat)
            try {
                $c.Save($crop, [System.Drawing.Imaging.ImageFormat]::Png)
                if ($Ink) {
                    # 统计深色像素（文字比占位灰「长按鼠标 语音输入」深得多）：
                    # 输入框有字时深色像素明显 >0，清空后只剩浅灰占位/空白 ≈0。
                    $dark = 0
                    for ($iy = 0; $iy -lt $c.Height; $iy += 2) {
                        for ($ix = 0; $ix -lt $c.Width; $ix += 2) {
                            $pc = $c.GetPixel($ix, $iy)
                            $lum = 0.299 * $pc.R + 0.587 * $pc.G + 0.114 * $pc.B
                            if ($lum -lt 110) { $dark++ }
                        }
                    }
                    $script:LastRegionInk = $dark
                }
            } finally { $c.Dispose() }
            # WXUIA_SHOT_DIR 打开时把区域截图也另存一份，方便实机校准区域坐标（排查“气泡未确认”用）。
            if ($script:ShotDir) {
                try {
                    $copy = Join-Path $script:ShotDir ("region-{0}-{1}.png" -f $Tag, (Get-Date).ToString('HHmmssfff'))
                    Copy-Item -LiteralPath $crop -Destination $copy -Force
                } catch {}
            }
            $lines = @(Get-OcrLines $crop ([double]$geo.scale))
            $ox = $x0 / [double]$geo.scale; $oy = $y0 / [double]$geo.scale
            foreach ($l in $lines) { $l.left += $ox; $l.right += $ox; $l.top += $oy; $l.bottom += $oy }
        } finally { $bmp.Dispose() }
    } finally {
        Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $crop -Force -ErrorAction SilentlyContinue
    }
    $inkCount = 0
    if ($Ink) { $inkCount = [int]$script:LastRegionInk }
    Write-Debug-Log ("REGION " + $Tag + " lines=" + $lines.Count + " ink=" + $inkCount)
    return @{ geo = $geo; lines = $lines; ink = $inkCount }
}

# ── OCR 行分类 / 过滤 ─────────────────────────────────────────────────────
# 时间戳、系统提示、纯标点等不应作为“对方消息”投递。

function Test-SystemLine([string]$Text) {
    # OCR 会在汉字间穿插空格、把冒号认成全角，先归一化再判断，否则「昨 天 22 ： 21」会漏网。
    $t = ($Text -replace "`r|`n", " ").Trim() -replace "\s+", "" -replace "：", ":"
    if ($t -eq '') { return $true }
    if ($t -match '^\d{1,2}:\d{2}$') { return $true }
    if ($t -match '^(上午|下午|中午|凌晨|晚上)\s*\d{1,2}:\d{2}$') { return $true }
    if ($t -match '^(昨天|今天|前天)\s*\d{1,2}:\d{2}$') { return $true }
    if ($t -match '^(昨天|今天|前天)$') { return $true }
    if ($t -match '^(星期|周)[一二三四五六日天]$') { return $true }
    if ($t -match '^\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}') { return $true }
    if ($t -match '^\d{1,2}月\d{1,2}日') { return $true }
    if ($t -match '^\d{1,2}/\d{1,2}$') { return $true }
    $systemWords = @('以下为新消息', '查看更多消息', '撤回了一条消息', '拍了拍', '消息已发出，但被对方拒收',
        '对方正在输入', '你已添加', '现在可以开始聊天', '以上是打招呼', '该消息类型暂不支持',
        '查看原图', '发送消息', '扫码登录', '文件传输助手', '网速较慢', '正在加载')
    foreach ($word in $systemWords) {
        if ($t.Contains($word)) { return $true }
    }
    # 纯标点/纯符号（含 OCR 噪点）：不算消息；单个汉字/字母/数字保留（“好”“嗯”是真实消息）。
    if ($t -match '^[\p{P}\p{S}\s]+$') { return $true }
    return $false
}

# 会话列表/搜索结果里匹配联系人名时用宽松过滤：只排除时间戳和明显系统行，不排除
# “文件传输助手”这类本身可能就是联系人名（或名字一部分）的词。

function Test-SystemLineLoose([string]$Text) {
    $t = $Text.Trim()
    if ($t -eq '') { return $true }
    if ($t -match '^\d{1,2}\s*[:：]\s*\d{2}$') { return $true }
    if ($t -match '^(上午|下午|中午|凌晨|晚上|昨天|今天|前天)\s*\d{1,2}\s*[:：]\s*\d{2}$') { return $true }
    if ($t -match '^(昨天|今天|前天|星期[一二三四五六日天]|周[一二三四五六日天])$') { return $true }
    if ($t -match '^\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}') { return $true }
    if ($t -match '^[\p{P}\p{S}\s]+$') { return $true }
    return $false
}

# 同一气泡内被 OCR 拆成多行时按“左对齐 + 行距小”合并；中文续行不加空格，英文单词间补空格。

function Merge-OcrLines($Lines) {
    $merged = New-Object System.Collections.Generic.List[object]
    foreach ($ln in $Lines) {
        $current = @{ text = [string]$ln.text; left = [double]$ln.left; right = [double]$ln.right; top = [double]$ln.top; bottom = [double]$ln.bottom }
        if ($merged.Count -gt 0) {
            $prev = $merged[$merged.Count - 1]
            $prevH = [math]::Max(4.0, [double]$prev.bottom - [double]$prev.top)
            $curH = [math]::Max(4.0, [double]$current.bottom - [double]$current.top)
            $avgH = ($prevH + $curH) / 2.0
            $gap = [double]$current.top - [double]$prev.bottom
            $leftDiff = [math]::Abs([double]$current.left - [double]$prev.left)
            if ($gap -le ([math]::Max(5.0, $avgH * 0.45)) -and $leftDiff -le 28.0) {
                $prevText = [string]$prev.text
                $curText = [string]$current.text
                $join = ''
                if ($prevText.Length -gt 0 -and $curText.Length -gt 0) {
                    if ((Char-IsAsciiWord $prevText[$prevText.Length - 1]) -and (Char-IsAsciiWord $curText[0])) { $join = ' ' }
                }
                $prev.text = $prevText + $join + $curText
                $prev.right = [math]::Max([double]$prev.right, [double]$current.right)
                $prev.bottom = [math]::Max([double]$prev.bottom, [double]$current.bottom)
                continue
            }
        }
        $merged.Add($current)
    }
    return $merged.ToArray()
}

# 从聊天面板提取“对方发来的消息”候选（右侧自己发的气泡按中心点过滤掉）。

function Get-InboundCandidates($Snapshot) {
    $lines = @($Snapshot.lines)
    $w = [double]$Snapshot.geo.width
    $h = [double]$Snapshot.geo.height
    $paneLeft = $w * $script:PaneLeftRatio
    $paneRight = $w * 0.995
    $paneTop = $h * 0.10
    $paneBottom = $h * 0.80
    $raw = @()
    foreach ($ln in $lines) {
        $x = [double]$ln.left
        $y = [double]$ln.top
        if ($x -lt $paneLeft -or $x -gt $paneRight) { continue }
        if ($y -lt $paneTop -or $y -gt $paneBottom) { continue }
        if (([double]$ln.right - $x) -lt 6) { continue }
        $text = Get-CleanText ([string]$ln.text)
        if (Test-SystemLine $text) { continue }
        # 自己的消息右对齐：气泡中心点明显偏右；对方气泡中心点在中线左侧。
        # 实测（1200 宽窗口）：对方长消息行中心 ≤0.60w，自己气泡行中心 ≥0.78w，中线取 0.65w 隔离。
        $centerX = ($x + [double]$ln.right) / 2.0
        if ($centerX -gt ($paneLeft + $paneRight) / 2.0) { continue }  # 右侧 = 自己发的，跳过
        $raw += @{ text = $text; left = $x; right = [double]$ln.right; top = $y; bottom = [double]$ln.bottom }
    }
    if ($raw.Count -eq 0) { return @() }
    $raw = @($raw | Sort-Object { $_.top })
    $merged = @(Merge-OcrLines $raw)
    return $merged
}

# ── 聊天窗口定位 ─────────────────────────────────────────────────────────
# 宽松标题判定：OCR 把「琦」认成「奇」这类形近字时，严格匹配会失败。
# 只在「刚用 Ctrl+F 精确搜索并回车」之后使用，作为确认，不作为找人依据。

function Test-IsTargetChatLoose($Snapshot, [string]$ContactName) {
    $n = Normalize-Text $ContactName
    if (-not $n) { return $false }
    $w = [double]$Snapshot.geo.width
    $h = [double]$Snapshot.geo.height
    foreach ($ln in @($Snapshot.lines)) {
        if ([double]$ln.left -lt ($w * 0.30)) { continue }
        if ([double]$ln.top -gt ($h * 0.13)) { continue }
        $t = Normalize-Text ([string]$ln.text)
        if (-not $t) { continue }
        if (Test-NameLike $t $ContactName) { return $true }
        # OCR 形近字容错：长度相同且只错 1 个字（如「张玮」vs「张伟」）也算命中。
        # 不再用「首字相同」兜底——曾把「张，伟」误认成「张磊」，导致读到了别人的聊天。
        if ($t.Length -eq $n.Length -and $t.Length -ge 2) {
            $diff = 0
            for ($ci = 0; $ci -lt $t.Length; $ci++) { if ($t[$ci] -ne $n[$ci]) { $diff++ } }
            if ($diff -le 1) { return $true }
        }
    }
    return $false
}

function Test-IsTargetChat($Snapshot, [string]$ContactName) {
    $needle = Normalize-Text $ContactName
    if (-not $needle) { return $false }
    $w = [double]$Snapshot.geo.width
    $h = [double]$Snapshot.geo.height
    foreach ($ln in @($Snapshot.lines)) {
        # 右侧聊天面板顶部标题栏区域（窗口内相对坐标）。标题行 x 会随分栏/DPI 漂移，
        # 用窗口宽度的 30% 作下限，避免 paneLeft 估偏时把标题也过滤掉。
        if ([double]$ln.left -lt ($w * 0.30)) { continue }
        if ([double]$ln.top -gt ($h * 0.13)) { continue }
        $t = Normalize-Text ([string]$ln.text)
        if (-not $t) { continue }
        $like = Test-NameLike $t $ContactName
        Write-Debug-Log ("TITLE? x=" + $ln.left + " y=" + $ln.top + " t=" + $t + " like=" + $like)
        if ($like) { return $true }
    }
    return $false
}

# 用左侧列表里该联系人的最新消息预览，交叉验证「当前打开的聊天」是不是他/她的：
# 列表预览通常就是聊天窗口里最近一条消息（两边 OCR 都可能出错，用字符覆盖匹配）。
# 标题栏 OCR 把「张伟」认成「张，伟」这类情况，标题判定会失败，此函数负责兜底。

function Test-ChatByListPreview($Snapshot, [string]$ContactName) {
    try {
        $rows = @(Get-ListRows $script:TargetHwnd @($ContactName))
        $row = $rows | Where-Object { $_.name -eq $ContactName } | Select-Object -First 1
        if (-not $row) { return $false }
        $pvRaw = Normalize-Text ([string]$row.preview)
        if ($pvRaw.Length -lt 2) { return $false }
        $head = $pvRaw.Substring(0, [math]::Min(10, $pvRaw.Length))
        $cands = @(Get-InboundCandidates $Snapshot)
        foreach ($c in $cands) {
            $ct = Normalize-Text ([string]$c.text)
            if ($ct.Length -lt 2) { continue }
            if ($ct.Contains($head)) {
                Write-Debug-Log ("列表预览交叉验证命中: " + $head)
                return $true
            }
            if (Test-NameLike $head $ct) {
                Write-Debug-Log ("列表预览交叉验证(形近字)命中: " + $head + " ~ " + $ct)
                return $true
            }
        }
    } catch { Write-Debug-Log ("列表预览交叉验证异常: " + $_.Exception.Message) }
    return $false
}

function Get-SearchBox($Snapshot) {
    $w = [double]$Snapshot.geo.width
    $h = [double]$Snapshot.geo.height
    $candidates = @()
    foreach ($ln in @($Snapshot.lines)) {
        if ([double]$ln.left -gt ($w * 0.55)) { continue }
        if ([double]$ln.top -gt ($h * 0.20)) { continue }
        $t = Normalize-Text ([string]$ln.text)
        if (-not $t) { continue }
        if ($t -match '^搜索' -or $t -eq '搜一搜' -or $t -match '^搜') {
            $candidates += $ln
        }
    }
    if ($candidates.Count -eq 0) { return $null }
    return ($candidates | Sort-Object { [double]$_.top } | Select-Object -First 1)
}

function Find-SearchHit($Snapshot, [string]$ContactName) {
    $needle = Normalize-Text $ContactName
    if (-not $needle) { return $null }
    $w = [double]$Snapshot.geo.width
    $h = [double]$Snapshot.geo.height
    $best = $null
    $bestTop = [double]::MaxValue
    $safe = $null
    $safeTop = [double]::MaxValue
    foreach ($ln in @($Snapshot.lines)) {
        if ([double]$ln.left -gt ($w * 0.45)) { continue }
        if ([double]$ln.top -lt ($h * 0.08) -or [double]$ln.top -gt ($h * 0.85)) { continue }
        $rawText = ([string]$ln.text).Trim()
        if (Test-SystemLineLoose $rawText) { continue }
        $t = Normalize-Text $rawText
        if (-not $t) { continue }
        if (-not (Test-NameLike $t $ContactName)) { continue }
        if ([double]$ln.top -lt $bestTop) { $bestTop = [double]$ln.top; $best = $ln }
        # 搜索框下方的“联系人/聊天记录”首屏结果优先；下方聊天记录命中时容易点进搜索详情页而不是聊天。
        if ([double]$ln.top -lt ($h * 0.42) -and [double]$ln.top -lt $safeTop) { $safeTop = [double]$ln.top; $safe = $ln }
    }
    if ($safe) { return $safe }
    return $best
}

function Find-SendButton($Snapshot) {
    $w = [double]$Snapshot.geo.width
    $h = [double]$Snapshot.geo.height
    $candidates = @()
    foreach ($ln in @($Snapshot.lines)) {
        if ([double]$ln.top -lt ($h * 0.60)) { continue }
        if ([double]$ln.left -lt ($w * 0.55)) { continue }
        $t = Normalize-Text ([string]$ln.text)
        if ($t -match '^发送') { $candidates += $ln }
    }
    if ($candidates.Count -eq 0) { return $null }
    return ($candidates | Sort-Object { [double]$_.top } | Select-Object -First 1)
}

# 发送后校验：聊天区（对方+自己区域）里必须能看到这段文字；长文本跨行时拼接后再比，
# OCR 形近字用“滑动窗口字符匹配率 >= 0.75”兜底。
# 发送校验兜底：OCR 对「自己发出的气泡」常丢字/形近，整句覆盖率可能不够。
# 这里比较发送前后的聊天区行集合，只要出现“新行”就认为气泡已发出（不要求字字匹配）。

function Test-NewBubble($BeforeSnapshot, $AfterSnapshot) {
    $before = @{}
    foreach ($ln in @($BeforeSnapshot.lines)) {
        $t = Normalize-Text ([string]$ln.text)
        if ($t) { $before[$t] = $true }
    }
    foreach ($ln in @($AfterSnapshot.lines)) {
        if ([double]$ln.left -lt ([double]$AfterSnapshot.geo.width * 0.30)) { continue }
        if ([double]$ln.top -gt ([double]$AfterSnapshot.geo.height * 0.80)) { continue }
        $t = Normalize-Text ([string]$ln.text)
        if (-not $t) { continue }
        if ($t.Length -lt 2) { continue }
        if (-not $before.ContainsKey($t)) { return $true }
    }
    return $false
}

# 取“输入框文字区”的 OCR 行（微信窗口底部输入框在整窗快照里约 y=0.77-0.90）。
# 发送判定用：键入后该区域应有文字；回车发送成功后微信会清空它。

function Get-InputAreaLines($Snapshot) {
    $h = [double]$Snapshot.geo.height
    if ($h -le 0) { return @() }
    # 只取输入框文字区（0.775-0.885），避开底部工具栏图标行：
    # 空输入框时工具栏图标会被 OCR 成「到 安 鼠 标 语 音 输 入」等文字，导致「输入框未清空」误判。
    $y0 = $h * 0.775
    $y1 = $h * 0.885
    $out = @()
    foreach ($ln in @($Snapshot.lines)) {
        $t = ([string]$ln.text).Trim()
        if ($t -eq '') { continue }
        if ([double]$ln.top -lt $y0 -or [double]$ln.top -gt $y1) { continue }
        # 空输入框会显示灰色占位提示「长按鼠标 语音输入」，OCR 会把它读成一行文字；
        # 这不是「输入框未清空」，必须排除，否则发送成功的兜底判定永远失败。
        $tn = ($t -replace '\s+', '')
        if ($tn -match '^(长按|按住).{0,3}(鼠标|说话|语音)|语音输入$|^长按鼠标') { continue }
        $out += $ln
    }
    return $out
}

function Test-TextInChat($Snapshot, [string]$NormalizedNeedle) {
    if (-not $NormalizedNeedle) { return $false }
    $w = [double]$Snapshot.geo.width
    $h = [double]$Snapshot.geo.height
    $paneLeft = $w * $script:PaneLeftRatio
    $top = $h * 0.10
    $bottom = $h * 0.80
    $texts = New-Object System.Collections.Generic.List[string]
    foreach ($ln in @($Snapshot.lines)) {
        if ([double]$ln.left -lt ($paneLeft - 8)) { continue }
        if ([double]$ln.top -lt $top -or [double]$ln.top -gt $bottom) { continue }
        $t = Normalize-Text ([string]$ln.text)
        if ($t) { $texts.Add($t) }
    }
    if ($texts.Count -eq 0) { return $false }
    foreach ($t in $texts) { if ($t.Contains($NormalizedNeedle)) { return $true } }
    $joined = [string]::Join('', $texts.ToArray())
    if ($joined.Contains($NormalizedNeedle)) { return $true }
    $checkLen = [math]::Min($NormalizedNeedle.Length, 12)
    if ($checkLen -lt 2) { return $false }
    # 形近字/漏字兜底：整句 OCR 常有少量错字，按“字符覆盖率”判断是不是同一句。
    $needleSet = New-Object 'System.Collections.Generic.HashSet[char]'
    foreach ($ch in $NormalizedNeedle.ToCharArray()) { [void]$needleSet.Add($ch) }
    $minLineLen = [math]::Max(4, [int]($NormalizedNeedle.Length * 0.5))
    foreach ($t in $texts) {
        if ($t.Length -lt $minLineLen) { continue }
        $cov = 0
        foreach ($ch in $t.ToCharArray()) { if ($needleSet.Contains($ch)) { $cov++ } }
        if (($cov / [double]$t.Length) -ge 0.6 -and ($cov / [double]$NormalizedNeedle.Length) -ge 0.5) { return $true }
    }
    $head = $NormalizedNeedle.Substring(0, $checkLen)
    foreach ($t in $texts) {
        $len = $t.Length
        if ($len -lt $checkLen) { continue }
        for ($i = 0; $i -le ($len - $checkLen); $i++) {
            $matched = 0
            for ($j = 0; $j -lt $checkLen; $j++) {
                if ($t[$i + $j] -eq $head[$j]) { $matched++ }
            }
            if (($matched / [double]$checkLen) -ge 0.75) { return $true }
        }
    }
    return $false
}

function Ensure-Foreground([IntPtr]$Hwnd) {
    if ([WXDriver]::GetForegroundWindow() -eq $Hwnd) { return }
    [WXDriver]::ForceForeground($Hwnd) | Out-Null
    $script:FocusStolen = $true
    Start-Sleep -Milliseconds 200
}

# 进入与 $Contact 的聊天窗口，返回 @{ geo; lines; exact; via }。
# exact=true 表示右侧标题栏 OCR 确认就是目标联系人；via 记录进入方式便于排障。

function Enter-Chat([IntPtr]$Hwnd) {
    $snap = Get-WindowSnapshot $Hwnd 'enter0'
    if (Test-IsTargetChat $snap $Contact) {
        Write-Debug-Log ("已在目标聊天: " + $Contact)
        return @{ geo = $snap.geo; lines = @($snap.lines); exact = $true; via = 'already' }
    }
    # 宽松匹配：OCR 形近字（「李四」→「张，伟」）导致严格匹配失败时，聊天其实已经打开，
    # 这里直接复用当前窗口，避免退到 Ctrl+F（用户会看到搜索框被反复输入）。
    if (Test-IsTargetChatLoose $snap $Contact) {
        Write-Debug-Log ("已在目标聊天(宽松匹配): " + $Contact)
        return @{ geo = $snap.geo; lines = @($snap.lines); exact = $false; via = 'already-loose' }
    }
    Ensure-Foreground $Hwnd
    $geo = $snap.geo
    # 0a) 主路径：Ctrl+F 聚焦搜索 → 清空 → 键入联系人 → 回车直达会话。
    #     微信 PC 的搜索框支持键盘操作，回车直接打开对应会话，不依赖坐标和标题容错。
    try {
        [WXDriver]::CtrlF()
        Start-Sleep -Milliseconds 280
        [WXDriver]::CtrlA()
        Start-Sleep -Milliseconds 60
        [WXDriver]::PressBackspace()
        Start-Sleep -Milliseconds 80
        [WXDriver]::TypeText($Contact)
        Start-Sleep -Milliseconds 750
        [WXDriver]::PressEnter()
        Start-Sleep -Milliseconds 950
        $snapF = Get-WindowSnapshot $Hwnd 'ctrl-f'
        if (Test-IsTargetChatLoose $snapF $Contact) {
            Write-Debug-Log ("Ctrl+F 直达会话: " + $Contact)
            return @{ geo = $snapF.geo; lines = @($snapF.lines); exact = $true; via = 'ctrl-f' }
        }
        if (Test-ChatByListPreview $snapF $Contact) {
            Write-Debug-Log ("Ctrl+F 直达会话(列表预览验证): " + $Contact)
            return @{ geo = $snapF.geo; lines = @($snapF.lines); exact = $true; via = 'ctrl-f-preview' }
        }
        [WXDriver]::PressEnter()
        Start-Sleep -Milliseconds 850
        $snapF2 = Get-WindowSnapshot $Hwnd 'ctrl-f2'
        if (Test-IsTargetChatLoose $snapF2 $Contact) {
            Write-Debug-Log ("Ctrl+F 直达会话(二次回车): " + $Contact)
            return @{ geo = $snapF2.geo; lines = @($snapF2.lines); exact = $true; via = 'ctrl-f2' }
        }
        if (Test-ChatByListPreview $snapF2 $Contact) {
            Write-Debug-Log ("Ctrl+F 直达会话(二次回车+列表预览验证): " + $Contact)
            return @{ geo = $snapF2.geo; lines = @($snapF2.lines); exact = $true; via = 'ctrl-f2-preview' }
        }
    } catch {
        Write-Debug-Log ('Ctrl+F 路径异常: ' + $_)
    }
    # 0b) 兜底：左侧会话列表里直接能看到目标联系人时点它。
    $geo0 = $snap.geo
    $needleList = Normalize-Text $Contact
    if ($needleList) {
        $candList = @(@($snap.lines) | Where-Object {
                ([double]$_.left -gt 8) -and ([double]$_.left -lt ([double]$geo0.width * 0.42)) -and
                ([double]$_.top -gt ([double]$geo0.height * 0.10)) -and ([double]$_.top -lt ([double]$geo0.height * 0.85)) -and
                (-not (Test-SystemLineLoose ([string]$_.text)))
            } | Where-Object {
                $tt = Normalize-Text ([string]$_.text)
                [bool](Test-NameLike $tt $Contact)
            } | Sort-Object { [double]$_.top })
        if ($candList.Count -gt 0) {
            $item = $candList[0]
            $lx = [int]($geo0.left + ([double]$item.left + [double]$item.right) / 2.0)
            $ly = [int]($geo0.top + ([double]$item.top + [double]$item.bottom) / 2.0)
            Write-Debug-Log ("点击会话列表联系人 " + $lx + "," + $ly + " text=" + $item.text)
            [WXDriver]::Click($lx, $ly)
            Start-Sleep -Milliseconds 700
            $snapList = Get-WindowSnapshot $Hwnd 'listdirect'
            if (Test-IsTargetChat $snapList $Contact) {
                return @{ geo = $snapList.geo; lines = @($snapList.lines); exact = $true; via = 'list-direct' }
            }
        }
    }
    # 1) 点顶部搜索框（OCR 找到“搜索”就用它，否则用左栏顶部的固定比例兜底位置）。
    $search = Get-SearchBox $snap
    if ($search) {
        $sx = [int]($geo.left + ([double]$search.left + [double]$search.right) / 2.0)
        $sy = [int]($geo.top + ([double]$search.top + [double]$search.bottom) / 2.0)
    } else {
        $sx = [int]($geo.left + $geo.width * 0.16)
        $sy = [int]($geo.top + $geo.height * 0.055)
    }
    Write-Debug-Log ("点击搜索框 " + $sx + "," + $sy)
    [WXDriver]::Click($sx, $sy)
    Start-Sleep -Milliseconds 260
    # 清空搜索框里可能残留的上一次输入（纯键盘 SelectAll + Backspace，不使用剪贴板）。
    [WXDriver]::CtrlA()
    Start-Sleep -Milliseconds 60
    [WXDriver]::PressBackspace()
    Start-Sleep -Milliseconds 120
    [WXDriver]::TypeText($Contact)
    Start-Sleep -Milliseconds 700
    $snap2 = Get-WindowSnapshot $Hwnd 'search'
    $hit = Find-SearchHit $snap2 $Contact
    if ($hit) {
        $cx = [int]($snap2.geo.left + ([double]$hit.left + [double]$hit.right) / 2.0)
        $cy = [int]($snap2.geo.top + ([double]$hit.top + [double]$hit.bottom) / 2.0)
        Write-Debug-Log ("点击搜索结果 " + $cx + "," + $cy)
        [WXDriver]::Click($cx, $cy)
        Start-Sleep -Milliseconds 700
        $snap3 = Get-WindowSnapshot $Hwnd 'chat'
        # 搜索结果行是 OCR 直接匹配到联系人名才点的，标题栏的形近字（如「琦/奇」）不再二次否决。
        return @{ geo = $snap3.geo; lines = @($snap3.lines); exact = $true; via = 'search' }
    }
    # 2) 兜底：回车选中搜索结果第一项。
    Write-Debug-Log '搜索结果未识别，尝试回车选中第一项'
    [WXDriver]::PressEnter()
    Start-Sleep -Milliseconds 700
    $snap4 = Get-WindowSnapshot $Hwnd 'enter'
    if (Test-IsTargetChat $snap4 $Contact) {
        return @{ geo = $snap4.geo; lines = @($snap4.lines); exact = $true; via = 'enter' }
    }
    # 3) 兜底：Esc 关掉搜索，点击左侧会话列表第一项。
    Write-Debug-Log '回车未确认目标聊天，回退点击会话列表首项'
    [WXDriver]::PressEsc()
    Start-Sleep -Milliseconds 350
    $snap5 = Get-WindowSnapshot $Hwnd 'list'
    $w = [double]$snap5.geo.width
    $h = [double]$snap5.geo.height
    $items = @(@($snap5.lines) | Where-Object {
        ([double]$_.left -lt ($w * 0.42)) -and
        ([double]$_.top -gt ($h * 0.10)) -and ([double]$_.top -lt ($h * 0.85)) -and
        (-not (Test-SystemLine ([string]$_.text)))
    } | Sort-Object { [double]$_.top })
    if ($items.Count -gt 0) {
        $it = $items[0]
        $ix = [int]($snap5.geo.left + ([double]$it.left + [double]$it.right) / 2.0)
        $iy = [int]($snap5.geo.top + ([double]$it.top + [double]$it.bottom) / 2.0)
        Write-Debug-Log ("点击会话列表首项 " + $ix + "," + $iy + " text=" + $it.text)
        [WXDriver]::Click($ix, $iy)
        Start-Sleep -Milliseconds 700
        $snap6 = Get-WindowSnapshot $Hwnd 'chat2'
        return @{ geo = $snap6.geo; lines = @($snap6.lines); exact = (Test-IsTargetChat $snap6 $Contact); via = 'list-first' }
    }
    return @{ geo = $snap5.geo; lines = @($snap5.lines); exact = $false; via = 'none' }
}

# ── 基线状态（去重） ─────────────────────────────────────────────────────

function Read-State {
    try {
        if (Test-Path -LiteralPath $script:StatePath) {
            $raw = [System.IO.File]::ReadAllText($script:StatePath, (New-Object System.Text.UTF8Encoding($false)))
            if ([string]::IsNullOrWhiteSpace($raw)) { return [pscustomobject]@{} }
            return ($raw | ConvertFrom-Json)
        }
    } catch {}
    return [pscustomobject]@{}
}

function Save-State($Object) {
    try {
        $dir = Split-Path $script:StatePath -Parent
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $json = $Object | ConvertTo-Json -Depth 8 -Compress
        [System.IO.File]::WriteAllText($script:StatePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        Write-Debug-Log ("保存基线失败: " + $_.Exception.Message)
    }
}

function Save-Baseline([string]$ContactKey, [string[]]$Texts) {
    $state = Read-State
    $entry = [pscustomobject]@{ texts = @($Texts); updatedAt = (Now-Id) }
    $state | Add-Member -NotePropertyName $ContactKey -NotePropertyValue $entry -Force
    Save-State $state
}

# 发送后等 OCR 看到气泡：最多轮询到超时（单次截图约 0.3-1s）。

function Wait-TextVisible([IntPtr]$Hwnd, [string]$Text, [int]$TimeoutMs) {
    $needle = Normalize-Text $Text
    if (-not $needle) { return $false }
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ($true) {
        $snap = Get-WindowSnapshot $Hwnd 'verify'
        if (Test-TextInChat $snap $needle) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 300
    }
}


# ── 未读检测：在头像/红点区域找微信红 ──────────────────────────────────

function Test-RedBadge($Bmp, [double]$Scale, [double]$X0, [double]$Y0, [double]$X1, [double]$Y1) {
    try {
        $sx0 = [int]([math]::Max(0, $X0 * $Scale)); $sy0 = [int]([math]::Max(0, $Y0 * $Scale))
        $sx1 = [int]([math]::Min($Bmp.Width - 1, $X1 * $Scale)); $sy1 = [int]([math]::Min($Bmp.Height - 1, $Y1 * $Scale))
    } catch { return $false }
    $count = 0
    for ($y = $sy0; $y -le $sy1; $y++) {
        for ($x = $sx0; $x -le $sx1; $x++) {
            $c = $Bmp.GetPixel($x, $y)
            if ($c.R -ge 185 -and $c.G -le 120 -and $c.B -le 120 -and ($c.R - $c.G) -ge 60 -and ($c.R - $c.B) -ge 60) {
                $count++
                if ($count -ge 12) { return $true }
            }
        }
    }
    return $false
}

# 一次截图 + OCR，返回白名单联系人在会话列表里的行（未读红点、最新消息预览）。

function Get-RowNameBandText($Bmp, $RowDef, [double]$Scale, [double]$ListReal) {
    # 单行「名字条」OCR：整栏一次 OCR 会把「张三」认成「张，三」这类乱码；
    # 按行裁出名字区域（含整行高度）再 OCR，NearestNeighbor 3x 下命中率明显更高。
    try {
        $ny0 = [int][math]::Max(0, ($RowDef.anchor - 30) * $Scale)
        $ny1 = [int][math]::Min($Bmp.Height - 1, ($RowDef.anchor + 30) * $Scale)
        $nx0 = [int][math]::Max(0, (0.35 * $ListReal) * $Scale)
        $nx1 = [int][math]::Min($Bmp.Width - 1, (0.96 * $ListReal) * $Scale)
        if (($ny1 - $ny0) -lt 12 -or ($nx1 - $nx0) -lt 40) { return '' }
        $rect = New-Object System.Drawing.Rectangle($nx0, $ny0, ($nx1 - $nx0), ($ny1 - $ny0))
        $nb = $Bmp.Clone($rect, $Bmp.PixelFormat)
        $path = Join-Path $env:TEMP ("wxuia-rowname-{0}.png" -f [Guid]::NewGuid().ToString('N'))
        try { $nb.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $nb.Dispose() }
        $lines = @(Get-OcrLines $path $Scale)
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        $timeRe = '^(\d{1,2}[:：]\d{2}|昨天|星期|上午|下午|晚上|前天|凌晨)'
        foreach ($cand in ($lines | Sort-Object { [double]$_.top })) {
            $ct = (([string]$cand.text) -replace '\s+', '')
            if ($ct.Length -lt 2) { continue }
            if ($ct -match $timeRe) { continue }
            if ($ct -match '^[0-9Oo]+$') { continue }
            return $ct
        }
    } catch { }
    return ''
}

function Get-ListRows([IntPtr]$Hwnd, [string[]]$Names) {
    $png = Join-Path $env:TEMP ("wxuia-list-{0}.png" -f [Guid]::NewGuid().ToString('N'))
    $rows = @()
    $bmp = $null
    $prevUpscale = $script:Upscale
    try {
        # 列表 OCR 用 4x 最近邻：3x 下「张三→张，三」「李四→张，伟」这类乱码明显更多（实机对比 4x 命中率更高）。
        $script:Upscale = [math]::Max([int]$script:Upscale, 4)
        $lines = @()
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            if ($bmp) { $bmp.Dispose(); $bmp = $null }
            Start-Sleep -Milliseconds 250
            $geo = Get-WindowShot $Hwnd $png
            $bmp = [System.Drawing.Bitmap]::FromFile($png)
            $cropPath = Join-Path $env:TEMP ("wxuia-list-{0}.png" -f [Guid]::NewGuid().ToString('N'))
            try {
                $realW = [double]$bmp.Width / [double]$geo.scale; $listReal = [math]::Min(420.0, $realW * 0.36); $cw = [math]::Max(1, [int]($listReal * [double]$geo.scale)); $chh = [int]($bmp.Height * 0.80)
                $cropRect = New-Object System.Drawing.Rectangle(0, 0, [Math]::Max(1, $cw), [Math]::Max(1, $chh))
                $cropBmp = $bmp.Clone($cropRect, $bmp.PixelFormat)
                try { $cropBmp.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $cropBmp.Dispose() }
                $lines = @(Get-OcrLines $cropPath ([double]$geo.scale))
            } finally { }
            if ($script:ShotDir) { try { Copy-Item -LiteralPath $cropPath -Destination (Join-Path $script:ShotDir ('list-{0}.png' -f (Get-Date).ToString('HHmmssfff'))) -Force -ErrorAction SilentlyContinue } catch {} }
            Write-Debug-Log ("LISTTRY attempt=" + $attempt + " lines=" + $lines.Count + " geo=" + $geo.width + "x" + $geo.height)
            if ($lines.Count -gt 0) { break }
        }
        $w = [double]$geo.width; $h = [double]$geo.height
        $scale = [double]$geo.scale
        $listReal = [math]::Min(420.0, $w * 0.36)
        $left = @($lines | Where-Object {
            ([double]$_.left -gt 2) -and ([double]$_.left -lt $listReal) -and
            ([double]$_.top -gt ($h * 0.045)) -and ([double]$_.top -lt ($h * 0.92))
        } | Sort-Object { [double]$_.top })
        $timeRe = '^(\d{1,2}[:：]\d{2}|昨天|星期|上午|下午|晚上|前天|凌晨)'
        $isTime = { param($t) (([string]$t) -replace '\s+', '') -match $timeRe }
        $pitch = [math]::Max(48.0, $h * 0.098)
        # 选中行绿底：直接读截图位图（微信被遮挡也准，不依赖屏幕截图/前台）。
        $greenTop = -1.0; $greenBottom = -1.0
        try {
            $xs = @(); foreach ($rx in 0.58, 0.66, 0.74, 0.82) { $xs += [int][math]::Min($bmp.Width - 1, [math]::Max(8, ($listReal * $rx) * $scale)) }
            $runStart = -1
            for ($py = 0; $py -lt $bmp.Height; $py++) {
                $hits = 0
                foreach ($sx in $xs) {
                    $c = $bmp.GetPixel($sx, $py)
                    if ($c.G -ge 120 -and $c.G -gt ($c.R + 30) -and $c.G -gt ($c.B + 15)) { $hits++ }
                }
                $isG = ($hits -ge 2)
                if ($isG -and $runStart -lt 0) { $runStart = $py }
                elseif (-not $isG -and $runStart -ge 0) {
                    $gh = ($py - $runStart) / $scale
                    if ($gh -ge 40 -and $gh -le ($pitch * 2.2)) { $greenTop = $runStart / $scale; $greenBottom = $py / $scale }
                    $runStart = -1
                }
            }
            if ($runStart -ge 0) {
                $gh = ($bmp.Height - $runStart) / $scale
                if ($gh -ge 40 -and $gh -le ($pitch * 2.2)) { $greenTop = $runStart / $scale; $greenBottom = $bmp.Height / $scale }
            }
        } catch {}
        # 行锚点：优先「绿底选中行 + 固定行距」推算（时间戳/名字 OCR 失败不影响行定位）；拿不到绿底再退回时间戳。
        $anchors = @()
        if ($greenTop -ge 0 -and ($greenBottom - $greenTop) -ge 40) {
            $pitch = ($greenBottom - $greenTop)
            $base = $greenTop
            while (($base - $pitch) -ge ($h * 0.04)) { $base -= $pitch }
            for ($ay = $base; $ay -le ($h * 0.90); $ay += $pitch) { $anchors += [math]::Round($ay + ($pitch * 0.28), 1) }
            Write-Debug-Log ("LIST 绿底锚点 green=" + [int]$greenTop + "-" + [int]$greenBottom + " pitch=" + [int]$pitch + " rows=" + $anchors.Count)
        } else {
            $times = @($left | Where-Object { & $isTime $_.text })
            foreach ($t in $times) {
                $ty = [double]$t.top
                if ($anchors.Count -gt 0 -and [math]::Abs($ty - $anchors[$anchors.Count - 1]) -lt 14) { continue }
                $anchors += $ty
            }
            if ($anchors.Count -eq 0) { $anchors = @($left | ForEach-Object { [double]$_.top }) }
            if ($anchors.Count -ge 2) {
                $gaps = @()
                for ($i = 1; $i -lt $anchors.Count; $i++) {
                    $gp = $anchors[$i] - $anchors[$i - 1]
                    if ($gp -gt 40 -and $gp -lt 160) { $gaps += $gp }
                }
                if ($gaps.Count -ge 2) { $gaps = @($gaps | Sort-Object); $pitch = [double]$gaps[[int][math]::Floor(($gaps.Count - 1) / 2)] }
            }
        }
        # 逐行取名字行/预览行/选中态。
        $rowDefs = @()
        foreach ($ay in $anchors) {
            $nameLine = $left | Where-Object {
                ([double]$_.top -ge ($ay - 20)) -and ([double]$_.top -le ($ay + 6)) -and
                (-not (& $isTime $_.text)) -and
                ((([string]$_.text) -replace '\s+', '').Length -ge 2) -and
                ((([string]$_.text) -replace '\s+', '') -notmatch '^[0-9Oo]+$')
            } | Sort-Object { [math]::Abs([double]$_.top - $ay) } | Select-Object -First 1
            $previewLine = $left | Where-Object {
                ([double]$_.top -gt ($ay + 8)) -and ([double]$_.top -lt ($ay + $pitch - 4)) -and
                (-not (& $isTime $_.text)) -and
                ((([string]$_.text) -replace '\s+', '').Length -ge 2)
            } | Sort-Object { [double]$_.top } | Select-Object -First 1
            $rowDefs += [pscustomobject]@{
                anchor = $ay; nameLine = $nameLine; previewLine = $previewLine
                selected = ($greenTop -ge 0 -and $ay -ge $greenTop -and $ay -le $greenBottom)
            }
        }
        # 整栏 OCR 偶尔整行漏掉名字（头像/彩色底干扰），对缺名字的非选中行单独裁「名字条」再 OCR 一次。
        foreach ($rd in $rowDefs) {
            if ($rd.nameLine) { continue }
            if ($rd.selected) { continue }
            try {
                $ny0 = [int][math]::Max(0, ($rd.anchor - 26) * $scale)
                $ny1 = [int][math]::Min($bmp.Height - 1, ($rd.anchor + 30) * $scale)
                $nx0 = [int][math]::Max(0, (0.35 * $listReal) * $scale)
                $nx1 = [int][math]::Min($bmp.Width - 1, (0.96 * $listReal) * $scale)
                if (($ny1 - $ny0) -lt 12 -or ($nx1 - $nx0) -lt 40) { continue }
                $nameRect = New-Object System.Drawing.Rectangle($nx0, $ny0, ($nx1 - $nx0), ($ny1 - $ny0))
                $nameBmp = $bmp.Clone($nameRect, $bmp.PixelFormat)
                $namePath = Join-Path $env:TEMP ("wxuia-name-{0}.png" -f [Guid]::NewGuid().ToString('N'))
                try { $nameBmp.Save($namePath, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $nameBmp.Dispose() }
                try {
                    $nl = @(Get-OcrLines $namePath $scale)
                    $pick = $null
                    foreach ($cand in ($nl | Sort-Object { [double]$_.top })) {
                        $ct = (([string]$cand.text) -replace '\s+', '')
                        if ($ct.Length -lt 2) { continue }
                        if (& $isTime $cand.text) { continue }
                        if ($ct -match '^[0-9Oo]+$') { continue }
                        $pick = $cand
                        break
                    }
                    if ($pick) {
                        $pick.left += ($nx0 / $scale); $pick.top += ($ny0 / $scale)
                        $rd.nameLine = $pick
                        Write-Debug-Log ("LIST 名字条 OCR anchor=" + [int]$rd.anchor + " text=" + (([string]$pick.text) -replace '\s+', ''))
                    }
                } finally { Remove-Item -LiteralPath $namePath -Force -ErrorAction SilentlyContinue }
            } catch { Write-Debug-Log ("LIST 名字条 OCR 失败: " + $_.Exception.Message) }
        }
        # 选中行是绿底白字，名字 OCR 常整行漏掉；用标题栏 OCR + CurrentContact 交叉验证后认领。
        foreach ($rd in $rowDefs) {
            if ($rd.nameLine -or (-not $rd.selected)) { continue }
            if ([string]::IsNullOrWhiteSpace($CurrentContact)) { continue }
            try {
                $titleSnap = Get-RegionSnapshot $hwnd 'list-title' 0.30 0.02 0.72 0.13
                if (Test-IsTargetChatLoose $titleSnap $CurrentContact) {
                    $rd.nameLine = [pscustomobject]@{ text = $CurrentContact; left = 150.0; top = $rd.anchor; right = 240.0; bottom = ($rd.anchor + 10) }
                    Write-Debug-Log ("绿底行用标题认领: " + $CurrentContact + " anchor=" + [int]$rd.anchor)
                }
            } catch { Write-Debug-Log ("绿底行标题认领失败: " + $_.Exception.Message) }
        }
        # 名字行 -> 联系人匹配（每个行锚点只认领一次，避免两个联系人抢同一行）。
        $usedAnchors = @{}
        foreach ($name in $Names) {
            $n1 = (Normalize-Text $name) -replace '[^\u4e00-\u9fa5A-Za-z0-9]', ''
            $bestRd = $null; $bestScore = -1000.0
            foreach ($rd in $rowDefs) {
                if (-not $rd.nameLine) { continue }
                if ($usedAnchors.ContainsKey([int]$rd.anchor)) { continue }
                $tt = (Normalize-Text ([string]$rd.nameLine.text)) -replace '[^\u4e00-\u9fa5A-Za-z0-9]', ''
                $score = -1000.0
                # 用 Test-NameLike 的形近字/覆盖率匹配（OCR 会把「文件传输助手」认成「刘牛传输助手」）；
                # 不再用「首字相同」兜底，避免把 李四 的行错认成 张三（曾导致预览错位）。
                if (Test-NameLike ([string]$rd.nameLine.text) $name) { $score = 60.0 - ([math]::Abs($tt.Length - $n1.Length) * 2.0) }
                if ($score -gt $bestScore) { $bestScore = $score; $bestRd = $rd }
            }
            if (-not $bestRd -or $bestScore -lt 10) {
                $rows += @{ name = $name; found = $false; unread = $false; preview = ''; selected = $false }
                continue
            }
            $usedAnchors[[int]$bestRd.anchor] = $true
            $nx = [double]$bestRd.nameLine.left
            $ny = [double]$bestRd.anchor
            $rt = [int][math]::Max(0, $ny - 26)
            $unread = Test-RedBadge $bmp $scale ([math]::Max(0, $nx - 62)) ([math]::Max(0, $rt + 6)) ([math]::Max(0, $nx - 14)) ($rt + 28)
            $preview = ''
            if ($bestRd.previewLine) { $preview = (([string]$bestRd.previewLine.text) -replace '\s+', '').Trim() }
            $rows += @{ name = $name; found = $true; unread = [bool]$unread; preview = $preview; top = $rt; left = [int]$nx; height = [int][math]::Round($pitch); selected = [bool]$bestRd.selected }
        }
        # 二遍：整栏 OCR 把名字认成乱码（如 张三→张，三）时，按行单独裁名字条重识别后再匹配。
        $failedRows = @($rows | Where-Object { -not $_.found })
        if ($failedRows.Count -gt 0) {
            $bandCache = @{}
            $bandLogged = @{}
            foreach ($fr in $failedRows) {
                $fn = [string]$fr.name
                $fnn = (Normalize-Text $fn) -replace '[^\u4e00-\u9fa5A-Za-z0-9]', ''
                $bestRd = $null; $bestScore = -1000.0
                foreach ($rd in $rowDefs) {
                    if ($usedAnchors.ContainsKey([int]$rd.anchor)) { continue }
                    $akey = [int]$rd.anchor
                    if (-not $bandCache.ContainsKey($akey)) {
                        $bandCache[$akey] = Get-RowNameBandText $bmp $rd $scale $listReal
                    }
                    $bt = [string]$bandCache[$akey]
                    if (-not $bandLogged.ContainsKey($akey)) {
                        $bandLogged[$akey] = $true
                        Write-Debug-Log ("LIST 二遍名字条 anchor=" + $akey + " text=" + $bt)
                    }
                    if ([string]::IsNullOrWhiteSpace($bt)) { continue }
                    if (-not (Test-NameLike $bt $fn)) { continue }
                    $btc = (Normalize-Text $bt) -replace '[^\u4e00-\u9fa5A-Za-z0-9]', ''
                    $score = 60.0 - ([math]::Abs($btc.Length - $fnn.Length) * 2.0)
                    if ($score -gt $bestScore) { $bestScore = $score; $bestRd = $rd }
                }
                if (-not $bestRd) {
                    Write-Debug-Log ("LIST 二遍名字条未匹配: " + $fn)
                    continue
                }
                $usedAnchors[[int]$bestRd.anchor] = $true
                $newRow = @{
                    name = $fn; found = $true; unread = $false; preview = ''
                    top = [int][math]::Max(0, ($bestRd.anchor - 26)); left = [int](0.35 * $listReal); height = [int][math]::Round($pitch)
                    selected = [bool]$bestRd.selected
                }
                if ($bestRd.previewLine) { $newRow.preview = (([string]$bestRd.previewLine.text) -replace '\s+', '').Trim() }
                for ($i = 0; $i -lt $rows.Count; $i++) {
                    if ([string]$rows[$i].name -eq $fn -and (-not $rows[$i].found)) { $rows[$i] = $newRow; break }
                }
                Write-Debug-Log ("LIST 二遍名字条匹配: " + $fn + " band=" + $bandCache[[int]$bestRd.anchor] + " anchor=" + [int]$bestRd.anchor)
            }
        }
    } finally {
        $script:Upscale = $prevUpscale
        if ($bmp) { try { $bmp.Dispose() } catch {} }
        Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
    }
    Write-Debug-Log ("LINES " + (($left | ForEach-Object { [string]$_.text + "@" + [int]$_.left + "," + [int]$_.top }) -join "|"))
    # 预览变化兜底：红点可能因窗口焦点/已读过而消失，用每行预览文本变化触发一次读取。
    $pvFile = Join-Path (Split-Path $script:StatePath) "list-preview.json"
    $prevMap = @{}
    if (Test-Path -LiteralPath $pvFile) { try { $prevMap = Get-Content -LiteralPath $pvFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $prevMap = @{} } }
    $newMap = @{}
    foreach ($r in $rows) {
        if (-not $r.found) { continue }
        $pv = [string]$r.preview
        $newMap[$r.name] = $pv
        if ($pv) {
            $oldPv = [string](@($prevMap.PSObject.Properties) | Where-Object { $_.Name -eq $r.name } | ForEach-Object { $_.Value } | Select-Object -First 1)
            if ($oldPv -and $oldPv -ne $pv) { $r.unread = $true }
        }
    }
    try { $newMap | ConvertTo-Json -Compress | Set-Content -LiteralPath $pvFile -Encoding UTF8 } catch {}

    Write-Debug-Log ("LIST " + ($rows | ConvertTo-Json -Compress -Depth 4))
    return $rows
}


# ══ 主流程 ═══════════════════════════════════════════════════════════════
$hwnd = [IntPtr]::Zero
function Ensure-UsableWindow([IntPtr]$H) {
  try {
    $rect = New-Object WXDriver+RECT
    [void][WXDriver]::GetWindowRect($H, [ref]$rect)
    $ww = [int]($rect.Right) - [int]($rect.Left)
    $hh = [int]($rect.Bottom) - [int]($rect.Top)
    $iconic = [bool][WXDriver]::IsIconic($H)
    if ($iconic -or ($ww -lt 700) -or ($hh -lt 400)) {
      Write-Debug-Log ("窗口不可用 {0}x{1} iconic={2}，强制恢复并调整大小" -f $ww, $hh, $iconic)
      [void][WXDriver]::ShowWindow($H, 9)
      [void][WXDriver]::MoveWindow($H, 100, 80, 1200, 830, $true)
      Start-Sleep -Milliseconds 700
      [void][WXDriver]::ForceForeground($H)
    }
  } catch {
    Write-Debug-Log ("窗口校验跳过: " + $_.Exception.Message)
  }
}
$wasMin = $false
$prevFg = [IntPtr]::Zero
$prevCursor = New-Object 'WXDriver+POINT'
$cursorSaved = $false

try {
    [WXDriver]::SetProcessDPIAware() | Out-Null

    if ($Action -eq 'read' -and [string]::IsNullOrWhiteSpace($Contact)) { Fail-With 'read 缺少 -Contact' }
    if ($Action -eq 'send' -and [string]::IsNullOrWhiteSpace($Contact)) { Fail-With 'send 缺少 -Contact' }

    # 可选的脚本级工作时段闸门（默认不限制，在线时段由插件 schedule 管理）。
    if (-not (Test-AllowedHours)) {
        $hours = [Environment]::GetEnvironmentVariable('WXUIA_ACTIVE_HOURS')
        if ($Action -eq 'send') { Fail-With "当前不在 WXUIA_ACTIVE_HOURS 允许的时段（$hours）内，放弃发送" }
        if ($Action -eq 'list') { Write-Result @{ ok = $true; rows = @() }; exit 0 }
        Write-Result @{ ok = $true; messages = @() }
        exit 0
    }

    # 键鼠空闲闸门：用户正在用电脑时绝不操作微信（send 明确失败，不再假成功）。
    # send 动作不被脚本级空闲门槛拦截（通道层负责判断是否在回复新消息；脚本自身的键鼠会把 idle 清零）。
    if (-not $script:Force -and $Action -ne 'send' -and $Action -ne 'list') {
        $idle = [WXDriver]::IdleMs()
        if ($idle -lt $script:IdleThresholdMs) {
            Write-Debug-Log ("用户键鼠活跃 idle=" + $idle + "ms < " + $script:IdleThresholdMs + "ms")
            if ($Action -eq 'send') { Fail-With "用户正在使用电脑（idle=${idle}ms < $($script:IdleThresholdMs)ms），放弃发送以避免抢鼠标键盘" }
            Write-Result @{ ok = $true; messages = @() }
            exit 0
        }
    }

    # 找窗口：先在可见窗口里精确匹配；找不到再允许恢复最小化窗口。
    $hwnd = [WXDriver]::FindWindowByTitle($WindowTitle)
    if ($hwnd -eq [IntPtr]::Zero) {
        $hwnd = [WXDriver]::FindWindowAnyState($WindowTitle)
if ($hwnd -ne [IntPtr]::Zero) { Ensure-UsableWindow $hwnd }
        if ($hwnd -ne [IntPtr]::Zero) {
            [WXDriver]::ShowWindow($hwnd, 9) | Out-Null
            Start-Sleep -Milliseconds 700
            $wasMin = $false
        }
    }
    if ($hwnd -eq [IntPtr]::Zero) {
        Fail-With "未找到微信窗口（WindowTitle=$WindowTitle）。请确认微信已登录、窗口标题匹配，或调整 channels.desktop.windowTitle"
    }
    $script:TargetHwnd = $hwnd
    try { Ensure-UsableWindow $hwnd } catch { }
    $wasMin = $false
    # 窗口被拖窄时左侧会话列表会消失：自动最大化，保证 list/read/send 的分栏稳定。
    $wr = New-Object 'WXDriver+RECT'
    [WXDriver]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
    $ww = $wr.Right - $wr.Left
    $wh = $wr.Bottom - $wr.Top
    if ($ww -lt 900 -or $ww -gt 2200 -or $wh -gt 1400) {
        [void][WXDriver]::MoveWindow($hwnd, 100, 80, 1200, 830, $true)
        Start-Sleep -Milliseconds 700
    }
    # 微信常被收进托盘/藏在别的窗口后面：隐藏时先显示，隐藏或后台时都必须切到前台，
    # 否则 OCR 的 PrintWindow 拿到的是旧画面、鼠标点击也会落到别的窗口上（之前就是这个问题）。
    for ($vi = 0; $vi -lt 3; $vi++) {
        if ([WXDriver]::IsWindowVisible($hwnd)) { break }
        [WXDriver]::ShowWindow($hwnd, 9) | Out-Null
        $wasMin = $false
        Start-Sleep -Milliseconds 350
        if ([WXDriver]::IsWindowVisible($hwnd)) { break }
        [WXDriver]::ShowWindow($hwnd, 5) | Out-Null
        Start-Sleep -Milliseconds 350
    }
    if (-not [WXDriver]::IsWindowVisible($hwnd)) { Write-Debug-Log '微信窗口仍不可见（可能被收进托盘）' }
    [WXDriver]::SetWindowPos($hwnd, [WXDriver]::HWND_TOPMOST, 0, 0, 0, 0, [WXDriver]::SWP_NOMOVE -bor [WXDriver]::SWP_NOSIZE -bor [WXDriver]::SWP_NOACTIVATE) | Out-Null
    $script:WasTopmost = $true
    Start-Sleep -Milliseconds 180
    [WXDriver]::ForceForeground($hwnd) | Out-Null
    Start-Sleep -Milliseconds 320
    $prevFg = [WXDriver]::GetForegroundWindow()
    try {
        [WXDriver]::GetCursorPos([ref]$prevCursor) | Out-Null
        $cursorSaved = $true
    } catch {}

    # ── list：一次截图拿到白名单联系人的会话行+未读红点（不打开聊天） ──
    if ($Action -eq 'list') {
        $names = @()
        if (-not [string]::IsNullOrWhiteSpace($Contacts)) {
            $names = @($Contacts -split '[,，]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        }
        if ($names.Count -eq 0) { Write-Result @{ ok = $true; rows = @() }; exit 0 }
        $rows = @(Get-ListRows $hwnd $names)
        Write-Result @{ ok = $true; rows = @($rows) }
        exit 0
    }

    # ── 快发送（v4.2）：点会话行 → 整窗快照校验标题 → 输入 → 回车 → 区域快照校验气泡 ──
    $fastDone = $false
    Write-Debug-Log ("FASTCHECK action=" + $Action + " rowTop=" + $RowTop + " cur=" + $CurrentContact + " env=" + $env:WXUIA_FAST_ROW)
    if ($Action -eq 'send') {
        # 硬门：必须确认微信真的在前台，否则截图/点击都会落到别的窗口（曾拍到 DSH 界面）。
        if (-not [WXDriver]::ForceForeground($hwnd)) {
            Write-Debug-Log '微信窗口无法置于前台，取消发送'
            Write-Result @{ ok = $false; error = '无法将微信窗口置于前台（被其他窗口抢占），已取消发送以避免发错窗口' }
            exit 0
        }
        $fr = New-Object WXDriver+RECT
        [WXDriver]::GetWindowRect($hwnd, [ref]$fr) | Out-Null
        $fw = [double]($fr.Right - $fr.Left); $fh = [double]($fr.Bottom - $fr.Top)
        $trustedOpen = ([int]$RowTop -le 0 -and $CurrentContact -ne '' -and ((Normalize-Text $CurrentContact) -eq (Normalize-Text $Contact)))
        if (-not $trustedOpen -and [int]$RowTop -le 0) {
            Write-Debug-Log '快发送缺少聊天定位信息，拒绝发送（不回退保守路径）'
            Write-Result @{ ok = $false; error = '缺少聊天定位信息（既不是当前会话也没有行坐标），已拒绝发送以避免发错人' }
            exit 0
        }
        if ($trustedOpen) {
            Write-Debug-Log '快发送信任已打开聊天（引擎 lastActiveContact），跳过标题OCR'
            $titleHit = $true
        } else {
        Ensure-Foreground $hwnd
        $fastChat = Get-RegionSnapshot $hwnd 'fast-title0' 0.30 0.02 0.72 0.13
        $titleHit = Test-IsTargetChatLoose $fastChat $Contact
        if (-not $titleHit -and [int]$RowTop -gt 0) {
            $rowH = if ($RowHeight -gt 0) { [int]$RowHeight } else { [int]($fh * 0.06) }
            $clickX = if ([int]$RowLeft -gt 0) { [int]($fr.Left + $RowLeft + 24) } else { [int]($fr.Left + $fw * 0.10) }
            $clickY = [int]($fr.Top + $RowTop + $rowH / 2)
            Write-Debug-Log ("快发送点击会话行 " + $clickX + "," + $clickY + " rowTop=" + $RowTop)
            [WXDriver]::Click($clickX, $clickY)
            Start-Sleep -Milliseconds 320
            $selX = [int]($clickX + 40)
            if (Test-GreenSelection $selX $clickY) {
                Write-Debug-Log '快发送行选中（绿色底）校验通过'
                $titleHit = $true
            } else {
                $fastChat = Get-RegionSnapshot $hwnd 'fast-title' 0.30 0.02 0.72 0.13
                if (@($fastChat.lines).Count -eq 0) {
                    Start-Sleep -Milliseconds 300
                    $fastChat = Get-RegionSnapshot $hwnd 'fast-title' 0.30 0.02 0.72 0.13
                }
                $titleHit = Test-IsTargetChatLoose $fastChat $Contact
            }
        }
        }
        if ($titleHit) {
            # 测试用开关（正常部署不设；供 QA 验证“输入框已清空”兜底判定的正/负路径）：
            #   WXUIA_FORCE_BUBBLE_FAIL=1 强制气泡校验失败，直接走兜底判定
            #   WXUIA_SKIP_ENTER=1        不回回车，验证兜底判定在输入框未清空时不会误报成功
            $forceBubbleFail = ($env:WXUIA_FORCE_BUBBLE_FAIL -eq '1')
            $skipEnter = ($env:WXUIA_SKIP_ENTER -eq '1')
            if (-not $TextBase64) { Fail-With '缺少 -TextBase64' }
            $ftext = ''
            try { $ftext = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($TextBase64)) } catch { Fail-With 'TextBase64 不是合法的 Base64' }
            if ([string]::IsNullOrWhiteSpace($ftext)) { Fail-With '发送文本为空' }
            # 2x 下输入框小字 OCR 不稳（短文本常整行读不出），发送判定相关快照临时用 3x。
            $script:Upscale = [math]::Max([int]$script:Upscale, 3)
            $preRegion = Get-RegionSnapshot $hwnd 'fast-pre' 0.28 0.70 0.99 0.99
            [WXDriver]::Click([int]($fr.Left + $fw * 0.70), [int]($fr.Top + $fh * 0.885))
            Start-Sleep -Milliseconds 150
            [WXDriver]::CtrlA()
            Start-Sleep -Milliseconds 40
            [WXDriver]::PressBackspace()
            Start-Sleep -Milliseconds 50
            # 微信输入框对逐字符 Unicode 注入不可靠（标点后第一个字会丢、标点会重复）。
            # 改用剪贴板粘贴：整段一次粘贴，落字完整；结束后恢复原剪贴板文本。
            $clipBackup = $null
            try { $clipBackup = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { }
            $pasted = $false
            try {
                Set-Clipboard -Value $ftext
                Start-Sleep -Milliseconds 80
                [WXDriver]::CtrlV()
                Start-Sleep -Milliseconds 260
                $pasted = $true
            } catch {
                Write-Debug-Log ('剪贴板粘贴失败，回退逐字符输入：' + $_.Exception.Message)
                [WXDriver]::TypeText($ftext, 25)
                Start-Sleep -Milliseconds 260
            }
            # 回车前先确认“输入框里真的出现了文字”：这是后面用“输入框已清空”判定发送成功的前提。
            # 若 OCR 没读到输入框文字（typedSeen=false），发送判定会走失败分支，不会误报成功。
            $typedRegion = Get-RegionSnapshot $hwnd 'fast-intext' 0.28 0.775 0.97 0.885 -Ink
            $typedLines = @(Get-InputAreaLines $typedRegion)
            Write-Debug-Log ('快发送键入后输入框行数=' + $typedLines.Count + ' text=' + (($typedLines | ForEach-Object { [string]$_.text }) -join '|'))
            # 回读校验：Unicode 注入过快时微信输入框会丢字/重复标点，覆盖率不足就清空重打。
            $needle = Normalize-Text $ftext
            $typedJoined = [string]::Join('', @($typedLines | ForEach-Object { Normalize-Text ([string]$_.text) }))
            $covered = 0
            if ($needle.Length -gt 0) {
                foreach ($ch in $needle.ToCharArray()) { if ($typedJoined.Contains([string]$ch)) { $covered++ } }
            }
            $coverage = if ($needle.Length -gt 0) { $covered / $needle.Length } else { 1.0 }
            Write-Debug-Log ('快发送输入框回读覆盖率=' + [math]::Round($coverage, 2) + ' 期望长度=' + $needle.Length)
            if ($coverage -lt 0.8) {
                Write-Debug-Log '输入框回读不全，清空后重试粘贴/慢速输字'
                [WXDriver]::CtrlA()
                Start-Sleep -Milliseconds 60
                [WXDriver]::PressBackspace()
                Start-Sleep -Milliseconds 80
                if ($pasted) {
                    try {
                        Set-Clipboard -Value $ftext
                        Start-Sleep -Milliseconds 80
                        [WXDriver]::CtrlV()
                        Start-Sleep -Milliseconds 300
                    } catch {
                        [WXDriver]::TypeText($ftext, 30)
                        Start-Sleep -Milliseconds 300
                    }
                } else {
                    [WXDriver]::TypeText($ftext, 30)
                    Start-Sleep -Milliseconds 300
                }
                $typedRegion = Get-RegionSnapshot $hwnd 'fast-intext' 0.28 0.775 0.97 0.885 -Ink
                $typedLines = @(Get-InputAreaLines $typedRegion)
                Write-Debug-Log ('快发送重试后输入框行数=' + $typedLines.Count + ' text=' + (($typedLines | ForEach-Object { [string]$_.text }) -join '|'))
            }
            # 输入框有字 = OCR 读到行 或 深色像素明显（3x 下键入文本约 200+ 深色像素，空框 0）。
            $typedSeen = (($typedLines.Count -gt 0) -or ([int]$typedRegion.ink -gt 30))
            if (-not $skipEnter) { [WXDriver]::PressEnter() }
            if ($null -ne $clipBackup) { try { Set-Clipboard -Value $clipBackup } catch { } }
            Start-Sleep -Milliseconds 350
            $postRegion = Get-RegionSnapshot $hwnd 'fast-post' 0.28 0.70 0.99 0.99
            if (-not $forceBubbleFail -and (Test-NewBubble $preRegion $postRegion)) {
                Write-Debug-Log '快发送气泡校验通过'
                $fastDone = $true
            } else {
                Start-Sleep -Milliseconds 450
                $postRegion2 = Get-RegionSnapshot $hwnd 'fast-post2' 0.28 0.70 0.99 0.99
                if (-not $forceBubbleFail -and (Test-NewBubble $preRegion $postRegion2)) {
                    Write-Debug-Log '快发送气泡二次校验通过'
                    $fastDone = $true
                } else {
                    # 气泡 OCR 没看到新行时，改用“输入框是否已清空”判定：回车发送成功后微信会清空输入框。
                    # 只有「键入时输入框有字」+「回车后输入框没字」才判成功；否则 ok:false，且绝不重发。
                    $postInput = @(Get-InputAreaLines $postRegion2)
                    $postInRegion = Get-RegionSnapshot $hwnd 'fast-postin' 0.28 0.775 0.97 0.885 -Ink
                    $postInk = [int]$postInRegion.ink
                    $needle = Normalize-Text $ftext
                    $postJoined = [string]::Join('', @($postInput | ForEach-Object { Normalize-Text ([string]$_.text) }))
                    $stillThere = ($needle.Length -ge 2 -and $postJoined.Contains($needle))
                    # 输入框已清空 = 深色像素几乎为 0（占位灰提示不计）；OCR 行数在 3x 下不可靠，只作辅助。
                    $inputCleared = ($postInk -lt 20)
                    Write-Debug-Log ('快发送气泡未确认：键入有字=' + $typedSeen + ' 键入ink=' + [int]$typedRegion.ink + ' 回车后输入框行数=' + $postInput.Count + ' 回车后ink=' + $postInk + ' 已清空=' + $inputCleared + ' 仍含原文=' + $stillThere)
                    if ($typedSeen -and $inputCleared -and -not $stillThere) {
                        Write-Debug-Log '输入框已清空，判定发送成功（气泡 OCR 未确认不影响）'
                        $fastDone = $true
                    } else {
                        Write-Debug-Log '快发送气泡未确认且输入框未清空，不回退保守路径（避免重复发送）'
                        Write-Result @{ ok = $false; error = '快发送已回车但气泡未确认且输入框未清空，已跳过保守重发以免重复' }
                        exit 0
                    }
                }
            }
        } else {
            Write-Debug-Log ("快发送聊天标题不匹配，拒绝发送 text=" + (($fastChat.lines | Select-Object -First 6 | ForEach-Object { $_.text }) -join '|'))
            Write-Result @{ ok = $false; error = '无法确认目标聊天窗口，已拒绝发送以避免发错人' }
            exit 0
        }
        if ($fastDone) {
            Write-Result @{ ok = $true }
            exit 0
        }
    }

    if ($Action -eq 'read' -and $NoSearch) {
        # 只认“当前已经打开的会话”：标题 OCR 命中、或插件通过 list 的绿底选中行传回的 CurrentContact 与目标一致；
        # 两者都不成立时直接放弃读取，绝不 Ctrl+F 搜索（避免抢前台和搜索框闪烁）。
        $openSnap = Get-WindowSnapshot $hwnd 'read-nosearch'
        $openHit = [bool](Test-IsTargetChat $openSnap $Contact) -or [bool](Test-IsTargetChatLoose $openSnap $Contact)
        if (-not $openHit -and -not [string]::IsNullOrWhiteSpace($CurrentContact)) {
            if ((Normalize-Text $CurrentContact) -eq (Normalize-Text $Contact)) {
                $openHit = $true
                Write-Debug-Log ("NoSearch 读取用 CurrentContact 信任判定 contact=" + $Contact)
            }
        }
        if (-not $openHit) {
            Write-Debug-Log ("NoSearch 读取：当前未打开目标聊天 contact=" + $Contact)
            Write-Result @{ ok = $false; error = ('当前未打开「' + $Contact + '」的聊天（NoSearch），已跳过读取') }
            exit 0
        }
        $snap = @{ geo = $openSnap.geo; lines = $openSnap.lines; exact = $true; via = 'nosearch-open' }
        Write-Debug-Log ("进入聊天 via=nosearch-open contact=" + $Contact)
    } else {
        $snap = Enter-Chat $hwnd
        Write-Debug-Log ("进入聊天 via=" + $snap.via + " exact=" + $snap.exact + " contact=" + $Contact)
    }

    $chatConfirmed = [bool]$snap.exact -or ($snap.via -eq 'search')

    if ($Action -eq 'send') {
        if (-not $chatConfirmed) { Fail-With "无法确认已打开与「$Contact」的聊天窗口，为避免发错人已放弃发送" }
        if (-not $TextBase64) { Fail-With '缺少 -TextBase64' }
        $text = ''
        try { $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($TextBase64)) } catch { Fail-With 'TextBase64 不是合法的 Base64' }
        if ([string]::IsNullOrWhiteSpace($text)) { Fail-With '发送文本为空' }

        $geo = $snap.geo
        $inputX = [int]($geo.left + $geo.width * 0.72)
        $inputY = [int]($geo.top + $geo.height * 0.875)
        $verified = $false
        Ensure-Foreground $hwnd
        $preSnap = Get-WindowSnapshot $hwnd 'presend'
        # 1) 点输入框；2) 清空；3) 键入；4) 回车发送（微信默认回车发送）
        [WXDriver]::Click($inputX, $inputY)
        Start-Sleep -Milliseconds 180
        [WXDriver]::CtrlA()
        Start-Sleep -Milliseconds 50
        [WXDriver]::PressBackspace()
        Start-Sleep -Milliseconds 60
        $clipBackup2 = $null
        try { $clipBackup2 = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { }
        try {
            Set-Clipboard -Value $text
            Start-Sleep -Milliseconds 80
            [WXDriver]::CtrlV()
            Start-Sleep -Milliseconds 260
        } catch {
            Write-Debug-Log ('保守路径剪贴板粘贴失败，回退逐字符输入：' + $_.Exception.Message)
            [WXDriver]::TypeText($text, 25)
            Start-Sleep -Milliseconds 260
        }
        [WXDriver]::PressEnter()
        if ($null -ne $clipBackup2) { try { Set-Clipboard -Value $clipBackup2 } catch { } }
        Write-Debug-Log '已回车发送，等待气泡'
        Start-Sleep -Milliseconds 1300
        $postSnap = Get-WindowSnapshot $hwnd 'postsend'
        if (Test-NewBubble $preSnap $postSnap) { $verified = $true; Write-Debug-Log '新气泡校验通过' }
        if (-not $verified) {
            Start-Sleep -Milliseconds 900
            $postSnap2 = Get-WindowSnapshot $hwnd 'postsend2'
            if (Test-NewBubble $preSnap $postSnap2) { $verified = $true; Write-Debug-Log '二次新气泡校验通过' }
        }
        if (-not $verified) {
            $preview = $text
            if ($preview.Length -gt 12) { $preview = $preview.Substring(0, 12) + '…' }
            Fail-With "发送后未在聊天区看到消息气泡（已重试 3 次）：$preview"
        }
        Write-Debug-Log '发送成功（OCR 已确认气泡出现）'
        Write-Result @{ ok = $true }
        exit 0
    }

    # ── read ────────────────────────────────────────────────────────────
    $candidates = @(Get-InboundCandidates $snap)
    if (-not $chatConfirmed) {
        # 标题 OCR 不可靠时，用左侧列表预览做二次确认，避免读错人串聊。
        if (-not (Test-ChatByListPreview $snap $Contact)) {
            Fail-With "无法确认当前聊天是「$Contact」（标题与列表预览均未匹配），已跳过读取以避免读错人"
        }
        Write-Debug-Log ("读取用列表预览二次确认通过 contact=" + $Contact)
    }
    Write-Debug-Log ("候选消息 " + $candidates.Count)
    foreach ($c in $candidates) { Write-Debug-Log ("  CAND top=" + [int]$c.top + " text=" + $c.text) }

    $texts = @($candidates | ForEach-Object { [string]$_.text })

    if ($script:NoBaseline) {
        $out = @()
        foreach ($t in ($texts | Select-Object -Last $MaxMessages)) {
            $out += @{ id = ('pc-' + (Get-Hash $t) + '-n'); text = $t; receivedAt = (Now-Id) }
        }
        Write-Result @{ ok = $true; messages = @($out) }
        exit 0
    }

    $state = Read-State
    $hasPrev = $false
    $prev = @()
    try {
        if ($state.PSObject.Properties.Name -contains $Contact) {
            $entry = $state.$Contact
            if ($null -ne $entry -and $entry.PSObject.Properties.Name -contains 'texts') {
                $prev = @($entry.texts | ForEach-Object { [string]$_ })
                $hasPrev = $true
            }
            # 旧版基线存的是裸 hash 数组，格式不兼容：当作没有基线，重新建立。
        }
    } catch { $hasPrev = $false; $prev = @() }

    $newTexts = @()
    $resetBaseline = $false
    if (-not $hasPrev) {
        # 首次运行：把当前可见消息记为基线，不回复历史消息。
        if ($texts.Count -gt 0) {
            Save-Baseline $Contact $texts
            Write-Debug-Log ("首次基线已建立，消息数=" + $texts.Count)
        }
        Write-Result @{ ok = $true; messages = @() }
        exit 0
    }

    $n = $texts.Count
    $m = $prev.Count
    if ($n -gt 0 -and $m -gt 0) {
        # 用“上一次可见窗口”对齐：当前窗口开头 k 条 == 基线末尾 k 条，则第 k 条之后是新消息。
        $k = [math]::Min($n, $m)
        $matched = $false
        while ($k -gt 0) {
            $ok = $true
            for ($i = 0; $i -lt $k; $i++) {
                if ([string]$prev[$m - $k + $i] -ne [string]$texts[$i]) { $ok = $false; break }
            }
            if ($ok) { $matched = $true; break }
            $k--
        }
        if ($matched) {
            if ($k -lt $n) { $newTexts = @($texts[$k..($n - 1)]) }
        } else {
            # 完全对不上基线：多半是聊天窗口滚动/缩放变化/OCR 抖动。宁可不回复，也不把旧消息当新消息。
            $resetBaseline = $true
            Write-Debug-Log '当前窗口与基线完全无法对齐，已重置基线（不输出消息）'
        }
        if (-not $resetBaseline) {
            $mergedBaseline = @($prev) + @($newTexts)
            $mergedBaseline = @($mergedBaseline | Select-Object -Last 200)
            Save-Baseline $Contact $mergedBaseline
        } else {
            Save-Baseline $Contact $texts
        }
    }

    if ($newTexts.Count -eq 0) {
        Write-Result @{ ok = $true; messages = @() }
        exit 0
    }

    $out = @()
    $seen = @{}
    foreach ($t in $newTexts) {
        $h = Get-Hash $t
        if (-not $seen.ContainsKey($h)) { $seen[$h] = 0 }
        $seen[$h] = $seen[$h] + 1
        $out += @{ id = ('pc-' + $h + '-' + $seen[$h]); text = $t; receivedAt = (Now-Id) }
    }
    $out = @($out | Select-Object -Last $MaxMessages)
    Write-Debug-Log ("输出新消息 " + $out.Count)
    Write-Result @{ ok = $true; messages = @($out) }
    exit 0
} catch {
    Write-Debug-Log ("脚本异常: " + $_.Exception.Message)
    if ($script:DebugPath) { Write-Debug-Log ("堆栈: " + $_.ScriptStackTrace) }
    Fail-With ("脚本异常: " + $_.Exception.Message)
} finally {
    # 恢复：topmost → 最小化状态 → 前台窗口 → 鼠标位置。
if ($script:WasTopmost) { try { [WXDriver]::SetWindowPos($hwnd, [WXDriver]::HWND_NOTOPMOST, 0, 0, 0, 0, [WXDriver]::SWP_NOMOVE -bor [WXDriver]::SWP_NOSIZE -bor [WXDriver]::SWP_NOACTIVATE) | Out-Null } catch {} }
    try {
        if ($script:TargetHwnd -ne [IntPtr]::Zero) {
            # 不再把微信窗口最小化回去：反复显示/最小化会让用户以为窗口在“反复开关”。
            if ($script:FocusStolen -and -not $wasMin -and $prevFg -ne [IntPtr]::Zero -and $prevFg -ne $script:TargetHwnd) {
                [WXDriver]::SetForegroundWindow($prevFg) | Out-Null
            }
        }
    } catch {}
    try {
        if ($cursorSaved) {
            $cur = New-Object 'WXDriver+POINT'
            [WXDriver]::GetCursorPos([ref]$cur) | Out-Null
            if ($cur.X -ne $prevCursor.X -or $cur.Y -ne $prevCursor.Y) {
                [WXDriver]::SetCursorPos($prevCursor.X, $prevCursor.Y) | Out-Null
            }
        }
    } catch {}
}
#requires -Version 5.1
<#
.SYNOPSIS
  dsh-wechat-persona 一键环境自检。
.DESCRIPTION
  检查 Windows/微信/DSH/OCR/构建产物/插件 API/数据目录，输出 JSON + 人话结论。
  退出码：0 = 全部通过；1 = 有 critical 失败（需要先修）。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/pwsh/selfcheck.ps1
  powershell -ExecutionPolicy Bypass -File scripts/pwsh/selfcheck.ps1 -Port 53905
#>
param(
  [string]$WindowTitle = '微信',
  [int]$Port = 0,
  [string]$DataDir = "$env:USERPROFILE\.dsh\profiles\desktop\.dsh-wechat-persona"
)

$ErrorActionPreference = 'SilentlyContinue'
$checks = New-Object System.Collections.ArrayList

function Add-Check([string]$name, [string]$status, [string]$detail) {
  [void]$checks.Add([ordered]@{ name = $name; status = $status; detail = $detail })
}

function Test-Critical { param([string]$s) return ($s -eq 'fail') }

# 1. Windows / PowerShell
$os = [System.Environment]::OSVersion.Version
$isWin = ($env:OS -eq 'Windows_NT')
if ($isWin) { Add-Check 'os' 'pass' ("Windows " + $os.Major + '.' + $os.Minor + ' build ' + $os.Build) }
else { Add-Check 'os' 'fail' '非 Windows：desktop 通道仅支持 Windows' }
Add-Check 'powershell' 'pass' ($PSVersionTable.PSVersion.ToString())

# 2. node（DSH 自带也可，仅提示）
$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($node) { Add-Check 'node' 'pass' ((& node --version) -join '') }
else { Add-Check 'node' 'warn' '未找到 node（DSH 插件运行不依赖系统 node，仅开发/构建需要）' }

# 3. 微信进程与窗口
$wechat = Get-Process Weixin -ErrorAction SilentlyContinue
if ($wechat) { Add-Check 'wechat-process' 'pass' ("Weixin pid=" + (($wechat | Select-Object -First 1).Id)) }
else { Add-Check 'wechat-process' 'fail' '未找到 Weixin 进程：请先打开并登录微信（小号）' }

$winOk = $false
if (-not $script:WinList) { $script:WinList = @() }
Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class SelfCheckWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
  public static List<string> Found = new List<string>();
  public static void Run() {
    Found.Clear();
    EnumWindows((h, p) => {
      var ct = new StringBuilder(256);
      GetClassName(h, ct, 256);
      if (!ct.ToString().Contains("Qt51514QWindowIcon")) return true;
      int l = GetWindowTextLength(h);
      var sb = new StringBuilder(l + 2);
      GetWindowText(h, sb, l + 1);
      RECT r; GetWindowRect(h, out r);
      Found.Add(sb.ToString() + "|" + (r.R - r.L) + "x" + (r.B - r.T) + "|vis=" + IsWindowVisible(h));
      return true;
    }, IntPtr.Zero);
  }
}
"@
[SelfCheckWin]::Run()
$wins = @([SelfCheckWin]::Found)
$main = $wins | Where-Object { $_ -like "$WindowTitle|*" } | Select-Object -First 1
if ($main) {
  $parts = $main.Split('|')
  $winOk = $true
  Add-Check 'wechat-window' 'pass' ("找到「$WindowTitle」窗口 " + $parts[1] + ' ' + $parts[2])
} else {
  Add-Check 'wechat-window' 'fail' ("未找到标题为「$WindowTitle」的微信窗口；当前 Qt 窗口：" + ($wins -join ' / '))
}
if ($winOk -and $wins.Count -gt 1) { Add-Check 'wechat-extra-windows' 'warn' ("检测到多个微信窗口：" + ($wins -join ' / ') + '（搜索/独立聊天窗可能干扰 OCR，建议关闭）') }

# 4. 屏幕/DPI
Add-Type -ErrorAction SilentlyContinue -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
Add-Check 'screen' 'pass' ($screen.Bounds.Width.ToString() + 'x' + $screen.Bounds.Height.ToString())

# 5. OCR 语言（中文）
$langs = Get-WinUserLanguageList -ErrorAction SilentlyContinue
$zh = $langs | Where-Object { $_.LanguageTag -like 'zh-Hans*' -or $_.LanguageTag -like 'zh-CN*' }
if ($zh) { Add-Check 'ocr-language' 'pass' ('已安装中文语言包：' + (($zh | ForEach-Object { $_.LanguageTag }) -join ', ')) }
else { Add-Check 'ocr-language' 'fail' '未检测到 zh-Hans 语言包：Windows OCR 无法识别中文，请安装「中文(简体)」可选功能' }

# 6. 构建产物 vs 源码
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$srcFile = Join-Path $root 'src\channels\pc\desktop.ts'
$distFile = Join-Path $root 'dist\channels\pc\desktop.js'
if ((Test-Path $distFile) -and (Test-Path $srcFile)) {
  $srcT = (Get-Item $srcFile).LastWriteTimeUtc
  $distT = (Get-Item $distFile).LastWriteTimeUtc
  if ($srcT -gt $distT.AddSeconds(5)) { Add-Check 'build-freshness' 'fail' 'src 比 dist 新：请先 npm run build 并重载插件' }
  else { Add-Check 'build-freshness' 'pass' ('dist 最新构建：' + $distT.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')) }
} else { Add-Check 'build-freshness' 'fail' '缺少 src 或 dist（是否在仓库根目录下运行？）' }

# 7. 数据目录
if (Test-Path $DataDir) {
  $audit = Join-Path $DataDir 'audit.jsonl'
  $tail = if (Test-Path $audit) { (Get-Content $audit -Tail 200 | Measure-Object).Count } else { 0 }
  Add-Check 'data-dir' 'pass' ($DataDir + '（audit 最近 ' + $tail + ' 行）')
} else { Add-Check 'data-dir' 'warn' ($DataDir + ' 不存在（尚未启动过插件？）') }

# 8. 插件 API（可选）
if ($Port -gt 0) {
  try {
    $r = Invoke-RestMethod -Uri ("http://127.0.0.1:$Port/dsh-wechat-persona/api/health") -Headers @{ 'x-dsh-wechat-persona' = '1' } -TimeoutSec 8
    Add-Check 'plugin-api' 'pass' ($Port.ToString() + ' => ' + ($r | ConvertTo-Json -Compress))
  } catch { Add-Check 'plugin-api' 'fail' ("端口 " + $Port + " API 不可达：" + $_.Exception.Message) }
} else {
  Add-Check 'plugin-api' 'warn' '未指定 -Port，跳过 API 检查（可用 DSH GUI 端口）'
}

# 汇总
$fail = @($checks | Where-Object { $_.status -eq 'fail' }).Count
$warn = @($checks | Where-Object { $_.status -eq 'warn' }).Count
$result = [ordered]@{
  ok = ($fail -eq 0)
  fail = $fail
  warn = $warn
  checks = $checks
  time = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}
$json = $result | ConvertTo-Json -Depth 6

Write-Host '=== 自检明细 ===' -ForegroundColor Cyan
foreach ($c in $checks) {
  $color = switch ($c.status) { 'pass' { 'Green' } 'warn' { 'Yellow' } default { 'Red' } }
  Write-Host ("[{0}] {1}：{2}" -f $c.status.ToUpper(), $c.name, $c.detail) -ForegroundColor $color
}
Write-Host ''
Write-Host '=== JSON ===' -ForegroundColor Cyan
Write-Host $json
if ($fail -gt 0) { exit 1 } else { exit 0 }

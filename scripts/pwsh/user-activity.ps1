# 用户键鼠空闲时长探测（供 desktop 通道做“人机让路”闸门）。
#
# 输出：stdout 一个纯整数 = 距离最后一次键盘/鼠标输入的毫秒数。
#       desktop 通道会把它和 channels.desktop.userActivityIdleMs 比较，
#       小于阈值就认为用户正在用电脑，禁止自动化操作。
# 退出码：0 成功；1 探测失败（调用方按“无法确认用户状态”保守处理，不发送）。
#
# 说明：
# - 只用 GetLastInputInfo（Win32），不注入、不截屏、不读输入内容；
# - 在非交互会话（如服务/计划任务）里可能探测失败，此时返回退出码 1；
# - 兼容 Windows PowerShell 5.1（由 desktop 通道用 powershell.exe -File 调用）。

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

try {
    $signature = @'
using System;
using System.Runtime.InteropServices;

public static class DshUserIdleTime
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll")]
    private static extern ulong GetTickCount64();

    /// <summary>返回自最后一次键盘/鼠标输入以来的毫秒数；失败返回 -1。</summary>
    public static long GetIdleMs()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info)) return -1;
        // Windows PowerShell 5.1 跑在 .NET Framework 4.8 上，没有 Environment.TickCount64，改用 Win32 GetTickCount64。
        ulong tick = GetTickCount64();
        long idle = (long)tick - (long)info.dwTime;
        // 回绕 / 时钟异常时保守返回 0（当作“用户正在操作”）。
        if (idle < 0) return 0;
        return idle;
    }
}
'@

    # 重复执行时避免 Add-Type 冲突。
    if (-not ('DshUserIdleTime' -as [type])) {
        Add-Type -TypeDefinition $signature -Language CSharp
    }

    $idle = [DshUserIdleTime]::GetIdleMs()
    if ($idle -lt 0) {
        [Console]::Error.WriteLine('GetLastInputInfo 调用失败（可能运行在非交互会话）')
        exit 1
    }

    Write-Output ([int64]$idle)
    exit 0
}
catch {
    [Console]::Error.WriteLine("user-activity.ps1 失败: $($_.Exception.Message)")
    exit 1
}

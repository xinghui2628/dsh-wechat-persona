#requires -Version 5.1
<#
  ocr-winrt.ps1 —— OCR Benchmark 用的 WinRT（Windows.Media.Ocr）独立识别 helper。

  输入：-Path <png 图片路径>（必填）
  输出：stdout 单行 UTF-8 JSON
    成功：
      {"ok":true,"engine":"winrt-zh-Hans-CN","elapsedMs":N,"width":W,"height":H,
       "lines":[{"text":"...","x":..,"y":..,"w":..,"h":..}]}
    失败：
      {"ok":false,"error":"原因"}，exit 1
  坐标系：图片左上角为原点、像素单位；lines 的 bbox 是该行所有 word 的包围盒并集。
  engine 字段用实际识别语言标签（通常 zh-Hans-CN）。

  运行要求：必须使用 Windows PowerShell 5.1（powershell.exe），
  PowerShell 7 没有 WinRT 类型投影；且系统需已安装对应 OCR 语言包。
  本脚本只读图片、不启动微信、不截图、不改系统设置。
  scripts/ocr/engines.mjs 通过 child_process 调用本文件。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Language = 'zh-Hans-CN'
)
$ErrorActionPreference = 'Stop'

# stdout 固定写入 UTF-8 字节（PS 5.1 默认按控制台代码页 GBK 输出，中文会乱码）。
# 注意：即使设置了 [Console]::OutputEncoding，被 Node 以 CREATE_NO_WINDOW(windowsHide) 启动时
# 仍会退回 GBK；所以这里直接拿标准输出流写字节，绕开 TextWriter 的编码。
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $Utf8NoBom

function Write-Result {
  param($Payload, [int]$ExitCode)
  $json = $Payload | ConvertTo-Json -Compress -Depth 6
  $bytes = $Utf8NoBom.GetBytes($json + "`n")
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
  exit $ExitCode
}

try {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Result ([ordered]@{ ok = $false; error = "图片不存在：$Path" }) 1
  }
  # WinRT 的 StorageFile API 只接受绝对路径
  try { $Path = [System.IO.Path]::GetFullPath($Path) } catch { }

  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  if ($null -eq $asTaskGeneric) {
    Write-Result ([ordered]@{ ok = $false; error = '找不到 AsTask 泛型方法，WinRT 运行时不可用' }) 1
  }

  # Await 的 $ResultType 必须显式声明为 [Type]，否则 PS 会把它当 [bool]
  function Await {
    param($WinRtTask, [Type]$ResultType)
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }

  # 注册 WinRT 类型投影
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

  # 建 OCR 引擎：先按指定语言，语言包不可用时回退系统语言
  $ocrEngine = $null
  try {
    $lang = New-Object Windows.Globalization.Language $Language
    $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  } catch {
    $ocrEngine = $null
  }
  if ($null -eq $ocrEngine) {
    try {
      $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    } catch {
      $ocrEngine = $null
    }
  }
  if ($null -eq $ocrEngine) {
    Write-Result ([ordered]@{ ok = $false; error = "WinRT OCR 引擎创建失败：语言 $Language 不可用且系统语言也不可用" }) 1
  }

  # 读图 → 解码 → SoftwareBitmap
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $width = [int]$decoder.PixelWidth
  $height = [int]$decoder.PixelHeight

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ocrResult = Await ($ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $sw.Stop()

  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $ocrResult.Lines) {
    $minX = [double]::MaxValue; $minY = [double]::MaxValue
    $maxX = [double]::MinValue; $maxY = [double]::MinValue
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    if ($minX -eq [double]::MaxValue) { continue }
    [void]$lines.Add([ordered]@{
        text = [string]$line.Text
        x    = [int][math]::Round($minX)
        y    = [int][math]::Round($minY)
        w    = [int][math]::Round($maxX - $minX)
        h    = [int][math]::Round($maxY - $minY)
      })
  }

  $tag = 'zh-Hans-CN'
  try { $tag = [string]$ocrEngine.RecognizerLanguage.LanguageTag } catch { }
  $payload = [ordered]@{
    ok        = $true
    engine    = "winrt-$tag"
    elapsedMs = [int]$sw.ElapsedMilliseconds
    width     = $width
    height    = $height
    lines     = @($lines)
  }
  try { $stream.Dispose() } catch { }
  try { $bitmap.Dispose() } catch { }
  Write-Result $payload 0
} catch {
  Write-Result ([ordered]@{ ok = $false; error = $_.Exception.Message }) 1
}

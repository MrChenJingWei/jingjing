<#
构建 Windows 桌面 App（托盘 + 原生窗口）、安装包和便携 zip。在 Windows 上运行，需要 .NET SDK 和 Node.js 24：

  pwsh packaging/windows/build.ps1            # App + 安装包 + 便携 zip，产物在 dist\
  pwsh packaging/windows/build.ps1 -AppOnly   # 只生成 packaging\windows\build\Jingjing\（开发调试用）

开发调试时直接运行 packaging\windows\build\Jingjing\Jingjing.exe；用 JINGJING_DATA_DIR / JINGJING_PORT 指到别处，
就不会碰已经安装的静静（%LOCALAPPDATA%\Jingjing、7777 端口）。JINGJING_DEVTOOLS=1 打开网页开发者工具。
安装包用 Inno Setup 6.5+ 打，本机没有会用 choco 装一个。
#>
param([switch]$AppOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Here = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $Here '..\..')).Path
$Build = Join-Path $Here 'build'
$Stage = Join-Path $Build 'Jingjing'
$Dist = Join-Path $Root 'dist'
$Icon = Join-Path $Build 'app.ico'
$Version = (Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'package.json') | ConvertFrom-Json).version

function Step([string]$message) {
  Write-Host "==> $message" -ForegroundColor Green
}

# 把一张大 PNG 缩成多种尺寸，写成 .ico（每一帧都是 PNG，Windows Vista 起都认）。
function New-Icon([string]$png, [string]$out) {
  Add-Type -AssemblyName System.Drawing
  $source = [System.Drawing.Image]::FromFile($png)
  $frames = New-Object System.Collections.Generic.List[object]
  try {
    foreach ($size in @(16, 20, 24, 32, 40, 48, 64, 128, 256)) {
      $bitmap = New-Object System.Drawing.Bitmap($size, $size)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($source, 0, 0, $size, $size)
      $graphics.Dispose()
      $stream = New-Object System.IO.MemoryStream
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $bitmap.Dispose()
      $frames.Add([pscustomobject]@{ Size = $size; Data = $stream.ToArray() })
    }
  } finally {
    $source.Dispose()
  }
  $writer = New-Object System.IO.BinaryWriter([System.IO.File]::Create($out))
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
      $dim = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
      $writer.Write([byte]$dim)
      $writer.Write([byte]$dim)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$frame.Data.Length)
      $writer.Write([uint32]$offset)
      $offset += $frame.Data.Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Data) }
  } finally {
    $writer.Dispose()
  }
}

function Find-Iscc {
  foreach ($dir in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
    if (-not $dir) { continue }
    $candidate = Join-Path $dir 'Inno Setup 6\ISCC.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $found = Get-Command iscc.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.Path }
  return $null
}

# ---------------------------------------------------------------------------

$node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw '找不到 node.exe，无法打包运行时。' }
$nodeVersion = [version](((& $node.Path -v) -replace '^v', '') -replace '[-+].*$', '')
if ($nodeVersion -lt [version]'23.4.0') { throw "打包用的 Node 是 $nodeVersion，静静需要 23.4+（推荐 24）。" }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '找不到 dotnet：请先安装 .NET SDK（8 或更新）。' }

Step "构建静静 Windows App v$Version"
if (Test-Path -LiteralPath $Build) { Remove-Item -LiteralPath $Build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

Step '生成图标'
New-Icon (Join-Path $Root 'public\icon-512.png') $Icon

Step '编译 App'
$bin = Join-Path $Build 'bin'
& dotnet publish (Join-Path $Here 'Jingjing.csproj') -c Release -o $bin "-p:Version=$Version" --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败（退出码 $LASTEXITCODE）" }
Copy-Item -Path (Join-Path $bin '*') -Destination $Stage -Recurse -Force
if (-not (Test-Path -LiteralPath (Join-Path $Stage 'Jingjing.exe'))) { throw '编译产物里没有 Jingjing.exe' }
if (-not (Test-Path -LiteralPath (Join-Path $Stage 'WebView2Loader.dll'))) { throw '编译产物里没有 WebView2Loader.dll' }

Step '复制服务与静态资源'
# 和 macOS App 一样只带运行需要的代码（不带测试、文档、打包脚本）。
$exclude = @('data', 'tests', 'docs', 'packaging', '.git', '.github', '.toolchain', 'mobile', 'scripts', 'dist', 'plugin-src', 'node_modules', 'inbox')
robocopy $Root (Join-Path $Stage 'app') /E /XD @($exclude | ForEach-Object { Join-Path $Root $_ }) /XF .DS_Store /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制服务代码失败（robocopy 退出码 $LASTEXITCODE）" }
foreach ($required in @('server.js', 'package.json', 'src', 'public', 'plugins', 'workers')) {
  if (-not (Test-Path -LiteralPath (Join-Path $Stage "app\$required"))) { throw "App 里缺少 app\$required" }
}

Step "打包 Node 运行时（$($node.Path)，v$nodeVersion）"
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'runtime') | Out-Null
Copy-Item -LiteralPath $node.Path -Destination (Join-Path $Stage 'runtime\node.exe')

if ($AppOnly) {
  Write-Host ''
  Write-Host "完成：$Stage"
  return
}

Step '生成安装包'
$iscc = Find-Iscc
$isccVersion = if ($iscc) { [version]((Get-Item -LiteralPath $iscc).VersionInfo.ProductVersion -replace '[^\d.].*$', '') } else { $null }
if (-not $iscc -or $isccVersion -lt [version]'6.5') {
  # 中文界面的语言文件需要 Inno Setup 6.5+。
  if (-not (Get-Command choco -ErrorAction SilentlyContinue)) { throw '需要 Inno Setup 6.5+：从 https://jrsoftware.org/isdl.php 下载安装，或者装好 Chocolatey 后重试。' }
  & choco upgrade innosetup -y --no-progress | Out-Host
  $iscc = Find-Iscc
  if (-not $iscc) { throw '装好 Inno Setup 后仍然找不到 ISCC.exe' }
}
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
& $iscc "/DAppVersion=$Version" "/DAppFiles=$Stage" "/DOutputDir=$Dist" "/DIconFile=$Icon" (Join-Path $Here 'jingjing.iss')
if ($LASTEXITCODE -ne 0) { throw "Inno Setup 编译失败（退出码 $LASTEXITCODE）" }
$setup = Join-Path $Dist "jingjing-$Version-windows-x64-setup.exe"
if (-not (Test-Path -LiteralPath $setup)) { throw "没有生成 $setup" }

Step '生成便携 zip'
$zip = Join-Path $Dist "jingjing-$Version-windows-x64.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
& tar.exe -a -c -f $zip -C $Build Jingjing
if ($LASTEXITCODE -ne 0) { throw '打包 zip 失败' }

Step '生成 SHA256SUMS-windows.txt'
$sums = foreach ($file in @($setup, $zip)) {
  '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant(), (Split-Path -Leaf $file)
}
Set-Content -Encoding ASCII -Path (Join-Path $Dist 'SHA256SUMS-windows.txt') -Value $sums
$sums | Write-Host

Write-Host ''
Write-Host "完成（Windows x64）："
Write-Host "  App:    $Stage"
Write-Host "  安装包: $setup"
Write-Host "  zip:    $zip"

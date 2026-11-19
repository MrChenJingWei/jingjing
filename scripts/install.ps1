<#
静静安装脚本（Windows 命令行版）：一条命令装好，不需要管理员权限，也不需要预装 Node.js。

  在 PowerShell 里运行：
    irm https://github.com/MrChenJingWei/jingjing/releases/latest/download/install.ps1 -OutFile "$env:TEMP\jingjing-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\jingjing-install.ps1"

  先下载成文件再运行（而不是 irm | iex）：Windows PowerShell 5.1 才能按 UTF-8 读出中文提示。

不指定版本时安装最新 Release；也可以用 -Version v0.9.4 装指定版本。
环境变量：JINGJING_REPO、JINGJING_RELEASE_BASE、JINGJING_VERSION、JINGJING_NODE_VERSION、
         JINGJING_DATA_DIR（只影响安装后拉起的服务）。
#>
[CmdletBinding()]
param(
  [string]$Version = $env:JINGJING_VERSION,
  [string]$Prefix = '',
  [string]$ListenHost = '0.0.0.0',
  [int]$Port = 7777,
  [switch]$Service,
  [switch]$NoNode,
  [switch]$NoPath,
  [switch]$DryRun,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 显示下载进度条会让下载慢上几十倍。
$ProgressPreference = 'SilentlyContinue'
# 老系统上默认还是 TLS 1.0，GitHub 和 nodejs.org 都要 TLS 1.2。
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = if ($env:JINGJING_REPO) { $env:JINGJING_REPO } else { 'MrChenJingWei/jingjing' }
$ReleaseBase = if ($env:JINGJING_RELEASE_BASE) { $env:JINGJING_RELEASE_BASE.TrimEnd('/') } else { "https://github.com/$Repo/releases" }
$NodeVersion = if ($env:JINGJING_NODE_VERSION) { $env:JINGJING_NODE_VERSION } else { '24.22.3' }
$NodeMin = [version]'23.4.0'

function Info([string]$message) {
  Write-Host '==> ' -ForegroundColor Green -NoNewline
  Write-Host $message
}

function Warn([string]$message) {
  Write-Host "警告：$message" -ForegroundColor Yellow
}

function Show-Usage {
  @'
静静安装脚本（Windows）

用法：
  install.ps1 [选项]

选项：
  -Version <版本>     指定版本，如 v0.9.4（默认最新 Release）
  -Prefix <目录>      安装目录（默认 %LOCALAPPDATA%\Jingjing\cli）
  -ListenHost <地址>  服务监听地址（默认 0.0.0.0，手机/局域网可访问）
  -Port <端口>        服务端口（默认 7777）
  -Service            装完顺手装成常驻服务（登录后自动在后台启动）
  -NoNode             缺少 Node.js 时直接报错，不自动下载
  -NoPath             不把 <安装目录>\bin 加进用户 PATH
  -DryRun             只打印将要执行的步骤
  -Help               显示帮助

环境变量：
  JINGJING_REPO             GitHub 仓库（默认 MrChenJingWei/jingjing）
  JINGJING_RELEASE_BASE     替换 Release 下载地址（调试/镜像用）
  JINGJING_VERSION          同 -Version
  JINGJING_NODE_VERSION     自动下载 Node 时用的版本（默认 24.22.3）
  JINGJING_DATA_DIR         运行时数据目录（默认 <安装目录>\data）
'@ | Write-Host
}

function Invoke-Quiet([string]$file, [string[]]$arguments) {
  # Windows PowerShell 5.1 里 $ErrorActionPreference = Stop 时，原生命令往 stderr 写一行就会变成异常。
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $file @arguments 2>&1 | Out-Null } finally { $ErrorActionPreference = $saved }
  return $LASTEXITCODE
}

function Get-Download([string]$url, [string]$out) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -UserAgent 'jingjing-installer'
      return
    } catch {
      if ($attempt -eq 3) { throw "下载失败：$url（$($_.Exception.Message)）" }
      Start-Sleep -Seconds $attempt
    }
  }
}

function Assert-Sha256([string]$expected, [string]$file) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
  $name = Split-Path -Leaf $file
  if ($actual -ne $expected.ToLowerInvariant()) { throw "$name 校验失败：期望 $expected，实际 $actual" }
  Info "已校验 $name 的 sha256"
}

function Expand-Zip([string]$zip, [string]$dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  # Windows 10 1803 起自带 tar.exe，解 zip 比 Expand-Archive 快得多；没有就退回 Expand-Archive。
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if ((Test-Path -LiteralPath $tar) -and ((Invoke-Quiet $tar @('-xf', $zip, '-C', $dest)) -eq 0)) { return }
  Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
}

function Test-NodeVersion([string]$bin) {
  try {
    $text = [string](& $bin -v)
  } catch {
    return $false
  }
  if ($text -match '^v(\d+)\.(\d+)\.(\d+)') {
    return ([version]"$($Matches[1]).$($Matches[2]).$($Matches[3])") -ge $NodeMin
  }
  return $false
}

function Find-Node([string]$root) {
  $found = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found -and (Test-NodeVersion $found.Path)) { return $found.Path }
  $bundled = Join-Path $root 'runtime\node.exe'
  if ((Test-Path -LiteralPath $bundled) -and (Test-NodeVersion $bundled)) { return $bundled }
  return $null
}

function Get-NodePlatform {
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { return 'win-x64' }
    'ARM64' { return 'win-arm64' }
    default { throw "没有适合 $arch 的 Node.js 预编译包（需要 64 位 Windows）。" }
  }
}

function Install-Node([string]$root, [string]$work) {
  $platform = Get-NodePlatform
  $name = "node-v$NodeVersion-$platform"
  $url = "https://nodejs.org/dist/v$NodeVersion/$name.zip"
  if ($DryRun) {
    Info "（演练）下载 Node v${NodeVersion}：$url"
    return (Join-Path $root 'runtime\node.exe')
  }
  Info "本机没有可用的 Node.js，下载 Node v$NodeVersion（$platform）"
  $zip = Join-Path $work "$name.zip"
  $sums = Join-Path $work 'SHASUMS256.txt'
  Get-Download $url $zip
  Get-Download "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" $sums
  $line = Get-Content -LiteralPath $sums | Where-Object { $_ -match ('^[0-9a-f]{64}\s+' + [regex]::Escape("$name.zip") + '$') } | Select-Object -First 1
  if (-not $line) { throw "Node.js 官方校验文件里找不到 $name.zip" }
  Assert-Sha256 (($line -split '\s+')[0]) $zip
  $extract = Join-Path $work 'node'
  Expand-Zip $zip $extract
  $runtime = Join-Path $root 'runtime'
  if (Test-Path -LiteralPath $runtime) { Remove-Item -LiteralPath $runtime -Recurse -Force }
  Move-Item -LiteralPath (Join-Path $extract $name) -Destination $runtime
  $node = Join-Path $runtime 'node.exe'
  if (-not (Test-Path -LiteralPath $node)) { throw "解压后找不到 $node" }
  return $node
}

# current 是指向 versions\<版本> 的目录联接（junction，不需要管理员权限），和 macOS / Linux 上的 current 符号链接一样：
# 常驻服务、启动命令都认 current，换版本只要改这个联接。
function Set-CurrentLink([string]$root, [string]$target) {
  $link = Join-Path $root 'current'
  $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  if ($item) {
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$link 不是链接，不敢覆盖：请先手动挪走它" }
    [IO.Directory]::Delete($link) # 只删联接本身，不碰它指向的文件
  }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}

function ConvertTo-Literal([string]$value) {
  return $value.Replace("'", "''")
}

function Write-Launcher([string]$root, [string]$dataDir, [string]$nodeBin) {
  $template = @'
# 静静命令行入口（由 install.ps1 生成，重新安装会覆盖）。用法：jingjing help
param(
  [Parameter(Position = 0)][string]$Command = 'start',
  [Parameter(Position = 1)][string]$Action = ''
)
$ErrorActionPreference = 'Stop'

$Prefix = '__JINGJING_PREFIX__'
$NodeBin = '__JINGJING_NODE__'
$AppDir = Join-Path $Prefix 'current'
if (-not $env:JINGJING_DATA_DIR) { $env:JINGJING_DATA_DIR = '__JINGJING_DATA_DIR__' }
if (-not $env:JINGJING_HOST) { $env:JINGJING_HOST = '__JINGJING_HOST__' }
if (-not $env:JINGJING_PORT) { $env:JINGJING_PORT = '__JINGJING_PORT__' }
$DataDir = $env:JINGJING_DATA_DIR
$Port = $env:JINGJING_PORT

if (-not (Test-Path -LiteralPath $NodeBin)) {
  $found = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  $NodeBin = if ($found) { $found.Path } else { '' }
}
if (-not $NodeBin) { Write-Host "找不到 Node.js 运行时。重新运行 install.ps1 可以补上。" -ForegroundColor Red; exit 1 }
if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'server.js'))) {
  Write-Host "静静的程序目录不完整：$AppDir（重新运行 install.ps1）" -ForegroundColor Red
  exit 1
}

function Get-AppVersion {
  return (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $AppDir 'package.json') | ConvertFrom-Json).version
}

function Get-PairUrl {
  $keyFile = Join-Path $DataDir 'access-key'
  if (Test-Path -LiteralPath $keyFile) {
    $key = (Get-Content -Raw -LiteralPath $keyFile).Trim()
    if ($key) { return "http://127.0.0.1:$Port/pair?key=$key" }
  }
  return "http://127.0.0.1:$Port"
}

function Show-Usage {
  Write-Host @"
用法：jingjing <命令>

  （无参数）/ start   前台启动服务（Ctrl+C 停止）
  open               用浏览器打开（自动带上配对码）
  url                打印本机地址和配对码
  status             查看服务是否在运行
  service install     装成常驻服务：登录后自动在后台启动、崩溃自动拉起
  service uninstall   卸载常驻服务
  service status      查看常驻服务的状态
  version            打印版本

当前数据目录：$DataDir
监听地址：     $($env:JINGJING_HOST):$Port
"@
}

switch ($Command) {
  { $_ -in @('start', 'run') } {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    Write-Host "静静 v$(Get-AppVersion) 启动中：http://127.0.0.1:$Port （Ctrl+C 停止）"
    & $NodeBin (Join-Path $AppDir 'server.js')
    exit $LASTEXITCODE
  }
  'open' {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    Start-Process (Get-PairUrl)
  }
  'url' { Write-Output (Get-PairUrl) }
  'status' {
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 | ConvertTo-Json -Compress | Write-Output
    } catch {
      Write-Host '静静没有在运行。' -ForegroundColor Yellow
      exit 1
    }
  }
  'service' {
    if ($Action -notin @('install', 'uninstall', 'status')) { Write-Host '用法：jingjing service install|uninstall|status'; exit 1 }
    & (Join-Path $AppDir 'scripts\windows-service.ps1') -Action $Action -Node $NodeBin -AppDir $AppDir -DataDir $DataDir -ListenHost $env:JINGJING_HOST -Port ([int]$Port)
  }
  'version' { Write-Output (Get-AppVersion) }
  { $_ -in @('help', '-h', '--help') } { Show-Usage }
  default { Show-Usage; exit 1 }
}
'@
  $content = $template.Replace('__JINGJING_PREFIX__', (ConvertTo-Literal $root))
  $content = $content.Replace('__JINGJING_NODE__', (ConvertTo-Literal $nodeBin))
  $content = $content.Replace('__JINGJING_DATA_DIR__', (ConvertTo-Literal $dataDir))
  $content = $content.Replace('__JINGJING_HOST__', (ConvertTo-Literal $ListenHost))
  $content = $content.Replace('__JINGJING_PORT__', "$Port")
  # 带 BOM 的 UTF-8：Windows PowerShell 5.1 没有 BOM 时按系统代码页读，中文会乱、甚至解析出错。
  [IO.File]::WriteAllText((Join-Path $root 'launcher.ps1'), $content, (New-Object System.Text.UTF8Encoding($true)))

  # bin 里只放 jingjing.cmd（cmd 和 PowerShell 里都能直接敲 jingjing）；PowerShell 逻辑放在 bin 外面，
  # 免得 PowerShell 优先去跑同名的 .ps1、又被系统默认的脚本执行策略拦住。
  # goto 到不存在的标签会先结束批处理，后面的命令照样执行：按 Ctrl+C 时不会再问「终止批处理操作吗」。
  $cmd = @(
    '@echo off',
    'goto #_undefined_# 2>NUL || title %COMSPEC% & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\launcher.ps1" %*'
  ) -join "`r`n"
  [IO.File]::WriteAllText((Join-Path $root 'bin\jingjing.cmd'), "$cmd`r`n", [Text.Encoding]::ASCII)
}

function Add-UserPath([string]$dir) {
  # 直接读写注册表，保留 %USERPROFILE% 这类没展开的写法（[Environment]::SetEnvironmentVariable 会把它们展开成固定路径）。
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = @($current -split ';' | Where-Object { $_ })
    if ($parts | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') }) { return $false }
    $key.SetValue('Path', (($parts + $dir) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
  } finally {
    $key.Close()
  }
  # 通知已经开着的资源管理器：新开的终端就能用上新的 PATH。
  try {
    Add-Type -Namespace JingjingInstall -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
    $result = [UIntPtr]::Zero
    [JingjingInstall.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
  } catch { }
  $env:Path = "$env:Path;$dir"
  return $true
}

function Install-Jingjing {
  if (-not $env:LOCALAPPDATA) { throw '找不到 %LOCALAPPDATA%：这个脚本只能在 Windows 上运行（macOS / Linux 请用 install.sh）。' }
  $root = if ($Prefix) { $Prefix } else { Join-Path $env:LOCALAPPDATA 'Jingjing\cli' }
  $root = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $dataDir = if ($env:JINGJING_DATA_DIR) { [IO.Path]::GetFullPath($env:JINGJING_DATA_DIR).TrimEnd('\') } else { Join-Path $root 'data' }

  New-Item -ItemType Directory -Force -Path $root | Out-Null
  # 临时目录放在安装目录里：最后要把解压出的目录挪进 versions，跨磁盘挪不动。
  $work = Join-Path $root ('.install-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    $wanted = if ($Version) { $Version.Trim().TrimStart('v') } else { '' }
    $metaUrl = if ($wanted) { "$ReleaseBase/download/v$wanted/latest.json" } else { "$ReleaseBase/latest/download/latest.json" }
    Info "读取 Release 信息：$metaUrl"
    $metaFile = Join-Path $work 'latest.json'
    Get-Download $metaUrl $metaFile
    $meta = Get-Content -Raw -Encoding UTF8 -LiteralPath $metaFile | ConvertFrom-Json
    if (-not $meta.version) { throw "Release 清单里没有 version 字段：$metaUrl" }
    if ($wanted -and $wanted -ne $meta.version) { throw "请求的版本是 $wanted，但清单里的版本是 $($meta.version)" }
    $release = [string]$meta.version
    Info "目标版本：$release"

    $node = Find-Node $root
    if ($node) {
      Info "使用 Node：$node（$(& $node -v)）"
    } elseif ($NoNode) {
      throw "需要 Node.js $NodeMin+（推荐 24），本机没有满足要求的 node。装好后重试，或去掉 -NoNode 让脚本自动下载。"
    } else {
      $node = Install-Node $root $work
    }

    $versionDir = Join-Path $root "versions\$release"
    $zipName = "jingjing-app-$release.zip"
    $zipUrl = "$ReleaseBase/download/v$release/$zipName"
    if ($DryRun) {
      Info "（演练）程序目录：$versionDir"
      Info "（演练）数据目录：$dataDir"
      Info "（演练）Node：$node"
      Info "（演练）下载：$zipUrl"
      return
    }

    if (Test-Path -LiteralPath (Join-Path $versionDir 'server.js')) {
      Info "v$release 已经在 $versionDir，跳过下载"
    } else {
      $zip = Join-Path $work $zipName
      Info "下载代码包：$zipUrl"
      Get-Download $zipUrl $zip
      if (-not $meta.sha256) { throw 'Release 清单里没有 sha256 字段' }
      Assert-Sha256 ([string]$meta.sha256) $zip
      $extract = Join-Path $work 'extract'
      Expand-Zip $zip $extract
      if (-not (Test-Path -LiteralPath (Join-Path $extract 'app\server.js'))) { throw '代码包里没有 app\server.js' }
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'versions') | Out-Null
      if (Test-Path -LiteralPath $versionDir) { Remove-Item -LiteralPath $versionDir -Recurse -Force }
      Move-Item -LiteralPath (Join-Path $extract 'app') -Destination $versionDir
    }

    New-Item -ItemType Directory -Force -Path (Join-Path $root 'bin'), $dataDir | Out-Null
    Set-CurrentLink $root $versionDir
    Write-Launcher $root $dataDir $node
    $launcher = Join-Path $root 'bin\jingjing.cmd'
    $pathAdded = $false
    if (-not $NoPath) { $pathAdded = Add-UserPath (Join-Path $root 'bin') }

    Write-Host ''
    Write-Host "静静已安装  v$release" -ForegroundColor White
    Write-Host ''
    Write-Host "  程序目录：   $versionDir"
    Write-Host "  当前版本：   $(Join-Path $root 'current')"
    Write-Host "  数据目录：   $dataDir"
    Write-Host "  启动命令：   $launcher"
    Write-Host ''
    Write-Host '接下来：'
    Write-Host ''
    Write-Host '  1. jingjing                  # 前台启动（Ctrl+C 停止）'
    Write-Host "  2. 打开 http://127.0.0.1:$Port"
    Write-Host "     第一次启动后配对码在 $(Join-Path $dataDir 'access-key')"
    Write-Host '     或者直接：jingjing url   /   jingjing open'
    Write-Host ''
    Write-Host '想让它常驻、登录后自动在后台启动：'
    Write-Host ''
    Write-Host '  jingjing service install     # 卸载：jingjing service uninstall'
    Write-Host ''
    if ($pathAdded) {
      Write-Host "已把 $(Join-Path $root 'bin') 加进用户 PATH：新开一个终端窗口就能直接用 jingjing 命令。" -ForegroundColor Yellow
    } elseif ($NoPath) {
      Write-Host "没有改 PATH：用完整路径 $launcher 启动。" -ForegroundColor Yellow
    }
    Write-Host ''

    if ($Service) {
      Info '装成常驻服务'
      & (Join-Path $root 'current\scripts\windows-service.ps1') -Action install -Node $node -AppDir (Join-Path $root 'current') -DataDir $dataDir -ListenHost $ListenHost -Port $Port
    }
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($Help) {
  Show-Usage
  return
}

try {
  Install-Jingjing
} catch {
  Write-Host "安装失败：$($_.Exception.Message)" -ForegroundColor Red
  # 用 -File 运行时退出码 1；被 irm | iex 直接执行时不要关掉用户的 PowerShell 窗口。
  if ($PSCommandPath) { exit 1 }
}

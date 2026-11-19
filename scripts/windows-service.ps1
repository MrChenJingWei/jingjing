<#
把静静装成 Windows 上的常驻服务：登录后自动在后台启动、崩溃了自动拉起（相当于 macOS 的 LaunchAgent）。

不需要管理员权限：开机项写在当前用户的注册表 Run 键里（任务管理器 →「启动应用」里能看到、能停用）。
它启动的是一个隐藏窗口的 PowerShell 守护循环（本脚本 -Action run），由它拉起 node server.js，
node 退出了过几秒再拉起来；日志在 <数据目录>\logs\server.log / server.err.log，上一轮的日志留在 .1 里。

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Action install
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Action uninstall
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Action status

参数（都可以不填）：-Node <node.exe>  -AppDir <程序目录>  -DataDir <数据目录>  -ListenHost 0.0.0.0  -Port 7777
不填时依次读环境变量 JINGJING_NODE / JINGJING_DATA_DIR / JINGJING_HOST / JINGJING_PORT。-DryRun 只打印要写入的开机命令。
#>
param(
  [ValidateSet('install', 'uninstall', 'status', 'run')]
  [string]$Action = 'install',
  [string]$Node = '',
  [string]$AppDir = '',
  [string]$DataDir = '',
  [string]$ListenHost = '',
  [int]$Port = 0,
  [string]$Name = 'Jingjing',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Get-FullPath([string]$value) {
  return [IO.Path]::GetFullPath($value).TrimEnd('\')
}

if (-not $AppDir) { $AppDir = Split-Path -Parent $PSScriptRoot }
$AppDir = Get-FullPath $AppDir
if (-not $DataDir) { $DataDir = if ($env:JINGJING_DATA_DIR) { $env:JINGJING_DATA_DIR } else { Join-Path $AppDir 'data' } }
$DataDir = Get-FullPath $DataDir
if (-not $ListenHost) { $ListenHost = if ($env:JINGJING_HOST) { $env:JINGJING_HOST } else { '0.0.0.0' } }
if (-not $Port) { $Port = if ($env:JINGJING_PORT) { [int]$env:JINGJING_PORT } else { 7777 } }
$PidFile = Join-Path $DataDir 'service.pid'
$LogDir = Join-Path $DataDir 'logs'

# 命令行参数加引号：结尾的反斜杠要成对，否则会把收尾的引号转义掉（C 运行库的规则）。
function Quote([string]$value) {
  return '"' + ($value -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-Quiet([string]$file, [string[]]$arguments) {
  # Windows PowerShell 5.1 里 $ErrorActionPreference = Stop 时，原生命令往 stderr 写一行就会变成异常。
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $file @arguments 2>&1 | Out-Null } finally { $ErrorActionPreference = $saved }
}

function Resolve-Node {
  $candidate = $Node
  if (-not $candidate -and $env:JINGJING_NODE) { $candidate = $env:JINGJING_NODE }
  if (-not $candidate) {
    $found = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $candidate = $found.Path }
  }
  if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) {
    throw '找不到 node.exe。请先安装 Node.js 24（或 23.4+），或者用 -Node 指定它的路径。'
  }
  $version = (& $candidate -v) -replace '^v', ''
  if ([version]($version -replace '[-+].*$', '') -lt [version]'23.4.0') {
    throw "当前 Node 是 $version，静静需要 23.4+。"
  }
  return (Get-FullPath $candidate)
}

function Get-PowerShellExe {
  return (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
}

function Get-RunArguments([string]$nodeExe) {
  $script = Join-Path $AppDir 'scripts\windows-service.ps1'
  return "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote $script) -Action run " +
    "-Node $(Quote $nodeExe) -AppDir $(Quote $AppDir) -DataDir $(Quote $DataDir) -ListenHost $(Quote $ListenHost) -Port $Port -Name $(Quote $Name)"
}

# 结束守护循环和它拉起的 node（连同 node 派生的 Worker 进程）。pid 文件可能是旧的、pid 已经被别的程序复用，
# 所以先核对命令行确实是静静的，再结束。
function Stop-Supervisor {
  if (-not (Test-Path -LiteralPath $PidFile)) { return }
  foreach ($line in Get-Content -LiteralPath $PidFile) {
    $id = 0
    if (-not [int]::TryParse(([string]$line).Trim(), [ref]$id) -or $id -le 0) { continue }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -and ($proc.CommandLine -like '*windows-service.ps1*' -or $proc.CommandLine -like '*server.js*')) {
      Invoke-Quiet 'taskkill.exe' @('/PID', "$id", '/T', '/F')
    }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Show-Urls {
  Write-Host "  本机：   http://127.0.0.1:$Port"
  if ($ListenHost -eq '0.0.0.0') {
    try {
      Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
        Select-Object -First 3 |
        ForEach-Object { Write-Host "  局域网： http://$($_.IPAddress):$Port" }
    } catch { }
  }
}

switch ($Action) {
  'install' {
    $nodeExe = Resolve-Node
    $ps = Get-PowerShellExe
    $arguments = Get-RunArguments $nodeExe
    $command = "$(Quote $ps) $arguments"
    if ($DryRun) {
      Write-Output $command
      return
    }
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'server.js'))) { throw "程序目录里没有 server.js：$AppDir" }
    Stop-Supervisor
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Set-ItemProperty -Path $RunKey -Name $Name -Value $command
    Start-Process -FilePath $ps -ArgumentList $arguments -WindowStyle Hidden
    Start-Sleep -Seconds 2
    Write-Host ''
    Write-Host "静静已经装成常驻服务（登录后自动启动，开机项名称：$Name）。"
    Show-Urls
    Write-Host "  日志：   $(Join-Path $LogDir 'server.log')"
    Write-Host '  第一次启动时 Windows 防火墙可能会问要不要允许 node 联网：要手机访问就点「允许」。'
    Write-Host ''
    Write-Host "停止并卸载：powershell -NoProfile -ExecutionPolicy Bypass -File $(Quote (Join-Path $AppDir 'scripts\windows-service.ps1')) -Action uninstall"
  }

  'uninstall' {
    Remove-ItemProperty -Path $RunKey -Name $Name -ErrorAction SilentlyContinue
    Stop-Supervisor
    Write-Host "已卸载 ${Name}：不再开机自启，后台的服务也停了。程序文件和数据库都没有动。"
  }

  'status' {
    $entry = (Get-ItemProperty -Path $RunKey -Name $Name -ErrorAction SilentlyContinue).$Name
    if ($entry) { Write-Host "开机自启：已开启（$Name）" } else { Write-Host '开机自启：没有安装' }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
      Write-Host "服务：在运行（v$($health.version)）"
    } catch {
      Write-Host '服务：没有在运行'
    }
  }

  'run' {
    # 同一个数据目录只跑一个守护循环（重复点了安装、登录时又被拉起一次都不会多开）。
    $sha = [Security.Cryptography.SHA1]::Create()
    $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($DataDir.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
    $mutex = New-Object System.Threading.Mutex($false, "Local\Jingjing-$hash")
    # 上一个守护循环被强制结束时互斥量是「遗弃」状态，WaitOne 会抛异常，但其实已经拿到了。
    try { $owned = $mutex.WaitOne(0) } catch { $owned = $true }
    if (-not $owned) { return }

    $nodeExe = Resolve-Node
    $env:JINGJING_DATA_DIR = $DataDir
    $env:JINGJING_HOST = $ListenHost
    $env:JINGJING_PORT = "$Port"
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $out = Join-Path $LogDir 'server.log'
    $err = Join-Path $LogDir 'server.err.log'
    $server = Join-Path $AppDir 'server.js'
    while ($true) {
      foreach ($file in @($out, $err)) {
        if (Test-Path -LiteralPath $file) { Move-Item -LiteralPath $file -Destination "$file.1" -Force }
      }
      $started = Get-Date
      # 这个 PowerShell 的窗口是隐藏的，-NoNewWindow 让 node 共用它，也就不会弹出窗口。
      $child = Start-Process -FilePath $nodeExe -ArgumentList (Quote $server) -WorkingDirectory $AppDir -NoNewWindow -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
      Set-Content -LiteralPath $PidFile -Value @("$PID", "$($child.Id)") -Encoding ASCII
      $child.WaitForExit()
      # 刚起来就退出（端口被占、另一个静静已经在跑……）：等久一点再试，别一直刷日志。
      $delay = if (((Get-Date) - $started).TotalSeconds -lt 15) { 30 } else { 5 }
      Start-Sleep -Seconds $delay
    }
  }
}

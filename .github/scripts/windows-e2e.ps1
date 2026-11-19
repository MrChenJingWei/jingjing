# Windows 上端到端走一遍（CI 用）：
#   打一个本地 Release（和 scripts/package-update.sh 同样的内容）→ install.ps1 安装 → jingjing 启动命令能起服务 →
#   jingjing service install 装成常驻服务能起来 → service uninstall 卸掉后服务停下、开机项删掉。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }) 'jj-e2e'
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
$version = (Get-Content -Raw (Join-Path $repo 'package.json') | ConvertFrom-Json).version
$release = Join-Path $temp "release\download\v$version"
$stage = Join-Path $temp 'stage'
$prefix = Join-Path $temp 'cli'
$port = 17781
New-Item -ItemType Directory -Force -Path $release, $stage | Out-Null

# 输出都记一份：失败时连同出错的步骤一起打成 GitHub 注解（下载 Actions 日志要管理员权限，注解谁都能看）。
$script:transcript = New-Object System.Collections.Generic.List[string]
$script:currentStep = '准备'

function Say([string]$message) {
  Write-Host $message
  $script:transcript.Add($message)
}

function Step([string]$message) {
  $script:currentStep = $message
  Say "`n==> $message"
}

# 跑一个命令行程序，stdout 和 stderr 都记下来；退出码不是 0 就失败。
# （Windows PowerShell 5.1 在 Stop 模式下把 stderr 当异常，收集时临时换成 Continue。）
function Invoke-Logged([string]$file, [string[]]$arguments) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $text = (& $file @arguments 2>&1 | ForEach-Object { "$_" } | Out-String).TrimEnd()
  } finally {
    $ErrorActionPreference = $saved
  }
  if ($text) { Say $text }
  if ($LASTEXITCODE -ne 0) { throw "$(Split-Path -Leaf $file) $($arguments -join ' ') 退出码 $LASTEXITCODE" }
  return $text
}

function Wait-Health([bool]$up, [int]$seconds = 45) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $ok = $false
    try { $ok = [bool](Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2).ok } catch { }
    if ($ok -eq $up) { return }
    Start-Sleep -Seconds 1
  }
  throw "等了 $seconds 秒，服务仍然$(if ($up) { '没有起来' } else { '没有停下' })"
}

function Show-Logs([string]$dir) {
  foreach ($file in Get-ChildItem -Path $dir -Filter '*.log*' -ErrorAction SilentlyContinue) {
    Say "--- $($file.Name)"
    Say ((Get-Content $file.FullName -Tail 40) -join "`n")
  }
}

try {
Step "打本地 Release v$version"
$exclude = @('data', 'dist', 'docs', 'tests', 'packaging', '.git', '.github', '.toolchain', 'node_modules', 'plugin-src', 'inbox')
robocopy $repo (Join-Path $stage 'app') /E /XD @($exclude | ForEach-Object { Join-Path $repo $_ }) /XF .DS_Store /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（$LASTEXITCODE）" }
$zip = Join-Path $release "jingjing-app-$version.zip"
& tar.exe -a -c -f $zip -C $stage app
if ($LASTEXITCODE -ne 0) { throw '打包失败' }
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
@{ version = $version; sha256 = $sha; notes = 'e2e' } | ConvertTo-Json | Set-Content -Encoding ASCII (Join-Path $release 'latest.json')
# 本地 Release 用 node 起一个静态文件服务（不依赖 runner 上有没有 Python）。
$serve = Join-Path $temp 'serve.cjs'
Set-Content -Encoding ASCII -Path $serve -Value @'
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2];
http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  fs.readFile(file, (err, data) => { res.writeHead(err ? 404 : 200); res.end(err ? '' : data); });
}).listen(18080, '127.0.0.1');
'@
$server = Start-Process node -ArgumentList "`"$serve`"", "`"$(Join-Path $temp 'release')`"" -PassThru -WindowStyle Hidden

try {
  Start-Sleep -Seconds 2
  Step 'install.ps1 安装'
  $env:JINGJING_RELEASE_BASE = 'http://127.0.0.1:18080'
  $installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repo 'scripts\install.ps1'), '-Version', "v$version", '-Prefix', $prefix, '-ListenHost', '127.0.0.1', '-Port', "$port", '-NoPath')
  Invoke-Logged 'powershell.exe' $installArgs | Out-Null
  $jingjing = Join-Path $prefix 'bin\jingjing.cmd'
  if (-not (Test-Path $jingjing)) { throw "没有生成 $jingjing" }
  $reported = (Invoke-Logged $jingjing @('version')).Trim()
  if ($reported -ne $version) { throw "jingjing version 输出 $reported，期望 $version" }

  Step '再装一次（覆盖 current 联接，不重复下载）'
  Invoke-Logged 'powershell.exe' $installArgs | Out-Null

  Step 'jingjing start 前台启动'
  $fgLogs = Join-Path $temp 'fg-logs'
  New-Item -ItemType Directory -Force -Path $fgLogs | Out-Null
  $fg = Start-Process cmd.exe -ArgumentList '/d', '/c', "`"$jingjing`" start" -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $fgLogs 'start.log') -RedirectStandardError (Join-Path $fgLogs 'start.err.log')
  try {
    Wait-Health $true
    $url = (Invoke-Logged $jingjing @('url')).Trim()
    if ($url -notmatch "^http://127\.0\.0\.1:$port/pair\?key=") { throw "jingjing url 输出不对：$url" }
  } catch {
    Show-Logs $fgLogs
    throw
  } finally {
    & taskkill.exe /PID $fg.Id /T /F | Out-Null
  }
  Wait-Health $false

  Step 'jingjing service install'
  Invoke-Logged $jingjing @('service', 'install') | Out-Null
  $entry = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name Jingjing -ErrorAction SilentlyContinue).Jingjing
  if (-not $entry) { throw '没有写入开机项' }
  try {
    Wait-Health $true
  } catch {
    Show-Logs (Join-Path $prefix 'data\logs')
    throw
  }

  Step 'jingjing service uninstall'
  Invoke-Logged $jingjing @('service', 'uninstall') | Out-Null
  Wait-Health $false
  if ((Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name Jingjing -ErrorAction SilentlyContinue)) { throw '开机项没有删掉' }
  Say "`nWindows 端到端通过。"
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
} catch {
  $detail = ($_ | Out-String).Trim()
  $tail = ($script:transcript -join "`n")
  if ($tail.Length -gt 6000) { $tail = $tail.Substring($tail.Length - 6000) }
  $message = "$detail`n`n----- 输出 -----`n$tail"
  $escaped = $message.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
  Write-Host "::error title=Windows 端到端失败（$($script:currentStep)）::$escaped"
  exit 1
}

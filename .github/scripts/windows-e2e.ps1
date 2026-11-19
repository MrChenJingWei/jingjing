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

function Step([string]$message) { Write-Host "`n==> $message" -ForegroundColor Green }

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
    Write-Host "--- $($file.Name)"
    Get-Content $file.FullName -Tail 40
  }
}

Step "打本地 Release v$version"
$exclude = @('data', 'dist', 'docs', 'tests', 'packaging', '.git', '.github', '.toolchain', 'node_modules', 'plugin-src', 'inbox')
robocopy $repo (Join-Path $stage 'app') /E /XD @($exclude | ForEach-Object { Join-Path $repo $_ }) /XF .DS_Store /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（$LASTEXITCODE）" }
$zip = Join-Path $release "jingjing-app-$version.zip"
& tar.exe -a -c -f $zip -C $stage app
if ($LASTEXITCODE -ne 0) { throw '打包失败' }
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
@{ version = $version; sha256 = $sha; notes = 'e2e' } | ConvertTo-Json | Set-Content -Encoding ASCII (Join-Path $release 'latest.json')
$server = Start-Process python -ArgumentList '-m', 'http.server', '18080', '--bind', '127.0.0.1', '--directory', (Join-Path $temp 'release') -PassThru -WindowStyle Hidden

try {
  Start-Sleep -Seconds 2
  Step 'install.ps1 安装'
  $env:JINGJING_RELEASE_BASE = 'http://127.0.0.1:18080'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\install.ps1') -Version "v$version" -Prefix $prefix -ListenHost 127.0.0.1 -Port $port -NoPath
  if ($LASTEXITCODE -ne 0) { throw "install.ps1 退出码 $LASTEXITCODE" }
  $jingjing = Join-Path $prefix 'bin\jingjing.cmd'
  if (-not (Test-Path $jingjing)) { throw "没有生成 $jingjing" }
  $reported = (& $jingjing version | Out-String).Trim()
  if ($reported -ne $version) { throw "jingjing version 输出 $reported，期望 $version" }

  Step '再装一次（覆盖 current 联接，不重复下载）'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\install.ps1') -Version "v$version" -Prefix $prefix -ListenHost 127.0.0.1 -Port $port -NoPath
  if ($LASTEXITCODE -ne 0) { throw "第二次 install.ps1 退出码 $LASTEXITCODE" }

  Step 'jingjing start 前台启动'
  $fg = Start-Process cmd.exe -ArgumentList '/d', '/c', "`"$jingjing`" start" -PassThru -WindowStyle Hidden
  try {
    Wait-Health $true
    $url = (& $jingjing url | Out-String).Trim()
    if ($url -notmatch "^http://127\.0\.0\.1:$port/pair\?key=") { throw "jingjing url 输出不对：$url" }
  } finally {
    & taskkill.exe /PID $fg.Id /T /F | Out-Null
  }
  Wait-Health $false

  Step 'jingjing service install'
  & $jingjing service install
  $entry = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name Jingjing -ErrorAction SilentlyContinue).Jingjing
  if (-not $entry) { throw '没有写入开机项' }
  try {
    Wait-Health $true
  } catch {
    Show-Logs (Join-Path $prefix 'data\logs')
    throw
  }

  Step 'jingjing service uninstall'
  & $jingjing service uninstall
  Wait-Health $false
  if ((Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name Jingjing -ErrorAction SilentlyContinue)) { throw '开机项没有删掉' }
  Write-Host "`nWindows 端到端通过。" -ForegroundColor Green
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}

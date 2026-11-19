#!/usr/bin/env node
/**
 * npm run service:install / service:uninstall：把从源码跑的静静装成常驻服务。
 *   macOS：LaunchAgent（scripts/install-service.sh），开机自启、崩溃自动拉起；
 *   Windows：登录后自动在后台启动、崩溃自动拉起（scripts/windows-service.ps1，不需要管理员权限）；
 *   Linux：没有内置，用 systemd 托管。
 * 用跑这个脚本的 node 作为服务的运行时。
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2] === 'uninstall' ? 'uninstall' : 'install';

let result;
if (process.platform === 'win32') {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  result = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'scripts', 'windows-service.ps1'),
    '-Action', action,
    '-Node', process.env.JINGJING_NODE || process.execPath,
    '-AppDir', ROOT
  ], { stdio: 'inherit' });
} else if (process.platform === 'darwin') {
  const script = action === 'install' ? 'install-service.sh' : 'uninstall-service.sh';
  result = spawnSync('bash', [path.join(ROOT, 'scripts', script)], {
    stdio: 'inherit',
    env: { ...process.env, JINGJING_NODE: process.env.JINGJING_NODE || process.execPath }
  });
} else {
  console.error('Linux 上没有内置的常驻服务，可以用 systemd 托管：');
  console.error(`  ExecStart=${process.execPath} ${path.join(ROOT, 'server.js')}（WorkingDirectory=${ROOT}）`);
  process.exit(1);
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

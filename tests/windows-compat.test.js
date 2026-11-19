// Windows 兼容：找命令（PATHEXT）、.cmd 包装脚本、cmd.exe 转义。这些逻辑都能注入平台参数，在任何系统上都能测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCommand, resolveSpawn, shimTarget, escapeCmdArg, extraBinDirs, runCommand } from '../src/worker-runtime.js';

function sandbox(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-win-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

// npm（cmd-shim）生成的 claude.cmd，原样照抄。
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ''
].join('\r\n');

// pnpm 生成的包装脚本。
const PNPM_SHIM = [
  '@SETLOCAL',
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ')'
].join('\r\n');

test('findCommand：Windows 按 PATHEXT 补扩展名，不认没有扩展名的 sh 脚本', () => {
  const root = sandbox({ 'npm/claude': '#!/bin/sh\n', 'npm/claude.cmd': NPM_SHIM, 'bin/codex.exe': 'MZ' });
  try {
    const env = { PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' };
    const dirs = [path.join(root, 'npm'), path.join(root, 'bin')];
    assert.equal(findCommand('claude', { platform: 'win32', env, dirs }), path.join(root, 'npm', 'claude.cmd'));
    assert.equal(findCommand('codex', { platform: 'win32', env, dirs }), path.join(root, 'bin', 'codex.exe'));
    assert.equal(findCommand('missing', { platform: 'win32', env, dirs }), null);
    // 已经带了扩展名、或者给的是完整路径，就按原样找。
    assert.equal(findCommand('claude.cmd', { platform: 'win32', env, dirs }), path.join(root, 'npm', 'claude.cmd'));
    assert.equal(findCommand(path.join(root, 'bin', 'codex'), { platform: 'win32', env }), path.join(root, 'bin', 'codex.exe'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findCommand：macOS / Linux 只认可执行文件', { skip: process.platform === 'win32' }, () => {
  const root = sandbox({ 'bin/tool': '#!/bin/sh\necho ok\n', 'bin/plain': 'not executable' });
  try {
    fs.chmodSync(path.join(root, 'bin', 'tool'), 0o755);
    const dirs = [path.join(root, 'bin')];
    assert.equal(findCommand('tool', { platform: 'darwin', dirs }), path.join(root, 'bin', 'tool'));
    assert.equal(findCommand('plain', { platform: 'darwin', dirs }), null);
    assert.equal(findCommand('tool', { platform: 'darwin', env: { PATH: dirs[0] } }), path.join(root, 'bin', 'tool'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extraBinDirs：Windows 上包含 Claude Code 原生安装和 npm 全局目录', () => {
  const dirs = extraBinDirs({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, home: 'C:\\Users\\me' });
  assert.ok(dirs.includes('C:\\Users\\me\\.local\\bin'));
  assert.ok(dirs.includes('C:\\Users\\me\\AppData\\Roaming\\npm'));
  assert.ok(!dirs.some((dir) => dir.startsWith('/')), 'Windows 上不该出现 /opt/homebrew 这类目录');
});

test('shimTarget / resolveSpawn：npm 和 pnpm 的 .cmd 改成用 node 直接跑背后的 js，参数里的换行原样保留', () => {
  const root = sandbox({
    'npm/claude.cmd': NPM_SHIM,
    'npm/node_modules/@anthropic-ai/claude-code/cli.js': '',
    'pnpm/codex.cmd': PNPM_SHIM,
    'pnpm/global/5/node_modules/@openai/codex/bin/codex.js': ''
  });
  try {
    const claudeJs = path.join(root, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    assert.equal(shimTarget(path.join(root, 'npm', 'claude.cmd')), claudeJs);
    const prompt = '第一行\n第二行 "带引号" & 符号';
    const spawned = resolveSpawn(path.join(root, 'npm', 'claude.cmd'), ['-p', prompt], { platform: 'win32', node: 'C:\\node\\node.exe' });
    assert.equal(spawned.cmd, 'C:\\node\\node.exe');
    assert.deepEqual(spawned.args, [claudeJs, '-p', prompt]);
    assert.deepEqual(spawned.options, {});

    const codex = resolveSpawn(path.join(root, 'pnpm', 'codex.cmd'), ['exec'], { platform: 'win32', node: 'node.exe' });
    assert.deepEqual(codex.args, [path.join(root, 'pnpm', 'global', '5', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'exec']);

    // 不是 Windows、不是 .cmd 时原样返回。
    assert.deepEqual(resolveSpawn('/usr/local/bin/claude', ['-p', 'x'], { platform: 'darwin' }), { cmd: '/usr/local/bin/claude', args: ['-p', 'x'], options: {} });
    assert.equal(resolveSpawn('C:\\bin\\claude.exe', [], { platform: 'win32' }).cmd, 'C:\\bin\\claude.exe');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSpawn：认不出来的 .cmd 退回 cmd.exe，参数按 cmd 的规则转义', () => {
  const root = sandbox({ 'tools/custom.cmd': '@echo off\r\necho %*\r\n' });
  try {
    const file = path.join(root, 'tools', 'custom.cmd');
    const spawned = resolveSpawn(file, ['a b', 'x&y'], { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' });
    assert.equal(spawned.cmd, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepEqual(spawned.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(spawned.options.windowsVerbatimArguments, true);
    assert.ok(spawned.args[3].includes('^"a^ b^"'), spawned.args[3]);
    assert.ok(spawned.args[3].includes('^"x^&y^"'), spawned.args[3]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // cmd.exe 的元字符都用 ^ 转义，引号和结尾的反斜杠按 C 运行库的规则处理。
  assert.equal(escapeCmdArg('100%'), '^"100^%^"');
  assert.equal(escapeCmdArg('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(escapeCmdArg('C:\\dir\\'), '^"C:\\dir\\\\^"');
  assert.equal(escapeCmdArg('两行\n文字'), '^"两行^ 文字^"');
});

test('runCommand：真的跑一个子进程，停止时能结束它', async () => {
  const done = await runCommand(process.execPath, ['-e', 'process.stdout.write("你好")']);
  assert.equal(done.code, 0);
  assert.equal(done.stdout, '你好');

  const controller = new AbortController();
  const pending = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  const stopped = await pending;
  assert.equal(stopped.error, 'aborted');
});

test('PowerShell 脚本带 UTF-8 BOM：Windows PowerShell 5.1 没有 BOM 时按系统代码页读，中文会乱、甚至解析出错', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = ['scripts', path.join('.github', 'scripts')].flatMap((dir) => fs.readdirSync(path.join(root, dir))
    .filter((name) => name.endsWith('.ps1'))
    .map((name) => path.join(root, dir, name)));
  assert.ok(files.length >= 3, '至少有 install.ps1、windows-service.ps1 和 CI 的端到端脚本');
  for (const file of files) {
    assert.deepEqual([...fs.readFileSync(file).subarray(0, 3)], [0xef, 0xbb, 0xbf], `${path.relative(root, file)} 缺少 BOM`);
  }
});

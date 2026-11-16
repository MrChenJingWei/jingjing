// DeepSeek Harness Worker：查找安装位置、缺 Key 的提示、调用参数。用假的 ctx.exec，不会调用真实的 dsh。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findHarness, detect, execute } from '../workers/dsh/index.js';
import { estimateTokens } from '../src/worker-runtime.js';

function fakeApp() {
  const apps = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jj-dsh-')), 'Applications');
  const cli = path.join(apps, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '#!/bin/sh\n');
  fs.chmodSync(cli, 0o755);
  return { appDirs: [apps], cli };
}

test('findHarness：Harness 环境变量优先，其次 PATH 里的 dsh，最后 App 包', () => {
  const { appDirs, cli } = fakeApp();
  const inHarness = findHarness({
    which: () => '/usr/local/bin/dsh',
    env: { DSH_NODE_EXECUTABLE: '/h/node', DSH_INSTALL_DIR: '/h/install', DSH_HOME: '/h/home' },
    platform: 'darwin',
    appDirs
  });
  assert.equal(inHarness.cmd, '/h/node');
  assert.deepEqual(inHarness.args, ['/h/install/lib/bin.js']);
  assert.equal(inHarness.env.DSH_HOME, '/h/home');

  const onPath = findHarness({ which: () => '/usr/local/bin/dsh', env: {}, platform: 'darwin', appDirs });
  assert.equal(onPath.cmd, '/usr/local/bin/dsh');

  // 只装了桌面 App、没有链命令行工具：用 App 自带的启动脚本。
  const fromApp = findHarness({ which: () => null, env: {}, platform: 'darwin', appDirs });
  assert.equal(fromApp.cmd, cli);
  assert.deepEqual(fromApp.args, []);

  assert.equal(findHarness({ which: () => null, env: {}, platform: 'linux', appDirs }), null);
});

test('detect：找到 Harness 但静静没有 DeepSeek Key 时说明原因', () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const which = () => '/usr/local/bin/dsh';
    const noKey = detect({}, { which, llm: { mode: 'demo' } });
    assert.equal(noKey.available, false);
    assert.match(noKey.detail, /API Key/);
    assert.equal(detect({}, { which, llm: { mode: 'deepseek' } }).available, true);
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
  }
});

function fakeCtx(output) {
  const calls = [];
  const ctx = {
    which: () => '/usr/local/bin/dsh',
    secrets: { apiKey: 'sk-test' },
    workspace: '/tmp/ws',
    emit: async () => {},
    exec: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { code: 0, stdout: '', stderr: '', ...output };
    },
    estimateTokens
  };
  return { ctx, calls };
}

test('execute：在工作区里跑 dsh headless，并把静静的 Key 交给子进程', async () => {
  const { ctx, calls } = fakeCtx({ stdout: '\x1b[32m改好了\x1b[0m\n' });
  const result = await execute({ prompt: '修一下测试' }, ctx);
  assert.equal(result.status, 'done');
  assert.equal(result.summary, '改好了');
  assert.equal(calls[0].cmd, '/usr/local/bin/dsh');
  assert.deepEqual(calls[0].args, ['headless', '修一下测试']);
  assert.equal(calls[0].options.cwd, '/tmp/ws');
  assert.equal(calls[0].options.env.DEEPSEEK_API_KEY, 'sk-test');
  assert.equal(calls[0].options.env.DSH_SESSION_ID, null);
});

test('execute：dsh 启动失败但退出码是 0 时按失败处理', async () => {
  const { ctx } = fakeCtx({ stderr: 'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"\n' });
  const result = await execute({ prompt: 'hi' }, ctx);
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
  assert.match(result.summary, /MISSING_CREDENTIAL/);
});

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
    const noKey = detect({}, { which });
    assert.equal(noKey.available, false);
    assert.match(noKey.detail, /API Key/);
    // 只认这个 Worker 自己的 Key：静静运行模式那把配没配都不影响它。
    assert.equal(detect({}, { which, llm: { mode: 'openai', hasKey: true } }).available, false);
    assert.equal(detect({ apiKey: 'sk-dsh' }, { which }).available, true);
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    assert.equal(detect({}, { which }).available, true, '环境变量也算这个 Worker 的 Key');
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
    else delete process.env.DEEPSEEK_API_KEY;
  }
});

function fakeCtx(output, { stream = false } = {}) {
  const calls = [];
  const emitted = [];
  const ctx = {
    which: () => '/usr/local/bin/dsh',
    config: { apiKey: 'sk-test' },
    workspace: '/tmp/ws',
    emit: async (message) => { emitted.push(message); },
    exec: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (stream) {
        const text = String(output.stdout || '');
        for (let i = 0; i < text.length; i += 40) options.onOutput?.(text.slice(i, i + 40));
      }
      return { code: 0, stdout: '', stderr: '', ...output };
    },
    estimateTokens
  };
  return { ctx, calls, emitted };
}

const jsonLines = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const dshEvents = [
  { type: 'session', sessionId: 'session-1', cwd: '/tmp/ws' },
  { type: 'status', phase: 'turn_start', turn: 1 },
  { type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'npm test' } },
  { type: 'tool_result', callId: 'c1', status: 'ok', result: 'pass' },
  { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { totalTokens: 7658 } },
  { type: 'text', text: '改好了' },
  { type: 'final', sessionId: 'session-1', reason: { kind: 'completed' }, text: '改好了' }
];

test('execute：在工作区里跑 dsh headless --json，并把它自己的 Key 交给子进程', async () => {
  const { ctx, calls } = fakeCtx({ stdout: jsonLines(dshEvents) });
  const result = await execute({ prompt: '修一下测试' }, ctx);
  assert.equal(result.status, 'done');
  assert.equal(result.summary, '改好了');
  assert.equal(result.tokens, 7658, '用 Harness 报的 token 数');
  assert.equal(calls[0].cmd, '/usr/local/bin/dsh');
  assert.deepEqual(calls[0].args, ['headless', '--json', '修一下测试']);
  assert.equal(calls[0].options.cwd, '/tmp/ws');
  assert.equal(calls[0].options.env.DEEPSEEK_API_KEY, 'sk-test');
  assert.equal(calls[0].options.env.DSH_SESSION_ID, null);
});

test('execute：不读“运行模式”那把 Key，只认这个 Worker 自己的配置', async () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const { ctx, calls } = fakeCtx({ stdout: '' });
    ctx.config = {};
    ctx.secrets = { apiKey: 'sk-from-run-mode' };
    const result = await execute({ prompt: 'x' }, ctx);
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /这个 Worker 的「配置」/);
    assert.equal(calls.length, 0, '没有自己的 Key 时不该启动 dsh');
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
  }
});

test('execute：边跑边把 Harness 的步骤转成进度，最终结果不重复', async () => {
  const { ctx, calls, emitted } = fakeCtx({ stdout: jsonLines(dshEvents) }, { stream: true });
  const result = await execute({ prompt: '修一下测试' }, ctx);
  assert.equal(result.summary, '改好了');
  assert.ok(emitted.some((message) => message.includes('bash') && message.includes('npm test')), '工具调用要出现在进度里');
  assert.equal(emitted.filter((message) => message === '改好了').length <= 1, true, '进度不重复刷同一句');
  assert.equal(calls[0].options.onOutput instanceof Function, true);
});

test('execute：Harness 输出不是 JSON 时退回原文', async () => {
  const { ctx } = fakeCtx({ stdout: '\x1b[32m改好了\x1b[0m\n' });
  const result = await execute({ prompt: '修一下测试' }, ctx);
  assert.equal(result.status, 'done');
  assert.equal(result.summary, '改好了');
});

test('execute：Harness 没正常结束（非 completed）时按失败处理', async () => {
  const { ctx } = fakeCtx({ stdout: jsonLines([
    { type: 'text', text: '做到一半' },
    { type: 'final', reason: { kind: 'error' }, text: '做到一半' }
  ]) });
  const result = await execute({ prompt: '修一下测试' }, ctx);
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /error/);
});

test('execute：dsh 启动失败但退出码是 0 时按失败处理', async () => {
  const { ctx } = fakeCtx({ stderr: 'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"\n' });
  const result = await execute({ prompt: 'hi' }, ctx);
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
  assert.match(result.summary, /MISSING_CREDENTIAL/);
});

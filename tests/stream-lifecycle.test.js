// 长连接插件：start() 有时间上限、超时后才连上的会被关掉；ctx.fail 后按退避自动重启；
// retry: false 停在错误状态；停掉以后旧连接迟到的 ingest / status / fail 一律忽略。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-stream-'));
process.env.JINGJING_DATA_DIR = dataDir;

const plugins = await import('../src/plugins.js');
const discovery = await import('../src/discovery.js');

test.after(() => removeTemp(dataDir));

Object.assign(discovery.limits, { startMs: 80, stopMs: 80, restartBaseMs: 40, restartMaxMs: 200, stableMs: 60 * 1000 });

// 插件的行为由测试通过 globalThis.__stream 控制。
const dir = path.join(plugins.USER_PLUGIN_DIR, 'stream-test');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'stream-test', name: '长连接测试', version: '0.1.0', entry: 'index.js', type: 'stream', lifecycle: true }));
fs.writeFileSync(path.join(dir, 'index.js'), [
  'export async function poll() { return { items: [] }; }',
  'export async function start(config, ctx) { return globalThis.__stream.start(ctx); }',
  ''
].join('\n'));
await plugins.reloadPlugins();
plugins.savePlugin('stream-test', { enabled: true });

const row = () => plugins.getPlugin('stream-test').row;
async function waitFor(fn, label, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

test('start() 卡住：按超时失败并自动重试；超时后才连上的连接会被立刻关掉', async () => {
  const starts = [];
  const stopped = [];
  globalThis.__stream = {
    start: (ctx) => new Promise((resolve) => starts.push({ ctx, resolve }))
  };
  const first = await discovery.startLifecycle('stream-test');
  assert.equal(first.running, false);
  assert.match(first.error, /还没建立/);
  assert.equal(row().last_status, 'error');
  assert.match(row().last_summary, /后自动重连/);

  // 第一次的 start 迟到地连上了：宿主马上调它的停止函数。
  starts[0].resolve(() => stopped.push('first'));
  await waitFor(() => stopped.includes('first'), '迟到的连接被关掉');

  // 退避时间到了自动重试；这次正常连上。
  globalThis.__stream.start = async (ctx) => {
    starts.push({ ctx });
    return () => stopped.push('second');
  };
  await waitFor(() => starts.length === 2 && row().last_status === 'ok', '自动重连成功');
  assert.equal(row().last_summary, '长连接已启动');

  // 旧连接（第一次的 ctx）迟到的上报都被忽略。
  starts[0].ctx.status('旧连接还活着');
  assert.equal(row().last_summary, '长连接已启动');
  assert.equal((await starts[0].ctx.ingest([{ externalId: 'x', title: 't', content: 'c' }])).stopped, true);

  await discovery.stopLifecycle('stream-test');
  assert.ok(stopped.includes('second'));
});

test('ctx.status 更新状态说明；ctx.fail 后停掉并按退避重启；retry: false 不重启', async () => {
  const starts = [];
  const stopped = [];
  globalThis.__stream = {
    start: async (ctx) => {
      const n = starts.push(ctx);
      return () => stopped.push(n);
    }
  };
  await discovery.startLifecycle('stream-test');
  starts[0].status('重连中（第 2 次）');
  assert.equal(row().last_status, 'ok');
  assert.equal(row().last_summary, '重连中（第 2 次）');

  starts[0].fail(new Error('放弃重连'));
  await waitFor(() => stopped.includes(1), '先调用停止函数');
  assert.equal(row().last_status, 'error');
  assert.match(row().last_error, /放弃重连/);
  await waitFor(() => starts.length === 2 && row().last_status === 'ok', '自动重启');

  // 旧 ctx 再报失败不会影响新连接。
  starts[0].fail('旧的');
  assert.equal(row().last_status, 'ok');

  starts[1].fail('被别处的登录顶掉了', { retry: false });
  await waitFor(() => stopped.includes(2), '停掉');
  assert.equal(row().last_summary, '长连接已断开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(starts.length, 2, 'retry: false 时不自动重启');
});

test('停用插件会取消还没到点的自动重连', async () => {
  let starts = 0;
  globalThis.__stream = {
    start: async () => {
      starts += 1;
      throw new Error('连不上');
    }
  };
  Object.assign(discovery.limits, { restartBaseMs: 100 });
  await discovery.startLifecycle('stream-test');
  assert.equal(starts, 1);
  await discovery.stopLifecycle('stream-test');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(starts, 1);
  assert.equal(row().last_status, 'idle');
});

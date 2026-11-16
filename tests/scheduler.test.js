// 调度器集成测试：用临时数据目录和假 Worker 插件，验证取消、超时、重试和按 Worker 限并发。
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-scheduler-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const scheduler = await import('../src/scheduler.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function fakeWorker(id, worker, execute) {
  const manifest = validateManifest({ id, kind: 'worker', name: id, entry: 'index.js', worker });
  workers.registerWorkerPlugin({ manifest, module: { execute }, dir: path.join(dataDir, 'plugins', id) });
}

/** 一个手动放行的 Worker：execute 挂起，直到测试调用 release(result)。 */
function gatedWorker(id, worker = {}) {
  const calls = [];
  fakeWorker(id, worker, (task, ctx) => new Promise((resolve) => {
    calls.push({ task, ctx, release: resolve });
  }));
  return calls;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(fn, label = '条件', ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error(`等待超时：${label}`);
}
const status = (id) => scheduler.getTask(id).status;
const eventTypes = (id) => scheduler.taskEvents(id).map((e) => e.type);

test('取消后 Worker 再返回 failed，任务也不会被重试复活', async () => {
  const calls = gatedWorker('gate-cancel', { retries: 1 });
  const task = scheduler.createTask({ title: '取消', prompt: 'x', worker: 'gate-cancel' });
  await waitFor(() => calls.length === 1, 'Worker 开始执行');
  scheduler.cancel(task.id);
  assert.equal(calls[0].ctx.signal.aborted, true);
  calls[0].release({ status: 'failed', summary: '被中止' });
  await waitFor(() => scheduler.stats().running === 0, '槽位释放');
  for (let i = 0; i < 20; i += 1) await tick();
  assert.equal(status(task.id), 'cancelled');
  assert.equal(calls.length, 1);
  assert.ok(!eventTypes(task.id).includes('task/retry'));
});

test('取消后 Worker 再返回 done，也不会覆盖成已完成', async () => {
  const calls = gatedWorker('gate-cancel-done');
  const task = scheduler.createTask({ title: '取消2', prompt: 'x', worker: 'gate-cancel-done' });
  await waitFor(() => calls.length === 1, 'Worker 开始执行');
  scheduler.cancel(task.id);
  calls[0].release({ status: 'done', summary: '其实做完了' });
  for (let i = 0; i < 20; i += 1) await tick();
  assert.equal(status(task.id), 'cancelled');
});

test('超时：按 Worker 的 timeoutMinutes 中止，标记失败且不自动重试', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = gatedWorker('gate-timeout', { timeoutMinutes: 1, retries: 2 });
    const task = scheduler.createTask({ title: '超时', prompt: 'x', worker: 'gate-timeout' });
    await waitFor(() => calls.length === 1, 'Worker 开始执行');
    mock.timers.tick(59 * 1000);
    await tick();
    assert.equal(status(task.id), 'running');
    mock.timers.tick(1000);
    await waitFor(() => status(task.id) === 'failed', '超时失败');
    assert.equal(calls[0].ctx.signal.reason, 'timeout');
    assert.match(scheduler.getTask(task.id).error, /超过 1 分钟/);
    assert.equal(calls.length, 1);
    assert.equal(scheduler.stats().running, 0);
  } finally {
    mock.timers.reset();
  }
});

test('重试次数由 Worker 声明；retryable: false 的失败不重试', async () => {
  let runs = 0;
  fakeWorker('flaky', { retries: 1 }, async () => { runs += 1; return { status: 'failed', summary: `第 ${runs} 次失败` }; });
  const task = scheduler.createTask({ title: '重试', prompt: 'x', worker: 'flaky' });
  await waitFor(() => status(task.id) === 'failed', '重试后失败');
  assert.equal(runs, 2);
  assert.equal(scheduler.getTask(task.id).attempts, 2);

  let fatalRuns = 0;
  fakeWorker('fatal', { retries: 3 }, async () => { fatalRuns += 1; return { status: 'failed', summary: '配置错误', retryable: false }; });
  const fatal = scheduler.createTask({ title: '不可重试', prompt: 'x', worker: 'fatal' });
  await waitFor(() => status(fatal.id) === 'failed', '直接失败');
  assert.equal(fatalRuns, 1);

  let defaultRuns = 0;
  fakeWorker('no-retry', {}, async () => { defaultRuns += 1; return { status: 'failed', summary: '失败' }; });
  const plain = scheduler.createTask({ title: '默认不重试', prompt: 'x', worker: 'no-retry' });
  await waitFor(() => status(plain.id) === 'failed', '默认失败');
  assert.equal(defaultRuns, 1);
});

test('按 Worker 限并发：一个 Worker 满了，不挡别的 Worker 的任务', async () => {
  const slow = gatedWorker('slow-agent', { concurrency: 1 });
  const quick = gatedWorker('quick-text', { concurrency: 2 });
  const a = scheduler.createTask({ title: 'slow-1', prompt: 'x', worker: 'slow-agent' });
  const b = scheduler.createTask({ title: 'slow-2', prompt: 'x', worker: 'slow-agent' });
  const c = scheduler.createTask({ title: 'quick-1', prompt: 'x', worker: 'quick-text' });
  await waitFor(() => slow.length === 1 && quick.length === 1, '两个 Worker 各跑一个');
  assert.equal(status(a.id), 'running');
  assert.equal(status(b.id), 'queued');
  assert.equal(status(c.id), 'running');

  slow[0].release({ status: 'done', summary: 'ok' });
  await waitFor(() => slow.length === 2, 'slow-2 接着跑');
  assert.equal(status(b.id), 'running');
  slow[1].release({ status: 'done', summary: 'ok' });
  quick[0].release({ status: 'done', summary: 'ok' });
  await waitFor(() => scheduler.stats().running === 0, '全部结束');
  assert.deepEqual([a, b, c].map((t) => status(t.id)), ['done', 'done', 'done']);
});

test('插件抛异常或返回非法结果时转成失败，不会卡住队列', async () => {
  fakeWorker('throws', {}, async () => { throw new Error('boom'); });
  fakeWorker('bad-result', {}, async () => ({ status: 'weird' }));
  const t1 = scheduler.createTask({ title: '抛异常', prompt: 'x', worker: 'throws' });
  const t2 = scheduler.createTask({ title: '坏结果', prompt: 'x', worker: 'bad-result' });
  await waitFor(() => status(t1.id) === 'failed' && status(t2.id) === 'failed', '两个都失败');
  assert.match(scheduler.getTask(t1.id).error, /boom/);
  assert.match(scheduler.getTask(t2.id).error, /未知状态/);
  assert.equal(scheduler.stats().running, 0);
});

test('内置 Worker 通过同一个加载器注册，并能在演示模式下执行', async () => {
  const errors = await workers.loadBuiltinWorkers();
  assert.deepEqual(errors, []);
  const avail = workers.availability();
  for (const id of ['llm', 'file', 'shell', 'memory', 'claude', 'codex', 'dsh']) {
    assert.equal(avail[id]?.source, 'builtin', id);
  }
  assert.equal(workers.defaultWorker(), 'llm');
  const task = scheduler.createTask({ title: '整理记忆', prompt: '整理一下', worker: 'memory' });
  await waitFor(() => status(task.id) === 'done', 'memory Worker 完成');
});

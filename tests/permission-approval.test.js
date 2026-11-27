// 权限拍板：Claude Code 报上来的 permission_denials 会停下来问主人，放开后带着授权和原来的会话接着跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-permission-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const scheduler = await import('../src/scheduler.js');
const db = await import('../src/db.js');

test.after(() => removeTemp(dataDir));

/** 一个手动放行的 Worker：execute 挂起，直到测试调用 release(result)。 */
function gatedWorker(id, worker = {}) {
  const calls = [];
  const manifest = validateManifest({ id, kind: 'worker', name: id, entry: 'index.js', worker });
  // 内存里的假插件没有入口文件，测试调度逻辑时在主线程执行。
  workers.registerWorkerPlugin({ manifest, module: { execute: (task, ctx) => new Promise((resolve) => calls.push({ task, ctx, release: resolve })) }, dir: path.join(dataDir, 'plugins', id), isolate: false });
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

function workspaceDir(name) {
  const dir = path.join(dataDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pendingFor(taskId) {
  return scheduler.pendingApprovals().find((approval) => approval.task_id === taskId) || null;
}

test('被权限拦下 → 先问主人；选「只放开这一次」后带着授权和同一会话接着跑', async () => {
  const calls = gatedWorker('perm-task');
  const cwd = workspaceDir('ws-task');
  const task = scheduler.createTask({ title: '写结果', prompt: '把结果写到 out.md', worker: 'perm-task', cwd });
  await waitFor(() => calls.length === 1, 'Worker 开始执行');
  calls[0].release({
    status: 'done',
    summary: '想写 out.md，但被权限拦下了',
    sessionId: 'sess_perm_1',
    permissionDenials: [{ tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'out.md') } }]
  });
  await waitFor(() => scheduler.getTask(task.id).status === 'waiting_approval', '停下来问主人');
  const approval = pendingFor(task.id);
  assert.ok(approval, '应该有审批');
  assert.equal(approval.kind, 'permission');
  assert.match(approval.question, /改文件：out\.md/);
  assert.deepEqual(approval.options, ['只放开这一次', '不放开']);

  scheduler.approve(approval.id, 0);
  await waitFor(() => calls.length === 2, '放开后重跑');
  assert.equal(calls[1].ctx.sessionId, 'sess_perm_1', '接着同一个会话');
  assert.equal(calls[1].ctx.permissions.level, 'edit', '这次可以改文件了');
  assert.match(String(calls[1].ctx.permissionNote), /放开/);
  assert.equal(JSON.parse(calls[1].task.options).permissions.grant.edit, true);

  calls[1].release({ status: 'done', summary: '写好了' });
  await waitFor(() => scheduler.getTask(task.id).status === 'done', '任务完成');
  assert.equal(scheduler.getTask(task.id).result, '写好了');
});

test('选「以后这个工作区都允许」：规则记到工作区上，下一轮直接带上', async () => {
  const cwd = workspaceDir('ws-shared');
  db.saveSettings({
    workspaces: [
      ...db.getSettings().workspaces.filter((ws) => ws.id !== 'w_shared'),
      { id: 'w_shared', name: '测试区', path: cwd }
    ]
  });
  const calls = gatedWorker('perm-workspace');
  const task = scheduler.createTask({ title: '跑测试', prompt: '跑 npm test', worker: 'perm-workspace', cwd });
  await waitFor(() => calls.length === 1, 'Worker 开始执行');
  calls[0].release({
    status: 'done',
    summary: '被权限拦了',
    sessionId: 'sess_perm_2',
    permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'npm test' } }]
  });
  await waitFor(() => scheduler.getTask(task.id).status === 'waiting_approval', '停下来问主人');
  const approval = pendingFor(task.id);
  const keepIndex = approval.options.findIndex((option) => option.includes('以后'));
  assert.ok(keepIndex > 0, `应该有「以后都允许」：${approval.options.join(' / ')}`);
  assert.match(approval.question, /跑命令：npm test/);

  scheduler.approve(approval.id, keepIndex);
  await waitFor(() => calls.length === 2, '放开后重跑');
  assert.deepEqual(db.getSettings().workspaces.find((ws) => ws.id === 'w_shared').permission, {
    level: 'read',
    allow: ['Bash(npm test:*)']
  });
  assert.ok(calls[1].ctx.permissions.allow.includes('Bash(npm test:*)'), '重跑时带着放开的规则');
  assert.equal(calls[1].ctx.permissions.level, 'read', '只是放开这条命令，不是放开改文件');

  calls[1].release({ status: 'done', summary: '测试通过' });
  await waitFor(() => scheduler.getTask(task.id).status === 'done', '任务完成');
});

test('选「不放开」：收尾并写明被拦下的操作，不会反复重跑', async () => {
  const calls = gatedWorker('perm-deny');
  const cwd = workspaceDir('ws-deny');
  const task = scheduler.createTask({ title: '清理', prompt: '清理 build 目录', worker: 'perm-deny', cwd });
  await waitFor(() => calls.length === 1, 'Worker 开始执行');
  calls[0].release({
    status: 'done',
    summary: '想删 build 目录',
    permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }]
  });
  await waitFor(() => scheduler.getTask(task.id).status === 'waiting_approval', '停下来问主人');
  const approval = pendingFor(task.id);
  const denyIndex = approval.options.indexOf('不放开');
  assert.ok(denyIndex >= 0);

  scheduler.approve(approval.id, denyIndex);
  await waitFor(() => scheduler.getTask(task.id).status === 'cancelled', '任务收尾');
  const stopped = scheduler.getTask(task.id);
  assert.match(stopped.result, /没有放开的操作/);
  assert.match(stopped.result, /rm -rf build/);
  for (let i = 0; i < 20; i += 1) await tick();
  assert.equal(calls.length, 1, '不放开就不该再跑一轮');
});

test('已经放开过的同一条命令不再重复问主人', async () => {
  const calls = gatedWorker('perm-repeat');
  const cwd = workspaceDir('ws-repeat');
  const task = scheduler.createTask({
    title: '再跑测试',
    prompt: '再跑一次 npm test',
    worker: 'perm-repeat',
    cwd,
    options: { permissions: { grant: { allow: ['Bash(npm test:*)'] } } }
  });
  await waitFor(() => calls.length === 1, 'Worker 开始执行');
  calls[0].release({
    status: 'done',
    summary: '又被拦了',
    sessionId: 'sess_perm_3',
    permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'npm test -- --runInBand' } }]
  });
  await waitFor(() => scheduler.getTask(task.id).status === 'done', '不该再问');
  assert.equal(pendingFor(task.id), null);
  assert.equal(calls.length, 1);
});

test('工具输入只留定位操作要用的字段，Write 的正文不跟着存', async () => {
  // normalizeResult 的行为：通过 runWorker 直接验证（不经过调度器）。
  const manifest = validateManifest({ id: 'perm-trim', kind: 'worker', name: 'perm-trim', entry: 'index.js', worker: {} });
  workers.registerWorkerPlugin({
    manifest,
    module: { execute: async () => ({ status: 'done', summary: 'x', permissionDenials: [{ tool_name: 'Write', tool_input: { file_path: '/a/b.md', content: 'x'.repeat(5000), description: 'noise' } }] }) },
    dir: path.join(dataDir, 'plugins', 'perm-trim'),
    isolate: false
  });
  const result = await workers.runWorker({ id: 't', worker: 'perm-trim', prompt: 'x', cwd: dataDir }, { signal: new AbortController().signal });
  assert.deepEqual(result.permissionDenials, [{ tool_name: 'Write', tool_input: { file_path: '/a/b.md' } }]);
});

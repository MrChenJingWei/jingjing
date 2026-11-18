// 「接着做」与卡片流转：同一张卡继续（保留会话、带上前几轮）、另起一张后续卡（parent 链接）、重试保留这一轮要求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-followup-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const scheduler = await import('../src/scheduler.js');
const { APPROVAL_GUIDE } = await import('../src/worker-runtime.js');
const { execute: claudeExecute } = await import('../workers/claude/index.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** 手动放行的假 Worker：每次执行记下 task 和 ctx，等测试 release。 */
function gatedWorker(id) {
  const calls = [];
  const manifest = validateManifest({ id, kind: 'worker', name: id, entry: 'index.js', worker: {} });
  workers.registerWorkerPlugin({
    manifest,
    module: { execute: (task, ctx) => new Promise((resolve) => calls.push({ task, ctx, release: resolve })) },
    dir: path.join(dataDir, 'plugins', id),
    isolate: false
  });
  return calls;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(fn, label, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error(`等待超时：${label}`);
}
const status = (id) => scheduler.getTask(id).status;

test('同一张卡接着做：保留会话，Worker 拿到前几轮和这次的话', async () => {
  const calls = gatedWorker('fu-same');
  const task = scheduler.createTask({ title: '修登录', prompt: '修好登录页', worker: 'fu-same' });
  await waitFor(() => calls.length === 1, '第一轮开始');
  assert.equal(calls[0].ctx.followup, null);
  assert.equal(calls[0].ctx.approvalGuide, APPROVAL_GUIDE);
  calls[0].release({ status: 'done', summary: '改好了，要不要顺便补测试？', sessionId: 'sess-1' });
  await waitFor(() => status(task.id) === 'done', '第一轮完成');

  scheduler.continueTask(task.id, '补上测试');
  await waitFor(() => calls.length === 2, '第二轮开始');
  const second = calls[1];
  assert.deepEqual(second.ctx.followup, { round: 2, text: '补上测试' });
  assert.equal(second.ctx.sessionId, 'sess-1', '会话要接着用');
  assert.match(second.task.prompt, /^修好登录页/);
  assert.match(second.task.prompt, /第 1 轮[\s\S]*改好了，要不要顺便补测试？/);
  assert.match(second.task.prompt, /第 2 轮：主人现在接着说[\s\S]*补上测试/);
  // 库里的指令不变，拼接只发生在交给 Worker 的那一刻。
  assert.equal(scheduler.getTask(task.id).prompt, '修好登录页');
  second.release({ status: 'done', summary: '测试补好了', sessionId: 'sess-1' });
  await waitFor(() => status(task.id) === 'done', '第二轮完成');

  scheduler.continueTask(task.id, '再跑一遍 lint');
  await waitFor(() => calls.length === 3, '第三轮开始');
  assert.equal(calls[2].ctx.followup.round, 3);
  assert.match(calls[2].task.prompt, /第 2 轮：主人追问「补上测试」[\s\S]*测试补好了/);
  calls[2].release({ status: 'done', summary: 'lint 通过' });
  await waitFor(() => status(task.id) === 'done', '第三轮完成');

  const followups = scheduler.taskEvents(task.id).filter((e) => e.type === 'task/followup');
  assert.deepEqual(followups.map((e) => e.data.round), [2, 3]);
  assert.equal(scheduler.getTask(task.id).result, 'lint 通过');
});

test('还在做或等拍板的卡不能「接着做」；空话不收', async () => {
  const calls = gatedWorker('fu-busy');
  const task = scheduler.createTask({ title: '忙', prompt: 'x', worker: 'fu-busy' });
  await waitFor(() => calls.length === 1, '开始');
  assert.throws(() => scheduler.continueTask(task.id, '再做点'), /还在做/);
  calls[0].release({ status: 'needs_approval', summary: '', approval: { question: '选哪个？', options: ['A', 'B'] } });
  await waitFor(() => status(task.id) === 'waiting_approval', '等拍板');
  assert.throws(() => scheduler.continueTask(task.id, '再做点'), /等你拍板/);
  scheduler.cancel(task.id);
  assert.throws(() => scheduler.continueTask(task.id, '   '), /先写下/);
  // 停掉的卡可以接着做，并带上「中途停了」的上下文。
  scheduler.continueTask(task.id, '还是做 A');
  await waitFor(() => calls.length === 2, '停掉后接着做');
  assert.match(calls[1].task.prompt, /中途停了/);
  calls[1].release({ status: 'done', summary: 'A 做好了' });
  await waitFor(() => status(task.id) === 'done', '完成');
});

test('接着做的那一轮失败后重试：重试的是这一轮，会话从头来', async () => {
  const calls = gatedWorker('fu-retry');
  const task = scheduler.createTask({ title: '重试', prompt: '原始指令', worker: 'fu-retry' });
  await waitFor(() => calls.length === 1, '第一轮');
  calls[0].release({ status: 'done', summary: '第一轮结果', sessionId: 'sess-r' });
  await waitFor(() => status(task.id) === 'done', '第一轮完成');
  scheduler.continueTask(task.id, '第二轮要求');
  await waitFor(() => calls.length === 2, '第二轮');
  calls[1].release({ status: 'failed', summary: '炸了', retryable: false });
  await waitFor(() => status(task.id) === 'failed', '第二轮失败');
  scheduler.retryTask(task.id);
  await waitFor(() => calls.length === 3, '重试');
  assert.equal(calls[2].ctx.sessionId, null);
  assert.equal(calls[2].ctx.followup.text, '第二轮要求');
  assert.match(calls[2].task.prompt, /第一轮结果[\s\S]*第二轮要求/);
  calls[2].release({ status: 'done', summary: '好了' });
  await waitFor(() => status(task.id) === 'done', '重试完成');
});

test('另起一张：后续卡带上上一张的指令和结果，两张卡互相连着', async () => {
  const calls = gatedWorker('fu-new');
  const parent = scheduler.createTask({ title: '写方案', prompt: '写一份迁移方案', worker: 'fu-new', cwd: '/tmp' });
  await waitFor(() => calls.length === 1, '上一张开始');
  calls[0].release({ status: 'done', summary: '方案：分三步迁移', sessionId: 'sess-p' });
  await waitFor(() => status(parent.id) === 'done', '上一张完成');

  const child = scheduler.spawnFollowup(parent.id, '按方案实现第一步');
  assert.equal(child.parent_id, parent.id);
  assert.equal(child.link_kind, 'followup');
  assert.equal(child.worker, 'fu-new');
  assert.equal(child.cwd, '/tmp');
  assert.equal(child.title, '按方案实现第一步');
  assert.match(child.prompt, /接着之前的任务「写方案」[\s\S]*写一份迁移方案[\s\S]*方案：分三步迁移[\s\S]*按方案实现第一步/);
  await waitFor(() => calls.length === 2, '后续卡开始');
  assert.equal(calls[1].ctx.sessionId, null, '后续卡是新会话');
  calls[1].release({ status: 'done', summary: '第一步完成' });
  await waitFor(() => status(child.id) === 'done', '后续卡完成');

  assert.equal(status(parent.id), 'done', '上一张不动');
  assert.ok(scheduler.taskEvents(parent.id).some((e) => e.type === 'task/spawned' && e.data.taskId === child.id));
  const links = scheduler.taskLinks(parent.id);
  assert.equal(links.parent, null);
  assert.deepEqual(links.children.map((c) => c.id), [child.id]);
  assert.equal(scheduler.taskLinks(child.id).parent.id, parent.id);

  // 上一张删了，后续卡还在，链接显示「已删除」。
  scheduler.deleteTask(parent.id);
  assert.equal(scheduler.taskLinks(child.id).parent.status, 'deleted');
});

function fakeClaudeCtx(extra = {}) {
  const calls = [];
  const result = JSON.stringify({ type: 'result', subtype: 'success', result: '好了', session_id: 'sess-c' });
  return {
    calls,
    ctx: {
      which: () => '/bin/claude',
      settings: {},
      emit: async () => {},
      checkpoint: async (d) => d,
      estimateTokens: () => 1,
      parseApproval: () => null,
      approvalGuide: 'GUIDE',
      exec: async (bin, args, { onOutput }) => { calls.push(args); onOutput(`${result}\n`); return { code: 0, stdout: result, stderr: '' }; },
      ...extra
    }
  };
}

test('Claude Code：会话还在时只发这次的话并 --resume；都带上拍板约定', async () => {
  const cont = fakeClaudeCtx({ followup: { round: 2, text: '补上测试' }, sessionId: 'sess-old' });
  await claudeExecute({ prompt: '原指令 + 前几轮' }, cont.ctx);
  const args = cont.calls[0];
  assert.match(args[1], /^补上测试/);
  assert.match(args[1], /GUIDE$/);
  assert.equal(args[args.indexOf('--resume') + 1], 'sess-old');

  const fresh = fakeClaudeCtx({ followup: { round: 2, text: '补上测试' } });
  await claudeExecute({ prompt: '原指令 + 前几轮' }, fresh.ctx);
  assert.equal(fresh.calls[0][1], '原指令 + 前几轮\n\nGUIDE');
});

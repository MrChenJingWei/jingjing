// 任务生命周期：状态规则、运行记录、回传接口、服务重启后的还原、习惯自动拍板、插件线程隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-lifecycle-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { db, now } = await import('../src/db.js');
const { validateManifest } = await import('../src/plugin-spec.js');
const lifecycle = await import('../src/lifecycle.js');
const workers = await import('../src/workers.js');
const scheduler = await import('../src/scheduler.js');
const workflows = await import('../src/workflows.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(fn, label, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error(`等待超时：${label}`);
}
const status = (id) => scheduler.getTask(id).status;

function fakeWorker(id, worker, execute) {
  const manifest = validateManifest({ id, kind: 'worker', name: id, entry: 'index.js', worker });
  workers.registerWorkerPlugin({ manifest, module: { execute }, dir: path.join(dataDir, 'fake', id), isolate: false });
}

function gatedWorker(id, worker = {}) {
  const calls = [];
  fakeWorker(id, worker, (task, ctx) => new Promise((resolve) => calls.push({ task, ctx, release: resolve })));
  return calls;
}

test('状态只能按生命周期规则变化', () => {
  assert.equal(lifecycle.canTransition('queued', 'running'), true);
  assert.equal(lifecycle.canTransition('running', 'waiting_approval'), true);
  assert.equal(lifecycle.canTransition('done', 'queued'), true);
  assert.equal(lifecycle.canTransition('done', 'running'), false);
  assert.equal(lifecycle.canTransition('cancelled', 'done'), false);
  assert.equal(lifecycle.canTransition('queued', 'done'), false);
  assert.throws(() => lifecycle.assertTransition('t1', 'cancelled', 'done'), /不能从「cancelled」变成「done」/);
});

test('每次执行一条运行记录：心跳、断点、结束原因', async () => {
  const calls = gatedWorker('run-rec');
  const task = scheduler.createTask({ title: '运行记录', prompt: 'x', worker: 'run-rec' });
  await waitFor(() => calls.length === 1, '开始执行');
  const { ctx } = calls[0];
  assert.ok(ctx.run.id.startsWith('r_'));
  assert.ok(ctx.run.token.length > 20);
  assert.match(ctx.run.reportUrl, /\/api\/runs\/r_[^/]+\/report$/);

  const saved = await ctx.checkpoint({ step: 2 });
  assert.deepEqual(saved, { step: 2 });
  assert.deepEqual(await ctx.checkpoint({ sessionId: 'abc' }), { step: 2, sessionId: 'abc' });
  assert.equal(scheduler.getTask(task.id).resume_payload.session_id, 'abc', '断点里的会话 id 同步到任务');
  assert.equal(scheduler.getTask(task.id).run_id, ctx.run.id);

  const [running] = scheduler.taskRuns(task.id);
  assert.equal(running.status, 'running');
  assert.ok(running.heartbeat_at);
  assert.equal(running.token_hash, undefined, '令牌哈希不对外暴露');

  calls[0].release({ status: 'done', summary: 'ok' });
  await waitFor(() => status(task.id) === 'done', '完成');
  const [finished] = scheduler.taskRuns(task.id);
  assert.equal(finished.status, 'done');
  assert.ok(finished.finished_at);
  assert.deepEqual(finished.checkpoint, { step: 2, sessionId: 'abc' });
});

test('回传接口：令牌校验、进度与断点上报、取消后告诉对方停下', async () => {
  const calls = gatedWorker('reporter');
  const task = scheduler.createTask({ title: '回传', prompt: 'x', worker: 'reporter' });
  await waitFor(() => calls.length === 1, '开始执行');
  const { run } = calls[0].ctx;

  assert.equal(scheduler.reportRun(run.id, 'wrong', { message: 'x' }).code, 401);
  assert.equal(scheduler.reportRun('r_missing', run.token, {}).code, 404);
  assert.deepEqual(scheduler.reportRun(run.id, run.token, { message: '正在编译 3/10', checkpoint: { step: 3 } }), { ok: true });
  assert.equal(scheduler.getTask(task.id).progress, '正在编译 3/10');
  assert.deepEqual(scheduler.taskRuns(task.id)[0].checkpoint, { step: 3 });
  assert.equal(scheduler.reportRun(run.id, run.token, { checkpoint: 'bad' }).code, 400);

  scheduler.cancel(task.id);
  const stopped = scheduler.reportRun(run.id, run.token, { message: '还在跑' });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stop, true);
  calls[0].release({ status: 'done', summary: '晚到' });
  await waitFor(() => scheduler.stats().running === 0, '槽位释放');
  assert.equal(status(task.id), 'cancelled');
  assert.equal(scheduler.taskRuns(task.id)[0].status, 'cancelled');
});

test('宿主启动的子进程自动拿到回传地址和令牌', async () => {
  let seen = null;
  fakeWorker('env-check', {}, async (task, ctx) => {
    const r = await ctx.exec(process.execPath, ['-e', 'console.log(JSON.stringify([process.env.JINGJING_RUN_ID, process.env.JINGJING_REPORT_URL, Boolean(process.env.JINGJING_RUN_TOKEN)]))']);
    seen = { out: JSON.parse(r.stdout), runId: ctx.run.id };
    return { status: 'done', summary: 'ok' };
  });
  const task = scheduler.createTask({ title: '环境变量', prompt: 'x', worker: 'env-check' });
  await waitFor(() => status(task.id) === 'done', '完成');
  assert.equal(seen.out[0], seen.runId);
  assert.match(seen.out[1], new RegExp(`/api/runs/${seen.runId}/report$`));
  assert.equal(seen.out[2], true);
});

function insertInterrupted({ id, worker, recoveries = 0, checkpoint = null, approval = null }) {
  const stamp = now();
  db.prepare(`
    INSERT INTO tasks(id, title, prompt, worker, cwd, status, origin, recoveries, resume_payload, created_at, updated_at, started_at)
    VALUES(?, ?, 'x', ?, '', 'running', 'chat', ?, ?, ?, ?, ?)
  `).run(id, `被打断的 ${id}`, worker, recoveries, JSON.stringify(approval ? { approval } : {}), stamp, stamp, stamp);
  const run = lifecycle.startRun({ id, worker, attempts: 0 });
  if (checkpoint) lifecycle.saveCheckpoint(run.id, checkpoint);
  return run.id;
}

test('服务重启后按 Worker 声明的方式还原，并防止崩溃循环', async () => {
  const resumeCalls = gatedWorker('rec-resume', { recovery: 'resume' });
  const restartCalls = gatedWorker('rec-restart', { recovery: 'restart' });
  const askCalls = gatedWorker('rec-ask', { recovery: 'ask' });

  const resumeRun = insertInterrupted({ id: 't_resume', worker: 'rec-resume', checkpoint: { sessionId: 's-1' } });
  insertInterrupted({ id: 't_resume_nocp', worker: 'rec-resume' });
  insertInterrupted({ id: 't_restart', worker: 'rec-restart', approval: { question: '归档吗', options: ['归档', '不动'], choice: 0 } });
  insertInterrupted({ id: 't_ask', worker: 'rec-ask' });
  insertInterrupted({ id: 't_loop', worker: 'rec-restart', recoveries: scheduler.MAX_RECOVERIES });

  assert.equal(scheduler.recover(), 5);
  assert.equal(lifecycle.getRun(resumeRun).status, 'interrupted');
  assert.equal(status('t_resume'), 'queued');
  assert.equal(scheduler.getTask('t_resume').resume_payload.recovered.checkpoint.sessionId, 's-1');
  assert.equal(status('t_resume_nocp'), 'waiting_approval', '声明了 resume 但没有断点：问用户');
  assert.equal(status('t_restart'), 'queued');
  assert.equal(status('t_ask'), 'waiting_approval');
  assert.equal(status('t_loop'), 'failed');
  assert.match(scheduler.getTask('t_loop').error, /连续 3 次重启/);
  assert.equal(scheduler.getTask('t_ask').recoveries, 1);

  scheduler.kick();
  await waitFor(() => resumeCalls.length === 1 && restartCalls.length === 1, '恢复的任务开始执行');
  // resume：带着断点继续，会话 id 也在；之后清掉恢复标记。
  assert.equal(resumeCalls[0].ctx.recovery.checkpoint.sessionId, 's-1');
  assert.equal(resumeCalls[0].ctx.sessionId, 's-1');
  assert.equal(scheduler.getTask('t_resume').resume_payload.recovered, undefined);
  // restart：之前用户拍过板的选择保留下来，接着那个分支做。
  assert.equal(restartCalls[0].ctx.recovery, null);
  assert.equal(restartCalls[0].ctx.resume.choice, 0);

  // 全局并发只有 2 个槽：先放行这两个，再看 ask 的任务。
  resumeCalls[0].release({ status: 'done', summary: 'ok' });
  restartCalls[0].release({ status: 'done', summary: 'ok' });
  await waitFor(() => status('t_resume') === 'done' && status('t_restart') === 'done', '恢复的任务完成');

  // ask：选「重新执行」后重新入队；这个选择不会被当成 Worker 自己的拍板结果。
  const approval = scheduler.getApproval(scheduler.getTask('t_ask').approval_id);
  assert.equal(approval.kind, 'recovery');
  scheduler.approve(approval.id, 0);
  await waitFor(() => askCalls.length === 1, 'ask 任务重新执行');
  assert.equal(askCalls[0].ctx.resume, null);

  const declined = scheduler.getApproval(scheduler.getTask('t_resume_nocp').approval_id);
  scheduler.approve(declined.id, 1);
  assert.equal(status('t_resume_nocp'), 'cancelled');

  askCalls[0].release({ status: 'done', summary: 'ok' });
  await waitFor(() => scheduler.stats().running === 0, '全部结束');
  assert.equal(scheduler.getTask('t_resume').recoveries, 0, '成功后清零');
});

test('习惯开启自动拍板时，按记下的选择替用户回答；没开就照常等', async () => {
  const seen = [];
  fakeWorker('asker', {}, async (task, ctx) => {
    if (!ctx.resume) {
      return { status: 'needs_approval', summary: '扫描完了', approval: { question: '要把这 7 个文件归档吗？', options: ['归档', '不动'] } };
    }
    seen.push(ctx.resume.choice);
    return { status: 'done', summary: `选了 ${ctx.resume.options[ctx.resume.choice]}` };
  });
  const flow = workflows.createWorkflow({ name: '自动归档', when: '自动归档测试', worker: 'asker' });
  const raw = workflows.readRaw(flow.id).replace('status: active', 'status: active\nanswers: 要把这 \\d+ 个文件归档吗？ => 归档');
  workflows.updateRaw(flow.id, raw);

  const manual = scheduler.createTask({ title: '没开自动', prompt: 'x', worker: 'asker', workflowId: flow.id });
  await waitFor(() => status(manual.id) === 'waiting_approval', '等待拍板');
  for (let i = 0; i < 10; i += 1) await tick();
  assert.equal(status(manual.id), 'waiting_approval', '没开自动拍板就等用户');

  workflows.setAuto(flow.id, true);
  assert.match(workflows.readRaw(flow.id), /auto: true/);
  const autoTask = scheduler.createTask({ title: '开了自动', prompt: 'x', worker: 'asker', workflowId: flow.id });
  await waitFor(() => status(autoTask.id) === 'done', '自动拍板后完成');
  assert.deepEqual(seen, [0]);
  const resolved = scheduler.taskEvents(autoTask.id).find((e) => e.type === 'approval/resolved');
  assert.equal(resolved.data.by, 'habit');
  assert.equal(resolved.data.option, '归档');

  // 选项对不上时不自动回答。
  assert.equal(workflows.autoAnswer(workflows.getWorkflow(flow.id), { question: '要把这 2 个文件归档吗？', options: ['删除', '不动'] }), null);
  scheduler.cancel(manual.id);
});

function writePlugin(id, source) {
  const dir = path.join(dataDir, 'thread-plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), source);
  return dir;
}

async function registerThreaded(id, source) {
  const dir = writePlugin(id, source);
  const manifest = validateManifest({ id, kind: 'worker', name: id, entry: 'index.js', worker: { recovery: 'restart' } }, { dir, dirName: id });
  const module = await import(path.join(dir, 'index.js'));
  workers.registerWorkerPlugin({ manifest, module, dir });
}

test('第三方 Worker 在独立线程里执行：进度、断点、模型调用都能用', async () => {
  await registerThreaded('threaded-ok', `
    import { isMainThread } from 'node:worker_threads';
    export async function execute(task, ctx) {
      await ctx.emit('线程里开始干活');
      await ctx.checkpoint({ step: 1 });
      const reply = await ctx.llm.chat({ messages: [{ role: 'user', content: '你好' }] });
      const r = await ctx.exec(process.execPath, ['-e', 'console.log(process.env.JINGJING_RUN_ID)']);
      return { status: 'done', summary: JSON.stringify({ main: isMainThread, llm: Boolean(reply.text), runId: r.stdout.trim(), ctxRun: ctx.run.id, apiKey: ctx.settings.apiKey ?? null, secrets: ctx.secrets }) };
    }
  `);
  const task = scheduler.createTask({ title: '线程', prompt: 'x', worker: 'threaded-ok' });
  await waitFor(() => ['done', 'failed'].includes(status(task.id)), '线程任务结束');
  const done = scheduler.getTask(task.id);
  assert.equal(done.status, 'done', done.error || '');
  const out = JSON.parse(done.result);
  assert.equal(out.main, false, '不在主线程');
  assert.equal(out.llm, true);
  assert.equal(out.runId, out.ctxRun);
  assert.equal(out.apiKey, null, '插件拿不到模型 Key');
  assert.deepEqual(out.secrets, {});
  assert.deepEqual(scheduler.taskRuns(task.id)[0].checkpoint, { step: 1 });
});

test('线程里的同步死循环：取消后立即释放槽位，线程被结束，主线程不受影响', async () => {
  await registerThreaded('spin', `export async function execute() { while (true) {} }`);
  const task = scheduler.createTask({ title: '死循环', prompt: 'x', worker: 'spin' });
  await waitFor(() => status(task.id) === 'running', '开始执行');
  await new Promise((resolve) => setTimeout(resolve, 100));
  scheduler.cancel(task.id);
  await waitFor(() => scheduler.stats().running === 0, '槽位释放');
  assert.equal(status(task.id), 'cancelled');

  await registerThreaded('thrower', `export async function execute() { throw new Error('插件炸了'); }`);
  const broken = scheduler.createTask({ title: '抛异常', prompt: 'x', worker: 'thrower' });
  await waitFor(() => status(broken.id) === 'failed', '失败');
  assert.match(scheduler.getTask(broken.id).error, /插件炸了/);
});

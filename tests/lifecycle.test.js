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

test('拍板时可以不选选项、自己写决定；Worker 没开这个口子时只能选选项', async () => {
  const seen = [];
  fakeWorker('decider', {}, async (task, ctx) => {
    if (!ctx.resume) {
      return { status: 'needs_approval', summary: '拿不到进度', approval: { question: '进度拿不到，怎么处理？', options: ['只给模板', '去检索'], custom: true } };
    }
    seen.push(ctx.resume);
    return { status: 'done', summary: `按「${ctx.resume.options[ctx.resume.choice]}」做了` };
  });
  const task = scheduler.createTask({ title: '自己写决定', prompt: 'x', worker: 'decider' });
  await waitFor(() => status(task.id) === 'waiting_approval', '等待拍板');
  const approval = scheduler.getApproval(scheduler.getTask(task.id).approval_id);
  assert.equal(approval.custom, true);
  assert.throws(() => scheduler.approve(approval.id, null, { answer: '长'.repeat(501) }), /太长/);
  scheduler.approve(approval.id, null, { answer: '  先问问产品经理，下午再回  ' });
  await waitFor(() => status(task.id) === 'done', '按自己写的决定继续');
  assert.equal(seen[0].answer, '先问问产品经理，下午再回');
  assert.equal(seen[0].options[seen[0].choice], '先问问产品经理，下午再回', '只认 options[choice] 的 Worker 也能拿到这句话');
  assert.equal(scheduler.getTask(task.id).result, '按「先问问产品经理，下午再回」做了');
  assert.equal(scheduler.getApproval(approval.id).answer, '先问问产品经理，下午再回');
  const resolved = scheduler.taskEvents(task.id).find((e) => e.type === 'approval/resolved');
  assert.equal(resolved.data.custom, true);
  assert.equal(resolved.data.option, '先问问产品经理，下午再回', '习惯学习能记下这个决定');

  // 按选项下标做不同操作的 Worker 不开这个口子：自己写的决定和越界的下标都会被拒绝。
  fakeWorker('picker', {}, async (t, ctx) => (ctx.resume
    ? { status: 'done', summary: ctx.resume.options[ctx.resume.choice] }
    : { status: 'needs_approval', summary: '扫完了', approval: { question: '归档吗？', options: ['归档', '不动'] } }));
  const fixed = scheduler.createTask({ title: '只能选', prompt: 'x', worker: 'picker' });
  await waitFor(() => status(fixed.id) === 'waiting_approval', '等待拍板');
  const fixedApproval = scheduler.getApproval(scheduler.getTask(fixed.id).approval_id);
  assert.equal(fixedApproval.custom, false);
  assert.throws(() => scheduler.approve(fixedApproval.id, 0, { answer: '随便' }), /只能从给出的选项里选/);
  assert.throws(() => scheduler.approve(fixedApproval.id, 2), /没有这个选项/);
  assert.equal(scheduler.getApproval(fixedApproval.id).status, 'pending', '被拒绝的拍板不会改状态');
  scheduler.approve(fixedApproval.id, 1);
  await waitFor(() => status(fixed.id) === 'done', '选项照常可用');
  assert.equal(scheduler.getTask(fixed.id).result, '不动');
});

test('自己写的决定里点名了别的 Worker：改派给它从头接着做；Worker 给的选项只认「改用 X」', async () => {
  fakeWorker('asker2', {}, async (task, ctx) => (ctx.resume
    ? { status: 'done', summary: 'asker2 接着做了' }
    : { status: 'needs_approval', summary: '拿不到数据', sessionId: 's-asker2', approval: { question: '数据怎么拿？', options: ['我自己去 fancy 里查', '改用 fancy 去查'], custom: true } }));
  const handed = [];
  fakeWorker('fancy', { abilities: ['text', 'code'], keywords: 'fancy' }, async (task, ctx) => {
    handed.push({ resume: ctx.resume, sessionId: ctx.sessionId });
    return { status: 'done', summary: 'fancy 查完了' };
  });

  const task = scheduler.createTask({ title: '改派', prompt: '查进度', worker: 'asker2' });
  await waitFor(() => status(task.id) === 'waiting_approval', '等待拍板');
  scheduler.approve(scheduler.getTask(task.id).approval_id, null, { answer: '用 fancy 查了回他' });
  await waitFor(() => status(task.id) === 'done', '改派后完成');
  assert.equal(scheduler.getTask(task.id).worker, 'fancy');
  assert.equal(scheduler.getTask(task.id).result, 'fancy 查完了');
  assert.equal(handed[0].sessionId, null, '原 Worker 的会话不交给新 Worker');
  assert.equal(handed[0].resume.answer, '用 fancy 查了回他');
  const edited = scheduler.taskEvents(task.id).find((e) => e.type === 'task/edited');
  assert.deepEqual([edited.data.from.worker, edited.data.to.worker, edited.data.by], ['asker2', 'fancy', 'approval']);

  // 选了「我自己去 fancy 里查」：是用户自己去用，哪怕提到 fancy，也不改派。
  const option = scheduler.createTask({ title: '不改派', prompt: '查进度', worker: 'asker2' });
  await waitFor(() => status(option.id) === 'waiting_approval', '等待拍板');
  scheduler.approve(scheduler.getTask(option.id).approval_id, 0);
  await waitFor(() => status(option.id) === 'done', '原 Worker 完成');
  assert.equal(scheduler.getTask(option.id).worker, 'asker2');
  assert.equal(handed.length, 1);

  // 选了 Worker 给的「改用 fancy 去查」：真的交给 fancy，带上这个选择。
  const swap = scheduler.createTask({ title: '按选项改派', prompt: '查进度', worker: 'asker2' });
  await waitFor(() => status(swap.id) === 'waiting_approval', '等待拍板');
  scheduler.approve(scheduler.getTask(swap.id).approval_id, 1);
  await waitFor(() => status(swap.id) === 'done', '改派后完成');
  assert.equal(scheduler.getTask(swap.id).worker, 'fancy');
  assert.equal(handed.length, 2);
  assert.equal(handed[1].sessionId, null, '原 Worker 的会话不交给新 Worker');
  assert.equal(handed[1].resume.options[handed[1].resume.choice], '改用 fancy 去查');
  const edited2 = scheduler.taskEvents(swap.id).find((e) => e.type === 'task/edited');
  assert.deepEqual([edited2.data.from.worker, edited2.data.to.worker, edited2.data.by], ['asker2', 'fancy', 'approval']);
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

test('每一种终态都只发一次 task/finished：排队中取消、执行中取消、Worker 自己取消、拍板超限、重启后放弃', async () => {
  const { bus } = await import('../src/events.js');
  const { saveSettings } = await import('../src/db.js');
  const finished = [];
  const off = bus.on(({ type, payload }) => {
    if (type === 'task/finished') finished.push([payload.task.id, payload.task.status]);
  });
  const finishedOf = (id) => finished.filter(([taskId]) => taskId === id).map(([, s]) => s);
  try {
    // 排队中就取消。
    saveSettings({ queuePaused: true });
    const queued = scheduler.createTask({ title: '排队中取消', prompt: 'x', worker: 'run-rec' });
    scheduler.cancel(queued.id);
    saveSettings({ queuePaused: false });
    assert.deepEqual(finishedOf(queued.id), ['cancelled']);

    // 执行中取消：Worker 之后晚到的结果不会再发一次。
    const calls = gatedWorker('fin-gate');
    const live = scheduler.createTask({ title: '执行中取消', prompt: 'x', worker: 'fin-gate' });
    await waitFor(() => calls.length === 1, '开始执行');
    scheduler.cancel(live.id);
    // 取消后迟到的断点不再保存。
    await assert.rejects(calls[0].ctx.checkpoint({ late: true }), /已经结束/);
    calls[0].release({ status: 'done', summary: '晚到' });
    await waitFor(() => scheduler.stats().running === 0, '槽位释放');
    for (let i = 0; i < 10; i += 1) await tick();
    assert.deepEqual(finishedOf(live.id), ['cancelled']);
    assert.equal(scheduler.taskRuns(live.id)[0].checkpoint, null);

    // Worker 自己返回 cancelled。
    fakeWorker('fin-self-cancel', {}, async () => ({ status: 'cancelled', summary: '不做了' }));
    const self = scheduler.createTask({ title: 'Worker 取消', prompt: 'x', worker: 'fin-self-cancel' });
    await waitFor(() => status(self.id) === 'cancelled', 'Worker 取消');
    assert.deepEqual(finishedOf(self.id), ['cancelled']);

    // 拍板次数超过上限：失败、清掉「等你拍板」、写明原因，审批也记为已处理。
    saveSettings({ maxHops: 1 });
    fakeWorker('fin-asker', {}, async () => ({ status: 'needs_approval', summary: '还要问', approval: { question: '继续吗？', options: ['继续'] } }));
    const looping = scheduler.createTask({ title: '一直问', prompt: 'x', worker: 'fin-asker' });
    await waitFor(() => status(looping.id) === 'waiting_approval', '第一次拍板');
    scheduler.approve(scheduler.getTask(looping.id).approval_id, 0);
    await waitFor(() => status(looping.id) === 'waiting_approval' && scheduler.getTask(looping.id).hops === 1, '第二次拍板');
    const lastApproval = scheduler.getTask(looping.id).approval_id;
    scheduler.approve(lastApproval, 0);
    const failed = scheduler.getTask(looping.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.progress, null);
    assert.equal(failed.approval_id, null);
    assert.match(failed.result, /来回拍板 1 次/);
    assert.equal(scheduler.getApproval(lastApproval).status, 'approved');
    assert.deepEqual(finishedOf(looping.id), ['failed']);
    saveSettings({ maxHops: 6 });

    // 服务重启后选「放弃」。
    gatedWorker('fin-rec-ask', { recovery: 'ask' });
    insertInterrupted({ id: 't_fin_decline', worker: 'fin-rec-ask' });
    scheduler.recover();
    scheduler.approve(scheduler.getTask('t_fin_decline').approval_id, 1);
    assert.equal(status('t_fin_decline'), 'cancelled');
    assert.deepEqual(finishedOf('t_fin_decline'), ['cancelled']);
  } finally {
    off();
    saveSettings({ queuePaused: false, maxHops: 6 });
  }
});

test('主人拍板时自己写「deepseek」：派给 DeepSeek Harness；外部来源不认这个别名', async () => {
  fakeWorker('dsh', { abilities: ['text', 'code'], cost: 4, keywords: 'deepseek harness|\\bdsh\\b' }, async () => ({ status: 'done', summary: 'dsh 改完了' }));
  fakeWorker('alias-asker', {}, async (task, ctx) => (ctx.resume
    ? { status: 'done', summary: 'asker 收尾' }
    : { status: 'needs_approval', summary: '要改代码', approval: { question: '谁来改？', options: ['我自己改'], custom: true } }));

  const task = scheduler.createTask({ title: '别名改派', prompt: '改一下接口字段', worker: 'alias-asker' });
  await waitFor(() => status(task.id) === 'waiting_approval', '等待拍板');
  scheduler.approve(scheduler.getTask(task.id).approval_id, null, { answer: '改用 deepseek 去做这个任务' });
  await waitFor(() => status(task.id) === 'done', '改派后完成');
  assert.equal(scheduler.getTask(task.id).worker, 'dsh');
  assert.equal(scheduler.getTask(task.id).result, 'dsh 改完了');
  const edited = scheduler.taskEvents(task.id).find((e) => e.type === 'task/edited');
  assert.deepEqual([edited.data.from.worker, edited.data.to.worker, edited.data.by], ['alias-asker', 'dsh', 'approval']);
});

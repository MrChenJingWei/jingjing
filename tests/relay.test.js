// 消息类来源往外说话（relay）：静静决定说什么、什么时候说，插件的 deliver() 决定怎么显示。
// 覆盖：收到回执（同一条消息上接着写）、顺序（回执先于拍板卡片）、做完 / 自动发结果、进度只原地刷新且限频、
// 策略开关、渠道里的拍板必须是主人、只能操作这个来源自己的任务、时间线留痕。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-relay-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const plugins = await import('../src/plugins.js');
const scheduler = await import('../src/scheduler.js');
const discovery = await import('../src/discovery.js');
const relay = await import('../src/relay.js');

test.after(() => removeTemp(dataDir));

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function waitFor(fn, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error(`等待超时：${label}`);
}

// 一个只记录 deliver 调用的「渠道」插件。
const dir = path.join(plugins.USER_PLUGIN_DIR, 'talk');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'talk', name: '测试群', version: '0.1.0', entry: 'index.js', type: 'poll' }));
fs.writeFileSync(path.join(dir, 'index.js'), [
  'export async function poll() { return { items: [] }; }',
  'export async function deliver(config, payload) { (globalThis.__said ||= []).push(payload); return { mode: payload.transient ? "updated" : "sent" }; }',
  ''
].join('\n'));
await plugins.reloadPlugins();
plugins.savePlugin('talk', { enabled: true });

// 手动放行的 Worker：能看着任务停在中间。
const runs = [];
const gated = (id, worker) => workers.registerWorkerPlugin({
  manifest: validateManifest({ id, kind: 'worker', name: id, entry: 'index.js', worker }),
  module: { execute: (task, ctx) => new Promise((resolve) => runs.push({ task, ctx, release: resolve })) },
  dir: path.join(dataDir, id),
  isolate: false
});
gated('relay-worker', { abilities: ['text'], cost: 1, concurrency: 4 });
// 能改代码的 Worker 在：外部消息提到代码仓库时，静静会先停下问主人交给谁。
gated('relay-coder', { abilities: ['code', 'text'], cost: 4, concurrency: 4 });

const said = () => globalThis.__said || [];
const reset = () => { globalThis.__said = []; };
let n = 0;
const message = (content, extra = {}) => {
  n += 1;
  return { externalId: `msg-${n}`, title: `群消息 ${n}`, content, direct: true, replyTo: { chatid: 'g1', msgid: `msg-${n}` }, ...extra };
};
const setPolicy = (relayPatch, extra = {}) => plugins.savePlugin('talk', { relay: relayPatch, ...extra });

test('收到回执：建了任务就不结束这条消息，之后做完接着在上面说，并记在时间线上', async () => {
  reset();
  setPolicy({ ack: true, status: 'key', owners: '' }, { autoReply: false });
  const result = await discovery.ingestItems('talk', [message('请帮忙整理一下周报')]);
  const taskId = result.details[0].taskId;
  assert.ok(taskId);
  // 回执在 ingest 返回前就发了。
  const first = said()[0];
  assert.equal(first.event, 'received');
  assert.equal(first.final, false, '有任务的消息先不结束');
  assert.match(first.text, /建了任务/);
  assert.deepEqual(first.to, { chatid: 'g1', msgid: `msg-${n}` });
  assert.equal(first.task.id, taskId);

  await waitFor(() => runs.length >= 1, 'Worker 开始');
  runs.at(-1).release({ status: 'done', summary: '周报整理好了' });
  await waitFor(() => said().some((p) => p.event === 'done'), '播报做完');
  const done = said().find((p) => p.event === 'done');
  assert.equal(done.final, true);
  assert.doesNotMatch(done.text, /周报整理好了/, '没开自动发回时不带结果正文');
  const relayed = scheduler.taskEvents(taskId).filter((e) => e.type === 'task/relayed').map((e) => e.data.event);
  assert.deepEqual(relayed, ['received', 'done']);
});

test('同一批里先攒着：回执一定先于拍板卡片', async () => {
  reset();
  // 外部消息里提到代码仓库：没有模型时会先停下问主人交给谁（routing 拍板），拍板发生在 ingest 过程中。
  const result = await discovery.ingestItems('talk', [message('请看下仓库里这个 bug')]);
  const detail = result.details[0];
  assert.ok(detail.held, '应该停下问主人');
  await waitFor(() => said().some((p) => p.event === 'waiting_approval'), '推拍板卡片');
  assert.deepEqual(said().map((p) => p.event), ['received', 'waiting_approval']);
  assert.equal(said()[0].final, true, '要等主人拍板的回执直接结束');
  const card = said()[1];
  assert.equal(card.approval.kind, 'routing');
  assert.ok(card.approval.options.length >= 2);
  assert.equal(card.task.id, detail.taskId);
});

test('渠道里拍板：不在名单里的人不算数并留痕；主人可以；只能操作这个来源自己的任务', async () => {
  reset();
  setPolicy({ owners: '' });
  const { details } = await discovery.ingestItems('talk', [message('请看下仓库里这个 bug 2')]);
  const task = scheduler.getTask(details[0].taskId);
  const denied = relay.interact('talk', { taskId: task.id, action: 'approve', choice: 0, actor: 'lisi' });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /还没设置谁能在这里拍板.*lisi/);
  assert.ok(scheduler.taskEvents(task.id).some((e) => e.type === 'task/remote_denied' && e.data.actor === 'lisi'));
  assert.equal(scheduler.getTask(task.id).status, 'waiting_approval');

  setPolicy({ owners: 'zhangsan, wangwu' });
  assert.match(relay.interact('talk', { taskId: task.id, action: 'approve', choice: 0, actor: 'lisi' }).message, /只有主人/);
  assert.equal(relay.interact('talk', { taskId: task.id, action: 'approve', choice: 0, actor: 'zhangsan', approvalId: 'a_old' }).code, 'stale');
  const ok = relay.interact('talk', { taskId: task.id, action: 'approve', choice: 0, actor: 'zhangsan', actorName: '张三' });
  assert.equal(ok.ok, true, ok.message);
  assert.match(ok.message, /张三 选了/);
  assert.notEqual(scheduler.getTask(task.id).status, 'waiting_approval');
  assert.ok(scheduler.taskEvents(task.id).some((e) => e.type === 'task/remote_action' && e.data.actor === 'zhangsan'));
  assert.equal(relay.interact('talk', { taskId: task.id, action: 'approve', choice: 0, actor: 'zhangsan' }).code, 'no_approval');

  // 别的来源（或对话里建的）任务：不能借这个来源操作。
  const chatTask = scheduler.createTask({ title: '对话里的', prompt: 'x', worker: 'relay-worker' });
  assert.equal(relay.interact('talk', { taskId: chatTask.id, action: 'cancel', actor: 'zhangsan' }).code, 'not_found');
  scheduler.cancel(chatTask.id);
  assert.equal(relay.interact('talk', { taskId: task.id, action: 'jump', actor: 'zhangsan' }).code, 'bad_action');
});

test('渠道里让它接着做、停下：也要主人', async () => {
  setPolicy({ owners: 'zhangsan' });
  const { details } = await discovery.ingestItems('talk', [message('请帮忙写个通知')]);
  const taskId = details[0].taskId;
  await waitFor(() => runs.some((r) => r.task.id === taskId), 'Worker 开始');
  runs.find((r) => r.task.id === taskId).release({ status: 'done', summary: '通知写好了' });
  await waitFor(() => scheduler.getTask(taskId).status === 'done', '做完');
  const cont = relay.interact('talk', { taskId, action: 'continue', text: '再短一点', actor: 'zhangsan' });
  assert.equal(cont.ok, true, cont.message);
  await waitFor(() => runs.filter((r) => r.task.id === taskId).length === 2, '接着做');
  assert.equal(runs.filter((r) => r.task.id === taskId).at(-1).ctx.followup.text, '再短一点');
  const stop = relay.interact('talk', { taskId, action: 'cancel', actor: 'zhangsan' });
  assert.equal(stop.ok, true);
  assert.equal(scheduler.getTask(taskId).status, 'cancelled');
});

test('打开自动发回：做完直接发结果（不再单独说做完了）；进度只原地刷新且限频', async () => {
  reset();
  setPolicy({ status: 'progress' }, { autoReply: true });
  relay.limits.progressGapMs = 60 * 1000;
  const { details } = await discovery.ingestItems('talk', [message('请帮忙整理会议纪要')]);
  const taskId = details[0].taskId;
  const run = await waitFor(() => runs.find((r) => r.task.id === taskId), 'Worker 开始');
  await run.ctx.emit('读取录音');
  await run.ctx.emit('整理要点');
  await waitFor(() => said().some((p) => p.event === 'progress'), '进度');
  await tick();
  const progress = said().filter((p) => p.event === 'progress');
  assert.equal(progress.length, 1, '限频');
  assert.equal(progress[0].transient, true);
  assert.equal(progress[0].final, false);
  run.release({ status: 'done', summary: '纪要：三件事' });
  await waitFor(() => said().some((p) => p.event === 'result'), '自动发结果');
  assert.ok(!said().some((p) => p.event === 'done'));
  assert.equal(said().find((p) => p.event === 'result').text, '纪要：三件事');
  assert.ok(scheduler.taskEvents(taskId).some((e) => e.type === 'task/replied' && e.data.by === 'auto'));
  assert.ok(!scheduler.taskEvents(taskId).some((e) => e.type === 'task/relayed' && e.data.event === 'progress'), '进度不进时间线');
  relay.limits.progressGapMs = 10 * 1000;
});

test('关掉回执和播报：什么都不说；重复的消息也不会回两次', async () => {
  reset();
  setPolicy({ ack: false, status: 'off' }, { autoReply: false });
  const item = message('请帮忙查一下发票');
  const { details } = await discovery.ingestItems('talk', [item]);
  const taskId = details[0].taskId;
  const run = await waitFor(() => runs.find((r) => r.task.id === taskId), 'Worker 开始');
  run.release({ status: 'done', summary: '查到了' });
  await waitFor(() => scheduler.getTask(taskId).status === 'done', '做完');
  await relay.drain('talk');
  assert.deepEqual(said(), []);

  setPolicy({ ack: true, status: 'key' });
  await discovery.ingestItems('talk', [item]);
  assert.deepEqual(said().map((p) => [p.event, p.final, p.text]), [['received', true, '这条之前已经处理过了。']]);
});

test('设置：策略存在静静这边，界面能读到；非法的播报级别拒绝', () => {
  setPolicy({ ack: true, status: 'key', owners: 'a, b；c' });
  const view = plugins.listPlugins().find((p) => p.id === 'talk');
  assert.equal(view.canDeliver, true);
  assert.equal(view.canReply, true);
  assert.deepEqual(view.relay, { ack: true, status: 'key', owners: 'a, b, c' });
  assert.throws(() => setPolicy({ status: 'loud' }), /off \/ key \/ progress/);
});

test('旧版插件配置里关掉过回执（replyAck: false）：没设置过新策略时沿用', () => {
  assert.equal(plugins.relayPolicy({ relay: null, config: JSON.stringify({ replyAck: false }) }).ack, false);
  assert.equal(plugins.relayPolicy({ relay: null, config: JSON.stringify({ replyAck: true }) }).ack, true);
  assert.equal(plugins.relayPolicy({ relay: JSON.stringify({ ack: true }), config: JSON.stringify({ replyAck: false }) }).ack, true, '设置过就以新设置为准');
});

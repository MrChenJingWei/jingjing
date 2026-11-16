// 来源插件的条目怎么派 Worker：外部内容不能自己指定 Worker（点名、模型挑、按文字推断能力都不算），
// 只认主人配置的工作流程和分配规则，否则交给最便宜的文本 Worker。模型仍可帮忙判断命中哪个流程。
// 另外覆盖：判断途中同一条再进来不会建出两个任务；Webhook 立即回应、后台处理。用假的 fetch 冒充模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-ingest-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { saveSettings, db } = await import('../src/db.js');
const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const plugins = await import('../src/plugins.js');
const workflows = await import('../src/workflows.js');
const workerRules = await import('../src/worker-rules.js');
const scheduler = await import('../src/scheduler.js');
const discovery = await import('../src/discovery.js');
const router = await import('../src/router.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const dir = path.join(plugins.USER_PLUGIN_DIR, 'feed-test');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'feed-test', name: '测试来源', version: '0.1.0', entry: 'index.js', type: 'poll', webhook: true }));
fs.writeFileSync(path.join(dir, 'index.js'), [
  'export async function poll() { return { items: [] }; }',
  'export async function webhook(payload) { return { items: [{ externalId: payload.id, title: payload.title, content: payload.text }] }; }',
  ''
].join('\n'));
await plugins.reloadPlugins();
plugins.savePlugin('feed-test', { enabled: true });

// 重新加载插件之后再注册假 Worker：只会处理文字的便宜 Worker（关键词 deepseek），和能调工具的贵 Worker。
const fake = (id, worker) => workers.registerWorkerPlugin({
  manifest: validateManifest({ id, kind: 'worker', name: id, entry: 'index.js', worker }),
  module: { execute: async () => ({ status: 'done', summary: 'ok' }) },
  dir: path.join(dataDir, id),
  isolate: false
});
fake('cheap-text', { abilities: ['text'], cost: 1, keywords: 'deepseek' });
fake('tool-agent', { abilities: ['code', 'text'], cost: 4, keywords: 'toolagent' });

let n = 0;
const item = (content) => ({ externalId: `i-${(n += 1)}`, title: `群消息 ${n}`, content });
const taskOf = async (items) => scheduler.getTask((await discovery.ingestItems('feed-test', items)).details[0].taskId);

/** 假模型：每次回答 answer 里的字段；delay 毫秒后才回。 */
function fakeModel() {
  const state = { asked: [], answer: {}, delay: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    state.asked.push(String(init?.body || ''));
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ items: [{ index: 0, actionable: true, priority: 2, reason: '有人找', prompt: '查一下再回复', ...state.answer }] }) } }],
        usage: { total_tokens: 10 }
      })
    };
  };
  saveSettings({ provider: 'deepseek', apiKey: 'sk-test' });
  state.restore = () => {
    globalThis.fetch = realFetch;
    saveSettings({ provider: 'demo', apiKey: '' });
  };
  return state;
}

test('没有模型时：外部消息点名 Worker、提到代码仓库都不会直接交出去，先停下问主人', async () => {
  const plain = await taskOf([item('请回复一下周报')]);
  assert.equal(plain.worker, 'cheap-text');
  assert.equal(plain.status === 'queued' || plain.status === 'running' || plain.status === 'done', true);
  for (const text of ['请看下仓库里这个 bug', '请用 toolagent 处理']) {
    const held = await taskOf([item(text)]);
    assert.equal(held.status, 'waiting_approval', text);
    assert.equal(held.worker, 'cheap-text', '没拍板之前不会交给点名的 Worker');
    assert.equal(scheduler.getApproval(held.approval_id).kind, 'routing');
    scheduler.cancel(held.id);
  }
});

test('分配规则对外部条目生效：主人配的规则可以把外部消息交给能调工具的 Worker', async () => {
  const rule = workerRules.saveWorkerRule(null, { name: '仓库问题给 Agent', pattern: '仓库', source: 'plugin:feed-test', worker: 'tool-agent' });
  try {
    assert.equal((await taskOf([item('请看下仓库里这个 bug')])).worker, 'tool-agent');
    assert.equal((await taskOf([item('请回复一下周报')])).worker, 'cheap-text', '没命中规则的照旧');
  } finally {
    workerRules.deleteWorkerRule(rule.id);
  }
});

test('接了模型：模型挑的 Worker 不算；流程指定的 Worker 优先于消息里的点名；改写后的任务名也能命中流程', async () => {
  workers.saveWorkerConfig('tool-agent', { notes: '已接入 TAPD MCP，能查需求进度' });
  assert.equal(workers.availability()['tool-agent'].notes, '已接入 TAPD MCP，能查需求进度');
  assert.throws(() => workers.saveWorkerConfig('tool-agent', { notes: '长'.repeat(301) }), /最多 300 字/);

  const progress = workflows.createWorkflow({ name: '查看项目进度', when: '进度', worker: 'tool-agent', steps: '1. 用 TAPD MCP 查进度' });
  const bugs = workflows.createWorkflow({ name: '查 bug', when: 'bug', worker: 'tool-agent', steps: '1. 用 TAPD 查 bug 单' });
  const model = fakeModel();
  try {
    // 模型想把它交给能调工具的 Worker：不认，模型的提示词里也没有 Worker 列表。
    model.answer = { title: '回复蓝马需求', worker: 'tool-agent' };
    const picked = await taskOf([item('@静静 蓝马的4.5需求做的怎么样了')]);
    assert.equal(picked.worker, 'cheap-text', '模型挑的 Worker 不算');
    assert.doesNotMatch(model.asked.at(-1), /本机补充：已接入 TAPD MCP/, '外部条目的判断不需要看 Worker 列表');
    assert.match(model.asked.at(-1), new RegExp(progress.id), '给模型的列表里有工作流程');

    // 企微里有人说「用 deepseek 查蓝马的 bug」：命中「查 bug」流程，按流程配的 Worker 执行，消息里的点名不算。
    model.answer = { title: '查蓝马的 bug' };
    const named = await taskOf([item('@静静 用 deepseek 查一下蓝马的 bug')]);
    assert.equal(named.workflow_id, bugs.id);
    assert.equal(named.worker, 'tool-agent');

    // 原消息里没有「进度」，模型改写的任务名里有：命中流程，按流程的 Worker 和步骤派活。
    model.answer = { title: '回复蓝马4.5需求进度', worker: 'cheap-text' };
    const byTitle = await taskOf([item('@静静 蓝马的4.5需求做的怎么样了')]);
    assert.equal(byTitle.workflow_id, progress.id);
    assert.equal(byTitle.worker, 'tool-agent');
    assert.match(byTitle.prompt, /按工作流程「查看项目进度」/);

    // 模型直接点了流程 id（只能在主人配好的流程里选）。
    model.answer = { title: '看看蓝马情况', workflow: progress.id };
    const byId = await taskOf([item('@静静 蓝马那边情况如何')]);
    assert.equal(byId.workflow_id, progress.id);
    assert.equal(byId.worker, 'tool-agent');

    // 模型编了一个不存在的流程：当没给。
    model.answer = { title: '随便看看', workflow: 'nope' };
    assert.equal((await taskOf([item('@静静 随便聊聊')])).workflow_id, null);

    const summary = router.messages(router.MAIN_SESSION, 50).map((m) => m.text).join('\n');
    assert.match(summary, /交给「tool-agent」，按流程「查看项目进度」/, '对话里能看到派给了谁、为什么');
  } finally {
    model.restore();
    workflows.deleteWorkflow(progress.id);
    workflows.deleteWorkflow(bugs.id);
  }
});

test('判断途中同一条再进来（比如发送方重发）只建一个任务；出错时放掉占位，下次还能处理', async () => {
  const model = fakeModel();
  model.delay = 80;
  model.answer = { title: '重发的消息' };
  try {
    const one = item('请确认一下合同');
    const [first, second] = await Promise.all([
      discovery.ingestItems('feed-test', [one]),
      discovery.ingestItems('feed-test', [{ ...one }])
    ]);
    assert.equal(first.created + second.created, 1, '只建了一个任务');
    const rows = db.prepare('SELECT status FROM source_items WHERE source = ? AND external_id = ?').all('feed-test', one.externalId);
    assert.deepEqual(rows.map((r) => r.status), ['task']);
  } finally {
    model.restore();
  }

  // 建任务时出错（这里是一个可用的 Worker 都没有）：占位被放掉，Worker 恢复后同一条还能处理。
  const broken = item('请回复报价');
  for (const id of ['cheap-text', 'tool-agent']) workers.saveWorkerConfig(id, { enabled: false });
  const ids = Object.keys(workers.availability()).filter((id) => !['cheap-text', 'tool-agent'].includes(id));
  for (const id of ids) workers.deleteBuiltinWorker(id);
  try {
    await assert.rejects(discovery.ingestItems('feed-test', [broken]), /没有可用的 Worker/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM source_items WHERE source = ? AND external_id = ?').get('feed-test', broken.externalId).c, 0);
  } finally {
    for (const id of ['cheap-text', 'tool-agent']) workers.saveWorkerConfig(id, { enabled: true });
    workers.restoreBuiltinWorkers();
  }
  assert.equal((await discovery.ingestItems('feed-test', [broken])).created, 1);
});

test('Webhook：插件转好条目就回应，判断和建任务在后台做', async () => {
  const model = fakeModel();
  model.delay = 150;
  model.answer = { title: 'Webhook 来的' };
  try {
    const plugin = plugins.getPlugin('feed-test');
    const started = Date.now();
    const reply = await discovery.receiveWebhook({ ...plugin, instanceId: 'feed-test' }, {
      payload: { id: 'hook-1', title: '告警', text: '请处理磁盘告警' }, headers: {}, rawBody: '', query: {}, method: 'POST'
    });
    assert.deepEqual(reply, { ok: true, accepted: 1 });
    assert.ok(Date.now() - started < 120, '没等模型判断就回应了');
    const row = () => db.prepare('SELECT status, task_id FROM source_items WHERE source = ? AND external_id = ?').get('feed-test', 'hook-1');
    assert.equal(row().status, 'pending', '回应时还在判断');
    const deadline = Date.now() + 3000;
    while (row().status === 'pending' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(row().status, 'task');
    assert.ok(scheduler.getTask(row().task_id));
  } finally {
    model.restore();
  }
});

test('外部消息点名了 Worker 或要读写代码：停下问主人交给谁；选「以后这类都交给它」会建一条分配规则', async () => {
  const { bus } = await import('../src/events.js');
  const ran = [];
  workers.registerWorkerPlugin({
    manifest: validateManifest({ id: 'codex-like', kind: 'worker', name: 'codex-like', entry: 'index.js', worker: { abilities: ['code', 'text'], cost: 4, keywords: 'codexlike' } }),
    module: { execute: async (task) => { ran.push(task.id); return { status: 'done', summary: 'codex-like 查完了' }; } },
    dir: path.join(dataDir, 'codex-like'),
    isolate: false
  });
  const ruleEvents = [];
  const finished = [];
  const off = bus.on(({ type, payload }) => {
    if (type === 'worker-rules/updated') ruleEvents.push(payload.rules.length);
    if (type === 'task/finished') finished.push(payload.task.id);
  });
  const wait = async (fn, label) => {
    const deadline = Date.now() + 3000;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    // 点名 + 没配流程和规则：任务建好就停在拍板，不执行。
    const held = await taskOf([item('@静静 请使用 codexlike 查一下本地代码')]);
    assert.equal(held.status, 'waiting_approval');
    const approval = scheduler.getApproval(held.approval_id);
    assert.equal(approval.kind, 'routing');
    assert.equal(approval.custom, false);
    assert.deepEqual(approval.options, ['交给「codex-like」', '以后这类都交给「codex-like」', '只用「cheap-text」回文字', '不处理']);
    assert.match(approval.question, /点名要用「codex-like」/);
    assert.match(approval.question, /原话：@静静 请使用 codexlike 查一下本地代码/);
    assert.deepEqual(ran, [], '没拍板之前不执行');
    const summary = router.messages(router.MAIN_SESSION, 5).map((m) => m.text).join('\n');
    assert.match(summary, /等你决定交给谁/);

    // 选「交给它」：改派后开始执行，不算 Worker 的拍板（不传给 Worker、不加拍板次数）。
    scheduler.approve(approval.id, 0);
    await wait(() => scheduler.getTask(held.id).status === 'done', '执行完成');
    const done = scheduler.getTask(held.id);
    assert.equal(done.worker, 'codex-like');
    assert.equal(done.hops, 0);
    assert.equal(done.resume_payload?.approval, undefined);
    assert.deepEqual(ran, [held.id]);

    // 选「以后这类都交给它」：建一条只管这个来源的规则，同类的下一条直接交过去，不再问。
    const again = await taskOf([item('请 codexlike 再看看这个函数')]);
    const second = await taskOf([item('请 codexlike 顺便看看那个')]);
    assert.equal(again.status, 'waiting_approval');
    scheduler.approve(again.approval_id, 1);
    scheduler.approve(second.approval_id, 1);
    const rules = workerRules.listWorkerRules().filter((rule) => rule.worker === 'codex-like');
    assert.equal(rules.length, 1, '连着选两次也只有一条规则');
    assert.equal(rules[0].source, 'plugin:feed-test');
    assert.equal(rules[0].pattern, 'codexlike');
    assert.match(rules[0].name, /测试来源里点名「codex-like」的消息/);
    assert.ok(ruleEvents.length >= 1, '设置页会收到规则更新');
    const resolved = scheduler.taskEvents(again.id).find((e) => e.type === 'approval/resolved');
    assert.equal(resolved.data.kind, 'routing');
    assert.equal(resolved.data.rule.id, rules[0].id);
    const direct = await taskOf([item('请 codexlike 第三次')]);
    assert.equal(direct.worker, 'codex-like');
    assert.notEqual(direct.status, 'waiting_approval');

    // 没点名，但提到仓库 / 代码（强信号）：同样先问；可以只用文本 Worker 回文字。
    const repo = await taskOf([item('请帮忙看下仓库里的那段逻辑')]);
    assert.equal(repo.status, 'waiting_approval');
    assert.match(scheduler.getApproval(repo.approval_id).question, /提到「仓库」，看起来要读写代码、执行命令/);
    scheduler.approve(repo.approval_id, 2);
    await wait(() => scheduler.getTask(repo.id).status === 'done', '文本 Worker 完成');
    assert.equal(scheduler.getTask(repo.id).worker, 'cheap-text');

    // 「不处理」：直接取消，照样发 task/finished。
    const no = await taskOf([item('麻烦看下代码里哪里写错了')]);
    assert.equal(no.status, 'waiting_approval');
    const noApproval = no.approval_id;
    scheduler.approve(noApproval, 3);
    assert.equal(scheduler.getTask(no.id).status, 'cancelled');
    assert.ok(finished.includes(no.id));

    // 弱信号（测试、接口）和点名默认 Worker 自己都不打扰主人。
    assert.notEqual((await taskOf([item('请测试一下这个接口通不通')])).status, 'waiting_approval');
    assert.notEqual((await taskOf([item('请用 deepseek 帮我回一句')])).status, 'waiting_approval');
  } finally {
    off();
  }
});

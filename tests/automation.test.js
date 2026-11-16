// 自动化：定时建任务、定时扫描来源并按流程/Worker 处理。用假 Worker 和假来源，不调模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-automation-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { saveSettings, db } = await import('../src/db.js');
const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const plugins = await import('../src/plugins.js');
const workflows = await import('../src/workflows.js');
const router = await import('../src/router.js');
const discovery = await import('../src/discovery.js');
const scheduler = await import('../src/scheduler.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

await workers.loadBuiltinWorkers();
// 先建好假来源并 reload（reload 会清掉之前注册的插件 Worker），再注册假 Worker。
const tapdDir = path.join(plugins.USER_PLUGIN_DIR, 'tapd-fake');
fs.mkdirSync(tapdDir, { recursive: true });
fs.writeFileSync(path.join(tapdDir, 'plugin.json'), JSON.stringify({ id: 'tapd-fake', name: 'TAPD', version: '0.1.0', entry: 'index.js', type: 'poll' }));
fs.writeFileSync(path.join(tapdDir, 'index.js'), [
  'export async function poll() {',
  '  return { items: [{ externalId: "bug-1", title: "商家列表字段不对", content: "只是通知，但自动化要求处理" }] };',
  '}',
  ''
].join('\n'));
await plugins.reloadPlugins();
plugins.savePlugin('tapd-fake', { enabled: true });

workers.registerWorkerPlugin({
  manifest: validateManifest({ id: 'auto-worker', kind: 'worker', name: '自动工人', entry: 'index.js', worker: { abilities: ['text', 'code'], cost: 1 } }),
  module: { execute: async () => ({ status: 'done', summary: '做完了' }) },
  dir: path.join(dataDir, 'auto-worker'),
  isolate: false
});
saveSettings({ workspaces: [{ id: 'default', name: '默认工作区', path: path.join(dataDir, 'sandbox') }], defaultWorkspaceId: 'default' });

test('校验：名称、时间、间隔、指令都要合法', () => {
  assert.throws(() => router.saveRule({ name: '', trigger: { type: 'daily', at: '08:00' }, action: { kind: 'task', prompt: 'x' } }), /名称/);
  assert.throws(() => router.saveRule({ name: 'x', trigger: { type: 'daily', at: '25:00' }, action: { kind: 'task', prompt: 'x' } }), /HH:MM/);
  assert.throws(() => router.saveRule({ name: 'x', trigger: { type: 'interval', minutes: 0 }, action: { kind: 'task', prompt: 'x' } }), /间隔/);
  assert.throws(() => router.saveRule({ name: 'x', trigger: { type: 'daily', at: '08:00' }, action: { kind: 'task', prompt: '  ' } }), /指令/);
  assert.throws(() => router.saveRule({ name: 'x', trigger: { type: 'daily', at: '08:00' }, action: { kind: 'scan', source: '' } }), /来源/);
});

test('到点判断：每天窗口 3 小时；间隔按上次运行算', () => {
  const now = new Date('2026-11-16T09:00:00');
  const daily = { trigger: JSON.stringify({ type: 'daily', at: '08:00' }), last_run: null };
  assert.equal(router.ruleDue(daily, now), true);
  assert.equal(router.ruleDue({ ...daily, last_run: '2026-11-16T08:30:00' }, now), false);
  assert.equal(router.ruleDue({ ...daily, last_run: '2026-11-15T08:30:00' }, now), true);
  assert.equal(router.ruleDue({ trigger: JSON.stringify({ type: 'daily', at: '05:00' }), last_run: null }, now), false, '超出 3 小时窗口');

  const every = { trigger: JSON.stringify({ type: 'interval', minutes: 60 }), last_run: '2026-11-16T08:30:00' };
  assert.equal(router.ruleDue(every, now), false);
  assert.equal(router.ruleDue({ ...every, last_run: '2026-11-16T07:59:00' }, now), true);
});

test('建任务动作：立即运行时建卡，记下上次结果', async () => {
  const rules = router.saveRule({
    name: '早间简报',
    trigger: { type: 'daily', at: '08:00' },
    action: { kind: 'task', title: '今天的待办', prompt: '汇总未完成的事', worker: 'auto-worker', cwd: path.join(dataDir, 'sandbox') }
  });
  const rule = rules.find((item) => item.name === '早间简报');
  assert.ok(rule.id.startsWith('auto_'));

  const out = await router.runRuleNow(rule.id);
  assert.equal(out.taskId && out.taskId.startsWith('t_'), true);
  const task = scheduler.getTask(out.taskId);
  assert.equal(task.worker, 'auto-worker');
  assert.equal(task.title, '今天的待办');
  assert.equal(task.prompt, '汇总未完成的事');
  assert.equal(task.cwd, path.join(dataDir, 'sandbox'));

  const saved = router.listRules().find((item) => item.id === rule.id);
  assert.ok(saved.last_run);
  assert.equal(saved.last_status, 'ok');
  assert.match(saved.last_summary, /建了任务/);
});

test('扫描动作：扫一遍来源，新条目按指定流程/Worker 处理，不经过模型判断', async () => {
  const flow = workflows.createWorkflow({ name: '修 bug', when: '字段', worker: 'auto-worker', steps: '1. 定位并修复' });
  try {
    const rules = router.saveRule({
      name: '夜里修 TAPD',
      trigger: { type: 'daily', at: '02:30' },
      action: { kind: 'scan', source: 'tapd-fake', workflow: flow.id }
    });
    const rule = rules.find((item) => item.name === '夜里修 TAPD');
    const out = await router.runRuleNow(rule.id);
    assert.match(out.summary, /建了 1 个任务/);

    const row = db.prepare("SELECT * FROM tasks WHERE origin = 'plugin:tapd-fake' ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(row.worker, 'auto-worker');
    assert.equal(row.workflow_id, flow.id);
    assert.equal(row.title, '商家列表字段不对', '强制处理时用原条目标题');

    // 同一条不会因为再扫一次而重复建卡。
    const again = await discovery.runPlugin('tapd-fake', { force: true, override: { workflow: flow.id } });
    assert.equal(again.created, 0);
  } finally {
    workflows.deleteWorkflow(flow.id);
  }
});

test('到点执行：proactiveScan 会跑到点的自动化', async () => {
  const at = new Date(Date.now() - 5 * 60 * 1000);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const rules = router.saveRule({
    name: '到点测试',
    trigger: { type: 'daily', at: `${hh}:${mm}` },
    action: { kind: 'task', title: '到点任务', prompt: '做点事', worker: 'auto-worker' }
  });
  const rule = rules.find((item) => item.name === '到点测试');
  try {
    const out = await router.proactiveScan();
    assert.ok(out.created >= 1);
    const after = router.listRules().find((item) => item.id === rule.id);
    assert.ok(after.last_run);
    assert.equal(after.last_status, 'ok');
  } finally {
    router.deleteRule(rule.id);
  }
});

test('开关和删除', () => {
  const rules = router.saveRule({ name: '待删', trigger: { type: 'daily', at: '09:00' }, action: { kind: 'task', prompt: 'x' } });
  const rule = rules.find((item) => item.name === '待删');
  assert.equal(router.setRuleEnabled(rule.id, false).find((item) => item.id === rule.id).enabled, false);
  assert.equal(router.deleteRule(rule.id).some((item) => item.id === rule.id), false);
});

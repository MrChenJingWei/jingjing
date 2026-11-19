// 来源状态跟踪：带状态的来源建卡时绑上外部对象；poll 再拉到同一条时更新状态；syncStatus 刷新已经不在 poll 结果里的；
// 失败保留最后已知状态；删任务删绑定但留去重账本；归档恢复带回绑定；后续卡继承绑定。核心不认识任何具体来源。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-track-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { db } = await import('../src/db.js');
const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const plugins = await import('../src/plugins.js');
const scheduler = await import('../src/scheduler.js');
const discovery = await import('../src/discovery.js');
const sourceLinks = await import('../src/source-links.js');
const archive = await import('../src/archive.js');

test.after(() => removeTemp(dataDir));

// 一个状态模型很「不标准」的假来源：等待客户 / 已打回 / 上线中，映射全在插件里。
const dir = path.join(plugins.USER_PLUGIN_DIR, 'fake-tracker');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'fake-tracker', name: '假工单', version: '0.1.0', entry: 'index.js', type: 'poll' }));
fs.writeFileSync(path.join(dir, 'index.js'), [
  'const remote = () => globalThis.__fakeTracker;',
  'export async function poll() { return { items: remote().poll }; }',
  'export async function syncStatus(config, links) {',
  '  remote().syncCalls.push(links.map((l) => l.externalId));',
  '  if (remote().fail) throw new Error(remote().fail);',
  '  return links.map((l) => remote().states[l.externalId] ? { externalId: l.externalId, status: remote().states[l.externalId] } : { externalId: l.externalId, missing: true });',
  '}',
  ''
].join('\n'));
globalThis.__fakeTracker = { poll: [], states: {}, syncCalls: [], fail: '' };
const remote = globalThis.__fakeTracker;
await plugins.reloadPlugins();
plugins.savePlugin('fake-tracker', { enabled: true });

workers.registerWorkerPlugin({
  manifest: validateManifest({ id: 'track-worker', kind: 'worker', name: 'track-worker', entry: 'index.js', worker: { abilities: ['text'], cost: 1 } }),
  module: { execute: async () => ({ status: 'done', summary: 'ok' }) },
  dir: path.join(dataDir, 'track-worker'),
  isolate: false
});

const ticket = (id, status, extra = {}) => ({
  externalId: id,
  externalType: 'ticket',
  title: `工单 ${id}：请处理登录白屏`,
  content: '请尽快处理，客户在等',
  url: `https://tickets.example.com/${id}`,
  status,
  meta: { project: 'p1' },
  ...extra
});
const pending = (label = '等待客户') => ({ key: 'waiting_customer', label, category: 'blocked', detail: '客户还没回' });

async function settled(id) {
  for (let i = 0; i < 200 && scheduler.getTask(id)?.status !== 'done'; i += 1) await new Promise((r) => setTimeout(r, 5));
  return scheduler.getTask(id);
}

async function ingestOne(item) {
  remote.poll = [item];
  const result = await discovery.runPlugin('fake-tracker', { force: true });
  return result.details?.[0]?.taskId ? scheduler.getTask(result.details[0].taskId) : null;
}

test('建卡时绑上外部对象，任务对象里带着 sources；非标准状态原样显示、映射到通用分类', async () => {
  const task = await ingestOne(ticket('T-1', pending()));
  assert.ok(task, '应该建了任务');
  assert.equal(task.sources.length, 1);
  const link = task.sources[0];
  assert.equal(link.provider, 'fake-tracker');
  assert.equal(link.providerLabel, '假工单');
  assert.equal(link.externalId, 'T-1');
  assert.equal(link.externalType, 'ticket');
  assert.equal(link.url, 'https://tickets.example.com/T-1');
  assert.deepEqual({ label: link.status.label, category: link.status.category }, { label: '等待客户', category: 'blocked' });
  assert.equal(link.tracking, true);
  assert.equal(link.canRefresh, true);
  assert.ok(scheduler.taskEvents(task.id).some((e) => e.type === 'source/linked'));
  // 列表接口也一次带上。
  assert.equal(scheduler.listTasks().find((t) => t.id === task.id).sources[0].externalId, 'T-1');
});

test('poll 再拉到同一条：不建新卡，只更新状态并写事件；状态没变不写事件；旧状态不覆盖新状态', async () => {
  const task = await settled((await ingestOne(ticket('T-2', pending()))).id);
  const before = scheduler.getTask(task.id).updated_at;
  const again = await ingestOne(ticket('T-2', { key: 'rejected', label: '已打回', category: 'nonsense' }));
  assert.equal(again, null, '见过的条目不建卡');
  let link = scheduler.getTask(task.id).sources[0];
  assert.equal(link.status.label, '已打回');
  assert.equal(link.status.category, 'unknown', '不认识的分类降级成 unknown');
  assert.equal(scheduler.getTask(task.id).updated_at, before, '外部状态变化不改任务的 updated_at');
  const changes = () => scheduler.taskEvents(task.id).filter((e) => e.type === 'source/status_changed');
  assert.equal(changes().length, 1);
  assert.deepEqual([changes()[0].data.from, changes()[0].data.to], ['等待客户', '已打回']);

  await ingestOne(ticket('T-2', { key: 'rejected', label: '已打回', category: 'nonsense' }));
  assert.equal(changes().length, 1, '状态没变不再写事件');

  await ingestOne(ticket('T-2', { key: 'deploying', label: '上线中', category: 'in_progress', updatedAt: '2026-11-17T10:00:00Z' }));
  await ingestOne(ticket('T-2', { key: 'open', label: '新建', category: 'open', updatedAt: '2026-11-17T09:00:00Z' }));
  link = scheduler.getTask(task.id).sources[0];
  assert.equal(link.status.label, '上线中', '更旧的状态被忽略');
});

test('syncStatus：刷新到期的绑定；失败保留最后状态并退避；找不到不当作删除', async () => {
  const task = await ingestOne(ticket('T-3', pending()));
  // 新建时已经带了状态，算刚同步过；到期前不会被同步。
  remote.syncCalls.length = 0;
  await discovery.syncDue();
  assert.ok(!remote.syncCalls.flat().includes('T-3'));

  const row = () => db.prepare("SELECT * FROM task_sources WHERE task_id = ?").get(task.id);
  db.prepare('UPDATE task_sources SET synced_at = ? WHERE task_id = ?').run('2000-01-01T00:00:00.000Z', task.id);
  remote.states['T-3'] = { key: 'done', label: '已上线', category: 'done' };
  await discovery.syncDue();
  assert.ok(remote.syncCalls.flat().includes('T-3'));
  let link = scheduler.getTask(task.id).sources[0];
  assert.equal(link.status.label, '已上线');
  assert.equal(link.syncState, 'ok');

  // 同步失败：保留「已上线」，标 error，失败次数 +1。
  remote.fail = 'CLI 没登录';
  const linkId = link.id;
  await assert.rejects(discovery.refreshLink(task.id, linkId), /CLI 没登录/);
  link = scheduler.getTask(task.id).sources[0];
  assert.equal(link.status.label, '已上线');
  assert.equal(link.syncState, 'error');
  assert.equal(link.syncError, 'CLI 没登录');
  assert.equal(row().sync_failures, 1);
  assert.ok(scheduler.taskEvents(task.id).some((e) => e.type === 'source/sync_failed'));
  // 刚失败过：正常间隔内不会再被同步。
  assert.ok(!sourceLinks.dueLinks().some((r) => r.task_id === task.id));

  // 恢复：清掉错误。
  remote.fail = '';
  await discovery.refreshLink(task.id, linkId);
  link = scheduler.getTask(task.id).sources[0];
  assert.equal(link.syncState, 'ok');
  assert.equal(row().sync_failures, 0);

  // 对方说找不到：状态不清空。
  delete remote.states['T-3'];
  await discovery.refreshLink(task.id, linkId);
  link = scheduler.getTask(task.id).sources[0];
  assert.equal(link.status.label, '已上线');
  assert.match(link.syncError, /找不到/);
});

test('停止跟踪 / 解除绑定；来源停用时显示暂停、不能刷新', async () => {
  const task = await ingestOne(ticket('T-4', pending()));
  const linkId = task.sources[0].id;
  sourceLinks.setTracking(task.id, linkId, false);
  let link = scheduler.getTask(task.id).sources[0];
  assert.equal(link.syncState, 'paused');
  assert.equal(link.canRefresh, false);
  // 停止跟踪后 poll 再带来状态也不更新。
  await ingestOne(ticket('T-4', { key: 'x', label: '已关闭', category: 'cancelled' }));
  assert.equal(scheduler.getTask(task.id).sources[0].status.label, '等待客户');
  sourceLinks.setTracking(task.id, linkId, true);
  assert.equal(scheduler.getTask(task.id).sources[0].tracking, true);

  plugins.savePlugin('fake-tracker', { enabled: false });
  link = scheduler.getTask(task.id).sources[0];
  assert.equal(link.syncState, 'paused');
  assert.equal(link.providerState, 'disabled');
  await assert.rejects(discovery.refreshLink(task.id, linkId), /停用/);
  plugins.savePlugin('fake-tracker', { enabled: true });

  sourceLinks.unlink(task.id, linkId);
  assert.deepEqual(scheduler.getTask(task.id).sources, []);
  assert.ok(scheduler.taskEvents(task.id).some((e) => e.type === 'source/unlinked'));
});

test('track: false 的条目不绑；挂在 node 上的改绑到该对象；后续卡继承绑定；删任务删绑定但去重账本还在', async () => {
  const untracked = await ingestOne(ticket('T-5', pending(), { track: false }));
  assert.deepEqual(untracked.sources, []);

  // 评论之类：条目 id 仍是 comment:…（发现去重），绑定落到所在单子，可打开原单。
  const comment = await ingestOne(ticket('comment:99', null, {
    track: false,
    externalType: '评论',
    title: '有人评论了：登录闪退',
    url: 'https://tickets.example.com/7001',
    node: { workspace: 'ws1', type: 'bug', id: '7001', title: '登录闪退', url: 'https://tickets.example.com/7001' }
  }));
  assert.ok(comment, '评论也该建卡');
  assert.equal(comment.sources.length, 1);
  assert.equal(comment.sources[0].externalId, '7001');
  assert.equal(comment.sources[0].externalType, 'bug');
  assert.equal(comment.sources[0].url, 'https://tickets.example.com/7001');
  assert.equal(comment.sources[0].title, '登录闪退');
  assert.equal(comment.sources[0].tracking, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM source_items WHERE source = 'fake-tracker' AND external_id = 'comment:99'").get().c,
    1,
    '发现去重仍用评论自己的 id'
  );

  const task = await ingestOne(ticket('T-6', pending()));
  await settled(task.id);
  const child = scheduler.spawnFollowup(task.id, '验证一下修复');
  assert.equal(child.sources.length, 1);
  assert.equal(child.sources[0].externalId, 'T-6');
  // 一条外部状态更新会同时更新整条链上的卡。
  await ingestOne(ticket('T-6', { key: 'verify', label: '待验证', category: 'review' }));
  assert.equal(scheduler.getTask(task.id).sources[0].status.label, '待验证');
  assert.equal(scheduler.getTask(child.id).sources[0].status.label, '待验证');

  await settled(child.id);
  scheduler.deleteTask(task.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM task_sources WHERE task_id = ?').get(task.id).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM source_items WHERE source = 'fake-tracker' AND external_id = 'T-6'").get().c, 1);
  assert.equal(await ingestOne(ticket('T-6', pending())), null, '去重账本还在，不会重新建卡');
});

test('归档带走绑定，恢复时一起回来', async () => {
  const task = await ingestOne(ticket('T-7', pending()));
  await settled(task.id);
  db.prepare("UPDATE tasks SET status = 'done', finished_at = '2000-01-01T00:00:00.000Z', created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(task.id);
  archive.archiveOld({ days: 30 });
  assert.equal(scheduler.getTask(task.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM task_sources WHERE task_id = ?').get(task.id).c, 0);
  const name = archive.listArchives()[0].name;
  archive.restoreTask(name, task.id);
  assert.equal(scheduler.getTask(task.id).sources[0].externalId, 'T-7');
});

test('护栏：核心代码不认识任何具体来源（注释里举例除外）', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [
    // update.js 是静静自己从 GitHub 发布页检查更新，和任务来源无关。
    ...fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js') && f !== 'update.js').map((f) => path.join(root, 'src', f)),
    path.join(root, 'server.js')
  ];
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
    // github 在别处是「代码活」的关键词，不算来源名；这里只查任务来源。
    for (const name of ['tapd', 'jira']) {
      assert.ok(!new RegExp(`\\b${name}\\b`, 'i').test(code), `${path.basename(file)} 里写死了「${name}」`);
    }
  }
});

// 认人：条目带 actor（谁说的），派活的、直接找静静的人都记进「认识的人」；来源导出 lookupPeople 时新人马上查通讯录，之后每天刷新。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-people-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { db } = await import('../src/db.js');
const plugins = await import('../src/plugins.js');
const discovery = await import('../src/discovery.js');
const people = await import('../src/people.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function waitFor(fn, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error(`等待超时：${label}`);
}

function writeSource(id, { lookup = false } = {}) {
  const dir = path.join(plugins.USER_PLUGIN_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: `${id} 来源`, version: '0.1.0', entry: 'index.js', type: 'poll' }));
  fs.writeFileSync(path.join(dir, 'index.js'), [
    'export async function poll() { return { items: [] }; }',
    lookup
      ? `export async function lookupPeople(config, ids) {
          (globalThis.__lookups ||= []).push(ids);
          return { people: ids.filter((id) => id !== 'ghost').map((id) => ({ id, name: '通讯录' + id, department: '研发部', title: '工程师' })) };
        }`
      : ''
  ].join('\n'));
}

writeSource('dir-src', { lookup: true });
writeSource('plain-src');
await plugins.reloadPlugins();
plugins.savePlugin('dir-src', { enabled: true });
plugins.savePlugin('plain-src', { enabled: true });
// 假的文本 Worker：派活的测试要建任务。要在重新加载插件之后注册，否则会被注销。
const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
workers.registerWorkerPlugin({
  manifest: validateManifest({ id: 'fake-text', kind: 'worker', name: '假文本', entry: 'index.js', worker: { abilities: ['text'], cost: 1 } }),
  module: { execute: async () => ({ status: 'done', summary: '好了' }) },
  dir: path.join(dataDir, 'fake-text'),
  isolate: false
});

const item = (n, extra = {}) => ({ externalId: `m${n}`, title: '你好呀', content: '你好呀', direct: true, ...extra });

test('直接找静静的消息：没开闲聊自动回也记下这个人，身份按来源实例区分', async () => {
  await discovery.ingestItems('plain-src', [item(1, { actor: { id: 'u1', name: '小王' } })]);
  const p = people.get('plain-src:u1');
  assert.ok(p, '记下了这个人');
  assert.equal(p.name, '小王');
  assert.equal(p.name_from, 'source');
  assert.equal(p.source_id, 'plain-src');
  assert.equal(p.external_id, 'u1');
  assert.equal(p.interactions, 1);
});

test('没给 actor 时按 meta.author 兜底；不再拿 groupKey 当人', async () => {
  await discovery.ingestItems('plain-src', [item(2, { meta: { author: 'tapd昵称' } })]);
  assert.ok(people.get('plain-src:tapd昵称'));
  await discovery.ingestItems('plain-src', [item(3, { groupKey: 'room-9' })]);
  assert.equal(people.get('plain-src:room-9'), null);
});

test('不是直接找来、也不用办的事不记人', async () => {
  await discovery.ingestItems('plain-src', [{ externalId: 'n1', title: '系统通知', content: '系统通知', actor: { id: 'bot' } }]);
  const row = db.prepare("SELECT status FROM source_items WHERE source = 'plain-src' AND external_id = 'n1'").get();
  if (row?.status === 'skipped') assert.equal(people.get('plain-src:bot'), null);
});

test('新人马上查通讯录：名字、部门、职位；查不到的也记下查过', async () => {
  globalThis.__lookups = [];
  await discovery.ingestItems('dir-src', [item(10, { actor: { id: 'zs' } }), item(11, { actor: { id: 'ghost' } })]);
  const p = await waitFor(() => people.get('dir-src:zs')?.looked_up_at && people.get('dir-src:zs'), '查通讯录');
  assert.equal(p.name, '通讯录zs');
  assert.equal(p.name_from, 'directory');
  assert.deepEqual(p.profile, { department: '研发部', title: '工程师' });
  assert.match(people.describe(p), /通讯录zs（研发部 · 工程师）/);
  const ghost = await waitFor(() => people.get('dir-src:ghost')?.looked_up_at && people.get('dir-src:ghost'), '查不到的人');
  assert.equal(ghost.name, 'ghost');
  assert.equal(ghost.profile, null);

  // 老熟人再来，不重复查。
  const before = globalThis.__lookups.length;
  await discovery.ingestItems('dir-src', [item(12, { actor: { id: 'zs', name: '插件给的名字' } })]);
  await tick();
  assert.equal(globalThis.__lookups.length, before);
  assert.equal(people.get('dir-src:zs').name, '通讯录zs', '插件给的名字盖不过通讯录');
});

test('每天刷新：超过一天没查的再查；不支持查的来源记下时间、不反复扫', async () => {
  const old = new Date(Date.now() - 2 * 86400000).toISOString();
  db.prepare("UPDATE people SET looked_up_at = ? WHERE id = 'dir-src:zs'").run(old);
  globalThis.__lookups = [];
  const summary = await discovery.refreshPeopleDue();
  assert.deepEqual(globalThis.__lookups, [['zs']]);
  assert.deepEqual(summary['dir-src'], { looked: 1, found: 1 });
  assert.equal(summary['plain-src'], undefined, '不支持查的来源，认识时就记下查过了');
  assert.ok(people.get('plain-src:u1').looked_up_at);
  assert.deepEqual(await discovery.refreshPeopleDue(), {}, '都查过了，这一轮没有要查的');
});

test('名字优先级：主人改的 > 通讯录 > 聊天里说的', () => {
  people.rename('dir-src:zs', '阿三', { from: 'chat' });
  assert.equal(people.get('dir-src:zs').name, '通讯录zs', '聊天里说的盖不过通讯录');
  people.update('dir-src:zs', { name: '老张' });
  assert.equal(people.get('dir-src:zs').name_from, 'manual');
  people.applyDirectory('dir-src:zs', { name: '通讯录zs' });
  assert.equal(people.get('dir-src:zs').name, '老张', '通讯录盖不过主人改的');
  people.rename('plain-src:u1', '王小明', { from: 'chat' });
  assert.equal(people.get('plain-src:u1').name, '王小明', '聊天里说的盖得过插件给的');
});

/* ------------------------------ 合并、忘掉、派活的人 ------------------------------ */

const memory = await import('../src/memory.js');
const conversation = await import('../src/conversation.js');
const persona = await import('../src/persona.js');

test('派活的人记在任务上：要办的事带着 actor 时，任务的 requester 指向这个人', async () => {
  const worker = 'fake-text';
  const { details } = await discovery.ingestItems('plain-src', [{ externalId: 't1', title: '帮我看下登录页白屏', content: '登录页白屏', actor: { id: 'zhangsan', name: '张三' } }], { override: { worker } });
  assert.equal(details[0].status, 'task');
  const row = db.prepare('SELECT requester FROM tasks WHERE id = ?').get(details[0].taskId);
  assert.equal(row.requester, 'plain-src:zhangsan');
  assert.equal(people.requestedTasks('plain-src:zhangsan').length, 1);
});

test('不同来源同名提示合并；说「不是」后不再提示', () => {
  people.ensure('dir-src:zhangsan', { name: '', sourceId: 'dir-src', externalId: 'zhangsan' });
  people.applyDirectory('dir-src:zhangsan', { name: '张三', department: '研发部', alias: 'Sam' });
  const hit = people.suggestions().find((s) => [s.keep.id, s.other.id].includes('plain-src:zhangsan'));
  assert.ok(hit, '提示了');
  assert.equal(hit.keep.id, 'dir-src:zhangsan', '有通讯录资料的当主身份');
  people.markDistinct('plain-src:zhangsan', 'dir-src:zhangsan');
  assert.ok(!people.suggestions().some((s) => [s.keep.id, s.other.id].includes('plain-src:zhangsan')));
});

test('合并：来往、聊天、记忆、派过的活都并到一起；以后从旧来源来的也认成同一个人', async () => {
  const keep = 'dir-src:zhangsan';
  const other = 'plain-src:zhangsan';
  conversation.ensureSession(`ext:${other}`, { personId: other });
  conversation.appendMessage({ sessionId: `ext:${other}`, role: 'user', text: '下周我去出差' });
  memory.remember({ text: '张三下周出差', layer: 'episodic', domain: 'persona', subject: other });
  const before = people.get(keep).interactions + people.get(other).interactions;

  const merged = people.merge(keep, other);
  assert.equal(merged.id, keep);
  assert.equal(merged.name, '张三');
  assert.equal(merged.interactions, before);
  assert.equal(people.get(other).id, keep, '旧身份解析到主身份');
  assert.equal(people.requestedTasks(keep).length, 1, '派过的活跟过来了');
  assert.equal(conversation.recentMessages(`ext:${keep}`).length, 1, '聊天搬过来了');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memories WHERE subject = ?').get(keep).c, 1, '记忆跟过来了');
  assert.deepEqual(people.list().find((p) => p.id === keep).aliases, [other]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM people_distinct').get().c, 0, '「不是同一个人」的记录随旧身份清掉');

  // 旧来源再来：算到主身份上，不新建人。
  const count = db.prepare('SELECT COUNT(*) AS c FROM people').get().c;
  await discovery.ingestItems('plain-src', [item(30, { actor: { id: 'zhangsan', name: '张三' } })]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM people').get().c, count);
  assert.equal(people.get(keep).interactions, before + 1);
});

test('主人提到认识的人：提示词里带上 ta 是谁和最近派过的活', () => {
  const text = persona.mentionedPeople('张三最近找我干嘛了');
  assert.match(text, /张三（研发部）/);
  assert.match(text, /帮我看下登录页白屏/);
  assert.match(persona.mentionedPeople('sam 那边怎么样'), /张三/, '英文名也认');
  assert.equal(persona.mentionedPeople('今天天气不错'), '');
});

test('忘掉一个人：聊天、记忆、别名一起删掉，任务还在但不再记是谁派的', async () => {
  const keep = 'dir-src:zhangsan';
  assert.ok(people.remove(keep));
  assert.equal(people.get(keep), null);
  assert.equal(people.get('plain-src:zhangsan'), null, '别名也忘了');
  assert.equal(conversation.recentMessages(`ext:${keep}`).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memories WHERE subject = ?').get(keep).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE requester = ?').get(keep).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE title LIKE '%登录页%'").get().c, 1, '任务还在');
  await discovery.ingestItems('plain-src', [item(31, { actor: { id: 'zhangsan', name: '张三' } })]);
  assert.equal(people.get('plain-src:zhangsan').interactions, 1, '再来就是新认识的人');
});

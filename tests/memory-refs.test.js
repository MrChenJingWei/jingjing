// 记忆的实体引用：写入时挂上触达点、靠触达点召回、旧的偏好被标记替代、回填幂等、合并人时跟着搬。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-memrefs-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { db, saveSettings, event } = await import('../src/db.js');
const memory = await import('../src/memory.js');
const people = await import('../src/people.js');
const knowledge = await import('../src/knowledge.js');
const { matchEntities } = await import('../src/entities.js');

test.after(() => removeTemp(dataDir));

const wsDir = path.join(dataDir, 'blue');
fs.mkdirSync(wsDir, { recursive: true });
const stamp = new Date().toISOString();
saveSettings({ workspaces: [{ id: 'w_blue', name: '蓝马项目', path: wsDir, aliases: ['蓝马'] }] });
db.prepare('INSERT INTO task_categories(id, axis, key, title, origin, state, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run('cat_blue', 'relation', 'cat_blue', '蓝马需求', 'auto', 'active', stamp, stamp);
for (let i = 0; i < 15; i += 1) {
  memory.write({ text: `日常记录第 ${i} 条：今天天气不错，顺手整理了一下桌面`, layer: 'episodic', kind: 'note' });
}

test('写入时自动挂上正文里提到的实体', () => {
  const item = memory.write({ text: '蓝马项目的 beta 合并前要跑 migrate', layer: 'semantic', kind: 'fact' });
  const refs = memory.refsOf(item.id);
  assert.ok(refs.some((ref) => ref.kind === 'workspace' && ref.key === 'w_blue'));
});

test('触达：消息里没提项目名，靠工作区也能把它捞出来', () => {
  const item = memory.write({ text: 'beta 合并前要跑 migrate（蓝马）', layer: 'semantic', kind: 'fact' });
  assert.ok(memory.refsOf(item.id).some((ref) => ref.kind === 'workspace' && ref.key === 'w_blue'));

  // 消息本身没有「蓝马」「项目」这些词，但任务在工作区里跑。
  const refs = matchEntities('把测试跑一下', { cwd: wsDir });
  const picked = memory.context('把测试跑一下', { limit: 3, refs });
  assert.ok(picked.some((m) => m.text.includes('migrate')), '应当按工作区触达带出来');
});

test('显式给的引用也会存下来，并参与召回', () => {
  const item = memory.write({
    text: 'beta 分支合并后记得通知产品',
    layer: 'semantic',
    kind: 'fact',
    refs: [{ kind: 'category', key: 'cat_blue' }]
  });
  assert.ok(memory.refsOf(item.id).some((ref) => ref.kind === 'category' && ref.key === 'cat_blue'));

  const picked = memory.context('那件事怎么样了', { limit: 3, refs: [{ kind: 'category', key: 'cat_blue', name: '蓝马需求' }] });
  assert.ok(picked.some((m) => m.id === item.id));
});

test('偏好变了：旧条目归档并记 superseded_by，不再被注入', () => {
  const older = memory.write({ text: '喜欢深色主题', layer: 'profile', kind: 'preference', subject: 'owner' });
  const newer = memory.write({ text: '不喜欢深色主题了，改用浅色', layer: 'profile', kind: 'preference', subject: 'owner' });
  assert.equal(memory.get(older.id).archived, true);
  assert.equal(memory.get(older.id).superseded_by, newer.id);
  const kinds = db.prepare('SELECT kind FROM memory_edges WHERE a IN (?, ?) AND b IN (?, ?)').all(older.id, newer.id, older.id, newer.id).map((row) => row.kind);
  assert.ok(kinds.includes('supersedes') && kinds.includes('conflict'), '痕迹：替代 + 冲突');

  const picked = memory.context('深色主题');
  assert.ok(picked.some((m) => m.id === newer.id));
  assert.ok(!picked.some((m) => m.id === older.id), '旧说法不再注入');
});

test('补充新偏好、不是否定旧说法时，不替代', () => {
  const a = memory.write({ text: '喜欢用 vim 编辑', layer: 'profile', kind: 'preference', subject: 'owner' });
  const b = memory.write({ text: '喜欢用 emacs 编辑', layer: 'profile', kind: 'preference', subject: 'owner' });
  assert.equal(memory.get(a.id).archived, false);
  assert.equal(memory.get(b.id).archived, false);
});

test('同一句话重复记：只留一条，引用合并', () => {
  const a = memory.write({ text: '蓝马项目周五提测', refs: [{ kind: 'tool', key: 'git' }] });
  const b = memory.write({ text: '蓝马项目周五提测', refs: [{ kind: 'category', key: 'cat_blue' }] });
  assert.equal(b.id, a.id, '同一件事不重复记');
  const refs = memory.refsOf(a.id);
  assert.ok(refs.some((ref) => ref.kind === 'tool' && ref.key === 'git'));
  assert.ok(refs.some((ref) => ref.kind === 'category' && ref.key === 'cat_blue'));
  assert.ok(refs.some((ref) => ref.kind === 'workspace' && ref.key === 'w_blue'));
});

test('回填：旧记忆补上引用，重复跑不重复加', () => {
  const id = `m_old_${Date.now()}`;
  db.prepare(`
    INSERT INTO memories(id, layer, kind, text, tags, importance, source, created_at, use_count, domain, archived)
    VALUES(?, 'semantic', 'fact', '蓝马项目下周三上线', '[]', 0.5, 'test', ?, 0, 'work', 0)
  `).run(id, stamp);
  assert.deepEqual(memory.refsOf(id), [], '还没回填时没有引用');

  assert.ok(memory.backfillMemoryRefs({ force: true }) >= 1);
  assert.ok(memory.refsOf(id).some((ref) => ref.kind === 'workspace' && ref.key === 'w_blue'));
  assert.equal(memory.backfillMemoryRefs({ force: true }), 0, '再跑一次没有新增');
});

test('合并两个人时，记忆上挂的引用跟着搬过去', () => {
  people.ensure('p_keep', { name: '李四', source: 'wecom' });
  people.ensure('p_other', { name: '李四（TAPD）', source: 'tapd' });
  const item = memory.write({ text: '和李四约了下周对需求', refs: [{ kind: 'person', key: 'p_other' }] });
  people.merge('p_keep', 'p_other');
  const refs = memory.refsOf(item.id);
  assert.ok(refs.some((ref) => ref.kind === 'person' && ref.key === 'p_keep'));
  assert.ok(!refs.some((ref) => ref.kind === 'person' && ref.key === 'p_other'));
});

test('知识晋升成记忆时保留分类引用', () => {
  db.prepare(`
    INSERT INTO task_knowledge(id, scope_key, kind, text, hash, source, confirmed, used_count, created_at, updated_at)
    VALUES('k_blue', 'cat_blue', 'fix', '接口返回 500 时先看网关日志', 'h_blue', 'test', 1, 0, ?, ?)
  `).run(stamp, stamp);
  event('t_know', 'knowledge/injected', { ids: ['k_blue'], scope: 'cat_blue' });
  for (let i = 0; i < 3; i += 1) knowledge.markUsed({ id: 't_know', status: 'done' });

  const promoted = memory.search('网关日志', 10, { domain: 'all' }).find((m) => m.source === 'knowledge');
  assert.ok(promoted, '用过三次之后晋升成记忆');
  assert.ok(memory.refsOf(promoted.id).some((ref) => ref.kind === 'category' && ref.key === 'cat_blue'), '分类引用没有丢');
});

test('旧说法又被提起：从「已被替代」恢复，并把替代它的那条归档', () => {
  const older = memory.write({ text: '喜欢深色主题', layer: 'profile', kind: 'preference', subject: 'owner' });
  const newer = memory.write({ text: '不喜欢深色主题了', layer: 'profile', kind: 'preference', subject: 'owner' });
  assert.equal(memory.get(older.id).archived, true);

  const again = memory.write({ text: '喜欢深色主题', layer: 'profile', kind: 'preference', subject: 'owner' });
  assert.equal(again.id, older.id, '还是同一条，不重复记');
  assert.equal(memory.get(older.id).archived, false, '重新想起来了');
  assert.equal(memory.get(older.id).superseded_by, null);
  assert.equal(memory.get(newer.id).archived, true, '后来的说法被归档');
  assert.equal(memory.get(newer.id).superseded_by, older.id);

  const picked = memory.context('深色主题');
  assert.ok(picked.some((m) => m.id === older.id));
  assert.ok(!picked.some((m) => m.id === newer.id));
});

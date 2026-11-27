// 记忆之间的边：同一次想起的连边（24 小时内只长一次）、任务结果连回背景、联想两跳、冷层复活、有效期过滤。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-memedges-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { db, saveSettings, transaction } = await import('../src/db.js');
const memory = await import('../src/memory.js');
const { matchEntities } = await import('../src/entities.js');

test.after(() => removeTemp(dataDir));

const wsDir = path.join(dataDir, 'blue');
fs.mkdirSync(wsDir, { recursive: true });
saveSettings({ workspaces: [{ id: 'w_edge', name: '蓝马项目', path: wsDir }] });
const refs = [{ kind: 'workspace', key: 'w_edge', name: '蓝马项目' }];

const insertRaw = db.prepare(`
  INSERT INTO memories(id, layer, kind, text, tags, importance, source, created_at, use_count, domain, archived, valid_from)
  VALUES(?, ?, ?, ?, '[]', ?, 'test', ?, 0, 'work', 0, ?)
`);

test('同一次被想起的两条互相连边：24 小时内只长一次，之后权重往上加', () => {
  const a = memory.write({ text: '部署前要跑 migrate', layer: 'semantic', kind: 'fact' });
  const b = memory.write({ text: '测试账号在密码库里', layer: 'semantic', kind: 'fact' });
  assert.equal(memory.coActivate([a.id, b.id]), 1);
  let edge = db.prepare("SELECT * FROM memory_edges WHERE kind = 'same_topic'").get();
  assert.ok(edge, '边建出来了');
  assert.equal(edge.weight, 0.5);

  assert.equal(memory.coActivate([a.id, b.id]), 0, '同一天不再长');
  const later = Date.now() + 25 * 3600 * 1000;
  assert.equal(memory.coActivate([a.id, b.id], { at: later }), 1);
  edge = db.prepare("SELECT * FROM memory_edges WHERE kind = 'same_topic'").get();
  assert.equal(Number(edge.weight.toFixed(2)), 0.7, '权重加 0.2');
  assert.equal(edge.co_count, 2);
});

test('两跳联想：消息没提项目，也能顺着边把项目里的旧经验带回来', () => {
  const old = '2020-01-01T00:00:00.000Z';
  // B、C 很久以前、也不重要：只靠候选池够不着，只能靠边。
  const b = 'm_edge_b';
  const c = 'm_edge_c';
  insertRaw.run(b, 'semantic', 'fact', '迁移脚本要先备份数据库', 0.01, old, old);
  insertRaw.run(c, 'episodic', 'note', '那次备份用了两小时', 0.01, old, old);
  // 大量日常记录把 B、C 挤出「最近 200」和「重要 60」。
  transaction(() => {
    for (let i = 0; i < 210; i += 1) {
      insertRaw.run(`m_fill_${i}`, 'episodic', 'note', `日常记录第 ${i} 条：整理桌面`, 0.3, new Date(Date.now() - i * 1000).toISOString(), old);
    }
  });
  const a = memory.write({
    text: '蓝马项目的 beta 合并前要跑迁移脚本',
    layer: 'semantic',
    kind: 'fact',
    importance: 0.9,
    refs
  });
  memory.linkMemories(a.id, [b], 'same_topic', 2);
  memory.linkMemories(b, [c], 'same_topic', 2);

  const picked = memory.recall('那个项目要合了', { limit: 10, refs: matchEntities('那个项目要合了', { cwd: wsDir }) });
  const ids = picked.map((m) => m.id);
  assert.ok(ids.includes(b), '一跳的 B 被带出来');
  assert.ok(ids.includes(c), '两跳的 C 也被带出来');
  const hit = picked.find((m) => m.id === c);
  assert.ok(hit.activated > 0, '带上了联想分');
});

test('冷层：已经淡忘、但挂在当前工作区上的记忆，能被触达想起并复活', () => {
  const item = memory.write({ text: '这个项目的网关超时是 30 秒', layer: 'semantic', kind: 'fact', refs });
  db.prepare('UPDATE memories SET archived = 1 WHERE id = ?').run(item.id);
  const picked = memory.recall('跑一下测试', { limit: 20, refs });
  const hit = picked.find((m) => m.id === item.id);
  assert.ok(hit, '淡忘的记忆被触达召回');
  assert.equal(hit.cold, true);
  assert.equal(memory.get(item.id).archived, false, '想起来了就恢复');
});

test('过了有效期的记忆不再被注入（但没删）', () => {
  const item = memory.write({ text: '旧的价格是 199', layer: 'semantic', kind: 'fact', refs });
  db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), item.id);
  const picked = memory.recall('旧的价格', { limit: 20, refs });
  assert.ok(!picked.some((m) => m.id === item.id), '失效的不注入');
  assert.ok(memory.get(item.id), '记录还在');
  assert.deepEqual(memory.search('旧的价格', 10, { validOnly: true }), []);
});

test('人格域的记忆不会被业务联想带出来', () => {
  const work = memory.write({ text: '蓝马项目周报周五发', layer: 'semantic', kind: 'fact' });
  const persona = memory.write({ text: '静静不太喜欢催人', layer: 'profile', kind: 'self', domain: 'persona', subject: 'self' });
  const [a, b] = work.id < persona.id ? [work.id, persona.id] : [persona.id, work.id];
  db.prepare("INSERT OR IGNORE INTO memory_edges(a, b, kind, weight, co_count, created_at) VALUES(?,?,'same_topic',1,1,?)").run(a, b, new Date().toISOString());
  const picked = memory.recall('周报', { limit: 30, domain: 'work' });
  assert.ok(!picked.some((m) => m.id === persona.id), '人格记忆不串到业务里');
});

test('整理：忘记时立刻清边，弱边按时间衰减剪掉，悬空边也会清', () => {
  const a = memory.write({ text: '要剪掉的边 A', layer: 'semantic', kind: 'fact' });
  const b = memory.write({ text: '要剪掉的边 B', layer: 'semantic', kind: 'fact' });
  const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  db.prepare("INSERT INTO memory_edges(a,b,kind,weight,co_count,created_at,last_fired_at) VALUES(?,?,'same_topic',0.05,1,?,?)")
    .run(x, y, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');

  // 删除记忆时边立刻清掉，不留悬空。
  const gone = memory.write({ text: '会被删掉的记忆', layer: 'semantic', kind: 'fact' });
  const [gx, gy] = gone.id < a.id ? [gone.id, a.id] : [a.id, gone.id];
  db.prepare("INSERT INTO memory_edges(a,b,kind,weight,co_count,created_at) VALUES(?,?,'same_task',1,1,?)")
    .run(gx, gy, new Date().toISOString());
  memory.forget(gone.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE a = ? OR b = ?').get(gone.id, gone.id).c, 0);

  // 旧数据/外部直接删表留下的悬空边，maintain 里清掉。
  const ghost = memory.write({ text: '只删表不删边的记忆', layer: 'semantic', kind: 'fact' });
  const [hx, hy] = ghost.id < a.id ? [ghost.id, a.id] : [a.id, ghost.id];
  db.prepare("INSERT INTO memory_edges(a,b,kind,weight,co_count,created_at) VALUES(?,?,'same_task',1,1,?)")
    .run(hx, hy, new Date().toISOString());
  db.prepare('DELETE FROM memories WHERE id = ?').run(ghost.id);

  const result = memory.maintain();
  assert.ok(result.edges >= 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE weight < 0.1').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE a NOT IN (SELECT id FROM memories) OR b NOT IN (SELECT id FROM memories)').get().c, 0);
});

test('性能：一万条记忆、五千条边时，recall 仍然够快', () => {
  const perfRef = [{ kind: 'workspace', key: 'w_perf', name: '性能项目' }];
  saveSettings({ workspaces: [{ id: 'w_perf', name: '性能项目', path: wsDir }] });
  const base = Date.now() - 30 * 24 * 3600 * 1000;
  transaction(() => {
    for (let i = 0; i < 10000; i += 1) {
      insertRaw.run(`m_perf_${i}`, i % 5 ? 'episodic' : 'semantic', 'fact', `性能测试记忆第 ${i} 条：接口重试要带退避`, 0.3 + (i % 10) / 100, new Date(base + i * 1000).toISOString(), new Date(base).toISOString());
    }
    for (let i = 0; i < 5000; i += 1) {
      const a = `m_perf_${(i * 7) % 10000}`;
      const b = `m_perf_${(i * 13 + 1) % 10000}`;
      const [x, y] = a < b ? [a, b] : [b, a];
      db.prepare("INSERT OR IGNORE INTO memory_edges(a,b,kind,weight,co_count,created_at,last_fired_at) VALUES(?,?,'same_topic',0.5,1,?,?)")
        .run(x, y, new Date(base).toISOString(), new Date(base).toISOString());
    }
  });
  const times = [];
  for (let i = 0; i < 20; i += 1) {
    const start = performance.now();
    memory.recall('接口重试要带退避', { limit: 10, refs: perfRef });
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95) - 1];
  assert.ok(p95 < 250, `P95 ${p95.toFixed(1)}ms 太慢`);
});

test('同一个工作区的任务结果按时间串 before 边', () => {
  const r1 = memory.write({ text: '任务 A 的结果：测试通过', layer: 'episodic', kind: 'task_result', refs });
  const r2 = memory.write({ text: '任务 B 的结果：接口发版', layer: 'episodic', kind: 'task_result', refs });
  assert.equal(memory.previousTaskResult(r2.id, 'w_edge'), r1.id);
  assert.equal(memory.linkBefore(r1.id, r2.id), 1);
  const edge = db.prepare("SELECT * FROM memory_edges WHERE kind = 'before'").get();
  assert.equal(edge.a, r1.id);
  assert.equal(edge.b, r2.id);
});

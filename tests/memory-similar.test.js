// embedding 相似边（可选）：批处理、阈值、跨域不连、重复跑不重复算；图谱数据只含当前域。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-memsim-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { db, saveSettings } = await import('../src/db.js');
const memory = await import('../src/memory.js');
const memoryIndex = await import('../src/memory-index.js');

test.after(() => removeTemp(dataDir));

const fakeEmbed = async (texts) => texts.map((text) => {
  if (/备份|迁移/.test(text)) return [1, 0.15, 0];
  return [0, 1, 0];
});

test('cosine：方向越接近越相似，长度不敏感', () => {
  assert.ok(memoryIndex.cosine([1, 0], [0.9, 0.1]) > 0.99);
  assert.equal(memoryIndex.cosine([1, 0], [0, 1]), 0);
  assert.equal(memoryIndex.cosine([1, 0], [1, 0, 0]), 0);
});

test('相似边：超过阈值才连，跨域不连，重复跑不会重复索引', async () => {
  const m1 = memory.write({ text: '迁移前一定要备份数据库', layer: 'semantic', kind: 'fact' });
  const m2 = memory.write({ text: '做数据库备份要留出两小时', layer: 'semantic', kind: 'fact' });
  const m3 = memory.write({ text: '周报模板放在共享盘', layer: 'semantic', kind: 'fact' });
  const persona = memory.write({ text: '静静也不太喜欢迁移', layer: 'profile', kind: 'self', domain: 'persona', subject: 'self' });

  saveSettings({ memory: { embedding: { enabled: true, model: 'fake-embed' } } });
  const result = await memoryIndex.indexSimilarMemories({ embedFn: fakeEmbed });
  assert.equal(result.indexed, 4);
  assert.ok(result.linked >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memory_vectors').get().c, 4, '每条都存了向量');

  const edge = db.prepare("SELECT * FROM memory_edges WHERE kind = 'similar' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))").get(m1.id, m2.id, m2.id, m1.id);
  assert.ok(edge, '两条相关的连上了');
  assert.ok(edge.weight >= 0.5);
  assert.ok(!db.prepare("SELECT 1 FROM memory_edges WHERE kind = 'similar' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))").get(m1.id, m3.id, m3.id, m1.id), '不相关的没连');
  assert.ok(!db.prepare("SELECT 1 FROM memory_edges WHERE kind = 'similar' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))").get(m1.id, persona.id, persona.id, m1.id), '跨域不连');

  const again = await memoryIndex.indexSimilarMemories({ embedFn: fakeEmbed });
  assert.equal(again.skipped, 'nothing');
  assert.equal(again.indexed, 0);
});

test('关掉开关时不动任何东西', async () => {
  saveSettings({ memory: { embedding: { enabled: false, model: 'fake-embed' } } });
  memory.write({ text: '关掉之后又记的一条', layer: 'semantic', kind: 'fact' });
  const result = await memoryIndex.indexSimilarMemories({ embedFn: fakeEmbed });
  assert.equal(result.skipped, 'disabled');
  assert.equal(result.indexed, 0);
});

test('图谱数据：只含当前域，带实体节点和边', () => {
  const graph = memory.graph({ domain: 'work' });
  const memoryNodes = graph.nodes.filter((node) => node.type === 'memory');
  assert.ok(memoryNodes.length >= 3);
  assert.ok(memoryNodes.every((node) => !node.title.includes('静静也不太喜欢迁移')), '人格记忆不在业务图谱里');
  assert.ok(graph.links.some((link) => link.kind === 'similar'), '相似边在图里');
  const personaGraph = memory.graph({ domain: 'persona' });
  assert.ok(personaGraph.nodes.some((node) => node.type === 'memory' && node.title.includes('静静也不太喜欢迁移')));
  assert.ok(!personaGraph.nodes.some((node) => node.title.includes('周报模板')), '业务记忆不在人格图谱里');
});

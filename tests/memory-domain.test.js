// 记忆分两域、存同一张表：业务（work）给任务和 Worker，人格（persona）给静静以自己身份说话时用，互不混用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-memdomain-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { db } = await import('../src/db.js');
const memory = await import('../src/memory.js');

test.after(() => removeTemp(dataDir));

test('两个域在同一张表里，默认按业务读写；业务的上下文和搜索拿不到人格记忆，反过来也一样', () => {
  const work = memory.remember({ text: '蓝马 4.5 预计周五提测', layer: 'semantic' });
  const self = memory.remember({ text: '静静怕黑，不爱讲鬼故事', layer: 'profile', domain: 'persona' });
  assert.equal(work.domain, 'work', '不写 domain 就是业务');
  assert.equal(self.domain, 'persona');
  assert.equal(memory.remember({ text: 'x', domain: 'nope' }).domain, 'work', '不认识的域按业务处理');
  const tables = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE id IN (?, ?)").get(work.id, self.id).c;
  assert.equal(tables, 2, '同一张表');

  const texts = (items) => items.map((m) => m.text);
  assert.ok(texts(memory.context('蓝马')).includes(work.text));
  assert.ok(!texts(memory.context('静静')).includes(self.text), '任务的上下文里没有人格记忆');
  assert.ok(texts(memory.context('静静', { domain: 'persona' })).includes(self.text));
  assert.ok(!texts(memory.context('蓝马', { domain: 'persona' })).includes(work.text), '人格的上下文里没有业务记忆');

  assert.deepEqual(texts(memory.search('鬼故事')), [], '默认只搜业务');
  assert.deepEqual(texts(memory.search('鬼故事', 10, { domain: 'persona' })), [self.text]);
  assert.equal(memory.search('提测', 10, { domain: 'all' }).length, 1);
  assert.equal(memory.list({ domain: 'all' }).length, 3);
  assert.equal(memory.list({ domain: 'persona' }).length, 1);
});

test('同一句话在两个域里各算各的；可以改到另一个域；统计按域分开', () => {
  const a = memory.remember({ text: '喜欢简洁的回复', layer: 'profile' });
  const b = memory.remember({ text: '喜欢简洁的回复', layer: 'profile', domain: 'persona' });
  assert.notEqual(a.id, b.id, '去重只在同一个域里');
  assert.equal(memory.remember({ text: '喜欢简洁的回复', layer: 'profile' }).id, a.id);

  const moved = memory.update(a.id, { domain: 'persona' });
  assert.equal(moved.domain, 'persona');
  assert.equal(memory.update(a.id, { text: '喜欢简洁、不啰嗦的回复' }).domain, 'persona', '只改内容时域不变');

  const counts = memory.domainStats();
  assert.equal(counts.work + counts.persona, memory.list({ domain: 'all', limit: 100 }).length);
  const personaLayers = memory.allLayersStats({ domain: 'persona' });
  assert.equal(personaLayers.reduce((sum, s) => sum + s.count, 0), counts.persona);
});

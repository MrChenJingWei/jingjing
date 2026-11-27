// 记忆的「触达点」：从一句话 + 当前目录认出工作区/分类/人/工具/文件，规则匹配，不调模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-entities-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { db, saveSettings } = await import('../src/db.js');
const people = await import('../src/people.js');
const { hasName, listEntities, matchEntities, normalizeRefs, refsForMemory } = await import('../src/entities.js');

test.after(() => removeTemp(dataDir));

const wsDir = path.join(dataDir, 'blue');
fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
const stamp = new Date().toISOString();
saveSettings({ workspaces: [{ id: 'w_blue', name: '蓝马项目', path: wsDir, aliases: ['蓝马'] }] });
db.prepare('INSERT INTO task_categories(id, axis, key, title, origin, state, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run('cat_blue', 'relation', 'cat_blue', '蓝马需求', 'auto', 'active', stamp, stamp);
people.ensure('p_zhang', { name: '张三', source: 'wecom' });

test('hasName：拉丁名按词边界，中文两字起，单字不认', () => {
  assert.equal(hasName('用 git 提交', 'git'), true);
  assert.equal(hasName('digit 不是 git', 'git'), true);
  assert.equal(hasName('先运行 digit 看看', 'git'), false, 'digit 里不该命中 git');
  assert.equal(hasName('让张三看一下', '张三'), true);
  assert.equal(hasName('让张三看一下', '主'), false, '单字不认，避免误伤');
});

test('listEntities：工作区、分类、人、工具都在；主人不参与匹配', () => {
  const list = listEntities();
  assert.ok(list.some((e) => e.kind === 'workspace' && e.key === 'w_blue' && e.name === '蓝马项目'));
  assert.ok(list.some((e) => e.kind === 'category' && e.key === 'cat_blue'));
  assert.ok(list.some((e) => e.kind === 'person' && e.key === 'p_zhang'));
  assert.ok(list.some((e) => e.kind === 'tool' && e.key === 'git'));
  assert.ok(!list.some((e) => e.kind === 'person' && e.key === 'owner'), '主人一直在，不当触达点');
});

test('matchEntities：一句话认出工作区、分类、人和工具；cwd 也算触达', () => {
  const refs = matchEntities('让张三用 git 把蓝马需求在蓝马项目里的测试跑一下', {});
  const has = (kind, key) => refs.some((ref) => ref.kind === kind && ref.key === key);
  assert.ok(has('workspace', 'w_blue'));
  assert.ok(has('category', 'cat_blue'));
  assert.ok(has('person', 'p_zhang'));
  assert.ok(has('tool', 'git'));

  // 消息里什么都没提，但任务在工作区里跑：cwd 就是触达点。
  const byCwd = matchEntities('把测试跑一下', { cwd: path.join(wsDir, 'src') });
  assert.deepEqual(byCwd.filter((ref) => ref.kind === 'workspace').map((ref) => ref.key), ['w_blue']);

  // 不带 cwd、也没提到，就什么都不认。
  assert.deepEqual(matchEntities('把测试跑一下', {}), []);
});

test('matchEntities：文件按认识的后缀认，URL 和版本号不误认', () => {
  const refs = matchEntities('看下 src/app.js 和 package.json，再打开 v0.11.6 的说明', {});
  const files = refs.filter((ref) => ref.kind === 'file').map((ref) => ref.key);
  assert.deepEqual(files.sort(), ['app.js', 'package.json']);
  assert.ok(!refs.some((ref) => ref.kind === 'file' && ref.key.includes('0.11.6')));
});

test('normalizeRefs：认识的种类、非空 key、去重、限量', () => {
  const refs = normalizeRefs([
    { kind: 'workspace', key: 'w_blue', name: '蓝马项目' },
    { kind: 'workspace', key: 'w_blue', name: '重复' },
    { kind: 'nope', key: 'x' },
    { kind: 'tool', key: '' },
    { kind: 'tool', key: 'git' }
  ]);
  assert.deepEqual(refs, [
    { kind: 'workspace', key: 'w_blue', name: '蓝马项目' },
    { kind: 'tool', key: 'git', name: 'git' }
  ]);
});

test('refsForMemory：业务域自动认，人格域只认显式给的', () => {
  const work = refsForMemory('蓝马项目下周提测', { domain: 'work' });
  assert.ok(work.some((ref) => ref.kind === 'workspace' && ref.key === 'w_blue'));

  const explicit = refsForMemory('蓝马项目下周提测', { domain: 'work', refs: [{ kind: 'category', key: 'cat_blue' }] });
  assert.ok(explicit.some((ref) => ref.kind === 'category' && ref.key === 'cat_blue'));
  assert.ok(explicit.some((ref) => ref.kind === 'workspace' && ref.key === 'w_blue'));

  assert.deepEqual(refsForMemory('蓝马项目下周提测', { domain: 'persona' }), [], '人格记忆不自动挂业务实体');
});

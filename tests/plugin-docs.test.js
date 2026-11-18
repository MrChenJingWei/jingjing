// 「怎么写插件」：文档按来源 / Worker 切开；例子只能看官方来源插件和内置 Worker（不能借 id 读别的文件）；
// 模板复制成「我的」插件后 id 不重复、能通过规范并被加载。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-docs-'));
process.env.JINGJING_DATA_DIR = dataDir;

const plugins = await import('../src/plugins.js');
const docs = await import('../src/plugin-docs.js');
await plugins.reloadPlugins();

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('文档按「## Worker 插件」切成两份', () => {
  const source = docs.guide('source');
  assert.match(source.markdown, /^# 写一个任务来源插件/);
  assert.match(source.markdown, /## 带状态的来源/);
  assert.doesNotMatch(source.markdown, /## Worker 插件/);
  const worker = docs.guide('worker');
  assert.match(worker.markdown, /^# 写一个 Worker 插件/);
  assert.match(worker.markdown, /ctx：宿主能力/);
  assert.doesNotMatch(worker.markdown, /## 条目格式/);
});

test('例子：来源看官方来源插件，Worker 看内置 Worker；源码只读、大文件不给内容', () => {
  const sources = docs.examples('source').map((item) => item.id);
  assert.ok(sources.includes('tapd') && sources.includes('calendar'));
  const workers = docs.examples('worker').map((item) => item.id);
  assert.ok(workers.includes('claude') && workers.includes('codex'));
  const tapd = docs.exampleFiles('source', 'tapd').files.map((f) => f.name);
  assert.deepEqual(tapd.slice(0, 2), ['plugin.json', 'index.js']);
  assert.ok(tapd.includes('status.js'));
  const wecom = docs.exampleFiles('source', 'wecom').files;
  assert.ok(wecom.some((f) => f.name === 'index.js' && f.content === null), '打包产物太大不给内容');
  assert.ok(!wecom.some((f) => f.name === 'BUILD.json'));
});

test('例子 id 不能拿来读别的东西', () => {
  for (const id of ['../src', '..', 'claude', '.template', 'node_modules', 'not-there']) {
    assert.throws(() => docs.exampleFiles('source', id), (err) => err.statusCode === 404, id);
  }
  assert.throws(() => docs.exampleFiles('worker', 'tapd'), (err) => err.statusCode === 404);
  assert.throws(() => docs.userPluginDir('../../etc'), (err) => err.statusCode === 404);
});

test('模板复制成「我的」插件：id 不重复、去掉指不到的 $schema、能通过规范被加载', async () => {
  const first = docs.createFromTemplate('source');
  const second = docs.createFromTemplate('source');
  const worker = docs.createFromTemplate('worker');
  assert.equal(first.id, 'my-source');
  assert.equal(second.id, 'my-source-2');
  assert.equal(worker.id, 'my-worker');
  assert.equal(path.dirname(first.dir), plugins.USER_PLUGIN_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(second.dir, 'plugin.json'), 'utf8'));
  assert.equal(manifest.id, 'my-source-2');
  assert.equal(manifest.$schema, undefined);
  assert.ok(fs.existsSync(path.join(second.dir, 'README.md')));
  await plugins.reloadPlugins();
  const loaded = plugins.listPlugins().map((p) => p.pluginId);
  assert.ok(loaded.includes('my-source') && loaded.includes('my-source-2'));
  assert.deepEqual(plugins.pluginErrors().filter((e) => /my-/.test(e.plugin)), []);
  assert.equal(docs.userPluginDir('my-worker'), worker.dir);
});

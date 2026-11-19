import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateManifest, validateConfig, validateWorkerLimits, PluginSpecError, WORKER_DEFAULTS } from '../src/plugin-spec.js';

function tempPlugin(manifest = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-plugin-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export async function poll() { return { items: [] }; }\n');
  const raw = {
    id: 'demo',
    name: '演示来源',
    entry: 'index.js',
    config: [],
    ...manifest
  };
  return { dir, raw };
}

const baseConfig = [
  { key: 'url', label: '地址', type: 'url', required: true },
  { key: 'limit', label: '数量', type: 'number', default: 5, min: 1, max: 10 },
  { key: 'mode', label: '模式', type: 'select', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }
];

test('合法 manifest 会被归一化', () => {
  const { dir, raw } = tempPlugin({ config: baseConfig });
  const manifest = validateManifest(raw, { dir, dirName: 'demo' });
  assert.equal(manifest.id, 'demo');
  assert.equal(manifest.intervalMinutes, 30);
  assert.equal(manifest.config.length, 3);
  assert.equal(manifest.config[1].default, 5);
  assert.equal(manifest.apiVersion, 1);
});

test('目录名必须和 id 一致', () => {
  const { dir, raw } = tempPlugin();
  assert.throws(
    () => validateManifest(raw, { dir, dirName: 'another' }),
    (err) => err instanceof PluginSpecError && /目录名/.test(err.message)
  );
});

test('拒绝非法 id、entry 越界和未知字段类型', () => {
  const { dir } = tempPlugin();
  assert.throws(() => validateManifest({ id: 'Bad ID', name: 'x', entry: 'index.js' }, { dir }), /id/);
  assert.throws(
    () => validateManifest({ id: 'demo', name: 'x', entry: '../index.js' }, { dir }),
    /相对路径/
  );
  const { dir: dir2 } = tempPlugin();
  assert.throws(
    () => validateManifest({ id: 'demo', name: 'x', entry: 'index.js', config: [{ key: 'a', label: 'A', type: 'file' }] }, { dir: dir2 }),
    /type/
  );
});

test('select 必须提供 options，number 的 min/max 必须合法', () => {
  const { dir } = tempPlugin();
  assert.throws(
    () => validateManifest({ id: 'demo', name: 'x', entry: 'index.js', config: [{ key: 'a', label: 'A', type: 'select' }] }, { dir }),
    /options/
  );
  assert.throws(
    () => validateManifest({
      id: 'demo', name: 'x', entry: 'index.js',
      config: [{ key: 'a', label: 'A', type: 'number', min: 10, max: 1 }]
    }, { dir }),
    /min/
  );
});

test('配置：补默认值、数字/布尔/选项校验', () => {
  const { dir, raw } = tempPlugin({
    config: [...baseConfig, { key: 'enabled', label: '启用', type: 'checkbox', default: true }]
  });
  const manifest = validateManifest(raw, { dir, dirName: 'demo' });
  const config = validateConfig(manifest, { url: 'https://example.com/feed', mode: 'b' });
  assert.equal(config.limit, 5);
  assert.equal(config.enabled, true);
  assert.equal(config.mode, 'b');

  const coerced = validateConfig(manifest, { url: 'https://example.com', limit: '8', enabled: 'false' });
  assert.equal(coerced.limit, 8);
  assert.equal(coerced.enabled, false);

  assert.throws(() => validateConfig(manifest, { url: 'https://example.com', limit: 100 }), /不能大于/);
  assert.throws(() => validateConfig(manifest, { url: 'https://example.com', mode: 'c' }), /不是可选值/);
  assert.throws(() => validateConfig(manifest, { url: 'file:///tmp/x' }), /http\/https/);
});

test('启用时校验必填项，关闭时允许留空', () => {
  const { dir, raw } = tempPlugin({ config: baseConfig });
  const manifest = validateManifest(raw, { dir, dirName: 'demo' });
  assert.throws(
    () => validateConfig(manifest, {}, { requireAll: true }),
    /缺少必填配置/
  );
  const lenient = validateConfig(manifest, {}, { requireAll: false });
  assert.equal(lenient.url, '');
});

test('未知配置键会被丢弃，密码和文本原样保留', () => {
  const { dir, raw } = tempPlugin({
    config: [
      { key: 'pass', label: '密码', type: 'password' },
      { key: 'name', label: '名字', type: 'text' }
    ]
  });
  const manifest = validateManifest(raw, { dir, dirName: 'demo' });
  const config = validateConfig(manifest, { pass: 'secret', name: '王工', typo: 'x' });
  assert.deepEqual(config, { pass: 'secret', name: '王工' });
});

test('multiInstance 必须是布尔值并归一化', () => {
  const { dir, raw } = tempPlugin({ multiInstance: true });
  const manifest = validateManifest(raw, { dir, dirName: 'demo' });
  assert.equal(manifest.multiInstance, true);
  const { dir: dir2, raw: raw2 } = tempPlugin();
  assert.equal(validateManifest(raw2, { dir: dir2, dirName: 'demo' }).multiInstance, false);
  const { dir: dir3, raw: raw3 } = tempPlugin({ multiInstance: 'yes' });
  assert.throws(() => validateManifest(raw3, { dir: dir3, dirName: 'demo' }), /multiInstance/);
});

test('Worker manifest：worker 段缺省时补默认值，来源插件不能写 worker 段', () => {
  const { dir, raw } = tempPlugin({ kind: 'worker' });
  const manifest = validateManifest(raw, { dir, dirName: 'demo' });
  assert.deepEqual(manifest.worker, { ...WORKER_DEFAULTS, abilities: ['text'] });
  const { dir: dir2, raw: raw2 } = tempPlugin({ worker: { cost: 1 } });
  assert.throws(() => validateManifest(raw2, { dir: dir2, dirName: 'demo' }), /只有 kind 为 worker/);
});

test('Worker manifest：校验能力词表、关键词正则和运行限制范围', () => {
  const ok = (worker) => {
    const { dir, raw } = tempPlugin({ kind: 'worker', worker });
    return validateManifest(raw, { dir, dirName: 'demo' }).worker;
  };
  assert.deepEqual(ok({ abilities: ['code', 'text', 'code'], cost: 4, keywords: '飞书|lark', timeoutMinutes: 90, concurrency: 1, retries: 0 }), {
    abilities: ['code', 'text'], cost: 4, keywords: '飞书|lark', aliases: [], capabilities: [], recovery: 'ask', timeoutMinutes: 90, concurrency: 1, retries: 0
  });
  assert.equal(ok({ recovery: 'resume' }).recovery, 'resume');
  assert.throws(() => ok({ recovery: 'later' }), /recovery 只能是/);
  assert.throws(() => ok({ abilities: ['fly'] }), /abilities 不支持/);
  assert.throws(() => ok({ abilities: [] }), /非空数组/);
  assert.throws(() => ok({ keywords: '(' }), /不是合法正则/);
  assert.throws(() => ok({ timeoutMinutes: 0 }), /timeoutMinutes/);
  assert.throws(() => ok({ concurrency: 9 }), /concurrency/);
  assert.throws(() => ok({ retries: 1.5 }), /retries/);
  assert.throws(() => ok({ speed: 1 }), /未知字段/);
});

test('本机运行限制覆盖：空值沿用默认，越界报错', () => {
  assert.deepEqual(validateWorkerLimits({ timeoutMinutes: '120', concurrency: '', retries: null }), { timeoutMinutes: 120 });
  assert.deepEqual(validateWorkerLimits(undefined), {});
  assert.throws(() => validateWorkerLimits({ retries: 4 }), /失败自动重试次数/);
});

test('仓库里的内置 Worker 和 Worker 模板都符合规范', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const builtinDir = path.join(root, 'workers');
  const ids = fs.readdirSync(builtinDir).filter((name) => !name.startsWith('.')).sort();
  assert.deepEqual(ids, ['claude', 'codex', 'dsh', 'file', 'llm', 'shell']);
  for (const id of ids) {
    const dir = path.join(builtinDir, id);
    const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir, dirName: id });
    assert.equal(manifest.kind, 'worker', id);
  }
  const templateDir = path.join(root, 'plugins', '.template-worker');
  const template = validateManifest(JSON.parse(fs.readFileSync(path.join(templateDir, 'plugin.json'), 'utf8')), { dir: templateDir });
  assert.equal(template.kind, 'worker');
});

test('筛选条件（filters）：归一化去空去重，接受 JSON 字符串，拒绝非法字段名和过多条件', () => {
  const { dir, raw } = tempPlugin({ config: [{ key: 'filters', label: '筛选条件', type: 'filters' }] });
  const manifest = validateManifest(raw, { dir, dirName: 'demo' });
  assert.deepEqual(manifest.config[0].default, []);
  assert.deepEqual(validateConfig(manifest, {}).filters, [], '没填就是空列表');

  const config = validateConfig(manifest, {
    filters: [
      { field: 'bug.status', values: ['new', 'new', ' ', 'reopened'] },
      { field: '', values: ['x'] },
      { field: 'story.owner', values: '我' },
      { field: 'bug.label', values: [] }
    ]
  });
  assert.deepEqual(config.filters, [
    { field: 'bug.status', values: ['new', 'reopened'] },
    { field: 'story.owner', values: ['我'] }
  ]);
  assert.deepEqual(validateConfig(manifest, { filters: '[{"field":"bug.status","values":["new"]}]' }).filters, [{ field: 'bug.status', values: ['new'] }]);

  assert.throws(() => validateConfig(manifest, { filters: [{ field: 'bug status', values: ['x'] }] }), /字段名不合法/);
  assert.throws(() => validateConfig(manifest, { filters: 'not json' }), /不是合法的条件列表/);
  assert.throws(() => validateConfig(manifest, { filters: Array.from({ length: 13 }, (_, i) => ({ field: `f${i}`, values: ['x'] })) }), /最多 12 个条件/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateManifest, validateConfig, PluginSpecError } from '../src/plugin-spec.js';

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

// 宿主层的几个保护：同一个数据目录只能跑一个服务、插件重装后子文件也刷新、
// 实时连接按浏览器限数、Worker 的 detect() 结果短时间缓存。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-guards-'));
process.env.JINGJING_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { acquireInstanceLock, releaseInstanceLock } = await import('../src/instance-lock.js');
const { importPluginEntry, reloadsSubmodules } = await import('../src/plugin-loader.js');
const { bus, MAX_STREAMS_PER_CLIENT } = await import('../src/events.js');
const { saveSettings } = await import('../src/db.js');
const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');

test.after(() => {
  releaseInstanceLock();
  removeTemp(dataDir);
});

function tryLockInOtherProcess(dir) {
  // Windows 上 import 绝对路径要写成 file:// URL。
  const lockModule = pathToFileURL(path.join(ROOT, 'src', 'instance-lock.js')).href;
  const script = `import { acquireInstanceLock } from ${JSON.stringify(lockModule)}; console.log(JSON.stringify(acquireInstanceLock(${JSON.stringify(dir)})));`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return JSON.parse(out.stdout.trim());
}

test('同一个数据目录只能有一个进程拿到锁；进程退出后锁自动释放', () => {
  const dir = path.join(dataDir, 'lock');
  assert.deepEqual(tryLockInOtherProcess(dir), { ok: true }, '别的进程拿过又退出了，不留残留');
  assert.deepEqual(acquireInstanceLock(dir), { ok: true });
  assert.deepEqual(acquireInstanceLock(dir), { ok: true }, '同一个进程重复拿锁直接成功');
  const blocked = tryLockInOtherProcess(dir);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.pid, process.pid, '能报出是哪个进程拿着');
  releaseInstanceLock();
  assert.deepEqual(tryLockInOtherProcess(dir), { ok: true });
});

test('插件目录里任何文件改了，重新加载时入口相对引用的子文件也是新的', { skip: !reloadsSubmodules && '当前 Node 不支持模块钩子' }, async () => {
  const dir = path.join(dataDir, 'multi-file');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), "export { value } from './lib/value.js';\n");
  fs.writeFileSync(path.join(dir, 'lib', 'value.js'), 'export const value = 1;\n');
  const first = await importPluginEntry(dir, 'index.js');
  assert.equal(first.value, 1);
  assert.equal(await importPluginEntry(dir, 'index.js'), first, '没改就复用缓存');

  fs.writeFileSync(path.join(dir, 'lib', 'value.js'), 'export const value = 22;\n');
  const second = await importPluginEntry(dir, 'index.js');
  assert.equal(second.value, 22, '只改了子文件，入口没改');
});

function fakeResponse() {
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = () => true;
  res.end = () => {
    res.ended = true;
    res.emit('close');
  };
  return res;
}

test('实时连接按浏览器限数：同一个浏览器超出时关掉它自己最早的一条，不影响别的设备', () => {
  const phone = fakeResponse();
  const cleanups = [bus.subscribe(phone, { client: 'phone' })];
  const desktop = [];
  for (let i = 0; i < MAX_STREAMS_PER_CLIENT + 1; i += 1) {
    const res = fakeResponse();
    desktop.push(res);
    cleanups.push(bus.subscribe(res, { client: 'desktop' }));
  }
  assert.equal(desktop[0].ended, true, '同一个浏览器最早的一条被关掉');
  assert.equal(desktop.slice(1).some((res) => res.ended), false);
  assert.equal(phone.ended, undefined, '别的设备不受影响');
  for (const cleanup of cleanups) cleanup();
  assert.equal(bus.size, 0);
});

test('detect() 结果短时间缓存；改了配置或设置、点了检测就重新检测', () => {
  let calls = 0;
  workers.registerWorkerPlugin({
    manifest: validateManifest({ id: 'detect-count', kind: 'worker', name: 'detect-count', entry: 'index.js', config: [{ key: 'path', label: '路径', type: 'text' }] }),
    module: { execute: async () => ({ status: 'done', summary: 'ok' }), detect: () => { calls += 1; return true; } },
    dir: path.join(dataDir, 'detect-count'),
    isolate: false
  });
  workers.availability();
  workers.availability();
  workers.workerCatalog();
  assert.equal(calls, 1, '连续查询只检测一次');
  workers.saveWorkerConfig('detect-count', { config: { path: '/usr/bin' } });
  assert.equal(calls, 2, '保存配置后重新检测');
  workers.availability();
  assert.equal(calls, 2);
  saveSettings({ persona: '换个风格' });
  workers.availability();
  assert.equal(calls, 3, '全局设置变了也重新检测');
  workers.clearWhichCache();
  workers.availability();
  assert.equal(calls, 4, '点「检测」清缓存');
});

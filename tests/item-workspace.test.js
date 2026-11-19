// 来源条目自己带工作区（比如 TAPD 每个项目配一个）：任务落到那个工作区；
// 没带、或工作区已经删掉时，跟随来源绑定的 / 默认工作区。用假的来源插件和 Worker，不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-item-ws-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { saveSettings } = await import('../src/db.js');
const { validateManifest } = await import('../src/plugin-spec.js');
const plugins = await import('../src/plugins.js');
const workers = await import('../src/workers.js');
const discovery = await import('../src/discovery.js');
const scheduler = await import('../src/scheduler.js');

const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-ws-a-'));
const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-ws-b-'));
test.after(() => {
  for (const dir of [dataDir, wsA, wsB]) fs.rmSync(dir, { recursive: true, force: true });
});

const dir = path.join(plugins.USER_PLUGIN_DIR, 'ws-src');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'ws-src', name: '工作区测试', version: '0.1.0', entry: 'index.js', type: 'poll' }));
fs.writeFileSync(path.join(dir, 'index.js'), 'export async function poll() { return { items: [] }; }\n');
await plugins.reloadPlugins();

workers.registerWorkerPlugin({
  manifest: validateManifest({ id: 'ws-worker', kind: 'worker', name: '工作区测试 Worker', entry: 'index.js', worker: { abilities: ['text'], cost: 1 } }),
  module: { execute: async () => ({ status: 'done', summary: 'ok' }) },
  dir: path.join(dataDir, 'ws-worker'),
  isolate: false
});

saveSettings({
  provider: 'demo',
  workspaces: [
    { id: 'ws_a', name: '项目 A', path: wsA },
    { id: 'ws_b', name: '项目 B', path: wsB }
  ],
  defaultWorkspaceId: 'ws_a'
});

let n = 0;
async function ingest(extra = {}) {
  const result = await discovery.ingestItems('ws-src', [{
    externalId: `item-${(n += 1)}`,
    title: '请确认这个登录问题',
    content: '请确认登录问题',
    ...extra
  }]);
  const detail = result.details[0];
  return { detail, task: detail?.taskId ? scheduler.getTask(detail.taskId) : null };
}

test('条目指定工作区：任务的 cwd 和提示词都用它', async () => {
  const { task } = await ingest({ workspace: 'ws_b' });
  assert.equal(task.cwd, wsB);
  assert.ok(task.prompt.includes(wsB), '提示词里写着工作区路径');
  assert.match(task.prompt, /工作区：项目 B/);
});

test('条目没指定：跟随来源（来源没绑就跟随默认工作区）', async () => {
  const { task } = await ingest();
  assert.equal(task.cwd, wsA);
});

test('工作区已经删掉：当没指定，跟随来源，并记一条提示', async () => {
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    const { task } = await ingest({ workspace: 'ws_gone' });
    assert.equal(task.cwd, wsA);
  } finally {
    console.warn = warn;
  }
  assert.ok(warned.some((line) => /工作区不存在/.test(line)), '找不到时应该留下提示');
});

test('工作区 id 只认设置里建好的，插件带路径也指不到任意目录', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { task } = await ingest({ workspace: '/tmp/not-a-workspace' });
    assert.equal(task.cwd, wsA);
  } finally {
    console.warn = warn;
  }
});

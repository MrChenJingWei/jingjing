// 派任务时按「任务在哪个工作区里跑」触达记忆：提示词里没提项目名，也要把项目里的旧经验带上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-ctxmem-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const scheduler = await import('../src/scheduler.js');
const db = await import('../src/db.js');
const memory = await import('../src/memory.js');

test.after(() => removeTemp(dataDir));

const wsDir = path.join(dataDir, 'proj-blue');
fs.mkdirSync(wsDir, { recursive: true });
db.saveSettings({ workspaces: [{ id: 'w_proj', name: '蓝马项目', path: wsDir }] });
for (let i = 0; i < 15; i += 1) {
  memory.write({ text: `日常记录第 ${i} 条：今天整理了一下桌面`, layer: 'episodic', kind: 'note' });
}
memory.write({ text: 'beta 合并前要跑 migrate', layer: 'semantic', kind: 'fact', refs: [{ kind: 'workspace', key: 'w_proj' }] });

let seen = null;
const manifest = validateManifest({ id: 'mem-worker', kind: 'worker', name: 'mem-worker', entry: 'index.js', worker: {} });
workers.registerWorkerPlugin({
  manifest,
  module: { execute: async (task, ctx) => { seen = ctx.memories; return { status: 'done', summary: '好了' }; } },
  dir: path.join(dataDir, 'plugins', 'mem-worker'),
  isolate: false
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(fn, label = '条件', ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error(`等待超时：${label}`);
}

test('派任务时按工作区触达记忆：提示词里没提项目名也带上了', async () => {
  const task = scheduler.createTask({ title: '跑测试', prompt: '把测试跑一下', worker: 'mem-worker', cwd: wsDir });
  await waitFor(() => scheduler.getTask(task.id).status === 'done', '任务完成');
  assert.ok(seen, 'Worker 收到了 ctx.memories');
  assert.ok(
    seen.some((m) => m.text.includes('migrate')),
    `应当带上工作区里的记忆：${seen.map((m) => m.text).join(' / ')}`
  );
});

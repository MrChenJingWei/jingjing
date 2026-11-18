// 决策顺序：点名 > 模型（要有原文证据）> 能力 > 兜底。用假模型，不请求真实接口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-router-order-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { saveSettings } = await import('../src/db.js');
const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const router = await import('../src/router.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function addWorker(id, worker) {
  const dir = path.join(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), 'export async function execute() { return { status: "done", summary: "ok" }; }\n');
  const manifest = validateManifest({ id, kind: 'worker', name: id, entry: 'index.js', worker }, { dir, dirName: id });
  workers.registerWorkerPlugin({
    manifest,
    module: { execute: async () => ({ status: 'done', summary: 'ok' }) },
    dir,
    isolate: false
  });
}

await workers.loadBuiltinWorkers();
for (const id of ['llm', 'file', 'shell', 'claude', 'codex', 'dsh']) workers.deleteBuiltinWorker(id);
addWorker('coder', { abilities: ['code', 'text'], cost: 4, aliases: ['coder', '编码助手'], capabilities: ['shell'] });
addWorker('writer', { abilities: ['text'], cost: 1, aliases: ['writer'] });
addWorker('sleepy', { abilities: ['text'], cost: 1, aliases: ['sleepy'] });
workers.saveWorkerConfig('sleepy', { enabled: false });

saveSettings({ provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat' });

let script = () => ({ status: 500, body: 'unset' });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const out = script(body);
  return {
    ok: out.status === 200,
    status: out.status,
    text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)),
    json: async () => out.body
  };
};
const taskCall = (args) => ({
  status: 200,
  body: { choices: [{ message: { content: '', tool_calls: [{ type: 'function', function: { name: 'create_task', arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 9 } }
});

test('用户点名压过模型选择，并保留流程步骤', async () => {
  script = () => taskCall({ title: '改一下页面', worker: 'writer', evidence: '用 coder 做' });
  const out = await router.handleMessage('用 coder 做这个页面');
  assert.equal(out.task.worker, 'coder');
  assert.match(out.reply.text, /点名/);
});

test('模型给的理由在原文里找不到：忽略它的选择，按能力/兜底走', async () => {
  script = () => taskCall({ title: '写点东西', worker: 'coder', evidence: '用 coder 精修' });
  const out = await router.handleMessage('帮我写点东西');
  assert.equal(out.task.worker, 'writer');
  assert.match(out.reply.text, /找不到/);
});

test('文本点到具体能力：没有显式声明时回退到能执行命令的 Worker', async () => {
  script = () => taskCall({ title: '查缺陷', capability: 'tapd-cli' });
  const out = await router.handleMessage('用 tapd 查一下分给我的缺陷');
  assert.equal(out.task.worker, 'coder');
  assert.match(out.reply.text, /能执行本机命令/);
});

test('点名不可用时说明改派，不静默换人', async () => {
  saveSettings({ fallbackWorker: 'writer' });
  script = () => taskCall({ title: '做一下', evidence: '用 sleepy 做' });
  const out = await router.handleMessage('用 sleepy 做一下');
  assert.equal(out.task.worker, 'writer');
  assert.match(out.reply.text, /点名.*不可用/);
});

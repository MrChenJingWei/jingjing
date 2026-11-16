// 一次模型调用完成「判断 + 回答」：用假的 fetch 模拟 DeepSeek，验证调用次数和退回两步判断。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-router-tools-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { saveSettings } = await import('../src/db.js');
const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const workflows = await import('../src/workflows.js');
const router = await import('../src/router.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

await workers.loadBuiltinWorkers();
// 建出来的任务交给一个不调模型的假 Worker，避免它的请求混进计数。
const manifest = validateManifest({ id: 'quiet', kind: 'worker', name: '安静', entry: 'index.js', worker: { abilities: ['text'], cost: 1 } });
workers.registerWorkerPlugin({ manifest, module: { execute: () => new Promise(() => {}) }, dir: path.join(dataDir, 'quiet'), isolate: false });
for (const id of ['llm', 'file', 'shell', 'claude', 'codex', 'dsh']) workers.deleteBuiltinWorker(id);

saveSettings({ provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat' });

const calls = [];
let script = () => ({ status: 500, body: 'unset' });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const kind = body.tools ? 'tools' : body.response_format ? 'classify' : 'chat';
  calls.push({ kind, body });
  const out = script(kind, body);
  return {
    ok: out.status === 200,
    status: out.status,
    text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)),
    json: async () => out.body
  };
};
const reply = (message) => ({ status: 200, body: { choices: [{ message }], usage: { total_tokens: 42 }, model: 'deepseek-chat' } });

test('闲聊：一次调用就拿到回答，不再单独判断意图', async () => {
  calls.length = 0;
  script = () => reply({ content: '你好，我在。' });
  const out = await router.handleMessage('今天心情不错');
  assert.equal(out.intent, 'chat');
  assert.equal(out.reply.text, '你好，我在。');
  assert.deepEqual(calls.map((c) => c.kind), ['tools']);
  const tool = calls[0].body.tools.find((t) => t.function.name === 'create_task');
  assert.deepEqual(tool.function.parameters.properties.worker.enum, ['quiet'], 'Worker id 用枚举约束');
});

test('要做事：模型调用 create_task，按它给的 Worker 和标题建任务', async () => {
  calls.length = 0;
  script = () => reply({
    content: '',
    tool_calls: [{ type: 'function', function: { name: 'create_task', arguments: JSON.stringify({ title: '整理会议纪要', worker: 'quiet' }) } }]
  });
  const out = await router.handleMessage('把今天的会议内容整理一下');
  assert.equal(out.intent, 'task');
  assert.equal(out.task.worker, 'quiet');
  assert.equal(out.task.title, '整理会议纪要');
  assert.deepEqual(calls.map((c) => c.kind), ['tools']);
});

test('show_status 等工具映射到对应意图；模型给了不存在的 Worker 时按能力兜底', async () => {
  script = () => reply({ tool_calls: [{ function: { name: 'show_status', arguments: '{}' } }] });
  assert.equal((await router.handleMessage('现在都在忙什么')).intent, 'status');

  script = () => reply({ tool_calls: [{ function: { name: 'create_task', arguments: '{"title":"写点东西","worker":"ghost"}' } }] });
  const out = await router.handleMessage('帮我写点东西');
  assert.equal(out.task.worker, 'quiet');
});

test('模型不支持工具调用：退回两步判断，并且之后不再尝试', async () => {
  saveSettings({ model: 'old-model' });
  calls.length = 0;
  script = (kind) => (kind === 'tools'
    ? { status: 400, body: 'This model does not support tools' }
    : kind === 'classify'
      ? reply({ content: '{"intent":"chat"}' })
      : reply({ content: '两步也能回答。' }));
  const first = await router.handleMessage('随便聊聊');
  assert.equal(first.reply.text, '两步也能回答。');
  assert.deepEqual(calls.map((c) => c.kind), ['tools', 'classify', 'chat']);

  calls.length = 0;
  await router.handleMessage('再聊两句');
  assert.deepEqual(calls.map((c) => c.kind), ['classify', 'chat'], '记住了这个模型不支持工具');
});

test('工作区：聊天框里显式选的 > 文字里点名的 > 流程指定的 > 默认', async () => {
  const sandbox = path.join(dataDir, 'sandbox');
  const yu = path.join(dataDir, '渔童');
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(yu, { recursive: true });
  saveSettings({
    workspaces: [
      { id: 'default', name: '默认工作区', path: sandbox },
      { id: 'ws_yu', name: '渔童', path: yu }
    ],
    defaultWorkspaceId: 'default'
  });
  const flow = workflows.createWorkflow({ name: '字段改名', when: '字段改名', worker: 'quiet', workspace: '默认工作区', steps: '1. 改字段' });
  try {
    // 文字里点名渔童：压过流程写死的默认工作区。
    const byText = await router.handleMessage('字段改名，在渔童工作区里做');
    assert.equal(byText.task.cwd, yu);

    // 聊天框显式选工作区：最高优先级。
    const byPicker = await router.handleMessage('字段改名', { workspaceId: 'ws_yu' });
    assert.equal(byPicker.task.cwd, yu);

    // 都没指定：按流程的默认工作区。
    const byFlow = await router.handleMessage('字段改名');
    assert.equal(byFlow.task.cwd, sandbox);
  } finally {
    workflows.deleteWorkflow(flow.id);
  }
});

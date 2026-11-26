// 从对话派任务：Worker 看不到对话，「你让 deepseek 干」这种接着前文的话要带上前文要做的事。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-chat-context-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { saveSettings } = await import('../src/db.js');
const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const router = await import('../src/router.js');

test.after(() => removeTemp(dataDir));

await workers.loadBuiltinWorkers();
const manifest = validateManifest({ id: 'quiet', kind: 'worker', name: '安静', entry: 'index.js', worker: { abilities: ['text', 'code'], cost: 1 } });
workers.registerWorkerPlugin({ manifest, module: { execute: () => new Promise(() => {}) }, dir: path.join(dataDir, 'quiet'), isolate: false });
for (const id of ['llm', 'file', 'shell', 'claude', 'codex', 'dsh']) workers.deleteBuiltinWorker(id);
saveSettings({ provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat' });

let script = () => ({ status: 500, body: 'unset' });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const kind = body.tools ? 'tools' : body.response_format ? 'classify' : 'chat';
  const out = script(kind, body);
  return { ok: out.status === 200, status: out.status, text: async () => JSON.stringify(out.body), json: async () => out.body };
};
const reply = (message) => ({ status: 200, body: { choices: [{ message }], usage: { total_tokens: 1 }, model: 'deepseek-chat' } });
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

const REQUEST = '帮我将这个项目的 tapd 工作流抽取成通用的工作流规则，配置到静静里面。';

test('buildChatTaskPrompt：有 brief 用它当正文，附上原话；短句再附最近的对话', () => {
  const history = [
    { role: 'user', text: REQUEST, created_at: minutesAgo(3) },
    { role: 'assistant', text: '我只负责把规则抽成文本，没法直接写进设置里。', created_at: minutesAgo(2) }
  ];
  const prompt = router.buildChatTaskPrompt({ clean: '你让deepseek干', brief: '把项目的 tapd 工作流抽取成通用工作流规则并配置到静静', history });
  assert.ok(prompt.startsWith('把项目的 tapd 工作流抽取成通用工作流规则'));
  assert.match(prompt, /主人的原话：你让deepseek干/);
  assert.match(prompt, /只作参考/);
  assert.match(prompt, /主人：帮我将这个项目的 tapd 工作流/);
});

test('buildChatTaskPrompt：没有 brief 时原话当正文，前文一定要带上', () => {
  const prompt = router.buildChatTaskPrompt({ clean: '你让deepseek干', history: [{ role: 'user', text: REQUEST, created_at: minutesAgo(1) }] });
  assert.ok(prompt.startsWith('你让deepseek干'));
  assert.match(prompt, /tapd 工作流/);
});

test('buildChatTaskPrompt：自己说清楚的长请求、有 brief 时不附对话；太久以前的对话不带', () => {
  const long = '把 src/router.js 里派任务的逻辑改成带上对话上下文，并补充对应的单元测试，跑通全部测试';
  const withBrief = router.buildChatTaskPrompt({ clean: long, brief: long, history: [{ role: 'user', text: '无关的旧话题', created_at: minutesAgo(1) }] });
  assert.equal(withBrief, long, 'brief 和原话一样时不重复，长句不附对话');
  const stale = router.buildChatTaskPrompt({ clean: '做吧', history: [{ role: 'user', text: '三小时前的话', created_at: minutesAgo(180) }] });
  assert.equal(stale, '做吧');
});

test('buildChatTaskPrompt：前文太长时从最近的往前装，总长有上限', () => {
  const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `第${i}条 ${'很长'.repeat(400)}`, created_at: minutesAgo(6 - i) }));
  const prompt = router.buildChatTaskPrompt({ clean: '就这样', history });
  assert.ok(prompt.length < 3200);
  assert.match(prompt, /第5条/, '最近的一条一定在');
  assert.doesNotMatch(prompt, /第0条/, '最早的先被挤掉');
});

test('对话里先说要做什么、再说「你让 xx 干」：派出去的任务带着前文要做的事', async () => {
  const sessionId = 's_context';
  script = () => reply({ content: '规则我会按这 6 条整理。' });
  await router.handleMessage(REQUEST, { sessionId });

  // 模型没给 brief（老模型或没填）：靠附上的对话兜底。
  script = () => reply({ tool_calls: [{ type: 'function', function: { name: 'create_task', arguments: JSON.stringify({ title: '抽取 TAPD 通用工作流规则', worker: 'quiet' }) } }] });
  const out = await router.handleMessage('你让quiet干', { sessionId });
  assert.equal(out.task.title, '抽取 TAPD 通用工作流规则');
  assert.match(out.task.prompt, /tapd 工作流抽取成通用的工作流规则/, '前文要做的事进了指令');
  assert.match(out.task.prompt, /你让quiet干/);

  // 模型给了 brief：正文是完整指令。
  script = (kind, body) => {
    const tool = body.tools?.find((t) => t.function.name === 'create_task');
    assert.ok(tool.function.parameters.required.includes('brief'), 'create_task 要求填 brief');
    return reply({ tool_calls: [{ type: 'function', function: { name: 'create_task', arguments: JSON.stringify({ title: '抽取工作流', brief: '把项目的 tapd 工作流抽取成通用规则，写成静静「工作流程」里能直接新建的一条', worker: 'quiet' }) } }] });
  };
  const second = await router.handleMessage('你让quiet干', { sessionId });
  assert.ok(second.task.prompt.startsWith('把项目的 tapd 工作流抽取成通用规则'));
});

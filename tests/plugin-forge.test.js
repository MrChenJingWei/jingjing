// 插件工坊：静静写插件 → 自动检查 → 没通过交回去修 → 用户确认后安装。用假的编码 Worker 和假的模型接口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-forge-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { saveSettings } = await import('../src/db.js');
const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const plugins = await import('../src/plugins.js');
const scheduler = await import('../src/scheduler.js');
const forge = await import('../src/plugin-forge.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(fn, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error(`等待超时：${label}`);
}

const posts = [];
let reloads = 0;
forge.configure({
  post: (text, options) => posts.push({ text, options }),
  reload: async () => { reloads += 1; await plugins.reloadPlugins(); }
});
await plugins.reloadPlugins();

const goodManifest = {
  id: 'rss-test', kind: 'source', name: 'RSS 测试', version: '0.1.0', entry: 'index.js', type: 'poll',
  capabilities: { network: true },
  config: [{ key: 'url', label: '订阅地址', type: 'url', required: true }]
};
const goodCode = "export async function poll(config, ctx) { return { items: [] }; }\nexport async function test() { return { ok: true, detail: 'ok' }; }\n";

function writeDraft(dir, manifest, code) {
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), code);
}

function handmadeDraft(id, manifest, code, kind = 'source') {
  const dir = path.join(forge.DRAFT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  writeDraft(dir, manifest, code);
  return { id, kind };
}

test('找出代码里引用的 npm 包', () => {
  const code = `import fs from 'node:fs';\nimport path from 'path';\nimport x from './lib.js';\nimport Parser from 'rss-parser';\nconst y = require('axios');\nawait import('lodash');`;
  assert.deepEqual(forge.externalImports(code).sort(), ['axios', 'lodash', 'rss-parser']);
});

test('检查：合格的插件通过；npm 依赖、重名、缺导出、加载报错都会被拦下', async () => {
  const ok = await forge.checkDraft(handmadeDraft('d_ok', goodManifest, goodCode));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.info.exports, ['poll', 'test']);
  assert.match(ok.info.testSkipped, /订阅地址/, '有必填配置时不试跑 test()');

  const npm = await forge.checkDraft(handmadeDraft('d_npm', goodManifest, `import Parser from 'rss-parser';\n${goodCode}`));
  assert.match(npm.errors.join(), /npm 包：rss-parser/);

  const taken = await forge.checkDraft(handmadeDraft('d_taken', { ...goodManifest, id: 'webhook' }, goodCode));
  assert.match(taken.errors.join(), /id「webhook」已经被占用/);

  const missing = await forge.checkDraft(handmadeDraft('d_missing', goodManifest, 'export const x = 1;\n'));
  assert.match(missing.errors.join(), /必需的函数：poll/);

  const broken = await forge.checkDraft(handmadeDraft('d_broken', goodManifest, "throw new Error('顶层炸了');\nexport async function poll() {}\n"));
  assert.match(broken.errors.join(), /加载入口失败：顶层炸了/);

  const wrongKind = await forge.checkDraft(handmadeDraft('d_kind', goodManifest, goodCode, 'worker'));
  assert.match(wrongKind.errors.join(), /kind 应该是 "worker"/);

  const workerOk = await forge.checkDraft(handmadeDraft('d_worker', {
    id: 'echo-test', kind: 'worker', name: '回声', entry: 'index.js', worker: { abilities: ['text'] }
  }, "export function detect() { return { available: true, detail: '可用' }; }\nexport async function execute() { return { status: 'done', summary: 'ok' }; }\n", 'worker'));
  assert.equal(workerOk.ok, true, JSON.stringify(workerOk.errors));
  assert.deepEqual(workerOk.info.detect, { available: true, detail: '可用' });
});

test('官方已有类似插件时能认出来', () => {
  assert.equal(forge.findSimilarOfficial('我想接收企业微信的消息，实现任务来源插件', 'source')?.id, 'wecom');
  assert.equal(forge.findSimilarOfficial('做一个读取日历的插件', 'source')?.id, 'calendar');
  assert.equal(forge.findSimilarOfficial('写一个拉取 RSS 的插件', 'source'), null);
});

test('没有能写代码的 Worker、也没接模型时，说清楚需要什么', () => {
  assert.equal(forge.writerFor(), null);
  assert.throws(() => forge.createDraft({ request: '写个 RSS 插件' }), /能写代码的 Worker/);
});

test('编码 Worker 写插件：第一轮没通过自动交回去修，通过后等用户确认，安装进「我的」', async () => {
  const seen = [];
  const manifest = validateManifest({ id: 'fake-coder', kind: 'worker', name: '假编码', entry: 'index.js', worker: { abilities: ['code', 'text'], cost: 1 } });
  // 只注册在内存里：安装插件后会重新加载插件目录，这个假 Worker 会被注销，需要时重新注册。
  const registerFakeCoder = () => workers.registerWorkerPlugin({
    manifest,
    dir: path.join(dataDir, 'fake-coder'),
    isolate: false,
    module: {
      execute: async (task, ctx) => {
        seen.push({ prompt: task.prompt, options: ctx.options, cwd: ctx.workspace });
        const fixing = /没有通过静静的检查/.test(task.prompt);
        writeDraft(ctx.workspace, goodManifest, fixing ? goodCode : `import Parser from 'rss-parser';\n${goodCode}`);
        return { status: 'done', summary: fixing ? '修好了' : '写好了' };
      }
    }
  });
  registerFakeCoder();

  const draft = forge.createDraft({ request: '每 30 分钟拉一次 RSS', sessionId: 'main' });
  assert.equal(draft.mode, 'agent');
  assert.equal(draft.worker, 'fake-coder');
  assert.ok(draft.taskId);
  assert.ok(fs.existsSync(path.join(forge.DRAFT_DIR, draft.id, 'AUTHORING.md')), '草稿目录里有规范');

  const ready = await waitFor(() => forge.getDraft(draft.id).status === 'ready' && forge.getDraft(draft.id), '检查通过');
  assert.equal(ready.rounds, 2);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].options, { allowEdits: true }, '编码任务允许在草稿目录里改文件');
  assert.match(seen[0].prompt, /只能使用 Node\.js 自带模块/);
  assert.match(seen[1].prompt, /npm 包：rss-parser/, '修复轮带着上一轮的报错');
  assert.equal(ready.pluginId, 'rss-test');
  assert.ok(posts.some((p) => p.options.kind === 'plugin-draft' && p.options.meta.draftId === draft.id), '对话里发了确认卡片');
  assert.ok(!fs.existsSync(path.join(plugins.USER_PLUGIN_DIR, 'rss-test')), '用户确认前不会安装');

  const files = forge.draftFiles(draft.id).map((f) => f.name);
  assert.deepEqual(files.sort(), ['index.js', 'plugin.json']);

  const result = await forge.installDraft(draft.id);
  assert.equal(result.pluginId, 'rss-test');
  assert.equal(reloads, 1);
  const installed = path.join(plugins.USER_PLUGIN_DIR, 'rss-test');
  assert.ok(fs.existsSync(path.join(installed, 'index.js')));
  assert.ok(!fs.existsSync(path.join(installed, 'AUTHORING.md')), '规范文件不跟着装进去');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'plugin.json'), 'utf8')).$schema, undefined);
  const plugin = plugins.listPlugins().find((p) => p.pluginId === 'rss-test');
  assert.equal(plugin.source, 'user');
  assert.equal(plugin.enabled, false, '来源插件装上默认停用，等用户填配置');
  await assert.rejects(forge.installDraft(draft.id), /不能安装/);

  // 放弃：停掉还在写的任务，删草稿目录。
  registerFakeCoder();
  const other = forge.createDraft({ request: '再写一个看看', sessionId: 'main' });
  forge.discardDraft(other.id);
  assert.equal(forge.getDraft(other.id).status, 'discarded');
  assert.ok(!fs.existsSync(path.join(forge.DRAFT_DIR, other.id)));
  await waitFor(() => ['cancelled', 'done'].includes(scheduler.getTask(other.taskId).status), '任务结束');
  workers.unregisterWorkerPlugin('fake-coder');
});

test('没有编码 Worker 但接了模型时，让模型直接生成文件，同样检查后等确认', async () => {
  saveSettings({ provider: 'deepseek', apiKey: 'sk-test' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        files: {
          'plugin.json': JSON.stringify({ ...goodManifest, id: 'model-rss', name: '模型写的 RSS' }),
          'index.js': goodCode,
          '../escape.js': 'x'
        },
        summary: '拉取 RSS'
      }) } }],
      usage: { total_tokens: 100 }
    })
  });
  try {
    assert.equal(forge.writerFor().mode, 'model');
    const draft = forge.createDraft({ kind: 'source', request: '拉 RSS', sessionId: 'main' });
    const ready = await waitFor(() => forge.getDraft(draft.id).status === 'ready' && forge.getDraft(draft.id), '模型生成并通过检查');
    assert.equal(ready.pluginId, 'model-rss');
    assert.ok(!fs.existsSync(path.join(forge.DRAFT_DIR, 'escape.js')), '不接受带路径的文件名');
  } finally {
    globalThis.fetch = realFetch;
    saveSettings({ provider: 'demo', apiKey: '' });
  }
});

test('对话里要写插件：官方已有的先提示用官方的；明确要另写才动手', async () => {
  const router = await import('../src/router.js');
  const first = await router.handleMessage('我想要能够接收到企业微信的消息，实现任务来源插件，并安装它');
  assert.equal(first.intent, 'plugin');
  assert.equal(first.task, null);
  assert.match(first.reply.text, /官方已经有「企业微信智能机器人」/);

  const second = await router.handleMessage('还是帮我另写一个企业微信插件');
  assert.equal(second.intent, 'plugin');
  assert.match(second.reply.text, /能写代码的 Worker/, '这时没有编码 Worker 也没接模型，说明需要什么');
});

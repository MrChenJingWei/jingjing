// 运行模式：OpenAI 兼容接口（旧版本叫 DeepSeek）——Key 可选、模型可换、旧配置自动迁移。
// 用假的 fetch，不会真的请求任何模型服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-provider-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { saveSettings, getSettings } = await import('../src/db.js');
const { normalizeProvider } = await import('../src/config.js');
const llm = await import('../src/llm.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test('旧配置里的 deepseek 读出来是 openai，其他值回落到演示模式', () => {
  assert.equal(normalizeProvider('deepseek'), 'openai');
  assert.equal(normalizeProvider('openai'), 'openai');
  assert.equal(normalizeProvider('ollama'), 'ollama');
  assert.equal(normalizeProvider('随便写的'), 'demo');

  saveSettings({ provider: 'deepseek', apiKey: '' });
  assert.equal(getSettings().provider, 'openai');
});

test('没填 Key 也走真实接口：不带 Authorization，地址和模型都按设置走', async () => {
  saveSettings({ provider: 'openai', apiKey: '', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' });
  assert.equal(llm.llmMode(), 'openai');

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '在线' } }], usage: { total_tokens: 3 }, model: 'local-model' })
    };
  };

  const out = await llm.chat({ messages: [{ role: 'user', content: '在吗' }] });
  assert.equal(out.text, '在线');
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(JSON.parse(calls[0].init.body).model, 'local-model');
});

test('填了 Key 就带上 Bearer，报错用接口主机名而不是写死 DeepSeek', async () => {
  saveSettings({ provider: 'openai', apiKey: 'sk-other', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2' });
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer sk-other');
    return { ok: false, status: 401, text: async () => 'invalid api key' };
  };
  await assert.rejects(() => llm.chat({ messages: [{ role: 'user', content: 'hi' }] }), /api\.moonshot\.cn 401/);
});

test('只有演示模式是 demo，且不会去请求网络', () => {
  saveSettings({ provider: 'demo', apiKey: '' });
  assert.equal(llm.llmMode(), 'demo');
  globalThis.fetch = async () => { throw new Error('演示模式不该联网'); };
  return llm.chat({ messages: [{ role: 'user', content: '你好' }] }).then((out) => assert.equal(out.model, 'demo'));
});

test('获取模型列表：OpenAI 兼容服务读 data[].id，Ollama 读 models[].name', async () => {
  saveSettings({ provider: 'openai', apiKey: '', baseUrl: 'http://127.0.0.1:1234/v1' });
  globalThis.fetch = async (url) => {
    assert.equal(url, 'http://127.0.0.1:1234/v1/models');
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'b-model' }, { id: 'a-model' }] }) };
  };
  assert.deepEqual(await llm.listModels(), ['a-model', 'b-model']);

  saveSettings({ provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' });
  globalThis.fetch = async (url) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/tags');
    return { ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }] }) };
  };
  assert.deepEqual(await llm.listModels(), ['llama3.1:8b', 'qwen2.5:7b']);
});

test('获取模型列表失败时给一句能看懂的提示，手动填模型照样能用', async () => {
  saveSettings({ provider: 'openai', apiKey: '', baseUrl: 'http://127.0.0.1:1234/v1' });
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'not found' });
  await assert.rejects(() => llm.listModels(), /127\.0\.0\.1:1234 404/);

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(() => llm.listModels(), /手动填模型名/);

  saveSettings({ provider: 'demo' });
  await assert.rejects(() => llm.listModels(), /演示模式/);
});

test('模型列表连不上时，直接说明是哪个地址连不上', async () => {
  saveSettings({ provider: 'openai', apiKey: '', baseUrl: 'http://127.0.0.1:1234/v1' });
  globalThis.fetch = async () => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  };
  await assert.rejects(() => llm.listModels(), /连不上 http:\/\/127\.0\.0\.1:1234\/v1（ECONNREFUSED）/);
});

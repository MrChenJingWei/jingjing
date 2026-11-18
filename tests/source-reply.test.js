// 把任务结果发回来源的原会话：条目带 replyTo、插件导出 reply()；手动发、开关打开后自动发、发不出去的提示。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-reply-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const plugins = await import('../src/plugins.js');
const scheduler = await import('../src/scheduler.js');
const discovery = await import('../src/discovery.js');
const router = await import('../src/router.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function waitFor(fn, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error(`等待超时：${label}`);
}

function writeSource(id, { reply = true } = {}) {
  const dir = path.join(plugins.USER_PLUGIN_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: `${id} 来源`, version: '0.1.0', entry: 'index.js', type: 'poll' }));
  fs.writeFileSync(path.join(dir, 'index.js'), [
    'export async function poll() { return { items: [] }; }',
    reply
      ? 'export async function reply(config, payload) { if (globalThis.__replyFail) throw new Error(globalThis.__replyFail); (globalThis.__replies ||= []).push(payload); }'
      : ''
  ].join('\n'));
}

const message = (n, extra = {}) => ({
  externalId: `m-${n}`,
  title: `群消息 ${n}`,
  content: `请回复一下蓝马 4.5 的进度（${n}）`,
  replyTo: { chatId: 'group-1', userId: 'zhangsan' },
  ...extra
});

writeSource('chat-test');
writeSource('mute-test', { reply: false });
await plugins.reloadPlugins();
// 假的文本 Worker：直接给出一段回复。要在重新加载插件之后注册，否则会被注销。
workers.registerWorkerPlugin({
  manifest: validateManifest({ id: 'fake-text', kind: 'worker', name: '假文本', entry: 'index.js', worker: { abilities: ['text'], cost: 1 } }),
  module: { execute: async (task) => ({ status: 'done', summary: `回复：${task.title} 预计周五提测` }) },
  dir: path.join(dataDir, 'fake-text'),
  isolate: false
});
plugins.savePlugin('chat-test', { enabled: true });
plugins.savePlugin('mute-test', { enabled: true });

test('条目里的 replyTo 原样保留；不是对象或太大就丢掉', () => {
  assert.deepEqual(discovery.normalizeItem(message(0)).replyTo, { chatId: 'group-1', userId: 'zhangsan' });
  assert.equal(discovery.normalizeItem(message(0, { replyTo: 'group-1' })).replyTo, null);
  assert.equal(discovery.normalizeItem(message(0, { replyTo: { big: 'x'.repeat(3000) } })).replyTo, null);
});

test('能回消息的来源：任务记下回传地址；插件看得到 canReply，不支持的来源不能开自动发回', () => {
  const list = plugins.listPlugins();
  assert.equal(list.find((p) => p.id === 'chat-test').canReply, true);
  assert.equal(list.find((p) => p.id === 'chat-test').autoReply, false, '自动发回默认关闭');
  assert.equal(list.find((p) => p.id === 'mute-test').canReply, false);
  assert.throws(() => plugins.savePlugin('mute-test', { autoReply: true }), /不支持把结果发回/);
});

test('手动发回：任务完成后按用户改过的内容发到原会话，并记进时间线', async () => {
  globalThis.__replies = [];
  const { details } = await discovery.ingestItems('chat-test', [message(1)]);
  const taskId = details[0].taskId;
  assert.deepEqual(scheduler.getTask(taskId).reply_to, { chatId: 'group-1', userId: 'zhangsan' });
  assert.match(scheduler.getTask(taskId).prompt, /由静静负责（主人确认后发出）/, '告诉 Worker 发消息是静静的事');
  assert.doesNotMatch(scheduler.getTask(taskId).prompt, /原样发给对方/, '没开自动发回时只是草稿');
  await waitFor(() => scheduler.getTask(taskId).status === 'done', '任务完成');
  await tick();
  assert.equal(globalThis.__replies.length, 0, '没开自动发回就不发');

  const result = await discovery.replyToSource(taskId, { text: '  4.5 预计周五提测  ' });
  assert.equal(result.label, 'chat-test 来源');
  assert.deepEqual(globalThis.__replies[0].to, { chatId: 'group-1', userId: 'zhangsan' });
  assert.equal(globalThis.__replies[0].text, '4.5 预计周五提测');
  assert.equal(globalThis.__replies[0].task.id, taskId);
  const replied = scheduler.taskEvents(taskId).find((e) => e.type === 'task/replied');
  assert.equal(replied.data.by, 'user');

  // 不支持回消息的来源：任务上没有回传地址，手动发也会说明原因。
  const mute = await discovery.ingestItems('mute-test', [message(2)]);
  assert.equal(scheduler.getTask(mute.details[0].taskId).reply_to, null);
  await assert.rejects(discovery.replyToSource(mute.details[0].taskId, { text: 'x' }), /不是从能回消息的来源来的/);
});

test('打开自动发回：指令里注明结果会原样发回；完成后自动发出任务结果；发不出去在对话里说一声', async () => {
  globalThis.__replies = [];
  plugins.savePlugin('chat-test', { autoReply: true });
  assert.equal(plugins.listPlugins().find((p) => p.id === 'chat-test').autoReply, true);

  const { details } = await discovery.ingestItems('chat-test', [message(3)]);
  const taskId = details[0].taskId;
  assert.match(scheduler.getTask(taskId).prompt, /由静静负责（任务完成后自动发出）[\s\S]*原样发给对方/);
  await waitFor(() => globalThis.__replies.length === 1, '自动发回');
  const task = scheduler.getTask(taskId);
  assert.equal(globalThis.__replies[0].text, task.result.trim());
  assert.equal(scheduler.taskEvents(taskId).find((e) => e.type === 'task/replied').data.by, 'auto');

  globalThis.__replyFail = '企业微信长连接没连上';
  const failed = await discovery.ingestItems('chat-test', [message(4)]);
  const failedId = failed.details[0].taskId;
  await waitFor(() => scheduler.taskEvents(failedId).some((e) => e.type === 'task/reply_failed'), '记下发送失败');
  await waitFor(
    () => router.messages(router.MAIN_SESSION, 50).some((m) => m.task_id === failedId && /没发出去：企业微信长连接没连上/.test(m.text)),
    '对话里提示发送失败'
  );
  delete globalThis.__replyFail;

  // 停用来源后不能再发。
  plugins.savePlugin('chat-test', { enabled: false });
  await assert.rejects(discovery.replyToSource(taskId, { text: 'x' }), /已停用/);
});

test('私聊或 @ 静静、但不是要办的事：不建任务，静静按人格决定回不回；闲聊开关和任务自动发回分开', async () => {
  const { saveSettings } = await import('../src/db.js');
  assert.equal(discovery.normalizeItem(message(0, { direct: 'yes' })).direct, false, '只认 direct: true');

  // 假模型：人格回复的提示词里有「不是要你办的事」，其余当成判断。
  const realFetch = globalThis.fetch;
  const model = { decide: { actionable: false, reason: '闲聊请求，无需行动' }, reply: '今晚不讲，怕你睡不着。', asked: [] };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const system = body.messages?.[0]?.content || '';
    model.asked.push(system);
    const content = system.includes('不是要你办的事')
      ? JSON.stringify({ reply: model.reply })
      : JSON.stringify({ items: [{ index: 0, priority: 2, title: '讲鬼故事', prompt: '无需行动', ...model.decide }] });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 5 } }) };
  };
  saveSettings({ provider: 'deepseek', apiKey: 'sk-test', persona: '慵懒、嘴硬心软' });
  const memory = await import('../src/memory.js');
  memory.remember({ text: '静静怕黑，不爱讲鬼故事', layer: 'profile', domain: 'persona' });
  memory.remember({ text: '蓝马 4.5 预计周五提测，鬼故事专项暂停', layer: 'semantic' });
  globalThis.__replies = [];
  plugins.savePlugin('chat-test', { enabled: true, autoReply: true });
  const chat = (n, extra = {}) => message(n, { content: '@静静 给我讲个鬼故事', direct: true, ...extra });
  try {
    const { created, details } = await discovery.ingestItems('chat-test', [chat(10)]);
    assert.equal(created, 0, '闲聊不建任务');
    assert.equal(details[0].status, 'chat');
    assert.equal(details[0].replied, true);
    assert.equal(globalThis.__replies.length, 1);
    assert.equal(globalThis.__replies[0].text, '今晚不讲，怕你睡不着。');
    assert.deepEqual(globalThis.__replies[0].to, { chatId: 'group-1', userId: 'zhangsan' });
    assert.equal(globalThis.__replies[0].task, null, '闲聊回复没有任务');
    assert.match(model.asked[0], /direct=true/, '判断时告诉模型哪些是直接找静静的');
    const personaPrompt = model.asked.find((s) => s.includes('不是要你办的事'));
    assert.match(personaPrompt, /风格：慵懒、嘴硬心软/, '按设置里的人格回');
    assert.doesNotMatch(personaPrompt, /长期记忆|当前任务/, '不给外人看主人的记忆和任务');
    assert.match(personaPrompt, /静静怕黑/, '用她自己的人格记忆');
    assert.doesNotMatch(personaPrompt, /蓝马 4\.5/, '业务记忆不给外人');
    assert.ok(router.messages(router.MAIN_SESSION, 20).some((m) => /有人找我闲聊，我回了[\s\S]*今晚不讲/.test(m.text)), '替主人说了话，对话里留底');

    // 静静这次不想回：不发。
    model.reply = '';
    const quiet = await discovery.ingestItems('chat-test', [chat(11)]);
    assert.equal(quiet.details[0].status, 'chat');
    assert.equal(quiet.details[0].replied, false);
    assert.equal(globalThis.__replies.length, 1);

    // 没开闲聊自动回：不回，也不调模型去想回什么。
    plugins.savePlugin('chat-test', { autoReply: false });
    model.reply = '不该发出去';
    const before = model.asked.length;
    const off = await discovery.ingestItems('chat-test', [chat(12)]);
    assert.equal(off.details[0].replied, false);
    assert.match(off.details[0].reason, /没开「闲聊自动回」/);
    assert.equal(model.asked.length, before + 1, '只调了判断，没调人格回复');
    assert.equal(globalThis.__replies.length, 1);

    // 不是直接找静静的闲聊：照旧跳过，不回。
    plugins.savePlugin('chat-test', { autoReply: true });
    const plain = await discovery.ingestItems('chat-test', [message(13, { content: '大家周末愉快' })]);
    assert.equal(plain.details[0].status, 'skipped');
    assert.equal(globalThis.__replies.length, 1);

    // 直接找静静、而且是要办的事：照常建任务。
    model.decide = { actionable: true, reason: '问进度', title: '回复进度', prompt: '查进度后回复' };
    const work = await discovery.ingestItems('chat-test', [chat(14, { content: '@静静 请回复一下蓝马的进度' })]);
    assert.equal(work.created, 1);
    assert.equal(work.details[0].status, 'task');

    // 两个开关独立：只开闲聊，闲聊能回；关掉闲聊后，即使任务自动发回开着，闲聊也不回。
    plugins.savePlugin('chat-test', { autoChat: true, autoReply: false });
    model.decide = { actionable: false, reason: '闲聊' };
    model.reply = '在的，慢慢说。';
    const chatOnly = await discovery.ingestItems('chat-test', [chat(15)]);
    assert.equal(chatOnly.details[0].replied, true, '只开闲聊自动回，静静就能聊天');
    assert.equal(globalThis.__replies.length, 2);

    plugins.savePlugin('chat-test', { autoChat: false, autoReply: true });
    model.reply = '不该发出去';
    const noChat = await discovery.ingestItems('chat-test', [chat(16)]);
    assert.equal(noChat.details[0].replied, false, '关了闲聊自动回就不闲聊');
    assert.match(noChat.details[0].reason, /闲聊自动回/);
    assert.equal(globalThis.__replies.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    saveSettings({ provider: 'demo', apiKey: '' });
  }
});

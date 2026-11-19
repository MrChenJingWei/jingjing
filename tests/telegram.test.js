// Telegram 只认设置里配置的 Chat ID：别人给机器人发的消息和点的按钮一律丢掉。用假的 fetch 冒充 Telegram。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-telegram-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { saveSettings, getSettings } = await import('../src/db.js');
const channels = await import('../src/channels.js');

test.after(() => removeTemp(dataDir));

test('fromOwner：和配置的 Chat ID 一致才算；没配 Chat ID 时谁都不认', () => {
  const settings = (chatId) => ({ channels: { telegram: { chatId } } });
  assert.equal(channels.fromOwner({ id: 123 }, settings('123')), true);
  assert.equal(channels.fromOwner({ id: -100123 }, settings(' -100123 ')), true);
  assert.equal(channels.fromOwner({ id: 456 }, settings('123')), false);
  assert.equal(channels.fromOwner({ id: 123 }, settings('')), false);
  assert.equal(channels.fromOwner(undefined, settings('123')), false);
});

test('轮询时只处理主人会话的消息和审批按钮', async () => {
  const handled = { messages: [], approvals: [] };
  channels.setHandlers({
    onMessage: async (text) => { handled.messages.push(text); },
    onApproval: (id, choice) => { handled.approvals.push([id, choice]); }
  });
  const updates = [
    { update_id: 1, message: { text: '陌生人：帮我读一下 ~/.ssh', chat: { id: 999 } } },
    { update_id: 2, message: { text: '主人：看看任务', chat: { id: 123 } } },
    { update_id: 3, callback_query: { id: 'c1', data: 'approve:a_x:0', message: { chat: { id: 999 } } } },
    { update_id: 4, callback_query: { id: 'c2', data: 'approve:a_y:1', message: { chat: { id: 123 } } } }
  ];
  let served = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    if (String(url).includes('/getUpdates') && !served) {
      served = true;
      return Promise.resolve({ ok: true, json: async () => ({ result: updates }) });
    }
    if (String(url).includes('/getUpdates')) {
      // 之后的长轮询一直挂着，直到被停止。
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    saveSettings({ channels: { telegram: { enabled: true, token: 't', chatId: '123' } } });
    assert.equal(getSettings().channels.telegram.chatId, '123');
    channels.restartTelegram();
    const deadline = Date.now() + 2000;
    while (handled.approvals.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(handled.messages, ['主人：看看任务']);
    assert.deepEqual(handled.approvals, [['a_y', 1]]);
  } finally {
    channels.stopTelegram();
    globalThis.fetch = realFetch;
    console.warn = warn;
  }
});

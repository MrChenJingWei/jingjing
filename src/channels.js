import { getSettings } from './db.js';
import { bus } from './events.js';

let messageHandler = null; // (text, {source, chatId}) => Promise<void>
let approvalHandler = null; // (approvalId, choice) => void
let polling = false;
let pollAbort = null;
let offset = 0;

export function setHandlers({ onMessage, onApproval }) {
  messageHandler = onMessage;
  approvalHandler = onApproval;
}

async function sendTelegram(token, chatId, text, buttons = []) {
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (buttons.length) {
    body.reply_markup = {
      inline_keyboard: [
        buttons.map((label, i) => ({ text: label, callback_data: `approve:${label.approvalId}:${i}`.slice(0, 64) }))
      ]
    };
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
  return res.json();
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function deliver(kind, payload, text) {
  const cfg = getSettings();
  const results = [];
  const push = (channel, ok, error = null) => {
    const item = { channel, ok, error, at: new Date().toISOString() };
    results.push(item);
    bus.emit('channel/delivery', item);
  };

  const tg = cfg.channels?.telegram;
  if (tg?.enabled && tg.token && tg.chatId) {
    try {
      const buttons = payload.approval
        ? payload.approval.options.map((label, i) => ({ label, approvalId: payload.approval.id, index: i }))
        : [];
      await sendTelegram(tg.token, tg.chatId, text, buttons);
      push('telegram', true);
    } catch (err) {
      push('telegram', false, err.message);
    }
  }

  const fs2 = cfg.channels?.feishu;
  if (fs2?.enabled && fs2.webhook) {
    try {
      await postJson(fs2.webhook, { msg_type: 'text', content: { text } });
      push('feishu', true);
    } catch (err) {
      push('feishu', false, err.message);
    }
  }

  const wh = cfg.channels?.webhook;
  if (wh?.enabled && wh.url) {
    try {
      await postJson(wh.url, { type: kind, text, ...payload });
      push('webhook', true);
    } catch (err) {
      push('webhook', false, err.message);
    }
  }
  if (!results.length) push('in-app', true);
  return results;
}

export async function notifyApproval(approval, task) {
  const text = [
    `*静静需要你拍板*`,
    task.title,
    '',
    approval.question,
    '',
    ...approval.options.map((o, i) => `${i + 1}. ${o}`)
  ].join('\n');
  return deliver('approval', { approval, task, text }, text);
}

export async function notifyTask(task) {
  const text = [`*静静任务更新*`, task.title, '', task.result || task.error || task.status].join('\n');
  return deliver('task', { task, text }, text);
}

/* --------------------------- Telegram 双向通道 --------------------------- */

async function pollLoop(token) {
  if (polling) return;
  polling = true;
  pollAbort = new AbortController();
  console.log('[channel] Telegram 轮询已启动');
  while (polling) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }),
        signal: pollAbort.signal
      });
      if (!res.ok) throw new Error(`getUpdates ${res.status}`);
      const data = await res.json();
      for (const update of data.result || []) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          const [tag, approvalId, index] = String(update.callback_query.data || '').split(':');
          if (tag === 'approve' && approvalHandler) {
            try {
              approvalHandler(approvalId, Number(index));
              await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: update.callback_query.id, text: '收到，继续处理。' })
              });
            } catch (err) {
              console.warn('[channel] approve failed:', err.message);
            }
          }
        } else if (update.message?.text && messageHandler) {
          await messageHandler(update.message.text, {
            source: 'telegram',
            chatId: update.message.chat?.id
          });
        }
      }
    } catch (err) {
      if (pollAbort?.signal.aborted) break;
      console.warn('[channel] Telegram 轮询出错:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  polling = false;
}

export function restartTelegram() {
  const cfg = getSettings();
  const tg = cfg.channels?.telegram;
  if (tg?.enabled && tg.token) {
    if (polling) {
      polling = false;
      pollAbort?.abort();
      setTimeout(() => pollLoop(tg.token), 500);
    } else {
      pollLoop(tg.token);
    }
  } else if (polling) {
    polling = false;
    pollAbort?.abort();
    console.log('[channel] Telegram 已停止');
  }
}

export function channelStatus() {
  const cfg = getSettings();
  return {
    telegram: Boolean(cfg.channels?.telegram?.enabled && cfg.channels?.telegram?.token),
    feishu: Boolean(cfg.channels?.feishu?.enabled && cfg.channels?.feishu?.webhook),
    webhook: Boolean(cfg.channels?.webhook?.enabled && cfg.channels?.webhook?.url),
    polling
  };
}

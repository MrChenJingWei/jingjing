import { fetchUnread, testImap } from './imap.js';

/** 发件人：「张三 <zhangsan@example.com>」→ { id: 邮箱（小写）, name: 张三 }。 */
export function senderOf(from) {
  const text = String(from || '').trim();
  const address = (text.match(/<([^<>\s]+@[^<>\s]+)>/) || text.match(/([^\s<>"]+@[^\s<>"]+)/) || [])[1];
  if (!address) return null;
  const name = text.replace(/<[^>]*>/, '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  return { id: address.toLowerCase(), name: name && !name.includes('@') ? name : '' };
}

const PRESETS = {
  qq: { host: 'imap.qq.com', port: 993 },
  '163': { host: 'imap.163.com', port: 993 },
  gmail: { host: 'imap.gmail.com', port: 993 },
  icloud: { host: 'imap.mail.me.com', port: 993 },
  outlook: { host: 'outlook.office365.com', port: 993 }
};

function resolved(config) {
  const preset = PRESETS[config.preset] || {};
  return {
    ...config,
    host: String(config.host || '').trim() || preset.host || '',
    port: Number(config.port) || preset.port || 993,
    secure: config.secure !== false
  };
}

export async function test(config) {
  try {
    return await testImap(resolved(config));
  } catch (err) {
    return {
      ok: false,
      detail: `${err.message}。请确认邮箱已开启 IMAP，并且密码填的是授权码 / App Password，不是登录密码。`
    };
  }
}

export async function poll(config, ctx = {}) {
  const log = ctx.log || (() => {});
  const settings = resolved(config);
  if (!settings.host || !settings.user || !settings.pass) {
    throw new Error('邮箱配置不完整：邮箱类型/服务器、账号、授权码都要填');
  }
  const messages = await fetchUnread(settings, { log, state: ctx.state });
  log(`取到 ${messages.length} 封未读`);

  return {
    items: messages.map((message) => {
      const when = message.date ? new Date(message.date) : null;
      const externalId = message.messageId || `uid:${settings.user}:${message.uid}`;
      return {
        externalId,
        kind: 'email',
        eventType: 'email.unread',
        title: message.subject || '(无主题)',
        content: [
          `发件人：${message.from || '未知'}`,
          when && !Number.isNaN(when.getTime()) ? `时间：${when.toLocaleString('zh-CN', { hour12: false })}` : '',
          '',
          message.text.slice(0, 2000)
        ].filter(Boolean).join('\n'),
        ...(senderOf(message.from) ? { actor: senderOf(message.from) } : {}),
        meta: {
          from: message.from,
          date: message.date,
          mailbox: settings.mailbox || 'INBOX',
          uid: message.uid
        },
        occurredAt: when && !Number.isNaN(when.getTime()) ? when.toISOString() : new Date().toISOString()
      };
    })
  };
}

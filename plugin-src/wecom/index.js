import AiBot, { generateReqId } from '@wecom/aibot-node-sdk';
import { createRelay } from './relay.js';
import { directoryConfigured, checkDirectory, lookupMembers } from './directory.js';
import { cliStatus, lookupByCli } from './cli.js';

// 每个插件实例（一条长连接）一个 relay：deliver() 由静静调用，按实例找到对应的连接。
const relays = new Map();

export async function test(config, ctx = {}) {
  if (!config.botId || !config.secret) return { ok: false, detail: 'BotID 和 Secret 都要填' };
  // 认人：wecom-cli 没装不算失败（只是认不出名字），自建应用凭证填了就必须能用。
  const cli = await cliStatus(config, { signal: ctx.signal });
  const notes = [cli.ok ? 'wecom-cli 已授权，新认识的人会去通讯录查姓名和部门。' : `认人：${cli.detail}。`];
  if (String(config.corpId || '').trim() || String(config.contactSecret || '').trim()) {
    if (!directoryConfigured(config)) return { ok: false, detail: '自建应用查通讯录要 CorpID 和 Secret 都填' };
    try {
      await checkDirectory(config, ctx.signal);
      notes.push('自建应用凭证可用，wecom-cli 搜不到的人用它补查。');
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
  return {
    ok: true,
    detail: `机器人凭证已填写。保存并启用后会建立 WebSocket 长连接；企业微信不会在“测试连接”时被连接。${notes.join('')}`
  };
}

/**
 * 静静认人：新认识的人马上查一次，之后每天刷新。ids 是企微 userid。
 * 先用 wecom-cli（机器人的通讯录授权）；没装、没授权或搜不到的，配了自建应用就用它补查。两条路都没有时返回空。
 */
export async function lookupPeople(config, ids, ctx) {
  const found = new Map();
  let cliError = null;
  try {
    for (const p of await lookupByCli(config, ids, { signal: ctx.signal })) found.set(p.id, p);
  } catch (err) {
    cliError = err;
    if (err.code !== 'NO_CLI') ctx.log?.(`wecom-cli 查通讯录失败：${err.message}`);
  }
  const rest = ids.filter((id) => !found.has(String(id)));
  if (rest.length && directoryConfigured(config)) {
    for (const p of await lookupMembers(config, rest, { signal: ctx.signal, log: ctx.log })) found.set(p.id, p);
  } else if (cliError && cliError.code !== 'NO_CLI') {
    // CLI 装了却调不通（没授权、网络），又没有备用：抛出去，静静下一小时再试。
    throw cliError;
  }
  return { people: [...found.values()] };
}

export async function poll() {
  return { items: [] };
}

/**
 * 静静要往企微里说一句（收到后的判断、等拍板、做完、结果、闲聊回复……）。
 * 返回 { mode }：updated 原地更新了收到的那条消息，sent 另发了一条，skipped 没发（只想原地刷新的进度）。
 */
export async function deliver(config, payload, ctx) {
  const relay = relays.get(ctx.instanceId);
  if (!relay) throw new Error('企业微信长连接还没连上');
  return relay.deliver(payload);
}

function messageTitle(body) {
  const user = body.from?.userid || '未知成员';
  if (body.chattype === 'group') return `企微群消息 · ${user}`;
  return `企微私聊 · ${user}`;
}

export async function start(config, ctx) {
  if (!config.botId || !config.secret) {
    throw new Error('缺少 BotID 或 Secret');
  }

  const client = new AiBot.WSClient({ botId: config.botId, secret: config.secret });
  let closed = false;
  let ready = false;
  // 旧版宿主没有 status / fail，缺了就只记日志。
  const status = (detail) => ctx.status?.(detail);
  const giveUp = (reason, options) => {
    if (closed) return;
    closed = true;
    try { client.disconnect(); } catch { /* ignore */ }
    ctx.fail?.(reason, options);
  };

  client.on('authenticated', () => {
    ctx.log('企业微信长连接认证成功');
    if (ready) status('已连接');
  });
  client.on('disconnected', (reason) => {
    ctx.log(`企业微信长连接断开：${reason}`);
    if (!ready || closed) return;
    // 被服务端踢下线（同一个机器人在别处建了新连接）SDK 不会重连；自动重连只会和另一边来回互踢，交给主人处理。
    if (client.started === false) {
      giveUp(`企业微信断开了这条连接：${reason}。可能同一个机器人在别处登录了，确认后在插件页重新保存即可重连。`, { retry: false });
    } else {
      status(`连接断开，等待重连：${reason}`);
    }
  });
  client.on('reconnecting', (attempt) => {
    ctx.log(`企业微信长连接重连中（第 ${attempt} 次）`);
    if (ready) status(`重连中（第 ${attempt} 次）`);
  });
  client.on('error', (err) => {
    ctx.log(`企业微信连接错误：${err.message}`);
    // SDK 重连次数或认证失败次数用完后就不再重连：交给宿主按退避时间整个重启。
    if (ready && /WSReconnectExhausted|WSAuthFailure/.test(err?.name || '')) {
      giveUp(`企业微信长连接放弃重连：${err.message}`);
    }
  });

  const relay = createRelay({
    client,
    newStreamId: () => generateReqId('stream'),
    log: (message) => ctx.log(message)
  });
  relays.set(ctx.instanceId, relay);

  client.on('message.text', async (frame) => {
    const body = frame.body || {};
    const content = String(body.text?.content || '').trim();
    if (!content) return;

    const quoted = String(body.quote?.text?.content || '').trim();
    const text = quoted ? `引用：${quoted}\n\n${content}` : content;
    const occurredAt = body.create_time ? new Date(body.create_time * 1000).toISOString() : null;
    // 说什么、播报到什么程度由静静的设置决定；这里只负责马上占一个「正在看…」的气泡。
    const policy = ctx.policy?.() || { ack: true };
    if (policy.ack) await relay.open(frame, body.msgid);

    try {
      // 收到之后的判断结果、之后的进度和结果，都由静静通过 deliver() 写回这条消息。
      await ctx.ingest([
        {
          externalId: body.msgid,
          kind: 'note',
          eventType: body.chattype === 'group' ? 'wecom.group_message' : 'wecom.private_message',
          groupKey: `wecom:${body.chatid || body.from?.userid || 'unknown'}`,
          title: messageTitle(body),
          content: text,
          occurredAt,
          // 机器人只收得到私聊和群里 @ 它的消息：都是直接找过来的。
          direct: true,
          // 谁说的：企微 userid，名字由静静去通讯录查（lookupPeople）。
          ...(body.from?.userid ? { actor: { id: body.from.userid } } : {}),
          replyTo: {
            chatid: body.chatid || body.from?.userid || '',
            chattype: body.chattype || 'single',
            msgid: body.msgid,
            userid: body.from?.userid || ''
          },
          meta: {
            chatid: body.chatid || '',
            chattype: body.chattype || 'single',
            userid: body.from?.userid || ''
          }
        }
      ]);
    } catch (err) {
      ctx.log(`处理企业微信消息失败：${err.message}`);
      await relay.deliver({ to: { msgid: body.msgid }, event: 'received', text: '处理这条消息时出错了，稍后再试。', final: true, transient: true }).catch(() => {});
    }
  });

  // 卡片按钮：转给静静核对是不是主人，再把卡片改成结果。
  client.on('event.template_card_event', async (frame) => {
    try {
      const result = await relay.onCardEvent(frame, (request) => ctx.interact?.(request) || { ok: false, message: '这个版本的静静不支持在企微里拍板。' });
      if (result) ctx.log(`卡片操作：${result.ok ? '已执行' : '没执行'}（${result.message}）`);
    } catch (err) {
      ctx.log(`处理卡片按钮失败：${err.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client.disconnect(); } catch { /* ignore */ }
      reject(new Error('连接企业微信超时（15 秒），请检查 BotID/Secret 和网络'));
    }, 15000);
    const ok = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.disconnect(); } catch { /* ignore */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    client.once('authenticated', ok);
    client.once('error', fail);
    client.connect();
  });
  ready = true;

  return async () => {
    if (relays.get(ctx.instanceId) === relay) relays.delete(ctx.instanceId);
    relay.dispose();
    if (closed) return;
    closed = true;
    try { client.disconnect(); } catch { /* ignore */ }
  };
}

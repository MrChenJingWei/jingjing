import AiBot, { generateReqId } from '@wecom/aibot-node-sdk';

export async function test(config) {
  if (!config.botId || !config.secret) return { ok: false, detail: 'BotID 和 Secret 都要填' };
  return {
    ok: true,
    detail: '凭证已填写。保存并启用后会建立 WebSocket 长连接；企业微信不会在“测试连接”时被连接。'
  };
}

export async function poll() {
  return { items: [] };
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

  client.on('authenticated', () => ctx.log('企业微信长连接认证成功'));
  client.on('disconnected', (reason) => ctx.log(`企业微信长连接断开：${reason}`));
  client.on('reconnecting', (attempt) => ctx.log(`企业微信长连接重连中（第 ${attempt} 次）`));
  client.on('error', (err) => ctx.log(`企业微信连接错误：${err.message}`));

  client.on('message.text', async (frame) => {
    const body = frame.body || {};
    const content = String(body.text?.content || '').trim();
    if (!content) return;

    const quoted = String(body.quote?.text?.content || '').trim();
    const text = quoted ? `引用：${quoted}\n\n${content}` : content;
    const occurredAt = body.create_time ? new Date(body.create_time * 1000).toISOString() : null;
    const streamId = generateReqId('stream');
    const ack = config.replyAck !== false;

    if (ack) {
      await client.replyStream(frame, streamId, '收到，正在看…', false).catch(() => {});
    }

    try {
      const result = await ctx.ingest([
        {
          externalId: body.msgid,
          kind: 'note',
          eventType: body.chattype === 'group' ? 'wecom.group_message' : 'wecom.private_message',
          groupKey: `wecom:${body.chatid || body.from?.userid || 'unknown'}`,
          title: messageTitle(body),
          content: text,
          occurredAt,
          meta: {
            chatid: body.chatid || '',
            chattype: body.chattype || 'single',
            userid: body.from?.userid || ''
          }
        }
      ]);
      if (ack) {
        const details = Array.isArray(result.details) ? result.details : [];
        let reply;
        if (result.created) {
          const lines = details.filter((item) => item.status === 'task').map((item) => `- ${item.title}：${item.reason || '需要处理'}`);
          reply = `收到。已经建了 ${result.created} 个任务：\n${lines.join('\n')}\n\n可以在静静任务板里查看。`;
        } else if (details.some((item) => item.status === 'merged')) {
          reply = `收到，已合并到已有任务：${details.find((item) => item.status === 'merged')?.title || ''}`;
        } else if (details.length) {
          reply = `看过了，这条先不动：${details[0].reason || '暂时不需要处理'}`;
        } else {
          reply = '这条之前已经处理过了。';
        }
        await client.replyStream(frame, streamId, reply.slice(0, 4000), true);
      }
    } catch (err) {
      ctx.log(`处理企业微信消息失败：${err.message}`);
      if (ack) {
        await client.replyStream(frame, streamId, '处理这条消息时出错了，稍后再试。', true).catch(() => {});
      }
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

  return async () => {
    if (closed) return;
    closed = true;
    try { client.disconnect(); } catch { /* ignore */ }
  };
}

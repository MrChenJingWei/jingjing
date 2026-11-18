// 企微这一侧「怎么显示」：静静决定说什么（deliver 的 payload），这里决定在企微里用哪种方式说。
// - 收到的那条消息还挂着流式气泡、也没超时：原地更新同一个气泡（不会新冒一条）；
// - 气泡已经结束或超时：用 sendMessage 主动发一条新消息；只想原地刷新的进度（transient）这时就不发；
// - 等拍板：推一张按钮卡片，有人点按钮时把点击人转给静静核对，5 秒内把卡片改成结果。
// 不依赖企微 SDK：client 只要有 replyStream / sendMessage / updateTemplateCard 三个方法，方便测试。

// 流式气泡最多挂多久。企微没写明上限，保守按 5 分钟算，到点前自动用最后的内容结束它。
export const STREAM_MAX_MS = 5 * 60 * 1000;
const STREAM_MARGIN_MS = 15 * 1000;
const STREAM_TEXT_MAX = 4000;
// markdown 消息按字节截断（企微按字节算长度，中文一个字 3 字节）。
const MARKDOWN_MAX_BYTES = 4000;
const CARD_KEY = 'jj';
const MAX_BUTTONS = 6;

function byteCut(text, maxBytes, tail = '\n\n…（完整内容在静静里）') {
  const value = String(text || '');
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const budget = maxBytes - Buffer.byteLength(tail);
  let out = '';
  for (const ch of value) {
    if (Buffer.byteLength(out + ch) > budget) break;
    out += ch;
  }
  return out + tail;
}

const cut = (text, max) => {
  const chars = [...String(text || '')];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

export function approvalCard(payload) {
  const { task, approval } = payload;
  const options = approval.options || [];
  const buttons = options.slice(0, MAX_BUTTONS - 1).map((option, index) => ({
    text: cut(`${index + 1}. ${option}`, 10),
    style: index === 0 ? 1 : 2,
    key: [CARD_KEY, 'a', task.id, approval.id, index].join(':')
  }));
  if (approval.kind !== 'recovery') {
    buttons.push({ text: approval.kind === 'routing' ? '不处理' : '停下', style: 3, key: [CARD_KEY, 'a', task.id, approval.id, -1].join(':') });
  }
  return {
    card_type: 'button_interaction',
    source: { desc: '静静 · 需要拍板' },
    main_title: { title: cut(task.title, 26), desc: cut(approval.question, 60) },
    sub_title_text: cut(options.map((option, index) => `${index + 1}. ${option}`).join('\n'), 112),
    button_list: buttons,
    // 同一个机器人内不能重复；只能有字母数字和 _-@。
    task_id: `jj-${approval.id}`.replace(/[^A-Za-z0-9_\-@]/g, '').slice(0, 128)
  };
}

export function parseCardKey(key) {
  const [tag, action, taskId, approvalId, choice] = String(key || '').split(':');
  if (tag !== CARD_KEY || action !== 'a' || !taskId) return null;
  return { action: 'approve', taskId, approvalId, choice: Number(choice) };
}

/**
 * 一条长连接对应一个 relay。
 * client：企微 SDK 的 WSClient（或测试替身）；newStreamId()：生成流式消息 id；now()：当前毫秒。
 */
export function createRelay({ client, newStreamId, log = () => {}, now = () => Date.now() }) {
  const streams = new Map();   // 收到的消息 msgid -> { frame, streamId, startedAt, open, text, timer }
  const cards = new Map();     // 卡片 task_id -> 卡片内容（按钮回调后原地改卡片要用）

  function closeStream(entry) {
    entry.open = false;
    if (entry.timer) clearTimeout(entry.timer);
    if (streams.get(entry.msgid) === entry) streams.delete(entry.msgid);
  }

  /** 收到消息：先占一个「正在看…」的气泡。到点前自动结束，免得一直转圈。 */
  async function open(frame, msgid, text = '收到，正在看…') {
    const entry = { msgid, frame, streamId: newStreamId(), startedAt: now(), open: true, text };
    streams.set(msgid, entry);
    entry.timer = setTimeout(() => {
      if (!entry.open) return;
      closeStream(entry);
      client.replyStream(entry.frame, entry.streamId, entry.text, true).catch(() => {});
    }, STREAM_MAX_MS - STREAM_MARGIN_MS);
    entry.timer.unref?.();
    await client.replyStream(frame, entry.streamId, text, false).catch((err) => log(`回执没发出去：${err.message}`));
    return entry;
  }

  function liveStream(msgid) {
    const entry = msgid ? streams.get(msgid) : null;
    if (!entry || !entry.open) return null;
    if (now() - entry.startedAt >= STREAM_MAX_MS - STREAM_MARGIN_MS) {
      closeStream(entry);
      return null;
    }
    return entry;
  }

  async function updateStream(entry, text, final) {
    entry.text = String(text || '').slice(0, STREAM_TEXT_MAX);
    if (final) closeStream(entry);
    await client.replyStream(entry.frame, entry.streamId, entry.text, Boolean(final));
  }

  async function send(chatid, body) {
    if (!chatid) throw new Error('不知道发到哪个会话（缺少 chatid）');
    await client.sendMessage(chatid, body);
  }

  /** 静静要说的一句话：返回 { mode: updated | sent | skipped }。 */
  async function deliver(payload = {}) {
    const to = payload.to || {};
    const stream = liveStream(to.msgid);
    if (payload.event === 'waiting_approval' && payload.approval && payload.task) {
      if (stream) await updateStream(stream, `「${payload.task.title}」需要拍板，看下面的卡片。`, true);
      const card = approvalCard(payload);
      cards.set(card.task_id, card);
      await send(to.chatid, { msgtype: 'template_card', template_card: card });
      return { mode: 'sent' };
    }
    if (stream) {
      await updateStream(stream, payload.text, payload.final);
      return { mode: 'updated' };
    }
    if (payload.transient) return { mode: 'skipped' };
    await send(to.chatid, { msgtype: 'markdown', markdown: { content: byteCut(payload.text, MARKDOWN_MAX_BYTES) } });
    return { mode: 'sent' };
  }

  /** 有人点了卡片上的按钮：转给静静（interact），5 秒内把卡片改成结果；不是主人只改他自己看到的那份。 */
  async function onCardEvent(frame, interact) {
    const body = frame?.body || {};
    const eventData = body.event || {};
    const parsed = parseCardKey(eventData.event_key);
    if (!parsed) return null;
    const actor = body.from?.userid || '';
    const result = await interact({ ...parsed, actor });
    const original = cards.get(eventData.task_id) || { card_type: 'button_interaction', main_title: { title: '静静' } };
    const updated = {
      ...original,
      task_id: eventData.task_id || original.task_id,
      sub_title_text: cut(result.message || (result.ok ? '好了' : '没办成'), 112),
      button_list: [{ text: result.ok ? '已处理' : '没有生效', style: result.ok ? 1 : 2, key: [CARD_KEY, 'done'].join(':') }]
    };
    await client.updateTemplateCard(frame, updated, result.ok || !actor ? undefined : [actor])
      .catch((err) => log(`更新卡片失败：${err.message}`));
    if (result.ok) cards.delete(eventData.task_id);
    return result;
  }

  function dispose() {
    for (const entry of streams.values()) closeStream(entry);
    streams.clear();
    cards.clear();
  }

  return { open, deliver, onCardEvent, dispose, streams, cards };
}

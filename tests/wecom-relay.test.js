// 企微插件「怎么显示」：同一个流式气泡原地更新、结束或超时后改发新消息、进度不另发、
// 拍板推按钮卡片、按钮回调转给静静并在 5 秒窗口里改卡片（不是主人只改他自己那份）。用假的 client，不连企微。
import test from 'node:test';
import assert from 'node:assert/strict';

const { createRelay, approvalCard, parseCardKey, STREAM_MAX_MS } = await import('../plugin-src/wecom/relay.js');

function fakeClient() {
  const calls = [];
  return {
    calls,
    replyStream: async (frame, streamId, content, finish) => { calls.push({ type: 'stream', msgid: frame.body.msgid, streamId, content, finish }); },
    sendMessage: async (chatid, body) => { calls.push({ type: 'send', chatid, body }); },
    updateTemplateCard: async (frame, card, userids) => { calls.push({ type: 'update', card, userids }); }
  };
}

function setup() {
  const client = fakeClient();
  let clock = 1_000_000;
  let seq = 0;
  const relay = createRelay({ client, newStreamId: () => `s${(seq += 1)}`, now: () => clock });
  return { client, relay, advance: (ms) => { clock += ms; } };
}

const frame = (msgid) => ({ headers: { req_id: `r-${msgid}` }, body: { msgid } });
const to = (msgid) => ({ chatid: 'group-1', msgid });

test('回执、判断结果、做完都写在同一个气泡里；结束后再说话就另发一条', async () => {
  const { client, relay } = setup();
  await relay.open(frame('m1'), 'm1');
  assert.deepEqual(await relay.deliver({ to: to('m1'), event: 'received', text: '收到，建了任务「周报」', final: false }), { mode: 'updated' });
  assert.deepEqual(await relay.deliver({ to: to('m1'), event: 'progress', text: '正在做：读取文件', final: false, transient: true }), { mode: 'updated' });
  assert.deepEqual(await relay.deliver({ to: to('m1'), event: 'done', text: '做完了', final: true }), { mode: 'updated' });
  const streams = client.calls.filter((c) => c.type === 'stream');
  assert.deepEqual(streams.map((c) => [c.streamId, c.content, c.finish]), [
    ['s1', '收到，正在看…', false],
    ['s1', '收到，建了任务「周报」', false],
    ['s1', '正在做：读取文件', false],
    ['s1', '做完了', true]
  ]);
  // 气泡结束了：进度不另发，结果另发一条 markdown。
  assert.deepEqual(await relay.deliver({ to: to('m1'), event: 'progress', text: 'x', transient: true }), { mode: 'skipped' });
  assert.deepEqual(await relay.deliver({ to: to('m1'), event: 'result', text: '结果正文', final: true }), { mode: 'sent' });
  assert.deepEqual(client.calls.at(-1), { type: 'send', chatid: 'group-1', body: { msgtype: 'markdown', markdown: { content: '结果正文' } } });
  assert.equal(relay.streams.size, 0, '结束的气泡不再记着');
});

test('气泡挂太久就不再往上写，改发新消息；超长内容按字节截断', async () => {
  const { client, relay, advance } = setup();
  await relay.open(frame('m2'), 'm2');
  advance(STREAM_MAX_MS);
  const long = '长'.repeat(3000);
  assert.deepEqual(await relay.deliver({ to: to('m2'), event: 'done', text: long, final: true }), { mode: 'sent' });
  const content = client.calls.at(-1).body.markdown.content;
  assert.ok(Buffer.byteLength(content) <= 4000);
  assert.match(content, /完整内容在静静里/);
});

test('没开回执（没有气泡）时：说的话都另发；闲聊回复也是', async () => {
  const { client, relay } = setup();
  assert.deepEqual(await relay.deliver({ to: to('m3'), event: 'chat', text: '哈哈好的', final: true }), { mode: 'sent' });
  assert.equal(client.calls[0].body.markdown.content, '哈哈好的');
  await assert.rejects(relay.deliver({ to: { msgid: 'm4' }, event: 'done', text: 'x', final: true }), /chatid/);
});

test('等拍板：先结束气泡，再推一张按钮卡片；按钮 key 能解析回任务和选项', async () => {
  const { client, relay } = setup();
  await relay.open(frame('m5'), 'm5');
  const payload = {
    to: to('m5'),
    event: 'waiting_approval',
    task: { id: 't_abc', title: '修复登录白屏问题并补上测试用例' },
    approval: { id: 'a_xyz', kind: 'routing', question: '要交给谁？', options: ['交给「Claude Code」', '以后这类都交给「Claude Code」', '只用「问答」回文字'] }
  };
  assert.deepEqual(await relay.deliver(payload), { mode: 'sent' });
  const [, closing, sent] = client.calls;
  assert.equal(closing.finish, true);
  assert.match(closing.content, /看下面的卡片/);
  const card = sent.body.template_card;
  assert.equal(sent.body.msgtype, 'template_card');
  assert.equal(card.card_type, 'button_interaction');
  assert.equal(card.task_id, 'jj-a_xyz');
  assert.equal(card.button_list.length, 4, '三个选项 + 不处理');
  assert.ok(card.button_list.every((b) => [...b.text].length <= 10), '按钮文字不超过 10 个字');
  assert.match(card.sub_title_text, /1\. 交给「Claude Code」/);
  assert.deepEqual(parseCardKey(card.button_list[1].key), { action: 'approve', taskId: 't_abc', approvalId: 'a_xyz', choice: 1 });
  assert.equal(parseCardKey(card.button_list.at(-1).key).choice, -1);
  assert.equal(parseCardKey('别的:key'), null);
  // 服务重启后的「重跑 / 放弃」不加额外的停下按钮。
  assert.equal(approvalCard({ ...payload, approval: { ...payload.approval, kind: 'recovery', options: ['重新执行', '放弃'] } }).button_list.length, 2);
});

test('点按钮：转给静静核对；主人点了卡片对所有人改成结果，别人点只改他自己看到的', async () => {
  const { client, relay } = setup();
  await relay.deliver({
    to: to('m6'),
    event: 'waiting_approval',
    task: { id: 't_1', title: '任务' },
    approval: { id: 'a_1', kind: 'worker', question: '继续吗？', options: ['继续'] }
  });
  const key = client.calls[0].body.template_card.button_list[0].key;
  const asked = [];
  const click = (userid, answer) => relay.onCardEvent(
    { headers: { req_id: 'e1' }, body: { from: { userid }, event: { eventtype: 'template_card_event', event_key: key, task_id: 'jj-a_1' } } },
    async (request) => { asked.push(request); return answer; }
  );

  await click('lisi', { ok: false, message: '只有主人能在这里拍板。' });
  let update = client.calls.at(-1);
  assert.deepEqual(update.userids, ['lisi']);
  assert.equal(update.card.sub_title_text, '只有主人能在这里拍板。');
  assert.equal(update.card.task_id, 'jj-a_1');

  await click('zhangsan', { ok: true, message: '张三 选了：继续' });
  update = client.calls.at(-1);
  assert.equal(update.userids, undefined);
  assert.equal(update.card.button_list[0].text, '已处理');
  assert.equal(update.card.main_title.desc, '继续吗？', '保留原来的问题');
  assert.deepEqual(asked.map((r) => [r.actor, r.taskId, r.approvalId, r.choice, r.action]), [
    ['lisi', 't_1', 'a_1', 0, 'approve'],
    ['zhangsan', 't_1', 'a_1', 0, 'approve']
  ]);
  // 不认识的按钮不转给静静。
  assert.equal(await relay.onCardEvent({ body: { event: { event_key: 'x:y' } } }, async () => { throw new Error('不该调'); }), null);
});

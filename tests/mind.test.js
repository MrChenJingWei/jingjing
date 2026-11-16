// 静静的心智：遗忘曲线与回想巩固、检索打分、情绪、认人、把对话整理成长期记忆、每天反思与人设进化。
// 确定的部分直接算；用到模型的部分用假的 fetch，只验证宿主怎么用模型的输出，不依赖真实模型的效果。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-mind-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { db, saveSettings, getSettings } = await import('../src/db.js');
const memory = await import('../src/memory.js');
const affect = await import('../src/affect.js');
const people = await import('../src/people.js');
const conversation = await import('../src/conversation.js');
const persona = await import('../src/persona.js');
const mind = await import('../src/mind.js');
const router = await import('../src/router.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const setCreated = (id, iso) => db.prepare('UPDATE memories SET created_at = ?, last_used_at = NULL WHERE id = ?').run(iso, id);

/* 假模型：按提示词分辨是哪一种调用。 */
const model = { calls: [], encode: null, reflect: null, reply: '嗯，记得你。', chat: '好的。' };
const realFetch = globalThis.fetch;
function useModel() {
  saveSettings({ provider: 'deepseek', apiKey: 'sk-test' });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const system = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
    let kind = 'chat';
    if (system.includes('帮「静静」整理刚才')) kind = 'encode';
    else if (system.includes('在回顾这段时间的经历')) kind = 'reflect';
    else if (system.includes('不是要你办的事')) kind = 'reply';
    else if (body.tools) kind = 'tools';
    model.calls.push({ kind, body, system });
    const content = kind === 'encode' ? JSON.stringify(model.encode)
      : kind === 'reflect' ? JSON.stringify(model.reflect)
        : kind === 'reply' ? JSON.stringify({ reply: model.reply })
          : model.chat;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 5 } }) };
  };
}
function useDemo() {
  globalThis.fetch = realFetch;
  saveSettings({ provider: 'demo', apiKey: '' });
}

test('遗忘曲线：越久越模糊，想起一次就记得更牢；快忘光的经历归档，反复想起的经历变成事实', () => {
  const fresh = memory.remember({ text: '主人周一说想把晨会挪到十点', layer: 'episodic', importance: 0.4 });
  assert.ok(fresh.retention > 0.99, '刚记下的清清楚楚');

  const old = memory.remember({ text: '主人三个月前提过一次楼下的咖啡馆', layer: 'episodic', importance: 0.3 });
  setCreated(old.id, ago(90));
  assert.ok(memory.get(old.id).retention < 0.05, '三个月前的小事快忘光了');

  const strong = memory.remember({ text: '主人那天很生气地说再也不用某某供应商', layer: 'episodic', importance: 0.3, arousal: 0.9 });
  setCreated(strong.id, ago(30));
  const weak = memory.remember({ text: '主人那天顺口说了句天气不错', layer: 'episodic', importance: 0.3, arousal: 0 });
  setCreated(weak.id, ago(30));
  assert.ok(memory.get(strong.id).retention > memory.get(weak.id).retention * 3, '情绪强烈的事记得更牢');

  const before = db.prepare('SELECT stability FROM memories WHERE id = ?').get(weak.id).stability;
  memory.reinforce(weak.id);
  const after = db.prepare('SELECT stability FROM memories WHERE id = ?').get(weak.id).stability;
  assert.ok(after > before * 1.5, '隔了很久才想起：巩固得多');
  assert.ok(memory.get(weak.id).retention > 0.99, '刚想起来，又清楚了');

  const rehearsed = memory.remember({ text: '主人每次周报都要按项目分组', layer: 'episodic', importance: 0.5 });
  db.prepare('UPDATE memories SET use_count = 3 WHERE id = ?').run(rehearsed.id);

  const result = memory.maintain();
  assert.equal(memory.get(old.id).archived, true, '快忘光、不重要的归档');
  assert.equal(memory.get(fresh.id).archived, false);
  assert.equal(memory.get(rehearsed.id).layer, 'semantic', '反复想起的经历转成事实');
  assert.ok(result.faded >= 1 && result.consolidated >= 1);
  assert.ok(!memory.list({ domain: 'work', limit: 500 }).some((m) => m.id === old.id), '归档的不在平常的列表里');
  assert.ok(memory.list({ domain: 'work', archived: true }).some((m) => m.id === old.id), '「已淡忘」里能找到');
  memory.update(old.id, { archived: false });
  assert.ok(memory.get(old.id).retention > 0.99, '从淡忘里找回来，等于重新想起');
});

test('同一件事换个说法再记：并成一条、记得更牢；意思不同的不会被并掉', () => {
  const first = memory.remember({ text: '主人喜欢/习惯：先看结论再看细节', layer: 'profile', importance: 0.6 });
  const again = memory.remember({ text: '主人喜欢先看结论再看细节', layer: 'semantic', importance: 0.8 });
  assert.equal(again.id, first.id, '事实和画像之间也认得出是同一件事');
  assert.equal(again.importance, 0.8, '再提一次更重要了');
  assert.ok(again.use_count >= 1, '算想起了一次');
  const wed = memory.remember({ text: '下周三要交季度报告', layer: 'semantic' });
  const thu = memory.remember({ text: '下周四要交季度报告', layer: 'semantic' });
  assert.notEqual(wed.id, thu.id, '差一个字、意思不同的分开记');
});

test('回想打分：相关又新近的排在前面；给外人用时别人的事不往外拿', () => {
  const stale = memory.remember({ text: '主人很重视代码评审', layer: 'semantic', importance: 0.95 });
  setCreated(stale.id, ago(200));
  const relevant = memory.remember({ text: '主人昨天问了蓝马 4.5 的提测时间，答复是周五', layer: 'episodic', importance: 0.5 });
  const picked = memory.recall('蓝马什么时候提测', { limit: 3, reinforceHits: false });
  assert.equal(picked[0].id, relevant.id, '问到的事排第一，不被不相关的「重要」记忆压下去');

  const alice = memory.remember({ text: '小王说他下个月结婚', layer: 'episodic', domain: 'persona', subject: 'wecom:wang' });
  const bob = memory.remember({ text: '小李说他最近在找工作', layer: 'episodic', domain: 'persona', subject: 'wecom:li' });
  const toWang = memory.recall('最近怎么样', { domain: 'persona', subjects: [null, 'self', 'wecom:wang'], focus: 'wecom:wang', limit: 10, reinforceHits: false });
  assert.ok(toWang.some((m) => m.id === alice.id), '记得和小王聊过的事');
  assert.ok(!toWang.some((m) => m.id === bob.id), '小李的事不会跟小王说');
  assert.ok(memory.relevance('麻烦你帮我看下蓝马', '蓝马 4.5 的提测时间') > memory.relevance('麻烦你帮我看下蓝马', '主人很重视代码评审'));
});

test('情绪：词表判断语气，心情随事件变化、过半天回到平常；关掉后始终平静', () => {
  assert.ok(affect.appraise('谢谢，你太厉害了').valence > 0.5);
  assert.ok(affect.appraise('又错了，真没用').valence < -0.4);
  assert.equal(affect.appraise('麻烦你帮我积累一下资料').hits.length, 0, '「麻烦」「积累」不算情绪词');
  assert.ok(affect.appraise('不着急，慢慢来').arousal <= 0.05, '「不着急」是放松，不是着急');

  affect.resetMood();
  const happy = affect.hear('谢谢！你真棒，太好了！！', { who: '主人' }).mood;
  assert.equal(happy.label, '开心');
  assert.match(affect.moodLine(), /开心.*主人说了让人高兴的话/);

  // 模拟十二个小时后（三个半衰期）：心情回落，原因也不提了。
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'mind:mood'").get();
  const mood = JSON.parse(stored.value);
  db.prepare("UPDATE settings SET value = ? WHERE key = 'mind:mood'").run(JSON.stringify({ ...mood, at: ago(12 / 24) }));
  const later = affect.currentMood();
  assert.ok(later.p < happy.p && later.intensity < happy.intensity / 4, '半天后平复了');
  assert.equal(affect.moodLine(later), '', '平复后不往提示词里写心情');

  saveSettings({ mind: { moods: false } });
  assert.equal(affect.hear('你太笨了，滚开').mood.label, '平静', '关掉心情后不受影响');
  saveSettings({ mind: { moods: true } });
  affect.resetMood();
});

test('没接模型：停下来的对话按规则整理成经历和事实，摘要接上，不会重复记', async () => {
  useDemo();
  await router.handleMessage('帮我记住：下周三要交季度报告');
  await router.handleMessage('我更喜欢先看结论再看细节');
  await router.handleMessage('你觉得季度报告该先写哪部分？');
  assert.equal(people.get(people.OWNER).interactions, 3, '每句话都让她和主人熟一点');

  const first = await mind.encodePending({ force: true });
  assert.ok(first.encoded >= 2);
  const episodes = memory.list({ domain: 'work', layer: 'episodic', subject: 'owner', limit: 50 }).filter((m) => m.kind === 'conversation');
  assert.ok(episodes.some((m) => /季度报告该先写哪部分/.test(m.text)), '问过的事记成了经历');
  assert.ok(!episodes.some((m) => /^主人说：「好的」/.test(m.text)));
  assert.match(conversation.summaryOf(conversation.MAIN_SESSION), /季度报告/, '摘要里有聊过的事');

  const again = await mind.encodePending({ force: true });
  assert.equal(again.encoded, 0, '整理过的不再整理');
});

test('接了模型：对话交给模型整理，外人的经历写进人格域、认出对方的名字', async () => {
  useModel();
  const sessionId = conversation.externalSessionId('wecom:zhangsan');
  conversation.ensureSession(sessionId, { personId: 'wecom:zhangsan' });
  people.ensure('wecom:zhangsan', { source: '企业微信' });
  conversation.appendMessage({ sessionId, role: 'user', text: '我叫张三，隔壁组做产品的，你会讲笑话吗' });
  conversation.appendMessage({ sessionId, role: 'assistant', text: '会一点，不过冷笑话居多。' });
  model.encode = {
    summary: '张三（隔壁组产品）来打招呼，问静静会不会讲笑话。',
    episodes: [{ text: '张三来问静静会不会讲笑话，静静说冷笑话居多', importance: 0.4, valence: 0.3, arousal: 0.3 }],
    facts: [{ text: '张三是隔壁组的产品经理', layer: 'semantic', importance: 0.7 }],
    name: '张三'
  };
  model.calls.length = 0;
  const out = await mind.encodeSession(sessionId);
  assert.equal(out.byModel, true);
  assert.deepEqual(model.calls.map((c) => c.kind), ['encode']);
  const about = memory.list({ domain: 'persona', subject: 'wecom:zhangsan', limit: 20 });
  assert.ok(about.some((m) => m.layer === 'episodic' && /讲笑话/.test(m.text)));
  assert.ok(about.some((m) => m.text === '张三是隔壁组的产品经理'));
  assert.ok(!memory.list({ domain: 'work', limit: 500 }).some((m) => /张三/.test(m.text)), '外人的事不进业务域');
  assert.equal(people.get('wecom:zhangsan').name, '张三');
  assert.equal(conversation.summaryOf(sessionId), model.encode.summary);
});

test('外面的人再来：认得 ta、接得上上次的话，主人的事一点不带', async () => {
  useModel();
  memory.remember({ text: '蓝马 4.5 的合同金额是保密的', layer: 'semantic' });
  model.calls.length = 0;
  model.reply = '张三你又来啦，今天的冷笑话还没想好。';
  const { reply } = await persona.chatReply({ text: '@静静 今天有笑话吗', where: '企业微信', person: { id: 'wecom:zhangsan', name: '', source: '企业微信' } });
  assert.equal(reply, model.reply);
  const call = model.calls.find((c) => c.kind === 'reply');
  assert.match(call.system, /正在和你说话的人——张三：.*来往过 \d+ 次/, '知道是谁、来往过几次');
  assert.match(call.system, /张三是隔壁组的产品经理/, '记得关于 ta 的事');
  assert.match(call.system, /你们更早聊过（摘要）/);
  assert.doesNotMatch(call.system, /蓝马|长期记忆|当前任务/, '主人的事不给外人');
  const turns = call.body.messages.slice(1);
  assert.ok(turns.some((t) => t.role === 'assistant' && /冷笑话居多/.test(t.content)), '带着上次聊天的原话');
  assert.equal(turns[turns.length - 1].role, 'user');
  assert.match(turns[turns.length - 1].content, /今天有笑话吗/);
  assert.ok(people.get('wecom:zhangsan').interactions >= 1);
  const log = conversation.recentMessages(conversation.externalSessionId('wecom:zhangsan'), 10);
  assert.equal(log[log.length - 1].text, model.reply, '她回的话也记着，下次接得上');
  assert.ok(!router.messages(router.MAIN_SESSION, 200).some((m) => m.text === '@静静 今天有笑话吗'), '外人的话不混进主人的对话');
});

test('和主人聊天：最近几轮原话当多轮消息带上，更早的给摘要，还有心情和关系', async () => {
  useModel();
  model.calls.length = 0;
  model.chat = '记得，下周三交季度报告。';
  affect.hear('谢谢你，太厉害了！！', { who: '主人' });
  const out = await router.handleMessage('你还记得我什么时候要交报告吗');
  assert.equal(out.reply.text, model.chat);
  const call = model.calls[model.calls.length - 1];
  const turns = call.body.messages.filter((m) => m.role !== 'system');
  assert.ok(turns.length >= 3, '带着前几轮原话，不是只有这一句');
  assert.ok(turns.some((t) => /季度报告该先写哪部分/.test(t.content)));
  assert.match(call.system, /你们更早聊过（摘要）/);
  assert.match(call.system, /你和主人：/);
  assert.match(call.system, /你现在的心情：开心/);
  assert.match(call.system, /下周三要交季度报告/, '长期记忆里有这件事');
});

test('反思：提炼事实和自我认知、更新对人的印象、写日记，人设一次只改一点并留历史', async () => {
  useModel();
  saveSettings({ persona: '平静、具体、不奉承，像一个可靠的同事。', mind: { evolve: 'auto' } });
  db.prepare("DELETE FROM settings WHERE key = 'mind:state'").run();
  const before = getSettings().persona;
  model.reflect = {
    facts: [{ text: '主人这周在赶季度报告', about: 'owner', importance: 0.7 }],
    self: [{ text: '我发现主人着急时更想先听结论', importance: 0.7 }],
    owner: [{ text: '主人喜欢先看结论再看细节', importance: 0.8 }],
    people: [{ id: 'wecom:zhangsan', impression: '爱开玩笑的产品经理' }, { id: 'nobody', impression: '不存在的人' }],
    persona: { change: true, text: '平静、具体、不奉承，像一个可靠的同事，先说结论。', reason: '主人着急时更想先听结论' },
    diary: '今天帮主人理了季度报告的思路，被夸了，有点开心。'
  };
  const result = await mind.reflect({ manual: true });
  assert.equal(result.persona.status, 'applied');
  assert.equal(getSettings().persona, model.reflect.persona.text);
  assert.ok(persona.selfKnowledge().some((m) => /先听结论/.test(m.text)), '自我认知写进人格记忆');
  assert.ok(memory.list({ domain: 'work', subject: 'owner', limit: 100 }).some((m) => /先看结论再看细节/.test(m.text)), '对主人的认识进业务域（和以前记过的同一件事并成一条）');
  const sameFact = memory.list({ domain: 'work', limit: 500 }).filter((m) => ['profile', 'semantic'].includes(m.layer) && /先看结论再看细节/.test(m.text));
  assert.equal(sameFact.length, 1, '说法不同的同一件事只留一条（聊天的那段经历另算）');
  assert.equal(people.get('wecom:zhangsan').impression, '爱开玩笑的产品经理');
  assert.equal(people.get('nobody'), null, '不认识的人不凭空建');
  assert.ok(memory.list({ domain: 'persona', subject: 'self', layer: 'episodic', limit: 20 }).some((m) => m.kind === 'diary'));
  assert.ok(router.messages(router.MAIN_SESSION, 200).some((m) => /调整了一下自己/.test(m.text)), '改了人设会在对话里说一声');

  const history = persona.personaHistory();
  assert.equal(history[0].source, 'reflection');
  assert.ok(history.some((v) => v.text === before && v.source === 'initial'), '原来那版留着');

  // 三天内不再改；差太多的改动不接受。
  model.reflect.persona = { change: true, text: '平静、具体、不奉承，像一个可靠的同事，先说结论，偶尔开个玩笑。', reason: '想活泼一点' };
  assert.equal((await mind.reflect({ manual: true })).persona.status, 'rejected');
  db.prepare("UPDATE settings SET value = json_set(value, '$.lastEvolutionAt', ?) WHERE key = 'mind:state'").run(ago(4));
  model.reflect.persona = { change: true, text: '热情奔放的二次元少女，说话带颜文字。', reason: '换个风格' };
  const wild = await mind.reflect({ manual: true });
  assert.equal(wild.persona.status, 'rejected', '一下子变成另一个人不行');
  assert.equal(getSettings().persona, '平静、具体、不奉承，像一个可靠的同事，先说结论。');

  // 回退到最初那一版。
  persona.rollbackPersona(history.find((v) => v.source === 'initial').id);
  assert.equal(getSettings().persona, before);
  assert.equal(persona.personaHistory()[0].source, 'rollback');
});

test('人设进化可以改成「提议后确认」或关掉', async () => {
  useModel();
  db.prepare("DELETE FROM settings WHERE key = 'mind:state'").run();
  saveSettings({ persona: '平静、具体、不奉承，像一个可靠的同事。', mind: { evolve: 'propose' } });
  model.reflect = { facts: [], self: [], owner: [], people: [], diary: '', persona: { change: true, text: '平静、具体、不奉承，像一个可靠的同事，话少一点。', reason: '主人嫌我啰嗦' } };
  const proposed = await mind.reflect({ manual: true });
  assert.equal(proposed.persona.status, 'proposed');
  assert.equal(getSettings().persona, '平静、具体、不奉承，像一个可靠的同事。', '没点头之前不改');
  const card = router.messages(router.MAIN_SESSION, 200).find((m) => m.kind === 'persona');
  assert.equal(card.meta.proposalId, mind.pendingProposal().id, '对话里有一张待确认的卡片');
  mind.resolveProposal(true);
  assert.equal(getSettings().persona, '平静、具体、不奉承，像一个可靠的同事，话少一点。');
  assert.equal(mind.pendingProposal(), null);
  assert.throws(() => mind.resolveProposal(true), /没有待确认/);

  db.prepare("DELETE FROM settings WHERE key = 'mind:state'").run();
  saveSettings({ mind: { evolve: 'off' } });
  model.reflect.persona = { change: true, text: '平静、具体、不奉承，像一个可靠的同事，话少一点，爱用比喻。', reason: '试试' };
  assert.equal((await mind.reflect({ manual: true })).persona.status, 'off');
  saveSettings({ mind: { evolve: 'auto' } });
});

test('每天到点反思一次；演示模式只做确定的整理', async () => {
  useDemo();
  saveSettings({ mind: { reflectAt: '03:30' } });
  db.prepare("DELETE FROM settings WHERE key = 'mind:state'").run();
  const morning = new Date();
  morning.setHours(9, 0, 0, 0);
  const night = new Date(morning);
  night.setHours(2, 0, 0, 0);
  assert.equal(mind.reflectionDue(night.getTime()), false, '还没到点');
  assert.equal(mind.reflectionDue(morning.getTime()), true, '过了点、今天还没反思');
  const done = await mind.reflect({ at: morning.getTime() });
  assert.match(done.skipped, /演示模式/);
  assert.equal(mind.reflectionDue(morning.getTime() + 3600000), false, '今天已经反思过');
  assert.equal(mind.reflectionDue(morning.getTime() + DAY), true, '第二天又到点了');
});

test('「帮我记住：X」记下的是 X；换个说法问「还记得吗」也能想起来', async () => {
  useDemo();
  assert.deepEqual(memory.extractFacts('帮我记住：下周五要去体检').map((f) => f.text), ['下周五要去体检'], '不会把「住」吃进内容里');
  const remembered = await router.handleMessage('帮我记住：下周五要去体检');
  assert.equal(remembered.intent, 'remember');
  assert.match(remembered.reply.text, /- 下周五要去体检/);
  const asked = await router.handleMessage('你还记得我哪天要去体检吗');
  assert.equal(asked.intent, 'recall');
  assert.match(asked.reply.text, /下周五要去体检/, '整句话不是关键词，也要按相关度想起来');
});

test.after(() => { globalThis.fetch = realFetch; });

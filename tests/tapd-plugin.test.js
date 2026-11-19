// TAPD 来源插件：用一个假的 tapd-cli（node 脚本，读 JSON 夹具）验证状态分类、首次只记基线、
// 每次最多交 10 条且轮换、syncStatus 按 id 批量查 / 找不到标 missing、找不到命令和没令牌时的提示、
// 评论和 @ 提醒（增量游标、只交和我有关的、评论优先交、超出的排队）。不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tapd = await import('../plugins/tapd/index.js');
const { categorize, parseOverrides, stripPrefix } = await import('../plugins/tapd/status.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-tapd-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const fixture = path.join(dir, 'fixture.json');
const calls = path.join(dir, 'calls.log');
const bin = path.join(dir, 'tapd-cli');
fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, token: process.env.TAPD_TOKEN }) + '\\n');
const db = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
const kv = Object.fromEntries(args.slice(2).filter((a) => a.includes('=')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const out = (data) => console.log(JSON.stringify({ status: 1, data, info: 'success' }));
const [entity, verb] = args;
if (entity === 'user') out({ nick: '小明' });
else if (entity === 'bug' && verb === 'related-stories') out((db.relations || {})[kv['bug-id']] ? db.relations[kv['bug-id']].map((id) => ({ workspace_id: kv.workspaceid, bug_id: kv['bug-id'], story_id: id })) : []);
else if (entity === 'comment' && verb === 'list') {
  let rows = db.comments || [];
  if (kv.created && kv.created.startsWith('>')) rows = rows.filter((c) => c.created > kv.created.slice(1));
  out(rows.map((c) => ({ Comment: c })));
}
else if (verb === 'fields') out((db.fields || {})[entity] || { status: { options: db.labels[entity] } });
else if (verb === 'count') out({ count: db[entity].filter((r) => !kv.status || kv.status.split('|').includes(r.status)).length });
else if (verb === 'list') {
  let rows = db[entity];
  if (kv.id) rows = rows.filter((r) => kv.id.split(',').includes(r.id));
  // 筛选条件：值用 | 表示「或」（和 TAPD 一样）；处理人类字段按包含匹配（TAPD 存的是「张三;李四;」）。
  for (const [key, value] of Object.entries(kv)) {
    if (['workspaceid', 'id', 'limit', 'order', 'fields'].includes(key)) continue;
    const wanted = value.split('|');
    rows = rows.filter((r) => r[key] === undefined || wanted.some((w) => String(r[key]).split(';').includes(w)));
  }
  const wrap = entity === 'bug' ? 'Bug' : 'Story';
  out(rows.map((r) => ({ [wrap]: r })));
} else { console.log(JSON.stringify({ status: 0, info: 'unknown' })); }
`, { mode: 0o755 });

const bugs = (n, status = 'new') => Array.from({ length: n }, (_, i) => ({ id: `11${1000 + i}`, title: `缺陷 ${i}`, status, modified: '2026-11-17 10:00:00', description: '<p>步骤：<br/>点登录</p>' }));
function setRemote(bug, story = [], relations = {}, comments = []) {
  fs.writeFileSync(fixture, JSON.stringify({
    bug,
    story,
    relations,
    comments,
    labels: {
      bug: { new: '未解决', status_4: '已解决未上线', postponed: 'E3-已关闭', status_5: '已上线' },
      story: { developing: 'C2-实现中', status_9: 'F3-已发布线上' }
    }
  }));
}
const memory = () => {
  const store = new Map();
  return { state: { get: (k, f = null) => (store.has(k) ? store.get(k) : f), set: (k, v) => store.set(k, v) }, log: () => {} };
};
const base = { bin, token: 'tok', workspaceIds: '123', entities: 'bug' };

test('状态分类：去掉排序前缀按中文名推断；已关闭看解决方法；可以手动覆盖', () => {
  assert.equal(stripPrefix('F3-已发布线上'), '已发布线上');
  assert.equal(categorize({ key: 'status_9', label: 'F3-已发布线上' }), 'done');
  assert.equal(categorize({ key: 'status_7', label: 'C3-测试打回' }), 'in_progress');
  assert.equal(categorize({ key: 'status_3', label: 'D2-测试中' }), 'review');
  assert.equal(categorize({ key: 'status_8', label: '搁置' }), 'blocked');
  assert.equal(categorize({ key: 'acknowledged', label: '已有需求' }), 'cancelled');
  assert.equal(categorize({ key: 'postponed', label: 'E3-已关闭', resolution: 'fix later' }), 'cancelled');
  assert.equal(categorize({ key: 'closed', label: '已关闭', resolution: 'fixed' }), 'done');
  assert.equal(categorize({ key: 'status_99' }), 'unknown');
  assert.equal(categorize({ key: 'resolved' }), 'review', '没有中文名时按系统 key 兜底');
  const overrides = parseOverrides('已解决未上线 = done\nstatus_3：blocked\n乱写 = nope');
  assert.equal(overrides.size, 2);
  assert.equal(categorize({ key: 'status_4', label: '已解决未上线' }, overrides), 'done');
});

test('test()：报告命令路径、处理人和数量；令牌从配置传给命令', async () => {
  setRemote(bugs(3));
  const result = await tapd.test(base, memory());
  assert.equal(result.ok, true);
  assert.match(result.detail, /项目 123，处理人「小明」：缺陷 3 条/);
  assert.ok(fs.readFileSync(calls, 'utf8').trim().split('\n').every((line) => JSON.parse(line).token === 'tok'));
});

test('首次启用只记基线不建卡；之后只交新分来的、没结束的单子，带上状态和链接', async () => {
  setRemote(bugs(2));
  const ctx = memory();
  const config = { ...base, startFresh: true };
  assert.deepEqual((await tapd.poll(config, ctx)).items, []);
  const remote = [...bugs(2), { id: '119999', title: '新来的', status: 'status_4', modified: '2026-11-17 12:30:00', description: '<p>a&amp;b</p>' }, { id: '118888', title: '已上线的', status: 'status_5', modified: '2026-11-17 12:00:00' }];
  setRemote(remote);
  const { items } = await tapd.poll(config, ctx);
  assert.deepEqual(items.map((i) => i.externalId), ['119999']);
  const item = items[0];
  assert.equal(item.externalType, '缺陷');
  assert.equal(item.url, 'https://www.tapd.cn/123/bugtrace/bugs/view?bug_id=119999');
  assert.deepEqual({ label: item.status.label, category: item.status.category }, { label: '已解决未上线', category: 'review' });
  assert.equal(item.status.updatedAt, '2026-11-17T04:30:00.000Z', '北京时间转 ISO');
  assert.deepEqual(item.meta, { workspaceId: '123', entity: 'bug' });
  assert.match(item.content, /a&b/);
});

test('一次最多交 10 条，没交过的排前面，几轮下来都能交到', async () => {
  setRemote(bugs(25));
  const ctx = memory();
  const config = { ...base, startFresh: false };
  const seen = new Set();
  for (let round = 0; round < 3; round += 1) {
    const { items } = await tapd.poll(config, ctx);
    assert.equal(items.length, 10);
    for (const item of items) seen.add(item.externalId);
  }
  assert.equal(seen.size, 25);
});

test('syncStatus：按项目和类型分组批量查，找不到的标 missing', async () => {
  setRemote([{ id: '11', title: 'a', status: 'postponed', resolution: 'fix later', modified: '2026-11-17 09:00:00' }], [{ id: '22', name: '需求 b', status: 'status_9', modified: '2026-11-17 09:00:00' }]);
  fs.writeFileSync(calls, '');
  const out = await tapd.syncStatus({ ...base, entities: 'both' }, [
    { externalId: '11', meta: { workspaceId: '123', entity: 'bug' } },
    { externalId: '22', meta: { workspaceId: '123', entity: 'story' } },
    { externalId: '33', meta: { workspaceId: '123', entity: 'bug' } }
  ], memory());
  const byId = Object.fromEntries(out.map((r) => [r.externalId, r]));
  assert.equal(byId['11'].status.category, 'cancelled');
  assert.match(byId['11'].status.detail, /fix later/);
  assert.equal(byId['22'].status.category, 'done');
  assert.equal(byId['22'].title, '需求 b');
  assert.equal(byId['33'].missing, true);
  const lists = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l).args).filter((a) => a[1] === 'list');
  assert.deepEqual(lists.map((a) => [a[0], a.find((x) => x.startsWith('id='))]), [['bug', 'id=11,33'], ['story', 'id=22']]);
});

test('找不到命令、没有令牌、项目 ID 不对时给出能照着改的提示', async () => {
  const saved = process.env.TAPD_TOKEN;
  delete process.env.TAPD_TOKEN;
  try {
    assert.match((await tapd.test({ ...base, bin: path.join(dir, 'nope') }, memory())).detail, /找不到 tapd-cli/);
    assert.match((await tapd.test({ ...base, token: '' }, memory())).detail, /个人令牌/);
    assert.match((await tapd.test({ ...base, workspaceIds: 'abc' }, memory())).detail, /只能是数字/);
  } finally {
    if (saved !== undefined) process.env.TAPD_TOKEN = saved;
  }
});

test('归类：自动归类关着时不查关联、不交 node；开着时缺陷给唯一关联需求当父，多个关联给 null + links，需求给父需求', async () => {
  const stories = [
    { id: '500', name: '登录改造', status: 'developing', parent_id: '0', modified: '2026-11-17 10:00:00' },
    { id: '501', name: '支付回调', status: 'developing', parent_id: '0', modified: '2026-11-17 10:00:00' },
    { id: '502', name: '登录改造 · 验证码', status: 'developing', parent_id: '500', modified: '2026-11-17 10:00:00' }
  ];
  const list = [
    { id: '9001', title: '登录闪退', status: 'new', modified: '2026-11-17 10:00:00' },
    { id: '9002', title: '回调超时又登录失败', status: 'new', modified: '2026-11-17 10:00:00' },
    { id: '9003', title: '孤儿缺陷', status: 'new', modified: '2026-11-17 10:00:00' }
  ];
  setRemote(list, stories, { 9001: ['500'], 9002: ['500', '501'] });
  const config = { ...base, entities: 'both', startFresh: false };

  fs.writeFileSync(calls, '');
  const off = await tapd.poll(config, { ...memory(), classify: 'off' });
  assert.ok(off.items.every((item) => !item.node && item.parent === undefined));
  assert.ok(!fs.readFileSync(calls, 'utf8').includes('related-stories'), '关着时不多调接口');

  const ctx = { ...memory(), classify: 'observing' };
  const { items } = await tapd.poll(config, ctx);
  const byId = Object.fromEntries(items.map((item) => [item.externalId, item]));
  assert.deepEqual(byId['9001'].node, { workspace: '123', type: 'bug', id: '9001', title: '登录闪退', url: 'https://www.tapd.cn/123/bugtrace/bugs/view?bug_id=9001' });
  assert.equal(byId['9001'].parent.id, '500');
  assert.equal(byId['9001'].parent.title, '登录改造', '父需求带标题');
  assert.equal(byId['9002'].parent, null, '多个关联不挑一个凑数');
  assert.deepEqual(byId['9002'].links.map((link) => link.to.id), ['500', '501']);
  assert.equal(byId['9003'].parent, null, '没有关联需求');
  assert.equal(byId['500'].parent, null, '没有父需求的需求是树根');
  assert.equal(byId['502'].parent.id, '500', '子需求的父是父需求');
  assert.equal(byId['502'].parent.title, '登录改造');

  // 第二次走缓存：不再查关联。
  fs.writeFileSync(calls, '');
  await tapd.syncStatus(config, [{ externalId: '9001', meta: { workspaceId: '123', entity: 'bug' } }], ctx);
  assert.ok(!fs.readFileSync(calls, 'utf8').includes('related-stories'), '关联 12 小时内走缓存');
});

test('归类：syncStatus 顺带交父节点（壳节点回填 / 父指针变化）', async () => {
  setRemote([{ id: '9100', title: '白屏', status: 'new', modified: '2026-11-17 10:00:00' }], [{ id: '600', name: '首页改版', status: 'developing', parent_id: '0' }], { 9100: ['600'] });
  const out = await tapd.syncStatus({ ...base }, [{ externalId: '9100', meta: { workspaceId: '123', entity: 'bug' } }], { ...memory(), classify: 'on' });
  assert.equal(out[0].node.id, '9100');
  assert.equal(out[0].parent.title, '首页改版');
  const missing = await tapd.syncStatus({ ...base }, [{ externalId: '404', meta: { workspaceId: '123', entity: 'bug' } }], { ...memory(), classify: 'on' });
  assert.equal(missing[0].missing, true);
  assert.equal(missing[0].node, undefined, '找不到的不交 node');
});

/* ------------------------------ 评论和 @ 提醒 ------------------------------ */

const comment = (id, author, entryType, entryId, created, description, title = '') => ({ id, author, entry_type: entryType, entry_id: entryId, created, description, title, root_id: '0', reply_id: '0' });

test('@ 识别：TAPD 界面的 at-who 标记和纯文本「@昵称」都算，名字是别人名字的前缀时不算', () => {
  assert.equal(tapd.mentions('<b class="at-who" data-userid="小明" data-type="user">@小明</b> 看下', '小明'), true);
  assert.equal(tapd.mentions('<p>请 @小明 确认</p>', '小明'), true);
  assert.equal(tapd.mentions('<p>请 @小明明 确认</p>', '小明'), false);
  assert.equal(tapd.mentions('<p>小明你好</p>', '小明'), false);
});

test('评论提醒：第一次只记游标、认出参与过的单子，不回补；之后只交和我有关、不是我写的新评论，评论先交', async () => {
  const mine = [{ id: '7001', title: '分给我的缺陷', status: 'new', modified: '2026-11-17 10:00:00' }];
  const story = [{ id: '8001', name: '我参与讨论的需求', status: 'developing' }, { id: '8002', name: '别人的需求', status: 'developing' }];
  const history = [comment('c1', '小明', 'stories', '8001', '2026-11-10 10:00:00', '<p>我先看看</p>')];
  setRemote(mine, story, {}, history);
  const ctx = memory();
  const config = { ...base, startFresh: false };
  const first = await tapd.poll(config, ctx);
  assert.ok(first.items.every((item) => item.externalType !== '评论'), '第一次不回补历史评论');
  assert.ok(ctx.state.get('comments:cursor:123'), '记下游标');

  const at = (min) => new Date(Date.now() + (8 * 60 + min) * 60000).toISOString().slice(0, 19).replace('T', ' ');
  setRemote(mine, story, {}, [
    ...history,
    comment('c2', '测试甲', 'bug_remark', '7001', at(1), '<p>复测不通过</p>', '流转状态从 [已解决] 到 [重新打开] 添加'),
    comment('c3', '测试乙', 'stories', '8001', at(2), '<p>补充了截图</p>'),
    comment('c4', '产品丙', 'stories', '8002', at(3), '<p><b class="at-who" data-userid="小明">@小明</b> 这个排期？</p>'),
    comment('c5', '产品丙', 'stories', '8002', at(4), '<p>和小明无关的讨论</p>'),
    comment('c6', '小明', 'bug', '7001', at(5), '<p>我自己写的</p>')
  ]);
  const { items } = await tapd.poll(config, ctx);
  const notes = items.filter((item) => item.externalType === '评论');
  assert.deepEqual(notes.map((item) => item.externalId), ['comment:c2', 'comment:c3', 'comment:c4']);
  assert.equal(items[0].externalType, '评论', '评论排在单子前面');
  const [reopen, talked, mention] = notes;
  assert.equal(reopen.eventType, 'tapd.comment');
  assert.match(reopen.title, /测试甲 评论了：分给我的缺陷/);
  assert.match(reopen.content, /场景：流转状态从 \[已解决\] 到 \[重新打开\] 添加/);
  assert.equal(reopen.groupKey, 'tapd:123:bug:7001');
  assert.equal(reopen.track, false, '评论不绑状态跟踪');
  assert.deepEqual(reopen.node, { workspace: '123', type: 'bug', id: '7001' });
  assert.equal(reopen.url, 'https://www.tapd.cn/123/bugtrace/bugs/view?bug_id=7001');
  assert.match(talked.title, /我参与讨论的需求/, '不是分给我的单子，标题另查');
  assert.equal(mention.eventType, 'tapd.comment.mention');
  assert.match(mention.title, /产品丙 @ 了你：别人的需求/);

  const again = await tapd.poll(config, ctx);
  assert.ok(again.items.every((item) => item.externalType !== '评论'), '同一条评论不会再交');
});

test('评论提醒：一次超过 10 条时排队，几轮交完；关掉之后不再拉评论', async () => {
  const mine = [{ id: '7001', title: '分给我的缺陷', status: 'new', modified: '2026-11-17 10:00:00' }];
  setRemote(mine, [], {}, []);
  const ctx = memory();
  const config = { ...base, startFresh: false };
  await tapd.poll(config, ctx);
  const at = (sec) => new Date(Date.now() + 8 * 3600000 + 60000 + sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
  setRemote(mine, [], {}, Array.from({ length: 14 }, (_, i) => comment(`n${i}`, '测试甲', 'bug', '7001', at(i), `<p>第 ${i} 条</p>`)));
  const one = await tapd.poll(config, ctx);
  assert.equal(one.items.length, 10);
  assert.ok(one.items.every((item) => item.externalType === '评论'));
  const two = await tapd.poll(config, ctx);
  assert.equal(two.items.filter((item) => item.externalType === '评论').length, 4);
  assert.ok(two.items.some((item) => item.externalId === '7001'), '剩下的名额给单子');

  fs.writeFileSync(calls, '');
  await tapd.poll({ ...config, comments: false }, memory());
  assert.ok(!fs.readFileSync(calls, 'utf8').includes('"comment"'), '关掉后不调 comment list');
});

/* ------------------------------ 单项目 + 筛选条件 ------------------------------ */

test('一条配置只对应一个项目：填了多个给出拆开的提示', async () => {
  setRemote(bugs(1));
  const result = await tapd.test({ ...base, workspaceIds: '123, 456' }, memory());
  assert.equal(result.ok, false);
  assert.match(result.detail, /一条配置只对应一个项目/);
  await assert.rejects(tapd.poll({ ...base, workspaceIds: '123,456' }, memory()), /其他项目.*各加一条/);
});

test('查询条件：默认只看分给我的；筛选条件按类型取、多个值用 |、「我」换成昵称、非法字段名忽略', () => {
  const plain = tapd.queryFor({}, 'bug', '小明');
  assert.deepEqual(plain.params, ['current_owner=小明']);
  assert.equal(plain.statusFiltered, false);

  const q = tapd.queryFor({
    scope: 'any',
    filters: [
      { field: 'story.developer', values: ['我', '小红'] },
      { field: 'story.status', values: ['developing', 'status_15'] },
      { field: 'bug.status', values: ['new'] },
      { field: 'story.bad key', values: ['x'] },
      { field: 'story.label', values: ['a|b'] }
    ]
  }, 'story', '小明');
  assert.deepEqual(q.params, ['developer=小明|小红', 'status=developing|status_15']);
  assert.equal(q.statusFiltered, true, '选了状态就完全按用户的来');
  assert.throws(() => tapd.queryFor({ scope: 'any', filters: [{ field: 'story.status', values: ['x'] }] }, 'bug', '小明'), /至少要加一个筛选条件/);
});

test('按筛选条件拉：选了状态时已结束的也会进来；改了条件重新记基线，不会一下子全涌进来', async () => {
  const list = [
    { id: '301', title: '分给小红的', status: 'new', current_owner: '小红;', modified: '2026-11-17 10:00:00' },
    { id: '302', title: '已上线但要看', status: 'status_5', current_owner: '小红;', modified: '2026-11-17 10:00:00' },
    { id: '303', title: '分给我的', status: 'new', current_owner: '小明;', modified: '2026-11-17 10:00:00' }
  ];
  setRemote(list);
  const ctx = memory();
  const mine = { ...base, startFresh: false, comments: false };
  assert.deepEqual((await tapd.poll(mine, ctx)).items.map((i) => i.externalId), ['303']);

  const others = { ...mine, scope: 'any', filters: [{ field: 'bug.current_owner', values: ['小红'] }, { field: 'bug.status', values: ['new', 'status_5'] }] };
  assert.deepEqual((await tapd.poll(others, memory())).items.map((i) => i.externalId).sort(), ['301', '302']);

  const fresh = { ...others, startFresh: true };
  const ctx2 = memory();
  assert.deepEqual((await tapd.poll(fresh, ctx2)).items, [], '第一次只记基线');
  const changed = { ...fresh, filters: [{ field: 'bug.current_owner', values: ['小红'] }] };
  assert.deepEqual((await tapd.poll(changed, ctx2)).items, [], '改了条件重新记一次基线');
  list.push({ id: '304', title: '新分给小红的', status: 'new', current_owner: '小红;', modified: '2026-11-17 11:00:00' });
  setRemote(list);
  assert.deepEqual((await tapd.poll(changed, ctx2)).items.map((i) => i.externalId), ['304']);
});

test('filterFields：按类型分组，只给下拉 / 多选（带候选值）和选人字段，常用字段排前面', async () => {
  setRemote(bugs(1), [], {}, []);
  const fixtureData = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  fixtureData.fields = {
    bug: {
      custom_field_10: { label: '问题分类', html_type: 'select', options: { 功能问题: '功能问题', 性能问题: '性能问题' } },
      title: { label: '标题', html_type: 'input' },
      status: { label: '状态', html_type: 'select', options: { new: '未解决', resolved: '已解决' } },
      priority: { label: '优先级', html_type: 'select', options: { high: '高' } },
      priority_label: { label: '优先级', html_type: 'select', options: { high: '高' } },
      current_owner: { label: '处理人', html_type: 'user_chooser', options: [] },
      project_id: { label: '所属项目', html_type: 'select', options: { 123: '演示' } },
      module: { label: '模块', html_type: 'select', options: [] }
    },
    story: { developer: { label: '开发人员', html_type: 'user_chooser' } }
  };
  fs.writeFileSync(fixture, JSON.stringify(fixtureData));
  const { fields } = await tapd.filterFields({ ...base, entities: 'both' }, memory());
  assert.deepEqual(fields.map((f) => f.key), ['bug.status', 'bug.priority_label', 'bug.current_owner', 'bug.custom_field_10', 'story.developer']);
  assert.deepEqual(fields[0], { key: 'bug.status', label: '状态', group: '缺陷', input: 'enum', options: [{ value: 'new', label: '未解决' }, { value: 'resolved', label: '已解决' }] });
  assert.equal(fields.find((f) => f.key === 'bug.current_owner').input, 'user');
  assert.equal(fields.find((f) => f.key === 'story.developer').group, '需求');
});

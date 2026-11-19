// 企微通讯录：按 userid 查姓名部门职位；token 过期换新再试；查不到的跳过；IP 不可信这类整体错误抛出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupMembers, directoryConfigured } from '../plugin-src/wecom/directory.js';

const config = { corpId: 'ww1', contactSecret: 's1' };

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname.split('/').pop() + (u.searchParams.get('userid') ? `:${u.searchParams.get('userid')}` : ''));
    return { ok: true, json: async () => handler(u) };
  };
  return calls;
}

test('没配凭证不查', async () => {
  assert.equal(directoryConfigured({ corpId: 'ww1' }), false);
  assert.deepEqual(await lookupMembers({}, ['a']), []);
});

test('查到姓名、主部门名、职位；查不到的跳过；token 过期换一次', async () => {
  let expired = true;
  let tokenNo = 0;
  const calls = mockFetch((u) => {
    const api = u.pathname.split('/').pop();
    if (api === 'gettoken') return { errcode: 0, access_token: `t${++tokenNo}`, expires_in: 7200 };
    if (api === 'user' || api === 'get') {
      if (u.pathname.endsWith('department/get')) return { errcode: 0, department: { id: 5, name: '研发部' } };
      if (expired) { expired = false; return { errcode: 42001, errmsg: 'expired' }; }
      if (u.searchParams.get('userid') === 'ghost') return { errcode: 60111, errmsg: 'not found' };
      return { errcode: 0, name: '张三', position: '工程师', department: [5], main_department: 5, alias: '' };
    }
    return { errcode: -1 };
  });
  const out = await lookupMembers(config, ['zs', 'ghost']);
  assert.deepEqual(out, [{ id: 'zs', name: '张三', title: '工程师', department: '研发部', alias: '' }]);
  assert.equal(tokenNo, 2, 'token 过期换了一次');
  assert.ok(calls.includes('get:ghost'));
});

test('IP 不可信：整批失败并给出提示', async () => {
  mockFetch((u) => (u.pathname.endsWith('gettoken')
    ? { errcode: 0, access_token: 'x', expires_in: 7200 }
    : { errcode: 60020, errmsg: 'not allow to access from your ip' }));
  await assert.rejects(lookupMembers({ corpId: 'ww2', contactSecret: 's2' }, ['zs']), /企业可信 IP/);
});

// wecom-cli：通讯录只能按关键词搜，拿 userid 当关键词，userid 完全一样才算查到。
const { lookupByCli } = await import('../plugin-src/wecom/cli.js');

test('wecom-cli：userid 当关键词搜，只认 userid 完全一样的；一次最多 10 个关键词', async () => {
  const calls = [];
  const run = async (config, args) => {
    const { keywords } = JSON.parse(args[args.indexOf('--json') + 1]);
    calls.push(keywords);
    assert.deepEqual(args.slice(0, 3), ['contact', 'users', 'search']);
    return {
      users: [
        { userid: 'zhangsan', name: '张三', alias: 'Sam', position: '负责人', departments: ['公司/研发中心/后台组'] },
        { userid: 'zhangsan2', name: '张三', departments: ['公司/市场部'] }, // 同名不同人：不要
        { userid: 'lisi', name: '李四', departments: [] }
      ].filter((u) => keywords.includes(u.userid) || u.userid === 'zhangsan2')
    };
  };
  const ids = ['zhangsan', 'lisi', 'ghost', ...Array.from({ length: 10 }, (_, i) => `u${i}`)];
  const out = await lookupByCli({}, ids, { run });
  assert.equal(calls.length, 2, '13 个 id 分两次搜');
  assert.deepEqual(out, [
    { id: 'zhangsan', name: '张三', title: '负责人', department: '后台组', alias: 'Sam' },
    { id: 'lisi', name: '李四', title: '', department: '', alias: '' }
  ]);
});

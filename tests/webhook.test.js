import test from 'node:test';
import assert from 'node:assert/strict';
import { webhook } from '../plugins/webhook/index.js';

test('GitHub webhook 会转成标题、链接和稳定 externalId', async () => {
  const payload = {
    action: 'opened',
    repository: { full_name: 'acme/jingjing', html_url: 'https://github.com/acme/jingjing' },
    issue: { number: 12, title: '登录失败', html_url: 'https://github.com/acme/jingjing/issues/12' },
    sender: { login: 'wang' }
  };
  const result = await webhook(payload, {
    headers: { 'x-github-event': 'issues', 'x-github-delivery': 'delivery-123' }
  });
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.externalId, 'delivery-123');
  assert.match(item.title, /acme\/jingjing/);
  assert.match(item.title, /登录失败/);
  assert.equal(item.url, 'https://github.com/acme/jingjing/issues/12');
  assert.ok(item.content.includes('登录失败'));
});

test('普通 JSON webhook 的字段映射与时间去格式化', async () => {
  const result = await webhook({
    title: '服务器告警',
    message: '磁盘占用 92%',
    link: 'https://example.com/alert/1',
    created_at: '2026-11-13T08:00:00Z',
    id: 'alert-1'
  });
  const item = result.items[0];
  assert.equal(item.title, '服务器告警');
  assert.equal(item.content, '磁盘占用 92%');
  assert.equal(item.url, 'https://example.com/alert/1');
  assert.equal(item.externalId, 'alert-1');
  assert.equal(item.occurredAt, '2026-11-13T08:00:00.000Z');
});

test('没有 id 时用 payload 哈希去重，且重复 payload 稳定', async () => {
  const a = await webhook({ title: 'x', message: 'y' });
  const b = await webhook({ title: 'x', message: 'y' });
  assert.equal(a.items[0].externalId, b.items[0].externalId);
});

test('非对象 payload 不会崩', async () => {
  const result = await webhook('plain text');
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].content, /plain text/);
});

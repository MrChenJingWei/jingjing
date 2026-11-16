import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleMatches } from '../src/worker-rules.js';

const base = {
  enabled: true,
  pattern: '',
  source: '',
  event_type: '',
  workspace_id: '',
  worker: 'llm'
};

test('Worker 规则：来源、事件类型、正则和工作区按 AND 匹配', () => {
  const rule = {
    ...base,
    pattern: '登录|login',
    source: 'plugin:webhook',
    event_type: 'issues',
    workspace_id: 'default'
  };
  assert.equal(ruleMatches(rule, {
    text: '登录页报错',
    source: 'plugin:webhook',
    eventType: 'issues',
    workspaceId: 'default'
  }), true);
  assert.equal(ruleMatches(rule, { text: '登录页报错', source: 'web', eventType: 'issues', workspaceId: 'default' }), false);
  assert.equal(ruleMatches(rule, { text: '登录页报错', source: 'plugin:webhook', eventType: 'push', workspaceId: 'default' }), false);
  assert.equal(ruleMatches(rule, { text: '登录页报错', source: 'plugin:webhook', eventType: 'issues', workspaceId: 'other' }), false);
  assert.equal(ruleMatches(rule, { text: '付款问题', source: 'plugin:webhook', eventType: 'issues', workspaceId: 'default' }), false);
});

test('Worker 规则：来源和事件类型支持通配，禁用规则永不命中', () => {
  const wildcard = { ...base, source: 'plugin:*', event_type: 'issues.*' };
  assert.equal(ruleMatches(wildcard, { source: 'plugin:github', eventType: 'issues.opened' }), true);
  assert.equal(ruleMatches(wildcard, { source: 'plugin:github', eventType: 'push' }), false);
  assert.equal(ruleMatches({ ...wildcard, enabled: false }, { source: 'plugin:github', eventType: 'issues.opened' }), false);
  assert.equal(ruleMatches({ ...base, event_type: '*' }, { source: 'anything', eventType: 'whatever' }), true);
});

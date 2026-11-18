// 路由信号：归一化、别名边界、关键词编译、证据校验。纯函数，不碰数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileTerms, evidenceMatches, matchCompiled, matchTerm, matchTerms, normalizeAliases, normalizeText, splitTerms
} from '../src/routing-signals.js';

test('归一化：全半角、大小写、空白标点都不影响匹配', () => {
  assert.equal(normalizeText('  Ｃｌａｕｄｅ　Code!! '), 'claudecode');
  assert.equal(normalizeText('TAPD-缺陷'), 'tapd缺陷');
  assert.ok(matchTerm('用 Claude Code 改一下', 'claude code'));
  assert.ok(matchTerm('用ＣＬＡＵＤＥ改', 'claude'));
  assert.ok(matchTerm('用claude改一下', 'claude'));
});

test('英文短词要词边界，中文里夹着也能认出来', () => {
  assert.equal(matchTerm('切到 deepseek-chat 模型', 'deepseek'), false);
  assert.equal(matchTerm('dshd 不是命令', 'dsh'), false);
  assert.ok(matchTerm('用dsh改一下', 'dsh'));
  assert.ok(matchTerm('用 dsh 改一下', 'dsh'));
  assert.equal(matchTerm('github 上的事', 'git'), false);
  assert.ok(matchTerm('用 git 提交', 'git'));
});

test('拆词：逗号、顿号、竖线、换行都算分隔，去重保序', () => {
  assert.deepEqual(splitTerms('周报, weekly、周报|日报\n晨会'), ['周报', 'weekly', '日报', '晨会']);
  assert.deepEqual(normalizeAliases(['claude', ' Claude ', 'claude', '']), ['claude']);
});

test('编译：默认当字面词，不会被正则元字符误伤；显式 regex 才按正则', () => {
  const literal = compileTerms('C++ (beta), 发布');
  assert.equal(literal.error, null);
  assert.deepEqual(literal.terms, ['C++ (beta)', '发布']);
  assert.ok(literal.trigger.test('帮我修 C++ (beta) 的问题'));

  const regex = compileTerms('^周报', { mode: 'regex' });
  assert.equal(regex.mode, 'regex');
  assert.ok(regex.trigger.test('周报汇总'));

  assert.match(compileTerms('(', { mode: 'regex' }).error, /不是合法的正则/);
});

test('编译：排除词命中就不算命中，长词优先', () => {
  const compiled = compileTerms('周报, 周报汇总', { negatives: '周报怎么用' });
  assert.equal(matchCompiled('帮我写周报汇总', compiled).term, '周报汇总');
  assert.equal(matchCompiled('周报怎么用？', compiled), null);

  const list = compileTerms('TAPD, 缺陷');
  assert.deepEqual(matchTerms('TAPD 上的缺陷', list.terms), ['TAPD', '缺陷']);
});

test('模型给的证据必须真的出现在原话里', () => {
  assert.ok(evidenceMatches('用 Claude Code 改一下这个页面', 'Claude Code'));
  assert.ok(evidenceMatches('用 Ｃｌａｕｄｅ 改', 'claude'));
  assert.equal(evidenceMatches('用 Claude Code 改一下', '用 Codex 改'), false);
  assert.ok(evidenceMatches('随便什么', ''), '空证据按旧格式放行');
});

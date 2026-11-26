// 任务结论：Worker 的 [[OUTCOME]] 标记，以及没给结论时从结果收尾推断「要不要主人接着处理」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOutcome, withOutcome } from '../src/worker-runtime.js';
import { awaitingReply } from '../public/js/reply-detect.js';

test('[[OUTCOME]] 标记：认出结论并从结果里去掉；不认识的结论只去掉标记', () => {
  assert.deepEqual(extractOutcome('方案如下。\n\n[[OUTCOME]] proposed'), { outcome: 'proposed', text: '方案如下。' });
  assert.deepEqual(extractOutcome('做完了\n[[OUTCOME]] shipped'), { outcome: null, text: '做完了' });
  assert.equal(extractOutcome('没有标记'), null);
  // 行中间提到标记不算
  assert.equal(extractOutcome('约定是输出 [[OUTCOME]] proposed 这一行'), null);
});

test('withOutcome：结果对象里的 outcome 优先；非法值丢掉；非 done 原样返回', () => {
  assert.deepEqual(withOutcome({ status: 'done', summary: 'x\n[[OUTCOME]] partial', outcome: 'blocked' }), { status: 'done', summary: 'x', outcome: 'blocked' });
  assert.deepEqual(withOutcome({ status: 'done', summary: 'x', outcome: 'whatever' }), { status: 'done', summary: 'x' });
  const failed = { status: 'failed', summary: '[[OUTCOME]] proposed' };
  assert.equal(withOutcome(failed), failed);
});

test('收尾在等回话：主动提出下一步、留了要定的事都算，不只看问号', () => {
  const plan = [
    '## 结论',
    '',
    '可以做，改动集中在两个页面；最大的不确定是接口字段。建议先把 Q1、Q2 定下来，再开始写代码。',
    '',
    '另：本单按新需求出方案。需要我把这些问题发到评论、建子任务，或先落文档，说一声即可。'
  ].join('\n');
  assert.match(awaitingReply(plan), /需要我把这些问题/);
  assert.ok(awaitingReply('改好了，测试也过了。要不要顺便把文档更新一下'));
  assert.ok(awaitingReply('两个方案各有取舍，你来定用哪个。'));
  assert.ok(awaitingReply('已经整理好了。\n\n要我直接发出去吗'));
  assert.ok(awaitingReply('结果见上。下一步是先合 beta 还是直接提测？'));
});

test('收尾不在等回话：做完了、客套话、问号只出现在代码或表格里', () => {
  assert.equal(awaitingReply('已经全部改完，测试通过，提交了 3 个文件。'), '');
  assert.equal(awaitingReply('周报已整理好。\n\n有问题随时告诉我。'), '');
  assert.equal(awaitingReply('如有其他需要再说。'), '');
  assert.equal(awaitingReply('改好了。\n\n```js\nconst ok = a ? b : c; // why?\n```'), '');
  assert.equal(awaitingReply('| 编号 | 问题？ |\n| --- | --- |\n| 1 | x |\n\n都处理完了。'), '');
  // 只看最后两段：前面问过的问题已经在正文里回答了
  assert.equal(awaitingReply('为什么会这样？\n\n原因是缓存过期。\n\n已修复，加了测试。\n\n上线了。'), '');
});

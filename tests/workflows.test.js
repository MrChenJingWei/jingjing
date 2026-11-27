// 工作流程：解析、匹配、读取用户文件夹、从任务学习习惯，以及按流程派活的完整闭环。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-workflows-'));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-user-flows-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { saveSettings, getSettings } = await import('../src/db.js');
const { SANDBOX_DIR } = await import('../src/config.js');
const wf = await import('../src/workflows.js');
const workers = await import('../src/workers.js');
const scheduler = await import('../src/scheduler.js');
const router = await import('../src/router.js');

fs.mkdirSync(SANDBOX_DIR, { recursive: true });
await workers.loadBuiltinWorkers();

test.after(() => removeTemp(dataDir, userDir));

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(fn, label, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error(`等待超时：${label}`);
}

test('解析：头部字段可选，没有头部时用一级标题或文件名当名称', () => {
  const full = wf.parseWorkflow('---\nname: 写周报\nwhen: 周报, weekly\nworker: file\nworkspace: 默认工作区\n---\n\n1. 汇总\n2. 保存', { file: '/x/a.md' });
  assert.equal(full.name, '写周报');
  assert.equal(full.worker, 'file');
  assert.equal(full.status, 'active');
  assert.equal(full.source, 'doc');
  assert.ok(full.trigger.test('帮我写这周的 Weekly'));
  assert.equal(full.steps, '1. 汇总\n2. 保存');

  assert.equal(wf.parseWorkflow('# 部署流程\n\n先跑测试', { file: '/x/deploy.md' }).name, '部署流程');
  assert.equal(wf.parseWorkflow('先跑测试', { file: '/x/发布检查.md' }).name, '发布检查');
  // 默认把 when 当关键词：正则元字符不再报错，也不会被当成正则。
  assert.equal(wf.parseWorkflow('---\nwhen: (\n---\n', { file: '/x/b.md' }).error, null);
  assert.ok(wf.parseWorkflow('---\nwhen: (\n---\n', { file: '/x/b2.md' }).trigger.test('帮我填 ( 这个空'));
  // 老流程显式声明 whenRegex 时仍按正则解释，非法正则照样报错。
  assert.match(wf.parseWorkflow('---\nwhen: (\nwhenRegex: true\n---\n', { file: '/x/b3.md' }).error, /when 不是合法的正则/);

  const learned = wf.parseWorkflow('---\nname: x\nsource: learned\n---\n', { file: '/x/c.md' });
  assert.equal(learned.status, 'candidate');
});

test('匹配：显式触发词优先，文档优先于习惯，没写 when 的文档按名称模糊匹配', () => {
  const list = [
    { ...wf.parseWorkflow('---\nname: 习惯周报\nwhen: 周报\nsource: learned\nstatus: active\n---\n', { file: '/l.md' }) },
    { ...wf.parseWorkflow('---\nname: 我的周报\nwhen: 周报\n---\n', { file: '/d.md' }) },
    { ...wf.parseWorkflow('# 部署流程\n1. 先跑测试', { file: '/deploy.md' }) },
    { ...wf.parseWorkflow('---\nname: 停用的\nwhen: 发票\nstatus: disabled\n---\n', { file: '/off.md' }) }
  ];
  assert.equal(wf.matchWorkflow('帮我写一下周报', { workflows: list }).workflow.name, '我的周报');
  const deploy = wf.matchWorkflow('帮我部署一下测试环境', { workflows: list });
  assert.equal(deploy.workflow.name, '部署流程');
  assert.equal(deploy.how, 'name');
  assert.equal(wf.matchWorkflow('整理一下发票', { workflows: list }), null);
  assert.equal(wf.matchWorkflow('整理一下发票', { workflows: list, includeInactive: true }).workflow.name, '停用的');
  assert.equal(wf.matchWorkflow('今天天气不错', { workflows: list }), null);
});

test('setFrontmatterField：替换、追加或新建头部', () => {
  assert.equal(wf.setFrontmatterField('---\nname: a\nstatus: candidate\n---\nbody', 'status', 'active'), '---\nname: a\nstatus: active\n---\nbody');
  assert.equal(wf.setFrontmatterField('---\nname: a\n---\nbody', 'status', 'active'), '---\nname: a\nstatus: active\n---\nbody');
  assert.equal(wf.setFrontmatterField('body', 'status', 'active'), '---\nstatus: active\n---\n\nbody');
});

test('读取用户文件夹：只读不改，停用只记在本机', () => {
  const file = path.join(userDir, '报销流程.md');
  const original = '---\nwhen: 报销, 发票\nworker: llm\n---\n1. 核对金额\n2. 填报销单\n';
  fs.writeFileSync(file, original);
  fs.mkdirSync(path.join(userDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'node_modules', 'x.md'), '# 不该被读');
  saveSettings({ workflowDirs: [userDir, path.join(userDir, '不存在')] });

  const overview = wf.overview({ fresh: true });
  const item = overview.workflows.find((w) => w.file === file);
  assert.ok(item, '读到了用户文件夹里的流程');
  assert.equal(item.editable, false);
  assert.ok(!overview.workflows.some((w) => w.name === '不该被读'));
  assert.ok(overview.errors.some((e) => /文件夹不存在/.test(e.error)));

  assert.equal(wf.setStatus(item.id, 'disabled').status, 'disabled');
  assert.equal(fs.readFileSync(file, 'utf8'), original, '用户文件没有被改写');
  assert.equal(wf.matchWorkflow('帮我报销这张发票'), null);
  assert.throws(() => wf.updateRaw(item.id, 'x'), /直接用编辑器改原文件/);
  assert.throws(() => wf.deleteWorkflow(item.id), /不会删除/);
  wf.setStatus(item.id, 'active');
  assert.equal(wf.matchWorkflow('帮我报销这张发票').workflow.id, item.id);
  saveSettings({ workflowDirs: [] });
  wf.reload();
});

test('shouldLearn：只总结对话/手动发起、不是一问一答的成功任务', () => {
  const base = { status: 'done', origin: 'chat', workflow_id: null };
  assert.equal(wf.shouldLearn(base, [], { textOnly: false }), true);
  assert.equal(wf.shouldLearn(base, [], { textOnly: true }), false);
  assert.equal(wf.shouldLearn(base, [{ type: 'task/waiting_approval' }], { textOnly: true }), true);
  assert.equal(wf.shouldLearn({ ...base, origin: 'proactive' }, []), false);
  assert.equal(wf.shouldLearn({ ...base, workflow_id: 'abc' }, []), false);
  assert.equal(wf.shouldLearn({ ...base, status: 'failed' }, []), false);
  assert.equal(wf.shouldLearn(base, [{ type: 'workflow/proposed' }]), false);
});

test('闭环：完成任务 → 候选习惯 → 确认 → 同类请求直接按习惯派活', async () => {
  const first = await router.handleMessage('帮我生成一个 notes.md 文件，内容是明天的三件事');
  assert.equal(first.task.worker, 'file');
  await waitFor(() => scheduler.getTask(first.task.id).status === 'done', '第一个任务完成');

  // 任务结束后异步总结，候选卡片发到对话里。
  const card = await waitFor(() => router.messages().find((m) => m.kind === 'workflow'), '候选卡片');
  const candidate = wf.getWorkflow(card.meta.workflowId);
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.source, 'learned');
  assert.equal(candidate.worker, 'file');
  assert.ok(candidate.file.startsWith(wf.LEARNED_DIR));
  assert.ok(candidate.trigger.test(first.task.prompt), '触发词能认出这次任务本身');
  assert.ok(scheduler.taskEvents(first.task.id).some((e) => e.type === 'workflow/proposed'));

  // 候选不生效。
  assert.equal(wf.matchWorkflow('再生成一个 notes.md 文件'), null);

  // 确认后：同类请求不经模型判断，直接按习惯派给 file，并带上步骤。
  wf.setStatus(candidate.id, 'active');
  assert.match(fs.readFileSync(candidate.file, 'utf8'), /status: active/);
  const second = await router.handleMessage('再帮我生成一个 notes.md 文件，内容是后天的安排');
  assert.equal(second.task.workflow_id, candidate.id);
  assert.equal(second.task.worker, 'file');
  assert.match(second.task.prompt, /按工作流程「.+」来做/);
  assert.match(second.reply.text, /按习惯「/);
  await waitFor(() => scheduler.getTask(second.task.id).status === 'done', '第二个任务完成');
  await waitFor(() => wf.listWorkflows().find((w) => w.id === candidate.id)?.stats.uses === 1, '使用次数统计');
  assert.equal(router.messages().filter((m) => m.kind === 'workflow').length, 1, '按习惯执行的任务不会再提议新习惯');

  // 已有同类流程时，手动总结会提示跳过。
  const again = await router.proposeWorkflow(first.task.id);
  assert.match(again.skipped, /已有同类流程/);
});

test('问句和进度查询不套流程；流程指定的工作区会生效', async () => {
  const created = wf.createWorkflow({ name: '晨会纪要', when: '晨会', worker: 'llm', workspace: '默认工作区', steps: '1. 列出昨天完成的事' });
  assert.equal(created.editable, true);
  const question = await router.handleMessage('晨会一般开多久？');
  assert.notEqual(question.intent, 'task');
  const status = await router.handleMessage('晨会纪要的进度怎么样了');
  assert.equal(status.intent, 'status');
  const run = await router.handleMessage('帮我整理今天的晨会');
  assert.equal(run.task.workflow_id, created.id);
  assert.equal(run.task.worker, 'llm');
  assert.equal(run.task.cwd, SANDBOX_DIR);
  await waitFor(() => ['done', 'failed'].includes(scheduler.getTask(run.task.id).status), '晨会任务结束');
  assert.equal(scheduler.getTask(run.task.id).status, 'done', scheduler.getTask(run.task.id).error || '');
});

test('从任务学流程时，默认工作区不写死，别的工作区才记下来', async () => {
  const task = { id: 't_learn_ws', title: '整理佣金字段', prompt: '整理佣金字段的命名', worker: 'llm' };
  const def = await wf.learnFromTask(task, [], { workerLabel: '问答', workspaceName: '默认工作区', force: true });
  assert.equal(def.workflow.workspace, '', '默认工作区不写进流程');
  const yu = await wf.learnFromTask({ ...task, id: 't_learn_ws2', prompt: '整理佣金字段的命名和引用' }, [], { workerLabel: '问答', workspaceName: '渔童', force: true });
  assert.equal(yu.workflow.workspace, '渔童');
});

test('流程触发词：默认按字面词匹配，支持排除词；老流程可显式用正则', () => {
  const flow = wf.parseWorkflow('---\nname: 修接口\nwhen: 接口, C++\nnotWhen: 接口怎么用\n---\n1. 修', { file: '/x/api.md' });
  assert.equal(flow.error, null);
  assert.ok(wf.matchWorkflow('帮我修一下 C++ 接口', { workflows: [flow] }));
  assert.equal(wf.matchWorkflow('接口怎么用？', { workflows: [flow] }), null);

  const legacy = wf.parseWorkflow('---\nname: 老流程\nwhen: ^周报\nwhenRegex: true\n---\n1. 写', { file: '/x/legacy.md' });
  assert.ok(wf.matchWorkflow('周报汇总', { workflows: [legacy] }));
  assert.equal(wf.matchWorkflow('写周报', { workflows: [legacy] }), null);
});

test('两个流程命中同样时，优先当前情境所在工作区的那个', () => {
  const settings = getSettings();
  const aPath = path.join(dataDir, 'ws-a');
  const bPath = path.join(dataDir, 'ws-b');
  fs.mkdirSync(aPath, { recursive: true });
  fs.mkdirSync(bPath, { recursive: true });
  saveSettings({
    workspaces: [
      ...settings.workspaces,
      { id: 'w_a', name: 'A 项目', path: aPath },
      { id: 'w_b', name: 'B 项目', path: bPath }
    ]
  });
  const a = wf.createWorkflow({ name: '发布检查 A', when: '发布检查', worker: 'llm', workspace: 'A 项目', steps: '1. 检查 A' });
  const b = wf.createWorkflow({ name: '发布检查 B', when: '发布检查', worker: 'llm', workspace: 'B 项目', steps: '1. 检查 B' });

  const pickA = wf.matchWorkflow('做一次发布检查', { refs: [{ kind: 'workspace', key: 'w_a', name: 'A 项目' }] });
  assert.equal(pickA.workflow.id, a.id, '在 A 项目里优先 A 的流程');
  const pickB = wf.matchWorkflow('做一次发布检查', { refs: [{ kind: 'workspace', key: 'w_b', name: 'B 项目' }] });
  assert.equal(pickB.workflow.id, b.id, '在 B 项目里优先 B 的流程');
  // 没有情境时仍然照常命中（不会因为没 refs 就不触发）。
  assert.ok(wf.matchWorkflow('做一次发布检查').workflow);
});

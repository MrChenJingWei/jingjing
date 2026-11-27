import { db, now, uid, getSettings, saveSettings, maskSettings, rowTask, rowApproval, event, transaction } from './db.js';
import { TASK_OUTCOMES as OUTCOMES } from './worker-runtime.js';
import { bus } from './events.js';
import * as memory from './memory.js';
import * as lifecycle from './lifecycle.js';
import * as workflows from './workflows.js';
import { runWorker, availability, isWorker, workerLimits, workerRecovery, workerLabelOf, defaultWorker, reportUrl, workerCatalog, terminateChildren, extraDirsFor } from './workers.js';
import { effectivePermissions, requestFromDenials, describeRequest, isEmptyRequest, mergeGrant, mergeWorkspacePermission } from './permissions.js';
import { matchEntities } from './entities.js';
import { buildMemoryContext, injectionPayload } from './context.js';
import { namedWorker, handoffWorker } from './worker-routing.js';
import { ensureWorkerRule, listWorkerRules } from './worker-rules.js';
import * as channels from './channels.js';
import * as sourceLinks from './source-links.js';
import * as classification from './task-classification.js';

// taskId -> { controller, startedAt, worker, runId, report(body) }
const running = new Map();
const ABORTED = Symbol('aborted');
const HEARTBEAT_MS = 15 * 1000;
// 同一个任务连续被服务重启打断的次数上限，超过就停下，避免「崩溃 → 重启 → 再执行 → 再崩溃」。
export const MAX_RECOVERIES = 2;
// 服务正常退出时中止执行用的原因：任务保持 running，下次启动由 recover() 按 Worker 的恢复方式接着做。
const SHUTDOWN = 'shutdown';
const SHUTDOWN_NOTE = '服务退出时中断';
let pumping = false;
let stopping = false;
let heartbeatTimer = null;

function emitTask(task) {
  bus.emit('task/updated', { task });
}

export function getTask(id) {
  const task = rowTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  if (task) classification.attach(sourceLinks.attach([task]));
  return task;
}

/** 任务本身没变、但挂在它上面的东西（比如来源状态）变了：重新推一次，不改 updated_at。 */
export function touchTask(id) {
  const task = getTask(id);
  if (task) emitTask(task);
  return task;
}

// 归属变了（重算、手动归入、移出……）：重新推一次卡片。
classification.onTasksChanged(touchTask);

export function listTasks({ limit = 60, status, q = '' } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
    : db.prepare(`
        SELECT * FROM tasks
        ORDER BY CASE status
          WHEN 'waiting_approval' THEN 0
          WHEN 'running' THEN 1
          WHEN 'queued' THEN 2
          WHEN 'held' THEN 3
          WHEN 'failed' THEN 4
          WHEN 'done' THEN 5
          ELSE 6 END, created_at DESC
        LIMIT ?
      `).all(limit);
  const needle = String(q || '').trim().toLowerCase();
  const filtered = needle
    ? rows.filter((row) => `${row.title} ${row.prompt}`.toLowerCase().includes(needle))
    : rows;
  return classification.attach(sourceLinks.attach(filtered.map(rowTask)));
}

export function taskEvents(taskId, limit = 50) {
  return db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?')
    .all(taskId, limit)
    .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }))
    .reverse();
}

export const taskRuns = lifecycle.listRuns;

export function pendingApprovals() {
  return db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC")
    .all()
    .map(rowApproval);
}

export function getApproval(id) {
  return rowApproval(db.prepare('SELECT * FROM approvals WHERE id = ?').get(id));
}

export function stats() {
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS c FROM tasks GROUP BY status').all().map((r) => [r.status, r.c])
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const doneToday = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE status = ? AND finished_at >= ?')
    .get('done', today.toISOString()).c;
  const tokens = db.prepare('SELECT COALESCE(SUM(tokens),0) AS t, COALESCE(SUM(cost),0) AS c FROM tasks').get();
  const memories = db.prepare('SELECT COUNT(*) AS c FROM memories').get().c;
  return {
    counts,
    active: (counts.queued || 0) + (counts.running || 0) + (counts.waiting_approval || 0),
    doneToday,
    tokens: tokens.t,
    cost: tokens.c,
    memories,
    pendingApprovals: db.prepare("SELECT COUNT(*) AS c FROM approvals WHERE status='pending'").get().c,
    running: running.size,
    paused: Boolean(getSettings().queuePaused)
  };
}

export function createTask({
  title,
  prompt,
  worker = null,
  cwd = '',
  origin = 'chat',
  sessionId = null,
  ruleId = null,
  priority = 2,
  source = null,
  groupKey = '',
  hops = 0,
  workflowId = null,
  workflowName = '',
  // 传给 Worker 的运行选项（ctx.options），比如插件草稿任务的 { allowEdits: true }。
  options = null,
  // 来源插件给的回传地址：任务结果可以发回原会话（见 discovery.replyToSource）。
  replyTo = null,
  // 建好先停下问主人（比如外部消息点名了别的 Worker）：{ question, options, choices, progress }。
  // choices[i] 是选第 i 项时做什么：{ worker, rule? } 交给它（rule 顺手建一条分配规则），或 { cancel: true }。
  hold = null,
  // 任务之间的流转：从哪张卡另起的（parentId）、怎么接上的（linkKind，目前只有 followup）。
  parentId = null,
  linkKind = null,
  // 绑定的外部对象（见 source-links.linkFromItem），和任务在同一个事务里写入；sourceLinks 是多条。
  sourceLink = null,
  sourceLinksList = null,
  // 派活的人（people.id）：外部来源里说这件事的人。另起的后续卡不传时沿用上一张的。
  requester = null,
  // 只跟踪、不执行：建成 held，调度器不会去取，等主人点「开始执行」。
  held = false
}) {
  const chosen = worker || defaultWorker();
  if (!chosen) {
    const err = new Error('本机没有可用的 Worker，先在设置里启用或安装一个');
    err.statusCode = 400;
    throw err;
  }
  if (!isWorker(chosen)) {
    const err = new Error('未知的 Worker');
    err.statusCode = 400;
    throw err;
  }
  const settings = getSettings();
  const id = uid('t_');
  const stamp = now();
  const cleanTitle = String(title || prompt || '未命名任务').slice(0, 80);
  const approvalId = hold ? uid('a_') : null;
  const askedBy = requester || (parentId ? db.prepare('SELECT requester FROM tasks WHERE id = ?').get(parentId)?.requester : null) || null;
  transaction(() => {
    db.prepare(`
      INSERT INTO tasks(id, title, prompt, worker, cwd, status, priority, origin, rule_id, session_id, group_key, hops, workflow_id, options, reply_to, approval_id, progress, parent_id, link_kind, requester, recoveries, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
    `).run(
      id, cleanTitle, String(prompt || cleanTitle), chosen,
      cwd || settings.defaultCwd || '', hold ? 'waiting_approval' : held ? 'held' : 'queued', priority, origin, ruleId, sessionId,
      groupKey || null, Math.max(0, Number(hops) || 0), workflowId || null,
      options ? JSON.stringify(options) : null, replyTo ? JSON.stringify(replyTo) : null,
      approvalId, hold ? hold.progress || '等你决定交给谁' : null,
      parentId || null, parentId ? linkKind || 'followup' : null, askedBy, stamp, stamp
    );
    event(id, 'task/created', {
      worker: chosen, origin, title: cleanTitle, source,
      ...(held && !hold ? { held: true } : {}),
      ...(workflowId ? { workflowId, workflow: workflowName } : {}),
      ...(parentId ? { parentId, linkKind: linkKind || 'followup' } : {})
    });
    for (const link of [sourceLink, ...(sourceLinksList || [])].filter(Boolean)) sourceLinks.insertLink(id, link);
    if (hold) {
      db.prepare(`
        INSERT INTO approvals(id, task_id, question, options, status, kind, custom, meta, created_at)
        VALUES(?,?,?,?, 'pending', 'routing', 0, ?, ?)
      `).run(approvalId, id, hold.question, JSON.stringify(hold.options), JSON.stringify({ choices: hold.choices }), stamp);
      event(id, 'task/waiting_approval', { approvalId, question: hold.question, options: hold.options, kind: 'routing' });
    }
  });
  const task = getTask(id);
  bus.emit('task/created', { task });
  if (hold) {
    const approval = getApproval(approvalId);
    bus.emit('approval/created', { approval, task });
    channels.notifyApproval(approval, task).catch((err) => console.warn('[channel]', err.message));
  } else if (task.status === 'queued') {
    pump();
  }
  return task;
}

export function findMergeableTask({ groupKey, worker, cwd }) {
  if (!groupKey) return null;
  const row = db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('queued', 'held') AND group_key = ? AND worker = ? AND COALESCE(cwd, '') = COALESCE(?, '')
    ORDER BY created_at ASC LIMIT 1
  `).get(groupKey, worker, cwd || '');
  return row ? rowTask(row) : null;
}

export function mergeTask(taskId, { text = '', title = '', source = '', replyTo = null, sourceLink = null } = {}) {
  const task = getTask(taskId);
  if (!task || !['queued', 'held'].includes(task.status)) return null;
  const addition = `\n\n--- 合并的新事件${title ? `：${title}` : ''} ---\n${String(text || '').slice(0, 3000)}`;
  if (task.prompt.length < 30000) {
    db.prepare('UPDATE tasks SET prompt = ?, updated_at = ? WHERE id = ?')
      .run(task.prompt + addition, now(), taskId);
  }
  // 合并进来的新消息更晚：结果发回最近一条消息所在的会话。
  if (replyTo) db.prepare('UPDATE tasks SET reply_to = ? WHERE id = ?').run(JSON.stringify(replyTo), taskId);
  event(taskId, 'task/merged', { title, source });
  // 合并进来的那条外部对象也绑到这张卡上：一张卡可以对应多条来源。
  if (sourceLink) sourceLinks.insertLink(taskId, sourceLink);
  const updated = getTask(taskId);
  emitTask(updated);
  return updated;
}

/** 更新任务字段；改 status 时必须符合生命周期规则。 */
function setStatus(taskId, patch) {
  if (patch.status) {
    const current = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId)?.status;
    if (current) lifecycle.assertTransition(taskId, current, patch.status);
  }
  const fields = Object.keys(patch);
  const values = fields.map((f) => patch[f]);
  db.prepare(`UPDATE tasks SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, now(), taskId);
  return getTask(taskId);
}

function resumePayload(taskId, extra = {}) {
  return JSON.stringify({ ...(getTask(taskId)?.resume_payload || {}), ...extra });
}

/**
 * 任务走到终态（done / failed / cancelled）的唯一出口。
 * 写状态和事件放在一个事务里，然后统一推送、发 task/finished、通知、更新统计。
 * 不管是 Worker 返回、超时、异常、用户取消、拍板次数超限还是重启后放弃，
 * 下游（流程统计、自动发回原会话、插件工坊）都只需要听 task/finished。
 */
function finalize(taskId, status, patch = {}, { type = `task/${status}`, data = null } = {}) {
  const task = transaction(() => {
    setStatus(taskId, { progress: null, finished_at: now(), ...patch, status });
    event(taskId, type, data);
    return getTask(taskId);
  });
  emitTask(task);
  bus.emit('task/finished', { task });
  // 用户自己停掉的不用再通知一遍；完成和失败才发到通知通道。
  if (status !== 'cancelled') channels.notifyTask(task).catch((err) => console.warn('[channel]', err.message));
  bus.emit('stats/updated', stats());
  return task;
}

function finishCancelled(taskId) {
  // cancel() 已经把状态写成 cancelled；这里只兜底，绝不覆盖成其他状态。
  const current = getTask(taskId);
  if (current?.status === 'running') {
    finalize(taskId, 'cancelled', { result: '已停止' }, { data: { reason: 'aborted' } });
  } else {
    emitTask(current);
  }
}

function finishTimeout(task, limits) {
  const message = `超过 ${limits.timeoutMinutes} 分钟还没跑完，已停止。超时不会自动重试；可以在 Worker 配置里调大超时后手动重试。`;
  finalize(task.id, 'failed', {
    attempts: (task.attempts || 0) + 1,
    error: message,
    result: message
  }, { data: { error: message, timeout: true } });
}

/** 中止原因 → 这次执行的结局：超时、服务退出（任务保持 running 等重启后恢复）、其他都算取消。 */
function abortOutcome(reason) {
  if (reason === 'timeout') return 'timeout';
  if (reason === SHUTDOWN) return 'interrupted';
  return 'cancelled';
}

function finishAborted(task, limits, outcome) {
  if (outcome === 'timeout') finishTimeout(task, limits);
  else if (outcome === 'cancelled') finishCancelled(task.id);
  // interrupted：什么都不改，recover() 会接手。
}

function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (running.size) lifecycle.heartbeat([...running.values()].map((item) => item.runId));
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

/** 习惯允许自动拍板时，按习惯里记下的选择替用户回答。 */
function autoApprove(task, approvalId) {
  if (!task.workflow_id) return false;
  const workflow = workflows.getWorkflow(task.workflow_id);
  const approval = getApproval(approvalId);
  const answer = workflows.autoAnswer(workflow, approval);
  if (answer === null) return false;
  // 放到下一轮事件循环：先让「等你拍板」的状态和事件完整落库、推送出去。
  setImmediate(() => {
    try {
      const current = getApproval(approvalId);
      if (current?.status !== 'pending') return;
      approve(approvalId, answer, { by: 'habit' });
      bus.emit('approval/auto', {
        task: getTask(task.id),
        workflow: { id: workflow.id, name: workflow.name },
        question: approval.question,
        option: approval.options[answer]
      });
    } catch (err) {
      console.warn('[workflow] 自动拍板失败：', err.message);
    }
  });
  return true;
}

/** 任务上的 options 存在库里是 JSON 字符串，也兼容已经解析过的对象。 */
function parseOptions(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

/**
 * 被权限拦下的操作 → 还要主人放开什么；已经放开过的会从 effectivePermissions 里滤掉，
 * 所以同样的请求不会问第二遍。
 */
function permissionRequestFor(task, result, settings) {
  const denials = Array.isArray(result.permissionDenials) ? result.permissionDenials : [];
  if (!denials.length) return null;
  const cwd = task.cwd || settings.defaultCwd || '';
  const request = requestFromDenials(denials, {
    workspace: cwd,
    extraDirs: extraDirsFor(cwd, settings),
    granted: effectivePermissions(task, settings)
  });
  return isEmptyRequest(request) ? null : request;
}

/**
 * 有操作被拦下：停下来问主人。选项按「只这一次 / 以后这个工作区都允许 / 不放开」给，
 * 选完由 approve() 把放开的内容记到任务或工作区上，再接着这个会话重跑。
 */
function askPermission(task, result, request, settings) {
  const permissions = effectivePermissions(task, settings);
  const workspace = (settings.workspaces || []).find((ws) => ws.id === permissions.workspaceId) || null;
  // 命令规则和「可改文件」能记在工作区上；只是要用工作区外的目录时，「以后都允许」没有可记的东西。
  const persistable = Boolean(workspace && (request.edit || request.rules.length));
  const blocked = describeRequest(request, { workspace: task.cwd || '' });
  const options = ['只放开这一次'];
  const choices = ['task'];
  if (persistable) {
    options.push(`以后「${workspace.name}」都允许`);
    choices.push('workspace');
  }
  options.push('不放开');
  choices.push('deny');
  const question = `「${workerLabelOf(task.worker)}」有几项操作被权限拦下了（后台执行时没人能点「允许」）：${blocked.join('；')}。`;
  const approvalId = uid('a_');
  transaction(() => {
    db.prepare(`
      INSERT INTO approvals(id, task_id, question, options, status, kind, custom, meta, created_at)
      VALUES(?,?,?,?, 'pending', 'permission', 0, ?, ?)
    `).run(approvalId, task.id, question, JSON.stringify(options), JSON.stringify({
      request,
      choices,
      workspaceId: workspace?.id || null,
      summary: String(result.summary || '').slice(0, 4000),
      sessionId: result.sessionId || null,
      tokens: result.tokens || 0,
      cost: result.cost || 0
    }), now());
    setStatus(task.id, {
      status: 'waiting_approval',
      approval_id: approvalId,
      result: result.summary || '',
      progress: '有几项操作被拦下了，等你决定要不要放开',
      tokens: (task.tokens || 0) + (result.tokens || 0),
      cost: (task.cost || 0) + (result.cost || 0),
      resume_payload: resumePayload(task.id, result.sessionId ? { session_id: result.sessionId } : {})
    });
    event(task.id, 'task/waiting_approval', { approvalId, question, options, kind: 'permission' });
  });
  const approval = getApproval(approvalId);
  bus.emit('approval/created', { approval, task: getTask(task.id) });
  emitTask(getTask(task.id));
  // 不走 autoApprove：权限不能由习惯替主人放开。
  channels.notifyApproval(approval, getTask(task.id)).catch((err) => console.warn('[channel]', err.message));
  return approval;
}

async function execute(task) {
  const settings = getSettings();
  const limits = workerLimits(task.worker);
  const controller = new AbortController();
  const run = lifecycle.startRun(task);
  // 服务重启后带着断点恢复：只在这一次执行里传给 Worker，之后清掉标记。
  const recovery = task.resume_payload?.recovered || null;
  if (recovery) {
    const { recovered: _drop, ...rest } = task.resume_payload;
    db.prepare('UPDATE tasks SET resume_payload = ? WHERE id = ?').run(JSON.stringify(rest), task.id);
  }
  // 上一轮被权限拦下、主人放开后接着跑：这句提示只用一次（Worker 用它代替任务原文继续会话）。
  const permissionNote = task.resume_payload?.permission_note || null;
  if (permissionNote) {
    const { permission_note: _drop, ...rest } = task.resume_payload;
    db.prepare('UPDATE tasks SET resume_payload = ? WHERE id = ?').run(JSON.stringify(rest), task.id);
  }

  let lastProgress = '';
  const onProgress = (message, meta = {}) => {
    if (controller.signal.aborted || lastProgress === message) return;
    lastProgress = message;
    db.prepare('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?').run(message, now(), task.id);
    lifecycle.heartbeat([run.id]);
    bus.emit('task/progress', { taskId: task.id, message, meta });
  };
  const checkpoint = (data) => {
    // 已经取消 / 超时的执行不再写断点：不理会 signal 的 Worker 迟到的断点会污染重试后的新一轮。
    if (controller.signal.aborted) throw new Error('这次执行已经结束，断点不再保存');
    const merged = lifecycle.saveCheckpoint(run.id, data);
    const extra = { checkpoint: merged };
    if (typeof data.sessionId === 'string' && data.sessionId) extra.session_id = data.sessionId;
    db.prepare('UPDATE tasks SET resume_payload = ? WHERE id = ?').run(resumePayload(task.id, extra), task.id);
    return merged;
  };
  // 回传接口（/api/runs/:id/report）进来的上报统一走这里。
  const report = (body = {}) => {
    if (body.checkpoint !== undefined) checkpoint(body.checkpoint);
    if (typeof body.message === 'string' && body.message.trim()) {
      onProgress(body.message.trim().slice(0, 300), body.progress && typeof body.progress === 'object' ? body.progress : {});
    }
    lifecycle.heartbeat([run.id]);
  };

  running.set(task.id, { controller, startedAt: Date.now(), worker: task.worker, runId: run.id, report });
  ensureHeartbeat();
  const timer = setTimeout(() => controller.abort('timeout'), limits.timeoutMinutes * 60 * 1000);
  timer.unref?.();
  setStatus(task.id, {
    status: 'running',
    started_at: now(),
    progress: `已交给「${workerLabelOf(task.worker)}」，等待 Worker 回传进度…`,
    error: null
  });
  event(task.id, 'task/started', { worker: task.worker, attempt: task.attempts + 1, runId: run.id, ...(recovery ? { recovery: true } : {}) });
  emitTask(getTask(task.id));

  // 取消或超时时不再等 Worker：即使插件不理会 signal，也能立刻释放槽位，且不会回头覆盖状态。
  const aborted = new Promise((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
  });

  let outcome = 'failed';
  let outcomeError = null;
  try {
    const resume = task.resume_payload?.approval || null;
    const followup = task.resume_payload?.followup || null;
    // 任务在哪个工作区里跑、说到哪些项目/人/工具/文件：这些都算「触达点」，参与记忆召回。
    // 和对话用同一套装配：常驻 + 按需 + token 预算；Worker 拿到的 ctx.memories 就是这份。
    const recallRefs = matchEntities(`${task.title} ${task.prompt}`, { settings, cwd: task.cwd });
    const memoryBundle = buildMemoryContext({ query: `${task.title} ${task.prompt}`, refs: recallRefs, settings });
    // 只有 llm Worker 会把 ctx.memories 拼进提示词；记一份「这次注入了什么、为什么」方便复盘。
    if (task.worker === 'llm') {
      const payload = injectionPayload(memoryBundle, 'worker');
      if (payload) event(task.id, 'memory/injected', payload);
    }
    const work = Promise.resolve().then(() => runWorker(withFollowup(getTask(task.id)), {
      signal: controller.signal,
      resume,
      recovery,
      followup: followup ? { round: followup.round, text: followup.text } : null,
      // 权限放开后接着跑：让 Worker 用这句话代替任务原文，别从头重做。
      permissionNote,
      // Worker 只拿业务记忆；静静的人格记忆不进任务。
      memories: memoryBundle.items,
      tasks: listTasks({ limit: 10 }),
      onProgress,
      checkpoint,
      run: { id: run.id, token: run.token, reportUrl: reportUrl(run.id) }
    }));
    work.catch(() => {});
    const result = await Promise.race([work, aborted]);

    if (result === ABORTED || controller.signal.aborted) {
      outcome = abortOutcome(controller.signal.reason);
      finishAborted(task, limits, outcome);
      return;
    }

    if (result.status === 'needs_approval') {
      outcome = 'waiting_approval';
      const approvalId = uid('a_');
      const options = result.approval?.options || ['继续', '取消'];
      transaction(() => {
        db.prepare(`
          INSERT INTO approvals(id, task_id, question, options, status, kind, custom, created_at)
          VALUES(?,?,?,?, 'pending', 'worker', ?, ?)
        `).run(approvalId, task.id, result.approval?.question || '要继续吗？', JSON.stringify(options), result.approval?.custom === true ? 1 : 0, now());
        setStatus(task.id, {
          status: 'waiting_approval',
          approval_id: approvalId,
          result: result.summary || '',
          progress: '等你拍板',
          tokens: task.tokens + (result.tokens || 0),
          cost: (task.cost || 0) + (result.cost || 0),
          resume_payload: resumePayload(task.id, result.sessionId ? { session_id: result.sessionId } : {})
        });
        event(task.id, 'task/waiting_approval', { approvalId, question: result.approval?.question, options });
      });
      const approval = getApproval(approvalId);
      bus.emit('approval/created', { approval, task: getTask(task.id) });
      emitTask(getTask(task.id));
      if (!autoApprove(getTask(task.id), approvalId)) {
        channels.notifyApproval(approval, getTask(task.id)).catch((err) => console.warn('[channel]', err.message));
      }
      return;
    }

    if (result.status === 'cancelled') {
      outcome = 'cancelled';
      finalize(task.id, 'cancelled', {
        result: result.summary || '已取消',
        tokens: task.tokens + (result.tokens || 0)
      }, { data: { summary: result.summary } });
      return;
    }

    if (result.status === 'failed') {
      outcomeError = result.summary;
      const attempts = (task.attempts || 0) + 1;
      const usage = {
        tokens: task.tokens + (result.tokens || 0),
        cost: (task.cost || 0) + (result.cost || 0)
      };
      // 只有 Worker 声明了重试次数、且没有标记 retryable: false 时才自动重试。
      if (result.retryable !== false && attempts <= limits.retries) {
        setStatus(task.id, {
          status: 'queued',
          attempts,
          error: result.summary,
          progress: '准备重试…',
          started_at: null,
          ...usage
        });
        event(task.id, 'task/retry', { attempt: attempts, error: result.summary });
        emitTask(getTask(task.id));
      } else {
        finalize(task.id, 'failed', {
          attempts,
          error: result.summary,
          result: result.summary,
          ...usage
        }, { data: { error: result.summary } });
      }
      return;
    }

    // done：有操作被权限拦下时先问主人要不要放开；放开后接着这次的会话继续，不当成做完。
    const permissionRequest = permissionRequestFor(task, result, settings);
    if (permissionRequest) {
      outcome = 'waiting_approval';
      askPermission(task, result, permissionRequest, settings);
      return;
    }
    outcome = 'done';
    const summary = result.summary || '完成';
    // Worker 给了结论（比如 proposed：方案等你确认）就记下；没给就留空，由列表从结果推断。
    const declared = result.outcome || null;
    if (declared) event(task.id, 'task/outcome', { from: task.outcome || null, to: declared, by: 'worker' });
    finalize(task.id, 'done', {
      result: summary,
      error: null,
      outcome: declared,
      recoveries: 0,
      tokens: task.tokens + (result.tokens || 0),
      cost: (task.cost || 0) + (result.cost || 0),
      resume_payload: resumePayload(task.id, result.sessionId ? { session_id: result.sessionId } : {})
    }, { data: { summary: summary.slice(0, 2000), tokens: result.tokens || 0 } });

    if (settings.autoRemember && summary && summary.length > 20 && task.origin !== 'seed') {
      // 这条结果记在当前任务的工作区下：以后在同一个项目里干活能把它捞出来。
      const wsRefs = matchEntities('', { settings, cwd: task.cwd }).filter((ref) => ref.kind === 'workspace');
      memory.write({
        text: `任务「${task.title}」的结果：${summary.slice(0, 400)}`,
        layer: 'episodic',
        kind: 'task_result',
        tags: [task.worker],
        importance: 0.4,
        source: 'scheduler',
        refs: wsRefs
      });
    }
  } catch (err) {
    outcomeError = err.message;
    if (controller.signal.aborted) {
      outcome = abortOutcome(controller.signal.reason);
      finishAborted(task, limits, outcome);
    } else if (getTask(task.id)?.status === 'running') {
      finalize(task.id, 'failed', {
        error: err.message,
        result: `执行出错：${err.message}`
      }, { data: { error: err.message } });
    }
  } finally {
    clearTimeout(timer);
    lifecycle.finishRun(run.id, outcome, outcome === 'interrupted' ? SHUTDOWN_NOTE : outcomeError);
    running.delete(task.id);
    pump();
    bus.emit('stats/updated', stats());
  }
}

function pump() {
  if (pumping || stopping) return;
  const settings = getSettings();
  if (settings.queuePaused) return;
  pumping = true;
  try {
    const limit = Math.max(1, Math.min(4, settings.concurrency || 2));
    if (running.size >= limit) return;
    const perWorker = new Map();
    for (const item of running.values()) perWorker.set(item.worker, (perWorker.get(item.worker) || 0) + 1);
    const queued = db.prepare(
      "SELECT * FROM tasks WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT 200"
    ).all();
    for (const row of queued) {
      if (running.size >= limit) break;
      // 某个 Worker 满了就跳过它的任务，让后面别的 Worker 的任务先跑。
      if ((perWorker.get(row.worker) || 0) >= workerLimits(row.worker).concurrency) continue;
      // 原子占位，避免重复调度
      const changed = db.prepare(
        "UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'"
      ).run(now(), row.id).changes;
      if (!changed) continue;
      perWorker.set(row.worker, (perWorker.get(row.worker) || 0) + 1);
      execute(rowTask(row));
    }
  } finally {
    pumping = false;
  }
}

/**
 * 接收 Worker 通过回传接口上报的进度 / 断点 / 心跳。
 * 返回 { ok } ；这次执行已结束（比如被取消）时返回 { ok: false, stop: true }，告诉对方停下。
 */
export function reportRun(runId, token, body = {}) {
  const check = lifecycle.verifyRun(runId, token);
  if (!check.ok) return { ok: false, code: check.code, error: check.error, stop: check.code === 409 };
  const live = running.get(check.run.task_id);
  if (!live || live.runId !== runId || live.controller.signal.aborted) {
    return { ok: false, code: 409, error: '这次执行已经结束', stop: true };
  }
  try {
    live.report(body);
  } catch (err) {
    return { ok: false, code: 400, error: err.message };
  }
  return { ok: true };
}

export const MAX_ANSWER = 500;

/**
 * 用户拍板。choice 是选项下标（< 0 表示取消）；answer 是用户不选选项、自己写的决定。
 * 自己写的决定只在 Worker 允许时接受（approval.custom）；传给 Worker 时追加在 options 末尾、choice 指向它，
 * 只认 options[choice] 的 Worker 不用改也能拿到这句话，认识 answer 的 Worker 可以单独措辞。
 */
export function approve(approvalId, choice, { by = 'user', answer = '' } = {}) {
  const approval = getApproval(approvalId);
  if (!approval) {
    const err = new Error('这条审批已经失效了（页面可能不是最新的），刷新一下就能看到最新状态');
    err.statusCode = 409;
    throw err;
  }
  if (approval.status !== 'pending') {
    const err = new Error('这条审批已经处理过了，刷新一下看看结果');
    err.statusCode = 409;
    throw err;
  }
  const task = getTask(approval.task_id);
  if (!task) throw new Error('任务不存在');

  const custom = String(answer ?? '').trim();
  if (custom && !approval.custom) {
    throw Object.assign(new Error('这个问题只能从给出的选项里选'), { statusCode: 400 });
  }
  if (custom.length > MAX_ANSWER) {
    throw Object.assign(new Error(`决定写得太长了（最多 ${MAX_ANSWER} 字）`), { statusCode: 400 });
  }
  const index = custom ? approval.options.length : Number(choice);
  if (!custom && (!Number.isInteger(index) || index >= approval.options.length)) {
    throw Object.assign(new Error('没有这个选项'), { statusCode: 400 });
  }
  const resolved = index >= 0 ? 'approved' : 'rejected';
  const resolveRow = () => db.prepare('UPDATE approvals SET status = ?, choice = ?, answer = ?, resolved_at = ? WHERE id = ?')
    .run(resolved, index, custom || null, now(), approvalId);
  const done = (updated) => {
    bus.emit('approval/resolved', { approval: getApproval(approvalId), task: updated });
    if (!['done', 'failed', 'cancelled'].includes(updated.status)) emitTask(updated);
    pump();
    return { approval: getApproval(approvalId), task: updated };
  };

  // 服务重启后问的「重新执行 / 放弃」：不是 Worker 的问题，选择不能当成 Worker 的拍板结果传下去。
  if (approval.kind === 'recovery') {
    const resolvedEvent = { approvalId, choice: index, option: approval.options[index] ?? null, by, kind: 'recovery' };
    if (index === 0) {
      transaction(() => {
        resolveRow();
        setStatus(task.id, { status: 'queued', approval_id: null, progress: '按你的选择重新执行…', started_at: null });
        event(task.id, 'approval/resolved', resolvedEvent);
      });
      return done(getTask(task.id));
    }
    transaction(() => {
      resolveRow();
      event(task.id, 'approval/resolved', resolvedEvent);
    });
    return done(finalize(task.id, 'cancelled', { approval_id: null, result: '服务重启后你选择了放弃' }, { data: { reason: 'recovery declined' } }));
  }

  // 宿主替你问的「交给谁」：选的是 Worker，不是给 Worker 的答复，所以不传给 Worker、也不算拍板次数。
  if (approval.kind === 'routing') {
    const pick = index >= 0 ? approval.meta?.choices?.[index] : { cancel: true };
    const resolvedEvent = { approvalId, choice: index, option: approval.options[index] ?? null, by, kind: 'routing' };
    if (!pick || pick.cancel) {
      transaction(() => {
        resolveRow();
        event(task.id, 'approval/resolved', resolvedEvent);
      });
      return done(finalize(task.id, 'cancelled', { approval_id: null, result: '你选择了不处理' }, { data: { reason: 'routing declined' } }));
    }
    if (!isWorker(pick.worker)) {
      throw Object.assign(new Error(`「${workerLabelOf(pick.worker)}」已经不在了，换一个选项`), { statusCode: 409 });
    }
    let rule = null;
    transaction(() => {
      resolveRow();
      if (pick.rule) rule = ensureWorkerRule({ ...pick.rule, worker: pick.worker });
      setStatus(task.id, {
        status: 'queued',
        worker: pick.worker,
        approval_id: null,
        progress: `按你的选择交给「${workerLabelOf(pick.worker)}」，准备开始…`
      });
      if (pick.worker !== task.worker) {
        event(task.id, 'task/edited', { fields: ['worker'], from: { worker: task.worker }, to: { worker: pick.worker }, by: 'routing' });
      }
      event(task.id, 'approval/resolved', { ...resolvedEvent, ...(rule ? { rule: { id: rule.id, name: rule.name } } : {}) });
    });
    if (rule) bus.emit('worker-rules/updated', { rules: listWorkerRules() });
    return done(getTask(task.id));
  }

  // 被权限拦下的操作：把主人放开的范围记到任务（或工作区）上，再带着这个会话重跑一轮。
  if (approval.kind === 'permission') {
    const meta = approval.meta || {};
    const request = meta.request && typeof meta.request === 'object' ? meta.request : null;
    const action = meta.choices?.[index] || 'deny';
    const resolvedEvent = { approvalId, choice: index, option: approval.options[index] ?? null, by, kind: 'permission' };
    if (!request || action === 'deny') {
      const blocked = request ? describeRequest(request, { workspace: task.cwd || '' }) : [];
      const note = blocked.length ? `（没有放开的操作：\n${blocked.map((line) => `- ${line}`).join('\n')}）` : '';
      const text = [String(task.result || meta.summary || '').trim(), note].filter(Boolean).join('\n\n');
      transaction(() => {
        resolveRow();
        event(task.id, 'approval/resolved', resolvedEvent);
      });
      // 主人选择不放开：这轮就停在这里，和「选了不处理」一样算停止，不算完成。
      return done(finalize(task.id, 'cancelled', { approval_id: null, result: text }, { data: { summary: text.slice(0, 2000), permission: 'denied' } }));
    }
    const nextHops = (task.hops || 0) + 1;
    const limit = getSettings().maxHops || 6;
    if (nextHops > limit) {
      const message = `已经来回放开权限 ${nextHops - 1} 次还没做完，为避免无限循环已停止。可以把要求说得更具体后手动重试。`;
      transaction(() => {
        resolveRow();
        event(task.id, 'approval/resolved', resolvedEvent);
      });
      return done(finalize(task.id, 'failed', { approval_id: null, error: message, result: message }, { data: { error: '权限放开次数超过上限', hops: nextHops } }));
    }
    // 「以后都允许」把改文件和命令规则记在工作区上；工作区外的目录换了任务未必还要，记在当前任务上。
    const toWorkspace = action === 'workspace' && Boolean(meta.workspaceId);
    if (toWorkspace) {
      const settings = getSettings();
      const workspaces = (settings.workspaces || []).map((ws) => (ws.id === meta.workspaceId
        ? { ...ws, permission: mergeWorkspacePermission(ws.permission, request) }
        : ws));
      saveSettings({ workspaces });
      bus.emit('settings/updated', { settings: maskSettings(getSettings()) });
    }
    const options = parseOptions(task.options);
    const grant = mergeGrant(options.permissions?.grant, toWorkspace ? { ...request, rules: [] } : request);
    const blocked = describeRequest(request, { workspace: task.cwd || '' });
    const note = blocked.length
      ? `已经放开了刚才被拦下的操作（${blocked.join('；')}）。请接着原来的任务继续，已经做完的部分不要重做。`
      : '被拦下的操作已经放开了，请接着原来的任务继续，已经做完的部分不要重做。';
    transaction(() => {
      resolveRow();
      setStatus(task.id, {
        status: 'queued',
        hops: nextHops,
        approval_id: null,
        progress: '权限放开了，接着这次的会话继续…',
        options: JSON.stringify({ ...options, permissions: { ...(options.permissions || {}), grant } }),
        resume_payload: JSON.stringify({ ...(task.resume_payload || {}), permission_note: note })
      });
      event(task.id, 'approval/resolved', resolvedEvent);
      event(task.id, 'task/permission-granted', {
        edit: Boolean(grant.edit),
        rules: request.rules,
        dirs: request.dirs,
        scope: toWorkspace ? 'workspace' : 'task'
      });
    });
    return done(getTask(task.id));
  }

  const settings = getSettings();
  const hops = (task.hops || 0) + 1;
  if (hops > (settings.maxHops || 6)) {
    const message = `已经来回拍板 ${hops - 1} 次还没做完，为避免无限追问已停止。可以把要求说得更具体后手动重试。`;
    transaction(() => {
      resolveRow();
      event(task.id, 'approval/resolved', { approvalId, choice: index, option: custom || (approval.options[index] ?? null), by });
    });
    return done(finalize(task.id, 'failed', { approval_id: null, error: message, result: message }, { data: { error: '恢复次数超过上限', hops } }));
  }

  // 自己写的决定里点名了另一个可用的 Worker（比如「用 claude 通过 tapd 查」）：改派给它接着做。
  // 主人自己的回复认口语别名（「改用 deepseek 去做」→ DeepSeek Harness）；Worker 给的选项只认明确换人的说法。
  const catalog = workerCatalog();
  const named = custom
    ? namedWorker(custom, catalog, { aliases: true })
    : handoffWorker(approval.options[index], catalog);
  const handoff = named && named.id !== task.worker ? named : null;
  const payload = { ...(getTask(task.id)?.resume_payload || {}) };
  if (handoff) {
    // 会话和断点属于原来的 Worker，换人后从头开始，带上原任务和你的决定。
    delete payload.session_id;
    delete payload.checkpoint;
  }
  transaction(() => {
    resolveRow();
    setStatus(task.id, {
      status: 'queued',
      hops,
      ...(handoff ? { worker: handoff.id } : {}),
      progress: handoff
        ? `按你的决定改派给「${handoff.label || handoff.id}」，准备继续…`
        : by === 'habit' ? '按习惯自动拍板，准备继续…' : '收到你的选择，准备继续…',
      approval_id: null,
      resume_payload: JSON.stringify({
        ...payload,
        approval: {
          question: approval.question,
          options: custom ? [...approval.options, custom] : approval.options,
          choice: index,
          ...(custom ? { answer: custom } : {})
        }
      })
    });
    if (handoff) {
      event(task.id, 'task/edited', { fields: ['worker'], from: { worker: task.worker }, to: { worker: handoff.id }, by: 'approval' });
    }
    event(task.id, 'approval/resolved', {
      approvalId,
      choice: index,
      option: custom || (approval.options[index] ?? null),
      by,
      ...(custom ? { custom: true } : {})
    });
  });
  return done(getTask(task.id));
}

export const TASK_OUTCOMES = OUTCOMES;

export function updateTask(taskId, patch = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'running') throw new Error('任务正在执行，先停止再修改');
  const fields = {};
  if (patch.title !== undefined) fields.title = String(patch.title).slice(0, 120);
  if (patch.prompt !== undefined) fields.prompt = String(patch.prompt);
  if (patch.worker !== undefined) {
    if (!isWorker(patch.worker)) throw new Error('未知的 Worker');
    fields.worker = patch.worker;
  }
  if (patch.priority !== undefined) fields.priority = Math.min(5, Math.max(1, Number(patch.priority) || 2));
  if (patch.cwd !== undefined) fields.cwd = String(patch.cwd);
  if (patch.outcome !== undefined) {
    const value = patch.outcome === null || patch.outcome === '' ? null : String(patch.outcome);
    if (value && !TASK_OUTCOMES.includes(value)) throw Object.assign(new Error('不认识的结论'), { statusCode: 400 });
    if (!['done', 'failed', 'cancelled'].includes(task.status)) {
      throw Object.assign(new Error('任务还没结束，等这轮跑完再标记结论'), { statusCode: 409 });
    }
    fields.outcome = value;
  }
  if (!Object.keys(fields).length) return task;
  db.prepare(`UPDATE tasks SET ${Object.keys(fields).map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...Object.values(fields), now(), taskId);
  if (fields.outcome !== undefined) event(taskId, 'task/outcome', { from: task.outcome || null, to: fields.outcome });
  event(taskId, 'task/edited', {
    fields: Object.keys(fields),
    ...(fields.worker && fields.worker !== task.worker ? { from: { worker: task.worker }, to: { worker: fields.worker } } : {})
  });
  const updated = getTask(taskId);
  emitTask(updated);
  return updated;
}

export function retryTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'running') throw new Error('任务正在执行，先停止再重试');
  transaction(() => {
    if (task.approval_id) {
      db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(now(), task.approval_id);
    }
    setStatus(taskId, {
      status: 'queued',
      attempts: 0,
      hops: 0,
      recoveries: 0,
      approval_id: null,
      error: null,
      result: null,
      outcome: null,
      progress: '重新排队…',
      started_at: null,
      finished_at: null,
      // 会话和断点从头来；但「接着做」的这一轮要求要留着，重试的是最近这一轮。
      resume_payload: JSON.stringify(task.resume_payload?.followup ? { followup: task.resume_payload.followup } : {})
    });
    event(taskId, 'task/retried', { by: 'user' });
  });
  const updated = getTask(taskId);
  emitTask(updated);
  pump();
  return updated;
}

/* ----------------------------- 只跟踪 ----------------------------- */

const notFound = () => Object.assign(new Error('任务不存在'), { statusCode: 404 });

/**
 * 转为只跟踪：留在列表里、来源状态照常同步，但调度器不会执行它。
 * 正在执行的不行（先停止）；等拍板的会作废那条审批。
 */
export function holdTask(taskId, { by = 'user' } = {}) {
  const task = getTask(taskId);
  if (!task) throw notFound();
  if (task.status === 'held') return task;
  if (task.status === 'running') {
    throw Object.assign(new Error('任务正在执行，先停止再转为只跟踪'), { statusCode: 409 });
  }
  transaction(() => {
    if (task.approval_id) {
      db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(now(), task.approval_id);
    }
    setStatus(taskId, { status: 'held', approval_id: null, progress: null });
    event(taskId, 'task/held', { from: task.status, by });
  });
  const updated = getTask(taskId);
  if (task.approval_id) bus.emit('approval/resolved', { approval: getApproval(task.approval_id), task: updated });
  emitTask(updated);
  bus.emit('stats/updated', stats());
  return updated;
}

/** 把所有排队中的任务一次转为只跟踪：开调度之前先把不想跑的拦下来。返回转了几个。 */
export function holdQueued({ by = 'user' } = {}) {
  const ids = db.prepare("SELECT id FROM tasks WHERE status = 'queued'").all().map((row) => row.id);
  const held = [];
  transaction(() => {
    for (const id of ids) {
      // 逐个再确认一次：pump 可能刚好占走了某一个。
      const changed = db.prepare("UPDATE tasks SET status = 'held', progress = NULL, updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(now(), id).changes;
      if (!changed) continue;
      event(id, 'task/held', { from: 'queued', by, bulk: true });
      held.push(id);
    }
  });
  for (const id of held) emitTask(getTask(id));
  if (held.length) bus.emit('stats/updated', stats());
  return held.length;
}

/** 只跟踪的任务交给 Worker 去做：回到排队，结果、会话这些都留着。 */
export function releaseTask(taskId, { by = 'user' } = {}) {
  const task = getTask(taskId);
  if (!task) throw notFound();
  if (task.status !== 'held') {
    throw Object.assign(new Error('这个任务不是只跟踪状态'), { statusCode: 409 });
  }
  transaction(() => {
    setStatus(taskId, {
      status: 'queued',
      attempts: 0,
      hops: 0,
      recoveries: 0,
      error: null,
      progress: '开始执行，排队中…',
      started_at: null,
      finished_at: null
    });
    event(taskId, 'task/released', { by });
  });
  const updated = getTask(taskId);
  emitTask(updated);
  pump();
  bus.emit('stats/updated', stats());
  return updated;
}

/* ----------------------------- 接着做 / 另起一张 ----------------------------- */

export const MAX_FOLLOWUP = 4000;
const TRANSCRIPT_KEEP = 4;
const TURN_CHARS = 3000;
const TERMINAL = ['done', 'failed', 'cancelled'];

function clip(text, max) {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max)}…（后面省略）` : value;
}

function followupText(text) {
  const value = String(text ?? '').trim();
  if (!value) throw Object.assign(new Error('先写下要接着做什么'), { statusCode: 400 });
  if (value.length > MAX_FOLLOWUP) {
    throw Object.assign(new Error(`写得太长了（最多 ${MAX_FOLLOWUP} 字）`), { statusCode: 400 });
  }
  return value;
}

/**
 * 交给 Worker 的任务：有「接着做」时把指令换成「原指令 + 前几轮 + 这次的话」。
 * 不认识 ctx.followup 的 Worker 不用改也能接上；能续会话的 Worker（Claude Code）可以只发这次的话。
 */
export function withFollowup(task) {
  const f = task?.resume_payload?.followup;
  if (!f?.text) return task;
  const parts = [task.prompt];
  for (const turn of f.transcript || []) {
    const head = turn.ask ? `--- 第 ${turn.round} 轮：主人追问「${turn.ask}」---` : `--- 第 ${turn.round} 轮 ---`;
    const label = turn.status === 'failed' ? '出错' : turn.status === 'cancelled' ? '中途停了' : '结果';
    parts.push(`${head}\n${label}：\n${turn.result || '（没有结果）'}`);
  }
  parts.push(`--- 第 ${f.round} 轮：主人现在接着说 ---\n${f.text}\n\n请在前面的基础上继续，已经做完的部分不要从头重做。`);
  return { ...task, prompt: parts.join('\n\n') };
}

/** 在同一张卡上接着做：保留 Worker 的会话，把这次的话作为新一轮交给它。 */
export function continueTask(taskId, text, { by = 'user' } = {}) {
  const task = getTask(taskId);
  if (!task) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
  if (!TERMINAL.includes(task.status)) {
    const why = task.status === 'waiting_approval' ? '它在等你拍板，直接回答它的问题就行'
      : task.status === 'held' ? '它是只跟踪的，先点「开始执行」' : '它还在做，等它停下再接着说';
    throw Object.assign(new Error(why), { statusCode: 409 });
  }
  const ask = followupText(text);
  const payload = task.resume_payload || {};
  const prev = payload.followup || null;
  const round = (prev?.round || 1) + 1;
  const transcript = [
    ...(prev?.transcript || []),
    { round: round - 1, ask: prev?.text || null, status: task.status, result: clip(task.result || task.error, TURN_CHARS) }
  ].slice(-TRANSCRIPT_KEEP);
  const { approval: _a, checkpoint: _c, recovered: _r, permission_note: _p, ...rest } = payload;
  transaction(() => {
    if (task.approval_id) {
      db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(now(), task.approval_id);
    }
    setStatus(taskId, {
      status: 'queued',
      attempts: 0,
      hops: 0,
      recoveries: 0,
      approval_id: null,
      error: null,
      outcome: null,
      progress: '收到，接着做…',
      started_at: null,
      finished_at: null,
      resume_payload: JSON.stringify({ ...rest, followup: { round, text: ask, transcript, at: now() } })
    });
    event(taskId, 'task/followup', { text: ask, round, by, from: task.status });
  });
  const updated = getTask(taskId);
  emitTask(updated);
  pump();
  return updated;
}

/** 另起一张接着做的卡：带上上一张的指令和结果，默认同一个 Worker、同一个工作目录。 */
export function spawnFollowup(parentId, text, { worker = null, cwd = null, title = '', by = 'user' } = {}) {
  const parent = getTask(parentId);
  if (!parent) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
  const ask = followupText(text);
  const chosen = worker || (isWorker(parent.worker) ? parent.worker : null);
  const prompt = [
    `接着之前的任务「${parent.title}」做。`,
    `原来的指令：\n${clip(parent.prompt, TURN_CHARS)}`,
    parent.result || parent.error
      ? `${parent.status === 'failed' ? '上一张卡出错了' : '上一张卡的结果'}：\n${clip(parent.result || parent.error, TURN_CHARS)}`
      : '',
    `这次要做的：\n${ask}`
  ].filter(Boolean).join('\n\n');
  const firstLine = ask.split('\n').find((line) => line.trim()) || ask;
  const task = createTask({
    title: String(title || '').trim() || firstLine.slice(0, 30),
    prompt,
    worker: chosen,
    cwd: cwd ?? parent.cwd,
    origin: parent.origin,
    sessionId: parent.session_id,
    priority: parent.priority || 2,
    replyTo: parent.reply_to || null,
    parentId: parent.id,
    linkKind: 'followup',
    // 后续卡继承上一张绑定的外部对象：修复卡 → 验证卡都挂在同一个外部单子下。
    sourceLinksList: (parent.sources || []).map((link) => ({
      provider: link.provider,
      providerLabel: link.providerLabel,
      externalId: link.externalId,
      externalType: link.externalType,
      title: link.title,
      url: link.url,
      status: link.status,
      tracking: link.tracking,
      nodeKey: link.nodeKey || null
    }))
  });
  event(parent.id, 'task/spawned', { taskId: task.id, title: task.title, by });
  emitTask(getTask(parent.id));
  return task;
}

/** 卡与卡的流转：上一张（parent）和从它另起的后续卡（children）。 */
export function taskLinks(taskId) {
  const task = getTask(taskId);
  if (!task) return { parent: null, children: [] };
  const brief = (row) => (row ? { id: row.id, title: row.title, status: row.status, link_kind: row.link_kind || null, created_at: row.created_at } : null);
  const parent = task.parent_id
    ? brief(db.prepare('SELECT id, title, status, link_kind, created_at FROM tasks WHERE id = ?').get(task.parent_id)) || { id: task.parent_id, title: null, status: 'deleted' }
    : null;
  const children = db.prepare('SELECT id, title, status, link_kind, created_at FROM tasks WHERE parent_id = ? ORDER BY created_at ASC').all(taskId).map(brief);
  return { parent, children };
}

export function deleteTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'running') throw new Error('任务正在执行，先停止再删除');
  transaction(() => {
    db.prepare('DELETE FROM approvals WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(taskId);
    // 绑定跟着任务走；source_items 是去重账本，留着，免得同一条外部单子又建一张卡。
    sourceLinks.deleteForTask(taskId);
    // 归属和卡级抑制是 task 级意图，跟着卡删；分类项本身留着（可能转 dormant）。
    classification.forgetTask(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
  bus.emit('task/deleted', { id: taskId, task });
  bus.emit('stats/updated', stats());
  return { ok: true };
}

export function cancel(taskId, reason = '用户取消') {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (['done', 'failed', 'cancelled'].includes(task.status)) return task;

  const live = running.get(taskId);
  if (task.approval_id) {
    db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(now(), task.approval_id);
  }
  const updated = finalize(taskId, 'cancelled', { result: reason }, { data: { reason } });
  if (task.approval_id) bus.emit('approval/resolved', { approval: getApproval(task.approval_id), task: updated });
  // 先把状态写成 cancelled 再中止：执行那边收尾时看到的已经是终态，不会再覆盖。
  if (live) live.controller.abort('cancelled');
  return updated;
}

/**
 * 服务退出前调用：中止所有正在执行的任务并结束它们的子进程（整组），最多等 graceMs。
 * 任务状态保持 running、运行记录记为 interrupted，下次启动由 recover() 按 Worker 声明的恢复方式接着做；
 * 正常退出打断的不算进「连续被重启打断」的次数。
 */
export async function shutdown({ graceMs = 1500 } = {}) {
  stopping = true;
  for (const item of running.values()) item.controller.abort(SHUTDOWN);
  await terminateChildren(graceMs);
  // 让每个执行的收尾（运行记录记为 interrupted）先跑完。
  await new Promise((resolve) => setImmediate(resolve));
}

function ranFor(iso) {
  const seconds = Math.max(0, Math.round((iso ? Date.now() - new Date(iso).getTime() : 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/**
 * 服务重启后还原被打断的任务。按 Worker 声明的恢复方式处理：
 * - resume：有断点就带着断点重新入队，Worker 从断点继续；没有断点按 ask 处理；
 * - restart：直接重新入队；
 * - ask：挂起，问用户「重新执行 / 放弃」。
 * 每个任务连续被打断超过 MAX_RECOVERIES 次就标记失败；服务正常退出（shutdown()）打断的不计数，
 * 只有崩溃、被强制结束这类没来得及收尾的才算，用来防止「崩溃 → 重启 → 再执行 → 再崩溃」。
 */
export function recover() {
  const stuck = db.prepare("SELECT * FROM tasks WHERE status = 'running'").all().map(rowTask);
  for (const task of stuck) {
    const run = task.run_id ? lifecycle.getRun(task.run_id) : null;
    const graceful = run?.status === 'interrupted';
    if (run) lifecycle.finishRun(run.id, 'interrupted', '服务重启时中断');
    const recoveries = (task.recoveries || 0) + (graceful ? 0 : 1);
    const policy = isWorker(task.worker) ? workerRecovery(task.worker) : 'ask';
    const checkpoint = run?.checkpoint || task.resume_payload?.checkpoint || null;
    const ran = ranFor(run?.started_at || task.started_at);

    if (recoveries > MAX_RECOVERIES) {
      const message = `服务连续 ${recoveries} 次重启都打断了这个任务，为避免反复执行已停止。确认没问题后可以手动重试。`;
      finalize(task.id, 'failed', { recoveries, error: message, result: message }, { data: { error: message, recovery: true } });
      continue;
    }

    if ((policy === 'resume' && checkpoint) || policy === 'restart') {
      const mode = policy === 'restart' ? 'restart' : 'resume';
      setStatus(task.id, {
        status: 'queued',
        recoveries,
        started_at: null,
        progress: mode === 'resume' ? '服务重启，准备从断点继续…' : '服务重启，重新执行…',
        resume_payload: mode === 'resume'
          ? resumePayload(task.id, {
            recovered: { at: now(), runId: run?.id || null, checkpoint },
            ...(typeof checkpoint?.sessionId === 'string' && checkpoint.sessionId ? { session_id: checkpoint.sessionId } : {})
          })
          : JSON.stringify(task.resume_payload || {})
      });
      event(task.id, 'task/recovered', { reason: 'server restart', mode, runId: run?.id || null });
      continue;
    }

    const approvalId = uid('a_');
    const options = ['重新执行', '放弃'];
    const question = `服务重启时「${task.title}」正在由「${workerLabelOf(task.worker)}」执行（已运行约 ${ran}），可能已经做了一部分。要怎么处理？`;
    transaction(() => {
      db.prepare(`
        INSERT INTO approvals(id, task_id, question, options, status, kind, created_at)
        VALUES(?,?,?,?, 'pending', 'recovery', ?)
      `).run(approvalId, task.id, question, JSON.stringify(options), now());
      setStatus(task.id, { status: 'waiting_approval', recoveries, approval_id: approvalId, progress: '服务重启，等你决定是否重跑' });
      event(task.id, 'task/recovered', { reason: 'server restart', mode: 'ask', runId: run?.id || null });
      event(task.id, 'task/waiting_approval', { approvalId, question, options });
    });
    const approval = getApproval(approvalId);
    bus.emit('approval/created', { approval, task: getTask(task.id) });
    channels.notifyApproval(approval, getTask(task.id)).catch(() => {});
  }
  if (stuck.length) console.log(`[scheduler] 已还原 ${stuck.length} 个被重启打断的任务`);
  return stuck.length;
}

export function init() {
  recover();
  pump();
  bus.emit('stats/updated', stats());
}

export function kick() {
  pump();
}

export { availability };

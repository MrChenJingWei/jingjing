import { db, now, uid, getSettings, rowTask, rowApproval, event, transaction } from './db.js';
import { bus } from './events.js';
import * as memory from './memory.js';
import * as lifecycle from './lifecycle.js';
import * as workflows from './workflows.js';
import { runWorker, availability, isWorker, workerLimits, workerRecovery, workerLabelOf, defaultWorker, reportUrl, workerCatalog, terminateChildren } from './workers.js';
import { namedWorker, handoffWorker } from './worker-routing.js';
import { ensureWorkerRule, listWorkerRules } from './worker-rules.js';
import * as channels from './channels.js';

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
  return rowTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

export function listTasks({ limit = 60, status, q = '' } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
    : db.prepare(`
        SELECT * FROM tasks
        ORDER BY CASE status
          WHEN 'waiting_approval' THEN 0
          WHEN 'running' THEN 1
          WHEN 'queued' THEN 2
          WHEN 'failed' THEN 3
          WHEN 'done' THEN 4
          ELSE 5 END, created_at DESC
        LIMIT ?
      `).all(limit);
  const needle = String(q || '').trim().toLowerCase();
  const filtered = needle
    ? rows.filter((row) => `${row.title} ${row.prompt}`.toLowerCase().includes(needle))
    : rows;
  return filtered.map(rowTask);
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
  hold = null
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
  transaction(() => {
    db.prepare(`
      INSERT INTO tasks(id, title, prompt, worker, cwd, status, priority, origin, rule_id, session_id, group_key, hops, workflow_id, options, reply_to, approval_id, progress, recoveries, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
    `).run(
      id, cleanTitle, String(prompt || cleanTitle), chosen,
      cwd || settings.defaultCwd || '', hold ? 'waiting_approval' : 'queued', priority, origin, ruleId, sessionId,
      groupKey || null, Math.max(0, Number(hops) || 0), workflowId || null,
      options ? JSON.stringify(options) : null, replyTo ? JSON.stringify(replyTo) : null,
      approvalId, hold ? hold.progress || '等你决定交给谁' : null, stamp, stamp
    );
    event(id, 'task/created', { worker: chosen, origin, title: cleanTitle, source, ...(workflowId ? { workflowId, workflow: workflowName } : {}) });
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
  } else {
    pump();
  }
  return task;
}

export function findMergeableTask({ groupKey, worker, cwd }) {
  if (!groupKey) return null;
  const row = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'queued' AND group_key = ? AND worker = ? AND COALESCE(cwd, '') = COALESCE(?, '')
    ORDER BY created_at ASC LIMIT 1
  `).get(groupKey, worker, cwd || '');
  return row ? rowTask(row) : null;
}

export function mergeTask(taskId, { text = '', title = '', source = '', replyTo = null } = {}) {
  const task = getTask(taskId);
  if (!task || task.status !== 'queued') return null;
  const addition = `\n\n--- 合并的新事件${title ? `：${title}` : ''} ---\n${String(text || '').slice(0, 3000)}`;
  if (task.prompt.length < 30000) {
    db.prepare('UPDATE tasks SET prompt = ?, updated_at = ? WHERE id = ?')
      .run(task.prompt + addition, now(), taskId);
  }
  // 合并进来的新消息更晚：结果发回最近一条消息所在的会话。
  if (replyTo) db.prepare('UPDATE tasks SET reply_to = ? WHERE id = ?').run(JSON.stringify(replyTo), taskId);
  event(taskId, 'task/merged', { title, source });
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
    const work = Promise.resolve().then(() => runWorker(getTask(task.id), {
      signal: controller.signal,
      resume,
      recovery,
      memories: memory.context(`${task.title} ${task.prompt}`, { limit: 6 }),
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

    // done
    outcome = 'done';
    const summary = result.summary || '完成';
    finalize(task.id, 'done', {
      result: summary,
      error: null,
      recoveries: 0,
      tokens: task.tokens + (result.tokens || 0),
      cost: (task.cost || 0) + (result.cost || 0),
      resume_payload: resumePayload(task.id, result.sessionId ? { session_id: result.sessionId } : {})
    }, { data: { summary: summary.slice(0, 2000), tokens: result.tokens || 0 } });

    if (settings.autoRemember && summary && summary.length > 20 && task.origin !== 'seed') {
      memory.remember({
        text: `任务「${task.title}」的结果：${summary.slice(0, 400)}`,
        layer: 'episodic',
        kind: 'task_result',
        tags: [task.worker],
        importance: 0.4,
        source: 'scheduler'
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
  // Worker 给的选项只认明确换人的说法（「改用 Claude Code 去查」）；「我去 Claude Code 里查」是让用户自己去用，不算。
  const catalog = workerCatalog();
  const named = custom ? namedWorker(custom, catalog) : handoffWorker(approval.options[index], catalog);
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
  if (!Object.keys(fields).length) return task;
  db.prepare(`UPDATE tasks SET ${Object.keys(fields).map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...Object.values(fields), now(), taskId);
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
      progress: '重新排队…',
      started_at: null,
      finished_at: null,
      resume_payload: JSON.stringify({})
    });
    event(taskId, 'task/retried', { by: 'user' });
  });
  const updated = getTask(taskId);
  emitTask(updated);
  pump();
  return updated;
}

export function deleteTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'running') throw new Error('任务正在执行，先停止再删除');
  transaction(() => {
    db.prepare('DELETE FROM approvals WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(taskId);
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

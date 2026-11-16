import { db, now, uid, getSettings, rowTask, rowApproval, event } from './db.js';
import { bus } from './events.js';
import * as memory from './memory.js';
import * as lifecycle from './lifecycle.js';
import * as workflows from './workflows.js';
import { runWorker, availability, isWorker, workerLimits, workerRecovery, workerLabelOf, defaultWorker, reportUrl } from './workers.js';
import * as channels from './channels.js';

// taskId -> { controller, startedAt, worker, runId, report(body) }
const running = new Map();
const ABORTED = Symbol('aborted');
const HEARTBEAT_MS = 15 * 1000;
// 同一个任务连续被服务重启打断的次数上限，超过就停下，避免「崩溃 → 重启 → 再执行 → 再崩溃」。
export const MAX_RECOVERIES = 2;
let pumping = false;
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
  options = null
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
  db.prepare(`
    INSERT INTO tasks(id, title, prompt, worker, cwd, status, priority, origin, rule_id, session_id, group_key, hops, workflow_id, options, recoveries, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
  `).run(
    id, cleanTitle, String(prompt || cleanTitle), chosen,
    cwd || settings.defaultCwd || '', 'queued', priority, origin, ruleId, sessionId,
    groupKey || null, Math.max(0, Number(hops) || 0), workflowId || null,
    options ? JSON.stringify(options) : null, stamp, stamp
  );
  event(id, 'task/created', { worker: chosen, origin, title: cleanTitle, source, ...(workflowId ? { workflowId, workflow: workflowName } : {}) });
  const task = getTask(id);
  bus.emit('task/created', { task });
  pump();
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

export function mergeTask(taskId, { text = '', title = '', source = '' } = {}) {
  const task = getTask(taskId);
  if (!task || task.status !== 'queued') return null;
  const addition = `\n\n--- 合并的新事件${title ? `：${title}` : ''} ---\n${String(text || '').slice(0, 3000)}`;
  if (task.prompt.length < 30000) {
    db.prepare('UPDATE tasks SET prompt = ?, updated_at = ? WHERE id = ?')
      .run(task.prompt + addition, now(), taskId);
  }
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

function finishCancelled(taskId) {
  // cancel() 已经把状态写成 cancelled；这里只兜底，绝不覆盖成其他状态。
  const current = getTask(taskId);
  if (current?.status === 'running') {
    setStatus(taskId, { status: 'cancelled', result: '已停止', progress: null, finished_at: now() });
    event(taskId, 'task/cancelled', { reason: 'aborted' });
  }
  emitTask(getTask(taskId));
}

function finishTimeout(task, limits) {
  const message = `超过 ${limits.timeoutMinutes} 分钟还没跑完，已停止。超时不会自动重试；可以在 Worker 配置里调大超时后手动重试。`;
  setStatus(task.id, {
    status: 'failed',
    attempts: (task.attempts || 0) + 1,
    error: message,
    result: message,
    progress: null,
    finished_at: now()
  });
  event(task.id, 'task/failed', { error: message, timeout: true });
  emitTask(getTask(task.id));
  bus.emit('task/finished', { task: getTask(task.id) });
  channels.notifyTask(getTask(task.id)).catch(() => {});
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
      outcome = controller.signal.reason === 'timeout' ? 'timeout' : 'cancelled';
      if (outcome === 'timeout') finishTimeout(task, limits);
      else finishCancelled(task.id);
      return;
    }

    if (result.status === 'needs_approval') {
      outcome = 'waiting_approval';
      const approvalId = uid('a_');
      const options = result.approval?.options || ['继续', '取消'];
      db.prepare(`
        INSERT INTO approvals(id, task_id, question, options, status, kind, created_at)
        VALUES(?,?,?,?, 'pending', 'worker', ?)
      `).run(approvalId, task.id, result.approval?.question || '要继续吗？', JSON.stringify(options), now());
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
      setStatus(task.id, {
        status: 'cancelled',
        result: result.summary || '已取消',
        progress: null,
        finished_at: now(),
        tokens: task.tokens + (result.tokens || 0)
      });
      event(task.id, 'task/cancelled', { summary: result.summary });
      emitTask(getTask(task.id));
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
        setStatus(task.id, {
          status: 'failed',
          attempts,
          error: result.summary,
          result: result.summary,
          progress: null,
          finished_at: now(),
          ...usage
        });
        event(task.id, 'task/failed', { error: result.summary });
        emitTask(getTask(task.id));
        bus.emit('task/finished', { task: getTask(task.id) });
        channels.notifyTask(getTask(task.id)).catch(() => {});
      }
      return;
    }

    // done
    outcome = 'done';
    const summary = result.summary || '完成';
    setStatus(task.id, {
      status: 'done',
      result: summary,
      progress: null,
      error: null,
      finished_at: now(),
      recoveries: 0,
      tokens: task.tokens + (result.tokens || 0),
      cost: (task.cost || 0) + (result.cost || 0),
      resume_payload: resumePayload(task.id, result.sessionId ? { session_id: result.sessionId } : {})
    });
    event(task.id, 'task/done', { summary: summary.slice(0, 2000), tokens: result.tokens || 0 });

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

    emitTask(getTask(task.id));
    bus.emit('task/finished', { task: getTask(task.id) });
    channels.notifyTask(getTask(task.id)).catch(() => {});
    bus.emit('stats/updated', stats());
  } catch (err) {
    outcomeError = err.message;
    if (controller.signal.aborted) {
      outcome = controller.signal.reason === 'timeout' ? 'timeout' : 'cancelled';
      if (outcome === 'timeout') finishTimeout(task, limits);
      else finishCancelled(task.id);
    } else if (getTask(task.id)?.status === 'running') {
      setStatus(task.id, {
        status: 'failed',
        error: err.message,
        result: `执行出错：${err.message}`,
        progress: null,
        finished_at: now()
      });
      event(task.id, 'task/failed', { error: err.message });
      emitTask(getTask(task.id));
    }
  } finally {
    clearTimeout(timer);
    lifecycle.finishRun(run.id, outcome, outcomeError);
    running.delete(task.id);
    pump();
    bus.emit('stats/updated', stats());
  }
}

function pump() {
  if (pumping) return;
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

export function approve(approvalId, choice, { by = 'user' } = {}) {
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

  const index = Number(choice);
  const resolved = index >= 0 ? 'approved' : 'rejected';
  db.prepare('UPDATE approvals SET status = ?, choice = ?, resolved_at = ? WHERE id = ?')
    .run(resolved, index, now(), approvalId);

  // 服务重启后问的「重新执行 / 放弃」：不是 Worker 的问题，选择不能当成 Worker 的拍板结果传下去。
  if (approval.kind === 'recovery') {
    if (index === 0) {
      setStatus(task.id, { status: 'queued', approval_id: null, progress: '按你的选择重新执行…', started_at: null });
    } else {
      setStatus(task.id, { status: 'cancelled', approval_id: null, result: '服务重启后你选择了放弃', progress: null, finished_at: now() });
      event(task.id, 'task/cancelled', { reason: 'recovery declined' });
    }
    event(task.id, 'approval/resolved', { approvalId, choice: index, option: approval.options[index] ?? null, by, kind: 'recovery' });
    const updated = getTask(task.id);
    bus.emit('approval/resolved', { approval: getApproval(approvalId), task: updated });
    emitTask(updated);
    pump();
    return { approval: getApproval(approvalId), task: updated };
  }

  const settings = getSettings();
  const hops = (task.hops || 0) + 1;
  if (hops > (settings.maxHops || 6)) {
    setStatus(task.id, { status: 'failed', error: '恢复次数超过上限，已停止', finished_at: now() });
    event(task.id, 'task/failed', { error: '恢复次数超过上限' });
    emitTask(getTask(task.id));
    return { approval: getApproval(approvalId), task: getTask(task.id) };
  }

  setStatus(task.id, {
    status: 'queued',
    hops,
    progress: by === 'habit' ? '按习惯自动拍板，准备继续…' : '收到你的选择，准备继续…',
    approval_id: null,
    resume_payload: resumePayload(task.id, {
      approval: {
        question: approval.question,
        options: approval.options,
        choice: index
      }
    })
  });
  event(task.id, 'approval/resolved', { approvalId, choice: index, option: approval.options[index] ?? null, by });
  const updated = getTask(task.id);
  bus.emit('approval/resolved', { approval: getApproval(approvalId), task: updated });
  emitTask(updated);
  pump();
  return { approval: getApproval(approvalId), task: updated };
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
  const updated = getTask(taskId);
  emitTask(updated);
  pump();
  return updated;
}

export function deleteTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'running') throw new Error('任务正在执行，先停止再删除');
  db.prepare('DELETE FROM approvals WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  bus.emit('task/deleted', { id: taskId });
  bus.emit('stats/updated', stats());
  return { ok: true };
}

export function cancel(taskId, reason = '用户取消') {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (['done', 'failed', 'cancelled'].includes(task.status)) return task;

  const live = running.get(taskId);
  if (live) live.controller.abort('cancelled');
  if (task.approval_id) {
    db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(now(), task.approval_id);
    bus.emit('approval/resolved', { approval: getApproval(task.approval_id), task: getTask(taskId) });
  }
  setStatus(taskId, {
    status: 'cancelled',
    result: reason,
    progress: null,
    finished_at: now()
  });
  event(taskId, 'task/cancelled', { reason });
  if (!live) {
    emitTask(getTask(taskId));
    bus.emit('stats/updated', stats());
  }
  return getTask(taskId);
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
 * 每个任务连续被打断超过 MAX_RECOVERIES 次就标记失败。
 */
export function recover() {
  const stuck = db.prepare("SELECT * FROM tasks WHERE status = 'running'").all().map(rowTask);
  for (const task of stuck) {
    const run = task.run_id ? lifecycle.getRun(task.run_id) : null;
    if (run) lifecycle.finishRun(run.id, 'interrupted', '服务重启时中断');
    const recoveries = (task.recoveries || 0) + 1;
    const policy = isWorker(task.worker) ? workerRecovery(task.worker) : 'ask';
    const checkpoint = run?.checkpoint || task.resume_payload?.checkpoint || null;
    const ran = ranFor(run?.started_at || task.started_at);

    if (recoveries > MAX_RECOVERIES) {
      const message = `服务连续 ${recoveries} 次重启都打断了这个任务，为避免反复执行已停止。确认没问题后可以手动重试。`;
      setStatus(task.id, { status: 'failed', recoveries, error: message, result: message, progress: null, finished_at: now() });
      event(task.id, 'task/failed', { error: message, recovery: true });
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
    db.prepare(`
      INSERT INTO approvals(id, task_id, question, options, status, kind, created_at)
      VALUES(?,?,?,?, 'pending', 'recovery', ?)
    `).run(approvalId, task.id, question, JSON.stringify(options), now());
    setStatus(task.id, { status: 'waiting_approval', recoveries, approval_id: approvalId, progress: '服务重启，等你决定是否重跑' });
    event(task.id, 'task/recovered', { reason: 'server restart', mode: 'ask', runId: run?.id || null });
    event(task.id, 'task/waiting_approval', { approvalId, question, options });
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

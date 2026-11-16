import { db, now, uid, getSettings, rowTask, rowApproval, event } from './db.js';
import { bus } from './events.js';
import * as memory from './memory.js';
import { runWorker, availability, isWorker } from './workers.js';
import * as channels from './channels.js';

const running = new Map(); // taskId -> { controller, startedAt }
let pumping = false;

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
  worker = 'llm',
  cwd = '',
  origin = 'chat',
  sessionId = null,
  ruleId = null,
  priority = 2,
  source = null,
  groupKey = '',
  hops = 0
}) {
  if (!isWorker(worker)) {
    const err = new Error('未知的 Worker');
    err.statusCode = 400;
    throw err;
  }
  const settings = getSettings();
  const id = uid('t_');
  const stamp = now();
  const cleanTitle = String(title || prompt || '未命名任务').slice(0, 80);
  db.prepare(`
    INSERT INTO tasks(id, title, prompt, worker, cwd, status, priority, origin, rule_id, session_id, group_key, hops, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, cleanTitle, String(prompt || cleanTitle), worker,
    cwd || settings.defaultCwd || '', 'queued', priority, origin, ruleId, sessionId,
    groupKey || null, Math.max(0, Number(hops) || 0), stamp, stamp
  );
  event(id, 'task/created', { worker, origin, title: cleanTitle, source });
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

function setStatus(taskId, patch) {
  const fields = Object.keys(patch);
  const values = fields.map((f) => patch[f]);
  db.prepare(`UPDATE tasks SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, now(), taskId);
  return getTask(taskId);
}

async function execute(task) {
  const settings = getSettings();
  const controller = new AbortController();
  running.set(task.id, { controller, startedAt: Date.now() });
  setStatus(task.id, { status: 'running', started_at: now(), progress: '启动中…', error: null });
  event(task.id, 'task/started', { worker: task.worker, attempt: task.attempts + 1 });
  emitTask(getTask(task.id));

  const resume = task.resume_payload?.approval || null;
  const contextMemories = memory.context(`${task.title} ${task.prompt}`, { limit: 6 });
  const taskSnapshot = listTasks({ limit: 10 });
  let lastProgress = '';

  const onProgress = (message, meta = {}) => {
    if (lastProgress === message) return;
    lastProgress = message;
    db.prepare('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?').run(message, now(), task.id);
    bus.emit('task/progress', { taskId: task.id, message, meta });
  };

  try {
    const result = await runWorker(task, {
      signal: controller.signal,
      resume,
      memories: contextMemories,
      tasks: taskSnapshot,
      onProgress
    });

    if (result.status === 'needs_approval') {
      const approvalId = uid('a_');
      const options = result.approval?.options || ['继续', '取消'];
      db.prepare(`
        INSERT INTO approvals(id, task_id, question, options, status, created_at)
        VALUES(?,?,?,?, 'pending', ?)
      `).run(approvalId, task.id, result.approval?.question || '要继续吗？', JSON.stringify(options), now());
      setStatus(task.id, {
        status: 'waiting_approval',
        approval_id: approvalId,
        result: result.summary || '',
        progress: '等你拍板',
        tokens: task.tokens + (result.tokens || 0),
        cost: (task.cost || 0) + (result.cost || 0),
        resume_payload: JSON.stringify({
          ...(task.resume_payload || {}),
          ...(result.sessionId ? { session_id: result.sessionId } : {})
        })
      });
      event(task.id, 'task/waiting_approval', { approvalId, question: result.approval?.question, options });
      const approval = getApproval(approvalId);
      bus.emit('approval/created', { approval, task: getTask(task.id) });
      channels.notifyApproval(approval, getTask(task.id)).catch((err) => console.warn('[channel]', err.message));
      emitTask(getTask(task.id));
      return;
    }

    if (result.status === 'cancelled') {
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
      const attempts = (task.attempts || 0) + 1;
      if (attempts < 2) {
        setStatus(task.id, {
          status: 'queued',
          attempts,
          error: result.summary,
          progress: '准备重试…',
          started_at: null,
          tokens: task.tokens + (result.tokens || 0)
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
          finished_at: now()
        });
        event(task.id, 'task/failed', { error: result.summary });
        emitTask(getTask(task.id));
        channels.notifyTask(getTask(task.id)).catch(() => {});
      }
      return;
    }

    // done
    const summary = result.summary || '完成';
    setStatus(task.id, {
      status: 'done',
      result: summary,
      progress: null,
      error: null,
      finished_at: now(),
      tokens: task.tokens + (result.tokens || 0),
      cost: (task.cost || 0) + (result.cost || 0),
      resume_payload: JSON.stringify({
        ...(task.resume_payload || {}),
        ...(result.sessionId ? { session_id: result.sessionId } : {})
      })
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
    channels.notifyTask(getTask(task.id)).catch(() => {});
    bus.emit('stats/updated', stats());
  } catch (err) {
    const aborted = err.message === 'aborted' || err.name === 'AbortError';
    setStatus(task.id, {
      status: aborted ? 'cancelled' : 'failed',
      error: err.message,
      result: aborted ? '已停止' : `执行出错：${err.message}`,
      progress: null,
      finished_at: now()
    });
    event(task.id, aborted ? 'task/cancelled' : 'task/failed', { error: err.message });
    emitTask(getTask(task.id));
  } finally {
    running.delete(task.id);
    pump();
    bus.emit('stats/updated', stats());
  }
}

async function pump() {
  if (pumping) return;
  const settings = getSettings();
  if (settings.queuePaused) return;
  pumping = true;
  try {
    const limit = Math.max(1, Math.min(4, settings.concurrency || 2));
    while (running.size < limit) {
      const row = db.prepare(
        "SELECT * FROM tasks WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT 1"
      ).get();
      if (!row) break;
      const task = rowTask(row);
      // 原子占位，避免重复调度
      const changed = db.prepare(
        "UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'"
      ).run(now(), task.id).changes;
      if (changed) execute(task);
    }
  } finally {
    pumping = false;
  }
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
    progress: '收到你的选择，准备继续…',
    approval_id: null,
    resume_payload: JSON.stringify({
      ...(task.resume_payload || {}),
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
  event(taskId, 'task/edited', { fields: Object.keys(fields) });
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
  if (live) live.controller.abort();
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

/** 进程重启后，把中断的 running 任务放回队列，而不是假装还在跑 */
export function recover() {
  const stuck = db.prepare("SELECT * FROM tasks WHERE status = 'running'").all();
  for (const task of stuck) {
    setStatus(task.id, { status: 'queued', progress: '进程重启，重新排队…', started_at: null });
    event(task.id, 'task/recovered', { reason: 'server restart' });
  }
  if (stuck.length) console.log(`[scheduler] 已恢复 ${stuck.length} 个中断的任务`);
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

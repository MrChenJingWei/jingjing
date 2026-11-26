/**
 * 任务生命周期。
 *
 * 一个任务的完整状态由本地数据库里的三样东西还原：
 * - tasks.status：当前所处阶段，只能按 TRANSITIONS 变化；
 * - task_runs：每次执行一条记录（第几次、心跳、Worker 存的断点、结束原因），tasks.run_id 指向最近一次；
 * - task_events：发生过的每件事，任务详情里的时间线。
 *
 * 每次执行还有一个只在本次有效的令牌（库里只存哈希），Worker 用它通过回传接口上报进度和断点；
 * 执行结束或被取消后令牌立即失效，迟到的回传会被拒绝。
 */
import crypto from 'node:crypto';
import { db, now, uid } from './db.js';

// held：只跟踪、不执行。调度器不会去取它，来源状态照常同步；主人点「开始执行」才回到 queued。
export const TRANSITIONS = Object.freeze({
  queued: ['running', 'cancelled', 'held'],
  running: ['done', 'failed', 'cancelled', 'waiting_approval', 'queued'],
  waiting_approval: ['queued', 'cancelled', 'failed', 'held'],
  held: ['queued', 'cancelled'],
  done: ['queued', 'held'],
  failed: ['queued', 'held'],
  cancelled: ['queued', 'held']
});

export const RUN_STATUSES = ['running', 'done', 'failed', 'cancelled', 'timeout', 'waiting_approval', 'interrupted'];

export function canTransition(from, to) {
  return from === to || (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(taskId, from, to) {
  if (canTransition(from, to)) return;
  const err = new Error(`任务 ${taskId} 不能从「${from}」变成「${to}」`);
  err.code = 'BAD_TRANSITION';
  err.statusCode = 409;
  throw err;
}

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function parse(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function rowRun(row) {
  if (!row) return null;
  const { token_hash: _omit, ...rest } = row;
  return { ...rest, checkpoint: parse(row.checkpoint) };
}

/** 开始一次执行：写运行记录，返回 run id 和本次的回传令牌（明文只在内存里）。 */
export function startRun(task) {
  const id = uid('r_');
  const token = crypto.randomBytes(24).toString('base64url');
  const stamp = now();
  db.prepare(`
    INSERT INTO task_runs(id, task_id, attempt, worker, status, token_hash, started_at, heartbeat_at)
    VALUES(?, ?, ?, ?, 'running', ?, ?, ?)
  `).run(id, task.id, (task.attempts || 0) + 1, task.worker, hash(token), stamp, stamp);
  db.prepare('UPDATE tasks SET run_id = ? WHERE id = ?').run(id, task.id);
  return { id, token };
}

export function getRun(id) {
  return rowRun(db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id));
}

export function listRuns(taskId) {
  return db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at ASC').all(taskId).map(rowRun);
}

/** 结束一次执行。只改还在 running 的记录，保证结束原因只写一次。 */
export function finishRun(id, status, error = null) {
  if (!id || !RUN_STATUSES.includes(status)) return;
  db.prepare(`
    UPDATE task_runs SET status = ?, finished_at = ?, error = ?, token_hash = NULL
    WHERE id = ? AND status = 'running'
  `).run(status, now(), error ? String(error).slice(0, 1000) : null, id);
}

export function heartbeat(ids) {
  const stamp = now();
  const update = db.prepare("UPDATE task_runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'");
  for (const id of ids) update.run(stamp, id);
}

/** 合并 Worker 存的断点（JSON 对象），返回合并后的完整断点。 */
export function saveCheckpoint(id, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('checkpoint 必须是对象');
  const current = getRun(id);
  if (!current) throw new Error('运行记录不存在');
  const merged = { ...(current.checkpoint || {}), ...data };
  const text = JSON.stringify(merged);
  if (text.length > 64 * 1024) throw new Error('checkpoint 太大（最多 64KB）');
  db.prepare('UPDATE task_runs SET checkpoint = ?, heartbeat_at = ? WHERE id = ?').run(text, now(), id);
  return merged;
}

/** 校验回传令牌：只有仍在执行的那次 run 才认，令牌用常量时间比较。 */
export function verifyRun(id, token) {
  const row = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id);
  if (!row) return { ok: false, code: 404, error: '运行记录不存在' };
  if (row.status !== 'running' || !row.token_hash) {
    return { ok: false, code: 409, error: `这次执行已经结束（${row.status}）`, status: row.status, run: rowRun(row) };
  }
  const expected = Buffer.from(row.token_hash, 'hex');
  const actual = Buffer.from(hash(token || ''), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, code: 401, error: '回传令牌不对' };
  }
  return { ok: true, run: rowRun(row) };
}

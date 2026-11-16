/**
 * 旧数据归档：清理前先打包，之后可以查、可以恢复。
 *
 * 归档对象：已结束（done / failed / cancelled）且超过 afterDays 天的任务，连同它们的
 * task_events、approvals、task_runs，以及同期、且不属于仍保留任务的对话消息。
 * 不动的：记忆（长期上下文）、来源条目 source_items（它是防重复派活的去重账本）。
 *
 * 文件格式：<data>/archive/archive-<时间>.jsonl.gz，每行一个 JSON：
 *   第一行 { "type": "archive", "version": 1, "createdAt", "cutoff", "counts" }
 *   之后   { "table": "tasks", "row": {...} } ……
 * 旁边的 .json 是同一份头信息，列表时不用解压。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA_DIR } from './config.js';
import { db, now, getSettings, getSetting, setSetting } from './db.js';

export const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const NAME_RE = /^archive-[0-9TZ-]+(?:-\d+)?\.jsonl\.gz$/;
const TASK_TABLES = ['task_events', 'approvals', 'task_runs'];
const DAY_MS = 24 * 60 * 60 * 1000;

function settingsFor(days) {
  const cfg = getSettings().archive || {};
  const afterDays = Math.max(7, Math.round(Number(days ?? cfg.afterDays ?? 90)) || 90);
  return { enabled: cfg.enabled !== false, afterDays };
}

function chunked(ids, size = 400) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

function rowsForTasks(table, ids) {
  const rows = [];
  for (const part of chunked(ids)) {
    rows.push(...db.prepare(`SELECT * FROM ${table} WHERE task_id IN (${part.map(() => '?').join(',')}) ORDER BY rowid`).all(...part));
  }
  return rows;
}

function deleteForTasks(table, ids, column = 'task_id') {
  for (const part of chunked(ids)) {
    db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${part.map(() => '?').join(',')})`).run(...part);
  }
}

function fileName(date = new Date()) {
  const base = `archive-${date.toISOString().replace(/[:.]/g, '-')}`;
  let name = `${base}.jsonl.gz`;
  for (let i = 2; fs.existsSync(path.join(ARCHIVE_DIR, name)); i += 1) name = `${base}-${i}.jsonl.gz`;
  return name;
}

/** 选出要归档的数据（不修改数据库）。 */
export function collect({ days } = {}) {
  const { afterDays } = settingsFor(days);
  const cutoff = new Date(Date.now() - afterDays * DAY_MS).toISOString();
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('done', 'failed', 'cancelled') AND COALESCE(finished_at, updated_at) < ?
  `).all(cutoff);
  const ids = tasks.map((t) => t.id);
  const tables = { tasks };
  for (const table of TASK_TABLES) tables[table] = ids.length ? rowsForTasks(table, ids) : [];
  // 旧消息：只要不挂在仍保留的任务上就归档。
  tables.messages = db.prepare(`
    SELECT * FROM messages
    WHERE created_at < ?
      AND (task_id IS NULL OR task_id NOT IN (
        SELECT id FROM tasks WHERE NOT (status IN ('done', 'failed', 'cancelled') AND COALESCE(finished_at, updated_at) < ?)
      ))
  `).all(cutoff, cutoff);
  const counts = Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length]));
  return { cutoff, afterDays, tables, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

/** 打包并清理。先写文件、读回核对，再在一个事务里删除。 */
export function archiveOld({ days, reason = 'manual' } = {}) {
  const picked = collect({ days });
  const record = { at: now(), reason, cutoff: picked.cutoff, counts: picked.counts, file: null };
  if (!picked.total) {
    setSetting('archiveLastRun', record);
    return { ...record, archived: 0 };
  }
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const name = fileName();
  const header = { type: 'archive', version: 1, createdAt: record.at, reason, cutoff: picked.cutoff, afterDays: picked.afterDays, counts: picked.counts };
  const lines = [JSON.stringify(header)];
  for (const [table, rows] of Object.entries(picked.tables)) {
    for (const row of rows) lines.push(JSON.stringify({ table, row }));
  }
  const target = path.join(ARCHIVE_DIR, name);
  const temp = `${target}.tmp`;
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeSync(fd, zlib.gzipSync(`${lines.join('\n')}\n`));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const check = zlib.gunzipSync(fs.readFileSync(temp)).toString('utf8').split('\n').filter(Boolean).length;
  if (check !== lines.length) {
    fs.rmSync(temp, { force: true });
    throw new Error(`归档文件校验失败（应有 ${lines.length} 行，读回 ${check} 行），没有删除任何数据`);
  }
  fs.renameSync(temp, target);
  fs.writeFileSync(path.join(ARCHIVE_DIR, `${name}.json`), JSON.stringify({ name, ...header }, null, 2));

  const ids = picked.tables.tasks.map((t) => t.id);
  const messageIds = picked.tables.messages.map((m) => m.id);
  db.exec('BEGIN');
  try {
    for (const table of TASK_TABLES) deleteForTasks(table, ids);
    deleteForTasks('tasks', ids, 'id');
    deleteForTasks('messages', messageIds, 'id');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`清理失败，已回滚（归档文件 ${name} 保留）：${err.message}`);
  }
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
  record.file = name;
  setSetting('archiveLastRun', record);
  console.log(`[archive] 已归档 ${picked.total} 行到 ${name}`);
  return { ...record, archived: picked.total };
}

export function listArchives() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  return fs.readdirSync(ARCHIVE_DIR)
    .filter((name) => NAME_RE.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(ARCHIVE_DIR, name));
      let header = {};
      try { header = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, `${name}.json`), 'utf8')); } catch { /* 旧文件没有头信息 */ }
      return { name, size: stat.size, createdAt: header.createdAt || stat.mtime.toISOString(), cutoff: header.cutoff || null, counts: header.counts || {} };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function archiveFile(name) {
  if (!NAME_RE.test(String(name || ''))) throw Object.assign(new Error('归档文件名不合法'), { statusCode: 400 });
  const file = path.join(ARCHIVE_DIR, name);
  if (!fs.existsSync(file)) throw Object.assign(new Error('归档文件不存在'), { statusCode: 404 });
  return file;
}

function readArchive(name) {
  const lines = zlib.gunzipSync(fs.readFileSync(archiveFile(name))).toString('utf8').split('\n').filter(Boolean);
  const records = [];
  for (const line of lines.slice(1)) {
    try { records.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return records;
}

/** 在所有归档里按任务 id、标题或指令查找任务，附带它的时间线。 */
export function searchArchives(query, { limit = 20 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const { name } of listArchives()) {
    const records = readArchive(name);
    const tasks = records.filter((r) => r.table === 'tasks'
      && (r.row.id.toLowerCase() === q || `${r.row.title} ${r.row.prompt}`.toLowerCase().includes(q)));
    for (const { row } of tasks) {
      const events = records.filter((r) => r.table === 'task_events' && r.row.task_id === row.id).map((r) => r.row);
      const runs = records.filter((r) => r.table === 'task_runs' && r.row.task_id === row.id).map((r) => r.row);
      results.push({ archive: name, task: row, events, runs });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

function columnsOf(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

/** 把归档里的一个任务恢复回数据库（连同事件、审批、执行记录）。只插入当前表结构里还存在的列。 */
export function restoreTask(name, taskId) {
  const records = readArchive(name);
  const task = records.find((r) => r.table === 'tasks' && r.row.id === taskId);
  if (!task) throw Object.assign(new Error('归档里没有这个任务'), { statusCode: 404 });
  if (db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) {
    throw Object.assign(new Error('这个任务已经在数据库里了'), { statusCode: 409 });
  }
  const restored = {};
  db.exec('BEGIN');
  try {
    for (const table of ['tasks', ...TASK_TABLES]) {
      const columns = columnsOf(table);
      const rows = table === 'tasks' ? [task.row] : records.filter((r) => r.table === table && r.row.task_id === taskId).map((r) => r.row);
      for (const row of rows) {
        const keys = Object.keys(row).filter((key) => columns.has(key) && !(table === 'task_events' && key === 'id'));
        db.prepare(`INSERT OR IGNORE INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
          .run(...keys.map((key) => row[key]));
      }
      restored[table] = rows.length;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return restored;
}

/** 每天最多自动归档一次。 */
export function maybeAutoArchive() {
  const { enabled } = settingsFor();
  if (!enabled) return null;
  const last = getSetting('archiveLastRun', null);
  if (last?.at && Date.now() - new Date(last.at).getTime() < DAY_MS) return null;
  return archiveOld({ reason: 'auto' });
}

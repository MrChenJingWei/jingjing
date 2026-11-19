// 旧数据归档：先打包再清理，只动该动的数据；归档可以查、可以恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-archive-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { db, saveSettings } = await import('../src/db.js');
const archive = await import('../src/archive.js');

test.after(() => removeTemp(dataDir));

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function task(id, status, finishedDaysAgo) {
  const at = daysAgo(finishedDaysAgo);
  db.prepare(`
    INSERT INTO tasks(id, title, prompt, worker, status, created_at, updated_at, finished_at)
    VALUES(?, ?, 'x', 'llm', ?, ?, ?, ?)
  `).run(id, `任务 ${id}`, status, at, at, ['done', 'failed', 'cancelled'].includes(status) ? at : null);
  db.prepare('INSERT INTO task_events(task_id, type, data, created_at) VALUES(?, ?, NULL, ?)').run(id, 'task/created', at);
  db.prepare('INSERT INTO task_events(task_id, type, data, created_at) VALUES(?, ?, NULL, ?)').run(id, 'task/done', at);
  db.prepare("INSERT INTO task_runs(id, task_id, attempt, worker, status, started_at) VALUES(?, ?, 1, 'llm', 'done', ?)").run(`r_${id}`, id, at);
}

function message(id, createdDaysAgo, taskId = null) {
  db.prepare("INSERT INTO messages(id, session_id, role, text, kind, task_id, created_at) VALUES(?, 'main', 'user', ?, 'text', ?, ?)")
    .run(id, `消息 ${id}`, taskId, daysAgo(createdDaysAgo));
}

const count = (table, where = '1=1', ...args) => db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...args).c;

test('没有可归档的数据时不产生文件', () => {
  const result = archive.archiveOld({ days: 90 });
  assert.equal(result.archived, 0);
  assert.equal(result.file, null);
  assert.deepEqual(archive.listArchives(), []);
});

test('只归档已结束且超期的任务；挂在保留任务上的旧消息、来源去重记录都不动', () => {
  task('old_done', 'done', 200);
  task('old_failed', 'failed', 120);
  task('recent_done', 'done', 10);
  task('old_queued', 'queued', 300);
  db.prepare("INSERT INTO approvals(id, task_id, question, options, status, created_at) VALUES('a1', 'old_done', '要继续吗？', '[\"是\"]', 'approved', ?)").run(daysAgo(200));
  message('m_old_free', 150);
  message('m_old_task', 150, 'old_done');
  message('m_old_keep', 150, 'recent_done');
  message('m_new', 1);
  db.prepare("INSERT INTO source_items(id, source, external_id, title, status, created_at) VALUES('s1', 'email', 'mail-1', '旧邮件', 'task', ?)").run(daysAgo(300));

  const pending = archive.collect({ days: 90 }).counts;
  assert.deepEqual(pending, { tasks: 2, task_events: 4, approvals: 1, task_runs: 2, task_sources: 0, task_assignments: 0, task_class_suppressions: 0, messages: 2 });

  const result = archive.archiveOld({ days: 90 });
  assert.equal(result.archived, 11);
  assert.ok(fs.existsSync(path.join(archive.ARCHIVE_DIR, result.file)));

  assert.equal(count('tasks', "id IN ('old_done', 'old_failed')"), 0);
  assert.equal(count('tasks', "id IN ('recent_done', 'old_queued')"), 2, '近期和未结束的任务保留');
  assert.equal(count('task_events', "task_id = 'old_done'"), 0);
  assert.equal(count('task_runs', "task_id = 'old_done'"), 0);
  assert.equal(count('approvals'), 0);
  assert.equal(count('messages', "id IN ('m_old_free', 'm_old_task')"), 0);
  assert.equal(count('messages', "id IN ('m_old_keep', 'm_new')"), 2);
  assert.equal(count('source_items'), 1, '去重账本不清理，避免旧邮件被再次派活');

  const lines = zlib.gunzipSync(fs.readFileSync(path.join(archive.ARCHIVE_DIR, result.file))).toString('utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[0]).type, 'archive');
  assert.equal(lines.length, 12);

  const [listed] = archive.listArchives();
  assert.equal(listed.name, result.file);
  assert.equal(listed.counts.tasks, 2);
});

test('在归档里按 id 或标题查任务，并能恢复回数据库', () => {
  const [byId] = archive.searchArchives('old_done');
  assert.equal(byId.task.title, '任务 old_done');
  assert.equal(byId.events.length, 2);
  assert.equal(byId.runs.length, 1);
  assert.equal(archive.searchArchives('任务 old_').length, 2);
  assert.deepEqual(archive.searchArchives('不存在的东西'), []);

  const restored = archive.restoreTask(byId.archive, 'old_done');
  assert.deepEqual(restored, { tasks: 1, task_events: 2, approvals: 1, task_runs: 1, task_sources: 0, task_assignments: 0, task_class_suppressions: 0 });
  assert.equal(count('tasks', "id = 'old_done'"), 1);
  assert.deepEqual(
    db.prepare("SELECT type FROM task_events WHERE task_id = 'old_done' ORDER BY id").all().map((e) => e.type),
    ['task/created', 'task/done'],
    '时间线顺序不变'
  );
  assert.throws(() => archive.restoreTask(byId.archive, 'old_done'), /已经在数据库里/);
  assert.throws(() => archive.archiveFile('../../etc/passwd'), /不合法/);
});

test('自动归档每天最多一次，可以关闭', () => {
  assert.equal(archive.maybeAutoArchive(), null, '刚手动归档过，24 小时内不再自动跑');
  db.prepare("DELETE FROM settings WHERE key = 'archiveLastRun'").run();
  saveSettings({ archive: { enabled: false, afterDays: 90 } });
  assert.equal(archive.maybeAutoArchive(), null);
  saveSettings({ archive: { enabled: true, afterDays: 90 } });
  assert.ok(archive.maybeAutoArchive(), '开启后会跑');
});

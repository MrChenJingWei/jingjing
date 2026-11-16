import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, DEFAULT_SETTINGS, normalizeWorkspaces } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'text',
    task_id    TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

  CREATE TABLE IF NOT EXISTS tasks (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    prompt         TEXT NOT NULL,
    worker         TEXT NOT NULL,
    cwd            TEXT,
    status         TEXT NOT NULL,
    priority       INTEGER NOT NULL DEFAULT 2,
    origin         TEXT NOT NULL DEFAULT 'chat',
    rule_id        TEXT,
    session_id     TEXT,
    parent_id      TEXT,
    approval_id    TEXT,
    result         TEXT,
    error          TEXT,
    tokens         INTEGER NOT NULL DEFAULT 0,
    cost           REAL NOT NULL DEFAULT 0,
    hops           INTEGER NOT NULL DEFAULT 0,
    attempts       INTEGER NOT NULL DEFAULT 0,
    progress       TEXT,
    resume_payload TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    started_at     TEXT,
    finished_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority, created_at);

  CREATE TABLE IF NOT EXISTS task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    type       TEXT NOT NULL,
    data       TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);

  CREATE TABLE IF NOT EXISTS approvals (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    question    TEXT NOT NULL,
    options     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    choice      INTEGER,
    created_at  TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS memories (
    id           TEXT PRIMARY KEY,
    layer        TEXT NOT NULL,
    kind         TEXT NOT NULL,
    text         TEXT NOT NULL,
    tags         TEXT NOT NULL DEFAULT '[]',
    importance   REAL NOT NULL DEFAULT 0.5,
    source       TEXT,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    use_count    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer, created_at);

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    text, tags,
    content='memories',
    content_rowid='rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
    INSERT INTO memories_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END;

  CREATE TABLE IF NOT EXISTS source_plugins (
    id           TEXT PRIMARY KEY,
    enabled      INTEGER NOT NULL DEFAULT 0,
    config       TEXT NOT NULL DEFAULT '{}',
    last_run     TEXT,
    last_status  TEXT NOT NULL DEFAULT 'idle',
    last_error   TEXT,
    last_summary TEXT,
    updated_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS source_items (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title       TEXT,
    summary     TEXT,
    status      TEXT NOT NULL DEFAULT 'new',
    task_id     TEXT,
    url         TEXT,
    occurred_at TEXT,
    created_at  TEXT NOT NULL,
    UNIQUE(source, external_id)
  );
  CREATE INDEX IF NOT EXISTS idx_source_items ON source_items(source, created_at);

  CREATE TABLE IF NOT EXISTS rules (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    trigger    TEXT NOT NULL,
    action     TEXT NOT NULL,
    last_run   TEXT,
    created_at TEXT NOT NULL
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('source_items', 'url', 'TEXT');
ensureColumn('source_items', 'occurred_at', 'TEXT');
ensureColumn('source_items', 'decision_reason', 'TEXT');
ensureColumn('source_items', 'event_type', 'TEXT');
ensureColumn('source_items', 'hops', 'INTEGER');
ensureColumn('source_plugins', 'webhook_token', 'TEXT');
ensureColumn('source_plugins', 'workspace_id', 'TEXT');
ensureColumn('source_plugins', 'interval_minutes', 'INTEGER');
ensureColumn('tasks', 'group_key', 'TEXT');
ensureColumn('source_plugins', 'plugin_id', 'TEXT');
ensureColumn('source_plugins', 'label', 'TEXT');
ensureColumn('source_plugins', 'fail_count', 'INTEGER');
db.prepare('UPDATE source_plugins SET plugin_id = id WHERE plugin_id IS NULL').run();
db.prepare('UPDATE source_plugins SET fail_count = 0 WHERE fail_count IS NULL').run();
db.exec(`
  CREATE TABLE IF NOT EXISTS plugin_state (
    instance_id TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY(instance_id, key)
  );
  CREATE TABLE IF NOT EXISTS worker_rules (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    position     INTEGER NOT NULL DEFAULT 0,
    pattern      TEXT,
    source       TEXT,
    event_type   TEXT,
    workspace_id TEXT,
    worker       TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worker_configs (
    id         TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL DEFAULT 1,
    deleted    INTEGER NOT NULL DEFAULT 0,
    config     TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS plugin_runs (
    id          TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,
    scanned     INTEGER,
    created     INTEGER,
    error       TEXT,
    duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_plugin_runs ON plugin_runs(instance_id, started_at);
`);

// Tables above may have been created by an older version without these columns.
ensureColumn('worker_rules', 'event_type', 'TEXT');
ensureColumn('worker_configs', 'deleted', 'INTEGER');

export const now = () => new Date().toISOString();
export const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function parse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? parse(row.value) ?? fallback : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
  return value;
}

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function getSettings() {
  const stored = getSetting('config', {});
  return normalizeWorkspaces(deepMerge(DEFAULT_SETTINGS, stored || {}));
}

export function saveSettings(patch) {
  const next = deepMerge(getSettings(), patch);
  setSetting('config', next);
  return next;
}

export function rowTask(row) {
  if (!row) return null;
  return { ...row, resume_payload: parse(row.resume_payload) };
}

export function rowApproval(row) {
  if (!row) return null;
  return { ...row, options: parse(row.options) || [] };
}

export function event(taskId, type, data = null) {
  const at = now();
  db.prepare('INSERT INTO task_events(task_id, type, data, created_at) VALUES(?,?,?,?)')
    .run(taskId, type, data == null ? null : JSON.stringify(data), at);
  return { task_id: taskId, type, data, created_at: at };
}

export function seedIfEmpty() {
  // 收件箱巡检已移除；保留每日简报。
  db.prepare("DELETE FROM rules WHERE id = 'inbox-watch'").run();
  const has = db.prepare('SELECT COUNT(*) AS c FROM rules').get().c;
  if (!has) {
    const stamp = now();
    const rules = [
      {
        id: 'morning-digest',
        name: '每日晨间简报',
        enabled: 1,
        trigger: JSON.stringify({ type: 'daily', at: '08:00' }),
        action: JSON.stringify({
          worker: 'llm',
          title: '生成今日晨间简报',
          prompt: '汇总昨天完成的任务、今天等待处理的事项、以及记忆里和近期相关的内容，生成一份不超过 200 字的晨间简报。',
          cwd: ''
        }),
        created_at: stamp
      }
    ];
    const ins = db.prepare(
      'INSERT INTO rules(id, name, enabled, trigger, action, last_run, created_at) VALUES(?,?,?,?,?,NULL,?)'
    );
    for (const r of rules) ins.run(r.id, r.name, r.enabled, r.trigger, r.action, r.created_at);
  }
}

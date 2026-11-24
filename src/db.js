import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, DEFAULT_SETTINGS, normalizeProvider, normalizeWorkspaces } from './config.js';

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
ensureColumn('rules', 'last_status', 'TEXT');
ensureColumn('rules', 'last_summary', 'TEXT');
ensureColumn('source_plugins', 'webhook_token', 'TEXT');
ensureColumn('source_plugins', 'workspace_id', 'TEXT');
ensureColumn('source_plugins', 'interval_minutes', 'INTEGER');
ensureColumn('tasks', 'group_key', 'TEXT');
ensureColumn('source_plugins', 'plugin_id', 'TEXT');
ensureColumn('source_plugins', 'label', 'TEXT');
ensureColumn('source_plugins', 'fail_count', 'INTEGER');
db.prepare('UPDATE source_plugins SET plugin_id = id WHERE plugin_id IS NULL').run();
db.prepare('UPDATE source_plugins SET fail_count = 0 WHERE fail_count IS NULL').run();
// 记忆分两域，存在同一张表里：work 业务（主人的偏好、项目、任务经验）给任务和 Worker 用；
// persona 人格（静静自己的设定、她在外面认识的人和事）给她以自己的身份说话时用。旧记忆都算业务。
ensureColumn('memories', 'domain', 'TEXT');
db.prepare("UPDATE memories SET domain = 'work' WHERE domain IS NULL").run();
db.exec('CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain, layer, created_at)');
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
ensureColumn('worker_configs', 'limits', 'TEXT');
// notes：用户补充的「这台机器上它还能做什么」（比如已接入 TAPD MCP），挑 Worker 时和描述一起给模型看。
ensureColumn('worker_configs', 'notes', 'TEXT');
// routing：本机给这个 Worker 加的别名/能力（{ aliases: [], capabilities: { add: [], remove: [] } }）。
ensureColumn('worker_configs', 'routing', 'TEXT');
ensureColumn('worker_rules', 'pattern_mode', 'TEXT');
ensureColumn('tasks', 'workflow_id', 'TEXT');
ensureColumn('messages', 'meta', 'TEXT');
ensureColumn('tasks', 'run_id', 'TEXT');
ensureColumn('tasks', 'recoveries', 'INTEGER');
ensureColumn('tasks', 'options', 'TEXT');
// outcome：任务结论，和 status（这轮运行的生命周期）分开。done 只代表跑完了，不代表事情做完了。
ensureColumn('tasks', 'outcome', 'TEXT');
ensureColumn('approvals', 'kind', 'TEXT');
// reply_to：来源插件给的「发回哪里」（插件自己认识的地址，比如企微的会话 ID）；有它，任务结果才能发回原会话。
ensureColumn('tasks', 'reply_to', 'TEXT');
// parent_id + link_kind：任务之间的流转。followup = 从上一张卡「另起一张」接着做。
ensureColumn('tasks', 'link_kind', 'TEXT');

// 任务 ↔ 外部对象（TAPD 缺陷、GitHub PR……）的绑定和外部状态，见 source-links.js。
// 和 source_items（去重账本）分开：这张表跟着任务删除、归档、恢复。
db.exec(`
  CREATE TABLE IF NOT EXISTS task_sources (
    id                TEXT PRIMARY KEY,
    task_id           TEXT NOT NULL,
    provider          TEXT NOT NULL,
    provider_label    TEXT,
    external_id       TEXT NOT NULL,
    external_type     TEXT,
    title             TEXT,
    url               TEXT,
    status_key        TEXT,
    status_label      TEXT,
    status_category   TEXT NOT NULL DEFAULT 'unknown',
    status_detail     TEXT,
    status_updated_at TEXT,
    meta              TEXT,
    tracking          INTEGER NOT NULL DEFAULT 1,
    sync_error        TEXT,
    sync_failures     INTEGER NOT NULL DEFAULT 0,
    synced_at         TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE(task_id, provider, external_id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_sources_task ON task_sources(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_sources_provider ON task_sources(provider, external_id);
`);
// node_key：这条绑定对应的外部对象树节点（插件声明了归类能力才有），见 task-classification.js。
ensureColumn('task_sources', 'node_key', 'TEXT');

// 任务归类（docs/architecture/external.md）：外部对象树、分类项、归属意图、卡级抑制、按域积累的知识。
// 外部对象树是全局事实，不跟任务走；归属和抑制是 task 级，跟着任务删除 / 归档 / 恢复。
db.exec(`
  CREATE TABLE IF NOT EXISTS external_nodes (
    key            TEXT PRIMARY KEY,
    provider_family TEXT NOT NULL,
    workspace      TEXT NOT NULL,
    type           TEXT NOT NULL,
    external_id    TEXT NOT NULL,
    parent_key     TEXT,
    title          TEXT,
    url            TEXT,
    ref            TEXT,
    resolved       INTEGER NOT NULL DEFAULT 0,
    observed_by    TEXT NOT NULL DEFAULT '[]',
    last_observer  TEXT,
    stale          INTEGER NOT NULL DEFAULT 0,
    observed_at    TEXT NOT NULL,
    UNIQUE(provider_family, workspace, type, external_id)
  );
  CREATE INDEX IF NOT EXISTS idx_external_nodes_parent ON external_nodes(parent_key);

  CREATE TABLE IF NOT EXISTS external_node_links (
    from_key    TEXT NOT NULL,
    to_key      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY(from_key, to_key, kind)
  );

  CREATE TABLE IF NOT EXISTS task_categories (
    id              TEXT PRIMARY KEY,
    axis            TEXT NOT NULL,
    key             TEXT NOT NULL,
    title           TEXT NOT NULL,
    ref             TEXT,
    provider_family TEXT,
    workspace       TEXT,
    origin          TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'active',
    merged_into     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE(axis, key)
  );

  CREATE TABLE IF NOT EXISTS task_assignments (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    axis        TEXT NOT NULL,
    category_id TEXT,
    state       TEXT NOT NULL DEFAULT 'member',
    candidates  TEXT,
    who         TEXT NOT NULL,
    pinned      INTEGER NOT NULL DEFAULT 0,
    reason      TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(task_id, axis)
  );
  CREATE INDEX IF NOT EXISTS idx_task_assignments_category ON task_assignments(category_id);

  CREATE TABLE IF NOT EXISTS task_class_suppressions (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    axis       TEXT NOT NULL,
    key        TEXT,
    reason     TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_class_suppressions_task ON task_class_suppressions(task_id, axis);

  CREATE TABLE IF NOT EXISTS task_knowledge (
    id           TEXT PRIMARY KEY,
    scope_key    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    subject      TEXT NOT NULL DEFAULT '',
    value        TEXT,
    text         TEXT NOT NULL,
    hash         TEXT NOT NULL,
    evidence     TEXT,
    source       TEXT NOT NULL,
    pinned       INTEGER NOT NULL DEFAULT 0,
    hidden       INTEGER NOT NULL DEFAULT 0,
    confirmed    INTEGER NOT NULL DEFAULT 1,
    seen_count   INTEGER NOT NULL DEFAULT 1,
    used_count   INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    conflict     INTEGER NOT NULL DEFAULT 0,
    stale        INTEGER NOT NULL DEFAULT 0,
    promoted     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE(scope_key, kind, subject, hash)
  );
  CREATE INDEX IF NOT EXISTS idx_task_knowledge_scope ON task_knowledge(scope_key, kind);
`);
// 每个来源实例的自动归类状态：off（默认）/ observing（试运行）/ on；group_at 是用户改过的切层策略（JSON）。
ensureColumn('source_plugins', 'classify_state', 'TEXT');
ensureColumn('source_plugins', 'classify_since', 'TEXT');
ensureColumn('source_plugins', 'classify_group_at', 'TEXT');
ensureColumn('source_plugins', 'classify_prompts', 'INTEGER');

// auto_reply：任务完成后自动把结果发回原会话。会往外发消息，默认关闭。
ensureColumn('source_plugins', 'auto_reply', 'INTEGER');
// auto_chat：闲聊自动回（不建任务、由静静按人格回）。和任务结果的自动发回分开；
// NULL 表示沿用旧行为（跟着 auto_reply），显式 0/1 才独立控制。
ensureColumn('source_plugins', 'auto_chat', 'INTEGER');
// relay：消息类来源往外说话的策略（回执 / 状态播报 / 谁能在群里拍板），见 relay.js。
ensureColumn('source_plugins', 'relay', 'TEXT');
// custom：这条审批是否允许用户不选给出的选项、自己写决定；answer：用户写的决定。
ensureColumn('approvals', 'custom', 'INTEGER');
ensureColumn('approvals', 'answer', 'TEXT');
// meta：宿主自己发起的审批（比如「外部消息点名了 Codex，交给谁？」）里每个选项对应做什么。
ensureColumn('approvals', 'meta', 'TEXT');
// 加这一列之前就在等拍板的：内置的 Claude Code / 问答 Worker 都能接住自己写的决定。
db.exec(`
  UPDATE approvals SET custom = 1
  WHERE custom IS NULL AND status = 'pending' AND kind = 'worker'
    AND task_id IN (SELECT id FROM tasks WHERE worker IN ('claude', 'llm'))
`);
db.exec(`
  -- 每次执行一条运行记录：任务的生命周期由「任务状态 + 运行记录 + 事件」三者在本地还原。
  CREATE TABLE IF NOT EXISTS task_runs (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL,
    attempt      INTEGER NOT NULL,
    worker       TEXT NOT NULL,
    status       TEXT NOT NULL,
    token_hash   TEXT,
    checkpoint   TEXT,
    started_at   TEXT NOT NULL,
    heartbeat_at TEXT,
    finished_at  TEXT,
    error        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at);
`);

// 静静的心智（src/mind.js / affect.js / people.js）：
// - 记忆按艾宾浩斯遗忘曲线衰减：stability 是「记忆稳定度」（天），越大忘得越慢；每次被想起会变大。
// - valence / arousal：记下这件事时的情绪（-1 难过 … 1 开心；0 平静 … 1 激动），情绪强烈的记得更牢。
// - subject：这条记忆是关于谁的（owner 主人、self 她自己、外面某个人的 key）；archived：已经淡忘（不删，记忆页能看到）。
ensureColumn('memories', 'stability', 'REAL');
ensureColumn('memories', 'valence', 'REAL');
ensureColumn('memories', 'arousal', 'REAL');
ensureColumn('memories', 'subject', 'TEXT');
ensureColumn('memories', 'archived', 'INTEGER');
db.exec(`
  UPDATE memories SET stability = CASE layer
    WHEN 'profile' THEN 365 WHEN 'semantic' THEN 90 WHEN 'episodic' THEN 14 ELSE 2 END * (0.5 + importance)
  WHERE stability IS NULL;
  UPDATE memories SET archived = 0 WHERE archived IS NULL;
  CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject, created_at);
`);
// 工作记忆：每段对话有一份滚动摘要（更早的对话压缩在这里），encoded_upto 记到哪条消息已经整理进长期记忆。
// kind：main 主人的对话 / external 外面某个人；person_id 指向 people。
ensureColumn('sessions', 'summary', 'TEXT');
ensureColumn('sessions', 'encoded_upto', 'TEXT');
ensureColumn('sessions', 'kind', 'TEXT');
ensureColumn('sessions', 'person_id', 'TEXT');
db.exec(`
  -- 社交记忆：静静认识的人（主人也在里面，id = owner）。熟悉度随来往变高、久不联系慢慢变低；好感随聊天的情绪变化。
  CREATE TABLE IF NOT EXISTS people (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    source       TEXT,
    first_seen   TEXT NOT NULL,
    last_seen    TEXT NOT NULL,
    interactions INTEGER NOT NULL DEFAULT 0,
    familiarity  REAL NOT NULL DEFAULT 0,
    affinity     REAL NOT NULL DEFAULT 0,
    impression   TEXT,
    updated_at   TEXT NOT NULL
  );
  -- 人设的每一个版本：她自己反思后改的、主人手动改的、回退的，都留底，可以回到任何一版。
  CREATE TABLE IF NOT EXISTS persona_versions (
    id         TEXT PRIMARY KEY,
    text       TEXT NOT NULL,
    reason     TEXT,
    source     TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// 认人：名字从哪来（id / source 插件给的 / chat 聊天里说的 / directory 通讯录 / manual 主人改的，后者优先），
// 来自哪个来源实例、在那边的 id，通讯录查到的部门职位（JSON），上次查通讯录的时间。
ensureColumn('people', 'name_from', 'TEXT');
ensureColumn('people', 'source_id', 'TEXT');
ensureColumn('people', 'external_id', 'TEXT');
ensureColumn('people', 'profile', 'TEXT');
ensureColumn('people', 'looked_up_at', 'TEXT');
// 合并过的人：别的来源里的身份（alias_id）都指向同一个人（person_id）。主人确认「不是同一个人」的一对记在 people_distinct。
// 派活的人：tasks.requester 指向 people.id（合并后会改指向）。
db.exec(`
  CREATE TABLE IF NOT EXISTS people_aliases (
    alias_id   TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_people_aliases_person ON people_aliases(person_id);
  CREATE TABLE IF NOT EXISTS people_distinct (
    a          TEXT NOT NULL,
    b          TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (a, b)
  );
`);
// 绑定时记下被并进来的那个身份当时的样子（称呼、来源、来源里的 id），解绑时照着还原成一个人；
// people.origin：这个人自己那个身份的来源名（合并后 source 会变成几个来源连在一起）。
ensureColumn('people_aliases', 'name', 'TEXT');
ensureColumn('people_aliases', 'name_from', 'TEXT');
ensureColumn('people_aliases', 'source', 'TEXT');
ensureColumn('people', 'origin', 'TEXT');
// 合并时的快照（JSON）：两边合并前后的样子、搬过来的聊天 / 记忆 / 活 / 别名，解绑时照着还原。
ensureColumn('people_aliases', 'snapshot', 'TEXT');
ensureColumn('tasks', 'requester', 'TEXT');

export const now =() => new Date().toISOString();
export const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

let txDepth = 0;

/**
 * 把几步写入包成一个事务：中途出错（或进程在中间崩溃）全部回滚，不会留下「审批已处理、任务还在等」这种半截状态。
 * fn 必须是同步的；嵌套调用时内层直接并入外层事务。
 */
export function transaction(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 已经回滚 */ }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

// 设置每保存一次加一：缓存（比如 Worker 的 detect 结果）据此判断是否过期。
let settingsVersion = 0;
export const settingsRevision = () => settingsVersion;

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
  settingsVersion += 1;
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
  const settings = deepMerge(DEFAULT_SETTINGS, stored || {});
  settings.provider = normalizeProvider(settings.provider);
  return normalizeWorkspaces(settings);
}

/** 给界面看的设置：密钥只告诉有没有填。 */
export function maskSettings(settings) {
  const copy = structuredClone(settings);
  copy.apiKey = settings.apiKey ? '••••••••' : '';
  if (copy.channels?.telegram?.token) copy.channels.telegram.token = '••••••••';
  return copy;
}

/**
 * 交给插件的设置快照：去掉模型 Key 和通知通道的凭据。
 * 插件需要的是人设、模型名、工作区这类信息，不需要也不应该拿到密钥。
 */
export function pluginSettings(settings = getSettings()) {
  const copy = structuredClone(settings);
  delete copy.apiKey;
  delete copy.channels;
  return copy;
}

export function saveSettings(patch) {
  const next = deepMerge(getSettings(), patch);
  setSetting('config', next);
  return next;
}

export function rowTask(row) {
  if (!row) return null;
  return { ...row, resume_payload: parse(row.resume_payload), reply_to: parse(row.reply_to) };
}

export function rowApproval(row) {
  if (!row) return null;
  return { ...row, options: parse(row.options) || [], custom: Boolean(row.custom), meta: row.meta ? parse(row.meta) : null };
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
          // 留空：运行时按能力挑最便宜的文本 Worker。
          worker: '',
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

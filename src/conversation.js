/**
 * 对话的短时记忆（工作记忆）：每段对话最近的原话 + 一份滚动摘要。
 * - 主人的对话是 main；外面每个人各有一段（ext:<人的 id>），不会混进主人的对话窗口。
 * - 原话只带最近几轮（模型上下文有限，小模型尤其如此）；更早的由 mind.js 定期压成摘要，摘要一直带着。
 * - encoded_upto 记到哪条消息已经整理进长期记忆，整理过的不会重复记。
 */
import { db, now, uid } from './db.js';

export const MAIN_SESSION = 'main';

export const externalSessionId = (personId) => `ext:${personId}`;

export function sessionKind(id) {
  return String(id).startsWith('ext:') ? 'external' : 'main';
}

export function ensureSession(id, { personId = null, title = null } = {}) {
  const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (existing) return existing;
  const stamp = now();
  db.prepare('INSERT INTO sessions(id, title, created_at, updated_at, kind, person_id) VALUES(?,?,?,?,?,?)')
    .run(id, title || (id === MAIN_SESSION ? '和静静的对话' : id), stamp, stamp, sessionKind(id), personId);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

export function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

/** 最近的消息，从旧到新。 */
export function recentMessages(sessionId, limit = 12) {
  return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(sessionId, limit)
    .reverse();
}

/** 只记录、不广播：外面的闲聊不该出现在主人的对话窗口里。 */
export function appendMessage({ sessionId, role, text, kind = 'text' }) {
  const stamp = now();
  db.prepare('INSERT INTO messages(id, session_id, role, text, kind, task_id, meta, created_at) VALUES(?,?,?,?,?,NULL,NULL,?)')
    .run(uid('msg_'), sessionId, role, String(text || ''), kind, stamp);
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(stamp, sessionId);
}

/**
 * 转成模型要的多轮消息：同一方连着说的合并，每条截断，第一条必须是对方说的。
 * names 用来给外人的消息标上名字（群里可能有几个人）。
 */
export function asTurns(messages, { maxChars = 600 } = {}) {
  const turns = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.text || '').trim().slice(0, maxChars);
    if (!content) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${content}`;
    else turns.push({ role, content });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

export function summaryOf(sessionId) {
  return getSession(sessionId)?.summary || '';
}

export function setSummary(sessionId, summary, encodedUpto) {
  db.prepare('UPDATE sessions SET summary = ?, encoded_upto = COALESCE(?, encoded_upto) WHERE id = ?')
    .run(String(summary || '').slice(0, 1200), encodedUpto || null, sessionId);
}

/** 还没整理进长期记忆的消息（从旧到新）。 */
export function unencoded(sessionId, limit = 60) {
  const session = getSession(sessionId);
  const since = session?.encoded_upto || '';
  return db.prepare(`
    SELECT * FROM messages WHERE session_id = ? AND created_at > ? AND kind IN ('text', 'task')
    ORDER BY created_at ASC, rowid ASC LIMIT ?
  `).all(sessionId, since, limit);
}

/** 有没整理的消息的对话：[{ id, pending, lastAt, kind, person_id }]。 */
export function sessionsWithPending() {
  return db.prepare(`
    SELECT s.id, s.kind, s.person_id, COUNT(m.id) AS pending, MAX(m.created_at) AS lastAt
    FROM sessions s JOIN messages m ON m.session_id = s.id
    WHERE m.created_at > COALESCE(s.encoded_upto, '') AND m.kind IN ('text', 'task') AND m.role = 'user'
    GROUP BY s.id
  `).all();
}

/**
 * 记忆库。同一张 memories 表，分两个域：
 * - work 业务：主人的偏好、项目、任务经验。Router 派活、Worker 执行时用；
 * - persona 人格：静静自己的设定、她在外面认识的人和聊过的事。她以自己的身份说话时用。
 * 两边互不混用：任务拿不到人格记忆，外面的人更拿不到业务记忆。所有读写不写 domain 时都按业务处理。
 */
import { db, now, uid } from './db.js';

const LAYERS = new Set(['working', 'episodic', 'semantic', 'profile']);
export const DOMAINS = ['work', 'persona'];

/** 规整 domain：认识的原样返回；all / null 表示两个域都要（只给记忆页和导出用）；其它按业务处理。 */
function domainOf(value, { allowAll = false } = {}) {
  if (allowAll && (value === null || value === 'all')) return null;
  return DOMAINS.includes(value) ? value : 'work';
}

function hydrate(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { /* ignore */ }
  return { ...row, tags };
}

export function remember({
  text,
  layer = 'semantic',
  kind = 'fact',
  tags = [],
  importance = 0.5,
  source = 'chat',
  domain = 'work'
}) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  if (!LAYERS.has(layer)) layer = 'semantic';
  domain = domainOf(domain);

  const dup = db.prepare('SELECT id FROM memories WHERE text = ? AND layer = ? AND domain = ?').get(clean, layer, domain);
  if (dup) {
    db.prepare('UPDATE memories SET importance = MAX(importance, ?), created_at = ? WHERE id = ?')
      .run(importance, now(), dup.id);
    return get(dup.id);
  }

  const id = uid('m_');
  db.prepare(`
    INSERT INTO memories(id, layer, kind, text, tags, importance, source, created_at, use_count, domain)
    VALUES(?,?,?,?,?,?,?,?,0,?)
  `).run(id, layer, kind, clean, JSON.stringify(tags), importance, source, now(), domain);
  return get(id);
}

export function get(id) {
  return hydrate(db.prepare('SELECT * FROM memories WHERE id = ?').get(id));
}

/** domain 默认业务；传 'all' 或 null 两个域都列（记忆页、导出）。 */
export function list({ layer, limit = 100, domain = 'work' } = {}) {
  const scope = domainOf(domain, { allowAll: true });
  const where = [];
  const args = [];
  if (layer) { where.push('layer = ?'); args.push(layer); }
  if (scope) { where.push('domain = ?'); args.push(scope); }
  const rows = db.prepare(`
    SELECT * FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY importance DESC, created_at DESC LIMIT ?
  `).all(...args, limit);
  return rows.map(hydrate);
}

export function update(id, patch = {}) {
  const current = get(id);
  if (!current) return null;
  const next = {
    text: patch.text === undefined ? current.text : String(patch.text || '').trim(),
    layer: ['working', 'episodic', 'semantic', 'profile'].includes(patch.layer) ? patch.layer : current.layer,
    domain: DOMAINS.includes(patch.domain) ? patch.domain : current.domain || 'work',
    kind: patch.kind === undefined ? current.kind : String(patch.kind || current.kind),
    tags: Array.isArray(patch.tags) ? patch.tags.map(String) : current.tags,
    importance: patch.importance === undefined
      ? current.importance
      : Math.min(1, Math.max(0, Number(patch.importance) || 0))
  };
  if (!next.text) throw new Error('记忆内容不能为空');
  db.prepare('UPDATE memories SET text = ?, layer = ?, domain = ?, kind = ?, tags = ?, importance = ? WHERE id = ?')
    .run(next.text, next.layer, next.domain, next.kind, JSON.stringify(next.tags), next.importance, id);
  return get(id);
}

export function forget(id) {
  return db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
}

function likeEscape(q) {
  return q.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** 按内容搜。domain 默认业务；传 'all' 或 null 两个域都搜（记忆页）。 */
export function search(query, limit = 12, { domain = 'work' } = {}) {
  const q = String(query || '').trim();
  if (!q) return list({ limit, domain });
  const scope = domainOf(domain, { allowAll: true });
  const inScope = scope ? ' AND m.domain = ?' : '';
  const scopeArgs = scope ? [scope] : [];
  const rows = [];
  if ([...q].length >= 3) {
    try {
      const match = '"' + q.replace(/"/g, '""') + '"';
      rows.push(...db.prepare(`
        SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
        WHERE memories_fts MATCH ?${inScope} ORDER BY rank LIMIT ?
      `).all(match, ...scopeArgs, limit));
    } catch { /* fall back to LIKE */ }
  }
  if (rows.length < limit) {
    const pattern = '%' + likeEscape(q) + '%';
    rows.push(...db.prepare(`
      SELECT m.* FROM memories m WHERE (m.text LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\')${inScope}
      ORDER BY m.importance DESC, m.created_at DESC LIMIT ?
    `).all(pattern, pattern, ...scopeArgs, limit));
  }
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(hydrate(row));
    if (out.length >= limit) break;
  }
  if (out.length) {
    const touch = db.prepare('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?');
    for (const m of out) touch.run(now(), m.id);
  }
  return out;
}

/** 拼装可注入提示词的记忆上下文。Router / Worker 用业务域（默认）；静静以自己身份说话时用 persona。 */
export function context(query, { limit = 6, domain = 'work' } = {}) {
  domain = domainOf(domain);
  const relevant = query ? search(query, limit, { domain }) : list({ limit, domain });
  const profile = list({ layer: 'profile', limit: 6, domain });
  const semantic = list({ layer: 'semantic', limit: 6, domain });
  const seen = new Set();
  const merged = [];
  for (const m of [...profile, ...relevant, ...semantic]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }
  return merged.slice(0, limit + 6);
}

export function serializeForPrompt(items) {
  return items
    .map((m) => `- [${m.layer}/${m.kind}] ${m.text}${m.tags?.length ? `（标签：${m.tags.join('、')}）` : ''}`)
    .join('\n');
}

/** 从一句话里抽取值得长期记住的事实（不依赖模型，保证离线可用） */
export function extractFacts(raw, userName = '用户') {
  const text = String(raw || '').trim();
  if (!text) return [];
  const facts = [];
  const push = (value, kind = 'fact', importance = 0.6) => {
    const t = value.trim().replace(/^[，,。：:\s]+|[，,。：:\s]+$/g, '');
    if (t.length >= 2) facts.push({ text: t, kind, importance });
  };

  const explicit = text.match(/(?:记住|记一下|记下|帮我记)[：:，,\s]*(.+)/);
  if (explicit) push(explicit[1], 'note', 0.7);

  const pref = text.match(/我(?:更)?(?:喜欢|偏好|习惯|通常|一般|不喜欢|讨厌)([^。！？!?\n]+)/);
  if (pref) push(`${userName}${text.includes('不喜欢') || text.includes('讨厌') ? '不喜欢' : '喜欢/习惯'}：${pref[1]}`, 'preference', 0.75);

  const mine = text.match(/我的([^\s，,。！？!?]{1,12})是([^。！？!?\n]+)/);
  if (mine) push(`${userName}的${mine[1]}是${mine[2]}`, 'profile', 0.8);

  const later = text.match(/(?:以后|今后|下次)(?:都|请|要)?([^。！？!?\n]{2,})/);
  if (later) push(`以后${later[1]}`, 'preference', 0.65);

  return facts;
}

/** 各层条数；给了 domain 只数那个域。 */
export function allLayersStats({ domain = null } = {}) {
  const scope = domainOf(domain, { allowAll: true });
  return scope
    ? db.prepare('SELECT layer, COUNT(*) AS count FROM memories WHERE domain = ? GROUP BY layer').all(scope)
    : db.prepare('SELECT layer, COUNT(*) AS count FROM memories GROUP BY layer').all();
}

/** 两个域各有多少条（记忆页的切换标签用）。 */
export function domainStats() {
  const counts = Object.fromEntries(DOMAINS.map((d) => [d, 0]));
  for (const row of db.prepare('SELECT domain, COUNT(*) AS count FROM memories GROUP BY domain').all()) {
    counts[domainOf(row.domain)] += row.count;
  }
  return counts;
}

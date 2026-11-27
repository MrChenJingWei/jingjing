/**
 * 记忆库。同一张 memories 表，分两个域：
 * - work 业务：主人的偏好、项目、任务经验、和主人聊过的事。Router 派活、Worker 执行时用；
 * - persona 人格：静静自己的设定和自我认知、她在外面认识的人和聊过的事。她以自己的身份说话时用。
 * 两边互不混用：任务拿不到人格记忆，外面的人更拿不到业务记忆。所有读写不写 domain 时都按业务处理。
 *
 * 记忆会遗忘，也会因为反复想起而记得更牢（全部是确定的计算，不依赖模型）：
 * - 保持率 R = e^(-t / S)：t 是距离上次想起的天数，S 是稳定度（天）。这是艾宾浩斯遗忘曲线的常用近似。
 * - 刚记下时 S 由层级、重要度和情绪强度决定：画像几乎不忘，情景记忆几周就淡；情绪越强烈记得越牢。
 * - 每次被想起（放进提示词）S 变大，间隔越久、当时越模糊，涨得越多（间隔效应）。
 * - 检索打分 = 相关 + 新近（保持率）+ 重要 + 情绪强度，参考 Generative Agents 的记忆流检索。
 * - 每天整理：快忘光的情景记忆归档（不删）；被反复想起的情景记忆转成语义记忆（复述巩固）。
 */
import { db, now, uid, getSetting, setSetting, transaction } from './db.js';
import { hasName, listEntities, matchEntities, refsForMemory } from './entities.js';

const LAYERS = new Set(['working', 'episodic', 'semantic', 'profile']);
export const DOMAINS = ['work', 'persona'];
const DAY = 86400000;
const BASE_STABILITY = { profile: 365, semantic: 90, episodic: 14, working: 2 };
const MAX_STABILITY = 3650;

/** 规整 domain：认识的原样返回；all / null 表示两个域都要（只给记忆页和导出用）；其它按业务处理。 */
function domainOf(value, { allowAll = false } = {}) {
  if (allowAll && (value === null || value === 'all')) return null;
  return DOMAINS.includes(value) ? value : 'work';
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));

/** 刚记下时的稳定度（天）。 */
export function initialStability(layer, importance = 0.5, arousal = 0) {
  return (BASE_STABILITY[layer] ?? BASE_STABILITY.episodic) * (0.5 + clamp(importance, 0, 1)) * (1 + 1.5 * clamp(arousal, 0, 1));
}

function stabilityOf(m) {
  return m.stability || initialStability(m.layer, m.importance, m.arousal || 0);
}

/** 现在还记得多少（0–1）。 */
export function retention(m, at = Date.now()) {
  const since = Date.parse(m.last_used_at || m.created_at);
  const days = Number.isFinite(since) ? Math.max(0, (at - since) / DAY) : 0;
  return Math.exp(-days / stabilityOf(m));
}

/** 给人看的「记得多清楚」。 */
export function retentionLabel(r) {
  if (r >= 0.8) return '清楚';
  if (r >= 0.5) return '记得';
  if (r >= 0.2) return '模糊';
  return '快忘了';
}

function hydrate(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { /* ignore */ }
  const item = { ...row, tags, archived: Boolean(row.archived) };
  item.retention = Number(retention(item).toFixed(3));
  return item;
}

/**
 * 写一条记忆（remember 的增强版，所有写入最终都走这里）：
 * - 去重：同一件事只留一条，补重要度、延长稳定度；
 * - refs：挂上这次说到的实体（工作区/分类/人/工具/文件），以后靠它被「触达」；
 * - 冲突：同一主体同一类型的旧说法（偏好变了之类）归档并记 superseded_by——不删，记忆页能看到。
 */
export function write({
  text,
  layer = 'semantic',
  kind = 'fact',
  tags = [],
  importance = 0.5,
  source = 'chat',
  domain = 'work',
  subject = null,
  valence = null,
  arousal = null,
  refs = null
}) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  if (!LAYERS.has(layer)) layer = 'semantic';
  domain = domainOf(domain);
  importance = clamp(importance, 0, 1);
  const feel = { valence: valence == null ? null : clamp(valence, -1, 1), arousal: arousal == null ? null : clamp(arousal, 0, 1) };
  const linked = refsForMemory(clean, { domain, refs });

  const dup = findSame(clean, layer, domain);
  if (dup) {
    // 同一件事又被提起（原话一样，或者只是说法稍有不同）：不重复记，而是更重要一点、记得更牢，淡忘的重新想起来。
    // 如果它之前被后来的说法替代过，这次重新提起就是又改回来了：把替代它的那条也归档。
    const supersededBy = dup.superseded_by || null;
    db.prepare('UPDATE memories SET importance = MAX(importance, ?), subject = COALESCE(subject, ?), archived = 0, superseded_by = NULL, valid_to = NULL WHERE id = ?').run(importance, subject, dup.id);
    if (supersededBy) {
      db.prepare('UPDATE memories SET archived = 1, superseded_by = ?, valid_to = ? WHERE id = ? AND COALESCE(archived, 0) = 0').run(dup.id, now(), supersededBy);
    }
    reinforce(dup.id);
    linkRefs(dup.id, linked);
    return get(dup.id);
  }

  const superseded = findSupersedable(clean, { layer, kind, domain, subject });
  const id = uid('m_');
  const stamp = now();
  db.prepare(`
    INSERT INTO memories(id, layer, kind, text, tags, importance, source, created_at, use_count, domain, stability, valence, arousal, subject, archived, valid_from)
    VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,?,0,?)
  `).run(
    id, layer, kind, clean, JSON.stringify(tags), importance, source, stamp, domain,
    initialStability(layer, importance, feel.arousal || 0), feel.valence, feel.arousal, subject, stamp
  );
  linkRefs(id, linked);
  if (superseded) {
    db.prepare('UPDATE memories SET archived = 1, superseded_by = ?, valid_to = ? WHERE id = ?').run(id, stamp, superseded.id);
    // 新旧之间连边：supersedes 记「谁替代了谁」，conflict 记「这两条是冲突的」。
    const [a, b] = edgePair(superseded.id, id);
    db.prepare("INSERT OR IGNORE INTO memory_edges(a,b,kind,weight,co_count,created_at,last_fired_at) VALUES(?,?,'supersedes',1,1,?,NULL)").run(a, b, stamp);
    db.prepare("INSERT OR IGNORE INTO memory_edges(a,b,kind,weight,co_count,created_at,last_fired_at) VALUES(?,?,'conflict',0.8,1,?,NULL)").run(a, b, stamp);
  }
  return get(id);
}

/** 兼容旧调用：remember 就是 write。 */
export function remember(options) {
  return write(options);
}

/** 给这条记忆挂实体引用（重复的忽略）。 */
function linkRefs(memoryId, refs) {
  if (!refs?.length) return 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO memory_refs(memory_id, kind, key, role, weight, created_at)
    VALUES(?,?,?, 'about', 1, ?)
  `);
  let added = 0;
  for (const ref of refs) added += stmt.run(memoryId, ref.kind, ref.key, now()).changes;
  return added;
}

/** 记忆挂了哪些实体（记忆页/测试用）。 */
export function refsOf(memoryId) {
  return db.prepare('SELECT kind, key FROM memory_refs WHERE memory_id = ? ORDER BY kind, key').all(memoryId);
}

/* ------------------------------- 记忆之间的边 ------------------------------- */

const DAY_MS = 86400000;
const EDGE_MAX = 2;
const EDGE_MIN = 0.1;
const CO_ACTIVATE_COOLDOWN = DAY_MS;

/** a/b 按字典序排，正反只存一条。 */
function edgePair(x, y) {
  return String(x) < String(y) ? [String(x), String(y)] : [String(y), String(x)];
}

function clampEdge(weight) {
  return Math.min(EDGE_MAX, Math.max(EDGE_MIN, Number(weight) || EDGE_MIN));
}

/** 同一工作区里上一条任务结果：用来把结果按时间串成 before 边。 */
export function previousTaskResult(excludeId, workspaceKey) {
  if (!workspaceKey) return null;
  return db.prepare(`
    SELECT m.id FROM memories m JOIN memory_refs r ON r.memory_id = m.id
    WHERE r.kind = 'workspace' AND r.key = ? AND m.kind = 'task_result' AND m.id <> ?
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
  `).get(String(workspaceKey), String(excludeId))?.id || null;
}

/** 把两条任务结果按时间串起来（older → newer）。before 是有向的，不按字典序存。 */
export function linkBefore(olderId, newerId) {
  if (!olderId || !newerId || olderId === newerId) return 0;
  return db.prepare(`
    INSERT OR IGNORE INTO memory_edges(a, b, kind, weight, co_count, created_at, last_fired_at)
    VALUES(?,?, 'before', 0.4, 1, ?, NULL)
  `).run(String(olderId), String(newerId), now()).changes;
}

/**
 * 给一条记忆连上别的记忆（同一次任务、同一主题）。
 * 已经存在的边不重复插；返回新增条数。
 */
export function linkMemories(from, toIds, kind = 'same_topic', weight = 0.6) {
  const source = String(from || '');
  if (!source) return 0;
  const sourceDomain = db.prepare('SELECT domain FROM memories WHERE id = ?').get(source)?.domain;
  if (!sourceDomain) return 0;
  const targets = [...new Set((Array.isArray(toIds) ? toIds : [toIds]).map(String).filter((id) => id && id !== source))]
    .filter((id) => db.prepare('SELECT domain FROM memories WHERE id = ?').get(id)?.domain === sourceDomain)
    .slice(0, 8);
  if (!targets.length) return 0;
  const stamp = now();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO memory_edges(a, b, kind, weight, co_count, created_at, last_fired_at)
    VALUES(?,?,?,?,1,?,NULL)
  `);
  let added = 0;
  for (const id of targets) {
    const [a, b] = edgePair(source, id);
    added += stmt.run(a, b, kind, clampEdge(weight), stamp).changes;
  }
  return added;
}

/**
 * 同一次被想起的几条互相连边（赫布式：一起出现就更容易一起出现）。
 * 24 小时内同一对只长一次，权重封顶 2，避免越用越密。
 */
export function coActivate(ids, { at = Date.now() } = {}) {
  const list = [...new Set((ids || []).map(String))].slice(0, 4);
  if (list.length < 2) return 0;
  const stamp = new Date(at).toISOString();
  let changed = 0;
  const find = db.prepare("SELECT weight, last_fired_at FROM memory_edges WHERE a = ? AND b = ? AND kind = 'same_topic'");
  const insert = db.prepare("INSERT INTO memory_edges(a, b, kind, weight, co_count, created_at, last_fired_at) VALUES(?,?,'same_topic',0.5,1,?,?)");
  const bump = db.prepare("UPDATE memory_edges SET weight = MIN(2, weight + 0.2), co_count = co_count + 1, last_fired_at = ? WHERE a = ? AND b = ? AND kind = 'same_topic'");
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const [a, b] = edgePair(list[i], list[j]);
      const row = find.get(a, b);
      if (!row) { insert.run(a, b, stamp, stamp); changed += 1; continue; }
      const last = row.last_fired_at ? Date.parse(row.last_fired_at) : 0;
      if (!Number.isFinite(last) || at - last >= CO_ACTIVATE_COOLDOWN) {
        bump.run(stamp, a, b);
        changed += 1;
      }
    }
  }
  return changed;
}

/** 一条记忆的邻居（带边权和记忆整行）；只取同一个域，可选放行已淡忘的。 */
function neighborsOf(id, { domain, allowArchived = false, at = Date.now(), limit = 3 } = {}) {
  return db.prepare(`
    SELECT e.weight, m.* FROM memory_edges e
    JOIN memories m ON m.id = CASE WHEN e.a = ? THEN e.b ELSE e.a END
    WHERE (e.a = ? OR e.b = ?) AND m.domain = ?
      AND (COALESCE(m.archived, 0) = 0 OR ?)
      AND (m.valid_to IS NULL OR m.valid_to > ?)
    ORDER BY e.weight DESC, m.importance DESC LIMIT ?
  `).all(id, id, id, domain, allowArchived ? 1 : 0, new Date(at).toISOString(), limit);
}

/** 和当前触达点挂在一起的、已经淡忘的记忆（冷层）：只在强命中时回来。 */
function coldCandidates(domain, refs, stamp) {
  const clauses = refs.map(() => '(r.kind = ? AND r.key = ?)');
  const args = refs.flatMap((ref) => [ref.kind, ref.key]);
  return db.prepare(`
    SELECT DISTINCT m.* FROM memories m JOIN memory_refs r ON r.memory_id = m.id
    WHERE m.domain = ? AND COALESCE(m.archived, 0) = 1 AND m.superseded_by IS NULL
      AND (m.valid_to IS NULL OR m.valid_to > ?) AND (${clauses.join(' OR ')})
    ORDER BY m.importance DESC LIMIT 20
  `).all(domain, stamp, ...args);
}

export function get(id) {
  return hydrate(db.prepare('SELECT * FROM memories WHERE id = ?').get(id));
}

// 说法不同、意思一样的两条记忆：二元组 Dice 相似度到这个程度就算同一件事。
// 「下周三要交季度报告」和「下周四要交季度报告」大约 0.75，不会被并掉。
const SAME_MEMORY = 0.85;

/** 找一条和它是同一件事的记忆：事实和画像互相比，经历只和经历比。 */
function findSame(text, layer, domain) {
  const exact = db.prepare('SELECT * FROM memories WHERE text = ? AND layer = ? AND domain = ?').get(text, layer, domain);
  if (exact) return exact;
  const group = layer === 'profile' || layer === 'semantic' ? ['profile', 'semantic'] : [layer];
  const peers = db.prepare(`
    SELECT * FROM memories WHERE domain = ? AND layer IN (${group.map(() => '?').join(',')})
    ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 400
  `).all(domain, ...group);
  let best = null;
  let bestScore = 0;
  for (const row of peers) {
    const score = similarity(text, row.text);
    if (score > bestScore) { best = row; bestScore = score; }
  }
  return bestScore >= SAME_MEMORY ? best : null;
}

// 会被「新说法」替代的类型：偏好、画像、事实、手动记的笔记。
// 经历（episodic）和日记不参与：发生过的事不会因为后来又说了一句就被替代。
const SUPERSEDABLE_KINDS = new Set(['preference', 'profile', 'fact', 'note']);
// 新说法里出现这些字，说明是在更新/否定旧说法，而不是补充一件新事。
// 只认明确的「换掉/不要了」说法；单独的「不」「没」「现在」太容易误伤，宁可漏也先不替代。
const CHANGE_MARK = /(?:不再|不用|不要|别用|不喜欢|不爱|不想|改成|换成|改为|换为|改到|换到|改回|换回|取消|停止|作废|重新|以后不|现在不|已经不用|已经改成)/;

/**
 * 找一条「被这句话更新掉」的旧记忆：同一主体、同一类型、说法相近，并且新说法在否定/更新它。
 * 只挑最像的一条；宁可漏，不要误杀。命中后旧条目归档并记 superseded_by，不删除。
 */
function findSupersedable(text, { layer, kind, domain, subject }) {
  if (!SUPERSEDABLE_KINDS.has(kind) && layer !== 'profile') return null;
  if (String(text).length < 4) return null;
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE domain = ? AND subject IS ? AND kind = ?
      AND COALESCE(archived, 0) = 0 AND superseded_by IS NULL
    ORDER BY created_at DESC LIMIT 100
  `).all(domain, subject ?? null, kind);
  // 只有明确在更新/否定的说法才替代；单纯补一条同类偏好（「喜欢用 vim」之后「喜欢用 emacs」）
  // 不动旧的——宁可留着两条，也不要自动把旧信息藏掉。
  if (!CHANGE_MARK.test(text)) return null;
  const threshold = 0.5;
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = similarity(text, row.text);
    if (score > bestScore) { best = row; bestScore = score; }
  }
  return bestScore >= threshold ? best : null;
}

/** 想起一次：间隔越久、当时越模糊，巩固得越多。 */
export function reinforce(id, at = Date.now()) {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!row) return null;
  const r = retention(row, at);
  const next = Math.min(MAX_STABILITY, stabilityOf(row) * (1.1 + 0.8 * (1 - r)));
  db.prepare('UPDATE memories SET stability = ?, last_used_at = ?, use_count = use_count + 1, archived = 0 WHERE id = ?')
    .run(next, new Date(at).toISOString(), id);
  return next;
}

/**
 * 列出记忆。domain 默认业务；传 'all' 或 null 两个域都列（记忆页、导出）。
 * archived：false 只要还记得的（默认），true 只要已淡忘的，'all' 都要。
 */
export function list({ layer, limit = 100, domain = 'work', archived = false, subject } = {}) {
  const scope = domainOf(domain, { allowAll: true });
  const where = [];
  const args = [];
  if (layer) { where.push('layer = ?'); args.push(layer); }
  if (scope) { where.push('domain = ?'); args.push(scope); }
  if (archived !== 'all') { where.push('COALESCE(archived, 0) = ?'); args.push(archived ? 1 : 0); }
  if (subject !== undefined) { where.push('subject IS ?'); args.push(subject); }
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
    layer: LAYERS.has(patch.layer) ? patch.layer : current.layer,
    domain: DOMAINS.includes(patch.domain) ? patch.domain : current.domain || 'work',
    kind: patch.kind === undefined ? current.kind : String(patch.kind || current.kind),
    tags: Array.isArray(patch.tags) ? patch.tags.map(String) : current.tags,
    importance: patch.importance === undefined ? current.importance : clamp(patch.importance, 0, 1),
    archived: patch.archived === undefined ? current.archived : Boolean(patch.archived)
  };
  if (!next.text) throw new Error('记忆内容不能为空');
  db.prepare('UPDATE memories SET text = ?, layer = ?, domain = ?, kind = ?, tags = ?, importance = ?, archived = ? WHERE id = ?')
    .run(next.text, next.layer, next.domain, next.kind, JSON.stringify(next.tags), next.importance, next.archived ? 1 : 0, id);
  // 从淡忘里找回来：当作刚想起一次。
  if (current.archived && !next.archived) reinforce(id);
  return get(id);
}

export function forget(id) {
  const removed = db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  if (removed) {
    // 边和引用一起清掉，别留下指向已删记忆的悬空记录（记忆页删除时立刻生效）。
    db.prepare('DELETE FROM memory_edges WHERE a = ? OR b = ?').run(id, id);
    db.prepare('DELETE FROM memory_refs WHERE memory_id = ?').run(id);
    db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id);
  }
  return removed;
}

function likeEscape(q) {
  return q.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * 按内容搜。domain 默认业务；传 'all' 或 null 两个域都搜（记忆页）。
 * touch=true 表示这是静静在「回想」（会巩固记忆）；记忆页里翻看不算。
 */
export function search(query, limit = 12, { domain = 'work', touch = false, archived = false, validOnly = false } = {}) {
  const q = String(query || '').trim();
  if (!q) return list({ limit, domain, archived });
  const scope = domainOf(domain, { allowAll: true });
  const filters = [];
  const filterArgs = [];
  if (scope) { filters.push('m.domain = ?'); filterArgs.push(scope); }
  if (archived !== 'all') { filters.push('COALESCE(m.archived, 0) = ?'); filterArgs.push(archived ? 1 : 0); }
  if (validOnly) { filters.push('(m.valid_to IS NULL OR m.valid_to > ?)'); filterArgs.push(new Date().toISOString()); }
  const extra = filters.length ? ` AND ${filters.join(' AND ')}` : '';
  const rows = [];
  if ([...q].length >= 3) {
    try {
      const match = '"' + q.replace(/"/g, '""') + '"';
      rows.push(...db.prepare(`
        SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
        WHERE memories_fts MATCH ?${extra} ORDER BY rank LIMIT ?
      `).all(match, ...filterArgs, limit));
    } catch { /* fall back to LIKE */ }
  }
  if (rows.length < limit) {
    const pattern = '%' + likeEscape(q) + '%';
    rows.push(...db.prepare(`
      SELECT m.* FROM memories m WHERE (m.text LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\')${extra}
      ORDER BY m.importance DESC, m.created_at DESC LIMIT ?
    `).all(pattern, pattern, ...filterArgs, limit));
  }
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= limit) break;
  }
  if (touch) for (const m of out) reinforce(m.id);
  return out.map((row) => get(row.id));
}

/* ------------------------------- 相关度 -------------------------------- */

// 只由这些字组成的二元组不算关键词（「你还」「我的」「了吗」……），免得问句本身把无关记忆拉上来。
const STOP_CHARS = new Set([...'的了吗呢吧啊呀哦嗯是在我你他她它们这那个一不也就都还有和与及或很太再又把被给让对向从到为着过么什怎样吗嘛呗啦哈得地之其而且但如果所以因此可以要会能想说问记']);

function grams(text) {
  const clean = String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ');
  const out = new Set();
  for (const word of clean.match(/[a-z0-9]{2,}/g) || []) out.add(word);
  const han = clean.replace(/[a-z0-9 ]+/g, ' ');
  for (const chunk of han.split(' ')) {
    const chars = [...chunk];
    for (let i = 0; i < chars.length - 1; i += 1) {
      if (STOP_CHARS.has(chars[i]) && STOP_CHARS.has(chars[i + 1])) continue;
      out.add(chars[i] + chars[i + 1]);
    }
    if (chars.length === 1 && !STOP_CHARS.has(chars[0])) out.add(chars[0]);
  }
  return out;
}

/** 两段文字有多相关（0–1）：共有关键词占较短一方的比例。中文按二元组切，不需要分词。 */
export function relevance(query, text) {
  const a = grams(query);
  const b = grams(text);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

/** 两段文字整体上有多像（0–1，Dice 系数）：人设改动幅度用。 */
export function similarity(a, b) {
  const x = grams(a);
  const y = grams(b);
  if (!x.size && !y.size) return 1;
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const g of x) if (y.has(g)) hit += 1;
  return (2 * hit) / (x.size + y.size);
}

/**
 * 回想：从记忆里挑出和眼下最相关的几条，并巩固它们。
 * subjects：只看关于这些人的记忆（null 表示不限；给外人用时传 [null, 'self', 对方]，别人的事不往外说）。
 */
export function recall(query, { limit = 8, domain = 'work', subjects = null, focus = null, reinforceHits = true, at = Date.now(), refs = [] } = {}) {
  const scope = domainOf(domain);
  const stamp = new Date(at).toISOString();
  const pool = new Map();
  const add = (rows) => { for (const row of rows) if (!pool.has(row.id)) pool.set(row.id, row); };
  const base = 'SELECT * FROM memories WHERE domain = ? AND COALESCE(archived, 0) = 0 AND (valid_to IS NULL OR valid_to > ?)';
  add(db.prepare(`${base} ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 200`).all(scope, stamp));
  add(db.prepare(`${base} ORDER BY importance DESC LIMIT 60`).all(scope, stamp));
  if (query) add(search(query, 30, { domain: scope, validOnly: true }));
  // 已经淡忘、但当初就挂在这些触达点上的记忆：强命中时允许回来（冷层）；被新说法替代过的不算。
  const coldIds = new Set();
  if (refs?.length) {
    for (const row of coldCandidates(scope, refs, stamp)) {
      coldIds.add(row.id);
      add([row]);
    }
  }
  // 情境触达：当前工作区/分类/人/工具/文件对上的记忆加分（文本里提到 + 写入时挂过引用），
  // 这样"消息里没提那个项目"也能把项目里的旧经验捞出来。
  const touched = refs?.length ? touchedRefs([...pool.keys()], refs) : new Map();
  const allowed = subjects ? new Set(subjects) : null;
  const mentioned = new Map();
  const baseScore = (m) => {
    const r = retention(m, at);
    const rel = query ? relevance(query, `${m.text} ${m.tags || ''}`) : 0;
    const hits = refs?.length ? refMatches(`${m.text} ${m.tags || ''}`, refs) : 0;
    mentioned.set(m.id, hits);
    return 1.2 * rel
      + 0.5 * r
      + 0.4 * (m.importance ?? 0.5)
      + 0.25 * (m.arousal || 0)
      + (focus && m.subject === focus ? 0.4 : 0)
      + (m.layer === 'profile' ? 0.15 : 0)
      + 0.8 * Math.min(hits, 3)
      + 1.0 * Math.min(touched.get(m.id) || 0, 3);
  };
  const baseScores = new Map();
  for (const m of pool.values()) baseScores.set(m.id, baseScore(m));

  // 联想：从分最高的几条出发，沿边扩散 1–2 跳；每跳衰减，每个种子最多带 3 个邻居。
  const activation = new Map();
  const activate = (id, value) => {
    if (!(value > 0)) return;
    activation.set(id, Math.max(activation.get(id) || 0, value));
  };
  const seeds = [...baseScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [id, score] of seeds) {
    if (score < 0.7) continue;
    // 只有「这条记忆是当前触达点直接命中的」才允许顺着它把淡忘的邻居拉回来。
    const strong = (touched.get(id) || 0) > 0 || (mentioned.get(id) || 0) > 0;
    for (const row of neighborsOf(id, { domain: scope, allowArchived: strong, at, limit: 3 })) {
      if (allowed && !allowed.has(row.subject ?? null)) continue;
      if (!pool.has(row.id)) pool.set(row.id, row);
      activate(row.id, score * clampEdge(row.weight) * 0.5);
    }
  }
  const hop1 = [...activation.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [id, score] of hop1) {
    for (const row of neighborsOf(id, { domain: scope, allowArchived: false, at, limit: 2 })) {
      if (row.id === id) continue;
      if (allowed && !allowed.has(row.subject ?? null)) continue;
      if (!pool.has(row.id)) pool.set(row.id, row);
      activate(row.id, score * clampEdge(row.weight) * 0.25);
    }
  }

  const scored = [];
  for (const m of pool.values()) {
    if (allowed && !allowed.has(m.subject ?? null)) continue;
    if (!baseScores.has(m.id)) baseScores.set(m.id, baseScore(m));
    // 冷层排在同分之前先打个折：只有真的很相关时才回来。
    const score = (baseScores.get(m.id) + (activation.get(m.id) || 0)) * (coldIds.has(m.id) ? 0.7 : 1);
    scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, limit).map((item) => item.m);
  if (reinforceHits) for (const m of picked) reinforce(m.id, at);
  return picked.map((m) => {
    const item = get(m.id);
    if (!item) return null;
    const act = activation.get(m.id);
    if (act) item.activated = Number(act.toFixed(2));
    if (coldIds.has(m.id)) item.cold = true;
    return item;
  }).filter(Boolean);
}

/** 拼装可注入提示词的记忆上下文。Router / Worker 用业务域（默认）；静静以自己身份说话时用 persona。 */
export function context(query, { limit = 6, domain = 'work', subjects = null, focus = null, refs = [] } = {}) {
  return recall(query, { limit: limit + 4, domain, subjects, focus, refs });
}

/** 这几条记忆里有哪些挂过这些实体（一次查完，按 memory_id 计数）。 */
function touchedRefs(ids, refs) {
  const out = new Map();
  const want = new Set(refs.map((ref) => `${ref.kind}:${ref.key}`));
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db.prepare(`
      SELECT memory_id, kind, key FROM memory_refs
      WHERE memory_id IN (${chunk.map(() => '?').join(',')})
    `).all(...chunk);
    for (const row of rows) {
      if (!want.has(`${row.kind}:${row.key}`)) continue;
      out.set(row.memory_id, (out.get(row.memory_id) || 0) + 1);
    }
  }
  return out;
}

/** 记忆正文里提到了几个当前实体（最多算 3 个，避免一条长记忆把分刷满）。 */
function refMatches(text, refs) {
  let hits = 0;
  for (const ref of refs) {
    if (hits >= 3) break;
    if (hasName(text, ref.name)) hits += 1;
  }
  return hits;
}

function agoText(iso, at = Date.now()) {
  const days = Math.floor((at - Date.parse(iso)) / DAY);
  if (!Number.isFinite(days) || days < 1) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

const LAYER_NAME = { profile: '画像', semantic: '事实', episodic: '经历', working: '眼下' };

export function serializeForPrompt(items) {
  return items
    .map((m) => {
      const when = m.layer === 'episodic' ? `·${agoText(m.created_at)}` : '';
      const fuzzy = m.retention !== undefined && m.retention < 0.3 ? '（记得不太清了）' : '';
      return `- [${LAYER_NAME[m.layer] || m.layer}${when}] ${m.text}${fuzzy}${m.tags?.length ? `（标签：${m.tags.join('、')}）` : ''}`;
    })
    .join('\n');
}

/* ------------------------------- 整理 -------------------------------- */

/**
 * 每天整理一次（反思之前做）：
 * - 快忘光（保持率 < 5%）、又不太重要的情景 / 工作记忆归档（不删，记忆页「已淡忘」里能看到，想起时会回来）；
 * - 被想起过 3 次以上的情景记忆转成语义记忆：反复用到的经历变成了「知道的事」。
 */
export function maintain(at = Date.now()) {
  let faded = 0;
  let consolidated = 0;
  const rows = db.prepare("SELECT * FROM memories WHERE COALESCE(archived, 0) = 0 AND layer IN ('episodic', 'working')").all();
  const fade = db.prepare('UPDATE memories SET archived = 1 WHERE id = ?');
  const promote = db.prepare("UPDATE memories SET layer = 'semantic', stability = MAX(COALESCE(stability, 0), ?) WHERE id = ?");
  for (const m of rows) {
    if (m.use_count >= 3 && m.layer === 'episodic') {
      promote.run(initialStability('semantic', m.importance, m.arousal || 0), m.id);
      consolidated += 1;
    } else if (retention(m, at) < 0.05 && (m.importance ?? 0.5) < 0.75) {
      fade.run(m.id);
      faded += 1;
    }
  }
  // 联想边也会腐烂：同主题的慢慢衰减，太弱又很久没一起出现的剪掉；指向已删记忆的边一并清掉。
  let edges = 0;
  try {
    db.prepare("UPDATE memory_edges SET weight = weight * 0.98 WHERE kind = 'same_topic'").run();
    db.prepare("UPDATE memory_edges SET weight = weight * 0.99 WHERE kind = 'similar'").run();
    edges += db.prepare(`
      DELETE FROM memory_edges
      WHERE kind = 'same_topic' AND weight < 0.1
        AND (last_fired_at IS NULL OR last_fired_at < ?)
    `).run(new Date(at - 90 * DAY_MS).toISOString()).changes;
    edges += db.prepare("DELETE FROM memory_edges WHERE kind = 'similar' AND weight < 0.1").run().changes;
    edges += db.prepare('DELETE FROM memory_edges WHERE a NOT IN (SELECT id FROM memories) OR b NOT IN (SELECT id FROM memories)').run().changes;
    db.prepare('DELETE FROM memory_vectors WHERE memory_id NOT IN (SELECT id FROM memories)').run();
  } catch (err) {
    console.warn('[memory] 整理记忆边失败：', err.message);
  }
  return { faded, consolidated, edges };
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

  // 长的说法放前面：「帮我记住：X」要整句认成「帮我记住」，不能先被「帮我记」吃掉、剩下「住：X」。
  const explicit = text.match(/(?:帮我记住|帮我记下|帮我记一下|请记住|记住|记一下|记下|帮我记)[：:，,\s]*(.+)/);
  if (explicit) push(explicit[1], 'note', 0.7);

  const pref = text.match(/我(?:更)?(?:喜欢|偏好|习惯|通常|一般|不喜欢|讨厌)([^。！？!?\n]+)/);
  if (pref) push(`${userName}${text.includes('不喜欢') || text.includes('讨厌') ? '不喜欢' : '喜欢/习惯'}：${pref[1]}`, 'preference', 0.75);

  const mine = text.match(/我的([^\s，,。！？!?]{1,12})是([^。！？!?\n]+)/);
  if (mine) push(`${userName}的${mine[1]}是${mine[2]}`, 'profile', 0.8);

  const later = text.match(/(?:以后|今后|下次)(?:都|请|要)?([^。！？!?\n]{2,})/);
  if (later) push(`以后${later[1]}`, 'preference', 0.65);

  return facts;
}

/** 各层条数（不含已淡忘的）；给了 domain 只数那个域。 */
export function allLayersStats({ domain = null } = {}) {
  const scope = domainOf(domain, { allowAll: true });
  return scope
    ? db.prepare('SELECT layer, COUNT(*) AS count FROM memories WHERE domain = ? AND COALESCE(archived, 0) = 0 GROUP BY layer').all(scope)
    : db.prepare('SELECT layer, COUNT(*) AS count FROM memories WHERE COALESCE(archived, 0) = 0 GROUP BY layer').all();
}

/** 已淡忘的有多少条。 */
export function archivedCount({ domain = null } = {}) {
  const scope = domainOf(domain, { allowAll: true });
  return scope
    ? db.prepare('SELECT COUNT(*) AS c FROM memories WHERE domain = ? AND archived = 1').get(scope).c
    : db.prepare('SELECT COUNT(*) AS c FROM memories WHERE archived = 1').get().c;
}

/**
 * 记忆页的图谱：取当前域里重要 / 常想起的记忆，连同它们挂的实体和之间的边。
 * 只读、限量；不参与召回，纯展示。
 */
export function graph({ domain = 'work', limit = 120 } = {}) {
  const scope = domainOf(domain);
  const rows = db.prepare(`
    SELECT id, layer, kind, text, importance, created_at FROM memories
    WHERE domain = ? AND COALESCE(archived, 0) = 0
    ORDER BY importance DESC, COALESCE(last_used_at, created_at) DESC
    LIMIT ?
  `).all(scope, limit);
  if (!rows.length) return { nodes: [], links: [] };
  const ids = rows.map((row) => row.id);
  const marks = ids.map(() => '?').join(',');
  const refs = db.prepare(`SELECT memory_id, kind, key FROM memory_refs WHERE memory_id IN (${marks})`).all(...ids);
  const edges = db.prepare(`SELECT a, b, kind, weight FROM memory_edges WHERE a IN (${marks}) AND b IN (${marks})`).all(...ids, ...ids);
  const known = new Map(listEntities().map((entity) => [`${entity.kind}:${entity.key}`, entity.name]));
  const nodes = rows.map((row) => ({
    id: row.id,
    type: 'memory',
    layer: row.layer,
    kind: row.kind,
    title: row.text.slice(0, 80),
    text: row.text.slice(0, 600),
    importance: row.importance
  }));
  const links = [];
  const seen = new Set();
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.key}`;
    if (!seen.has(key)) {
      seen.add(key);
      nodes.push({ id: `entity:${key}`, type: 'entity', entityKind: ref.kind, title: known.get(key) || ref.key });
    }
    links.push({ source: ref.memory_id, target: `entity:${key}`, kind: 'ref' });
  }
  for (const edge of edges) links.push({ source: edge.a, target: edge.b, kind: edge.kind, weight: edge.weight });
  return { nodes, links };
}

/** 两个域各有多少条（记忆页的切换标签用，不含已淡忘的）。 */
export function domainStats() {
  const counts = Object.fromEntries(DOMAINS.map((d) => [d, 0]));
  for (const row of db.prepare('SELECT domain, COUNT(*) AS count FROM memories WHERE COALESCE(archived, 0) = 0 GROUP BY domain').all()) {
    counts[domainOf(row.domain)] += row.count;
  }
  return counts;
}

/* ------------------------------- 实体引用 ------------------------------- */

// 回填版本：旧库第一次启动时给已有记忆补 refs；逻辑或参数变了就 +1，下次启动重跑。
const REFS_BACKFILL_VERSION = 1;

/**
 * 给还没有引用、或者老版本的记忆补上实体引用（幂等，可以重复跑）。
 * 用主题词表（工作区/分类/人/工具/文件）扫记忆正文，不调模型；人格域不自动挂业务实体。
 */
export function backfillMemoryRefs({ force = false, batch = 500 } = {}) {
  if (!force && Number(getSetting('memory_refs_backfill', 0)) >= REFS_BACKFILL_VERSION) return 0;
  const entities = listEntities();
  const rows = db.prepare('SELECT id, text, domain FROM memories').all();
  let added = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    transaction(() => {
      for (const row of chunk) {
        if (domainOf(row.domain) !== 'work') continue;
        added += linkRefs(row.id, matchEntities(row.text, { entities }));
      }
    });
  }
  setSetting('memory_refs_backfill', REFS_BACKFILL_VERSION);
  return added;
}

/**
 * 社交记忆：静静认识的人。主人也在里面（id = owner）。
 * - 熟悉度（0–1）：每来往一次往上走一点，越熟涨得越慢；很久不联系每天掉一点。
 * - 好感（-1–1）：跟着聊天的情绪慢慢变，一两句话改变不了太多。
 * - 印象：一句话的描述，每天反思时由模型更新；没接模型时就没有，不瞎编。
 * 都是确定的计算；外人看不到主人的任何信息，主人可以在记忆页查看和改。
 */
import { db, now, getSettings, transaction } from './db.js';

export const OWNER = 'owner';
const DAY = 86400000;
const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));

/** 主人的称呼跟设置走；设置里还是默认的「你」时叫「主人」。 */
function ownerName() {
  const name = String(getSettings().userName || '').trim();
  return name && name !== '你' ? name : '主人';
}

// 名字从哪来，后面的盖前面的：id → 插件给的 → 聊天里说的 → 通讯录 → 主人改的。
const NAME_RANK = { id: 0, source: 1, chat: 2, directory: 3, manual: 4 };
const rankOf = (from) => NAME_RANK[from] ?? NAME_RANK.id;

function hydrate(row) {
  if (!row) return null;
  let profile = null;
  try { profile = row.profile ? JSON.parse(row.profile) : null; } catch { profile = null; }
  const person = { ...row, profile };
  return row.id === OWNER ? { ...person, name: ownerName() } : person;
}

/** 合并过的身份指向同一个人：别的来源里的 id 先换成那个人的 id。 */
export function resolve(id) {
  const row = db.prepare('SELECT person_id FROM people_aliases WHERE alias_id = ?').get(id);
  return row ? row.person_id : id;
}

export function get(id) {
  return hydrate(db.prepare('SELECT * FROM people WHERE id = ?').get(resolve(id)));
}

export function list({ limit = 100 } = {}) {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.requester = p.id) AS requested,
      (SELECT json_group_array(alias_id) FROM people_aliases a WHERE a.person_id = p.id) AS aliases_json
    FROM people p ORDER BY (p.id = ?) DESC, p.last_seen DESC LIMIT ?
  `).all(OWNER, limit).map((row) => {
    const { aliases_json: aliasesJson, ...rest } = row;
    return { ...hydrate(rest), aliases: JSON.parse(aliasesJson || '[]') };
  });
}

/** 这个人派过的活（只给主人那边用：外人看不到任务）。 */
export function requestedTasks(id, limit = 5) {
  const person = get(id);
  if (!person) return [];
  return db.prepare('SELECT id, title, status, created_at FROM tasks WHERE requester = ? ORDER BY created_at DESC LIMIT ?').all(person.id, limit);
}

/**
 * 确保有这个人；没有就新建。主人的名字跟设置里的称呼走。
 * sourceId / externalId：这个人来自哪个来源实例、在那边的 id（查通讯录用）。
 */
export function ensure(id, { name = '', source = '', sourceId = null, externalId = null } = {}) {
  const existing = get(id);
  if (existing) {
    if ((sourceId && !existing.source_id) || (externalId && !existing.external_id)) {
      db.prepare('UPDATE people SET source_id = COALESCE(source_id, ?), external_id = COALESCE(external_id, ?) WHERE id = ?')
        .run(sourceId, externalId, existing.id);
      return get(existing.id);
    }
    return existing;
  }
  const stamp = now();
  const given = String(name || '').trim();
  const display = id === OWNER ? ownerName() : (given || id.split(':').pop());
  db.prepare(`
    INSERT INTO people(id, name, name_from, source, source_id, external_id, first_seen, last_seen, interactions, familiarity, affinity, impression, updated_at)
    VALUES(?,?,?,?,?,?,?,?,0,?,?,NULL,?)
  `).run(id, display.slice(0, 40), given ? 'source' : 'id', source, sourceId, externalId, stamp, stamp,
    id === OWNER ? 0.6 : 0, id === OWNER ? 0.3 : 0, stamp);
  return get(id);
}

/** 来往了一次：熟悉一点，好感跟着这次的情绪动一点。 */
export function touch(id, { name = '', source = '', sourceId = null, externalId = null, valence = 0 } = {}) {
  const person = ensure(id, { name, source, sourceId, externalId });
  const familiarity = 1 - (1 - person.familiarity) * 0.92;
  const affinity = clamp(person.affinity * 0.97 + clamp(valence, -1, 1) * 0.12, -1, 1);
  const stamp = now();
  db.prepare('UPDATE people SET interactions = interactions + 1, familiarity = ?, affinity = ?, last_seen = ?, updated_at = ? WHERE id = ?')
    .run(familiarity, affinity, stamp, stamp, person.id);
  // 插件这次给了称呼：比只有 id 强，但盖不过聊天里说的、通讯录和主人改的。
  if (name) rename(person.id, name, { from: 'source' });
  return get(person.id);
}

/** 改称呼：from 的优先级不低于现在这个名字的来源才改（通讯录盖得过聊天里说的，盖不过主人改的）。 */
export function rename(id, name, { from = 'chat' } = {}) {
  const clean = String(name || '').trim().slice(0, 40);
  const person = get(id);
  if (!clean || !person || person.id === OWNER) return person;
  if (rankOf(from) < rankOf(person.name_from)) return person;
  if (clean === person.name && from === person.name_from) return person;
  db.prepare('UPDATE people SET name = ?, name_from = ?, updated_at = ? WHERE id = ?').run(clean, from, now(), person.id);
  return get(person.id);
}

/**
 * 通讯录查到的结果：名字（按优先级）、部门职位这些资料，记下查过的时间。
 * found = null 表示查过但没查到（或来源没开通讯录），只记时间，下次按周期再查。
 */
export function applyDirectory(id, found, at = now()) {
  const person = get(id);
  if (!person) return null;
  id = person.id;
  db.prepare('UPDATE people SET looked_up_at = ? WHERE id = ?').run(at, id);
  if (!found) return get(id);
  const profile = {};
  for (const key of ['title', 'department', 'alias']) {
    const value = String(found[key] || '').trim();
    if (value) profile[key] = value.slice(0, 80);
  }
  db.prepare('UPDATE people SET profile = ?, updated_at = ? WHERE id = ?')
    .run(Object.keys(profile).length ? JSON.stringify(profile) : null, now(), id);
  if (found.name) rename(id, found.name, { from: 'directory' });
  return get(id);
}

/** 该查通讯录的人：从来没查过的，或者上次查是 maxAgeMs 之前。按来源实例分组前由调用方过滤。 */
export function dueForLookup({ maxAgeMs = DAY, at = Date.now(), limit = 200 } = {}) {
  const before = new Date(at - maxAgeMs).toISOString();
  return db.prepare(`
    SELECT * FROM people
    WHERE id != ? AND source_id IS NOT NULL AND external_id IS NOT NULL AND (looked_up_at IS NULL OR looked_up_at < ?)
    ORDER BY (looked_up_at IS NULL) DESC, last_seen DESC LIMIT ?
  `).all(OWNER, before, limit).map(hydrate);
}

export function update(id, patch = {}) {
  const person = get(id);
  if (!person) return null;
  const nextName = patch.name === undefined ? '' : String(patch.name || '').trim().slice(0, 40);
  // 主人手动改的称呼最大，之后通讯录和聊天都不再覆盖。
  const manual = nextName && nextName !== person.name;
  const name = manual ? nextName : person.name;
  const impression = patch.impression === undefined ? person.impression : String(patch.impression || '').trim().slice(0, 200) || null;
  db.prepare(`UPDATE people SET name = ?, name_from = ${manual ? "'manual'" : 'name_from'}, impression = ?, updated_at = ? WHERE id = ?`)
    .run(name, impression, now(), person.id);
  return get(person.id);
}

/**
 * 忘掉这个人：人、和 ta 的聊天（原话和摘要）、关于 ta 的记忆、合并过的别的身份，一起删掉。
 * ta 派过的任务留着（那是主人的事），只是不再记是谁派的。以后 ta 再来就是个新认识的人。
 */
export function remove(id) {
  const person = get(id);
  if (!person) return false;
  if (person.id === OWNER) throw new Error('主人不能从认识的人里删掉');
  const pid = person.id;
  const session = `ext:${pid}`;
  transaction(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session);
    db.prepare('DELETE FROM sessions WHERE id = ? OR person_id = ?').run(session, pid);
    db.prepare('DELETE FROM memories WHERE subject = ?').run(pid);
    db.prepare('DELETE FROM people_aliases WHERE person_id = ?').run(pid);
    db.prepare('DELETE FROM people_distinct WHERE a = ? OR b = ?').run(pid, pid);
    db.prepare('UPDATE tasks SET requester = NULL WHERE requester = ?').run(pid);
    db.prepare('DELETE FROM people WHERE id = ?').run(pid);
  });
  return true;
}

/* ------------------------------ 合并同一个人 ------------------------------ */

const pairKey = (a, b) => (a < b ? [a, b] : [b, a]);
const sourceLabels = (...values) => [...new Set(values.flatMap((v) => String(v || '').split(' · ')).map((v) => v.trim()).filter(Boolean))].join(' · ');

/**
 * 把 otherId 并进 keepId：来往次数相加、熟悉度取高、好感按来往次数加权，名字按来源优先级，
 * 聊天、记忆、派过的活、别名都改到 keep 名下；other 的身份记成 keep 的别名，以后从那个来源来的也认成 keep。
 * 查通讯录的身份：keep 没有通讯录资料而 other 有时，改用 other 的（它的来源能查）。
 */
export function merge(keepId, otherId) {
  const keep = get(keepId);
  const other = get(otherId);
  if (!keep || !other) throw new Error('没有这个人');
  if (keep.id === other.id) return keep;
  if (keep.id === OWNER || other.id === OWNER) throw new Error('主人不能和别人合并');
  const total = keep.interactions + other.interactions;
  const affinity = total ? (keep.affinity * keep.interactions + other.affinity * other.interactions) / total : (keep.affinity + other.affinity) / 2;
  const byName = rankOf(other.name_from) > rankOf(keep.name_from) ? other : keep;
  const lookup = !keep.profile && other.profile ? other : keep;
  const stamp = now();
  const keepSession = `ext:${keep.id}`;
  const otherSession = `ext:${other.id}`;
  transaction(() => {
    db.prepare(`
      UPDATE people SET name = ?, name_from = ?, source = ?, source_id = ?, external_id = ?, profile = ?, looked_up_at = ?,
        first_seen = ?, last_seen = ?, interactions = ?, familiarity = ?, affinity = ?, impression = ?, updated_at = ?
      WHERE id = ?
    `).run(
      byName.name, byName.name_from || 'id', sourceLabels(keep.source, other.source),
      lookup.source_id, lookup.external_id, lookup.profile ? JSON.stringify(lookup.profile) : null, lookup.looked_up_at,
      keep.first_seen < other.first_seen ? keep.first_seen : other.first_seen,
      keep.last_seen > other.last_seen ? keep.last_seen : other.last_seen,
      total, Math.max(keep.familiarity, other.familiarity), clamp(affinity, -1, 1),
      keep.impression || other.impression || null, stamp, keep.id
    );
    // 聊天：other 的原话搬进 keep 的会话；摘要接在一起；整理进度取靠后的（不重复整理）。
    const a = db.prepare('SELECT * FROM sessions WHERE id = ?').get(keepSession);
    const b = db.prepare('SELECT * FROM sessions WHERE id = ?').get(otherSession);
    if (b && !a) {
      db.prepare('UPDATE sessions SET id = ?, person_id = ?, title = ? WHERE id = ?').run(keepSession, keep.id, `和${byName.name}的聊天`, otherSession);
    } else if (b) {
      const summary = [a.summary, b.summary].filter(Boolean).join('\n').slice(-1200);
      const upto = [a.encoded_upto, b.encoded_upto].filter(Boolean).sort().pop() || null;
      db.prepare('UPDATE sessions SET summary = ?, encoded_upto = ?, updated_at = ? WHERE id = ?').run(summary || null, upto, stamp, keepSession);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(otherSession);
    }
    db.prepare('UPDATE messages SET session_id = ? WHERE session_id = ?').run(keepSession, otherSession);
    db.prepare('UPDATE memories SET subject = ? WHERE subject = ?').run(keep.id, other.id);
    db.prepare('UPDATE tasks SET requester = ? WHERE requester = ?').run(keep.id, other.id);
    db.prepare('UPDATE people_aliases SET person_id = ? WHERE person_id = ?').run(keep.id, other.id);
    db.prepare('INSERT OR REPLACE INTO people_aliases(alias_id, person_id, created_at) VALUES(?,?,?)').run(other.id, keep.id, stamp);
    db.prepare('DELETE FROM people_distinct WHERE a = ? OR b = ?').run(other.id, other.id);
    db.prepare('DELETE FROM people WHERE id = ?').run(other.id);
  });
  return get(keep.id);
}

/** 主人说这两个不是同一个人：以后不再提示。 */
export function markDistinct(aId, bId) {
  const a = get(aId);
  const b = get(bId);
  if (!a || !b || a.id === b.id) return false;
  const [x, y] = pairKey(a.id, b.id);
  db.prepare('INSERT OR IGNORE INTO people_distinct(a, b, created_at) VALUES(?,?,?)').run(x, y, now());
  return true;
}

const nameKey = (text) => String(text || '').toLowerCase().replace(/\s+/g, '');

/**
 * 可能是同一个人：不同来源里，称呼（或通讯录里的英文名 / 别名）一模一样。只提示，不自动合并——同名的不同人并不少见。
 * 只看有真名的（名字不是 id 本身），主人说过不是的不再提。
 */
export function suggestions({ limit = 10 } = {}) {
  const rows = db.prepare("SELECT * FROM people WHERE id != ? AND COALESCE(name_from, 'id') != 'id'").all(OWNER).map(hydrate);
  const distinct = new Set(db.prepare('SELECT a, b FROM people_distinct').all().map((r) => `${r.a}\n${r.b}`));
  const byKey = new Map();
  for (const p of rows) {
    for (const key of new Set([nameKey(p.name), nameKey(p.profile?.alias)].filter((k) => k.length >= 2))) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(p);
    }
  }
  const seen = new Set();
  const out = [];
  for (const group of byKey.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const [p, q] = [group[i], group[j]];
        // 同一个来源里两个身份同名，多半是两个人（企微里两个张三 userid 不同）。
        if (p.source_id && p.source_id === q.source_id) continue;
        const [x, y] = pairKey(p.id, q.id);
        const key = `${x}\n${y}`;
        if (seen.has(key) || distinct.has(key)) continue;
        seen.add(key);
        // 留下有通讯录资料、来往多的那个当主身份。
        const keep = (q.profile && !p.profile) || (!!q.profile === !!p.profile && q.interactions > p.interactions) ? q : p;
        const other = keep === p ? q : p;
        out.push({ keep: { id: keep.id, name: keep.name, source: keep.source }, other: { id: other.id, name: other.name, source: other.source }, name: keep.name });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** 每天整理时：一周以上没来往的人，熟悉度慢慢往下掉（主人除外）。 */
export function drift(at = Date.now()) {
  let changed = 0;
  for (const p of db.prepare('SELECT * FROM people WHERE id != ?').all(OWNER)) {
    const idle = (at - Date.parse(p.last_seen)) / DAY;
    if (idle < 7) continue;
    db.prepare('UPDATE people SET familiarity = ?, updated_at = ? WHERE id = ?').run(p.familiarity * 0.97, now(), p.id);
    changed += 1;
  }
  return changed;
}

function familiarityText(f) {
  if (f >= 0.7) return '很熟';
  if (f >= 0.4) return '比较熟';
  if (f >= 0.15) return '认识';
  return '不太熟';
}

function affinityText(a) {
  if (a >= 0.4) return '挺喜欢 ta';
  if (a >= 0.12) return '印象不错';
  if (a <= -0.4) return '不太喜欢 ta';
  if (a <= -0.12) return '有点提防';
  return '没什么特别的感觉';
}

/** 写进提示词的一句「你和这个人的关系」。 */
export function describe(person, at = Date.now()) {
  if (!person) return '';
  const days = Math.max(0, Math.floor((at - Date.parse(person.first_seen)) / DAY));
  const known = days < 1 ? '今天刚认识' : `认识 ${days} 天`;
  const role = [person.profile?.department, person.profile?.title].filter(Boolean).join(' · ');
  return `${person.name}${role ? `（${role}）` : ''}：${known}，来往过 ${person.interactions} 次，${familiarityText(person.familiarity)}，${affinityText(person.affinity)}${person.impression ? `。你对 ta 的印象：${person.impression}` : ''}`;
}

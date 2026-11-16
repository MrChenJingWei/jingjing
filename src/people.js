/**
 * 社交记忆：静静认识的人。主人也在里面（id = owner）。
 * - 熟悉度（0–1）：每来往一次往上走一点，越熟涨得越慢；很久不联系每天掉一点。
 * - 好感（-1–1）：跟着聊天的情绪慢慢变，一两句话改变不了太多。
 * - 印象：一句话的描述，每天反思时由模型更新；没接模型时就没有，不瞎编。
 * 都是确定的计算；外人看不到主人的任何信息，主人可以在记忆页查看和改。
 */
import { db, now, getSettings } from './db.js';

export const OWNER = 'owner';
const DAY = 86400000;
const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));

/** 主人的称呼跟设置走；设置里还是默认的「你」时叫「主人」。 */
function ownerName() {
  const name = String(getSettings().userName || '').trim();
  return name && name !== '你' ? name : '主人';
}

function hydrate(row) {
  if (!row) return null;
  return row.id === OWNER ? { ...row, name: ownerName() } : { ...row };
}

export function get(id) {
  return hydrate(db.prepare('SELECT * FROM people WHERE id = ?').get(id));
}

export function list({ limit = 100 } = {}) {
  return db.prepare('SELECT * FROM people ORDER BY (id = ?) DESC, last_seen DESC LIMIT ?').all(OWNER, limit).map(hydrate);
}

/** 确保有这个人；没有就新建。主人的名字跟设置里的称呼走。 */
export function ensure(id, { name = '', source = '' } = {}) {
  const existing = get(id);
  if (existing) return existing;
  const stamp = now();
  const display = id === OWNER ? ownerName() : (String(name || '').trim() || id.split(':').pop());
  db.prepare(`
    INSERT INTO people(id, name, source, first_seen, last_seen, interactions, familiarity, affinity, impression, updated_at)
    VALUES(?,?,?,?,?,0,?,?,NULL,?)
  `).run(id, display.slice(0, 40), source, stamp, stamp, id === OWNER ? 0.6 : 0, id === OWNER ? 0.3 : 0, stamp);
  return get(id);
}

/** 来往了一次：熟悉一点，好感跟着这次的情绪动一点。 */
export function touch(id, { name = '', source = '', valence = 0 } = {}) {
  const person = ensure(id, { name, source });
  const familiarity = 1 - (1 - person.familiarity) * 0.92;
  const affinity = clamp(person.affinity * 0.97 + clamp(valence, -1, 1) * 0.12, -1, 1);
  const stamp = now();
  db.prepare('UPDATE people SET interactions = interactions + 1, familiarity = ?, affinity = ?, last_seen = ?, updated_at = ? WHERE id = ?')
    .run(familiarity, affinity, stamp, stamp, id);
  // 知道了对方的称呼（以前只有 id）就记上。
  if (name && person.name === id.split(':').pop()) rename(id, name);
  return get(id);
}

export function rename(id, name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return get(id);
  db.prepare('UPDATE people SET name = ?, updated_at = ? WHERE id = ?').run(clean, now(), id);
  return get(id);
}

export function update(id, patch = {}) {
  const person = get(id);
  if (!person) return null;
  const name = patch.name === undefined ? person.name : String(patch.name || '').trim().slice(0, 40) || person.name;
  const impression = patch.impression === undefined ? person.impression : String(patch.impression || '').trim().slice(0, 200) || null;
  db.prepare('UPDATE people SET name = ?, impression = ?, updated_at = ? WHERE id = ?').run(name, impression, now(), id);
  return get(id);
}

export function remove(id) {
  if (id === OWNER) throw new Error('主人不能从认识的人里删掉');
  return db.prepare('DELETE FROM people WHERE id = ?').run(id).changes > 0;
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
  return `${person.name}：${known}，来往过 ${person.interactions} 次，${familiarityText(person.familiarity)}，${affinityText(person.affinity)}${person.impression ? `。你对 ta 的印象：${person.impression}` : ''}`;
}

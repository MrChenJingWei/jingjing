/**
 * 记忆的「触达点」：把记忆和它说的事挂到同一组实体上（工作区、分类域、人、工具、文件）。
 *
 * 目的：很多记忆只在某个情境下才需要被想起（进了某个项目、和某个人有关、碰了某个工具），
 * 光靠字面命中会随记忆变多而漏掉。这里不依赖模型，只用已知名单做匹配：
 * - 工作区：settings.workspaces 的名字和别名，任务 cwd 落在哪个工作区；
 * - 分类域：task_categories 的标题（key 是内部 id，不拿来匹配文本）；
 * - 人：people 的名字和别名（主人不参与匹配，他一直都在）；
 * - 工具：常见的命令行工具名（拉丁字母按词边界匹配，避免 digit 命中 git）；
 * - 文件：文本里出现的、扩展名认识的文件名。
 *
 * 匹配是确定性的，不做词干/近义；宁可漏，不要错连。
 */
import path from 'node:path';
import { db, getSettings } from './db.js';
import { workspaceFor } from './permissions.js';

export const ENTITY_KINDS = ['workspace', 'category', 'person', 'tool', 'file'];
const KIND_CAP = { workspace: 2, category: 2, person: 3, tool: 3, file: 3 };
const MAX_REFS = 8;
const MAX_KEY = 200;
const MAX_NAME = 120;

// 只列真的会出现在对话里的工具名；拉丁名按词边界匹配，不会误伤普通单词。
const TOOLS = ['git', 'npm', 'pnpm', 'yarn', 'node', 'python', 'docker', 'gh', 'claude', 'codex', 'dsh', 'ollama', 'swift', 'xcode'];
const FILE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'css', 'html', 'yml', 'yaml', 'sql', 'py', 'go', 'rs', 'swift', 'sh', 'plist', 'xml', 'toml', 'ini', 'csv', 'txt']);

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 文本里有没有这个名字。
 * 拉丁字母（工具名、英文别名）要求前后不是字母数字，避免 digit 命中 git；
 * 中文按子串匹配（没有分词，两字以上才认，减少「主」「你」这类误伤）。
 */
export function hasName(text, name) {
  const hay = String(text || '').toLowerCase();
  const needle = String(name || '').trim().toLowerCase();
  if (needle.length < 2) return false;
  if (/^[\x20-\x7e]+$/.test(needle)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`).test(hay);
  }
  return hay.includes(needle);
}

/** 文本里出现的文件名（只认认识的后缀，最多 3 个）。 */
function filesIn(text) {
  const out = [];
  const source = String(text || '');
  const re = /[A-Za-z0-9_./~-]+\.([A-Za-z0-9]{1,8})\b/g;
  let match;
  while ((match = re.exec(source))) {
    const token = match[0];
    if (!FILE_EXT.has(match[1].toLowerCase())) continue;
    if (/^[a-z]+:\/\//i.test(token)) continue;
    const base = path.basename(token);
    if (!base || base.length > 120 || out.includes(base)) continue;
    out.push(base);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 已知实体清单。工作区/分类/人来自各自的事实来源，工具是常量。
 * 不单独建实体表：key 直接复用工作区 id、分类 key、people.id、工具名；换了显示名不用同步。
 */
export function listEntities(settings = getSettings()) {
  const list = [];
  for (const ws of settings.workspaces || []) {
    if (!ws?.id || !ws?.name) continue;
    list.push({ kind: 'workspace', key: ws.id, name: ws.name, aliases: (ws.aliases || []).filter(Boolean) });
  }
  for (const row of db.prepare("SELECT key, title FROM task_categories WHERE COALESCE(state, 'active') = 'active' AND title IS NOT NULL").all()) {
    if (!row.key || !row.title) continue;
    list.push({ kind: 'category', key: row.key, name: row.title, aliases: [] });
  }
  const people = db.prepare(`
    SELECT p.id, p.name, a.name AS alias_name
    FROM people p LEFT JOIN people_aliases a ON a.person_id = p.id
  `).all();
  const byPerson = new Map();
  for (const row of people) {
    if (!row.id || row.id === 'owner' || !row.name) continue;
    const item = byPerson.get(row.id) || { kind: 'person', key: row.id, name: row.name, aliases: [] };
    const alias = String(row.alias_name || '').trim();
    if (alias && !item.aliases.includes(alias)) item.aliases.push(alias);
    byPerson.set(row.id, item);
  }
  list.push(...byPerson.values());
  for (const tool of TOOLS) list.push({ kind: 'tool', key: tool, name: tool, aliases: [] });
  return list;
}

/**
 * 这句话（+ 当前目录）碰到了哪些实体。
 * cwd 命中的工作区直接算一个（任务在哪个项目里跑，不靠文本提）。
 * entities 可预加载（回填时循环用，别每条记忆都查一遍库）。
 */
export function matchEntities(text, { settings = getSettings(), cwd = '', entities = null } = {}) {
  const list = entities || listEntities(settings);
  const hay = String(text || '').toLowerCase();
  const picked = [];
  const seen = new Set();
  const push = (kind, key, name) => {
    if (!ENTITY_KINDS.includes(kind)) return false;
    const id = `${kind}:${key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    picked.push({ kind, key: String(key).slice(0, MAX_KEY), name: String(name || key).slice(0, MAX_NAME) });
    return true;
  };

  const counts = { workspace: 0, category: 0, person: 0, tool: 0, file: 0 };
  if (cwd) {
    const ws = workspaceFor(cwd, settings);
    if (ws && push('workspace', ws.id, ws.name)) counts.workspace = 1;
  }

  const hits = [];
  for (const entity of list) {
    let best = '';
    for (const name of [entity.name, ...(entity.aliases || [])]) {
      if (name && hasName(hay, name) && name.length > best.length) best = name;
    }
    if (best) hits.push({ entity, length: best.length });
  }
  // 名字长的更具体（「TAPD 项目」优先于「TAPD」），先占名额。
  hits.sort((a, b) => b.length - a.length);
  for (const { entity } of hits) {
    if (picked.length >= MAX_REFS) break;
    if ((counts[entity.kind] || 0) >= (KIND_CAP[entity.kind] || 0)) continue;
    if (push(entity.kind, entity.key, entity.name)) counts[entity.kind] = (counts[entity.kind] || 0) + 1;
  }

  if (picked.length < MAX_REFS) {
    for (const file of filesIn(text)) {
      if ((counts.file || 0) >= KIND_CAP.file) break;
      if (push('file', file, file)) counts.file = (counts.file || 0) + 1;
    }
  }
  return picked;
}

/** 规整一组 refs：认识的种类、非空 key、去重、限量。name 只是给人看/给匹配用，缺省用 key。 */
export function normalizeRefs(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    if (!ENTITY_KINDS.includes(item.kind)) continue;
    const key = String(item.key ?? '').trim();
    if (!key || key.length > MAX_KEY) continue;
    const id = `${item.kind}:${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: item.kind, key, name: String(item.name || key).slice(0, MAX_NAME) });
    if (out.length >= MAX_REFS) break;
  }
  return out;
}

/** 这条记忆该挂哪些实体：显式给的 + 文本里认出来的（人格域不自动认，避免把业务实体带进人格记忆）。 */
export function refsForMemory(text, { domain = 'work', refs = null, entities = null } = {}) {
  const explicit = normalizeRefs(refs);
  if (domain !== 'work') return explicit;
  const auto = matchEntities(text, { entities });
  const seen = new Set(explicit.map((ref) => `${ref.kind}:${ref.key}`));
  for (const ref of auto) {
    if (seen.has(`${ref.kind}:${ref.key}`)) continue;
    explicit.push(ref);
    if (explicit.length >= MAX_REFS) break;
  }
  return explicit;
}

// 任务归类引擎（docs/architecture/external.md「归类」）。
//
// 能力归核心，映射归插件：插件只交「这个外部对象是谁、它的上级是谁」（node / parent / links），
// 切哪层当父卡、怎么显示、怎么合并都在这里决定。父卡是分类视图，不是任务：不执行、不进队列。
//
// 三件东西分开：
// - 意图（持久，task 级）：task_assignments（归属）、task_class_suppressions（卡级抑制）；
// - 视图（可重建）：task_categories（分类项），掉一个成员不影响它；
// - 计算（不落库）：成员数、进度。
//
// 自动归类按来源实例单独开关：off（默认）/ observing（试运行：只算不显示、不写知识）/ on。
import { db, now, uid, getSettings, transaction } from './db.js';
import { bus } from './events.js';
import * as plugins from './plugins.js';
import { validateGroupAt } from './plugin-spec.js';
import * as archive from './archive.js';

export const AXES = ['relation', 'label'];
export const STATES = ['off', 'observing', 'on'];
const MAX_DEPTH = 32;
const MAX_LINKS = 8;
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const LINK_KINDS = new Set(['related', 'blocks', 'duplicates', 'parent-conflict']);

/* --------------------------------- 设置 --------------------------------- */

export function settings() {
  const cfg = getSettings().classification || {};
  return {
    enabled: cfg.enabled !== false,
    maxGroupSize: Math.max(2, Math.min(500, Number(cfg.maxGroupSize) || 30)),
    ttlDays: Math.max(1, Math.min(3650, Number(cfg.emptyAutoCategoryTtlDays) || 30)),
    shadow: { minHours: Number(cfg.shadow?.minHours ?? 24), minCards: Number(cfg.shadow?.minCards ?? 10) },
    notify: cfg.notify !== false
  };
}

/* ------------------------------ 来源实例状态 ------------------------------ */

function declarationOf(plugin) {
  return plugin?.manifest?.classification || null;
}

/** 这个实例的自动归类状态。没声明能力、插件停用 / 删除、总开关关着都算 off。 */
export function stateOf(instanceId) {
  if (!settings().enabled) return 'off';
  const plugin = plugins.getPlugin(instanceId);
  if (!plugin || !declarationOf(plugin)) return 'off';
  const state = plugin.row?.classify_state;
  return STATES.includes(state) ? state : 'off';
}

function stateMap() {
  const rows = db.prepare('SELECT id, classify_state FROM source_plugins').all();
  const out = new Map();
  for (const row of rows) out.set(row.id, STATES.includes(row.classify_state) ? row.classify_state : 'off');
  return out;
}

/** 切层策略：用户设置 > 插件 defaultGroupAt > 核心默认 { levels: 1 }。 */
export function policyOf(instanceId) {
  const plugin = plugins.getPlugin(instanceId);
  const decl = declarationOf(plugin);
  if (!decl) return { levels: 1 };
  if (plugin.row?.classify_group_at) {
    try {
      return validateGroupAt(JSON.parse(plugin.row.classify_group_at), decl.nodeTypes);
    } catch { /* 用户设置坏了就退回插件默认 */ }
  }
  return decl.defaultGroupAt || { levels: 1 };
}

function typeLabel(family, type) {
  for (const plugin of plugins.listPlugins()) {
    if (plugin.pluginId !== family) continue;
    const decl = plugins.getPlugin(plugin.id)?.manifest?.classification;
    if (decl?.nodeLabels?.[type]) return decl.nodeLabels[type];
  }
  return type;
}

/**
 * 设置一个实例的自动归类：state（off / observing / on）、groupAt（切层，null 恢复默认）。
 * 从 off 打开时跑一次 reconcile，把已有的卡补算进来。
 */
export function configurePlugin(instanceId, { state, groupAt } = {}) {
  const plugin = plugins.getPlugin(instanceId);
  if (!plugin) throw Object.assign(new Error('插件不存在'), { statusCode: 404 });
  const decl = declarationOf(plugin);
  if (!decl) throw Object.assign(new Error('这个来源没有声明归类能力，只能手动归类'), { statusCode: 400 });
  const before = stateOf(instanceId);
  if (state !== undefined) {
    if (!STATES.includes(state)) throw Object.assign(new Error('state 只能是 off / observing / on'), { statusCode: 400 });
    db.prepare('UPDATE source_plugins SET classify_state = ?, classify_since = ?, classify_prompts = CASE WHEN ? = \'observing\' THEN 0 ELSE classify_prompts END, updated_at = ? WHERE id = ?')
      .run(state, state === before ? plugin.row.classify_since : now(), state, now(), instanceId);
  }
  if (groupAt !== undefined) {
    const value = groupAt === null ? null : JSON.stringify(validateGroupAt(groupAt, decl.nodeTypes));
    db.prepare('UPDATE source_plugins SET classify_group_at = ?, updated_at = ? WHERE id = ?').run(value, now(), instanceId);
  }
  const after = stateOf(instanceId);
  if (after === 'off' && before !== 'off') removeObserver(instanceId);
  if (after !== 'off' && (before === 'off' || groupAt !== undefined)) reconcile({ provider: instanceId });
  bus.emit('classification/plugin', { instanceId, state: after });
  changed(tasksOfProvider(instanceId));
  return pluginSummary(instanceId);
}

/** 设置页用：声明、状态、切层、质量摘要。 */
export function pluginSummary(instanceId) {
  const plugin = plugins.getPlugin(instanceId);
  const decl = declarationOf(plugin);
  if (!decl) return { declared: false };
  const state = stateOf(instanceId);
  const taskIds = tasksOfProvider(instanceId);
  const rows = taskIds.length ? assignmentsFor(taskIds).filter((row) => row.axis === 'relation') : [];
  const members = rows.filter((row) => row.state === 'member' && row.category_id);
  const byCategory = new Map();
  for (const row of members) byCategory.set(row.category_id, (byCategory.get(row.category_id) || 0) + 1);
  const recent = db.prepare(`
    SELECT node_key FROM task_sources WHERE provider = ? ORDER BY created_at DESC LIMIT 20
  `).all(instanceId);
  return {
    declared: true,
    nodeTypes: decl.nodeTypes,
    nodeLabels: decl.nodeLabels || {},
    defaultGroupAt: decl.defaultGroupAt,
    groupAt: policyOf(instanceId),
    customGroupAt: Boolean(plugin.row?.classify_group_at),
    state,
    since: plugin.row?.classify_since || null,
    quality: {
      tasks: taskIds.length,
      classified: members.length,
      categories: byCategory.size,
      singles: [...byCategory.values()].filter((n) => n < 2).length,
      ambiguous: rows.filter((row) => row.state === 'ambiguous').length,
      overflow: rows.filter((row) => row.state === 'overflow').length,
      // 声明了能力但最近 20 张卡都没有节点：多半是插件没按规范交 node。
      noNodes: state !== 'off' && recent.length >= 20 && recent.every((row) => !row.node_key)
    },
    trialReady: state === 'observing' && trialReady(instanceId, members.length)
  };
}

function trialReady(instanceId, classified) {
  const plugin = plugins.getPlugin(instanceId);
  const since = Date.parse(plugin?.row?.classify_since || '');
  const { minHours, minCards } = settings().shadow;
  return Number.isFinite(since) && Date.now() - since >= minHours * 3600 * 1000 && classified >= minCards;
}

function tasksOfProvider(instanceId) {
  return db.prepare('SELECT DISTINCT task_id FROM task_sources WHERE provider = ?').all(instanceId).map((row) => row.task_id);
}

/* --------------------------------- 节点 --------------------------------- */

const part = (value) => encodeURIComponent(String(value));

export function nodeKey(family, workspace, type, id) {
  return `${part(family)}:${part(workspace)}:${part(type)}:${part(id)}`;
}

function cut(value, n) {
  return String(value ?? '').trim().slice(0, n);
}

function httpUrl(value) {
  const text = cut(value, 2000);
  return /^https?:\/\//i.test(text) ? text : '';
}

function cleanRef(value, fallbackWorkspace) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = cut(value.type, 24);
  const id = cut(value.id, 120);
  if (!type || !id) return null;
  return {
    workspace: cut(value.workspace ?? fallbackWorkspace, 120),
    type,
    id,
    title: cut(value.title, 200),
    url: httpUrl(value.url),
    status: value.status && typeof value.status === 'object' ? { label: cut(value.status.label, 40), category: cut(value.status.category, 20) } : null
  };
}

/**
 * 白名单收口插件交来的 node / parent / links（discovery.normalizeItem 和 syncStatus 都走这里）。
 * parent 显式为 null 表示「不知道父是谁」；undefined 表示这次没说（保留已知的父）。
 */
export function normalizeTree(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const node = cleanRef(raw.node, raw.node?.workspace);
  if (!node || !node.workspace) return null;
  // 显式给了但不合法的 parent 按「不知道」处理（null），不保留旧的父。
  const parent = raw.parent === undefined ? undefined : cleanRef(raw.parent, node.workspace);
  const links = (Array.isArray(raw.links) ? raw.links : [])
    .map((link) => ({ kind: cut(link?.kind, 24), to: cleanRef(link?.to, node.workspace) }))
    .filter((link) => link.to && LINK_KINDS.has(link.kind))
    .slice(0, MAX_LINKS);
  return { node, parent, links };
}

export function getNode(key) {
  return key ? db.prepare('SELECT * FROM external_nodes WHERE key = ?').get(key) || null : null;
}

function upsertNode(family, ref, instanceId, { resolved = Boolean(ref.title) } = {}) {
  const key = nodeKey(family, ref.workspace, ref.type, ref.id);
  const stamp = now();
  const existing = getNode(key);
  const meta = ref.status ? JSON.stringify({ status: ref.status }) : null;
  if (!existing) {
    db.prepare(`
      INSERT INTO external_nodes(key, provider_family, workspace, type, external_id, parent_key, title, url, ref, resolved, observed_by, last_observer, stale, observed_at)
      VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,0,?)
    `).run(key, family, ref.workspace, ref.type, ref.id, ref.title || null, ref.url || null, meta, resolved ? 1 : 0, JSON.stringify([instanceId]), instanceId, stamp);
    return getNode(key);
  }
  const observers = new Set(JSON.parse(existing.observed_by || '[]'));
  observers.add(instanceId);
  db.prepare(`
    UPDATE external_nodes SET title = COALESCE(?, title), url = COALESCE(?, url), ref = COALESCE(?, ref),
      resolved = MAX(resolved, ?), observed_by = ?, stale = 0, observed_at = ?
    WHERE key = ?
  `).run(ref.title || null, ref.url || null, meta, resolved ? 1 : 0, JSON.stringify([...observers]), stamp, key);
  return getNode(key);
}

/** 从 start 往上走，会不会走回 target（成环）。 */
function reaches(start, target) {
  let key = start;
  for (let depth = 0; key && depth <= MAX_DEPTH; depth += 1) {
    if (key === target) return true;
    key = getNode(key)?.parent_key || null;
  }
  return Boolean(key);
}

/**
 * 记一次观察：写节点、父指针、补充关系。校验不过的整条丢弃并记日志。
 * 返回 { key, parentChanged }；父指针变了，调用方要对受影响的卡重算（observe 自己也会做）。
 */
export function observe(instanceId, family, tree) {
  const plugin = plugins.getPlugin(instanceId);
  const decl = declarationOf(plugin);
  if (!decl || !tree?.node) return null;
  const { node, parent, links } = tree;
  const allowed = new Set(decl.nodeTypes);
  if (!allowed.has(node.type)) {
    console.warn(`[classification] ${instanceId} 交了未声明的节点类型 ${node.type}，丢弃`);
    return null;
  }
  if (parent && !allowed.has(parent.type)) {
    console.warn(`[classification] ${instanceId} 的父节点类型 ${parent.type} 不在 nodeTypes 里，丢弃这条映射`);
    return null;
  }
  const key = nodeKey(family, node.workspace, node.type, node.id);
  if (parent && nodeKey(family, parent.workspace, parent.type, parent.id) === key) {
    console.warn(`[classification] ${instanceId} 的节点 ${key} 自指，丢弃`);
    return null;
  }
  return transaction(() => {
    const before = getNode(key);
    upsertNode(family, node, instanceId);
    let parentChanged = false;
    if (parent !== undefined) {
      let parentKey = null;
      if (parent) {
        parentKey = upsertNode(family, parent, instanceId).key;
        if (reaches(parentKey, key)) {
          console.warn(`[classification] ${instanceId} 的父指针 ${key} → ${parentKey} 成环，丢弃`);
          return { key, parentChanged: false, dropped: true };
        }
      }
      const previous = before?.parent_key || null;
      // 两个实例对同一个节点给了不同的父：不以最后写入者为准，按歧义处理（父置空，两个都进 links）。
      const otherObserver = before?.last_observer && before.last_observer !== instanceId;
      if (before && previous && parentKey && previous !== parentKey && otherObserver) {
        for (const to of [previous, parentKey]) {
          db.prepare('INSERT OR REPLACE INTO external_node_links(from_key, to_key, kind, observed_at) VALUES(?,?,?,?)').run(key, to, 'parent-conflict', now());
        }
        console.warn(`[classification] ${key} 的父节点在不同实例间不一致（${previous} / ${parentKey}），按歧义处理`);
        parentKey = null;
      }
      if (previous !== parentKey || !before) {
        db.prepare('UPDATE external_nodes SET parent_key = ?, last_observer = ? WHERE key = ?').run(parentKey, instanceId, key);
        parentChanged = Boolean(before) && previous !== parentKey;
      } else {
        db.prepare('UPDATE external_nodes SET last_observer = ? WHERE key = ?').run(instanceId, key);
      }
    }
    for (const link of links || []) {
      if (!allowed.has(link.to.type)) continue;
      const toKey = upsertNode(family, link.to, instanceId).key;
      if (toKey === key) continue;
      db.prepare('INSERT OR REPLACE INTO external_node_links(from_key, to_key, kind, observed_at) VALUES(?,?,?,?)').run(key, toKey, link.kind, now());
    }
    return { key, parentChanged };
  });
}

/** 观察一批条目（discovery 拉到的、syncStatus 返回的），父指针有变化的卡当场局部重算。 */
export function observeItems(instanceId, items) {
  const state = stateOf(instanceId);
  if (state === 'off') return 0;
  const plugin = plugins.getPlugin(instanceId);
  const family = plugin.pluginId;
  const moved = [];
  let count = 0;
  for (const item of items) {
    if (!item?.tree) continue;
    const result = observe(instanceId, family, item.tree);
    if (!result) continue;
    item.nodeKey = result.key;
    count += 1;
    if (result.parentChanged) moved.push(result.key);
  }
  if (moved.length) {
    const affected = tasksUnder(moved);
    for (const taskId of affected) route(taskId);
  }
  return count;
}

/** 节点在这些 key 之下（含自身）的卡。 */
function tasksUnder(keys) {
  const targets = new Set(keys);
  const rows = db.prepare('SELECT DISTINCT task_id, node_key FROM task_sources WHERE node_key IS NOT NULL').all();
  const out = new Set();
  for (const row of rows) {
    let key = row.node_key;
    for (let depth = 0; key && depth <= MAX_DEPTH; depth += 1) {
      if (targets.has(key)) { out.add(row.task_id); break; }
      key = getNode(key)?.parent_key || null;
    }
  }
  return [...out];
}

/** 实例关掉 / 删除：从 observed_by 里拿掉它；没人观察的节点标 stale，不再参与新卡切层。 */
function removeObserver(instanceId) {
  const rows = db.prepare("SELECT key, observed_by FROM external_nodes WHERE observed_by LIKE ?").all(`%${JSON.stringify(instanceId).slice(1, -1)}%`);
  for (const row of rows) {
    const observers = JSON.parse(row.observed_by || '[]').filter((id) => id !== instanceId);
    db.prepare('UPDATE external_nodes SET observed_by = ?, stale = ? WHERE key = ?').run(JSON.stringify(observers), observers.length ? 0 : 1, row.key);
  }
}

/* --------------------------------- 切层 --------------------------------- */

/**
 * 纯函数：从节点自身开始沿父指针找目标层。lookup(key) 返回 { key, type, parent_key }。
 * - { type }：第一个 type 匹配的节点（可以是自身）；
 * - { levels, anchor? }：自身是 anchor 类型就是自身，否则上溯 levels 层。
 * 找不到、成环、超过 32 层都返回 null。
 */
export function ancestorAt(start, policy, lookup = getNode) {
  let node = typeof start === 'string' ? lookup(start) : start;
  if (!node) return null;
  const seen = new Set();
  if (policy?.type) {
    for (let depth = 0; node && depth <= MAX_DEPTH; depth += 1) {
      if (seen.has(node.key)) return null;
      seen.add(node.key);
      if (node.type === policy.type) return node;
      node = node.parent_key ? lookup(node.parent_key) : null;
    }
    return null;
  }
  if (policy?.anchor && node.type === policy.anchor) return node;
  const levels = Math.max(1, Number(policy?.levels) || 1);
  for (let step = 0; step < levels; step += 1) {
    if (seen.has(node.key)) return null;
    seen.add(node.key);
    node = node.parent_key ? lookup(node.parent_key) : null;
    if (!node) return null;
  }
  return seen.has(node.key) ? null : node;
}

/** 沿 merged_into 找到存活的分类项；suppressed 返回 null；还没建分类行时返回 { key } 占位。 */
export function resolve(key, axis = 'relation') {
  let row = db.prepare('SELECT * FROM task_categories WHERE axis = ? AND key = ?').get(axis, key);
  for (let hop = 0; row && row.state === 'merged' && row.merged_into && hop < 16; hop += 1) {
    row = db.prepare('SELECT * FROM task_categories WHERE id = ?').get(row.merged_into);
  }
  if (!row) return { key, virtual: true };
  if (row.state === 'suppressed') return null;
  return row;
}

/**
 * 不依赖任务和归属行，按条目现场算出它的知识域（给 discovery 拼 prompt 用：那时任务还没建）。
 * 实例不是 on 时返回 null（试运行不注入）。返回 { key, keys（含祖先）, title }。
 */
export function scopeFor(instanceId, item) {
  if (stateOf(instanceId) !== 'on' || !item?.nodeKey) return null;
  const target = ancestorAt(item.nodeKey, policyOf(instanceId));
  if (!target || target.stale) return null;
  const category = resolve(target.key);
  if (!category) return null;
  const keys = [category.key];
  let up = getNode(category.key)?.parent_key || null;
  for (let depth = 0; up && depth < 4; depth += 1) {
    keys.push(resolve(up)?.key || up);
    up = getNode(up)?.parent_key || null;
  }
  return { key: category.key, keys, title: category.title || nodeTitle(getNode(category.key)) };
}

function nodeTitle(node) {
  if (!node) return '';
  return node.title || `${typeLabel(node.provider_family, node.type)} #${node.external_id}`;
}

/* --------------------------------- 归属 --------------------------------- */

function assignmentRow(taskId, axis) {
  return db.prepare('SELECT * FROM task_assignments WHERE task_id = ? AND axis = ?').get(taskId, axis) || null;
}

function suppressed(taskId, axis, key = null) {
  const rows = db.prepare('SELECT key FROM task_class_suppressions WHERE task_id = ? AND axis = ?').all(taskId, axis);
  return rows.some((row) => row.key === null || (key && row.key === key));
}

function memberCount(categoryId, exceptTask = null) {
  return db.prepare("SELECT COUNT(*) AS c FROM task_assignments WHERE category_id = ? AND state = 'member' AND task_id <> ?")
    .get(categoryId, exceptTask || '').c;
}

function categoryFromNode(node) {
  const existing = db.prepare("SELECT * FROM task_categories WHERE axis = 'relation' AND key = ?").get(node.key);
  if (existing) {
    // 外部原名可能后补（壳节点回填）：只在标题还是占位时更新。
    const title = nodeTitle(node);
    if (node.title && existing.title !== title && existing.origin === 'auto') {
      db.prepare('UPDATE task_categories SET title = ?, ref = ?, updated_at = ? WHERE id = ?').run(title, refJson(node), now(), existing.id);
    }
    return db.prepare('SELECT * FROM task_categories WHERE id = ?').get(existing.id);
  }
  const id = uid('cat_');
  const stamp = now();
  db.prepare(`
    INSERT INTO task_categories(id, axis, key, title, ref, provider_family, workspace, origin, state, merged_into, created_at, updated_at)
    VALUES(?, 'relation', ?, ?, ?, ?, ?, 'auto', 'active', NULL, ?, ?)
  `).run(id, node.key, nodeTitle(node), refJson(node), node.provider_family, node.workspace, stamp, stamp);
  bus.emit('category/created', { id, axis: 'relation' });
  return db.prepare('SELECT * FROM task_categories WHERE id = ?').get(id);
}

function refJson(node) {
  const ref = node.ref ? JSON.parse(node.ref) : {};
  return JSON.stringify({ type: node.type, id: node.external_id, workspace: node.workspace, url: node.url || '', status: ref.status || null, typeLabel: typeLabel(node.provider_family, node.type) });
}

function writeAssignment(taskId, axis, { categoryId = null, state = 'member', candidates = null, who = 'auto', pinned = 0, reason = '' }) {
  const current = assignmentRow(taskId, axis);
  const candText = candidates ? JSON.stringify(candidates) : null;
  if (current && current.category_id === categoryId && current.state === state && (current.candidates || null) === candText
    && current.who === who && current.pinned === pinned) return false;
  const stamp = now();
  if (current) {
    db.prepare('UPDATE task_assignments SET category_id = ?, state = ?, candidates = ?, who = ?, pinned = ?, reason = ?, updated_at = ? WHERE id = ?')
      .run(categoryId, state, candText, who, pinned, reason, stamp, current.id);
  } else {
    db.prepare(`
      INSERT INTO task_assignments(id, task_id, axis, category_id, state, candidates, who, pinned, reason, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(uid('as_'), taskId, axis, categoryId, state, candText, who, pinned, reason, stamp, stamp);
  }
  const type = !current ? 'classification/assigned' : current.category_id !== categoryId ? 'classification/moved' : 'classification/assigned';
  bus.emit(type, { taskId, axis, categoryId, from: current?.category_id || null, state });
  if (categoryId) touchCategory(categoryId);
  if (current?.category_id && current.category_id !== categoryId) touchCategory(current.category_id);
  return true;
}

function dropAssignment(taskId, axis) {
  const current = assignmentRow(taskId, axis);
  if (!current) return false;
  db.prepare('DELETE FROM task_assignments WHERE id = ?').run(current.id);
  bus.emit('classification/removed', { taskId, axis, categoryId: current.category_id });
  if (current.category_id) touchCategory(current.category_id);
  return true;
}

function touchCategory(id) {
  const row = db.prepare('SELECT state FROM task_categories WHERE id = ?').get(id);
  if (!row) return;
  const active = db.prepare(`
    SELECT COUNT(*) AS c FROM task_assignments a JOIN tasks t ON t.id = a.task_id
    WHERE a.category_id = ? AND a.state = 'member' AND t.status NOT IN ('done', 'failed', 'cancelled')
  `).get(id).c;
  const next = row.state === 'active' && !active ? 'dormant' : row.state === 'dormant' && active ? 'active' : row.state;
  db.prepare('UPDATE task_categories SET state = ?, updated_at = ? WHERE id = ?').run(next, now(), id);
}

/**
 * 按切层策略重算这张卡的关系轴归属（幂等）。手动 / 固定 / 整轴抑制的不动。
 * 一卡多节点切出不同分类 → ambiguous，不自动归；分类满了 → overflow（知识域照常）。
 */
export function route(taskId) {
  if (!settings().enabled) return null;
  const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId);
  if (!task) return null;
  const axis = 'relation';
  const current = assignmentRow(taskId, axis);
  if (current && (current.who === 'manual' || current.pinned)) return current;
  if (suppressed(taskId, axis)) {
    dropAssignment(taskId, axis);
    return null;
  }
  const states = stateMap();
  const links = db.prepare('SELECT provider, node_key FROM task_sources WHERE task_id = ? AND node_key IS NOT NULL').all(taskId)
    .filter((row) => (states.get(row.provider) || 'off') !== 'off' && stateOf(row.provider) !== 'off');
  const candidates = new Map();
  // 切不到、但插件给了补充关系（多关联且没有「主」，按协议 parent: null + links）：
  // 把关联对象切层后的结果当候选，让人来选，绝不自己挑一个。
  const linked = new Map();
  let selfKey = null;
  for (const link of links) {
    const node = getNode(link.node_key);
    if (!node) continue;
    const target = ancestorAt(node, policyOf(link.provider));
    if (!target && !node.parent_key) {
      const related = db.prepare("SELECT to_key FROM external_node_links WHERE from_key = ? AND kind IN ('related', 'parent-conflict')").all(node.key);
      for (const { to_key: toKey } of related) {
        const relTarget = ancestorAt(toKey, policyOf(link.provider));
        const relResolved = relTarget ? resolve(relTarget.key) : null;
        if (relResolved && !suppressed(taskId, axis, relResolved.key)) linked.set(relResolved.key, { node: getNode(relResolved.key) || relTarget, resolved: relResolved });
      }
    }
    if (!target || (target.stale && !current)) continue;
    const resolved = resolve(target.key);
    if (!resolved || suppressed(taskId, axis, resolved.key)) continue;
    if (target.key === node.key) selfKey = target.key;
    candidates.set(resolved.key, { node: getNode(resolved.key) || target, resolved });
  }
  return transaction(() => {
    const pool = candidates.size ? candidates : linked;
    if (!pool.size) {
      dropAssignment(taskId, axis);
      return null;
    }
    if (pool.size > 1 || pool === linked) {
      const list = [...pool.values()].map(({ node }) => ({ key: node.key, title: nodeTitle(node), type: node.type, url: node.url || '' }));
      writeAssignment(taskId, axis, { state: 'ambiguous', candidates: list, reason: `关联了 ${list.length} 个上级，拿不准` });
      return assignmentRow(taskId, axis);
    }
    const [{ node, resolved }] = [...candidates.values()];
    const category = resolved.virtual ? categoryFromNode(node) : (node.key === resolved.key ? categoryFromNode(node) : resolved);
    if (category.state === 'dormant') db.prepare("UPDATE task_categories SET state = 'active' WHERE id = ?").run(category.id);
    const reason = selfKey && selfKey === category.key ? '本卡即分类项' : `${nodeTitle(getNode(links[0].node_key))} → ${category.title}`;
    // 已经是这个分类的成员就不算「满」（不把老成员挤出去）；overflow 的重算时仍按满处理。
    const alreadyMember = current?.category_id === category.id && current.state === 'member';
    const full = !alreadyMember && memberCount(category.id, taskId) >= settings().maxGroupSize;
    writeAssignment(taskId, axis, { categoryId: category.id, state: full ? 'overflow' : 'member', reason: full ? '分类已满，未进组' : reason });
    return assignmentRow(taskId, axis);
  });
}

/** 批量重算：启动、每日、打开开关、用户点「重新归类」。分批 200 张。 */
export function reconcile({ taskIds = null, provider = null } = {}) {
  if (!settings().enabled) return { routed: 0 };
  const ids = taskIds
    || (provider
      ? tasksOfProvider(provider)
      : db.prepare('SELECT DISTINCT task_id FROM task_sources WHERE node_key IS NOT NULL').all().map((row) => row.task_id));
  let routed = 0;
  for (let i = 0; i < ids.length; i += 200) {
    for (const id of ids.slice(i, i + 200)) {
      route(id);
      routed += 1;
    }
  }
  changed(ids);
  return { routed };
}

/* ------------------------------ 手动运营 ------------------------------ */

function getCategoryRow(id) {
  const row = db.prepare('SELECT * FROM task_categories WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('分类不存在'), { statusCode: 404 });
  return row;
}

export function createCategory({ title }) {
  const clean = cut(title, 60);
  if (!clean) throw Object.assign(new Error('分类名不能为空'), { statusCode: 400 });
  const id = uid('cat_');
  const stamp = now();
  db.prepare(`
    INSERT INTO task_categories(id, axis, key, title, ref, provider_family, workspace, origin, state, merged_into, created_at, updated_at)
    VALUES(?, 'label', ?, ?, NULL, NULL, NULL, 'manual', 'active', NULL, ?, ?)
  `).run(id, `label:${id}`, clean, stamp, stamp);
  bus.emit('category/created', { id, axis: 'label' });
  return getCategoryRow(id);
}

export function renameCategory(id, title) {
  const clean = cut(title, 60);
  if (!clean) throw Object.assign(new Error('分类名不能为空'), { statusCode: 400 });
  getCategoryRow(id);
  db.prepare('UPDATE task_categories SET title = ?, updated_at = ? WHERE id = ?').run(clean, now(), id);
  bus.emit('category/updated', { id });
  return getCategoryRow(id);
}

/** 手动归入（写 manual + pinned）。自动流程之后对这张卡这根轴沉默。 */
export function assign(taskId, categoryId) {
  if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
  let category = getCategoryRow(categoryId);
  if (category.state === 'merged') category = resolve(category.key, category.axis) || category;
  transaction(() => {
    db.prepare('DELETE FROM task_class_suppressions WHERE task_id = ? AND axis = ? AND key = ?').run(taskId, category.axis, category.key);
    if (category.state === 'dormant' || category.state === 'suppressed') db.prepare("UPDATE task_categories SET state = 'active' WHERE id = ?").run(category.id);
    writeAssignment(taskId, category.axis, { categoryId: category.id, who: 'manual', pinned: 1, reason: '手动归入' });
  });
  changed([taskId]);
  return assignmentRow(taskId, category.axis);
}

/** 歧义时从候选里选一个：候选是节点 key，分类行可能还没建。 */
export function assignByKey(taskId, key) {
  const resolved = resolve(key);
  if (resolved && !resolved.virtual) return assign(taskId, resolved.id);
  const node = getNode(key);
  if (!node) throw Object.assign(new Error('这个候选已经不在了，点「重新归类」再试'), { statusCode: 404 });
  const category = transaction(() => categoryFromNode(node));
  return assign(taskId, category.id);
}

/** 移出：删归属，并写卡级抑制（之后自动不再归到这里）。 */
export function unassign(taskId, axis) {
  if (!AXES.includes(axis)) throw Object.assign(new Error('未知的轴'), { statusCode: 400 });
  const current = assignmentRow(taskId, axis);
  transaction(() => {
    if (current?.category_id) {
      const key = db.prepare('SELECT key FROM task_categories WHERE id = ?').get(current.category_id)?.key || null;
      if (axis === 'relation' && key) suppress(taskId, axis, key, '用户移出');
    } else if (current?.state === 'ambiguous') {
      suppress(taskId, axis, null, '用户选择都别管');
    }
    dropAssignment(taskId, axis);
  });
  changed([taskId]);
  return { ok: true };
}

export function suppress(taskId, axis, key = null, reason = '') {
  const exists = db.prepare('SELECT 1 FROM task_class_suppressions WHERE task_id = ? AND axis = ? AND key IS ?').get(taskId, axis, key);
  if (!exists) {
    db.prepare('INSERT INTO task_class_suppressions(id, task_id, axis, key, reason, created_at) VALUES(?,?,?,?,?,?)')
      .run(uid('sp_'), taskId, axis, key, reason, now());
  }
}

/** 恢复自动：去掉手动 / 固定和这根轴上的卡级抑制，马上重算。 */
export function restoreAuto(taskId, axis = 'relation') {
  transaction(() => {
    db.prepare('DELETE FROM task_class_suppressions WHERE task_id = ? AND axis = ?').run(taskId, axis);
    dropAssignment(taskId, axis);
  });
  if (axis === 'relation') route(taskId);
  changed([taskId]);
  return assignmentRow(taskId, axis);
}

/** 不参与自动归类（整轴抑制）。 */
export function optOut(taskId, axis = 'relation') {
  transaction(() => {
    suppress(taskId, axis, null, '不参与自动归类');
    const current = assignmentRow(taskId, axis);
    if (current && current.who !== 'manual') dropAssignment(taskId, axis);
  });
  changed([taskId]);
  return { ok: true };
}

/** 合并 from → into（同轴）。成员搬过去，知识跟着迁，旧分类留跳转。 */
export function mergeCategories(fromId, intoId, { moveKnowledge = null } = {}) {
  if (fromId === intoId) throw Object.assign(new Error('不能合并到自己'), { statusCode: 400 });
  const from = getCategoryRow(fromId);
  const into = getCategoryRow(intoId);
  if (from.axis !== into.axis) throw Object.assign(new Error('只能合并同一根轴上的分类'), { statusCode: 400 });
  if (into.state === 'merged') throw Object.assign(new Error('目标分类已经被合并过了'), { statusCode: 400 });
  const members = db.prepare('SELECT task_id FROM task_assignments WHERE category_id = ?').all(fromId).map((row) => row.task_id);
  transaction(() => {
    db.prepare('UPDATE task_assignments SET category_id = ?, updated_at = ? WHERE category_id = ?').run(intoId, now(), fromId);
    db.prepare("UPDATE task_categories SET state = 'merged', merged_into = ?, updated_at = ? WHERE id = ?").run(intoId, now(), fromId);
    db.prepare("UPDATE task_categories SET state = 'active', updated_at = ? WHERE id = ?").run(now(), intoId);
    if (moveKnowledge) moveKnowledge(from.key, into.key);
  });
  bus.emit('category/merged', { from: fromId, into: intoId });
  changed(members);
  return getCategoryRow(intoId);
}

/** 删除：手动分类直接删（成员回到未归类）；自动分类转 suppressed（不再自动重建）。 */
export function deleteCategory(id) {
  const category = getCategoryRow(id);
  const members = db.prepare('SELECT task_id FROM task_assignments WHERE category_id = ?').all(id).map((row) => row.task_id);
  transaction(() => {
    db.prepare('DELETE FROM task_assignments WHERE category_id = ?').run(id);
    if (category.origin === 'manual') db.prepare('DELETE FROM task_categories WHERE id = ?').run(id);
    else db.prepare("UPDATE task_categories SET state = 'suppressed', updated_at = ? WHERE id = ?").run(now(), id);
  });
  bus.emit('category/suppressed', { id });
  changed(members);
  return { ok: true, suppressed: category.origin !== 'manual' };
}

/* ------------------------------ 读：给界面 ------------------------------ */

function assignmentsFor(taskIds) {
  const out = [];
  for (let i = 0; i < taskIds.length; i += 400) {
    const chunk = taskIds.slice(i, i + 400);
    out.push(...db.prepare(`SELECT * FROM task_assignments WHERE task_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  return out;
}

/**
 * 关系轴的归属只在来源实例「开启」时显示（试运行只算不显示）；标签轴（手动分类）总是显示。
 * visibleFor 返回这张卡的关系轴归属该不该给界面看。
 */
function relationVisible(task, states) {
  return (task.sources || []).some((link) => states.get(link.provider) === 'on' && stateOf(link.provider) === 'on');
}

/** 给任务 DTO 挂 classifications（照 sourceLinks.attach，批量查）。 */
export function attach(tasks) {
  const list = tasks.filter(Boolean);
  if (!list.length) return tasks;
  if (!settings().enabled) {
    for (const task of list) task.classifications = [];
    return tasks;
  }
  const rows = assignmentsFor(list.map((task) => task.id));
  const categoryIds = [...new Set(rows.map((row) => row.category_id).filter(Boolean))];
  const categories = new Map();
  for (let i = 0; i < categoryIds.length; i += 400) {
    const chunk = categoryIds.slice(i, i + 400);
    for (const row of db.prepare(`SELECT * FROM task_categories WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) categories.set(row.id, row);
  }
  const states = stateMap();
  const byTask = new Map();
  for (const row of rows) {
    if (!byTask.has(row.task_id)) byTask.set(row.task_id, []);
    byTask.get(row.task_id).push(row);
  }
  for (const task of list) {
    const showRelation = relationVisible(task, states);
    task.classifications = (byTask.get(task.id) || [])
      .filter((row) => row.axis === 'label' || row.who === 'manual' || showRelation)
      .map((row) => {
        const category = row.category_id ? categories.get(row.category_id) : null;
        return {
          axis: row.axis,
          categoryId: category?.id || null,
          title: category?.title || '',
          ref: category?.ref ? JSON.parse(category.ref) : null,
          state: row.state,
          ambiguous: row.state === 'ambiguous',
          candidates: row.candidates ? JSON.parse(row.candidates) : [],
          who: row.who,
          pinned: Boolean(row.pinned),
          reason: row.reason || ''
        };
      });
  }
  return tasks;
}

function rollupOf(categoryId) {
  const rows = db.prepare(`
    SELECT t.status, t.outcome FROM task_assignments a JOIN tasks t ON t.id = a.task_id
    WHERE a.category_id = ? AND a.state = 'member'
  `).all(categoryId);
  const count = (fn) => rows.filter(fn).length;
  return {
    members: rows.length,
    done: count((row) => row.status === 'done'),
    finished: count((row) => FINISHED.has(row.status)),
    active: count((row) => !FINISHED.has(row.status)),
    running: count((row) => row.status === 'running'),
    waiting: count((row) => row.status === 'waiting_approval'),
    failed: count((row) => row.status === 'failed')
  };
}

function categoryDto(row) {
  const ref = row.ref ? JSON.parse(row.ref) : null;
  return {
    id: row.id,
    axis: row.axis,
    key: row.key,
    title: row.title,
    ref,
    origin: row.origin,
    state: row.state,
    mergedInto: row.merged_into || null,
    providerFamily: row.provider_family || null,
    shell: row.axis === 'relation' && !getNode(row.key)?.resolved,
    rollup: rollupOf(row.id),
    updatedAt: row.updated_at
  };
}

/** 界面上可见的分类：手动的 + 来源实例「开启」的家族的自动分类。merged / suppressed 不列。 */
export function listCategories({ axis = null, includeHidden = false } = {}) {
  if (!settings().enabled) return [];
  const onFamilies = new Set();
  for (const plugin of plugins.listPlugins()) if (stateOf(plugin.id) === 'on') onFamilies.add(plugin.pluginId);
  const rows = db.prepare(`SELECT * FROM task_categories WHERE state NOT IN ('merged', 'suppressed') ${axis ? 'AND axis = ?' : ''} ORDER BY updated_at DESC`)
    .all(...(axis ? [axis] : []));
  return rows
    .filter((row) => includeHidden || row.axis === 'label' || onFamilies.has(row.provider_family))
    .map(categoryDto);
}

export function getCategory(id, { knowledgeOf = null } = {}) {
  const row = getCategoryRow(id);
  const members = db.prepare(`
    SELECT a.task_id, a.who, a.pinned, a.state, a.reason, t.title, t.status, t.worker, t.updated_at
    FROM task_assignments a JOIN tasks t ON t.id = a.task_id
    WHERE a.category_id = ? ORDER BY t.updated_at DESC
  `).all(id).map((member) => ({
    taskId: member.task_id,
    title: member.title,
    status: member.status,
    worker: member.worker,
    who: member.who,
    pinned: Boolean(member.pinned),
    state: member.state,
    reason: member.reason || '',
    updatedAt: member.updated_at
  }));
  // 为什么在这里：成员卡的节点 → 这个分类节点的路径。只列事实。
  const why = [];
  if (row.axis === 'relation') {
    const memberIds = members.map((member) => member.taskId);
    const nodes = memberIds.length
      ? db.prepare(`SELECT DISTINCT node_key FROM task_sources WHERE node_key IS NOT NULL AND task_id IN (${memberIds.map(() => '?').join(',')})`).all(...memberIds)
      : [];
    for (const { node_key: key } of nodes.slice(0, 12)) {
      const node = getNode(key);
      if (!node || key === row.key) continue;
      why.push(`${nodeTitle(node)} → ${row.title}`);
    }
  }
  const dto = categoryDto(row);
  return { ...dto, members, why, knowledge: knowledgeOf ? knowledgeOf(row.key) : [] };
}

/* ------------------------------ 回收与维护 ------------------------------ */

/** 每天一次：空的自动分类 dormant 超过 TTL 就删（连带它的自动知识由调用方清理）。 */
export function maintain({ dropKnowledge = null } = {}) {
  const { ttlDays } = settings();
  const cutoff = new Date(Date.now() - ttlDays * 24 * 3600 * 1000).toISOString();
  const stale = db.prepare(`
    SELECT c.* FROM task_categories c
    WHERE c.origin = 'auto' AND c.state IN ('active', 'dormant') AND c.updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM task_assignments a WHERE a.category_id = c.id)
  `).all(cutoff);
  for (const row of stale) {
    db.prepare('DELETE FROM task_categories WHERE id = ?').run(row.id);
    if (dropKnowledge) dropKnowledge(row.key);
  }
  return { removed: stale.length };
}

/* ------------------------------ 归档 / 删除 ------------------------------ */

/** 删任务：删归属和卡级抑制，分类可能转 dormant。 */
export function forgetTask(taskId) {
  const categories = db.prepare('SELECT category_id FROM task_assignments WHERE task_id = ? AND category_id IS NOT NULL').all(taskId);
  db.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM task_class_suppressions WHERE task_id = ?').run(taskId);
  for (const row of categories) touchCategory(row.category_id);
}

/**
 * 归档恢复的钩子（archive.restoreTask 调用）：抑制原样写回；
 * 归属只写回手动的、且分类还在的（换成合并后的存活分类）；自动的丢掉，恢复后重算。
 */
export const restoreHooks = {
  task_assignments(rows) {
    const out = [];
    for (const row of rows) {
      if (row.who !== 'manual' || !row.category_id) continue;
      const category = db.prepare('SELECT * FROM task_categories WHERE id = ?').get(row.category_id);
      if (!category) continue;
      const alive = category.state === 'merged' ? resolve(category.key, category.axis) : category;
      if (!alive || alive.virtual) continue;
      out.push({ ...row, category_id: alive.id });
    }
    return out;
  },
  task_class_suppressions(rows) {
    return rows;
  }
};

for (const [table, fn] of Object.entries(restoreHooks)) archive.registerRestoreHook(table, fn);
archive.onRestored((taskId) => {
  route(taskId);
  changed([taskId]);
});

/* --------------------------------- 推送 --------------------------------- */

let notify = () => {};

/** scheduler 注册：归属变了的卡重新推一次（这里不反向依赖 scheduler）。 */
export function onTasksChanged(fn) {
  notify = typeof fn === 'function' ? fn : () => {};
}

function changed(taskIds) {
  for (const id of new Set(taskIds || [])) {
    try { notify(id); } catch (err) { console.warn('[classification]', err.message); }
  }
  bus.emit('categories/updated', {});
}

/* --------------------------------- 事件 --------------------------------- */

bus.on(({ type, payload }) => {
  try {
    if (type === 'source/linked' || type === 'source/unlinked') {
      if (payload?.taskId && route(payload.taskId) !== undefined) changed([payload.taskId]);
    } else if (type === 'task/created' && payload?.task?.id) {
      const before = assignmentRow(payload.task.id, 'relation');
      const after = route(payload.task.id);
      if ((before?.category_id || null) !== (after?.category_id || null)) changed([payload.task.id]);
    } else if (type === 'task/finished' && payload?.task?.id) {
      for (const row of db.prepare('SELECT category_id FROM task_assignments WHERE task_id = ? AND category_id IS NOT NULL').all(payload.task.id)) touchCategory(row.category_id);
      bus.emit('categories/updated', {});
    }
  } catch (err) {
    console.warn('[classification]', err.message);
  }
});

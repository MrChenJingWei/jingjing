/**
 * 任务 ↔ 外部对象的绑定（task_sources）：这张卡对应 TAPD 的哪个缺陷、GitHub 的哪个 PR，外部那边现在是什么状态。
 *
 * - 和 source_items 分开：source_items 是「这条外部数据处理过没有」的去重账本，删任务也要留着；
 *   task_sources 是「这张卡绑定了谁、对方状态如何」，跟着任务删除、归档、恢复。
 * - 核心只认这套协议（provider / externalId / status{key,label,category,detail,updatedAt}），不认识任何一家来源；
 *   状态映射全部在来源插件里做。
 * - 外部状态只展示、只提示，不改任务状态，也不改 tasks.updated_at（不会把任务顶到列表最上面）。
 */
import { db, now, uid, event } from './db.js';
import { bus } from './events.js';
import * as plugins from './plugins.js';

export const STATUS_CATEGORIES = ['open', 'in_progress', 'blocked', 'review', 'done', 'cancelled', 'unknown'];

/** 同步节奏：默认 10 分钟一次；失败按 1×、2×、4×… 退避，最长 1 小时。导出成可改的对象，测试里可以调短。 */
export const syncPolicy = {
  intervalMs: 10 * 60 * 1000,
  maxBackoffMs: 60 * 60 * 1000,
  // 任务结束后再跟踪多久：外部单子通常在任务完成后还会被验证、关闭。
  afterFinishMs: 7 * 24 * 60 * 60 * 1000,
  batch: 50
};

const cut = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
};

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function httpUrl(value) {
  const text = cut(value, 2000);
  return /^https?:\/\//i.test(text) ? text : '';
}

function metaJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const text = JSON.stringify(value);
    return text.length <= 4000 ? text : null;
  } catch {
    return null;
  }
}

/**
 * 插件给的状态 → 核心认识的形状。可以只给一个字符串（当作显示文案）。
 * 返回 null 表示没给状态。
 */
export function normalizeStatus(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = typeof raw === 'string' ? { label: raw } : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const key = cut(value.key, 60);
  const label = cut(value.label, 40) || key;
  if (!label) return null;
  return {
    key: key || label,
    label,
    category: STATUS_CATEGORIES.includes(value.category) ? value.category : 'unknown',
    detail: cut(value.detail, 200),
    updatedAt: isoOrNull(value.updatedAt)
  };
}

/** 从一条来源条目（discovery.normalizeItem 之后）整理出要写进绑定表的内容。 */
export function linkFromItem(provider, providerLabel, item) {
  return {
    provider,
    providerLabel: cut(providerLabel, 60),
    externalId: cut(item.externalId, 200),
    externalType: cut(item.externalType, 30),
    title: cut(item.title, 200),
    url: httpUrl(item.url),
    status: item.status || null,
    // 原样存、同步时原样交回插件（比如项目 id）；核心不解析。
    meta: item.meta && Object.keys(item.meta).length ? item.meta : null,
    tracking: item.track !== false,
    nodeKey: item.nodeKey || null
  };
}

/**
 * 绑定变了就发到总线（归类引擎据此重算）。insertLink 常在建卡事务里被调，
 * 所以推迟到当前同步调用结束（事务提交）之后再发，监听者看到的是已提交的数据。
 */
function announce(type, payload) {
  queueMicrotask(() => bus.emit(type, payload));
}

/** 写一条绑定（同一任务 + 来源 + 外部 id 只有一条；重复写时只补上更新的信息）。返回绑定 id。 */
export function insertLink(taskId, link) {
  const stamp = now();
  const status = link.status || null;
  const existing = db.prepare('SELECT id FROM task_sources WHERE task_id = ? AND provider = ? AND external_id = ?')
    .get(taskId, link.provider, link.externalId);
  if (existing) {
    if (status) applyToRows([existing.id], status, { url: link.url, title: link.title, meta: link.meta });
    if (link.nodeKey) db.prepare('UPDATE task_sources SET node_key = ? WHERE id = ? AND node_key IS NULL').run(link.nodeKey, existing.id);
    return existing.id;
  }
  const id = uid('ts_');
  db.prepare(`
    INSERT INTO task_sources(id, task_id, provider, provider_label, external_id, external_type, title, url,
      status_key, status_label, status_category, status_detail, status_updated_at, meta, tracking, sync_failures, synced_at, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)
  `).run(
    id, taskId, link.provider, link.providerLabel || null, link.externalId, link.externalType || null,
    link.title || null, link.url || null,
    status?.key || null, status?.label || null, status?.category || 'unknown', status?.detail || null, status?.updatedAt || null,
    metaJson(link.meta), link.tracking === false ? 0 : 1, status ? stamp : null, stamp, stamp
  );
  if (link.nodeKey) db.prepare('UPDATE task_sources SET node_key = ? WHERE id = ?').run(String(link.nodeKey).slice(0, 400), id);
  event(taskId, 'source/linked', { provider: link.provider, label: link.providerLabel, externalId: link.externalId, status: status?.label || null });
  announce('source/linked', { taskId, provider: link.provider, externalId: link.externalId });
  return id;
}

/** 把新状态写到这些绑定上；返回状态真的变了的任务 id。插件给的状态比已有的旧就忽略（旧响应不覆盖新状态）。 */
function applyToRows(ids, status, { url = '', title = '', meta = null } = {}) {
  const changedTasks = new Set();
  const stamp = now();
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM task_sources WHERE id = ?').get(id);
    if (!row) continue;
    if (status.updatedAt && row.status_updated_at && status.updatedAt < row.status_updated_at) {
      db.prepare('UPDATE task_sources SET synced_at = ?, sync_error = NULL, sync_failures = 0 WHERE id = ?').run(stamp, id);
      continue;
    }
    const changed = row.status_key !== status.key || row.status_label !== status.label
      || row.status_category !== status.category || (row.status_detail || '') !== (status.detail || '');
    const recovered = Boolean(row.sync_error);
    db.prepare(`
      UPDATE task_sources SET status_key = ?, status_label = ?, status_category = ?, status_detail = ?, status_updated_at = ?,
        url = COALESCE(?, url), title = COALESCE(?, title), meta = COALESCE(?, meta),
        synced_at = ?, sync_error = NULL, sync_failures = 0, updated_at = ?
      WHERE id = ?
    `).run(
      status.key, status.label, status.category, status.detail || null, status.updatedAt || row.status_updated_at,
      httpUrl(url) || null, cut(title, 200) || null, metaJson(meta), stamp, changed ? stamp : row.updated_at, id
    );
    if (changed) {
      event(row.task_id, 'source/status_changed', {
        provider: row.provider,
        label: row.provider_label,
        externalId: row.external_id,
        from: row.status_label || null,
        to: status.label,
        category: status.category
      });
    }
    if (changed || recovered) changedTasks.add(row.task_id);
  }
  return [...changedTasks];
}

/** 某个来源报来一条外部对象的最新状态：更新所有绑着它、还在跟踪的卡。返回需要推送的任务 id。 */
export function applyStatus(provider, externalId, status, extra = {}) {
  if (!status) return [];
  const ids = db.prepare('SELECT id FROM task_sources WHERE provider = ? AND external_id = ? AND tracking = 1')
    .all(provider, String(externalId)).map((row) => row.id);
  return applyToRows(ids, status, extra);
}

/** 同步失败：保留最后已知状态，只记错误和失败次数（用来退避）。返回错误是第一次出现的任务 id。 */
export function markSyncError(ids, message) {
  const fresh = new Set();
  for (const id of ids) {
    const row = db.prepare('SELECT task_id, sync_error FROM task_sources WHERE id = ?').get(id);
    if (!row) continue;
    db.prepare('UPDATE task_sources SET sync_error = ?, sync_failures = COALESCE(sync_failures, 0) + 1, synced_at = ? WHERE id = ?')
      .run(cut(message, 300), now(), id);
    if (!row.sync_error) {
      fresh.add(row.task_id);
      event(row.task_id, 'source/sync_failed', { error: cut(message, 300) });
    }
  }
  return [...fresh];
}

/** 到了该同步的绑定：在跟踪、任务还在进行或结束不到 7 天、距上次同步超过（退避后的）间隔。 */
export function dueLinks(at = Date.now()) {
  const finishedAfter = new Date(at - syncPolicy.afterFinishMs).toISOString();
  const rows = db.prepare(`
    SELECT s.* FROM task_sources s JOIN tasks t ON t.id = s.task_id
    WHERE s.tracking = 1
      AND (t.status NOT IN ('done', 'failed', 'cancelled') OR t.finished_at IS NULL OR t.finished_at >= ?)
    ORDER BY COALESCE(s.synced_at, '') ASC
    LIMIT 500
  `).all(finishedAfter);
  return rows.filter((row) => {
    if (!row.synced_at) return true;
    const wait = Math.min(syncPolicy.intervalMs * 2 ** Math.min(row.sync_failures || 0, 6), syncPolicy.maxBackoffMs);
    return at - new Date(row.synced_at).getTime() >= wait;
  });
}

export function getLink(taskId, linkId) {
  return db.prepare('SELECT * FROM task_sources WHERE id = ? AND task_id = ?').get(linkId, taskId) || null;
}

function notFound() {
  return Object.assign(new Error('这个来源绑定不存在了'), { statusCode: 404 });
}

export function setTracking(taskId, linkId, tracking) {
  const row = getLink(taskId, linkId);
  if (!row) throw notFound();
  const next = tracking ? 1 : 0;
  if (row.tracking === next) return row;
  // 恢复跟踪时清掉同步时间，下一轮马上同步一次。
  db.prepare('UPDATE task_sources SET tracking = ?, synced_at = CASE WHEN ? = 1 THEN NULL ELSE synced_at END, sync_failures = 0 WHERE id = ?')
    .run(next, next, linkId);
  event(taskId, 'source/tracking_changed', { provider: row.provider, label: row.provider_label, externalId: row.external_id, tracking: Boolean(next) });
  return getLink(taskId, linkId);
}

export function unlink(taskId, linkId) {
  const row = getLink(taskId, linkId);
  if (!row) throw notFound();
  db.prepare('DELETE FROM task_sources WHERE id = ?').run(linkId);
  event(taskId, 'source/unlinked', { provider: row.provider, label: row.provider_label, externalId: row.external_id });
  announce('source/unlinked', { taskId, provider: row.provider, externalId: row.external_id });
  return { ok: true };
}

export function deleteForTask(taskId) {
  db.prepare('DELETE FROM task_sources WHERE task_id = ?').run(taskId);
}

/* ------------------------------- 给界面的形状 ------------------------------- */

function providerInfo(provider) {
  const plugin = plugins.getPlugin(provider);
  if (!plugin) return { exists: false, enabled: false, canSync: false, label: null };
  return {
    exists: true,
    enabled: plugin.enabled,
    canSync: typeof plugin.module?.syncStatus === 'function',
    label: plugin.label
  };
}

/**
 * 同步状态是现场算出来的，不存库，免得和插件启用状态、时间对不上：
 * paused（停止跟踪 / 来源停用或删除）、error、ok、stale（太久没同步）、passive（来源没有 syncStatus，只随轮询更新）。
 */
function syncStateOf(row, info, at) {
  if (!row.tracking) return 'paused';
  if (!info.exists || !info.enabled) return 'paused';
  if (row.sync_error) return 'error';
  if (!info.canSync) return 'passive';
  if (!row.synced_at) return 'stale';
  return at - new Date(row.synced_at).getTime() <= syncPolicy.intervalMs * 2 ? 'ok' : 'stale';
}

function toDto(row, cache, at) {
  if (!cache.has(row.provider)) cache.set(row.provider, providerInfo(row.provider));
  const info = cache.get(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: info.label || row.provider_label || row.provider,
    providerState: !info.exists ? 'removed' : info.enabled ? 'enabled' : 'disabled',
    externalId: row.external_id,
    externalType: row.external_type || '',
    title: row.title || '',
    url: row.url || '',
    status: row.status_label
      ? { key: row.status_key, label: row.status_label, category: row.status_category || 'unknown', detail: row.status_detail || '', updatedAt: row.status_updated_at }
      : null,
    tracking: Boolean(row.tracking),
    nodeKey: row.node_key || null,
    canRefresh: info.exists && info.enabled && info.canSync && Boolean(row.tracking),
    syncState: syncStateOf(row, info, at),
    syncError: row.sync_error || null,
    syncedAt: row.synced_at || null
  };
}

/** 一批任务的绑定：taskId -> [绑定]。一次查完，不按任务逐个查。 */
export function sourcesFor(taskIds) {
  const out = new Map();
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (!ids.length) return out;
  const cache = new Map();
  const at = Date.now();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const rows = db.prepare(`SELECT * FROM task_sources WHERE task_id IN (${part.map(() => '?').join(',')}) ORDER BY created_at ASC`).all(...part);
    for (const row of rows) {
      if (!out.has(row.task_id)) out.set(row.task_id, []);
      out.get(row.task_id).push(toDto(row, cache, at));
    }
  }
  return out;
}

/** 给任务对象挂上 sources（没有绑定就是空数组）。 */
export function attach(tasks) {
  const list = tasks.filter(Boolean);
  const map = sourcesFor(list.map((task) => task.id));
  for (const task of list) task.sources = map.get(task.id) || [];
  return tasks;
}

import crypto from 'node:crypto';
import { db, now, getSettings } from './db.js';
import { availability, isWorker } from './workers.js';

function rowRule(row) {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    position: Number(row.position || 0)
  };
}

export function listWorkerRules() {
  return db.prepare('SELECT * FROM worker_rules ORDER BY position ASC, created_at ASC').all().map(rowRule);
}

function typeMatches(pattern, type) {
  if (!pattern) return true;
  const wanted = String(pattern);
  const actual = String(type || '');
  if (wanted === '*') return true;
  if (wanted.endsWith('.*')) return actual.startsWith(wanted.slice(0, -1));
  return actual === wanted;
}

export function ruleMatches(rule, { text = '', source = '', eventType = '', workspaceId = '' } = {}) {
  if (!rule.enabled) return false;
  if (rule.pattern) {
    try {
      if (!new RegExp(rule.pattern, 'i').test(String(text || ''))) return false;
    } catch {
      return false;
    }
  }
  if (rule.source) {
    const wanted = String(rule.source);
    const actual = String(source || '');
    if (wanted.endsWith('*')) {
      if (!actual.startsWith(wanted.slice(0, -1))) return false;
    } else if (actual !== wanted) {
      return false;
    }
  }
  if (!typeMatches(rule.event_type, eventType)) return false;
  if (rule.workspace_id && String(rule.workspace_id) !== String(workspaceId || '')) return false;
  return true;
}

/**
 * 返回第一个命中且 Worker 当前可用的规则。
 * 规则命中后，调用方应优先使用它，而不是 Router 的默认判断。
 */
export function matchWorkerRule(context) {
  const avail = availability();
  for (const rule of listWorkerRules()) {
    if (!ruleMatches(rule, context)) continue;
    if (!avail[rule.worker]?.available) continue;
    return rule;
  }
  return null;
}

export function saveWorkerRule(id, patch = {}) {
  const current = id ? db.prepare('SELECT * FROM worker_rules WHERE id = ?').get(id) : null;
  const ruleId = current?.id || `wr_${crypto.randomBytes(6).toString('hex')}`;
  const name = String(patch.name ?? current?.name ?? '').trim().slice(0, 80);
  if (!name) throw new Error('规则名称不能为空');

  const worker = String(patch.worker ?? current?.worker ?? '').trim();
  if (!isWorker(worker)) throw new Error('规则里的 Worker 不存在');

  const pattern = String(patch.pattern ?? current?.pattern ?? '').trim();
  if (pattern) {
    try { new RegExp(pattern, 'i'); } catch (err) { throw new Error(`正则表达式无效：${err.message}`); }
  }

  const source = String(patch.source ?? current?.source ?? '').trim().slice(0, 120);
  const eventType = String(patch.event_type ?? current?.event_type ?? '').trim().slice(0, 120);
  const workspaceId = String(patch.workspace_id ?? current?.workspace_id ?? '').trim();
  if (workspaceId) {
    const valid = (getSettings().workspaces || []).some((workspace) => workspace.id === workspaceId);
    if (!valid) throw new Error('规则里的工作区不存在');
  }
  const enabled = patch.enabled === undefined ? (current ? Boolean(current.enabled) : true) : Boolean(patch.enabled);

  if (current) {
    db.prepare(`
      UPDATE worker_rules SET name = ?, enabled = ?, pattern = ?, source = ?, event_type = ?, workspace_id = ?, worker = ? WHERE id = ?
    `).run(name, enabled ? 1 : 0, pattern, source, eventType, workspaceId, worker, ruleId);
  } else {
    const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM worker_rules').get().p;
    db.prepare(`
      INSERT INTO worker_rules(id, name, enabled, position, pattern, source, event_type, workspace_id, worker, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ruleId, name, enabled ? 1 : 0, max + 1, pattern, source, eventType, workspaceId, worker, now());
  }
  return listWorkerRules().find((rule) => rule.id === ruleId);
}

export function deleteWorkerRule(id) {
  db.prepare('DELETE FROM worker_rules WHERE id = ?').run(id);
  return listWorkerRules();
}

export function moveWorkerRule(id, direction) {
  const rules = listWorkerRules();
  const index = rules.findIndex((rule) => rule.id === id);
  const target = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || target < 0 || target >= rules.length) return rules;
  const a = rules[index];
  const b = rules[target];
  const update = db.prepare('UPDATE worker_rules SET position = ? WHERE id = ?');
  update.run(b.position, a.id);
  update.run(a.position, b.id);
  return listWorkerRules();
}

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA_DIR } from './config.js';
import { db, now, getSettings, getSetting, setSetting } from './db.js';
import { validateManifest, validateConfig } from './plugin-spec.js';
import { registerWorkerPlugin, unregisterWorkerPlugin, listWorkerPlugins } from './workers.js';

export const PLUGIN_DIR = path.join(ROOT, 'plugins');
export const USER_PLUGIN_DIR = path.join(DATA_DIR, 'plugins');
const MASK = '••••••••';

/**
 * 首次启动把随安装包发布的插件复制到数据插件目录。
 * 之后所有插件都在同一个目录里，一视同仁，可以删除。
 */
export function seedBuiltins() {
  if (getSetting('builtinPluginsSeeded')) return;
  fs.mkdirSync(USER_PLUGIN_DIR, { recursive: true });
  if (fs.existsSync(PLUGIN_DIR)) {
    for (const entry of fs.readdirSync(PLUGIN_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const source = path.join(PLUGIN_DIR, entry.name);
      const destination = path.join(USER_PLUGIN_DIR, entry.name);
      if (!fs.existsSync(destination)) fs.cpSync(source, destination, { recursive: true });
    }
  }
  setSetting('builtinPluginsSeeded', true);
}

/** id -> { manifest, dir, module, loadedAt } */
const registry = new Map();
const loadErrors = [];

function ensureDefaultInstance(manifest) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM source_plugins WHERE plugin_id = ?').get(manifest.id).c;
  if (count) return;
  const stamp = now();
  const defaults = parseFieldDefaults(manifest.config);
  db.prepare(`
    INSERT INTO source_plugins(id, plugin_id, label, enabled, config, last_status, fail_count, updated_at)
    VALUES(?, ?, ?, 0, ?, 'idle', 0, ?)
  `).run(manifest.id, manifest.id, manifest.name, JSON.stringify(defaults), stamp);
}

function rowFor(instanceId) {
  return db.prepare('SELECT * FROM source_plugins WHERE id = ?').get(instanceId) || null;
}

function instanceRows() {
  return db.prepare('SELECT * FROM source_plugins ORDER BY rowid').all();
}

function makeInstance(pluginId, label) {
  const item = registry.get(pluginId);
  if (!item) throw new Error('插件不存在');
  const count = db.prepare('SELECT COUNT(*) AS c FROM source_plugins WHERE plugin_id = ?').get(pluginId).c;
  if (!item.manifest.multiInstance && count > 0) {
    const err = new Error('这个插件不支持多实例');
    err.statusCode = 400;
    throw err;
  }
  const stamp = now();
  const suffix = crypto.randomBytes(4).toString('hex');
  const id = `${pluginId}~${suffix}`;
  const defaults = parseFieldDefaults(item.manifest.config);
  const instanceLabel = label || `${item.manifest.name} ${count + 1}`;
  db.prepare(`
    INSERT INTO source_plugins(id, plugin_id, label, enabled, config, last_status, fail_count, updated_at)
    VALUES(?, ?, ?, 0, ?, 'idle', 0, ?)
  `).run(id, pluginId, instanceLabel, JSON.stringify(defaults), stamp);
  return id;
}

function parseFieldDefaults(fields = []) {
  const out = {};
  for (const field of fields) {
    if (field.default !== undefined) out[field.key] = field.default;
    else if (field.type === 'checkbox') out[field.key] = false;
    else if (field.type === 'number') out[field.key] = field.min ?? 0;
    else out[field.key] = '';
  }
  return out;
}

/** 扫描数据目录的插件目录，重新加载所有插件。 */
export async function reloadPlugins() {
  loadErrors.length = 0;
  fs.mkdirSync(USER_PLUGIN_DIR, { recursive: true });
  const seen = new Map();
  const loaded = new Set();
  const loadedWorkers = new Set();
  const dirs = fs.readdirSync(USER_PLUGIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);

  for (const name of dirs) {
    const dir = path.join(USER_PLUGIN_DIR, name);
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const manifest = validateManifest(raw, { dir, dirName: name });
      if (seen.has(manifest.id)) {
        throw new Error(`插件 id「${manifest.id}」已被目录「${seen.get(manifest.id)}」占用`);
      }
      seen.set(manifest.id, name);
      const stat = fs.statSync(path.join(dir, manifest.entry));
      const url = `${pathToFileURL(path.join(dir, manifest.entry)).href}?v=${stat.mtimeMs}`;
      const module = await import(url);
      if (manifest.kind === 'worker') {
        registerWorkerPlugin({ manifest, module, dir });
        loadedWorkers.add(manifest.id);
        continue;
      }
      if (typeof module.poll !== 'function') throw new Error('插件没有导出 poll()');
      if (manifest.webhook && typeof module.webhook !== 'function') throw new Error('声明了 webhook 但没有导出 webhook()');
      if (manifest.lifecycle && typeof module.start !== 'function') throw new Error('声明了 lifecycle 但没有导出 start()');
      if (module.test !== undefined && typeof module.test !== 'function') throw new Error('test 必须是一个函数');
      registry.set(manifest.id, { manifest, dir, module, source: 'user', loadedAt: new Date().toISOString() });
      ensureDefaultInstance(manifest);
      loaded.add(manifest.id);
    } catch (err) {
      loadErrors.push({ plugin: name, source: 'user', error: err.message });
      console.warn(`[plugin] 加载 ${name} 失败：${err.message}`);
    }
  }

  for (const id of [...registry.keys()]) {
    if (!loaded.has(id)) registry.delete(id);
  }
  for (const worker of listWorkerPlugins()) {
    if (!loadedWorkers.has(worker.id)) unregisterWorkerPlugin(worker.id);
  }
  return listPlugins();
}

export function pluginErrors() {
  return loadErrors.map((item) => ({ ...item }));
}

function ensureWebhookToken(id) {
  const row = rowFor(id);
  if (!row) return null;
  if (row.webhook_token) return row.webhook_token;
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE source_plugins SET webhook_token = ?, updated_at = ? WHERE id = ?').run(token, now(), id);
  return token;
}

export function findWebhookPlugin(token) {
  if (!token) return null;
  const row = db.prepare('SELECT id FROM source_plugins WHERE webhook_token = ?').get(token);
  if (!row) return null;
  const plugin = getPlugin(row.id);
  if (!plugin || !plugin.enabled || !plugin.manifest.webhook) return null;
  return plugin;
}

/** 删除插件：文件、配置和启用状态一起移除；已建任务保留。 */
export function uninstallPlugin(id) {
  const plugin = getPlugin(id);
  if (!plugin) throw new Error('插件不存在');
  const remaining = db.prepare('SELECT COUNT(*) AS c FROM source_plugins WHERE plugin_id = ? AND id <> ?')
    .get(plugin.pluginId, id).c;
  db.prepare('DELETE FROM source_plugins WHERE id = ?').run(id);
  db.prepare('DELETE FROM plugin_state WHERE instance_id = ?').run(id);
  db.prepare('DELETE FROM plugin_runs WHERE instance_id = ?').run(id);
  if (remaining > 0) return { ok: true, purged: false };
  const root = path.resolve(USER_PLUGIN_DIR) + path.sep;
  const target = path.resolve(plugin.dir);
  if (!target.startsWith(root)) {
    const err = new Error('插件目录不在数据插件目录内，拒绝删除');
    err.statusCode = 400;
    throw err;
  }
  fs.rmSync(target, { recursive: true, force: true });
  return { ok: true, purged: true };
}

export function removeWorkerPlugin(id) {
  const worker = listWorkerPlugins().find((item) => item.id === id);
  if (!worker) throw new Error('Worker 插件不存在');
  const root = path.resolve(USER_PLUGIN_DIR) + path.sep;
  const target = path.resolve(worker.dir);
  if (!target.startsWith(root)) throw new Error('Worker 目录不在数据插件目录内');
  fs.rmSync(target, { recursive: true, force: true });
  unregisterWorkerPlugin(id);
  db.prepare('DELETE FROM worker_configs WHERE id = ?').run(id);
  return { ok: true };
}

export function createInstance(pluginId, label = '') {
  const id = makeInstance(pluginId, String(label || '').trim());
  return getPlugin(id);
}

export function getPluginState(instanceId, key, fallback = null) {
  const row = db.prepare('SELECT value FROM plugin_state WHERE instance_id = ? AND key = ?').get(instanceId, key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setPluginState(instanceId, key, value) {
  const stamp = now();
  db.prepare(`
    INSERT INTO plugin_state(instance_id, key, value, updated_at) VALUES(?, ?, ?, ?)
    ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(instanceId, key, JSON.stringify(value), stamp);
  return value;
}

export function deletePluginState(instanceId, key = null) {
  if (key == null) db.prepare('DELETE FROM plugin_state WHERE instance_id = ?').run(instanceId);
  else db.prepare('DELETE FROM plugin_state WHERE instance_id = ? AND key = ?').run(instanceId, key);
}

export function listRuns(instanceId, limit = 20) {
  return db.prepare('SELECT * FROM plugin_runs WHERE instance_id = ? ORDER BY started_at DESC LIMIT ?').all(instanceId, limit);
}

export function recordRun(instanceId, { startedAt, finishedAt, status, scanned = null, created = null, error = null }) {
  const start = startedAt ? new Date(startedAt).getTime() : Date.now();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  db.prepare(`
    INSERT INTO plugin_runs(id, instance_id, started_at, finished_at, status, scanned, created, error, duration_ms)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(`run_${crypto.randomBytes(6).toString('hex')}`, instanceId, new Date(start).toISOString(), new Date(end).toISOString(), status, scanned, created, error, Math.max(0, end - start));
  db.prepare(`
    DELETE FROM plugin_runs WHERE instance_id = ? AND id NOT IN (
      SELECT id FROM plugin_runs WHERE instance_id = ? ORDER BY started_at DESC LIMIT 100
    )
  `).run(instanceId, instanceId);
}

function readConfig(manifest, row) {
  let stored = {};
  try { stored = JSON.parse(row.config || '{}'); } catch { /* ignore */ }
  return { ...parseFieldDefaults(manifest.config), ...stored };
}

function maskConfig(manifest, config) {
  const out = { ...config };
  for (const field of manifest.config || []) {
    if (field.type === 'password' && out[field.key]) out[field.key] = MASK;
  }
  return out;
}

export function listPlugins() {
  const out = [];
  for (const row of instanceRows()) {
    const pluginId = row.plugin_id || row.id;
    const item = registry.get(pluginId);
    if (!item) continue;
    const { manifest } = item;
    const config = readConfig(manifest, row);
    const token = manifest.type === 'webhook' ? ensureWebhookToken(row.id) : null;
    out.push({
      id: row.id,
      pluginId,
      label: row.label || manifest.name,
      name: manifest.name,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      icon: manifest.icon || 'plug',
      type: manifest.type || 'poll',
      multiInstance: Boolean(manifest.multiInstance),
      intervalMinutes: row.interval_minutes || manifest.intervalMinutes || 30,
      defaultIntervalMinutes: manifest.intervalMinutes || 30,
      capabilities: manifest.capabilities || {},
      configSchema: manifest.config || [],
      enabled: Boolean(row.enabled),
      source: item.source || 'user',
      removable: true,
      webhook: manifest.type === 'webhook',
      lifecycle: manifest.type === 'stream',
      webhookPath: token ? `/api/hooks/${token}` : null,
      workspaceId: row.workspace_id || null,
      config: maskConfig(manifest, config),
      status: {
        lastRun: row.last_run,
        lastStatus: row.last_status,
        lastError: row.last_error,
        lastSummary: row.last_summary,
        failCount: Number(row.fail_count || 0)
      }
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

export function getPlugin(instanceId) {
  let row = rowFor(instanceId);
  if (!row) {
    const direct = registry.get(instanceId);
    if (!direct) return null;
    ensureDefaultInstance(direct.manifest);
    row = rowFor(instanceId);
  }
  if (!row) return null;
  const pluginId = row.plugin_id || row.id;
  const item = registry.get(pluginId);
  if (!item) return null;
  return {
    ...item,
    row,
    id: row.id,
    instanceId: row.id,
    pluginId,
    label: row.label || item.manifest.name,
    config: readConfig(item.manifest, row),
    enabled: Boolean(row.enabled),
    source: item.source || 'user',
    removable: true,
    workspaceId: row.workspace_id || null,
    type: item.manifest.type || 'poll',
    multiInstance: Boolean(item.manifest.multiInstance),
    intervalMinutes: row.interval_minutes || item.manifest.intervalMinutes || 30,
    defaultIntervalMinutes: item.manifest.intervalMinutes || 30
  };
}

export function savePlugin(id, { enabled, config, workspaceId, intervalMinutes, label } = {}) {
  const plugin = getPlugin(id);
  if (!plugin) throw new Error('插件不存在');
  const row = plugin.row;
  const current = plugin.config;
  const patch = { ...(config || {}) };
  for (const field of plugin.manifest.config || []) {
    if (field.type === 'password' && patch[field.key] === MASK) patch[field.key] = current[field.key] ?? '';
  }
  const nextConfig = { ...current, ...patch };
  const nextEnabled = enabled === undefined ? Boolean(row.enabled) : Boolean(enabled);
  const normalized = validateConfig(plugin.manifest, nextConfig, { requireAll: nextEnabled });
  let nextInterval = intervalMinutes === undefined ? row.interval_minutes : intervalMinutes;
  if (nextInterval !== null && nextInterval !== '') {
    nextInterval = Number(nextInterval);
    if (!Number.isInteger(nextInterval) || nextInterval < 1 || nextInterval > 1440) {
      const err = new Error('获取频率必须是 1–1440 分钟的整数');
      err.statusCode = 400;
      throw err;
    }
    if ((plugin.manifest.type || 'poll') !== 'poll') {
      const err = new Error('只有轮询型插件能设置获取频率');
      err.statusCode = 400;
      throw err;
    }
  } else {
    nextInterval = null;
  }
  const workspaceIds = new Set(getSettings().workspaces.map((item) => item.id));
  let nextWorkspace = workspaceId === undefined ? row.workspace_id || null : workspaceId || null;
  if (nextWorkspace && !workspaceIds.has(nextWorkspace)) {
    const err = new Error('工作区不存在');
    err.statusCode = 400;
    throw err;
  }
  const nextLabel = label === undefined ? (row.label || plugin.manifest.name) : (String(label).trim().slice(0, 60) || plugin.manifest.name);
  db.prepare(`
    UPDATE source_plugins SET label = ?, enabled = ?, config = ?, workspace_id = ?, interval_minutes = ?, updated_at = ? WHERE id = ?
  `).run(nextLabel, nextEnabled ? 1 : 0, JSON.stringify(normalized), nextWorkspace, nextInterval, now(), id);
  return getPlugin(id);
}

/** 测试通过后清掉上一次运行留下的错误状态 */
export function clearPluginError(id) {
  db.prepare("UPDATE source_plugins SET last_status = 'idle', last_error = NULL, fail_count = 0 WHERE id = ? AND last_status = 'error'").run(id);
}

export function markPluginStatus(id, { status, summary = null, error = null }) {
  db.prepare(`
    UPDATE source_plugins
    SET last_status = ?, last_summary = ?, last_error = ?, fail_count = CASE WHEN ? = 'error' THEN COALESCE(fail_count, 0) + 1 ELSE 0 END, updated_at = ?
    WHERE id = ?
  `).run(status, summary, error, status, now(), id);
}

export function markPluginRun(id, { status, summary = null, error = null }) {
  db.prepare(`
    UPDATE source_plugins
    SET last_run = ?, last_status = ?, last_summary = ?, last_error = ?, fail_count = CASE WHEN ? = 'error' THEN COALESCE(fail_count, 0) + 1 ELSE 0 END, updated_at = ?
    WHERE id = ?
  `).run(now(), status, summary, error, status, now(), id);
}

export { MASK };

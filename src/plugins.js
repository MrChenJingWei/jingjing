import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, DATA_DIR } from './config.js';
import { db, now, getSettings, getSetting, setSetting } from './db.js';
import { validateManifest, validateConfig } from './plugin-spec.js';
import { registerWorkerPlugin, unregisterWorkerPlugin, listWorkerPlugins } from './workers.js';
import { importPluginEntry } from './plugin-loader.js';

/**
 * 插件有两个来源：
 * - 官方：<app>/plugins/，随 App 发布和在线升级，只读；
 * - 我的：<data>/plugins/，用户安装、自己写或让静静写的，App 升级永远不会覆盖。
 * 「我的」里出现和官方同 id 的插件时，加载「我的」那份（覆盖官方）；删掉它就恢复官方版本，
 * 实例配置按插件 id 存，覆盖 / 恢复都不会丢。
 */
export const PLUGIN_DIR = path.join(ROOT, 'plugins');
export const USER_PLUGIN_DIR = path.join(DATA_DIR, 'plugins');
const MIGRATED_DIR = path.join(USER_PLUGIN_DIR, '.migrated');
const MASK = '••••••••';

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

function sameContent(a, b) {
  try {
    const left = listFiles(a);
    const right = listFiles(b);
    if (left.join('\n') !== right.join('\n')) return false;
    return left.every((file) => fs.readFileSync(path.join(a, file)).equals(fs.readFileSync(path.join(b, file))));
  } catch {
    return false;
  }
}

/** 复制出来以后有没有被改过：所有文件的修改时间都在目录创建后 1 分钟内，就当没改过。 */
function untouchedSinceCopy(dir) {
  try {
    const created = fs.statSync(dir).birthtimeMs;
    if (!created) return false;
    return listFiles(dir).every((file) => fs.statSync(path.join(dir, file)).mtimeMs - created < 60 * 1000);
  } catch {
    return false;
  }
}

/**
 * 旧版本会在第一次启动时把官方插件复制到数据目录，之后官方更新就到不了用户手里。
 * 迁移一次：没改过的副本挪到 plugins/.migrated/ 备份（不删除），改用官方版本；改过的保留，当作「我的」。
 */
export function migrateSeededCopies() {
  if (getSetting('officialPluginsMigrated')) return [];
  const moved = [];
  if (fs.existsSync(USER_PLUGIN_DIR) && fs.existsSync(PLUGIN_DIR)) {
    for (const entry of fs.readdirSync(PLUGIN_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const copy = path.join(USER_PLUGIN_DIR, entry.name);
      if (!fs.existsSync(copy)) continue;
      if (!sameContent(path.join(PLUGIN_DIR, entry.name), copy) && !untouchedSinceCopy(copy)) continue;
      fs.mkdirSync(MIGRATED_DIR, { recursive: true });
      fs.renameSync(copy, path.join(MIGRATED_DIR, `${entry.name}-${Date.now()}`));
      moved.push(entry.name);
    }
  }
  if (moved.length) console.log(`[plugin] 已改用官方版本：${moved.join('、')}（旧副本备份在 plugins/.migrated/）`);
  setSetting('officialPluginsMigrated', true);
  return moved;
}

/** 兼容旧调用：启动时执行一次迁移。 */
export function seedBuiltins() {
  return migrateSeededCopies();
}

/** id -> { manifest, dir, module, source: 'official' | 'user', shadows: officialManifest | null, loadedAt } */
const registry = new Map();
const loadErrors = [];
/** 官方插件清单：id -> { manifest, dir }，包括被「我的」覆盖的那些。 */
const officialCatalog = new Map();

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

function scanDir(root, source) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
      out.push({ name: entry.name, dir, source, manifest: validateManifest(raw, { dir, dirName: entry.name }) });
    } catch (err) {
      loadErrors.push({ plugin: entry.name, source, error: err.message });
      console.warn(`[plugin] ${source === 'official' ? '官方' : ''}插件 ${entry.name} 不合规范：${err.message}`);
    }
  }
  return out;
}

/** 扫描官方和「我的」两个插件目录，重新加载所有插件。 */
export async function reloadPlugins() {
  loadErrors.length = 0;
  fs.mkdirSync(USER_PLUGIN_DIR, { recursive: true });
  const loaded = new Set();
  const loadedWorkers = new Set();

  // 官方在前，「我的」同 id 的覆盖官方。
  officialCatalog.clear();
  const candidates = new Map();
  for (const item of scanDir(PLUGIN_DIR, 'official')) {
    officialCatalog.set(item.manifest.id, { manifest: item.manifest, dir: item.dir });
    candidates.set(item.manifest.id, { ...item, shadows: null });
  }
  for (const item of scanDir(USER_PLUGIN_DIR, 'user')) {
    const existing = candidates.get(item.manifest.id);
    if (existing && existing.source === 'user') {
      loadErrors.push({ plugin: item.name, source: 'user', error: `插件 id「${item.manifest.id}」已被目录「${existing.name}」占用` });
      continue;
    }
    candidates.set(item.manifest.id, { ...item, shadows: existing?.source === 'official' ? existing.manifest : null });
  }

  for (const { name, dir, source, manifest, shadows } of candidates.values()) {
    try {
      const module = await importPluginEntry(dir, manifest.entry);
      if (manifest.kind === 'worker') {
        registerWorkerPlugin({ manifest, module, dir, origin: source });
        loadedWorkers.add(manifest.id);
        continue;
      }
      if (typeof module.poll !== 'function') throw new Error('插件没有导出 poll()');
      if (manifest.webhook && typeof module.webhook !== 'function') throw new Error('声明了 webhook 但没有导出 webhook()');
      if (manifest.lifecycle && typeof module.start !== 'function') throw new Error('声明了 lifecycle 但没有导出 start()');
      if (module.test !== undefined && typeof module.test !== 'function') throw new Error('test 必须是一个函数');
      registry.set(manifest.id, { manifest, dir, module, source, shadows, loadedAt: new Date().toISOString() });
      ensureDefaultInstance(manifest);
      loaded.add(manifest.id);
    } catch (err) {
      loadErrors.push({ plugin: name, source, error: err.message });
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

/** 删除插件：文件、配置和启用状态一起移除；已建任务保留。官方插件只能删多出来的实例，默认实例只能停用。 */
export function uninstallPlugin(id) {
  const plugin = getPlugin(id);
  if (!plugin) throw new Error('插件不存在');
  if (plugin.source === 'official' && id === plugin.pluginId) {
    const err = new Error('官方插件不能删除，不用的话停用就好；想改它可以「复制为我的插件」');
    err.statusCode = 400;
    throw err;
  }
  const remaining = db.prepare('SELECT COUNT(*) AS c FROM source_plugins WHERE plugin_id = ? AND id <> ?')
    .get(plugin.pluginId, id).c;
  if (plugin.source === 'official') {
    db.prepare('DELETE FROM source_plugins WHERE id = ?').run(id);
    db.prepare('DELETE FROM plugin_state WHERE instance_id = ?').run(id);
    db.prepare('DELETE FROM plugin_runs WHERE instance_id = ?').run(id);
    return { ok: true, purged: false };
  }
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
  if (!target.startsWith(root)) throw new Error('官方 Worker 插件不能删除，可以停用或隐藏');
  fs.rmSync(target, { recursive: true, force: true });
  unregisterWorkerPlugin(id);
  db.prepare('DELETE FROM worker_configs WHERE id = ?').run(id);
  return { ok: true };
}

function userCopyOf(pluginId) {
  const dir = path.join(USER_PLUGIN_DIR, pluginId);
  return fs.existsSync(path.join(dir, 'plugin.json')) ? dir : null;
}

/**
 * 把官方插件复制一份到「我的」，换一个新 id，之后可以随便改；官方版本照常保留和更新。
 * 返回新插件的 id。
 */
export function forkOfficial(pluginId) {
  const official = officialCatalog.get(pluginId);
  if (!official) throw Object.assign(new Error('没有这个官方插件'), { statusCode: 404 });
  const base = `${pluginId.slice(0, 26)}-mine`;
  let id = base;
  for (let i = 2; fs.existsSync(path.join(USER_PLUGIN_DIR, id)) || officialCatalog.has(id); i += 1) id = `${base}${i}`;
  const target = path.join(USER_PLUGIN_DIR, id);
  fs.cpSync(official.dir, target, { recursive: true });
  const manifestPath = path.join(target, 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  raw.id = id;
  raw.name = `${raw.name}（我的）`.slice(0, 60);
  fs.writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  return id;
}

/** 删掉「我的」里覆盖官方的那一份，恢复官方版本。实例配置保留。旧文件挪到 .migrated/ 备份。 */
export function restoreOfficial(pluginId) {
  if (!officialCatalog.has(pluginId)) throw Object.assign(new Error('没有这个官方插件'), { statusCode: 404 });
  const copy = userCopyOf(pluginId);
  if (!copy) throw Object.assign(new Error('当前用的已经是官方版本'), { statusCode: 400 });
  fs.mkdirSync(MIGRATED_DIR, { recursive: true });
  fs.renameSync(copy, path.join(MIGRATED_DIR, `${pluginId}-${Date.now()}`));
  return { ok: true };
}

export function isOfficialPlugin(pluginId) {
  return officialCatalog.has(pluginId);
}

/** 官方插件的清单列表（含被「我的」覆盖的），给「静静写插件」查有没有现成的用。 */
export function officialManifests() {
  return [...officialCatalog.values()].map((item) => item.manifest);
}

/** 所有插件 id（官方 + 我的，含 Worker），给「静静写插件」查重用。 */
export function knownPluginIds() {
  const ids = new Set(officialCatalog.keys());
  if (fs.existsSync(USER_PLUGIN_DIR)) {
    for (const entry of fs.readdirSync(USER_PLUGIN_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) ids.add(entry.name);
    }
  }
  return ids;
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

/** 插件能不能往原会话说话：导出了 deliver()（完整的播报接口）或旧的 reply()（只能发结果和闲聊回复）。 */
export function canSpeak(module) {
  return typeof module?.deliver === 'function' || typeof module?.reply === 'function';
}

export const RELAY_STATUS = ['off', 'key', 'progress'];

/**
 * 往外说话的策略，存在静静这边（插件代码里不放）：
 * ack 收到消息先回执；status 状态播报（off 不播 / key 只播等拍板、完成、失败 / progress 再加进度）；
 * owners 能在群里拍板、接着做的人（渠道里的用户 id，逗号分隔），默认没有人。
 */
export function relayPolicy(row) {
  let raw = {};
  try { raw = row?.relay ? JSON.parse(row.relay) : {}; } catch { raw = {}; }
  // 还没设置过：沿用旧版企微插件配置里的「收到消息后回执」（replyAck）。
  if (!row?.relay) {
    try { if (JSON.parse(row?.config || '{}').replyAck === false) raw.ack = false; } catch { /* 没有就算了 */ }
  }
  return {
    ack: raw.ack !== false,
    status: RELAY_STATUS.includes(raw.status) ? raw.status : 'key',
    owners: String(raw.owners || '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean),
    autoResult: Boolean(row?.auto_reply)
  };
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
      // 「我的」覆盖了官方同 id 插件时，带上官方版本号，界面上可以提示「官方有更新」并一键恢复。
      overridesOfficial: Boolean(item.shadows),
      officialVersion: item.shadows?.version || (item.source === 'official' ? manifest.version : null),
      removable: item.source !== 'official' || row.id !== pluginId,
      webhook: manifest.type === 'webhook',
      lifecycle: manifest.type === 'stream',
      // 插件导出了 reply() / deliver() 就能把任务结果发回原会话；autoReply 是用户打开的「完成后自动发回」。
      canReply: canSpeak(item.module),
      autoReply: Boolean(row.auto_reply) && canSpeak(item.module),
      // NULL 时沿用旧行为（跟着 autoReply），显式值才独立。
      autoChat: canSpeak(item.module) && (row.auto_chat === null || row.auto_chat === undefined ? Boolean(row.auto_reply) : Boolean(row.auto_chat)),
      // 导出了 deliver()：收到回执、状态播报、在渠道里拍板都由静静按 relay 策略来管。
      canDeliver: typeof item.module?.deliver === 'function',
      relay: (({ autoResult: _a, ...rest }) => ({ ...rest, owners: rest.owners.join(', ') }))(relayPolicy(row)),
      // 声明了归类能力（manifest.classification）：设置页据此显示三态开关。声明不等于启用。
      classification: manifest.classification
        ? { declared: true, state: ['observing', 'on'].includes(row.classify_state) ? row.classify_state : 'off', nodeTypes: manifest.classification.nodeTypes, nodeLabels: manifest.classification.nodeLabels || {} }
        : { declared: false, state: 'off' },
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
    overridesOfficial: Boolean(item.shadows),
    removable: item.source !== 'official' || row.id !== pluginId,
    workspaceId: row.workspace_id || null,
    type: item.manifest.type || 'poll',
    multiInstance: Boolean(item.manifest.multiInstance),
    intervalMinutes: row.interval_minutes || item.manifest.intervalMinutes || 30,
    defaultIntervalMinutes: item.manifest.intervalMinutes || 30
  };
}

export function savePlugin(id, { enabled, config, workspaceId, intervalMinutes, label, autoReply, autoChat, relay } = {}) {
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
  const nextAutoReply = autoReply === undefined ? Boolean(row.auto_reply) : Boolean(autoReply);
  if (nextAutoReply && !canSpeak(plugin.module)) {
    const err = new Error('这个插件不支持把结果发回原会话');
    err.statusCode = 400;
    throw err;
  }
  // 闲聊开关独立存；没显式设置过就保持 NULL，沿用旧行为（跟着 autoReply），不主动写值。
  if (autoChat !== undefined && Boolean(autoChat) && !canSpeak(plugin.module)) {
    const err = new Error('这个插件不支持自动回消息');
    err.statusCode = 400;
    throw err;
  }
  let nextRelay = row.relay || null;
  if (relay !== undefined) {
    const current = relayPolicy(row);
    const status = relay.status === undefined ? current.status : relay.status;
    if (!RELAY_STATUS.includes(status)) throw Object.assign(new Error('状态播报只能是 off / key / progress'), { statusCode: 400 });
    const owners = relay.owners === undefined ? current.owners.join(',') : String(relay.owners || '').slice(0, 1000);
    nextRelay = JSON.stringify({ ack: relay.ack === undefined ? current.ack : Boolean(relay.ack), status, owners });
  }
  db.prepare('UPDATE source_plugins SET relay = ? WHERE id = ?').run(nextRelay, id);
  db.prepare(`
    UPDATE source_plugins SET label = ?, enabled = ?, config = ?, workspace_id = ?, interval_minutes = ?, auto_reply = ?, updated_at = ? WHERE id = ?
  `).run(nextLabel, nextEnabled ? 1 : 0, JSON.stringify(normalized), nextWorkspace, nextInterval, nextAutoReply ? 1 : 0, now(), id);
  if (autoChat !== undefined) {
    db.prepare('UPDATE source_plugins SET auto_chat = ? WHERE id = ?').run(autoChat ? 1 : 0, id);
  }
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

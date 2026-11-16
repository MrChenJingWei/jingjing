/**
 * Worker 注册表与宿主 API。
 *
 * 所有 Worker（包括内置的）都是同一种插件包：plugin.json（kind: "worker"）+ 入口模块。
 * - 内置 Worker 随代码发布在 <app>/workers/<id>/，跟着在线升级一起更新；
 * - 用户安装的 Worker 插件在 <data>/plugins/<id>/，由 plugins.js 加载。
 * 入口只能通过 execute(task, ctx) 拿到的 ctx 使用宿主能力，不直接 import 核心模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, SANDBOX_DIR } from './config.js';
import { db, now, getSettings } from './db.js';
import { validateManifest, validateConfig, validateWorkerLimits, WORKER_DEFAULTS, WORKER_LIMIT_RANGES } from './plugin-spec.js';
import { chat, demoTaskOutput, estimateTokens, llmMode } from './llm.js';
import { pickWorker } from './worker-routing.js';

export const BUILTIN_WORKER_DIR = path.join(ROOT, 'workers');
const RESULT_STATUSES = new Set(['done', 'failed', 'needs_approval', 'cancelled']);
const WORKER_MASK = '••••••••';

/* --------------------------------- 工具 --------------------------------- */

const BIN = {};
export function which(bin) {
  if (!(bin in BIN)) {
    const home = process.env.HOME || '';
    const extra = [
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin'
    ];
    const env = { ...process.env, PATH: [...extra, process.env.PATH || ''].join(':') };
    const r = spawnSync('which', [bin], { encoding: 'utf8', env });
    BIN[bin] = r.status === 0 ? r.stdout.trim() : null;
    if (!BIN[bin]) {
      for (const dir of extra) {
        const candidate = path.join(dir, bin);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          BIN[bin] = candidate;
          break;
        } catch { /* ignore */ }
      }
    }
  }
  return BIN[bin];
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/**
 * 运行一个外部命令。signal 中止时先 SIGTERM，1.5 秒后 SIGKILL，并返回 { error: 'aborted' }。
 * timeoutMs 为 0 表示不单独设超时（由调度器按 Worker 的 timeoutMinutes 统一中止）。
 */
export function runCommand(cmd, args = [], { cwd, signal, onOutput, timeoutMs = 0, env: extraEnv = {} } = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (value === null || value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: -2, error: 'aborted', stdout: '', stderr: '' });
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    child.stdout.on('data', (buf) => { stdout += buf.toString(); onOutput?.(buf.toString()); });
    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.on('error', (err) => finish({ code: -1, error: err.message }));
    child.on('close', (code) => finish({ code }));
    signal?.addEventListener('abort', () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref?.();
      finish({ code: -2, error: 'aborted' });
    }, { once: true });
  });
}

/** 解析输出末尾的 [[APPROVAL]] {"question":"…","options":[…]} 标记。 */
export function extractApproval(text) {
  const idx = String(text || '').lastIndexOf('[[APPROVAL]]');
  if (idx === -1) return null;
  const body = text.slice(idx + '[[APPROVAL]]'.length).trim();
  try {
    const parsed = JSON.parse(body.split('\n').filter(Boolean)[0]);
    if (!parsed.question) return null;
    return {
      approval: {
        question: String(parsed.question),
        options: Array.isArray(parsed.options) && parsed.options.length
          ? parsed.options.map(String).slice(0, 5)
          : ['继续', '先停一下']
      },
      text: text.slice(0, idx).trim()
    };
  } catch {
    return null;
  }
}

/* -------------------------------- 注册表 -------------------------------- */

/** id -> { id, source: 'builtin'|'plugin', dir, manifest, module } */
const workerRegistry = new Map();

function workerRow(id) {
  return db.prepare('SELECT * FROM worker_configs WHERE id = ?').get(id) || null;
}

function parseJson(text) {
  try { return JSON.parse(text || '{}') || {}; } catch { return {}; }
}

function register(descriptor) {
  workerRegistry.set(descriptor.id, descriptor);
  if (!workerRow(descriptor.id)) {
    db.prepare('INSERT INTO worker_configs(id, enabled, config, updated_at) VALUES(?, 1, ?, ?)')
      .run(descriptor.id, '{}', now());
  }
}

function assertWorkerModule(module) {
  if (typeof module.execute !== 'function') throw new Error('Worker 插件没有导出 execute()');
  if (module.detect !== undefined && typeof module.detect !== 'function') throw new Error('detect 必须是一个函数');
  if (module.test !== undefined && typeof module.test !== 'function') throw new Error('test 必须是一个函数');
}

/** 加载 <app>/workers/ 下随代码发布的内置 Worker。返回加载失败的列表。 */
export async function loadBuiltinWorkers(dir = BUILTIN_WORKER_DIR) {
  const errors = [];
  if (!fs.existsSync(dir)) return errors;
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const pluginDir = path.join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
      const manifest = validateManifest(raw, { dir: pluginDir, dirName: name });
      if (manifest.kind !== 'worker') throw new Error('内置 Worker 的 kind 必须是 worker');
      const entry = path.join(pluginDir, manifest.entry);
      const module = await import(`${pathToFileURL(entry).href}?v=${fs.statSync(entry).mtimeMs}`);
      assertWorkerModule(module);
      register({ id: manifest.id, source: 'builtin', dir: pluginDir, manifest, module });
    } catch (err) {
      errors.push({ worker: name, error: err.message });
      console.warn(`[worker] 加载内置 Worker ${name} 失败：${err.message}`);
    }
  }
  return errors;
}

export function registerWorkerPlugin({ manifest, module, dir }) {
  const existing = workerRegistry.get(manifest.id);
  if (existing?.source === 'builtin') throw new Error(`Worker id「${manifest.id}」与内置 Worker 冲突`);
  if (existing && existing.dir !== dir) throw new Error(`Worker id「${manifest.id}」已被占用`);
  assertWorkerModule(module);
  register({ id: manifest.id, source: 'plugin', dir, manifest, module });
}

export function unregisterWorkerPlugin(id) {
  if (workerRegistry.get(id)?.source === 'plugin') workerRegistry.delete(id);
}

export function isBuiltinWorker(id) {
  return workerRegistry.get(id)?.source === 'builtin';
}

export function isWorkerDeleted(id) {
  return Boolean(workerRow(id)?.deleted);
}

export function isWorker(id) {
  return workerRegistry.has(id) && !isWorkerDeleted(id);
}

export function deleteBuiltinWorker(id) {
  if (!isBuiltinWorker(id)) throw new Error('不是内置 Worker');
  db.prepare(`
    INSERT INTO worker_configs(id, enabled, deleted, config, updated_at) VALUES(?, 1, 1, '{}', ?)
    ON CONFLICT(id) DO UPDATE SET deleted = 1, updated_at = excluded.updated_at
  `).run(id, now());
  return { ok: true, builtin: true };
}

export function restoreBuiltinWorkers() {
  const update = db.prepare('UPDATE worker_configs SET deleted = 0 WHERE id = ?');
  for (const descriptor of workerRegistry.values()) {
    if (descriptor.source === 'builtin') update.run(descriptor.id);
  }
  return { ok: true };
}

export function listWorkerPlugins() {
  return [...workerRegistry.values()]
    .filter((descriptor) => descriptor.source === 'plugin')
    .map((descriptor) => ({ id: descriptor.id, label: descriptor.manifest.name, dir: descriptor.dir }));
}

/* ------------------------------ 配置与限制 ------------------------------ */

function workerConfig(descriptor) {
  const defaults = {};
  for (const field of descriptor.manifest.config || []) defaults[field.key] = field.default;
  return { ...defaults, ...parseJson(workerRow(descriptor.id)?.config) };
}

function maskConfig(descriptor, config) {
  const out = { ...config };
  for (const field of descriptor.manifest.config || []) {
    if (field.type === 'password' && out[field.key]) out[field.key] = WORKER_MASK;
  }
  return out;
}

function limitDefaults(descriptor) {
  const block = descriptor?.manifest?.worker || WORKER_DEFAULTS;
  return {
    timeoutMinutes: block.timeoutMinutes,
    concurrency: block.concurrency,
    retries: block.retries
  };
}

/** Worker 的实际运行限制：manifest 默认值，叠加本机在设置页里的覆盖。 */
export function workerLimits(id) {
  const descriptor = workerRegistry.get(id);
  const defaults = limitDefaults(descriptor);
  const stored = parseJson(workerRow(id)?.limits);
  const out = { ...defaults };
  for (const [key, range] of Object.entries(WORKER_LIMIT_RANGES)) {
    const value = Number(stored[key]);
    if (Number.isInteger(value) && value >= range.min && value <= range.max) out[key] = value;
  }
  return out;
}

export function saveWorkerConfig(id, { config, enabled, limits } = {}) {
  const descriptor = workerRegistry.get(id);
  if (!descriptor || isWorkerDeleted(id)) throw new Error('Worker 不存在');
  const row = workerRow(id);
  const current = workerConfig(descriptor);
  const patch = { ...(config || {}) };
  for (const field of descriptor.manifest.config || []) {
    if (field.type === 'password' && patch[field.key] === WORKER_MASK) patch[field.key] = current[field.key] ?? '';
  }
  const nextEnabled = enabled === undefined ? (row ? Boolean(row.enabled) : true) : Boolean(enabled);
  const normalized = validateConfig(descriptor.manifest, { ...current, ...patch }, { requireAll: nextEnabled });
  const nextLimits = limits === undefined ? parseJson(row?.limits) : validateWorkerLimits(limits);
  db.prepare(`
    INSERT INTO worker_configs(id, enabled, config, limits, updated_at) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config,
      limits = excluded.limits, updated_at = excluded.updated_at
  `).run(id, nextEnabled ? 1 : 0, JSON.stringify(normalized), JSON.stringify(nextLimits), now());
  return availability()[id];
}

/* --------------------------------- 检测 --------------------------------- */

function detectContext() {
  return { settings: getSettings(), which };
}

function normalizeDetection(result) {
  if (result === false) return { available: false, detail: '当前主机不可用' };
  if (result === true || result === undefined || result === null) return { available: true, detail: '已安装' };
  return { available: Boolean(result.available), detail: String(result.detail || '') };
}

function workerDetection(descriptor) {
  const row = workerRow(descriptor.id);
  if (row && !row.enabled) return { available: false, detail: '已停用' };
  if (typeof descriptor.module.detect !== 'function') return { available: true, detail: '已安装' };
  try {
    return normalizeDetection(descriptor.module.detect(workerConfig(descriptor), detectContext()));
  } catch (err) {
    return { available: false, detail: err.message };
  }
}

export async function testWorker(id) {
  const descriptor = workerRegistry.get(id);
  if (!descriptor || isWorkerDeleted(id)) throw new Error('Worker 不存在');
  if (typeof descriptor.module.test === 'function') {
    try {
      return normalizeDetection(await descriptor.module.test(workerConfig(descriptor), detectContext()));
    } catch (err) {
      return { available: false, detail: err.message };
    }
  }
  return workerDetection(descriptor);
}

export function availability() {
  const out = {};
  for (const descriptor of workerRegistry.values()) {
    if (isWorkerDeleted(descriptor.id)) continue;
    const { manifest } = descriptor;
    const detection = workerDetection(descriptor);
    const row = workerRow(descriptor.id);
    out[descriptor.id] = {
      available: detection.available,
      detail: detection.detail,
      label: manifest.name,
      glyph: manifest.icon || '工',
      description: manifest.description,
      version: manifest.version,
      source: descriptor.source,
      enabled: row ? Boolean(row.enabled) : true,
      abilities: manifest.worker.abilities,
      cost: manifest.worker.cost,
      keywords: manifest.worker.keywords,
      limits: workerLimits(descriptor.id),
      limitDefaults: limitDefaults(descriptor),
      configSchema: manifest.config || [],
      config: maskConfig(descriptor, workerConfig(descriptor))
    };
  }
  return out;
}

/** 给 Router / worker-routing 用的精简列表（含不可用的，由 routing 自己过滤）。 */
export function workerCatalog({ onlyAvailable = false } = {}) {
  return Object.entries(availability())
    .filter(([, item]) => !onlyAvailable || item.available)
    .map(([id, item]) => ({
      id,
      label: item.label,
      description: item.description,
      available: item.available,
      abilities: item.abilities,
      cost: item.cost,
      keywords: item.keywords,
      source: item.source
    }));
}

/** 没有指定 Worker 时的默认选择：最便宜的可用文本 Worker。 */
export function defaultWorker() {
  return pickWorker({ workers: workerCatalog() }).worker || 'llm';
}

/* --------------------------------- 执行 --------------------------------- */

function hostContext(descriptor, task, ctx) {
  const settings = getSettings();
  const signal = ctx.signal;
  const emit = async (message, meta = {}) => ctx.onProgress?.(String(message), meta);
  return {
    signal,
    emit,
    log: (message) => console.log(`[worker:${descriptor.id}] ${message}`),
    config: workerConfig(descriptor),
    settings,
    resume: ctx.resume || null,
    sessionId: task.resume_payload?.session_id || null,
    memories: ctx.memories || [],
    tasks: ctx.tasks || [],
    workers: workerCatalog({ onlyAvailable: true }),
    workspace: path.resolve(task.cwd || settings.defaultCwd || SANDBOX_DIR),
    paths: { sandbox: SANDBOX_DIR },
    llm: {
      mode: llmMode(settings),
      chat: (options = {}) => chat({ ...options, signal: options.signal || signal }),
      demoOutput: () => demoTaskOutput({ task, memories: ctx.memories || [], tasks: ctx.tasks || [] })
    },
    exec: (cmd, args, options = {}) => runCommand(cmd, args, { ...options, signal: options.signal || signal }),
    which,
    sleep: (ms) => sleep(ms, signal),
    parseApproval: extractApproval,
    estimateTokens
  };
}

function normalizeResult(descriptor, result) {
  if (!result || typeof result !== 'object') throw new Error('execute() 必须返回结果对象');
  if (!RESULT_STATUSES.has(result.status)) throw new Error(`execute() 返回了未知状态：${result.status}`);
  if (result.status === 'needs_approval' && !result.approval?.question) {
    throw new Error('needs_approval 必须带 approval.question');
  }
  return result;
}

/**
 * 执行一个任务。插件异常一律转成 failed，不会抛出。
 * 超时与取消由调度器通过 ctx.signal 统一处理。
 */
export async function runWorker(task, ctx = {}) {
  const descriptor = workerRegistry.get(task.worker);
  if (!descriptor || isWorkerDeleted(task.worker)) {
    return { status: 'failed', summary: `未知的 Worker：${task.worker}`, retryable: false };
  }
  const row = workerRow(descriptor.id);
  if (row && !row.enabled) {
    return { status: 'failed', summary: `Worker「${descriptor.manifest.name}」已停用。`, retryable: false };
  }
  try {
    return normalizeResult(descriptor, await descriptor.module.execute(task, hostContext(descriptor, task, ctx)));
  } catch (err) {
    if (ctx.signal?.aborted || err?.message === 'aborted' || err?.name === 'AbortError') {
      return { status: 'cancelled', summary: '任务已停止。' };
    }
    return { status: 'failed', summary: `Worker「${descriptor.manifest.name}」执行失败：${err.message}` };
  }
}

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
import { Worker as ThreadWorker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { ROOT, SANDBOX_DIR, HOST, PORT } from './config.js';
import { db, now, getSettings, pluginSettings } from './db.js';
import { validateManifest, validateConfig, validateWorkerLimits, WORKER_DEFAULTS, WORKER_LIMIT_RANGES } from './plugin-spec.js';
import { chat, demoTaskOutput, llmMode } from './llm.js';
import { pickWorker } from './worker-routing.js';
import { which, clearWhichCache, sleep, runCommand, extractApproval, estimateTokens } from './worker-runtime.js';

export { which, clearWhichCache, runCommand, extractApproval };

export const BUILTIN_WORKER_DIR = path.join(ROOT, 'workers');
const RESULT_STATUSES = new Set(['done', 'failed', 'needs_approval', 'cancelled']);
const WORKER_MASK = '••••••••';
// 插件线程收到中止后的宽限期，超时直接 terminate（同步死循环也能被结束）。
const THREAD_GRACE_MS = 2000;

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

/**
 * 注册第三方 Worker 插件。isolate=true（默认）时 execute 在独立线程里跑，
 * detect / test 仍在主线程同步调用，所以它们必须足够快。
 */
export function registerWorkerPlugin({ manifest, module, dir, isolate = true, origin = 'user' }) {
  const existing = workerRegistry.get(manifest.id);
  if (existing?.source === 'builtin') throw new Error(`Worker id「${manifest.id}」与内置 Worker 冲突`);
  // 同 id 的插件重新加载、或「我的」覆盖官方时直接替换；同一轮加载里的重复 id 由 plugins.js 拦下。
  assertWorkerModule(module);
  register({ id: manifest.id, source: 'plugin', origin, dir, manifest, module, isolate });
}

export function unregisterWorkerPlugin(id) {
  if (workerRegistry.get(id)?.source === 'plugin') workerRegistry.delete(id);
}

export function workerRecovery(id) {
  return workerRegistry.get(id)?.manifest.worker.recovery || WORKER_DEFAULTS.recovery;
}

export function workerLabelOf(id) {
  return workerRegistry.get(id)?.manifest.name || id;
}

/** Worker 回传进度用的本机地址。服务监听在 0.0.0.0 时用回环地址。 */
export function reportUrl(runId) {
  const host = !HOST || HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  return `http://${host.includes(':') ? `[${host}]` : host}:${PORT}/api/runs/${encodeURIComponent(runId)}/report`;
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

/** 内置 Worker 和官方 Worker 插件随 App 发布，只能隐藏，不能删文件。 */
export function isShippedWorker(id) {
  const descriptor = workerRegistry.get(id);
  return descriptor?.source === 'builtin' || descriptor?.origin === 'official';
}

export function deleteBuiltinWorker(id) {
  if (!isShippedWorker(id)) throw new Error('不是内置或官方 Worker');
  db.prepare(`
    INSERT INTO worker_configs(id, enabled, deleted, config, updated_at) VALUES(?, 1, 1, '{}', ?)
    ON CONFLICT(id) DO UPDATE SET deleted = 1, updated_at = excluded.updated_at
  `).run(id, now());
  return { ok: true, builtin: true };
}

export function restoreBuiltinWorkers() {
  const update = db.prepare('UPDATE worker_configs SET deleted = 0 WHERE id = ?');
  for (const descriptor of workerRegistry.values()) {
    if (isShippedWorker(descriptor.id)) update.run(descriptor.id);
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
  return { settings: pluginSettings(), which, llm: { mode: llmMode() } };
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
  clearWhichCache();
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
      // builtin：随 App 的核心 Worker；official：你维护的官方 Worker 插件；user：用户自己装的
      origin: descriptor.source === 'builtin' ? 'builtin' : descriptor.origin || 'user',
      enabled: row ? Boolean(row.enabled) : true,
      abilities: manifest.worker.abilities,
      cost: manifest.worker.cost,
      keywords: manifest.worker.keywords,
      recovery: manifest.worker.recovery,
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

/** 没有指定 Worker 时的默认选择：最便宜的可用文本 Worker；一个可用的都没有时返回 null。 */
export function defaultWorker() {
  return pickWorker({ workers: workerCatalog() }).worker || null;
}

/* --------------------------------- 执行 --------------------------------- */

function parseTaskOptions(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

function hostContext(descriptor, task, ctx) {
  const settings = getSettings();
  const signal = ctx.signal;
  const emit = async (message, meta = {}) => ctx.onProgress?.(String(message), meta);
  const run = ctx.run ? { id: ctx.run.id, token: ctx.run.token, reportUrl: ctx.run.reportUrl } : null;
  // 宿主启动的子进程自动拿到回传地址和令牌，外部 Agent 可以直接 POST 进度回来。
  const runEnv = run ? { JINGJING_RUN_ID: run.id, JINGJING_RUN_TOKEN: run.token, JINGJING_REPORT_URL: run.reportUrl } : {};
  return {
    signal,
    emit,
    run,
    checkpoint: async (data) => (ctx.checkpoint ? ctx.checkpoint(data) : { ...data }),
    recovery: ctx.recovery || null,
    log: (message) => console.log(`[worker:${descriptor.id}] ${message}`),
    config: workerConfig(descriptor),
    settings: pluginSettings(settings),
    // 只有随代码发布的内置 Worker 能拿到模型 Key（比如 DeepSeek Harness 要转交给子进程）。
    secrets: descriptor.source === 'builtin' ? { apiKey: settings.apiKey || '' } : {},
    resume: ctx.resume || null,
    sessionId: task.resume_payload?.session_id || null,
    // 任务级运行选项，比如插件草稿任务的 { allowEdits: true }：允许编码 Agent 在工作目录里直接改文件。
    options: parseTaskOptions(task.options),
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
    exec: (cmd, args, options = {}) => runCommand(cmd, args, {
      ...options,
      env: { ...runEnv, ...(options.env || {}) },
      signal: options.signal || signal
    }),
    which,
    sleep: (ms) => sleep(ms, signal),
    parseApproval: extractApproval,
    estimateTokens
  };
}

/** 在独立线程里运行插件的 execute；主线程只转发进度、断点和模型调用。 */
function runInThread(descriptor, task, host) {
  const entry = pathToFileURL(path.join(descriptor.dir, descriptor.manifest.entry)).href;
  const { signal, emit, log, checkpoint, llm, exec: _exec, which: _which, sleep: _sleep, parseApproval: _parse, estimateTokens: _tokens, ...plain } = host;
  const runEnv = host.run ? { JINGJING_RUN_ID: host.run.id, JINGJING_RUN_TOKEN: host.run.token, JINGJING_REPORT_URL: host.run.reportUrl } : {};
  return new Promise((resolve) => {
    let settled = false;
    let thread;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      thread?.terminate().catch(() => {});
      resolve(result);
    };
    const onAbort = () => {
      thread?.postMessage({ type: 'abort', reason: String(signal.reason || 'cancelled') });
      setTimeout(() => finish({ status: 'cancelled', summary: '任务已停止。' }), THREAD_GRACE_MS).unref?.();
    };
    try {
      thread = new ThreadWorker(new URL('./worker-thread.js', import.meta.url), {
        workerData: { entry, task, data: { plain, llmMode: llm.mode, demoOutput: llm.demoOutput(), runEnv } },
        resourceLimits: { maxOldGenerationSizeMb: 512 }
      });
    } catch (err) {
      resolve({ status: 'failed', summary: `Worker「${descriptor.manifest.name}」线程启动失败：${err.message}` });
      return;
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    thread.on('message', async (msg) => {
      if (msg?.type === 'emit') return emit(msg.message, msg.meta || {});
      if (msg?.type === 'log') return log(msg.message);
      if (msg?.type === 'rpc') {
        try {
          const handler = msg.method === 'checkpoint' ? checkpoint : msg.method === 'llm.chat' ? llm.chat : null;
          if (!handler) throw new Error(`不支持的调用：${msg.method}`);
          const result = await handler(...(msg.args || []));
          thread.postMessage({ type: 'rpc-result', id: msg.id, result: JSON.parse(JSON.stringify(result ?? null)) });
        } catch (err) {
          thread.postMessage({ type: 'rpc-result', id: msg.id, error: err.message });
        }
        return;
      }
      if (msg?.type === 'result') {
        try {
          finish(normalizeResult(descriptor, msg.result));
        } catch (err) {
          finish({ status: 'failed', summary: `Worker「${descriptor.manifest.name}」执行失败：${err.message}` });
        }
        return;
      }
      if (msg?.type === 'error') {
        finish(msg.aborted || signal?.aborted
          ? { status: 'cancelled', summary: '任务已停止。' }
          : { status: 'failed', summary: `Worker「${descriptor.manifest.name}」执行失败：${msg.error}` });
      }
    });
    thread.on('error', (err) => finish({ status: 'failed', summary: `Worker「${descriptor.manifest.name}」线程出错：${err.message}` }));
    thread.on('exit', (code) => finish(signal?.aborted
      ? { status: 'cancelled', summary: '任务已停止。' }
      : { status: 'failed', summary: `Worker「${descriptor.manifest.name}」线程意外退出（退出码 ${code}）` }));
  });
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
    const host = hostContext(descriptor, task, ctx);
    if (descriptor.source === 'plugin' && descriptor.isolate !== false) return await runInThread(descriptor, task, host);
    return normalizeResult(descriptor, await descriptor.module.execute(task, host));
  } catch (err) {
    if (ctx.signal?.aborted || err?.message === 'aborted' || err?.name === 'AbortError') {
      return { status: 'cancelled', summary: '任务已停止。' };
    }
    return { status: 'failed', summary: `Worker「${descriptor.manifest.name}」执行失败：${err.message}` };
  }
}

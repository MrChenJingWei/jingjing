import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOST, PORT, PUBLIC_DIR, DATA_DIR, DB_PATH } from './src/config.js';
import { db, getSettings, getSetting, saveSettings, seedIfEmpty } from './src/db.js';
import { bus } from './src/events.js';
import * as memory from './src/memory.js';
import * as scheduler from './src/scheduler.js';
import * as router from './src/router.js';
import * as channels from './src/channels.js';
import { availability, testWorker, saveWorkerConfig, isShippedWorker, deleteBuiltinWorker, restoreBuiltinWorkers, loadBuiltinWorkers, defaultWorker } from './src/workers.js';
import * as workerRules from './src/worker-rules.js';
import * as workflows from './src/workflows.js';
import * as archive from './src/archive.js';
import * as forge from './src/plugin-forge.js';
import { chat as llmChat } from './src/llm.js';
import * as plugins from './src/plugins.js';
import * as discovery from './src/discovery.js';
import { installPluginZip } from './src/plugin-install.js';
import * as auth from './src/auth.js';
import { installLogCapture, recentLogs } from './src/logger.js';
import { seed } from './src/seed.js';
import { VERSION } from './src/version.js';
import { activateOverlay } from './src/overlay.js';
import * as updates from './src/update.js';

// 被桌面 App 拉起时：App 没了（崩溃 / 被强制结束）就跟着退出，不留孤儿进程占着端口。
const parentPid = Number(process.env.JINGJING_PARENT_PID || 0);
if (parentPid > 1) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') {
        console.log('[server] 桌面 App 已退出，服务随之停止');
        process.exit(0);
      }
    }
  }, 3000).unref();
}

// 数据目录里若有已安装的新版本，先交接给子进程；父进程只负责守护与转发信号。
await activateOverlay();

installLogCapture();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function fail(res, code, err) {
  json(res, err?.statusCode || code, { error: err instanceof Error ? err.message : String(err) });
}

async function readRawBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('插件包过大');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new Error('请求体不是合法 JSON'); }
}

function maskSettings(settings) {
  const copy = structuredClone(settings);
  copy.apiKey = settings.apiKey ? '••••••••' : '';
  if (copy.channels?.telegram?.token) copy.channels.telegram.token = '••••••••';
  return copy;
}

function bootstrap() {
  const settings = getSettings();
  return {
    settings: maskSettings(settings),
    sessionId: router.MAIN_SESSION,
    messages: router.messages(router.MAIN_SESSION, 120),
    tasks: scheduler.listTasks({ limit: 80 }),
    approvals: scheduler.pendingApprovals(),
    memories: memory.list({ limit: 100 }),
    memoryStats: memory.allLayersStats(),
    rules: router.listRules(),
    workerRules: workerRules.listWorkerRules(),
    workers: availability(),
    workflows: workflows.overview(),
    pluginDrafts: forge.listDrafts(),
    stats: scheduler.stats(),
    plugins: plugins.listPlugins(),
    pluginErrors: plugins.pluginErrors(),
    channels: channels.channelStatus(),
    server: {
      now: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      version: VERSION,
      update: updates.status(),
      demo: settings.provider === 'demo'
    }
  };
}

function mergeSettingsPatch(patch, current) {
  const next = structuredClone(patch);
  if (next.apiKey === '••••••••') next.apiKey = current.apiKey;
  if (next.channels?.telegram?.token === '••••••••') {
    next.channels.telegram.token = current.channels?.telegram?.token || '';
  }
  return next;
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== path.join(PUBLIC_DIR, 'index.html')) {
    return fail(res, 403, 'forbidden');
  }
  let file = full;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(rel)) return fail(res, 404, 'not found');
    file = path.join(PUBLIC_DIR, 'index.html');
  }
  const stat = fs.statSync(file);
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600'
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) {
    if (pathname === '/pair') {
      const key = url.searchParams.get('key') || '';
      if (!auth.checkKey(key)) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<meta charset="utf-8"><p>配对码不正确。回到主机上的静静 App，复制配对码后重试。</p>');
      }
      auth.setSessionCookie(req, res);
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    return serveStatic(req, res, pathname);
  }

  const publicApis = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/logout']);
  const hookMatch = pathname.match(/^\/api\/hooks\/([A-Za-z0-9_-]+)$/);
  // Worker 回传接口：不用配对码，只认这次执行的令牌（Authorization: Bearer <JINGJING_RUN_TOKEN>）。
  const runReportMatch = pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/report$/);
  if (!publicApis.has(pathname) && !hookMatch && !runReportMatch && !auth.isAuthorized(req)) {
    return json(res, 401, { error: '还没有配对', code: 'UNAUTHORIZED' });
  }

  try {
    if (runReportMatch) {
      if (req.method !== 'POST') return fail(res, 405, '回传接口只接受 POST');
      const header = String(req.headers.authorization || '');
      const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
      const body = await readBody(req);
      const result = scheduler.reportRun(runReportMatch[1], token, body);
      return json(res, result.ok ? 200 : result.code || 400, result);
    }

    if (hookMatch) {
      if (req.method !== 'POST') return fail(res, 405, 'Webhook 只接受 POST');
      const plugin = plugins.findWebhookPlugin(hookMatch[1]);
      if (!plugin) return fail(res, 401, 'Webhook 地址无效，或插件没有启用');
      if (typeof plugin.module.webhook !== 'function') return fail(res, 400, '这个插件没有实现 webhook()');
      const buffer = await readRawBody(req, 1024 * 1024);
      const raw = buffer.toString('utf8');
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { text: raw };
      }
      const result = await plugin.module.webhook(payload, {
        headers: req.headers,
        rawBody: raw,
        query: Object.fromEntries(url.searchParams.entries()),
        method: req.method,
        instanceId: plugin.instanceId,
        pluginId: plugin.pluginId,
        state: {
          get: (key, fallback = null) => plugins.getPluginState(plugin.instanceId, key, fallback),
          set: (key, value) => plugins.setPluginState(plugin.instanceId, key, value),
          delete: (key) => plugins.deletePluginState(plugin.instanceId, key)
        },
        log: (message) => console.log(`[webhook:${plugin.instanceId}] ${message}`)
      });
      const items = Array.isArray(result?.items) ? result.items : [];
      const ingested = await discovery.ingestItems(plugin.instanceId, items, { verb: '接收' });
      return json(res, 200, { ok: true, ...ingested });
    }

    if (req.method === 'GET' && pathname === '/api/auth/status') {
      return json(res, 200, { authenticated: auth.isAuthorized(req), pairing: true });
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readBody(req);
      const limit = auth.rateLimit(req);
      if (!limit.ok) {
        return json(res, 429, { error: `尝试次数太多，请 ${limit.retryAfter} 秒后再试` });
      }
      if (!auth.login(req, res, body.key)) {
        return json(res, 401, { error: '配对码不正确' });
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      auth.clearSessionCookie(req, res);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/auth/pairing') {
      return json(res, 200, auth.pairingInfo(req));
    }

    if (req.method === 'POST' && pathname === '/api/auth/rotate') {
      const key = auth.rotateAccessKey();
      auth.setSessionCookie(req, res, key);
      return json(res, 200, { key });
    }

    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      return json(res, 200, bootstrap());
    }

    if (req.method === 'GET' && pathname === '/api/stream') {
      return bus.subscribe(res);
    }

    if (req.method === 'POST' && pathname === '/api/system/pick-folder') {
      if (process.platform !== 'darwin') return fail(res, 400, '原生文件夹选择器只支持 macOS 主机');
      try {
        const rawPath = await new Promise((resolve, reject) => {
          execFile('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "选择静静的工作区文件夹")'], {
            timeout: 120000,
            maxBuffer: 1024 * 1024
          }, (err, stdout) => {
            if (err) reject(err);
            else resolve(String(stdout || '').trim());
          });
        });
        const chosen = rawPath.replace(/\/+$/, '') || '/';
        if (!chosen) return fail(res, 400, '没有选择文件夹');
        let stat;
        try { stat = fs.statSync(chosen); } catch { return fail(res, 400, '选择的目录不存在'); }
        if (!stat.isDirectory()) return fail(res, 400, '选择的不是目录');
        return json(res, 200, { path: chosen });
      } catch (err) {
        if (err.killed) return fail(res, 408, '选择超时');
        return fail(res, 400, '已取消选择');
      }
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        overlay: process.env.JINGJING_OVERLAY_VERSION || null,
        uptime: process.uptime(),
        clients: bus.size
      });
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readBody(req);
      console.log(`[chat] ${body.source || 'web'}: ${String(body.text || '').slice(0, 60)}`);
      const result = await router.handleMessage(body.text, {
        sessionId: body.sessionId || router.MAIN_SESSION,
        source: body.source || 'web'
      });
      return json(res, 200, { ...result, stats: scheduler.stats() });
    }

    if (req.method === 'GET' && pathname === '/api/tasks') {
      return json(res, 200, {
        tasks: scheduler.listTasks({
          limit: 100,
          status: url.searchParams.get('status') || undefined,
          q: url.searchParams.get('q') || ''
        }),
        stats: scheduler.stats()
      });
    }

    if (req.method === 'POST' && pathname === '/api/tasks') {
      const body = await readBody(req);
      const task = scheduler.createTask({
        title: body.title || body.prompt,
        prompt: body.prompt || body.title,
        worker: body.worker || defaultWorker(),
        cwd: body.cwd,
        origin: 'manual',
        sessionId: router.MAIN_SESSION,
        priority: Number(body.priority || 2)
      });
      return json(res, 200, { task });
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(approve|cancel|retry|learn))?$/);
    if (taskMatch) {
      const [, id, action] = taskMatch;
      if (req.method === 'PATCH' && !action) {
        const body = await readBody(req);
        return json(res, 200, { task: scheduler.updateTask(id, body) });
      }
      if (req.method === 'DELETE' && !action) {
        return json(res, 200, scheduler.deleteTask(id));
      }
      if (req.method === 'POST' && action === 'retry') {
        return json(res, 200, { task: scheduler.retryTask(id) });
      }
      if (req.method === 'GET' && !action) {
        const task = scheduler.getTask(id);
        if (!task) return fail(res, 404, '任务不存在');
        const approval = task.approval_id ? scheduler.getApproval(task.approval_id) : null;
        return json(res, 200, { task, events: scheduler.taskEvents(id), approval, runs: scheduler.taskRuns(id) });
      }
      if (req.method === 'POST' && action === 'approve') {
        const body = await readBody(req);
        const task = scheduler.getTask(id);
        if (!task?.approval_id) return fail(res, 400, '这个任务没有待审批项');
        const result = scheduler.approve(task.approval_id, Number(body.choice), { by: body.by || 'web' });
        return json(res, 200, result);
      }
      if (req.method === 'POST' && action === 'cancel') {
        return json(res, 200, { task: scheduler.cancel(id) });
      }
      if (req.method === 'POST' && action === 'learn') {
        const result = await router.proposeWorkflow(id, { force: true });
        return json(res, 200, { ...result, ...workflows.overview() });
      }
    }

    // 插件工坊：让静静写插件。安装只能由用户在界面上点「安装」触发。
    if (pathname === '/api/plugin-drafts' && req.method === 'GET') {
      return json(res, 200, { drafts: forge.listDrafts() });
    }
    if (pathname === '/api/plugin-drafts' && req.method === 'POST') {
      const body = await readBody(req);
      const draft = forge.createDraft({ kind: body.kind, request: body.request, sessionId: router.MAIN_SESSION });
      if (draft.taskId) {
        router.postAssistant(`好，我让编码 Worker 写一个${draft.kindLabel}：${draft.request.slice(0, 60)}。写完先自动检查，通过后你确认再安装。`, { kind: 'task', taskId: draft.taskId });
      }
      return json(res, 200, { draft, drafts: forge.listDrafts() });
    }
    const draftMatch = pathname.match(/^\/api\/plugin-drafts\/(d_[A-Za-z0-9]+)(?:\/(files|install|discard|retry))?$/);
    if (draftMatch) {
      const [, id, action] = draftMatch;
      if (req.method === 'GET' && !action) return json(res, 200, { draft: forge.getDraft(id) });
      if (req.method === 'GET' && action === 'files') return json(res, 200, { files: forge.draftFiles(id) });
      if (req.method === 'POST' && action === 'install') {
        const result = await forge.installDraft(id);
        return json(res, 200, { ...result, drafts: forge.listDrafts(), plugins: plugins.listPlugins(), workers: availability() });
      }
      if (req.method === 'POST' && action === 'discard') return json(res, 200, { draft: forge.discardDraft(id), drafts: forge.listDrafts() });
      if (req.method === 'POST' && action === 'retry') return json(res, 200, { draft: forge.retryDraft(id), drafts: forge.listDrafts() });
    }

    if (pathname === '/api/workflows' && req.method === 'GET') {
      return json(res, 200, workflows.overview({ fresh: true }));
    }
    if (pathname === '/api/workflows/reload' && req.method === 'POST') {
      const overview = workflows.overview({ fresh: true });
      bus.emit('workflows/updated', overview);
      return json(res, 200, overview);
    }
    if (pathname === '/api/workflows' && req.method === 'POST') {
      const workflow = workflows.createWorkflow(await readBody(req));
      const overview = workflows.overview();
      bus.emit('workflows/updated', overview);
      return json(res, 200, { workflow, ...overview });
    }
    const workflowMatch = pathname.match(/^\/api\/workflows\/([a-f0-9]{12})(?:\/(status|auto))?$/);
    if (workflowMatch) {
      const [, id, action] = workflowMatch;
      if (req.method === 'GET' && !action) {
        const workflow = workflows.listWorkflows().find((item) => item.id === id);
        if (!workflow) return fail(res, 404, '工作流程不存在');
        return json(res, 200, { workflow, raw: workflows.readRaw(id) });
      }
      let workflow = null;
      if (req.method === 'PUT' && !action) workflow = workflows.updateRaw(id, (await readBody(req)).raw);
      else if (req.method === 'POST' && action === 'status') workflow = workflows.setStatus(id, (await readBody(req)).status);
      else if (req.method === 'POST' && action === 'auto') workflow = workflows.setAuto(id, (await readBody(req)).auto);
      else if (req.method === 'DELETE' && !action) workflows.deleteWorkflow(id);
      else return fail(res, 405, 'method not allowed');
      const overview = workflows.overview();
      bus.emit('workflows/updated', overview);
      return json(res, 200, { workflow, ...overview });
    }

    const approveMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
    if (approveMatch && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, scheduler.approve(approveMatch[1], Number(body.choice), { by: body.by || 'web' }));
    }

    if (req.method === 'GET' && pathname === '/api/memories') {
      const q = url.searchParams.get('q');
      const layer = url.searchParams.get('layer') || undefined;
      const items = q ? memory.search(q, 50) : memory.list({ layer, limit: 200 });
      return json(res, 200, { memories: items, stats: memory.allLayersStats() });
    }

    if (req.method === 'POST' && pathname === '/api/memories') {
      const body = await readBody(req);
      const item = memory.remember({
        text: body.text,
        layer: body.layer || 'semantic',
        kind: body.kind || 'note',
        tags: body.tags || [],
        importance: Number(body.importance ?? 0.6),
        source: 'manual'
      });
      bus.emit('memory/created', { memory: item });
      return json(res, 200, { memory: item });
    }

    const memoryMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (memoryMatch && req.method === 'DELETE') {
      const ok = memory.forget(memoryMatch[1]);
      bus.emit('memory/deleted', { id: memoryMatch[1] });
      return json(res, 200, { ok });
    }

    if (memoryMatch && req.method === 'PATCH') {
      const body = await readBody(req);
      const item = memory.update(memoryMatch[1], body);
      if (!item) return fail(res, 404, '记忆不存在');
      bus.emit('memory/updated', { memory: item });
      return json(res, 200, { memory: item });
    }

    if (req.method === 'POST' && pathname === '/api/model/test') {
      const settings = getSettings();
      if (settings.provider === 'demo') {
        return json(res, 400, { ok: false, error: '当前是演示模式，请先在设置里选择 DeepSeek 或 Ollama 并保存' });
      }
      if (settings.provider === 'deepseek' && !settings.apiKey) {
        return json(res, 400, { ok: false, error: '还没有填 API Key' });
      }
      const started = Date.now();
      try {
        const out = await llmChat({
          messages: [{ role: 'user', content: '只回复两个字：在线' }],
          maxTokens: 8,
          temperature: 0,
          system: '你是连通性测试助手，只输出要求的内容。'
        });
        return json(res, 200, {
          ok: true,
          provider: settings.provider,
          model: out.model,
          latencyMs: Date.now() - started,
          tokens: out.tokens,
          text: out.text.trim().slice(0, 80)
        });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message, latencyMs: Date.now() - started });
      }
    }

    if (req.method === 'GET' && pathname === '/api/settings') {
      return json(res, 200, { settings: maskSettings(getSettings()), workers: availability(), workerRules: workerRules.listWorkerRules() });
    }

    if (req.method === 'PUT' && pathname === '/api/settings') {
      const body = await readBody(req);
      const current = getSettings();
      saveSettings(mergeSettingsPatch(body, current));
      const next = getSettings();
      const workspaceIds = new Set(next.workspaces.map((workspace) => workspace.id));
      for (const row of db.prepare('SELECT id, workspace_id FROM source_plugins').all()) {
        if (row.workspace_id && !workspaceIds.has(row.workspace_id)) {
          db.prepare('UPDATE source_plugins SET workspace_id = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
        }
      }
      channels.restartTelegram();
      bus.emit('settings/updated', { settings: maskSettings(next) });
      bus.emit('workflows/updated', workflows.overview({ fresh: true }));
      bus.emit('plugins/updated', { plugins: plugins.listPlugins(), errors: plugins.pluginErrors() });
      return json(res, 200, { settings: maskSettings(next), workers: availability(), workerRules: workerRules.listWorkerRules() });
    }

    if (req.method === 'GET' && pathname === '/api/admin/overview') {
      const dbSize = [DB_PATH, `${DB_PATH}-wal`]
        .filter((file) => fs.existsSync(file))
        .reduce((sum, file) => sum + fs.statSync(file).size, 0);
      return json(res, 200, {
        version: VERSION,
        update: updates.status(),
        uptime: process.uptime(),
        node: process.version,
        db: { file: path.basename(DB_PATH), size: dbSize },
        sse: bus.size,
        stats: scheduler.stats(),
        workers: availability(),
        plugins: plugins.listPlugins().map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          enabled: plugin.enabled,
          status: plugin.status
        })),
        channels: channels.channelStatus(),
        settings: {
          provider: getSettings().provider,
          model: getSettings().model,
          queuePaused: Boolean(getSettings().queuePaused),
          persona: getSettings().persona
        }
      });
    }

    if (req.method === 'GET' && pathname === '/api/admin/logs') {
      return json(res, 200, { logs: recentLogs(Number(url.searchParams.get('limit')) || 200) });
    }

    if (req.method === 'GET' && pathname === '/api/update/status') {
      return json(res, 200, updates.status());
    }

    if (req.method === 'GET' && pathname === '/api/update/check') {
      return json(res, 200, await updates.checkForUpdate({ force: url.searchParams.get('force') === '1' }));
    }

    if (req.method === 'POST' && pathname === '/api/update/apply') {
      const result = await updates.applyUpdate();
      console.log(`[update] 已安装 ${result.version}，重启后生效`);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/update/rollback') {
      const result = updates.rollbackUpdate();
      console.log(`[update] 已回退到 ${result.version}，重启后生效`);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/admin/queue') {
      const body = await readBody(req);
      const paused = Boolean(body.paused);
      saveSettings({ queuePaused: paused });
      if (!paused) scheduler.kick();
      bus.emit('stats/updated', scheduler.stats());
      return json(res, 200, { paused, stats: scheduler.stats() });
    }

    if (req.method === 'GET' && pathname === '/api/admin/archives') {
      const q = url.searchParams.get('q');
      if (q) return json(res, 200, { results: archive.searchArchives(q) });
      return json(res, 200, {
        archives: archive.listArchives(),
        settings: getSettings().archive,
        lastRun: getSetting('archiveLastRun', null),
        pending: archive.collect().counts
      });
    }
    if (req.method === 'POST' && pathname === '/api/admin/archive') {
      const body = await readBody(req);
      const result = archive.archiveOld({ days: body.days, reason: 'manual' });
      bus.emit('stats/updated', scheduler.stats());
      return json(res, 200, { result, archives: archive.listArchives() });
    }
    const archiveMatch = pathname.match(/^\/api\/admin\/archives\/([^/]+)(?:\/restore)?$/);
    if (archiveMatch) {
      const name = decodeURIComponent(archiveMatch[1]);
      if (req.method === 'POST' && pathname.endsWith('/restore')) {
        const body = await readBody(req);
        const restored = archive.restoreTask(name, String(body.taskId || ''));
        const task = scheduler.getTask(String(body.taskId));
        if (task) bus.emit('task/created', { task });
        return json(res, 200, { restored, task });
      }
      if (req.method === 'GET') {
        const file = archive.archiveFile(name);
        const stat = fs.statSync(file);
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Content-Length': stat.size,
          'Cache-Control': 'no-store'
        });
        return fs.createReadStream(file).pipe(res);
      }
    }

    if (req.method === 'GET' && pathname === '/api/admin/backup') {
      const stamp = new Date().toISOString().slice(0, 10);
      const snapshot = path.join(DATA_DIR, `backup-${Date.now()}.db`);
      try {
        db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      } catch (err) {
        return fail(res, 500, `备份失败：${err.message}`);
      }
      const stat = fs.statSync(snapshot);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="jingjing-backup-${stamp}.db"`,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store'
      });
      const stream = fs.createReadStream(snapshot);
      const cleanup = () => fs.promises.unlink(snapshot).catch(() => {});
      stream.on('close', cleanup);
      stream.on('error', cleanup);
      stream.pipe(res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/admin/export') {
      const payload = {
        exportedAt: new Date().toISOString(),
        tasks: db.prepare('SELECT * FROM tasks').all(),
        memories: memory.list({ limit: 5000 }),
        rules: router.listRules(),
        plugins: plugins.listPlugins(),
        settings: maskSettings(getSettings())
      };
      res.setHeader('Content-Disposition', 'attachment; filename="jingjing-export.json"');
      return json(res, 200, payload);
    }

    if (pathname === '/api/worker-rules' && req.method === 'GET') {
      return json(res, 200, { rules: workerRules.listWorkerRules() });
    }
    if (pathname === '/api/worker-rules' && req.method === 'POST') {
      const body = await readBody(req);
      const rule = workerRules.saveWorkerRule(null, body);
      return json(res, 200, { rule, rules: workerRules.listWorkerRules() });
    }
    const workerRuleMatch = pathname.match(/^\/api\/worker-rules\/([^/]+)(?:\/(move))?$/);
    if (workerRuleMatch) {
      const id = decodeURIComponent(workerRuleMatch[1]);
      const action = workerRuleMatch[2];
      if (req.method === 'PATCH' && !action) {
        const body = await readBody(req);
        const rule = workerRules.saveWorkerRule(id, body);
        return json(res, 200, { rule, rules: workerRules.listWorkerRules() });
      }
      if (req.method === 'DELETE' && !action) {
        return json(res, 200, { rules: workerRules.deleteWorkerRule(id) });
      }
      if (req.method === 'POST' && action === 'move') {
        const body = await readBody(req);
        return json(res, 200, { rules: workerRules.moveWorkerRule(id, body.direction === 'up' ? 'up' : 'down') });
      }
    }

    if (req.method === 'POST' && pathname === '/api/workers/restore') {
      restoreBuiltinWorkers();
      const workers = availability();
      bus.emit('workers/updated', { workers });
      return json(res, 200, { ok: true, workers });
    }

    const workerMatch = pathname.match(/^\/api\/workers\/([^/]+)(?:\/test)?$/);
    if (workerMatch) {
      const id = decodeURIComponent(workerMatch[1]);
      const isTest = pathname.endsWith('/test');
      if (req.method === 'PUT' && !isTest) {
        const body = await readBody(req);
        saveWorkerConfig(id, body);
        const workers = availability();
        bus.emit('workers/updated', { workers });
        return json(res, 200, { workers });
      }
      if (req.method === 'POST' && isTest) {
        const result = await testWorker(id);
        return json(res, 200, result);
      }
      if (req.method === 'DELETE' && !isTest) {
        if (isShippedWorker(id)) deleteBuiltinWorker(id);
        else plugins.removeWorkerPlugin(id);
        const workers = availability();
        bus.emit('workers/updated', { workers });
        return json(res, 200, { ok: true, workers });
      }
    }

    if (req.method === 'GET' && pathname === '/api/plugins') {
      return json(res, 200, { plugins: plugins.listPlugins(), errors: plugins.pluginErrors() });
    }

    if (req.method === 'POST' && pathname === '/api/plugins/reload') {
      await discovery.stopLifecycles();
      const list = await plugins.reloadPlugins();
      await discovery.startLifecycles();
      const errors = plugins.pluginErrors();
      bus.emit('plugins/updated', { plugins: list, errors });
      return json(res, 200, { plugins: list, workers: availability(), errors });
    }

    if (req.method === 'POST' && pathname === '/api/plugins/install') {
      if (!String(req.headers['content-type'] || '').includes('zip')) {
        return fail(res, 400, '请上传 .zip 插件包');
      }
      const buffer = await readRawBody(req, 20 * 1024 * 1024);
      const installed = await installPluginZip(buffer);
      const list = await plugins.reloadPlugins();
      const errors = plugins.pluginErrors();
      bus.emit('plugins/updated', { plugins: list, errors });
      return json(res, 200, {
        plugin: list.find((plugin) => plugin.id === installed.id) || null,
        plugins: list,
        workers: availability(),
        errors
      });
    }

    const pluginRunsMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/runs$/);
    if (pluginRunsMatch && req.method === 'GET') {
      const id = decodeURIComponent(pluginRunsMatch[1]);
      return json(res, 200, { runs: plugins.listRuns(id, 20) });
    }

    const pluginItemsMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/items$/);
    if (pluginItemsMatch && req.method === 'GET') {
      const id = decodeURIComponent(pluginItemsMatch[1]);
      const items = discovery.recentItems(id, 20).map((row) => ({
        externalId: row.external_id,
        title: row.title,
        status: row.status,
        taskId: row.task_id,
        reason: row.decision_reason,
        eventType: row.event_type,
        hops: row.hops,
        url: row.url,
        occurredAt: row.occurred_at,
        createdAt: row.created_at
      }));
      return json(res, 200, { items });
    }

    const pluginInstancesMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/instances$/);
    if (pluginInstancesMatch && req.method === 'POST') {
      const body = await readBody(req);
      const plugin = plugins.createInstance(decodeURIComponent(pluginInstancesMatch[1]), body.label || '');
      const list = plugins.listPlugins();
      bus.emit('plugins/updated', { plugins: list, errors: plugins.pluginErrors() });
      return json(res, 200, { plugin, plugins: list, errors: plugins.pluginErrors() });
    }

    const pluginMatch = pathname.match(/^\/api\/plugins\/([^/]+)(?:\/(test|scan|fork|restore-official))?$/);
    if (pluginMatch) {
      const [, id, action] = pluginMatch;
      if (req.method === 'POST' && (action === 'fork' || action === 'restore-official')) {
        const plugin = plugins.getPlugin(id);
        if (!plugin) return fail(res, 404, '插件不存在');
        await discovery.stopLifecycles();
        let forkedId = null;
        try {
          if (action === 'fork') forkedId = plugins.forkOfficial(plugin.pluginId);
          else plugins.restoreOfficial(plugin.pluginId);
        } finally {
          await plugins.reloadPlugins();
          await discovery.startLifecycles();
        }
        const list = plugins.listPlugins();
        const errors = plugins.pluginErrors();
        bus.emit('plugins/updated', { plugins: list, errors });
        bus.emit('workers/updated', { workers: availability() });
        return json(res, 200, { plugins: list, errors, forkedId, workers: availability() });
      }
      if (req.method === 'PUT' && !action) {
        const body = await readBody(req);
        const plugin = plugins.savePlugin(id, body);
        if (plugin?.lifecycle) await discovery.restartLifecycle(id);
        bus.emit('plugins/updated', { plugins: plugins.listPlugins(), errors: plugins.pluginErrors() });
        return json(res, 200, { plugin: plugins.listPlugins().find((item) => item.id === id) || plugin, errors: plugins.pluginErrors() });
      }
      if (req.method === 'DELETE' && !action) {
        if (discovery.isRunning(id)) {
          return fail(res, 400, '插件正在拉取，稍后再卸载');
        }
        await discovery.stopLifecycle(id, { mark: false });
        const removed = plugins.uninstallPlugin(id);
        const list = await plugins.reloadPlugins();
        const errors = plugins.pluginErrors();
        bus.emit('plugins/updated', { plugins: list, errors });
        return json(res, 200, { plugins: list, errors, purged: Boolean(removed.purged) });
      }
      if (req.method === 'POST' && action === 'test') {
        const body = await readBody(req).catch(() => ({}));
        const result = await discovery.testPlugin(id, body.config || {});
        return json(res, 200, result);
      }
      if (req.method === 'POST' && action === 'scan') {
        const result = await discovery.runPlugin(id, { force: true });
        return json(res, 200, { ...result, plugins: plugins.listPlugins(), errors: plugins.pluginErrors() });
      }
    }

    if (req.method === 'GET' && pathname === '/api/rules') {
      return json(res, 200, { rules: router.listRules() });
    }

    const ruleMatch = pathname.match(/^\/api\/rules\/([^/]+)\/toggle$/);
    if (ruleMatch && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { rules: router.setRuleEnabled(ruleMatch[1], Boolean(body.enabled)) });
    }

    if (req.method === 'POST' && pathname === '/api/channels/test') {
      const settings = getSettings();
      const fakeApproval = {
        id: 'test',
        question: '这是一条测试通知，收到说明通道是通的。',
        options: ['收到']
      };
      const deliveries = await channels.notifyApproval(fakeApproval, { title: '静静通道测试' });
      return json(res, 200, { deliveries, status: channels.channelStatus() });
    }

    return fail(res, 404, '接口不存在');
  } catch (err) {
    console.error('[api]', req.method, pathname, err.message);
    const status = Number(err.statusCode) || (err.message === '请求体不是合法 JSON' ? 400 : 500);
    return fail(res, status, err);
  }
});

seedIfEmpty();
seed();
auth.getAccessKey();
await loadBuiltinWorkers();
plugins.seedBuiltins();
await plugins.reloadPlugins();
await discovery.startLifecycles();
// 插件工坊：写好的插件通过对话卡片通知用户；用户点「安装」后重新加载插件。
forge.configure({
  post: (text, options) => router.postAssistant(text, options),
  reload: async () => {
    await discovery.stopLifecycles();
    const list = await plugins.reloadPlugins();
    await discovery.startLifecycles();
    bus.emit('plugins/updated', { plugins: list, errors: plugins.pluginErrors() });
    bus.emit('workers/updated', { workers: availability() });
  }
});
scheduler.init();
// 每 6 小时检查一次，每天最多自动归档一次；启动一分钟后先检查一次。
const runArchive = () => {
  try { archive.maybeAutoArchive(); } catch (err) { console.warn('[archive] 自动归档失败：', err.message); }
};
setTimeout(runArchive, 60 * 1000).unref();
setInterval(runArchive, 6 * 60 * 60 * 1000).unref();
router.startProactiveLoop();
discovery.start();
channels.setHandlers({
  onMessage: (text, meta) => router.handleMessage(text, { sessionId: router.MAIN_SESSION, source: meta.source }),
  onApproval: (approvalId, choice) => scheduler.approve(approvalId, choice, { by: 'telegram' })
});
channels.restartTelegram();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  静静 · 本地个人 AI 工作站 · v${VERSION}`);
  console.log(`  → http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`  数据目录：${DATA_DIR}`);
  console.log(`  运行模式：${getSettings().provider === 'demo' ? '演示模式（无需 API Key）' : getSettings().provider}`);
  if (process.env.JINGJING_OVERLAY_VERSION) console.log(`  热更新版本：${process.env.JINGJING_OVERLAY_VERSION}（数据目录）`);
  console.log(`  配对码文件：${auth.accessKeyPath()}`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换一个：JINGJING_PORT=7778 npm start`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n静静先休息了。');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200);
  });
}

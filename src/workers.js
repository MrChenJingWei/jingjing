import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { SANDBOX_DIR, WORKER_LABEL } from './config.js';
import { db, now, getSettings } from './db.js';
import { validateConfig } from './plugin-spec.js';
import { chat, demoTaskOutput, estimateTokens } from './llm.js';

const BIN = {};
function which(bin) {
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

const workerRegistry = new Map();
const WORKER_MASK = '••••••••';

function workerRow(id) {
  return db.prepare('SELECT * FROM worker_configs WHERE id = ?').get(id) || null;
}

export function isBuiltinWorker(id) {
  return workerRegistry.get(id)?.source === 'builtin';
}

export function isWorkerDeleted(id) {
  const row = workerRow(id);
  return Boolean(row?.deleted);
}

export function deleteBuiltinWorker(id) {
  const descriptor = workerRegistry.get(id);
  if (!descriptor || descriptor.source !== 'builtin') throw new Error('不是内置 Worker');
  db.prepare(`
    INSERT INTO worker_configs(id, enabled, deleted, config, updated_at) VALUES(?, 1, 1, '{}', ?)
    ON CONFLICT(id) DO UPDATE SET deleted = 1, updated_at = excluded.updated_at
  `).run(id, now());
  return { ok: true, builtin: true };
}

export function restoreBuiltinWorkers() {
  db.prepare('UPDATE worker_configs SET deleted = 0 WHERE id IN (SELECT id FROM worker_configs)').run();
  for (const id of workerRegistry.keys()) {
    if (workerRegistry.get(id).source === 'builtin') {
      db.prepare('UPDATE worker_configs SET deleted = 0 WHERE id = ?').run(id);
    }
  }
  return { ok: true };
}

function workerDefaults(fields = []) {
  const out = {};
  for (const field of fields || []) {
    if (field.default !== undefined) out[field.key] = field.default;
    else if (field.type === 'checkbox') out[field.key] = false;
    else if (field.type === 'number') out[field.key] = field.min ?? 0;
    else out[field.key] = '';
  }
  return out;
}

function workerConfig(descriptor) {
  const row = workerRow(descriptor.id);
  let stored = {};
  try { stored = JSON.parse(row?.config || '{}'); } catch { /* ignore */ }
  return { ...workerDefaults(descriptor.configSchema), ...stored };
}

function maskWorkerConfig(descriptor, config) {
  const out = { ...config };
  for (const field of descriptor.configSchema || []) {
    if (field.type === 'password' && out[field.key]) out[field.key] = WORKER_MASK;
  }
  return out;
}

function registerBuiltin(id, descriptor) {
  workerRegistry.set(id, { id, source: 'builtin', enabled: true, configSchema: [], ...descriptor });
}

export function registerWorkerPlugin({ manifest, module, dir }) {
  if (workerRegistry.has(manifest.id)) {
    const existing = workerRegistry.get(manifest.id);
    if (existing.source === 'builtin') throw new Error(`Worker id「${manifest.id}」与内置 Worker 冲突`);
    if (existing.dir !== dir) throw new Error(`Worker id「${manifest.id}」已被占用`);
  }
  workerRegistry.set(manifest.id, {
    id: manifest.id,
    source: 'plugin',
    dir,
    manifest,
    module,
    label: manifest.name,
    glyph: manifest.icon || 'W',
    configSchema: manifest.config || [],
    enabled: true
  });
  const row = workerRow(manifest.id);
  if (!row) {
    db.prepare('INSERT INTO worker_configs(id, enabled, config, updated_at) VALUES(?, 1, ?, ?)')
      .run(manifest.id, '{}', now());
  }
}

export function unregisterWorkerPlugin(id) {
  const descriptor = workerRegistry.get(id);
  if (descriptor?.source === 'plugin') workerRegistry.delete(id);
}

export function isWorker(id) {
  if (!workerRegistry.has(id)) return false;
  return !isWorkerDeleted(id);
}

export function workerIds() {
  return Object.keys(availability()).filter((id) => !isWorkerDeleted(id));
}

export function listWorkerPlugins() {
  const out = [];
  for (const descriptor of workerRegistry.values()) {
    if (descriptor.source !== 'plugin') continue;
    const row = workerRow(descriptor.id);
    const config = workerConfig(descriptor);
    out.push({
      id: descriptor.id,
      label: descriptor.label,
      glyph: descriptor.glyph,
      enabled: row ? Boolean(row.enabled) : true,
      configSchema: descriptor.configSchema,
      config: maskWorkerConfig(descriptor, config),
      dir: descriptor.dir
    });
  }
  return out;
}

function workerDetection(descriptor) {
  if (descriptor.source === 'plugin') {
    const row = workerRow(descriptor.id);
    if (row && !row.enabled) return { available: false, detail: '已停用' };
    if (typeof descriptor.module.detect !== 'function') return { available: true, detail: '已安装' };
    try {
      const result = descriptor.module.detect(workerConfig(descriptor), { settings: getSettings() });
      if (result === false) return { available: false, detail: '当前主机不可用' };
      if (result === true || result === undefined) return { available: true, detail: '已安装' };
      return { available: Boolean(result.available), detail: String(result.detail || '') };
    } catch (err) {
      return { available: false, detail: err.message };
    }
  }
  return descriptor.detect ? descriptor.detect() : { available: true, detail: '' };
}

export function availability() {
  const out = {};
  for (const descriptor of workerRegistry.values()) {
    if (isWorkerDeleted(descriptor.id)) continue;
    const detection = workerDetection(descriptor);
    const row = workerRow(descriptor.id);
    out[descriptor.id] = {
      available: detection.available,
      label: descriptor.label,
      detail: detection.detail,
      glyph: descriptor.glyph || '工',
      source: descriptor.source,
      enabled: row ? Boolean(row.enabled) : true,
      configSchema: descriptor.configSchema || [],
      config: descriptor.source === 'plugin' ? maskWorkerConfig(descriptor, workerConfig(descriptor)) : {}
    };
  }
  return out;
}

export function workerCatalog() {
  const available = availability();
  return Object.entries(available)
    .filter(([, item]) => item.available)
    .map(([id, item]) => ({ id, label: item.label }));
}

export function saveWorkerPluginConfig(id, { config, enabled } = {}) {
  const descriptor = workerRegistry.get(id);
  if (!descriptor || descriptor.source !== 'plugin') throw new Error('Worker 插件不存在');
  const row = workerRow(id);
  const current = workerConfig(descriptor);
  const patch = { ...(config || {}) };
  for (const field of descriptor.configSchema) {
    if (field.type === 'password' && patch[field.key] === WORKER_MASK) patch[field.key] = current[field.key] ?? '';
  }
  const nextConfig = { ...current, ...patch };
  const nextEnabled = enabled === undefined ? (row ? Boolean(row.enabled) : true) : Boolean(enabled);
  const normalized = validateConfig(descriptor.manifest, nextConfig, { requireAll: nextEnabled });
  db.prepare(`
    INSERT INTO worker_configs(id, enabled, config, updated_at) VALUES(?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at
  `).run(id, nextEnabled ? 1 : 0, JSON.stringify(normalized), now());
  return availability()[id];
}

export function testWorkerPlugin(id) {
  const descriptor = workerRegistry.get(id);
  if (!descriptor || descriptor.source !== 'plugin') throw new Error('Worker 插件不存在');
  const config = workerConfig(descriptor);
  if (typeof descriptor.module.test === 'function') {
    const result = descriptor.module.test(config, { settings: getSettings() });
    return result;
  }
  return workerDetection(descriptor);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });

function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

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

/* ------------------------------- LLM Worker ------------------------------ */

async function runLlm(task, ctx) {
  const settings = getSettings();
  const { emit, signal } = ctx;
  const promptText = String(task.prompt || task.title || '');
  const needsSystemAction = /(?:保存|写入|创建|新建|建|生成|修改|删除|移动|运行|执行|安装|部署|推送|提交|下载|上传).{0,40}(?:文件|文档|txt|md|markdown|tex|json|csv|代码|仓库|git|github|命令|脚本|目录|文件夹)/i.test(promptText)
    || /[A-Za-z0-9_\-\u4e00-\u9fa5]+\.(?:txt|md|markdown|tex|json|csv)/i.test(promptText)
    || /(^|[^a-z])(git|github)([^a-z]|$)/i.test(promptText);
  if (needsSystemAction) {
    return {
      status: 'failed',
      summary: '「问答」Worker 只能处理和回答文本，不能读写文件、执行命令或操作仓库。请在任务详情里把 Worker 改成「文件生成」/ Claude Code / DeepSeek Harness 后重试。'
    };
  }
  if (ctx.resume && ctx.resume.choice < 0) {
    return { status: 'cancelled', summary: '已按你的选择停下，没有再继续。' };
  }

  if (settings.provider === 'demo') {
    await emit('正在读取任务上下文…');
    await sleep(500, signal);
    await emit('检索记忆与近期任务…');
    await sleep(600, signal);
    const text = demoTaskOutput({
      task,
      memories: ctx.memories || [],
      tasks: ctx.tasks || []
    });
    await emit('整理输出…');
    await sleep(400, signal);
    return { status: 'done', summary: text, tokens: estimateTokens(text) };
  }

  const memBlock = (ctx.memories || []).map((m) => `- ${m.text}`).join('\n') || '-（暂无）';
  const taskBlock = (ctx.tasks || [])
    .slice(0, 8)
    .map((t) => `- [${t.status}] ${t.title}`)
    .join('\n') || '-（暂无）';
  const decision = ctx.resume
    ? `\n\n用户刚刚对「${ctx.resume.question}」选择了：${ctx.resume.choice >= 0 ? ctx.resume.options?.[ctx.resume.choice] ?? ctx.resume.choice : '取消'}。请据此继续完成，不要重复提问。`
    : '';

  const system = [
    '你是「静静」，运行在用户个人主机上的 AI 管家。',
    `风格：${settings.persona || '平静、具体、不奉承，像一个可靠的同事。'}`,
    '你在执行一个已经派给你的任务。直接交付结果，不要说「作为一个 AI」。',
    '你是「问答」Worker，只能处理和回答文本；你没有读写文件、执行命令、访问网络或修改系统的能力。',
    '不要声称「已保存」「已写入」「已执行」「已修改」任何文件或系统；需要落盘时告诉用户改用「文件生成」或编码 Worker。',
    '不要描述系统内部操作，不要声称「任务板已更新」「已写入数据库」；只交付内容本身。',
    `当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}。`,
    '需要用户拍板才能继续时，把问题写在最后，并单独输出一行：',
    '[[APPROVAL]] {"question":"要问的问题","options":["选项A","选项B"]}',
    '否则不要输出这个标记。',
    '',
    '你可以参考的长期记忆：',
    memBlock,
    '',
    '当前任务板：',
    taskBlock
  ].join('\n');

  const res = await chat({
    system,
    messages: [{ role: 'user', content: `${task.prompt}${decision}` }],
    maxTokens: 1800
  });
  const parsed = extractApproval(res.text);
  if (parsed) {
    return { status: 'needs_approval', summary: parsed.text, approval: parsed.approval, tokens: res.tokens };
  }
  return { status: 'done', summary: res.text, tokens: res.tokens, cost: res.cost };
}

/* ------------------------------ Shell Worker ----------------------------- */

const GROUPS = [
  { name: '文档', exts: ['.md', '.txt', '.doc', '.docx', '.pdf', '.rtf', '.pages'] },
  { name: '图片', exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.svg'] },
  { name: '压缩包', exts: ['.zip', '.rar', '.7z', '.tar', '.gz'] },
  { name: '表格', exts: ['.xlsx', '.xls', '.csv', '.numbers'] }
];

function groupOf(file) {
  const ext = path.extname(file).toLowerCase();
  return GROUPS.find((g) => g.exts.includes(ext))?.name || '其他';
}

async function runFileWriter(task, ctx) {
  const settings = getSettings();
  const dir = path.resolve(task.cwd || settings.defaultCwd);
  if (!fs.existsSync(dir)) return { status: 'failed', summary: `目录不存在：${dir}` };
  const prompt = task.prompt || task.title;
  await ctx.emit('生成文件内容…');

  let filename = '';
  let content = '';
  const requested = prompt.match(/([A-Za-z0-9_\-\u4e00-\u9fa5]+\.(?:txt|md|markdown|tex|json|csv|html|css|js|py))/i);
  if (requested) filename = requested[1];

  if (settings.provider === 'demo') {
    content = `${prompt}\n`;
  } else {
    const system = [
      '你是静静的文件生成 Worker。根据用户要求生成一个文本文件。',
      '只输出 JSON，不要 Markdown 代码围栏。结构：',
      '{"filename":"abc.txt","content":"文件的完整内容"}',
      'filename 只能是文件名，不能带路径；用户没指定时自己取一个贴切的名字和扩展名。',
      'content 是最终文件内容，不要解释、不要额外说明。'
    ].join('\n');
    try {
      const res = await chat({
        system,
        messages: [{ role: 'user', content: prompt }],
        json: true,
        temperature: 0.3,
        maxTokens: 5000
      });
      const text = res.text || '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (parsed.filename) filename = String(parsed.filename);
        if (parsed.content !== undefined) content = String(parsed.content);
      } else {
        content = text;
      }
    } catch (err) {
      return { status: 'failed', summary: `生成文件内容失败：${err.message}` };
    }
  }

  if (!content) return { status: 'failed', summary: '模型没有返回文件内容。' };
  if (!filename) filename = 'generated.txt';
  filename = path.basename(filename).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'generated.txt';
  if (!/\.[A-Za-z0-9]{1,8}$/.test(filename)) filename += '.txt';
  const target = path.resolve(dir, filename);
  if (!isInside(dir, target)) return { status: 'failed', summary: '文件名越出了任务工作区。' };
  fs.writeFileSync(target, content, 'utf8');
  await ctx.emit(`已写入 ${filename}`);
  const preview = content.length > 600 ? `${content.slice(0, 600)}…` : content;
  return {
    status: 'done',
    summary: `已生成并保存到：${target}\n\n${preview}`,
    tokens: estimateTokens(content)
  };
}

async function runShell(task, ctx) {
  const { emit, signal } = ctx;
  const cwd = path.resolve(task.cwd || SANDBOX_DIR);
  if (!fs.existsSync(cwd)) return { status: 'failed', summary: `目录不存在：${cwd}` };

  let entries = [];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch (err) {
    return { status: 'failed', summary: `读取目录失败：${err.message}` };
  }

  const groups = {};
  for (const name of entries) (groups[groupOf(name)] ||= []).push(name);

  if (ctx.resume) {
    const choice = ctx.resume.choice;
    if (choice < 0 || choice === 1) {
      return { status: 'cancelled', summary: `好，${entries.length} 个文件都原地不动。` };
    }
    if (choice === 2) {
      return { status: 'done', summary: '清单：\n' + entries.map((n) => `- ${n}`).join('\n') };
    }
    await emit('准备归档目录…');
    await sleep(300, signal);
    let moved = 0;
    for (const [group, files] of Object.entries(groups)) {
      const dir = path.join(cwd, '归档', group);
      fs.mkdirSync(dir, { recursive: true });
      for (const name of files) {
        const from = path.join(cwd, name);
        const to = path.join(dir, name);
        if (!isInside(cwd, from) || !isInside(cwd, to)) continue;
        fs.renameSync(from, to);
        moved += 1;
      }
      await emit(`归档「${group}」：${files.length} 个文件`, { done: moved, total: entries.length });
      await sleep(200, signal);
    }
    return {
      status: 'done',
      summary: `已归档 ${moved} 个文件到：\n` + Object.entries(groups).map(([g, f]) => `- 归档/${g}/（${f.length} 个）`).join('\n')
    };
  }

  if (!entries.length) return { status: 'done', summary: '目录是空的，不用整理。' };

  await emit(`扫描到 ${entries.length} 个文件`, { total: entries.length });
  await sleep(400, signal);
  const preview = Object.entries(groups).map(([g, f]) => `${g} ${f.length} 个`).join('、');
  return {
    status: 'needs_approval',
    summary: `「${path.basename(cwd)}」里有 ${entries.length} 个文件（${preview}）。我可以按类型归档到 归档/ 下的子目录。`,
    approval: {
      question: `要把这 ${entries.length} 个文件按类型归档吗？`,
      options: ['归档', '先不动', '只列个清单']
    }
  };
}

/* ----------------------------- Claude Worker ----------------------------- */

function runCommand(cmd, args, { cwd, signal, onLine, timeoutMs = 10 * 60 * 1000, env: extraEnv = {} }) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    child.stdout.on('data', (buf) => { stdout += buf.toString(); onLine?.(buf.toString()); });
    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.on('error', (err) => finish({ code: -1, error: err.message }));
    child.on('close', (code) => finish({ code }));
    signal?.addEventListener('abort', () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500);
      finish({ code: -2, error: 'aborted' });
    }, { once: true });
  });
}

async function runClaude(task, ctx) {
  const settings = getSettings();
  const { emit, signal } = ctx;
  const bin = which('claude');
  if (!bin || settings.claude?.enabled === false) {
    return { status: 'failed', summary: '没有找到 claude 命令，或在设置里禁用了 Claude Code。' };
  }
  const prompt = ctx.resume
    ? `${task.prompt}\n\n用户刚刚对「${ctx.resume.question}」选择了：${
        ctx.resume.choice >= 0 ? ctx.resume.options?.[ctx.resume.choice] ?? String(ctx.resume.choice) : '取消'
      }。请在此基础上继续完成。`
    : task.prompt;

  // 工具权限交给 Claude Code 自身的用户配置和 macOS 账户权限，静静不覆盖。
  const args = ['-p', prompt, '--output-format', 'json'];
  const resumeId = task.resume_payload?.session_id;
  if (resumeId) args.push('--resume', resumeId);

  await emit('Claude Code 已启动，正在自己的上下文里工作…');
  const result = await runCommand(bin, args, { cwd: task.cwd || settings.defaultCwd, signal });
  if (result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  if (result.code !== 0) {
    return { status: 'failed', summary: `Claude Code 退出码 ${result.code}。\n${(result.stderr || result.stdout).slice(-800)}` };
  }

  let text = result.stdout.trim();
  let sessionId = null;
  let cost = 0;
  let tokens = 0;
  try {
    const parsed = JSON.parse(text);
    text = parsed.result || parsed.message || text;
    sessionId = parsed.session_id || null;
    cost = parsed.total_cost_usd || 0;
    tokens = estimateTokens(text);
  } catch {
    tokens = estimateTokens(text);
  }
  const approval = extractApproval(text);
  if (approval) {
    return { status: 'needs_approval', summary: approval.text, approval: approval.approval, sessionId, tokens, cost };
  }
  return { status: 'done', summary: text, sessionId, tokens, cost };
}

async function runDsh(task, ctx) {
  const settings = getSettings();
  const node = process.env.DSH_NODE_EXECUTABLE;
  const install = process.env.DSH_INSTALL_DIR;
  const home = process.env.DSH_HOME;
  if (!node || !install || !home) {
    return { status: 'failed', summary: '当前进程没有 DeepSeek Harness 运行环境（DSH_NODE_EXECUTABLE / DSH_INSTALL_DIR / DSH_HOME）' };
  }
  const cli = path.join(install, 'lib/bin.js');
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    DSH_PROFILE: 'headless',
    DSH_HOME: home,
    // 避免继承桌面会话的 profile/session 状态。
    DSH_PROFILE_DIR: null,
    DSH_SESSION_ID: null,
    DSH_WEB_URL: null,
    ...(settings.apiKey ? { DEEPSEEK_API_KEY: settings.apiKey } : {})
  };
  await ctx.emit('DeepSeek Harness 已启动，正在自己的会话里工作…');
  const result = await runCommand(node, [cli, 'headless', task.prompt || task.title], {
    cwd: task.cwd || settings.defaultCwd,
    signal: ctx.signal,
    env
  });
  const text = String(result.stdout || result.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  if (result.code !== 0) return { status: 'failed', summary: `DeepSeek Harness 退出码 ${result.code}。\n${text.slice(-1200)}` };
  return { status: 'done', summary: text || 'DeepSeek Harness 没有输出。', tokens: estimateTokens(text) };
}

async function runCodex(task, ctx) {
  const settings = getSettings();
  const bin = which('codex');
  if (!bin) return { status: 'failed', summary: '没有找到 codex 命令。' };
  const prompt = ctx.resume
    ? `${task.prompt}\n\n用户的选择：${ctx.resume.choice >= 0 ? ctx.resume.options?.[ctx.resume.choice] : '取消'}`
    : task.prompt;
  await ctx.emit('Codex 已启动…');
  const result = await runCommand(bin, ['exec', '--skip-git-repo-check', prompt], {
    cwd: task.cwd || settings.defaultCwd,
    signal: ctx.signal
  });
  const text = (result.stdout || result.stderr).trim() || `Codex 退出码 ${result.code}`;
  if (result.code !== 0) return { status: 'failed', summary: text.slice(-1200) };
  return { status: 'done', summary: text, tokens: estimateTokens(text) };
}

/* ------------------------------ Memory Worker ---------------------------- */

async function runMemory(task, ctx) {
  await ctx.emit('整理记忆库…');
  await sleep(300, ctx.signal);
  return {
    status: 'done',
    summary: ctx.memories?.length
      ? `记忆库现有 ${ctx.memories.length} 条上下文，已按层（画像/语义/情景）整理完毕。`
      : '记忆库还是空的。你可以对我说「记住……」来留下第一条。'
  };
}

registerBuiltin('llm', {
  label: WORKER_LABEL.llm, glyph: '事',
  detect: () => {
    const settings = getSettings();
    return { available: true, detail: `${settings.provider === 'demo' ? '演示模式' : `模型：${settings.model}`} · 仅文本，不读写文件/不执行命令` };
  },
  run: runLlm
});
registerBuiltin('shell', { label: WORKER_LABEL.shell, glyph: '件', detect: () => ({ available: true, detail: '由主机账户权限决定' }), run: runShell });
registerBuiltin('file', { label: WORKER_LABEL.file, glyph: '文', detect: () => ({ available: true, detail: '生成文本文件并写入任务工作区' }), run: runFileWriter });
registerBuiltin('claude', {
  label: WORKER_LABEL.claude, glyph: '码',
  detect: () => {
    const settings = getSettings();
    const available = Boolean(which('claude')) && settings.claude?.enabled !== false;
    return { available, detail: available ? which('claude') : '未安装或已禁用' };
  },
  run: runClaude
});
registerBuiltin('codex', {
  label: WORKER_LABEL.codex, glyph: '码',
  detect: () => ({ available: Boolean(which('codex')), detail: which('codex') || '未安装' }),
  run: runCodex
});
registerBuiltin('dsh', {
  label: WORKER_LABEL.dsh, glyph: 'H',
  detect: () => {
    const available = Boolean(process.env.DSH_NODE_EXECUTABLE && process.env.DSH_INSTALL_DIR && process.env.DSH_HOME);
    return { available, detail: available ? 'dsh headless' : '未检测到 DeepSeek Harness 运行环境' };
  },
  run: runDsh
});
registerBuiltin('memory', { label: WORKER_LABEL.memory, glyph: '忆', detect: () => ({ available: true, detail: '本地 SQLite' }), run: runMemory });

export async function runWorker(task, ctx) {
  const descriptor = workerRegistry.get(task.worker);
  if (!descriptor || isWorkerDeleted(task.worker)) return { status: 'failed', summary: `未知的 Worker：${task.worker}` };
  const emit = async (message, meta = {}) => ctx.onProgress?.(message, meta);
  if (descriptor.source === 'plugin') {
    const row = workerRow(descriptor.id);
    if (row && !row.enabled) return { status: 'failed', summary: `Worker「${descriptor.label}」已停用。` };
    try {
      const result = await descriptor.module.execute(task, {
        ...ctx,
        emit,
        config: workerConfig(descriptor),
        settings: getSettings(),
        log: (message) => console.log(`[worker:${descriptor.id}] ${message}`)
      });
      if (!result || typeof result !== 'object') throw new Error('execute() 必须返回结果对象');
      return result;
    } catch (err) {
      return { status: 'failed', summary: `Worker「${descriptor.label}」执行失败：${err.message}` };
    }
  }
  return descriptor.run(task, { ...ctx, emit });
}

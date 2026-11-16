/**
 * 插件工坊：让静静自己写任务来源插件 / Worker 插件，检查通过后由用户确认安装。
 *
 * 流程：
 * 1. 在 <data>/plugin-drafts/<draftId>/ 准备草稿目录（模板 + AUTHORING.md + JSON Schema）；
 * 2. 有能写代码的 Worker（Claude Code、Codex……）就派任务给它在草稿目录里写；没有但接了云端模型时，让模型直接生成文件；
 * 3. 写完自动检查：清单规范、id 不重名、只用 Node 自带模块、在隔离线程里加载入口并试跑 detect / test；
 * 4. 没通过就把报错交回去修，最多 MAX_ROUNDS 轮；
 * 5. 通过后在对话里发卡片，**只有用户点「安装」才会装进「我的」插件**（插件和静静跑在同一个进程里，必须人来把关）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { DATA_DIR } from './config.js';
import { db, now, uid } from './db.js';
import { bus } from './events.js';
import { validateManifest } from './plugin-spec.js';
import { chat, llmMode } from './llm.js';
import * as scheduler from './scheduler.js';
import { workerCatalog, isWorker } from './workers.js';
import { PLUGIN_DIR, USER_PLUGIN_DIR, knownPluginIds, officialManifests } from './plugins.js';

export const DRAFT_DIR = path.join(DATA_DIR, 'plugin-drafts');
export const MAX_ROUNDS = 3;
const HELPER_FILES = new Set(['AUTHORING.md', 'plugin.schema.json']);
const MAX_FILES = 30;
const MAX_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 10 * 1000;
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const KIND_LABEL = { source: '任务来源插件', worker: 'Worker 插件' };
const TEMPLATE_IDS = new Set(['my-source', 'my-worker']);

db.exec(`
  CREATE TABLE IF NOT EXISTS plugin_drafts (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    request    TEXT NOT NULL,
    status     TEXT NOT NULL,
    mode       TEXT NOT NULL,
    worker     TEXT,
    task_id    TEXT,
    rounds     INTEGER NOT NULL DEFAULT 0,
    plugin_id  TEXT,
    name       TEXT,
    report     TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

/** 由 server.js 注入：往对话里发消息、重新加载插件。避免和 router / discovery 循环依赖。 */
let hooks = { post: () => null, reload: async () => {} };
export function configure(next = {}) {
  hooks = { ...hooks, ...next };
}

/* -------------------------------- 状态 -------------------------------- */

function parse(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function publicDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: KIND_LABEL[row.kind] || row.kind,
    request: row.request,
    status: row.status,
    mode: row.mode,
    worker: row.worker,
    taskId: row.task_id,
    rounds: row.rounds,
    maxRounds: MAX_ROUNDS,
    pluginId: row.plugin_id,
    name: row.name,
    report: parse(row.report),
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getDraft(id) {
  return publicDraft(db.prepare('SELECT * FROM plugin_drafts WHERE id = ?').get(id));
}

export function listDrafts({ limit = 30 } = {}) {
  return db.prepare('SELECT * FROM plugin_drafts ORDER BY created_at DESC LIMIT ?').all(limit).map(publicDraft);
}

function update(id, patch) {
  const fields = Object.keys(patch);
  db.prepare(`UPDATE plugin_drafts SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...fields.map((f) => patch[f]), now(), id);
  bus.emit('plugin-drafts/updated', { drafts: listDrafts() });
  return getDraft(id);
}

function draftDir(id) {
  const dir = path.resolve(DRAFT_DIR, id);
  if (!dir.startsWith(path.resolve(DRAFT_DIR) + path.sep)) throw new Error('草稿路径不合法');
  return dir;
}

function notFound() {
  return Object.assign(new Error('插件草稿不存在'), { statusCode: 404 });
}

/* -------------------------------- 选择谁来写 -------------------------------- */

export function inferKind(text) {
  return /(worker|执行器|agent|cli|命令行|干活|执行任务)/i.test(String(text || '')) ? 'worker' : 'source';
}

/** 有能写代码的 Worker 就让它写（最便宜的那个）；没有但接了云端模型就让模型直接生成。 */
export function writerFor() {
  const code = workerCatalog()
    .filter((w) => w.available !== false && (w.abilities || []).includes('code'))
    .sort((a, b) => (a.cost ?? 3) - (b.cost ?? 3)
      || Number(b.source === 'builtin') - Number(a.source === 'builtin')
      || String(a.id).localeCompare(String(b.id)))[0];
  if (code) return { mode: 'agent', worker: code.id, label: code.label };
  if (llmMode() !== 'demo') return { mode: 'model', worker: null, label: '模型' };
  return null;
}

/**
 * 官方已经有类似插件时先提示用户，免得重复造轮子：按名称里的关键片段粗匹配。
 * 返回 { id, name, description, kind } 或 null。
 */
export function findSimilarOfficial(text, kind) {
  const haystack = String(text || '').toLowerCase();
  const candidates = [
    ...officialManifests().map((m) => ({ id: m.id, name: m.name, description: m.description, kind: m.kind })),
    ...(kind === 'worker'
      ? workerCatalog().filter((w) => w.source === 'builtin').map((w) => ({ id: w.id, name: w.label, description: w.description, kind: 'worker' }))
      : [])
  ].filter((item) => item.kind === kind);
  for (const item of candidates) {
    const core = String(item.name || '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/(插件|机器人|智能|接收|订阅|集成)$/g, '')
      .trim()
      .toLowerCase();
    if (!core) continue;
    if (core.length <= 4 ? haystack.includes(core) : [...Array(core.length - 3).keys()].some((i) => haystack.includes(core.slice(i, i + 4)))) {
      return item;
    }
    if (haystack.includes(String(item.id).toLowerCase())) return item;
  }
  return null;
}

/* -------------------------------- 草稿目录 -------------------------------- */

function listFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

function prepareDir(id, kind) {
  const dir = draftDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const template = path.join(PLUGIN_DIR, kind === 'worker' ? '.template-worker' : '.template');
  if (fs.existsSync(template)) fs.cpSync(template, dir, { recursive: true });
  for (const helper of HELPER_FILES) {
    const source = path.join(PLUGIN_DIR, helper);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dir, helper));
  }
  const manifestPath = path.join(dir, 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    raw.$schema = './plugin.schema.json';
    fs.writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  }
  return dir;
}

function takenIds() {
  const ids = knownPluginIds();
  for (const w of workerCatalog()) ids.add(w.id);
  return [...ids].sort();
}

function agentPrompt(draft) {
  return [
    `你要为「静静」（本地个人 AI 工作站）写一个${KIND_LABEL[draft.kind]}。`,
    '',
    `需求：${draft.request}`,
    '',
    '当前目录就是插件草稿目录，里面有：',
    '- AUTHORING.md：插件规范，动手前先读完；',
    '- plugin.schema.json：plugin.json 的 JSON Schema；',
    '- plugin.json、index.js：模板，在它们的基础上改。',
    '',
    '要求：',
    '1. 只在当前目录里写文件（plugin.json、入口文件、可选 README.md），不要改动其他目录，不要安装任何东西，不要运行 npm。',
    '2. 只能使用 Node.js 自带模块（node:xxx）和全局 fetch，不能有 npm 依赖。',
    `3. plugin.json 的 kind 必须是 "${draft.kind}"；id 用小写字母、数字、短横线（2–32 位），不能和这些重复：${takenIds().join('、')}。`,
    '4. 模块顶层不要有副作用；需要用户填写的地址、Token 等放进 config。',
    '5. 写完用两三句话说明：插件做什么、用户需要填哪些配置。',
    '',
    '静静会自动检查清单和导出的函数，通过后由用户确认安装。'
  ].join('\n');
}

function fixPrompt(draft, errors) {
  return [
    `你在当前目录写的${KIND_LABEL[draft.kind]}没有通过静静的检查，请在当前目录里修好（规范见 AUTHORING.md）：`,
    '',
    ...errors.map((e) => `- ${e}`),
    '',
    `原始需求：${draft.request}`,
    '',
    '同样只改当前目录，不要安装任何东西。修完简要说明改了什么。'
  ].join('\n');
}

/* -------------------------------- 检查 -------------------------------- */

const IMPORT_RES = [
  /(?:^|[^\w$.])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|[^\w$.])import\s*['"]([^'"]+)['"]/g,
  /(?:^|[^\w$.])import\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:^|[^\w$.])require\(\s*['"]([^'"]+)['"]\s*\)/g
];

/** 找出代码里引用的非 Node 自带、非相对路径的模块（也就是 npm 包）。 */
export function externalImports(code) {
  const found = new Set();
  for (const re of IMPORT_RES) {
    for (const match of String(code).matchAll(re)) {
      const spec = match[1];
      if (spec.startsWith('./') || spec.startsWith('../') || NODE_BUILTINS.has(spec)) continue;
      found.add(spec);
    }
  }
  return [...found];
}

function runProbe(dir, manifest, config, runTest) {
  return new Promise((resolve) => {
    const thread = new ThreadWorker(new URL('./plugin-probe.js', import.meta.url), {
      workerData: { entry: pathToFileURL(path.join(dir, manifest.entry)).href, manifest, config, runTest },
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      thread.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `加载入口超过 ${PROBE_TIMEOUT_MS / 1000} 秒（顶层是不是有死循环或在等网络？）` }), PROBE_TIMEOUT_MS);
    thread.on('message', finish);
    thread.on('error', (err) => finish({ ok: false, error: err.message }));
    thread.on('exit', (code) => finish({ ok: false, error: `检查线程意外退出（退出码 ${code}）` }));
  });
}

function defaults(manifest) {
  const out = {};
  for (const field of manifest.config || []) out[field.key] = field.default;
  return out;
}

/** 检查一份草稿。返回 { ok, errors, warnings, info, checkedAt }。 */
export async function checkDraft(draftOrId) {
  const draft = typeof draftOrId === 'string' ? getDraft(draftOrId) : draftOrId;
  if (!draft) throw notFound();
  const dir = draftDir(draft.id);
  const errors = [];
  const warnings = [];
  const files = listFiles(dir).filter((file) => !HELPER_FILES.has(file));
  const sizes = files.map((file) => ({ name: file, size: fs.statSync(path.join(dir, file)).size }));
  const info = { files: sizes };
  const report = () => ({ ok: errors.length === 0, errors, warnings, info, checkedAt: now() });

  if (files.length > MAX_FILES) errors.push(`文件太多（${files.length} 个，最多 ${MAX_FILES} 个）`);
  if (sizes.reduce((sum, f) => sum + f.size, 0) > MAX_BYTES) errors.push('插件太大（超过 1MB），不要把依赖或数据打包进来');

  let manifest;
  try {
    manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  } catch (err) {
    errors.push(`plugin.json：${err.message}`);
    return report();
  }
  Object.assign(info, {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    kind: manifest.kind,
    type: manifest.kind === 'source' ? manifest.type : null,
    capabilities: manifest.capabilities,
    abilities: manifest.worker?.abilities || null,
    config: (manifest.config || []).map((field) => ({ key: field.key, label: field.label, type: field.type, required: field.required }))
  });
  if (manifest.kind !== draft.kind) errors.push(`kind 应该是 "${draft.kind}"，现在是 "${manifest.kind}"`);
  // 模板本身就能通过检查：id 没改说明还没真正动手写（比如编码任务一开始就断了）。
  if (TEMPLATE_IDS.has(manifest.id)) errors.push(`id 还是模板里的「${manifest.id}」，插件还没写，或者没写完`);
  if (knownPluginIds().has(manifest.id) || isWorker(manifest.id)) errors.push(`id「${manifest.id}」已经被占用，换一个`);

  if (fs.existsSync(path.join(dir, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).length) {
      errors.push('不能有 npm 依赖：删掉 package.json 里的 dependencies，只用 Node 自带模块和 fetch');
    }
  }
  for (const file of files.filter((name) => /\.(c|m)?js$/.test(name))) {
    const external = externalImports(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (external.length) errors.push(`${file} 引用了 npm 包：${external.join('、')}（只能用 node: 自带模块和相对路径）`);
  }
  if (errors.length) return report();

  const required = (manifest.config || []).filter((field) => field.required);
  const probe = await runProbe(dir, manifest, defaults(manifest), manifest.kind === 'source' && required.length === 0);
  if (!probe.ok) {
    errors.push(`加载入口失败：${probe.error}`);
    return report();
  }
  info.exports = probe.exports;
  const need = manifest.kind === 'worker'
    ? ['execute']
    : ['poll', ...(manifest.type === 'webhook' ? ['webhook'] : []), ...(manifest.type === 'stream' ? ['start'] : [])];
  const missing = need.filter((name) => !probe.exports.includes(name));
  if (missing.length) errors.push(`入口没有导出必需的函数：${missing.join('、')}`);
  if (probe.detect?.error) errors.push(`detect() 出错：${probe.detect.error}`);
  else if (probe.detect && probe.detect.available === false) warnings.push(`detect() 说这台机器上暂时不可用：${probe.detect.detail || ''}`);
  if (probe.detect) info.detect = probe.detect;
  if (probe.test) {
    info.test = probe.test;
    if (probe.test.ok === false) warnings.push(`test() 没通过：${probe.test.detail || ''}（可能需要先填配置）`);
  } else if (manifest.kind === 'source' && required.length) {
    info.testSkipped = `有必填配置（${required.map((f) => f.label).join('、')}），安装后填好再点「测试连接」`;
  }
  return report();
}

/* -------------------------------- 写 / 修 -------------------------------- */

function startAgentRound(draft, prompt) {
  const task = scheduler.createTask({
    title: `${draft.rounds > 1 ? `修改${KIND_LABEL[draft.kind]}（第 ${draft.rounds} 轮）` : `写${KIND_LABEL[draft.kind]}`}：${draft.request.slice(0, 30)}`,
    prompt,
    worker: draft.worker,
    cwd: draftDir(draft.id),
    origin: 'plugin-forge',
    sessionId: draft.sessionId || null,
    options: { allowEdits: true }
  });
  return update(draft.id, { task_id: task.id, status: 'writing' });
}

const SAFE_NAME = /^[\w.-]{1,60}\.(?:js|mjs|cjs|json|md)$/;

async function runModelRound(draft, errors = []) {
  const dir = draftDir(draft.id);
  const guide = fs.readFileSync(path.join(PLUGIN_DIR, 'AUTHORING.md'), 'utf8');
  const current = listFiles(dir)
    .filter((file) => !HELPER_FILES.has(file) && SAFE_NAME.test(file))
    .map((file) => `### ${file}\n${fs.readFileSync(path.join(dir, file), 'utf8').slice(0, 20000)}`)
    .join('\n\n');
  const system = [
    `你是插件工程师，按下面的规范给「静静」写一个${KIND_LABEL[draft.kind]}。`,
    '只输出 JSON：{"files":{"plugin.json":"文件内容","index.js":"文件内容"},"summary":"两三句话说明插件做什么、要填哪些配置"}。',
    `plugin.json 的 kind 必须是 "${draft.kind}"，id 不能和这些重复：${takenIds().join('、')}。`,
    '',
    guide
  ].join('\n');
  const content = [
    `需求：${draft.request}`,
    errors.length ? `\n上一版没通过检查，请修好：\n${errors.map((e) => `- ${e}`).join('\n')}` : '',
    `\n当前文件：\n${current}`
  ].join('\n');
  const res = await chat({ system, messages: [{ role: 'user', content }], json: true, temperature: 0.2, maxTokens: 8000 });
  const text = res.text || '';
  const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const files = parsed.files && typeof parsed.files === 'object' ? parsed.files : {};
  let written = 0;
  for (const [name, body] of Object.entries(files)) {
    if (!SAFE_NAME.test(name) || HELPER_FILES.has(name)) continue;
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    written += 1;
  }
  if (!written) throw new Error('模型没有给出插件文件');
}

/** 检查草稿并把报告存起来。extra 会并进报告（比如 interrupted：编码任务中途断掉的原因）。 */
async function runCheck(draftId, extra = {}) {
  update(draftId, { status: 'checking' });
  const report = { ...(await checkDraft(draftId)), ...extra };
  const draft = update(draftId, { report: JSON.stringify(report), plugin_id: report.info.id || null, name: report.info.name || null });
  return { draft, report };
}

/** 一轮写完后：检查，通过就等用户确认；没通过且还有轮次就交回去修；否则判定失败。 */
async function afterRound(draftId) {
  let { draft, report } = await runCheck(draftId);
  if (report.ok) {
    update(draftId, { status: 'ready' });
    announce(draftId, `「${report.info.name}」写好了，检查都通过了。看一眼代码，没问题就点「安装」。`);
    return;
  }
  if (draft.rounds < MAX_ROUNDS) {
    draft = update(draftId, { rounds: draft.rounds + 1, status: 'writing' });
    if (draft.mode === 'agent') startAgentRound(draft, fixPrompt(draft, report.errors));
    else runModelRound(draft, report.errors).then(() => afterRound(draftId)).catch((err) => fail(draftId, err.message));
    return;
  }
  update(draftId, { status: 'failed' });
  announce(draftId, `「${report.info.name || draft.request.slice(0, 20)}」改了 ${draft.rounds} 轮还是没通过检查，先停在这里。可以看看代码，或者让我再试一次。`);
}

/**
 * 编码任务失败了（比如额度用完、进程被杀），但文件可能已经写好了：照常检查一遍。
 * 通过就等用户确认（卡片上提示可能没写完整）；没通过就停下，不自动开新一轮——Worker 这时多半还用不了。
 */
async function salvage(draftId, reason) {
  const { report } = await runCheck(draftId, { interrupted: reason });
  const short = reason.split('\n')[0].slice(0, 80);
  if (report.ok) {
    update(draftId, { status: 'ready' });
    announce(draftId, `「${report.info.name}」的编码任务中途断了（${short}），不过草稿里的文件已经通过了检查。可能没写完整，先「查看代码」确认，没问题再点「安装」。`);
    return;
  }
  update(draftId, { status: 'failed' });
  announce(draftId, `插件没写成：${short}。等它能用了点「再试一次」，会接着已经写好的部分继续。`);
}

function fail(draftId, message) {
  const draft = getDraft(draftId);
  if (!draft || ['installed', 'discarded'].includes(draft.status)) return;
  const report = { ...(draft.report || {}), ok: false, errors: [...(draft.report?.errors || []), message], warnings: draft.report?.warnings || [], info: draft.report?.info || {} };
  update(draftId, { status: 'failed', report: JSON.stringify(report) });
  announce(draftId, `插件没写成：${message}`);
}

function announce(draftId, text) {
  const draft = getDraft(draftId);
  hooks.post(text, { kind: 'plugin-draft', meta: { draftId }, sessionId: draft?.sessionId || undefined });
}

/* -------------------------------- 对外 -------------------------------- */

/** 开始写一个插件。返回草稿（agent 模式下 taskId 指向编码任务）。 */
export function createDraft({ kind, request, sessionId = null } = {}) {
  const text = String(request || '').trim();
  if (!text) throw Object.assign(new Error('说说想要一个什么样的插件'), { statusCode: 400 });
  const pluginKind = kind === 'worker' ? 'worker' : kind === 'source' ? 'source' : inferKind(text);
  const writer = writerFor();
  if (!writer) {
    throw Object.assign(new Error('要写插件需要一个能写代码的 Worker（比如 Claude Code、Codex），或者先在设置里接入云端模型。'), { statusCode: 400 });
  }
  const id = uid('d_');
  prepareDir(id, pluginKind);
  const stamp = now();
  db.prepare(`
    INSERT INTO plugin_drafts(id, kind, request, status, mode, worker, rounds, session_id, created_at, updated_at)
    VALUES(?, ?, ?, 'writing', ?, ?, 1, ?, ?, ?)
  `).run(id, pluginKind, text.slice(0, 2000), writer.mode, writer.worker, sessionId, stamp, stamp);
  const draft = getDraft(id);
  if (writer.mode === 'agent') return startAgentRound(draft, agentPrompt(draft));
  runModelRound(draft).then(() => afterRound(id)).catch((err) => fail(id, `模型生成失败：${err.message}`));
  bus.emit('plugin-drafts/updated', { drafts: listDrafts() });
  return draft;
}

/** 用户点「安装」：复查一遍，再挪进「我的」插件目录并重新加载。 */
export async function installDraft(id) {
  const draft = getDraft(id);
  if (!draft) throw notFound();
  if (draft.status !== 'ready') throw Object.assign(new Error('这个草稿现在不能安装（还没写完、没通过检查，或者已经处理过了）'), { statusCode: 400 });
  const report = await checkDraft(draft);
  if (!report.ok) {
    update(id, { status: 'failed', report: JSON.stringify(report) });
    throw Object.assign(new Error(`安装前复查没通过：${report.errors.join('；')}`), { statusCode: 400 });
  }
  const dir = draftDir(id);
  const target = path.join(USER_PLUGIN_DIR, report.info.id);
  if (fs.existsSync(target)) throw Object.assign(new Error(`「我的」插件里已经有 ${report.info.id} 了`), { statusCode: 409 });
  for (const helper of HELPER_FILES) fs.rmSync(path.join(dir, helper), { force: true });
  const manifestPath = path.join(dir, 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete raw.$schema;
  fs.writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  fs.mkdirSync(USER_PLUGIN_DIR, { recursive: true });
  fs.renameSync(dir, target);
  update(id, { status: 'installed', plugin_id: report.info.id, report: JSON.stringify(report) });
  await hooks.reload();
  return { pluginId: report.info.id, kind: report.info.kind, draft: getDraft(id) };
}

/** 放弃草稿：停掉还在写的任务，删掉草稿目录。 */
export function discardDraft(id) {
  const draft = getDraft(id);
  if (!draft) throw notFound();
  if (draft.status === 'installed') throw Object.assign(new Error('已经安装了，要删请到插件页删除'), { statusCode: 400 });
  if (draft.taskId) {
    const task = scheduler.getTask(draft.taskId);
    if (task && ['queued', 'running', 'waiting_approval'].includes(task.status)) scheduler.cancel(task.id, '插件草稿已放弃');
  }
  fs.rmSync(draftDir(id), { recursive: true, force: true });
  return update(id, { status: 'discarded' });
}

/** 没通过的草稿再试一轮（轮次清零）。 */
export function retryDraft(id) {
  const draft = getDraft(id);
  if (!draft) throw notFound();
  if (draft.status !== 'failed') throw Object.assign(new Error('只有没通过的草稿可以再试'), { statusCode: 400 });
  const errors = [
    ...(draft.report?.interrupted ? ['上一次写到一半中断了：先看看当前目录里已经写好的部分，再把插件补全'] : []),
    ...(draft.report?.errors || [])
  ];
  if (!errors.length) errors.push('上一次没有完成，请检查并补全插件');
  const next = update(id, { rounds: 1, status: 'writing' });
  if (next.mode === 'agent') return startAgentRound(next, fixPrompt(next, errors));
  runModelRound(next, errors).then(() => afterRound(id)).catch((err) => fail(id, `模型生成失败：${err.message}`));
  return next;
}

/**
 * 没通过的草稿重新检查一遍，不让 Worker 改：编码任务报错但文件其实写完了，或者用户自己动手改过草稿时用。
 * 通过就变成待确认，照样要用户点「安装」；没通过就用新的检查结果替换旧报错。
 */
export async function recheckDraft(id) {
  const draft = getDraft(id);
  if (!draft) throw notFound();
  if (draft.status !== 'failed') throw Object.assign(new Error('只有没通过的草稿需要重新检查'), { statusCode: 400 });
  let report;
  try {
    ({ report } = await runCheck(id, { interrupted: draft.report?.interrupted }));
  } catch (err) {
    update(id, { status: 'failed' });
    throw err;
  }
  const next = update(id, { status: report.ok ? 'ready' : 'failed' });
  if (report.ok) announce(id, `「${report.info.name}」重新检查通过了。看一眼代码，没问题就点「安装」。`);
  return next;
}

/** 给「查看代码」用：草稿里的文件内容（不含规范和 Schema）。 */
export function draftFiles(id) {
  const draft = getDraft(id);
  if (!draft) throw notFound();
  const dir = draft.status === 'installed' && draft.pluginId ? path.join(USER_PLUGIN_DIR, draft.pluginId) : draftDir(id);
  return listFiles(dir)
    .filter((file) => !HELPER_FILES.has(file))
    .map((file) => {
      const full = path.join(dir, file);
      const size = fs.statSync(full).size;
      return { name: file, size, content: size > 200 * 1024 ? '（文件太大，不显示）' : fs.readFileSync(full, 'utf8') };
    });
}

// 编码任务结束时接着检查；失败时也检查一遍已经写出来的文件；被取消或删掉时记下来。
// 调度器在每一种终态（完成、失败、超时、取消、拍板超限……）都会发 task/finished。
bus.on(({ type, payload }) => {
  if (type === 'task/deleted') {
    if (payload.task?.origin !== 'plugin-forge') return;
    const row = db.prepare("SELECT id FROM plugin_drafts WHERE task_id = ? AND status = 'writing'").get(payload.id);
    if (row) fail(row.id, '编码任务被删除了');
    return;
  }
  if (type !== 'task/finished') return;
  const task = payload.task;
  if (!task || task.origin !== 'plugin-forge') return;
  const row = db.prepare("SELECT id FROM plugin_drafts WHERE task_id = ? AND status = 'writing'").get(task.id);
  if (!row) return;
  if (task.status === 'done') {
    afterRound(row.id).catch((err) => fail(row.id, err.message));
  } else if (task.status === 'failed') {
    salvage(row.id, String(task.error || '编码任务失败').slice(0, 300)).catch((err) => fail(row.id, err.message));
  } else if (task.status === 'cancelled') {
    fail(row.id, '编码任务被取消了');
  }
});

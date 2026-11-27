/**
 * 工作流程：「遇到什么情况 → 派给哪个 Worker、在哪个工作区 → 按什么步骤做」。
 *
 * 每个流程就是一个 Markdown 文件，头部（可选）是几行 key: value：
 *
 *   ---
 *   name: 写周报
 *   when: 周报, weekly        # 触发词（逗号/顿号/竖线分隔；默认当字面词，不再当正则）
 *   whenRegex: false          # true：when 按正则解释（高级用法，兼容老流程）
 *   notWhen: 周报怎么用       # 可选：命中这些词就不触发（排除问句/反例）
 *   worker: file              # 可选：派给哪个 Worker
 *   workspace: 默认工作区      # 可选：工作区名称或 id
 *   status: active            # active / candidate / dismissed / disabled
 *   auto: false               # true：执行中遇到 answers 里记过的问题时自动拍板
 *   answers: 要覆盖.*吗 => 覆盖; 要发布吗 => 先不发
 *   ---
 *   1. 汇总本周完成的任务……
 *
 * 来源有两种，格式完全一样：
 * - 文档：用户自己写的，放在 <data>/workflows/ 或设置里指定的文件夹；
 * - 习惯：任务完成后静静总结的，写在 <data>/workflows/learned/，默认是候选，用户确认后生效。
 *
 * 静静不会改写用户文件夹里的文件：那些文件的启用/停用只记在本机数据库里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { db, now, getSettings } from './db.js';
import { chat, llmMode, makeTitle } from './llm.js';
import { compileTerms, matchCompiled } from './routing-signals.js';

export const WORKFLOW_DIR = path.join(DATA_DIR, 'workflows');
export const LEARNED_DIR = path.join(WORKFLOW_DIR, 'learned');
export const STATUSES = ['active', 'candidate', 'dismissed', 'disabled'];

const MAX_FILES = 300;
const MAX_DEPTH = 3;
const MAX_BYTES = 64 * 1024;
const MAX_STEPS_IN_PROMPT = 4000;
const RESCAN_MS = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '.Trash']);
const NAME_SUFFIX_RE = /(工作流程|流程|规范|手册|指南|步骤|模板|SOP|checklist|检查清单)$/i;
const VERB_PREFIX_RE = /^(帮我|请|麻烦)?\s*(写|做|生成|整理|处理|准备|制作|创建|新建|编写|更新|发送|发|提交|看看|看一下|检查|修复|总结|汇总|跑一下|执行)?\s*(一下|一个|一份|一篇|个|份|篇)?\s*/;

db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_stats (
    id           TEXT PRIMARY KEY,
    uses         INTEGER NOT NULL DEFAULT 0,
    successes    INTEGER NOT NULL DEFAULT 0,
    failures     INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS workflow_state (
    id         TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
try { db.exec('ALTER TABLE workflow_state ADD COLUMN auto INTEGER'); } catch { /* 已存在 */ }

/* ------------------------------- 解析 ------------------------------- */

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function parseFrontmatter(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    out[match[1].toLowerCase()] = unquote(match[2].replace(/\s+#.*$/, ''));
  }
  return out;
}

/**
 * 把 when 编译成运行时能用的形状：
 * - 默认 keywords：按逗号/顿号/竖线拆词，转义后匹配，用户写人话不会被正则元字符误伤；
 * - whenRegex: true 时按正则解释，兼容老流程。
 * 保留 trigger 正则给老代码/测试使用，terms 供归一化匹配。
 */
export function compileTrigger(when, { mode = 'keywords', negatives = '' } = {}) {
  const raw = String(when || '').trim().replace(/^\[|\]$/g, '');
  if (!raw) return { trigger: null, terms: [], negatives: [], mode, error: null };
  const compiled = compileTerms(raw, { mode, negatives });
  return {
    trigger: compiled.trigger,
    terms: compiled.terms,
    negatives: compiled.negatives,
    mode: compiled.mode,
    error: compiled.error ? `when ${compiled.error}` : null
  };
}

const TRUE_RE = /^(true|yes|on|1|是|开)$/i;

/** answers: 问题正则 => 选项; 问题正则 => 选项 */
export function parseAnswers(text) {
  const answers = [];
  for (const part of String(text || '').split(/\s*;\s*/)) {
    if (!part.trim()) continue;
    const index = part.lastIndexOf('=>');
    if (index < 0) return { answers, error: `answers 格式应为「问题 => 选项」：${part}` };
    const question = part.slice(0, index).trim();
    const option = part.slice(index + 2).trim();
    if (!question || !option) return { answers, error: `answers 缺少问题或选项：${part}` };
    try {
      answers.push({ question, option, pattern: new RegExp(question, 'i') });
    } catch (err) {
      return { answers, error: `answers 里的问题不是合法正则：${err.message}` };
    }
  }
  return { answers, error: null };
}

/** 把一次具体的问题泛化成能匹配同类问题的正则：转义特殊字符，数字换成 \d+。 */
export function generalizeQuestion(question) {
  return escapeRegExp(String(question || '').trim()).replace(/\d+/g, '\\d+').replace(/;/g, '.');
}

function idFor(file) {
  return crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 12);
}

export function isOwnedFile(file) {
  const root = path.resolve(WORKFLOW_DIR) + path.sep;
  return path.resolve(file).startsWith(root);
}

/** 解析一份流程文档。file 只用于生成 id 和兜底名称。 */
export function parseWorkflow(raw, { file = '', mtimeMs = 0 } = {}) {
  const text = String(raw || '');
  const fm = text.match(FRONTMATTER_RE);
  const meta = fm ? parseFrontmatter(fm[1]) : {};
  const body = (fm ? text.slice(fm[0].length) : text).trim();
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const fallback = path.basename(file || '未命名流程', path.extname(file || ''));
  const name = String(meta.name || heading || fallback).trim().slice(0, 60) || fallback;
  const source = meta.source === 'learned' ? 'learned' : 'doc';
  const fileStatus = STATUSES.includes(meta.status) ? meta.status : (source === 'learned' ? 'candidate' : 'active');
  const whenMode = TRUE_RE.test(String(meta.whenregex || meta.when_regex || '')) ? 'regex' : 'keywords';
  const notWhen = String(meta.notwhen || meta.not_when || '');
  const { trigger, error: triggerError, terms, negatives, mode } = compileTrigger(meta.when, { mode: whenMode, negatives: notWhen });
  const { answers, error: answersError } = parseAnswers(meta.answers);
  return {
    id: idFor(file || name),
    file: file ? path.resolve(file) : '',
    name,
    when: meta.when || '',
    notWhen,
    mode,
    trigger,
    terms,
    negatives,
    worker: meta.worker || '',
    workspace: meta.workspace || '',
    source,
    fileStatus,
    status: fileStatus,
    steps: body.replace(/^<!--[\s\S]*?-->\s*/, '').trim(),
    learnedFrom: meta.learned_from || '',
    fileAuto: TRUE_RE.test(meta.auto || ''),
    auto: TRUE_RE.test(meta.auto || ''),
    answers,
    error: triggerError || answersError,
    updatedAt: mtimeMs ? new Date(mtimeMs).toISOString() : null
  };
}

/* ------------------------------- 扫描 ------------------------------- */

function expandHome(dir) {
  const value = String(dir || '').trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function workflowDirs(settings = getSettings()) {
  const extra = Array.isArray(settings.workflowDirs) ? settings.workflowDirs : [];
  const seen = new Set();
  const out = [];
  for (const dir of [WORKFLOW_DIR, ...extra]) {
    const resolved = path.resolve(expandHome(dir));
    if (!dir || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

const cache = new Map(); // file -> { mtimeMs, size, workflow }
let lastScan = 0;
let scanned = [];
let scanErrors = [];

function walk(dir, depth, files, errors) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push({ dir, error: err.code === 'ENOENT' ? '文件夹不存在' : err.message });
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) walk(full, depth + 1, files, errors);
    } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
      files.push(full);
    }
  }
}

function effectiveState(workflow) {
  const row = db.prepare('SELECT status, auto FROM workflow_state WHERE id = ?').get(workflow.id);
  return {
    status: STATUSES.includes(row?.status) ? row.status : workflow.fileStatus,
    auto: row?.auto === null || row?.auto === undefined ? workflow.fileAuto : Boolean(row.auto)
  };
}

/** 重新扫描所有流程文件夹；没改过的文件直接用缓存。 */
export function reload() {
  fs.mkdirSync(LEARNED_DIR, { recursive: true });
  const files = [];
  const errors = [];
  for (const dir of workflowDirs()) walk(dir, 0, files, errors);
  if (files.length >= MAX_FILES) errors.push({ dir: '', error: `流程文件超过 ${MAX_FILES} 个，只读取了前 ${MAX_FILES} 个` });
  const next = [];
  const live = new Set();
  for (const file of files) {
    live.add(file);
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BYTES) {
        errors.push({ dir: file, error: `文件超过 ${MAX_BYTES / 1024}KB，已跳过` });
        continue;
      }
      const cached = cache.get(file);
      let workflow = cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size ? cached.workflow : null;
      if (!workflow) {
        workflow = parseWorkflow(fs.readFileSync(file, 'utf8'), { file, mtimeMs: stat.mtimeMs });
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, workflow });
      }
      next.push({ ...workflow, ...effectiveState(workflow) });
    } catch (err) {
      errors.push({ dir: file, error: err.message });
    }
  }
  for (const file of cache.keys()) if (!live.has(file)) cache.delete(file);
  scanned = next;
  scanErrors = errors;
  lastScan = Date.now();
  return scanned;
}

function all({ fresh = false } = {}) {
  if (fresh || Date.now() - lastScan > RESCAN_MS) reload();
  return scanned;
}

function stats(id) {
  return db.prepare('SELECT uses, successes, failures, last_used_at FROM workflow_stats WHERE id = ?').get(id)
    || { uses: 0, successes: 0, failures: 0, last_used_at: null };
}

function publicWorkflow(workflow) {
  const { trigger, fileStatus, fileAuto, answers, ...rest } = workflow;
  return {
    ...rest,
    answers: (answers || []).map(({ question, option }) => ({ question, option })),
    editable: isOwnedFile(workflow.file),
    stats: stats(workflow.id)
  };
}

/**
 * 习惯开启了自动拍板时，找出对这条审批的回答（选项下标）；找不到就返回 null，照常等用户。
 * 只认流程里明确记下的「问题 => 选项」，并且选项必须在这次的可选项里。
 */
export function autoAnswer(workflow, approval) {
  if (!workflow || workflow.status !== 'active' || !workflow.auto || !approval) return null;
  for (const answer of workflow.answers || []) {
    if (!answer.pattern.test(approval.question || '')) continue;
    const want = answer.option.trim().toLowerCase();
    const index = (approval.options || []).findIndex((option) => String(option).trim().toLowerCase() === want);
    if (index >= 0) return index;
  }
  return null;
}

export function listWorkflows({ fresh = false } = {}) {
  const order = { active: 0, candidate: 1, disabled: 2, dismissed: 3 };
  return all({ fresh })
    .map(publicWorkflow)
    .sort((a, b) => order[a.status] - order[b.status] || a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

export function overview({ fresh = false } = {}) {
  return { workflows: listWorkflows({ fresh }), dirs: workflowDirs(), errors: scanErrors, root: WORKFLOW_DIR };
}

export function getWorkflow(id) {
  return all().find((workflow) => workflow.id === id) || null;
}

export function readRaw(id) {
  const workflow = getWorkflow(id);
  if (!workflow) throw notFound();
  return fs.readFileSync(workflow.file, 'utf8');
}

function notFound() {
  const err = new Error('工作流程不存在（文件可能被移动或删除了），刷新一下');
  err.statusCode = 404;
  return err;
}

/* ------------------------------- 匹配 ------------------------------- */

function bigrams(text) {
  const chars = [...String(text || '').toLowerCase().replace(/\s+/g, '')];
  if (chars.length < 2) return chars.length ? [chars[0]] : [];
  const out = [];
  for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** 没写 when 的文档按名称模糊匹配：去掉「流程/规范」后缀和动词前缀，看二字组的覆盖率。 */
function implicitScore(workflow, text) {
  const core = workflow.name.replace(NAME_SUFFIX_RE, '').replace(VERB_PREFIX_RE, '').trim();
  const grams = bigrams(core);
  if (!grams.length || core.length < 2) return 0;
  const haystack = String(text || '').toLowerCase().replace(/\s+/g, '');
  const hit = grams.filter((gram) => haystack.includes(gram)).length;
  return hit / grams.length;
}

/**
 * 找和这句话匹配的生效流程。显式 when 优先（文档优先于习惯，命中越长越具体）；
 * 没有 when 的文档按名称模糊匹配。返回 { workflow, how } 或 null。
 */
export function matchWorkflow(text, { workflows = all(), includeInactive = false, refs = [] } = {}) {
  const pool = workflows.filter((w) => includeInactive || w.status === 'active');
  // 实体键只做同分时的偏好：两个流程都命中同样的触发词时，优先当前情境所在工作区的那个；
  // 不参与「有没有命中」的判断，避免「进了这个工作区就自动套所有流程」。
  const workspaceIds = new Set((refs || []).filter((ref) => ref.kind === 'workspace').map((ref) => ref.key));
  const settings = workspaceIds.size ? getSettings() : null;
  const workspaceBonus = (workflow) => {
    if (!settings) return 0;
    const ws = resolveWorkspace(workflow, settings);
    return ws && workspaceIds.has(ws.id) ? 1 : 0;
  };
  let best = null;
  for (const workflow of pool) {
    if (!workflow.trigger && !workflow.terms?.length) continue;
    const hit = matchCompiled(text, workflow);
    if (!hit) continue;
    const score = (workflow.source === 'doc' ? 1000 : 0) + hit.length + workspaceBonus(workflow) * 0.9;
    if (!best || score > best.score) best = { workflow, how: 'when', score };
  }
  if (best) return best;
  for (const workflow of pool) {
    if (workflow.trigger || workflow.terms?.length || workflow.source !== 'doc') continue;
    const base = implicitScore(workflow, text);
    if (base < 0.6) continue;
    const score = base + workspaceBonus(workflow) * 0.2;
    if (!best || score > best.score) best = { workflow, how: 'name', score };
  }
  return best;
}

/** 给模型分类用的精简列表。 */
export function catalog() {
  return all()
    .filter((w) => w.status === 'active')
    .slice(0, 30)
    .map((w) => ({
      id: w.id,
      name: w.name,
      when: w.when,
      triggers: w.terms || [],
      worker: w.worker,
      hint: w.steps.split('\n').find(Boolean)?.slice(0, 60) || ''
    }));
}

/** 追加到任务指令末尾的流程说明。 */
export function promptSection(workflow) {
  if (!workflow) return '';
  const origin = workflow.source === 'learned' ? '你确认过的习惯' : '你写的流程';
  const steps = workflow.steps.length > MAX_STEPS_IN_PROMPT ? `${workflow.steps.slice(0, MAX_STEPS_IN_PROMPT)}…` : workflow.steps;
  // 不带文件名：Worker 会检查指令里有没有 .md 等文件名来判断是否要写文件。
  return `\n\n---\n按工作流程「${workflow.name}」来做（来源：${origin}）：\n${steps || '（流程没有写具体步骤）'}`;
}

export function resolveWorkspace(workflow, settings = getSettings()) {
  if (!workflow?.workspace) return null;
  const value = workflow.workspace.trim();
  return (settings.workspaces || []).find((w) => w.id === value || w.name === value) || null;
}

/* ------------------------------- 写入 ------------------------------- */

/** 设置 frontmatter 里的一个字段（没有 frontmatter 就新建）。 */
export function setFrontmatterField(raw, key, value) {
  const text = String(raw || '');
  const line = `${key}: ${value}`;
  const fm = text.match(FRONTMATTER_RE);
  if (!fm) return `---\n${line}\n---\n\n${text}`;
  const lines = fm[1].split(/\r?\n/);
  const index = lines.findIndex((l) => new RegExp(`^${key}\\s*:`, 'i').test(l));
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  return `---\n${lines.join('\n')}\n---\n${text.slice(fm[0].length)}`;
}

function slugify(name) {
  return String(name || '流程').replace(/[\\/:*?"<>|#\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || '流程';
}

function uniqueFile(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const base = slugify(name);
  let file = path.join(dir, `${base}.md`);
  for (let i = 2; fs.existsSync(file); i += 1) file = path.join(dir, `${base}-${i}.md`);
  return file;
}

function frontmatter(fields) {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${String(value).replace(/\r?\n/g, ' ')}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

function writeAndReload(file, content) {
  fs.writeFileSync(file, content, 'utf8');
  reload();
  return getWorkflow(idFor(file));
}

export function createWorkflow({ name, when = '', worker = '', workspace = '', steps = '' } = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('流程名不能为空'), { statusCode: 400 });
  const { error } = compileTrigger(when);
  if (error) throw Object.assign(new Error(error), { statusCode: 400 });
  const file = uniqueFile(WORKFLOW_DIR, clean);
  const body = String(steps || '').trim() || '1. 第一步……\n2. 第二步……';
  return publicWorkflow(writeAndReload(file, `${frontmatter({ name: clean, when, worker, workspace, status: 'active' })}\n${body}\n`));
}

export function updateRaw(id, raw) {
  const workflow = getWorkflow(id);
  if (!workflow) throw notFound();
  if (!isOwnedFile(workflow.file)) {
    throw Object.assign(new Error('这个流程在你自己的文件夹里，请直接用编辑器改原文件'), { statusCode: 400 });
  }
  const text = String(raw ?? '');
  if (Buffer.byteLength(text) > MAX_BYTES) throw Object.assign(new Error('内容太长'), { statusCode: 400 });
  const { error } = compileTrigger(parseWorkflow(text, { file: workflow.file }).when);
  if (error) throw Object.assign(new Error(error), { statusCode: 400 });
  return publicWorkflow(writeAndReload(workflow.file, text));
}

/** 改状态：静静自己目录里的文件直接写回 frontmatter；用户文件夹里的只记在数据库。 */
export function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw Object.assign(new Error('未知的状态'), { statusCode: 400 });
  const workflow = getWorkflow(id);
  if (!workflow) throw notFound();
  if (isOwnedFile(workflow.file)) {
    db.prepare('DELETE FROM workflow_state WHERE id = ?').run(id);
    return publicWorkflow(writeAndReload(workflow.file, setFrontmatterField(fs.readFileSync(workflow.file, 'utf8'), 'status', status)));
  }
  db.prepare(`
    INSERT INTO workflow_state(id, status, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
  `).run(id, status, now());
  reload();
  return publicWorkflow(getWorkflow(id));
}

/** 开关自动拍板。规则同 setStatus：自己目录的写回文件，用户文件夹的只记在数据库。 */
export function setAuto(id, auto) {
  const workflow = getWorkflow(id);
  if (!workflow) throw notFound();
  const value = Boolean(auto);
  if (isOwnedFile(workflow.file)) {
    return publicWorkflow(writeAndReload(workflow.file, setFrontmatterField(fs.readFileSync(workflow.file, 'utf8'), 'auto', String(value))));
  }
  db.prepare(`
    INSERT INTO workflow_state(id, status, auto, updated_at) VALUES(?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET auto = excluded.auto, updated_at = excluded.updated_at
  `).run(id, workflow.status, value ? 1 : 0, now());
  reload();
  return publicWorkflow(getWorkflow(id));
}

export function deleteWorkflow(id) {
  const workflow = getWorkflow(id);
  if (!workflow) throw notFound();
  if (!isOwnedFile(workflow.file)) {
    throw Object.assign(new Error('不会删除你自己文件夹里的文件；不想用可以停用'), { statusCode: 400 });
  }
  fs.rmSync(workflow.file, { force: true });
  db.prepare('DELETE FROM workflow_stats WHERE id = ?').run(id);
  db.prepare('DELETE FROM workflow_state WHERE id = ?').run(id);
  reload();
  return { ok: true };
}

export function recordOutcome(id, status) {
  if (!id || !['done', 'failed'].includes(status)) return;
  db.prepare(`
    INSERT INTO workflow_stats(id, uses, successes, failures, last_used_at) VALUES(?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET uses = uses + 1, successes = successes + excluded.successes,
      failures = failures + excluded.failures, last_used_at = excluded.last_used_at
  `).run(id, status === 'done' ? 1 : 0, status === 'failed' ? 1 : 0, now());
}

/* ------------------------------- 学习 ------------------------------- */

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从任务标题里取一个能识别同类请求的核心短语。 */
export function corePhrase(text) {
  const title = makeTitle(text).replace(VERB_PREFIX_RE, '').trim();
  const first = title.split(/[，,。；;：:！!？?]/)[0].trim();
  return (first || title).slice(0, 12).trim();
}

const NONTRIVIAL_EVENTS = new Set(['task/waiting_approval', 'task/edited', 'task/retried', 'task/retry']);
// 静静自己问的（重启后要不要重跑、外部消息交给谁），不是做事过程中的选择，不记进习惯。
const HOST_APPROVALS = new Set(['recovery', 'routing']);

/**
 * 这次任务值不值得总结成习惯：只看对话/手动发起的成功任务，没按已有流程执行，
 * 而且不是「一问一答」——用了非纯文本 Worker、中途拍过板、被改过派活或重试过。
 */
export function shouldLearn(task, events = [], { textOnly = false } = {}) {
  if (!task || task.status !== 'done') return false;
  if (!['chat', 'manual'].includes(task.origin)) return false;
  if (task.workflow_id) return false;
  if (events.some((e) => e.type.startsWith('workflow/'))) return false;
  return !textOnly || events.some((e) => NONTRIVIAL_EVENTS.has(e.type));
}

/** 从事件里整理出客观的经过，供模型或离线模板使用。 */
export function taskFacts(task, events = [], { workerLabel = task.worker, workspaceName = '' } = {}) {
  const facts = [];
  facts.push(`交给「${workerLabel}」Worker 执行${workspaceName ? `，工作区「${workspaceName}」` : ''}。`);
  for (const e of events) {
    if (e.type === 'task/edited' && e.data?.from?.worker && e.data?.to?.worker) {
      facts.push(`（最初派给了「${e.data.from.worker}」，你改成了「${e.data.to.worker}」。）`);
    }
    if (e.type === 'approval/resolved' && e.data?.option && !HOST_APPROVALS.has(e.data?.kind)) {
      const asked = events.find((x) => x.type === 'task/waiting_approval' && x.data?.approvalId === e.data.approvalId);
      facts.push(`遇到「${asked?.data?.question || '需要确认的问题'}」时，选「${e.data.option}」。`);
    }
  }
  const result = String(task.result || '').split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
  if (result) facts.push(`上次的产出：${result.length > 120 ? `${result.slice(0, 120)}…` : result}`);
  return facts;
}

async function summarizeWithModel(task, facts) {
  const system = [
    '你是静静的流程整理员。根据一次已经完成的任务，总结一个以后遇到同类请求可以直接照做的工作流程。',
    '只输出 JSON：{"name":"不超过 16 字的流程名","when":"识别同类请求的关键词，2-5 个，用 | 分隔，不要太宽泛","steps":["步骤1","步骤2"]}',
    '步骤 3-7 条，写成给执行者的具体指令（祈使句），不要写成过去发生的经过；保留用户做过的选择和偏好。'
  ].join('\n');
  const content = [
    `用户原话：${String(task.prompt || '').slice(0, 1500)}`,
    `任务名：${task.title}`,
    '经过：',
    ...facts.map((f) => `- ${f}`),
    '',
    `结果（节选）：${String(task.result || '').slice(0, 1500)}`
  ].join('\n');
  const res = await chat({ system, messages: [{ role: 'user', content }], json: true, temperature: 0.2, maxTokens: 700 });
  const text = res.text || '';
  const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const steps = Array.isArray(parsed.steps) ? parsed.steps.map(String).filter(Boolean).slice(0, 10) : [];
  if (!parsed.name || !steps.length) throw new Error('模型没有给出完整的流程');
  return { name: String(parsed.name).slice(0, 30), when: String(parsed.when || ''), steps };
}

/**
 * 把一次完成的任务总结成候选习惯，写到 learned/ 目录。
 * 返回 { workflow } ；同类请求已经有流程（含已忽略的）时返回 { skipped }。
 */
export async function learnFromTask(task, events = [], { workerLabel, workspaceName = '', force = false } = {}) {
  const existing = matchWorkflow(task.prompt, { workflows: all({ fresh: true }), includeInactive: true });
  if (existing && !force) return { skipped: `已有同类流程「${existing.workflow.name}」` };

  const facts = taskFacts(task, events, { workerLabel, workspaceName });
  let draft = null;
  if (llmMode() !== 'demo') {
    try { draft = await summarizeWithModel(task, facts); } catch (err) { console.warn('[workflow] 模型总结失败，改用模板：', err.message); }
  }
  const core = corePhrase(task.title || task.prompt);
  let when = draft?.when || '';
  // 触发词至少要能认出这次任务本身，否则退回到标题里的核心短语。
  if (!when || compileTrigger(when).error || !compileTrigger(when).trigger.test(task.prompt)) when = core;
  const name = draft?.name || makeTitle(task.title || task.prompt).slice(0, 24) || core;
  const steps = draft?.steps?.length
    ? draft.steps.map((step, i) => `${i + 1}. ${step.replace(/^\d+[.、]\s*/, '')}`).join('\n')
    : facts.map((fact, i) => `${i + 1}. ${fact}`).join('\n');

  // 记下这次每个拍板问题的选择，开启自动拍板后可以照着回答。
  const answers = events
    .filter((e) => e.type === 'approval/resolved' && e.data?.option && !HOST_APPROVALS.has(e.data?.kind))
    .map((e) => {
      const asked = events.find((x) => x.type === 'task/waiting_approval' && x.data?.approvalId === e.data.approvalId);
      return asked?.data?.question ? `${generalizeQuestion(asked.data.question)} => ${String(e.data.option).replace(/;/g, '，')}` : '';
    })
    .filter(Boolean)
    .join('; ');
  // 学流程时不把「默认工作区」写死进去：否则以后同类请求都会被拉回默认目录，
  // 连主人文字里点名的工作区也会被流程覆盖。只有确实用了别的工作区才记下来。
  const settings = getSettings();
  const defaultWorkspace = (settings.workspaces || []).find((w) => w.id === settings.defaultWorkspaceId);
  const learnedWorkspace = workspaceName && defaultWorkspace?.name !== workspaceName ? workspaceName : '';

  const file = uniqueFile(LEARNED_DIR, name);
  const header = frontmatter({
    name,
    when,
    worker: task.worker,
    workspace: learnedWorkspace,
    auto: answers ? 'false' : '',
    answers,
    status: 'candidate',
    source: 'learned',
    learned_from: task.id,
    learned_at: now()
  });
  const note = `<!-- 静静根据任务「${String(task.title).replace(/--/g, '—')}」总结的处理流程。确认后，同类请求会自动按它派活和执行；可以直接改这个文件。 -->`;
  const workflow = writeAndReload(file, `${header}\n${note}\n\n${steps}\n`);
  return { workflow: publicWorkflow(workflow) };
}

import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_API_VERSION = 1;
export const FIELD_TYPES = ['text', 'url', 'password', 'number', 'checkbox', 'textarea', 'select'];
export const PLUGIN_TYPES = ['poll', 'webhook', 'stream', 'manual', 'watch'];
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_FIELDS = 40;

export class PluginSpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginSpecError';
    this.code = 'PLUGIN_SPEC';
    this.statusCode = 400;
  }
}

function bad(message) {
  throw new PluginSpecError(message);
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

const FIELD_KEYS = new Set(['key', 'label', 'type', 'default', 'placeholder', 'help', 'required', 'wide', 'min', 'max', 'options']);
const MANIFEST_KEYS = new Set(['$schema', 'id', 'apiVersion', 'kind', 'name', 'version', 'description', 'icon', 'entry', 'type', 'intervalMinutes', 'webhook', 'lifecycle', 'multiInstance', 'capabilities', 'config', 'worker']);

/**
 * Worker 能力词表。Router 只按能力挑 Worker，不认具体 id：
 * - text：纯文本问答 / 写作
 * - write-file：在任务工作区里生成文件
 * - manage-files：整理、移动、归档文件
 * - code：读写代码仓库、执行命令、操作 git
 * - memory：整理静静的记忆库
 */
// 记忆不是 Worker 的能力：记住、检索、整理都是静静内置的功能。
export const WORKER_ABILITIES = ['text', 'write-file', 'manage-files', 'code'];
export const WORKER_LIMIT_RANGES = {
  timeoutMinutes: { min: 1, max: 1440, label: '超时（分钟）' },
  concurrency: { min: 1, max: 4, label: '最多同时运行' },
  retries: { min: 0, max: 3, label: '失败自动重试次数' }
};
/**
 * 服务重启打断执行时怎么恢复：
 * - resume：Worker 存过断点（ctx.checkpoint）就带着断点接着跑，没有断点按 ask 处理；
 * - restart：重跑是安全的（只读、或结果可覆盖），直接重新执行；
 * - ask：可能已经改了一半，先问用户「重新执行 / 放弃」。
 */
export const WORKER_RECOVERY = ['resume', 'restart', 'ask'];
export const WORKER_DEFAULTS = Object.freeze({
  abilities: ['text'],
  cost: 3,
  keywords: '',
  aliases: [],
  capabilities: [],
  recovery: 'ask',
  timeoutMinutes: 30,
  concurrency: 2,
  retries: 0
});
const WORKER_KEYS = new Set(['abilities', 'cost', 'keywords', 'aliases', 'capabilities', 'recovery', ...Object.keys(WORKER_LIMIT_RANGES)]);
const CAPABILITY_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function intInRange(value, { min, max }, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) bad(`${label} 必须是 ${min}–${max} 的整数`);
  return number;
}

/** 校验 manifest 里的 worker 段：能力、开销、关键词和运行限制。 */
export function validateWorkerBlock(raw) {
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('worker 必须是对象');
  for (const key of Object.keys(raw)) {
    if (!WORKER_KEYS.has(key)) bad(`worker 有未知字段：${key}`);
  }
  let abilities = WORKER_DEFAULTS.abilities;
  if (raw.abilities !== undefined) {
    if (!Array.isArray(raw.abilities) || !raw.abilities.length) bad('worker.abilities 必须是非空数组');
    for (const ability of raw.abilities) {
      if (!WORKER_ABILITIES.includes(ability)) {
        bad(`worker.abilities 不支持：${ability}（可选 ${WORKER_ABILITIES.join(' / ')}）`);
      }
    }
    abilities = [...new Set(raw.abilities)];
  }
  const keywords = raw.keywords === undefined ? '' : raw.keywords;
  if (typeof keywords !== 'string' || keywords.length > 300) bad('worker.keywords 必须是不超过 300 字符的正则字符串');
  if (keywords) {
    try { new RegExp(keywords, 'i'); } catch (err) { bad(`worker.keywords 不是合法正则：${err.message}`); }
  }
  const aliases = raw.aliases === undefined ? [] : raw.aliases;
  if (!Array.isArray(aliases) || aliases.length > 8) bad('worker.aliases 必须是最多 8 个的数组');
  const cleanAliases = [];
  for (const alias of aliases) {
    if (typeof alias !== 'string') bad('worker.aliases 的每一项必须是字符串');
    const value = alias.trim();
    if (!value || value.length > 30) bad('worker.aliases 的每一项必须是 1–30 个字符');
    if (!cleanAliases.includes(value)) cleanAliases.push(value);
  }
  const capabilities = raw.capabilities === undefined ? [] : raw.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length > 20) bad('worker.capabilities 必须是最多 20 个的数组');
  const cleanCapabilities = [];
  for (const id of capabilities) {
    const value = String(id || '').trim().toLowerCase();
    if (!CAPABILITY_ID_RE.test(value)) bad(`worker.capabilities 里的 id 不合法：${id}`);
    if (!cleanCapabilities.includes(value)) cleanCapabilities.push(value);
  }
  const recovery = raw.recovery === undefined ? WORKER_DEFAULTS.recovery : raw.recovery;
  if (!WORKER_RECOVERY.includes(recovery)) bad(`worker.recovery 只能是 ${WORKER_RECOVERY.join(' / ')}`);
  const out = {
    abilities,
    cost: raw.cost === undefined ? WORKER_DEFAULTS.cost : intInRange(raw.cost, { min: 1, max: 5 }, 'worker.cost'),
    keywords,
    aliases: cleanAliases,
    capabilities: cleanCapabilities,
    recovery
  };
  for (const [key, range] of Object.entries(WORKER_LIMIT_RANGES)) {
    out[key] = raw[key] === undefined ? WORKER_DEFAULTS[key] : intInRange(raw[key], range, `worker.${key}`);
  }
  return out;
}

/** 校验本机对 Worker 运行限制的覆盖值；空值表示沿用 manifest 默认。 */
export function validateWorkerLimits(raw = {}) {
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) bad('limits 必须是对象');
  const out = {};
  for (const [key, range] of Object.entries(WORKER_LIMIT_RANGES)) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    out[key] = intInRange(value, range, range.label);
  }
  return out;
}

function validateField(field, index) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    bad(`config[${index}] 必须是对象`);
  }
  for (const key of Object.keys(field)) {
    if (!FIELD_KEYS.has(key)) bad(`config[${index}] 有未知字段：${key}`);
  }
  const key = asString(field.key).trim();
  if (!KEY_RE.test(key)) {
    bad(`config[${index}].key 不合法：只允许字母开头，字母/数字/下划线，最多 40 字符`);
  }
  const label = asString(field.label).trim();
  if (!label) bad(`config.${key} 缺少 label`);
  const type = asString(field.type, 'text').trim();
  if (!FIELD_TYPES.includes(type)) {
    bad(`config.${key} 的 type 不支持：${type}（可选 ${FIELD_TYPES.join(' / ')}）`);
  }
  const out = {
    key,
    label: label.slice(0, 60),
    type,
    placeholder: asString(field.placeholder).slice(0, 200),
    help: asString(field.help).slice(0, 300),
    required: Boolean(field.required)
  };
  if (field.wide === true) out.wide = true;

  if (type === 'number') {
    const min = field.min === undefined ? undefined : Number(field.min);
    const max = field.max === undefined ? undefined : Number(field.max);
    if (min !== undefined && !Number.isFinite(min)) bad(`config.${key}.min 必须是数字`);
    if (max !== undefined && !Number.isFinite(max)) bad(`config.${key}.max 必须是数字`);
    if (min !== undefined && max !== undefined && min > max) bad(`config.${key} 的 min 不能大于 max`);
    if (min !== undefined) out.min = min;
    if (max !== undefined) out.max = max;
    if (field.default !== undefined) {
      const value = Number(field.default);
      if (!Number.isFinite(value)) bad(`config.${key}.default 必须是数字`);
      if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
        bad(`config.${key}.default 超出 min/max`);
      }
      out.default = value;
    }
  } else if (type === 'checkbox') {
    out.default = field.default === undefined ? false : Boolean(field.default);
  } else if (type === 'select') {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      bad(`config.${key} 是 select，必须提供非空 options`);
    }
    out.options = field.options.map((option) => {
      if (!option || typeof option !== 'object' || option.value === undefined) {
        bad(`config.${key}.options 每项都需要 value/label`);
      }
      return { value: String(option.value), label: String(option.label || option.value) };
    });
    const values = out.options.map((option) => option.value);
    if (field.default !== undefined && !values.includes(String(field.default))) {
      bad(`config.${key}.default 不在 options 里`);
    }
    out.default = field.default === undefined ? values[0] : String(field.default);
  } else {
    if (field.default !== undefined && typeof field.default !== 'string') {
      bad(`config.${key}.default 必须是字符串`);
    }
    out.default = asString(field.default);
  }
  return out;
}

export function validateManifest(raw, { dir, dirName } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('plugin.json 必须是对象');
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_KEYS.has(key)) bad(`plugin.json 有未知字段：${key}`);
  }
  const id = asString(raw.id).trim();
  if (!ID_RE.test(id)) bad('id 只能是小写字母/数字/短横线，2–32 位，且不能以短横线开头');
  if (dirName && id !== dirName) bad(`目录名「${dirName}」必须和 id「${id}」一致`);

  const name = asString(raw.name).trim();
  if (!name) bad('缺少 name');
  const entry = asString(raw.entry).trim();
  if (!entry) bad('缺少 entry');
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
    bad('entry 必须是插件目录内的相对路径');
  }

  if (dir) {
    const entryPath = path.resolve(dir, entry);
    const root = path.resolve(dir) + path.sep;
    if (!entryPath.startsWith(root)) bad('entry 越出了插件目录');
    if (!fs.existsSync(entryPath)) bad(`入口文件不存在：${entry}`);
  }

  const apiVersion = raw.apiVersion === undefined ? PLUGIN_API_VERSION : Number(raw.apiVersion);
  if (!Number.isInteger(apiVersion) || apiVersion < 1) bad('apiVersion 必须是正整数');
  if (apiVersion > PLUGIN_API_VERSION) {
    bad(`插件要求 apiVersion ${apiVersion}，当前核心只支持 ${PLUGIN_API_VERSION}`);
  }

  if (raw.webhook !== undefined && typeof raw.webhook !== 'boolean') bad('webhook 必须是布尔值');
  if (raw.lifecycle !== undefined && typeof raw.lifecycle !== 'boolean') bad('lifecycle 必须是布尔值');
  if (raw.multiInstance !== undefined && typeof raw.multiInstance !== 'boolean') bad('multiInstance 必须是布尔值');
  if (raw.kind !== undefined && !['source', 'worker'].includes(raw.kind)) bad('kind 只能是 source 或 worker');
  const kind = raw.kind === 'worker' ? 'worker' : 'source';
  if (kind !== 'worker' && raw.worker !== undefined) bad('只有 kind 为 worker 的插件才能写 worker 段');
  const legacyType = raw.webhook === true ? 'webhook' : raw.lifecycle === true ? 'stream' : 'poll';
  const type = raw.type === undefined ? legacyType : String(raw.type);
  if (!PLUGIN_TYPES.includes(type)) bad(`type 不支持：${type}（可选 ${PLUGIN_TYPES.join(' / ')}）`);
  const intervalMinutes = raw.intervalMinutes === undefined ? 30 : Number(raw.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    bad('intervalMinutes 必须是 1–1440 的整数');
  }

  if (!Array.isArray(raw.config || [])) bad('config 必须是数组');
  const fields = raw.config || [];
  if (fields.length > MAX_FIELDS) bad(`config 最多 ${MAX_FIELDS} 个字段`);
  const config = fields.map(validateField);
  const keys = new Set();
  for (const field of config) {
    if (keys.has(field.key)) bad(`config 字段重复：${field.key}`);
    keys.add(field.key);
  }

  const capabilities = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  for (const key of Object.keys(capabilities)) {
    if (!['network', 'read', 'write'].includes(key)) bad(`capabilities 有未知字段：${key}`);
    if (typeof capabilities[key] !== 'boolean') bad(`capabilities.${key} 必须是布尔值`);
  }

  const manifest = {
    id,
    apiVersion,
    name: name.slice(0, 60),
    version: asString(raw.version, '0.0.0').slice(0, 24),
    description: asString(raw.description).slice(0, 500),
    icon: asString(raw.icon, '插').slice(0, 8),
    entry,
    kind,
    type,
    intervalMinutes,
    webhook: type === 'webhook',
    lifecycle: type === 'stream',
    multiInstance: raw.multiInstance === true,
    capabilities: {
      network: Boolean(capabilities.network),
      read: Boolean(capabilities.read),
      write: Boolean(capabilities.write)
    },
    config
  };
  if (kind === 'worker') manifest.worker = validateWorkerBlock(raw.worker);
  return manifest;
}

function coerceValue(field, value) {
  if (field.type === 'checkbox') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    bad(`config.${field.key} 必须是布尔值`);
  }

  if (field.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) bad(`config.${field.key} 必须是数字`);
    if (field.min !== undefined && number < field.min) bad(`config.${field.key} 不能小于 ${field.min}`);
    if (field.max !== undefined && number > field.max) bad(`config.${field.key} 不能大于 ${field.max}`);
    return number;
  }

  if (field.type === 'select') {
    const text = String(value);
    if (!field.options.some((option) => option.value === text)) {
      bad(`config.${field.key} 不是可选值：${text}`);
    }
    return text;
  }

  const text = String(value ?? '');
  if (text.length > 10000) bad(`config.${field.key} 太长（最多 10000 字符）`);
  if (field.type === 'url' && text) {
    let url;
    try { url = new URL(text); } catch { bad(`config.${field.key} 不是合法 URL`); }
    if (!['http:', 'https:'].includes(url.protocol)) bad(`config.${field.key} 只支持 http/https`);
  }
  return text;
}

/**
 * 校验并归一化一份完整配置。
 * requireAll=true 时要求所有 required 字段非空（启用插件时使用）。
 */
export function validateConfig(manifest, raw = {}, { requireAll = false } = {}) {
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) bad('config 必须是对象');
  const out = {};
  for (const field of manifest.config || []) {
    const supplied = Object.prototype.hasOwnProperty.call(raw, field.key);
    const value = supplied ? raw[field.key] : undefined;
    const empty = value === undefined || value === null || value === '';
    if (empty) {
      if (requireAll && field.required) bad(`缺少必填配置：${field.label || field.key}`);
      out[field.key] = field.default;
      continue;
    }
    out[field.key] = coerceValue(field, value);
  }
  return out;
}

export function requiredFields(manifest) {
  return (manifest.config || []).filter((field) => field.required).map((field) => field.key);
}

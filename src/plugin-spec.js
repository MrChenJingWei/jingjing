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
const MANIFEST_KEYS = new Set(['$schema', 'id', 'apiVersion', 'kind', 'name', 'version', 'description', 'icon', 'entry', 'type', 'intervalMinutes', 'webhook', 'lifecycle', 'multiInstance', 'capabilities', 'config']);

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

  return {
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

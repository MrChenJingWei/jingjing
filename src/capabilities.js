import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTerm } from './routing-signals.js';

const CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'capabilities.json');

/**
 * 能力目录：给人看的工具/领域能力，和 Worker 声明的能力 id 对应。
 *
 * - hostTool=true：需要本机装了对应命令行工具（tapd-cli、gh、docker…）；
 *   没有 Worker 显式声明时，具备 shell 能力（能执行本机命令）的 Worker 作为候选。
 * - 自定义能力存在 settings.capabilities，和内置目录合并。
 */

export const SHELL_CAPABILITY = 'shell';

// 能力目录是数据，不是代码：厂商/工具名放在 capabilities.json 里，核心不认识任何具体来源。
export const BUILTIN_CAPABILITIES = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function cleanCustom(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').trim().toLowerCase();
  const label = String(item.label || '').trim().slice(0, 40);
  const keywords = Array.isArray(item.keywords)
    ? item.keywords.map((k) => String(k || '').trim().slice(0, 40)).filter(Boolean).slice(0, 12)
    : [];
  if (!ID_RE.test(id) || !label || !keywords.length) return null;
  return {
    id,
    label,
    keywords,
    description: String(item.description || '').trim().slice(0, 200),
    risk: ['read', 'write', 'deploy'].includes(item.risk) ? item.risk : 'write',
    hostTool: Boolean(item.hostTool),
    custom: true
  };
}

/** 内置 + 用户自定义能力；同 id 时内置优先。 */
export function capabilityCatalog(settings = {}) {
  const seen = new Set(BUILTIN_CAPABILITIES.map((item) => item.id));
  const out = BUILTIN_CAPABILITIES.map((item) => ({ ...item }));
  for (const raw of Array.isArray(settings.capabilities) ? settings.capabilities : []) {
    const item = cleanCustom(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function capabilityById(id, catalog = capabilityCatalog({})) {
  return catalog.find((item) => item.id === id) || null;
}

/** 一段话命中了哪些能力 id（保持目录顺序）。 */
export function matchCapabilities(text, catalog = capabilityCatalog({})) {
  const hits = [];
  for (const item of catalog) {
    if (!Array.isArray(item.keywords) || !item.keywords.length) continue;
    if (item.keywords.some((keyword) => matchKeyword(text, keyword))) hits.push(item.id);
  }
  return hits;
}

function matchKeyword(text, keyword) {
  return matchTerm(text, keyword);
}

/** 过滤出目录里存在的能力 id，去重、限长。 */
export function normalizeCapabilityIds(value, catalog = capabilityCatalog({}), max = 20) {
  const raw = Array.isArray(value) ? value : [];
  const known = new Set(catalog.map((item) => item.id));
  const out = [];
  for (const id of raw) {
    const key = String(id || '').trim().toLowerCase();
    if (!known.has(key) || out.includes(key)) continue;
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

export function capabilityLabels(ids = [], catalog = capabilityCatalog({})) {
  const byId = new Map(catalog.map((item) => [item.id, item.label]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * 能力 → 候选 Worker。
 * 先找显式声明了全部能力的 Worker；一个都没有时，hostTool 能力回退到具备 shell 能力的 Worker
 * （它们能执行本机命令，装了工具就能用）。
 */
export function candidatesForCapabilities(ids, workers = [], catalog = capabilityCatalog({})) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return { workers: [], fallback: false };
  const usable = workers.filter((worker) => worker.available !== false);
  const hasAll = (worker) => wanted.every((id) => (worker.capabilities || []).includes(id));
  const direct = usable.filter(hasAll);
  if (direct.length) return { workers: direct, fallback: false };
  const hostTool = wanted.some((id) => capabilityById(id, catalog)?.hostTool);
  if (!hostTool) return { workers: [], fallback: false };
  const shell = usable.filter((worker) => (worker.capabilities || []).includes(SHELL_CAPABILITY));
  return { workers: shell, fallback: shell.length > 0 };
}

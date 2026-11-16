import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 当前代码根目录（打包后在 .app 内的 Resources/app，从数据目录热更新时在 updates 下）。 */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 读取某个目录 package.json 里的版本号。 */
export function readVersion(dir = APP_ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const version = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
    return version || null;
  } catch {
    return null;
  }
}

/** 版本号唯一来源：package.json。缺省时退回 0.0.0，避免启动失败。 */
export const VERSION = readVersion() || '0.0.0';

export function normalizeVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '');
  return /^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(text) ? text : null;
}

function splitVersion(value) {
  const text = normalizeVersion(value);
  if (!text) return null;
  const coreAndPre = text.split('+')[0];
  const dash = coreAndPre.indexOf('-');
  const core = dash === -1 ? coreAndPre : coreAndPre.slice(0, dash);
  const pre = dash === -1 ? '' : coreAndPre.slice(dash + 1);
  return { core: core.split('.').map((part) => Number(part) || 0), pre };
}

function comparePrerelease(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const a = left.split('.');
  const b = right.split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff) return diff > 0 ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** 语义化版本比较：a > b 返回 1，相等 0，小于 -1。非法版本按相等处理。 */
export function compareVersions(a, b) {
  const left = splitVersion(a);
  const right = splitVersion(b);
  if (!left || !right) return 0;
  const length = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left.core[i] || 0) - (right.core[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return comparePrerelease(left.pre, right.pre);
}

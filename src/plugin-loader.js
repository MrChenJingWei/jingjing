/**
 * 在主线程里加载插件入口，保证插件改过以后重新加载拿到的是新代码。
 *
 * ESM 模块按 URL 缓存。只给入口加 ?v= 不够：入口里 import './imap.js' 这种相对路径解析出来
 * 不带查询参数，还是旧的缓存，多文件插件（邮箱、日历……）重装后子文件要重启才生效。
 * 这里给入口加上「整个插件目录的版本号」，再用模块钩子把它传给入口相对引用的每个文件。
 * 插件线程（worker-thread.js）每次都是新线程、没有缓存，不需要这一套。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as nodeModule from 'node:module';

const PARAM = 'jjv';
const RELATIVE = /^\.\.?\//;

/** 当前 Node 支持同步模块钩子（23.5+）时，子文件也会跟着刷新。 */
export const reloadsSubmodules = typeof nodeModule.registerHooks === 'function';

if (reloadsSubmodules) {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      const parent = context.parentURL;
      if (!parent || !RELATIVE.test(specifier) || !result.url?.startsWith('file:') || !parent.includes(`${PARAM}=`)) return result;
      const version = new URL(parent).searchParams.get(PARAM);
      if (!version) return result;
      const url = new URL(result.url);
      url.searchParams.set(PARAM, version);
      return { ...result, url: url.href };
    }
  });
}

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) {
      const stat = fs.statSync(full);
      out.push(`${path.relative(base, full)}:${stat.size}:${stat.mtimeMs}`);
    }
  }
}

/** 插件目录的版本号：任何一个文件改了（大小或修改时间变了），版本号就变。 */
export function dirVersion(dir) {
  const lines = [];
  walk(dir, dir, lines);
  return crypto.createHash('sha1').update(lines.sort().join('\n')).digest('hex').slice(0, 16);
}

let warned = false;

/** 加载插件入口：目录没变就复用缓存，变了就连同子文件一起重新加载。 */
export async function importPluginEntry(dir, entry) {
  const url = pathToFileURL(path.join(dir, entry));
  url.searchParams.set(PARAM, dirVersion(dir));
  if (!reloadsSubmodules && !warned) {
    warned = true;
    console.warn('[plugin] 当前 Node 版本不支持模块钩子：插件入口以外的文件改动要重启静静后才生效（升级到 Node 23.5+ 可解决）');
  }
  return import(url.href);
}

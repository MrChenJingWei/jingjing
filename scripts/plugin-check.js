#!/usr/bin/env node
/**
 * 校验插件清单与入口：数据目录（或仓库 plugins/）里的插件，以及仓库 workers/ 里的内置 Worker。
 * 用法：npm run plugin:check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest, validateConfig, PLUGIN_API_VERSION } from '../src/plugin-spec.js';
import { DATA_DIR } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_DIR = path.join(DATA_DIR, 'plugins');
const userDirs = fs.existsSync(USER_DIR)
  ? fs.readdirSync(USER_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  : [];
const ROOTS = [
  userDirs.length ? { dir: USER_DIR, label: '插件' } : { dir: path.join(ROOT, 'plugins'), label: '插件' },
  { dir: path.join(ROOT, 'workers'), label: '内置Worker', workerOnly: true }
];
const errors = [];
const ok = [];
const seen = new Map();

for (const root of ROOTS) {
  if (!fs.existsSync(root.dir)) continue;
  const dirs = fs.readdirSync(root.dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
  for (const name of dirs) {
    const dir = path.join(root.dir, name);
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      errors.push({ plugin: `${root.label}/${name}`, error: '缺少 plugin.json' });
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const manifest = validateManifest(raw, { dir, dirName: name });
      if (seen.has(manifest.id)) {
        throw new Error(`id「${manifest.id}」与 ${seen.get(manifest.id)} 重复`);
      }
      seen.set(manifest.id, `${root.label}/${name}`);
      const module = await import(`${pathToFileURL(path.join(dir, manifest.entry)).href}?v=${Date.now()}`);
      if (root.workerOnly && manifest.kind !== 'worker') throw new Error('workers/ 下只能放 kind 为 worker 的插件');
      if (manifest.kind === 'worker') {
        if (typeof module.execute !== 'function') throw new Error('Worker 入口没有导出 execute()');
        if (module.detect !== undefined && typeof module.detect !== 'function') throw new Error('detect 必须是一个函数');
      } else {
        if (typeof module.poll !== 'function') throw new Error('入口没有导出 poll()');
        if (manifest.webhook && typeof module.webhook !== 'function') throw new Error('声明了 webhook 但没有导出 webhook()');
        if (manifest.lifecycle && typeof module.start !== 'function') throw new Error('声明了 lifecycle 但没有导出 start()');
      }
      if (module.test !== undefined && typeof module.test !== 'function') throw new Error('test 必须是一个函数');
      validateConfig(manifest, {}, { requireAll: false });
      ok.push(`${name}  ${manifest.name} v${manifest.version}`);
      const extra = manifest.worker ? `  [${manifest.worker.abilities.join(', ')}]` : '';
      console.log(`✓ ${(root.label + '/' + name).padEnd(22)} ${manifest.name} v${manifest.version}${extra}`);
    } catch (err) {
      errors.push({ plugin: `${root.label}/${name}`, error: err.message });
      console.error(`✗ ${(root.label + '/' + name).padEnd(22)} ${err.message}`);
    }
  }
}

console.log('');
console.log(`插件 API v${PLUGIN_API_VERSION} · 通过 ${ok.length} 个，失败 ${errors.length} 个`);

if (errors.length) {
  console.error('规范检查未通过。修复 plugin.json 或入口后重试。');
  process.exitCode = 1;
}

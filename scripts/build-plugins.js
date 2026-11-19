#!/usr/bin/env node
/**
 * 构建带 npm 依赖的官方插件：plugin-src/<id>/ → plugins/<id>/（单文件，用户机器上不需要 npm install）。
 *
 *   npm run plugins:build             构建全部（需要联网：npm ci + esbuild）
 *   npm run plugins:build -- wecom    只构建某几个
 *   npm run plugins:check-built       只检查 plugins/ 里的产物是否和源码一致（CI 用，不联网）
 *
 * 不需要依赖的插件直接放在 plugins/<id>/ 维护，不经过这里。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../src/plugin-spec.js';
import { findCommand, resolveSpawn } from '../src/worker-runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'plugin-src');
const OUT = path.join(ROOT, 'plugins');
const ESBUILD = 'esbuild@0.24.2';
// 可选的原生加速包，缺了库会自己降级（比如 ws 的 bufferutil）。
const OPTIONAL_EXTERNALS = ['bufferutil', 'utf-8-validate'];
// 打成 ESM 后，依赖里的 require() 需要一个真正的 require。
const BANNER = "import { createRequire as __jjCreateRequire } from 'node:module'; const require = __jjCreateRequire(import.meta.url);";

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.filter((arg) => !arg.startsWith('--'));

function sourceFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.DS_Store'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, base));
    // 统一用 / 分隔：Windows 上算出来的指纹要和 macOS / Linux 上的一样。
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** 源码指纹：文件名 + 内容（不含 node_modules），产物里记下它，CI 据此判断是否过期。 */
function sourceHash(dir) {
  const hash = crypto.createHash('sha256');
  for (const file of sourceFiles(dir)) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(dir, file)));
  }
  return hash.digest('hex');
}

function run(cmd, cmdArgs, cwd) {
  // Windows 上 npm / npx 是 .cmd，resolveSpawn 会改成经过 cmd.exe 跑（参数按 cmd 的规则转义）。
  const target = resolveSpawn(findCommand(cmd) || cmd, cmdArgs);
  execFileSync(target.cmd, target.args, { cwd, stdio: 'inherit', ...target.options });
}

const names = fs.existsSync(SRC)
  ? fs.readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  : [];
const targets = only.length ? names.filter((name) => only.includes(name)) : names;
let failed = 0;

for (const name of targets) {
  const dir = path.join(SRC, name);
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir, dirName: name });
  const outDir = path.join(OUT, manifest.id);
  const hash = sourceHash(dir);

  if (checkOnly) {
    let built = null;
    try { built = JSON.parse(fs.readFileSync(path.join(outDir, 'BUILD.json'), 'utf8')); } catch { /* 没构建过 */ }
    if (built?.sourceHash === hash) {
      console.log(`✓ ${name} 产物是最新的`);
    } else {
      console.error(`✗ ${name} 的产物过期或不存在，请运行 npm run plugins:build -- ${name} 并提交 plugins/${manifest.id}/`);
      failed += 1;
    }
    continue;
  }

  console.log(`==> 构建 ${name}（${manifest.name} v${manifest.version}）`);
  const pkg = fs.existsSync(path.join(dir, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) : {};
  if (Object.keys(pkg.dependencies || {}).length) {
    run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], dir);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  run('npx', [
    '--yes', ESBUILD,
    path.join(dir, manifest.entry),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node22',
    '--legal-comments=eof',
    ...OPTIONAL_EXTERNALS.map((pkgName) => `--external:${pkgName}`),
    `--banner:js=${BANNER}`,
    `--outfile=${path.join(outDir, manifest.entry)}`
  ], ROOT);
  fs.copyFileSync(path.join(dir, 'plugin.json'), path.join(outDir, 'plugin.json'));
  for (const extra of ['README.md']) {
    if (fs.existsSync(path.join(dir, extra))) fs.copyFileSync(path.join(dir, extra), path.join(outDir, extra));
  }
  fs.writeFileSync(path.join(outDir, 'BUILD.json'), `${JSON.stringify({
    source: `plugin-src/${name}`,
    sourceHash: hash,
    builtWith: ESBUILD,
    note: '这个目录是构建产物，不要直接改；改 plugin-src/ 后重新运行 npm run plugins:build'
  }, null, 2)}\n`);
  // 产物必须能被加载器读通。
  validateManifest(JSON.parse(fs.readFileSync(path.join(outDir, 'plugin.json'), 'utf8')), { dir: outDir, dirName: manifest.id });
  console.log(`✓ ${name} → plugins/${manifest.id}/`);
}

if (failed) process.exitCode = 1;

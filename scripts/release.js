#!/usr/bin/env node
/**
 * 发版：改版本号 → 提交 → 打 tag → 推送，剩下的交给 GitHub Actions。
 *
 *   npm run release -- 0.7.1 --notes "v0.7.1 修复：设置页模型下拉在窄窗口被截断"
 *
 * 选项：
 *   --notes <text>  更新说明，会显示在用户的「关于与更新」里（默认 vX.Y.Z）
 *   --yes           跳过确认
 *   --dry-run       只打印计划，不改文件、不提交
 *   --no-push       只在本机提交和打 tag，不推送（排练用）
 *   --skip-tests    跳过发版前的 npm test
 *   --ui            强制刷新 service worker 缓存版本（改了前端资源时用）
 *
 * 这个脚本只管到 tag 推送为止；Release 由 .github/workflows/release.yml 在 tag 上生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { compareVersions, normalizeVersion } from '../src/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const PLIST_PATH = path.join(ROOT, 'packaging/macos/Info.plist');
const SW_PATH = path.join(ROOT, 'public/sw.js');
const INDEX_PATH = path.join(ROOT, 'public/index.html');

const flags = new Set();
let notes = '';
let versionArg = '';

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--notes') {
    notes = argv[i + 1] || '';
    i += 1;
  } else if (arg === '--yes') {
    flags.add('yes');
  } else if (arg === '--dry-run') {
    flags.add('dry-run');
  } else if (arg === '--no-push') {
    flags.add('no-push');
  } else if (arg === '--skip-tests') {
    flags.add('skip-tests');
  } else if (arg === '--ui') {
    flags.add('ui');
  } else if (arg === '--help' || arg === '-h') {
    flags.add('help');
  } else if (arg.startsWith('-')) {
    fail(`不认识的参数：${arg}（用 --help 看用法）`);
  } else {
    versionArg = arg;
  }
}

if (flags.has('help')) {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const header = source.match(/\/\*\*([\s\S]*?)\*\//)?.[1] || '';
  console.log(header.split('\n').map((line) => line.replace(/^\s*\* ?/, '')).join('\n').trim());
  process.exit(0);
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n==> ${message}`);
}

function detail(message) {
  console.log(`    ${message}`);
}

/** 跑一条命令并返回输出；失败时把 stderr 一起带出来。 */
function run(command, args, { inherit = false, allowFail = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
  });
  if (result.error) {
    if (allowFail) return { ok: false, stdout: '', stderr: result.error.message };
    fail(`执行 ${command} 失败：${result.error.message}`);
  }
  const ok = result.status === 0;
  if (!ok && !allowFail) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    fail(`${command} ${args.join(' ')} 失败${output ? `：\n${output}` : ''}`);
  }
  return { ok, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

const git = (...args) => run('git', args).stdout;
const gitOk = (...args) => run('git', args, { allowFail: true }).ok;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readPlistVersion(plist) {
  return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/)?.[1] || '';
}

function readBuildNumber(plist) {
  return Number(plist.match(/<key>CFBundleVersion<\/key>\s*<string>(\d+)<\/string>/)?.[1] || 0);
}

function todayStamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

/** 前端资源有改动时，把 service worker 缓存和 index.html 的资源版本一起往前推。 */
function nextAssetVersion(current) {
  const stamp = todayStamp();
  const match = current.match(/^(\d{8})-(\d+)$/);
  if (!match) return `${stamp}-1`;
  if (match[1] === stamp) return `${stamp}-${Number(match[2]) + 1}`;
  // 系统时间比上次发布还早：宁可继续往后加，也不要让版本倒退。
  if (Number(stamp) < Number(match[1])) return `${match[1]}-${Number(match[2]) + 1}`;
  return `${stamp}-1`;
}

/* ------------------------------ 1. 校验参数 ------------------------------ */

step('检查版本号');
const current = readJson(PKG_PATH).version;
if (!versionArg) fail('用法：npm run release -- <新版本号> [--notes "更新说明"]');
const version = normalizeVersion(versionArg);
if (!version) fail(`版本号不合法：${versionArg}（要像 0.7.1 这样）`);
if (compareVersions(version, current) <= 0) {
  fail(`新版本号必须大于当前版本 ${current}（用户只会看到更高的版本）`);
}
detail(`当前 v${current} → 发布 v${version}`);

/* ------------------------------ 2. 检查仓库 ------------------------------ */

step('检查 git 状态');
if (!gitOk('rev-parse', '--is-inside-work-tree')) fail('当前目录不是 git 仓库');
const root = git('rev-parse', '--show-toplevel');
if (path.resolve(root) !== ROOT) fail(`请在仓库根目录运行（现在在 ${root}）`);
const branch = git('symbolic-ref', '--short', 'HEAD');
if (branch !== 'main') fail(`当前分支是 ${branch}，发版请切回 main`);

// 只看已跟踪文件的改动；没跟踪的草稿（比如 docs 里的临时笔记）不影响发版，也不会被提交。
const dirty = git('status', '--porcelain', '--untracked-files=no');
if (dirty) {
  fail(`工作区有未提交的改动，先提交或清理：\n${dirty}`);
}

if (!flags.has('dry-run')) {
  step('同步远程');
  const fetched = run('git', ['fetch', 'origin', 'main', '--quiet'], { allowFail: true });
  if (!fetched.ok) {
    detail(`拉取远程失败（${fetched.stderr || '网络问题'}），继续按本地 main 发版`);
  } else if (gitOk('rev-parse', '--verify', 'origin/main')) {
    const behind = Number(git('rev-list', '--count', 'HEAD..origin/main') || 0);
    if (behind > 0) fail(`本地落后 origin/main ${behind} 个提交，先 git pull --rebase`);
  }
}

const tag = `v${version}`;
if (gitOk('rev-parse', '--verify', `refs/tags/${tag}`)) fail(`本地已经有 tag ${tag}，换一个更高的版本号`);
if (!flags.has('no-push')) {
  const remoteTag = run('git', ['ls-remote', '--tags', 'origin', tag], { allowFail: true });
  if (remoteTag.ok && remoteTag.stdout) fail(`远程已经有 tag ${tag}，不能重复发布`);
}

/* --------------------------- 3. 判断前端是否改动 --------------------------- */

step('检查前端资源有没有变');
const swSource = fs.readFileSync(SW_PATH, 'utf8');
const assetMatch = swSource.match(/const ASSET_VERSION = '([^']+)';/);
const cacheMatch = swSource.match(/const CACHE = '([^']+)';/);
if (!assetMatch || !cacheMatch) fail('public/sw.js 里找不到 ASSET_VERSION / CACHE，先修复脚本');
const lastTag = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], { allowFail: true }).stdout;
const changedPublic = lastTag
  ? git('diff', '--name-only', `${lastTag}..HEAD`, '--', 'public')
  : 'public 有改动';
const uiChanged = flags.has('ui') || Boolean(changedPublic);
const nextAsset = nextAssetVersion(assetMatch[1]);
const nextCache = Number(cacheMatch[1].match(/-v(\d+)$/)?.[1] || 0) + 1;
detail(uiChanged ? `会刷新缓存：${cacheMatch[1]} → jingjing-shell-v${nextCache}，资源版本 ${assetMatch[1]} → ${nextAsset}` : '前端资源没变，缓存版本保持不动');

/* ------------------------------- 4. 计划 ------------------------------- */

const files = [PKG_PATH, PLIST_PATH];
if (uiChanged) files.push(SW_PATH, INDEX_PATH);
const tagMessage = notes || `v${version}`;
const shortFiles = files.map((file) => path.relative(ROOT, file));

step('发版计划');
detail(`版本：${current} → ${version}`);
detail(`提交：chore: 版本升到 ${version}`);
detail(`文件：${shortFiles.join('、')}`);
detail(`tag：${tag}${flags.has('no-push') ? '（不推送）' : ''}`);
detail(`说明：${tagMessage}`);

if (flags.has('dry-run')) {
  console.log('\n--dry-run：什么都没改。\n');
  process.exit(0);
}

/* ------------------------------ 5. 跑测试 ------------------------------ */

if (!flags.has('skip-tests')) {
  step('跑测试（--skip-tests 可跳过）');
  run('npm', ['test'], { inherit: true });
}

/* ------------------------------ 6. 确认 ------------------------------ */

if (!flags.has('yes')) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`\n确认发版 v${version}？[y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    console.log('已取消，什么都没改。');
    process.exit(1);
  }
}

/* ------------------------------ 7. 改文件 ------------------------------ */

step('改版本号');
const pkg = readJson(PKG_PATH);
pkg.version = version;
fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
detail('package.json');

let plist = fs.readFileSync(PLIST_PATH, 'utf8');
const plistVersion = readPlistVersion(plist);
const build = readBuildNumber(plist);
plist = plist.replace(
  /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
  `$1${version}$2`
);
plist = plist.replace(
  /(<key>CFBundleVersion<\/key>\s*<string>)\d+(<\/string>)/,
  `$1${build + 1}$2`
);
fs.writeFileSync(PLIST_PATH, plist);
detail(`Info.plist（${plistVersion} → ${version}，Bundle ${build} → ${build + 1}）`);

if (uiChanged) {
  let sw = swSource
    .replace(/(const CACHE = ')[^']+(';)/, `$1jingjing-shell-v${nextCache}$2`)
    .replace(/(const ASSET_VERSION = ')[^']+(';)/, `$1${nextAsset}$2`);
  fs.writeFileSync(SW_PATH, sw);
  let index = fs.readFileSync(INDEX_PATH, 'utf8');
  const before = index;
  index = index.replace(new RegExp(`\\?v=${assetMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), `?v=${nextAsset}`);
  if (index === before) fail(`public/index.html 里没找到 ?v=${assetMatch[1]}，资源版本没改成`);
  fs.writeFileSync(INDEX_PATH, index);
  detail(`public/sw.js、public/index.html（资源版本 ${nextAsset}）`);
}

/* ------------------------------ 8. 提交与 tag ------------------------------ */

step('提交');
run('git', ['add', '--', ...files.map((file) => path.relative(ROOT, file))]);
run('git', ['commit', '-m', `chore: 版本升到 ${version}`], { inherit: true });

step(`打 tag ${tag}`);
run('git', ['tag', '-a', tag, '-m', tagMessage]);

if (flags.has('no-push')) {
  console.log(`\n✓ 已在本地提交并打好 ${tag}（--no-push，没有推送）。`);
  console.log('   检查没问题后可以手动推送：');
  console.log(`   git push origin main && git push origin ${tag}\n`);
  process.exit(0);
}

/* ------------------------------ 9. 推送 ------------------------------ */

step('推送 main 和 tag');
run('git', ['push', 'origin', 'main'], { inherit: true });
run('git', ['push', 'origin', tag], { inherit: true });

console.log(`\n✓ v${version} 已推送，GitHub Actions 会自动生成 Release。`);
console.log('   接下来：');
console.log('   1. 看流水线：gh run list --workflow=release');
console.log(`   2. 验收：    gh release view ${tag}`);
console.log('   3. 用户升级：设置 → 关于与更新 → 检查更新 → 重启生效');
console.log('   注意：tag 与 package.json 必须一致，CI 会校验；macOS 安装包由 macOS job 构建。\n');

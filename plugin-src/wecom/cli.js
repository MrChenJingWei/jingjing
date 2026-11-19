/**
 * 用企业微信官方命令行 wecom-cli（npm i -g @wecom/cli）查通讯录。
 * 它用智能机器人的授权（wecom-cli auth init 扫码或填 BotID / Secret），不用另建自建应用、不用配可信 IP。
 *
 * 通讯录只有按关键词搜（姓名 / 拼音 / 英文名 / 别名）：拿 userid 当关键词去搜，
 * 返回里 userid 完全一样的才算查到，不会认错人；搜不到的交给自建应用那条路补查（配了的话）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CALL_TIMEOUT_MS = 20 * 1000;
const KEYWORDS_PER_CALL = 10;

const WINDOWS = process.platform === 'win32';

/** 从「应用程序」或后台服务启动时 PATH 里通常没有 npm 全局目录，常见位置挨个找。 */
export function findCli(config = {}) {
  const configured = String(config.cliPath || '').trim().replace(/^~(?=[\\/])/, os.homedir());
  if (configured) return configured;
  const dirs = WINDOWS
    ? [
      ...String(process.env.PATH || '').split(';'),
      path.dirname(process.execPath),
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'pnpm'),
      path.join(os.homedir(), '.volta', 'bin')
    ]
    : [
      ...String(process.env.PATH || '').split(':'),
      path.dirname(process.execPath),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(os.homedir(), '.npm-global/bin'),
      path.join(os.homedir(), '.local/bin'),
      path.join(os.homedir(), '.volta/bin'),
      path.join(os.homedir(), 'Library/pnpm')
    ];
  // Windows 上 npm 装的是 wecom-cli.cmd；同目录那个没有扩展名的 wecom-cli 是给 Git Bash 用的，跑不了。
  const names = WINDOWS ? ['wecom-cli.exe', 'wecom-cli.cmd'] : ['wecom-cli'];
  for (const dir of dirs.filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch { /* 下一个 */ }
    }
  }
  return null;
}

/**
 * Windows 上 npm 装的命令是 .cmd 包装脚本，Node 不允许不经过 shell 直接跑（CVE-2024-27980）：
 * 读出它真正调用的 js 用 node 跑，或者直接跑它指向的 exe。和宿主 src/worker-runtime.js 的 resolveSpawn
 * 是同一套规则（插件不 import 核心模块）。认不出来时返回 null。
 */
export function spawnTarget(bin) {
  if (!WINDOWS || !/\.(?:cmd|bat)$/i.test(bin)) return { cmd: bin, pre: [] };
  try {
    const text = fs.readFileSync(bin, 'utf8');
    const rel = [...text.matchAll(/"%~?dp0%?\\?([^"%*]+)"/gi)].map((m) => m[1].trim())
      .filter((p) => p && !/(?:^|\\)node(?:\.exe)?$/i.test(p)).pop();
    const full = rel && path.resolve(path.dirname(bin), ...rel.split(/[\\/]+/).filter(Boolean));
    if (full && fs.existsSync(full) && /\.[cm]?js$/i.test(full)) return { cmd: process.execPath, pre: [full] };
    if (full && fs.existsSync(full) && /\.exe$/i.test(full)) return { cmd: full, pre: [] };
  } catch { /* 认不出来 */ }
  return null;
}

function execCli(config, bin, args, options, callback) {
  const target = spawnTarget(bin);
  if (!target) {
    const err = Object.assign(new Error(`认不出 ${bin} 这个包装脚本：在插件设置里填 wecom-cli 真正的可执行文件（.exe 或 .js）`), { code: 'NO_CLI' });
    process.nextTick(() => callback(err, '', ''));
    return;
  }
  execFile(target.cmd, [...target.pre, ...args], { env: envFor(config, bin), windowsHide: true, ...options }, callback);
}

function envFor(config, bin) {
  // wecom-cli 是个 node 脚本（#!/usr/bin/env node），PATH 里要有 node。
  const env = { ...process.env };
  // Windows 上环境变量名不分大小写，原来叫 Path 就改 Path，别多出一个 PATH。
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = [path.dirname(bin), path.dirname(process.execPath), env[pathKey] || ''].filter(Boolean).join(path.delimiter);
  const dir = String(config.cliConfigDir || '').trim().replace(/^~(?=[\\/])/, os.homedir());
  if (dir) env.WECOM_CLI_CONFIG_DIR = dir;
  return env;
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 分页等情况下是 NDJSON：取最后一行。
    const last = raw.split('\n').filter(Boolean).pop();
    try { return JSON.parse(last); } catch { return null; }
  }
}

/** 跑一次 wecom-cli，返回 stdout 的 JSON。错误也是 stdout 里的 { error: { code, message } }。 */
export function runCli(config, args, { signal } = {}) {
  const bin = findCli(config);
  if (!bin) return Promise.reject(Object.assign(new Error('没装 wecom-cli：终端里运行 npm install -g @wecom/cli，再运行 wecom-cli auth init 授权'), { code: 'NO_CLI' }));
  return new Promise((resolve, reject) => {
    execCli(config, bin, args, { signal, timeout: CALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err?.code === 'NO_CLI') {
        reject(err);
        return;
      }
      if (err?.code === 'ENOENT') {
        reject(Object.assign(new Error(`找不到 wecom-cli（${bin}）。在插件设置里填它的完整路径，终端里 ${WINDOWS ? 'where' : 'which'} wecom-cli 可以查到`), { code: 'NO_CLI' }));
        return;
      }
      const data = parseJson(stdout);
      if (data?.error) {
        reject(Object.assign(new Error(`wecom-cli：${data.error.message || data.error.type || '出错了'}（${data.error.code ?? '?'}）`), { code: 'CLI_ERROR', cliCode: data.error.code }));
        return;
      }
      if (err) {
        reject(new Error(`wecom-cli 运行失败：${String(stderr || err.message).trim().slice(0, 300)}`));
        return;
      }
      resolve(data);
    });
  });
}

/** 装了没、授权了没：{ ok, detail }。 */
export async function cliStatus(config, { signal } = {}) {
  const bin = findCli(config);
  if (!bin) return { ok: false, detail: '没装 wecom-cli（npm install -g @wecom/cli）' };
  return new Promise((resolve) => {
    execCli(config, bin, ['auth', 'show', '--status'], { signal, timeout: CALL_TIMEOUT_MS }, (err, stdout) => {
      const status = String(stdout || '').trim();
      if (status === 'authorized') resolve({ ok: true, detail: 'wecom-cli 已授权' });
      else if (status === 'unauthorized') resolve({ ok: false, detail: 'wecom-cli 还没授权：终端里运行 wecom-cli auth init' });
      else resolve({ ok: false, detail: `wecom-cli 状态未知：${String(err?.message || status).slice(0, 200)}` });
    });
  });
}

/**
 * 查一批 userid：[{ id, name, title, department, alias }]，搜不到（或 userid 对不上）的不返回。
 * 没装、没授权时抛 code = NO_CLI / CLI_ERROR，调用方决定要不要换别的路。
 */
export async function lookupByCli(config, userIds, { signal, run = runCli } = {}) {
  const wanted = new Set(userIds.map(String));
  const out = new Map();
  const ids = [...wanted];
  for (let i = 0; i < ids.length; i += KEYWORDS_PER_CALL) {
    const keywords = ids.slice(i, i + KEYWORDS_PER_CALL);
    const data = await run(config, ['contact', 'users', 'search', '--json', JSON.stringify({ keywords })], { signal });
    for (const user of Array.isArray(data?.users) ? data.users : []) {
      const id = String(user?.userid ?? '');
      if (!wanted.has(id) || out.has(id)) continue;
      const departments = Array.isArray(user.departments) ? user.departments : [];
      // 部门是从大到小的路径，主部门在前：取主部门路径的最后一段。
      const main = String(departments[0] || '');
      out.set(id, {
        id,
        name: String(user.name || '').trim(),
        title: String(user.position || '').trim(),
        department: main.split(/[/>]/).map((s) => s.trim()).filter(Boolean).pop() || main,
        alias: String(user.alias || '').trim()
      });
    }
  }
  return [...out.values()];
}

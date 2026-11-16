/**
 * Worker 运行时的纯工具函数：不依赖数据库和设置，主线程和 Worker 线程都能用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export function estimateTokens(text) {
  return Math.max(1, Math.round(String(text || '').length / 1.8));
}

// 命令路径缓存 30 秒：启动后才安装的 CLI 不用重启也能被检测到；点「检测」时会清空缓存。
const WHICH_TTL_MS = 30 * 1000;
const BIN = new Map(); // bin -> { path, at }

export function clearWhichCache() {
  BIN.clear();
}

export function which(bin) {
  const cached = BIN.get(bin);
  if (cached && Date.now() - cached.at <= WHICH_TTL_MS) return cached.path;
  const home = process.env.HOME || '';
  const extra = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ];
  const env = { ...process.env, PATH: [...extra, process.env.PATH || ''].join(':') };
  const r = spawnSync('which', [bin], { encoding: 'utf8', env });
  let found = r.status === 0 ? r.stdout.trim() : null;
  if (!found) {
    for (const dir of extra) {
      const candidate = path.join(dir, bin);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        found = candidate;
        break;
      } catch { /* ignore */ }
    }
  }
  BIN.set(bin, { path: found, at: Date.now() });
  return found;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/**
 * 运行一个外部命令。signal 中止时先 SIGTERM，1.5 秒后 SIGKILL，并返回 { error: 'aborted' }。
 * timeoutMs 为 0 表示不单独设超时（由调度器按 Worker 的 timeoutMinutes 统一中止）。
 */
export function runCommand(cmd, args = [], { cwd, signal, onOutput, timeoutMs = 0, env: extraEnv = {} } = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (value === null || value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: -2, error: 'aborted', stdout: '', stderr: '' });
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    child.stdout.on('data', (buf) => { stdout += buf.toString(); onOutput?.(buf.toString()); });
    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.on('error', (err) => finish({ code: -1, error: err.message }));
    child.on('close', (code) => finish({ code }));
    signal?.addEventListener('abort', () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref?.();
      finish({ code: -2, error: 'aborted' });
    }, { once: true });
  });
}

/** 解析输出末尾的 [[APPROVAL]] {"question":"…","options":[…]} 标记。 */
export function extractApproval(text) {
  const idx = String(text || '').lastIndexOf('[[APPROVAL]]');
  if (idx === -1) return null;
  const body = text.slice(idx + '[[APPROVAL]]'.length).trim();
  try {
    const parsed = JSON.parse(body.split('\n').filter(Boolean)[0]);
    if (!parsed.question) return null;
    return {
      approval: {
        question: String(parsed.question),
        options: Array.isArray(parsed.options) && parsed.options.length
          ? parsed.options.map(String).slice(0, 5)
          : ['继续', '先停一下']
      },
      text: text.slice(0, idx).trim()
    };
  } catch {
    return null;
  }
}

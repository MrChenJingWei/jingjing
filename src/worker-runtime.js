/**
 * Worker 运行时的纯工具函数：不依赖数据库和设置，主线程和 Worker 线程都能用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

export function estimateTokens(text) {
  return Math.max(1, Math.round(String(text || '').length / 1.8));
}

// 命令路径缓存 30 秒：启动后才安装的 CLI 不用重启也能被检测到；点「检测」时会清空缓存。
const WHICH_TTL_MS = 30 * 1000;
const BIN = new Map(); // bin -> { path, at }

export function clearWhichCache() {
  BIN.clear();
}

/** 从「应用程序」或后台服务启动时 PATH 往往很短，这些常见的安装位置也找一遍（排在 PATH 前面）。 */
export function extraBinDirs({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const join = path.win32.join;
    return [
      join(home, '.local', 'bin'), // Claude Code 原生安装的 claude.exe
      env.APPDATA && join(env.APPDATA, 'npm'), // npm i -g
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'pnpm'),
      join(home, '.bun', 'bin'),
      join(home, 'scoop', 'shims'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
      env.ProgramFiles && join(env.ProgramFiles, 'nodejs')
    ].filter(Boolean);
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ];
}

// Windows 上能直接拿来 spawn 的扩展名；PATHEXT 里的 .js / .vbs 之类要别的解释器，不算。
const WINDOWS_RUNNABLE = ['.com', '.exe', '.bat', '.cmd'];

/**
 * 在常见目录和 PATH 里找命令，找到返回完整路径，找不到返回 null。
 * Windows 上按 PATHEXT 补扩展名（claude → claude.exe / claude.cmd），不认没有扩展名的同名文件：
 * npm 在同一个目录里放的那个是给 Git Bash 用的 sh 脚本，Windows 跑不了。
 */
export function findCommand(bin, { platform = process.platform, env = process.env, dirs } = {}) {
  const name = String(bin || '').trim();
  if (!name) return null;
  const windows = platform === 'win32';
  const exts = windows
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.trim().toLowerCase()).filter((ext) => WINDOWS_RUNNABLE.includes(ext))
    : [''];
  const hasExt = windows && WINDOWS_RUNNABLE.includes(path.extname(name).toLowerCase());
  const variants = (file) => (windows && !hasExt ? exts.map((ext) => file + ext) : [file]);
  const usable = (file) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (!windows) fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (name.includes('/') || (windows && name.includes('\\'))) return variants(name).find(usable) || null;
  const pathVar = String(env.PATH ?? env.Path ?? '');
  const searchDirs = dirs || [...extraBinDirs({ platform, env }), ...pathVar.split(windows ? ';' : ':')];
  for (const raw of searchDirs) {
    const dir = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    const found = variants(path.join(dir, name)).find(usable);
    if (found) return found;
  }
  return null;
}

export function which(bin) {
  const cached = BIN.get(bin);
  if (cached && Date.now() - cached.at <= WHICH_TTL_MS) return cached.path;
  const found = findCommand(bin);
  BIN.set(bin, { path: found, at: Date.now() });
  return found;
}

/* --------------------------- Windows 的 .cmd 包装脚本 --------------------------- */

/**
 * npm（cmd-shim）、pnpm、yarn 给全局命令生成的 .cmd 里写着它真正调用的文件，路径相对 .cmd 所在目录：
 *   npm：  "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
 *   pnpm： "%~dp0\node.exe"  "%~dp0\..\pnpm-global\5\node_modules\x\cli.js" %*
 * 取最后一个不是 node.exe 的那个；文件不存在或者认不出来返回 null。
 */
export function shimTarget(file, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  let text;
  try {
    text = read(file);
  } catch {
    return null;
  }
  if (typeof text !== 'string' || text.length > 64 * 1024) return null;
  let target = null;
  for (const match of text.matchAll(/"%~?dp0%?\\?([^"%*]+)"/gi)) {
    const rel = match[1].trim();
    if (!rel || /(?:^|\\)node(?:\.exe)?$/i.test(rel)) continue; // 解释器本身
    target = rel;
  }
  if (!target) return null;
  const full = path.resolve(path.dirname(file), ...target.split(/[\\/]+/).filter(Boolean));
  return fs.existsSync(full) ? full : null;
}

// cmd.exe 的元字符：整段加引号后再逐个用 ^ 转义，cmd 就不会把它们当成管道、变量或分隔符（https://qntm.org/cmd）。
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCmdArg(arg) {
  let value = String(arg ?? '').replace(/\r?\n/g, ' '); // cmd.exe 传不了换行
  value = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  value = value.replace(/(?=(\\+?)?)\1$/, '$1$1');
  return `"${value}"`.replace(CMD_META, '^$1');
}

/**
 * 把要运行的命令变成 spawn 能直接跑的 { cmd, args, options }。
 *
 * 只有 Windows 上的 .cmd / .bat 需要处理：Node 不允许不经过 shell 直接跑它们（CVE-2024-27980），
 * 经过 cmd.exe 又会丢掉参数里的换行、整行还不能超过 8191 个字符——交给编码 Agent 的 prompt 两样都会碰到。
 * 所以先读包装脚本，直接用 node 跑它背后的 js（或者直接跑它指向的 exe）；认不出来的才退回 cmd.exe。
 */
export function resolveSpawn(cmd, args = [], { platform = process.platform, node = process.execPath, comspec = process.env.ComSpec, depth = 0 } = {}) {
  const list = [...args].map(String);
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(String(cmd))) return { cmd, args: list, options: {} };
  const target = depth < 3 ? shimTarget(cmd) : null;
  if (target && /\.(?:c|m)?js$/i.test(target)) return { cmd: node, args: [target, ...list], options: {} };
  if (target && /\.(?:exe|com)$/i.test(target)) return { cmd: target, args: list, options: {} };
  if (target && /\.(?:cmd|bat)$/i.test(target)) return resolveSpawn(target, list, { platform, node, comspec, depth: depth + 1 });
  const line = [String(cmd).replace(CMD_META, '^$1'), ...list.map(escapeCmdArg)].join(' ');
  return { cmd: comspec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
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

// 这个线程启动的、还没退出的子进程。服务退出时统一结束，不留下还在改文件的孤儿进程。
const children = new Set();

/**
 * 结束子进程和它派生出来的整组进程（比如 Claude Code 的 Bash 工具起的命令）。
 * macOS / Linux：子进程用 detached 启动、自成一个进程组，所以能按组发信号。
 * Windows：没有进程组，也没有能让程序收尾的 SIGTERM，用 taskkill /T 连同派生的整棵进程树一起结束。
 */
function killTree(child, signal) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const fallback = () => { try { child.kill(); } catch { /* 已经退出 */ } };
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', fallback);
    } catch {
      fallback();
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* 已经退出 */ }
  }
}

export function activeChildren() {
  return children.size;
}

/** 给所有还在跑的子进程发 SIGTERM，最多等 graceMs，剩下的 SIGKILL。 */
export async function terminateChildren(graceMs = 1500) {
  for (const child of children) killTree(child, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (children.size && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const child of children) killTree(child, 'SIGKILL');
}

/**
 * 运行一个外部命令。signal 中止时给整组进程发 SIGTERM，1.5 秒后 SIGKILL（Windows 上直接结束整棵进程树），
 * 并返回 { error: 'aborted' }。
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
    // Windows 上 spawn 只会自己补 .exe：裸命令名先按 PATHEXT 找到完整路径（npm、pnpm 这些是 .cmd）。
    const bare = IS_WINDOWS && !/[\\/]/.test(String(cmd)) ? findCommand(cmd) : null;
    const target = resolveSpawn(bare || cmd, args);
    // Windows 不用 detached：那样子进程没有控制台，它再起的命令行程序会各自弹出黑窗口。
    // windowsHide 让子进程拿到一个看不见的控制台，主机这边按 Ctrl+C 也不会直接传给它。
    const child = spawn(target.cmd, target.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !IS_WINDOWS,
      windowsHide: true,
      ...target.options
    });
    children.add(child);
    const forget = () => children.delete(child);
    child.once('exit', forget);
    child.once('error', forget);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => killTree(child, 'SIGKILL'), timeoutMs) : null;
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
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 1500).unref?.();
      finish({ code: -2, error: 'aborted' });
    }, { once: true });
  });
}

/*
 * 任务结论（outcome）：done 只代表这一轮跑完了，不代表事情做完了。
 * Worker 可以在结果里直接给 outcome，也可以让自己的 Agent 在输出最后单独写一行 [[OUTCOME]] <结论>，
 * 宿主在 runWorker 里统一认出来、从结果里去掉。没给就留空，由列表从结果的收尾推断要不要主人接着处理。
 */
export const TASK_OUTCOMES = ['completed', 'proposed', 'delivered', 'partial', 'blocked'];

export const OUTCOME_GUIDE = [
  '做完这一轮后，如果还有要主人定的事——方案等确认、列了几个可选的下一步、只做完一部分、卡在外部条件上——',
  '在最后单独输出一行 [[OUTCOME]] proposed（方案或下一步等主人确认）、partial（只做完一部分）或 blocked（卡住了，等主人决定）；',
  '事情已经完全做完、不需要主人再做什么，输出 [[OUTCOME]] completed。这一行只放标记，不要加别的字。'
].join('\n');

const OUTCOME_LINE = /^[ \t]*\[\[OUTCOME\]\][ \t]*([a-z_]+)[ \t]*$/gm;

/** 认出输出里的 [[OUTCOME]] 标记：返回 { outcome, text（去掉标记行） }；没有或不认识的结论返回 null。 */
export function extractOutcome(text) {
  const source = String(text || '');
  const found = [...source.matchAll(OUTCOME_LINE)];
  if (!found.length) return null;
  const outcome = found[found.length - 1][1];
  const cleaned = source.replace(OUTCOME_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { outcome: TASK_OUTCOMES.includes(outcome) ? outcome : null, text: cleaned };
}

/** done 的结果：结果对象里的 outcome 优先，其次是输出里的标记；标记行总是从给主人看的结果里去掉。 */
export function withOutcome(result) {
  if (!result || result.status !== 'done') return result;
  const parsed = extractOutcome(result.summary);
  const declared = TASK_OUTCOMES.includes(result.outcome) ? result.outcome : parsed?.outcome || null;
  const { outcome: _drop, ...rest } = result;
  return { ...rest, ...(parsed ? { summary: parsed.text } : {}), ...(declared ? { outcome: declared } : {}) };
}

/**
 * 交给编码 Agent（Claude Code、Codex……）的「怎么停下来问主人」约定。
 * 不告诉它，它在结果里随口问一句「要我接着改吗？」，任务就直接算完成了。
 */
export const APPROVAL_GUIDE = [
  '（静静的约定）如果做到一半必须由主人决定才能继续（选方案、确认有风险的操作、缺关键信息），',
  '不要猜，也不要把问题埋在结果里：把已经做完的部分和问题写清楚，最后单独输出一行：',
  '[[APPROVAL]] {"question":"要问的问题","options":["选项A","选项B"]}',
  '主人回答后会接着这次的上下文继续。不需要主人决定时不要输出这个标记，直接把事情做完。',
  OUTCOME_GUIDE
].join('\n');

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
          : ['继续', '先停一下'],
        // 输出里提问的 Worker 会把用户的决定写进下一轮指令，用户可以不选选项、自己写一个决定。
        custom: true
      },
      text: text.slice(0, idx).trim()
    };
  } catch {
    return null;
  }
}

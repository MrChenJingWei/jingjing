// 内置 Worker：DeepSeek Harness。用 `dsh headless` 在任务工作区里跑一次任务。
// 按顺序找 Harness：
//   1. 静静本身跑在 Harness 里（有 DSH_* 环境变量）——直接用 Harness 自带的 node；
//   2. PATH 里有 dsh 命令（在 Harness 里装过命令行工具）；
//   3. macOS 上装在 /Applications 或 ~/Applications 的 DeepSeek Harness.app，用 App 自带的 dsh 启动脚本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_BUNDLE = 'DeepSeek Harness.app';
const APP_CLI = path.join('Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh');

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 返回 { cmd, args, env, detail }；找不到返回 null。 */
export function findHarness({
  which,
  env = process.env,
  platform = process.platform,
  appDirs = ['/Applications', path.join(os.homedir(), 'Applications')]
} = {}) {
  if (env.DSH_NODE_EXECUTABLE && env.DSH_INSTALL_DIR && env.DSH_HOME) {
    return {
      cmd: env.DSH_NODE_EXECUTABLE,
      args: [path.join(env.DSH_INSTALL_DIR, 'lib/bin.js')],
      env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: env.DSH_HOME },
      detail: 'Harness 运行环境'
    };
  }
  const bin = which?.('dsh');
  if (bin) return { cmd: bin, args: [], env: {}, detail: bin };
  if (platform === 'darwin') {
    for (const dir of appDirs) {
      const cli = path.join(dir, APP_BUNDLE, APP_CLI);
      if (executable(cli)) return { cmd: cli, args: [], env: {}, detail: path.join(dir, APP_BUNDLE) };
    }
  }
  return null;
}

// 这个 Worker 有自己的 DeepSeek Key：存在它自己的配置里（设置 → Worker → DeepSeek Harness → 配置），
// 或者用进程环境里的 DEEPSEEK_API_KEY。它不读“运行模式”那把 Key —— 那把可能指向 Kimi、中转站或
// 本地网关，交给无头 dsh 只会 401。
function hasApiKey(config, env = process.env) {
  return Boolean(config?.apiKey) || Boolean(env.DEEPSEEK_API_KEY);
}

export function detect(config, { which } = {}) {
  const harness = findHarness({ which });
  if (!harness) return { available: false, detail: '没有找到 DeepSeek Harness（需要 dsh 命令或 /Applications 里的 DeepSeek Harness.app）' };
  if (!hasApiKey(config)) {
    return { available: false, detail: '已找到 DeepSeek Harness，但还没有它自己的 DeepSeek API Key：在 Worker 的「配置」里填，或设环境变量 DEEPSEEK_API_KEY' };
  }
  return { available: true, detail: harness.detail };
}

export async function execute(task, ctx) {
  const harness = findHarness({ which: ctx.which });
  if (!harness) {
    return { status: 'failed', retryable: false, summary: '没有找到 DeepSeek Harness：需要 dsh 命令，或把 DeepSeek Harness.app 装在「应用程序」里。' };
  }
  const apiKey = ctx.config?.apiKey || '';
  if (!apiKey && !process.env.DEEPSEEK_API_KEY) {
    return { status: 'failed', retryable: false, summary: 'DeepSeek Harness 的无头模式需要 DeepSeek API Key：在这个 Worker 的「配置」里填好，或设环境变量 DEEPSEEK_API_KEY。' };
  }
  const env = {
    ...harness.env,
    // 避免继承桌面会话的 profile/session 状态。
    DSH_PROFILE_DIR: null,
    DSH_SESSION_ID: null,
    DSH_WEB_URL: null,
    ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {})
  };
  // 服务重启会打断 dsh 进程；之前存过会话 id 的话，用 --session-id 接着上次的会话继续，
  // 而不是从头再来（分支、未提交的改动都还在工作区里）。
  const resumeSession = String(ctx.sessionId || ctx.recovery?.checkpoint?.sessionId || '').trim();
  const prompt = resumeSession
    ? `服务重启打断了上一轮执行。请从上次停下的地方继续，不要重复已经完成的工作；先检查当前工作区状态（分支、未提交改动），再完成剩余步骤并给出最终结果。\n\n原任务：${task.prompt || task.title}`
    : (task.prompt || task.title);
  await ctx.emit(resumeSession ? '继续上次的 Harness 会话…' : 'DeepSeek Harness 已启动，正在自己的会话里工作…');

  // 用 --json 跑：Harness 会把每一步（工具调用、文字、结束原因）逐行写到 stdout，
  // 这里解析成事件转成进度，对话卡片就能边跑边看到它在做什么，而不是等最后一次性出结果。
  const events = [];
  let line = '';
  let streamedBytes = 0;
  let lastProgressAt = 0;
  const progress = (message) => {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const now = Date.now();
    if (now - lastProgressAt < 900) return;
    lastProgressAt = now;
    ctx.emit(text.slice(0, 200)).catch(() => {});
  };
  const toolDetail = (input = {}) => String(
    input.command || input.path || input.file_path || input.query || input.url || ''
  ).replace(/\s+/g, ' ').trim().slice(0, 80);

  let savedSession = resumeSession;
  const rememberSession = (id) => {
    const value = String(id || '').trim();
    if (!value || value === savedSession) return;
    savedSession = value;
    // 存进任务断点：服务重启后调度器会带着它重新排队，上面就会用 --session-id 继续。
    try { ctx.checkpoint?.({ sessionId: value }); } catch { /* 已经结束的执行不再保存 */ }
  };
  const handle = (raw) => {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (!event || typeof event !== 'object') return;
    events.push(event);
    if (event.type === 'session' && event.sessionId) rememberSession(event.sessionId);
    if (event.type === 'tool_call') {
      const detail = toolDetail(event.input);
      progress(`调用「${event.tool || '工具'}」${detail ? `：${detail}` : '…'}`);
    } else if (event.type === 'tool_result' && event.status === 'error') {
      progress('工具报错了，换办法继续…');
    } else if (event.type === 'text') {
      const lastLine = String(event.text || '').split('\n').map((part) => part.trim()).filter(Boolean).pop();
      if (lastLine) progress(lastLine.slice(0, 160));
    }
  };

  const result = await ctx.exec(harness.cmd, [...harness.args, 'headless', '--json', ...(resumeSession ? ['--session-id', resumeSession] : []), prompt], {
    cwd: ctx.workspace,
    env,
    onOutput: (chunk) => {
      streamedBytes += chunk.length;
      line += chunk;
      let index;
      while ((index = line.indexOf('\n')) !== -1) {
        const current = line.slice(0, index).trim();
        line = line.slice(index + 1);
        if (current) handle(current);
      }
    }
  });

  // 没走 onOutput 的实现（或者最后一行没有换行）也要能解析。
  if (line.trim()) { handle(line.trim()); line = ''; }
  const rawStdout = String(result.stdout || '');
  if (rawStdout.length > streamedBytes) {
    for (const current of rawStdout.slice(streamedBytes).split('\n')) {
      if (current.trim()) handle(current.trim());
    }
  }
  if (line.trim()) { handle(line.trim()); line = ''; }

  const finalEvent = [...events].reverse().find((event) => event.type === 'final');
  if (finalEvent?.sessionId) rememberSession(finalEvent.sessionId);
  const streamedText = events.filter((event) => event.type === 'text').map((event) => event.text || '').join('');
  const usage = [...events].reverse().find((event) => event.type === 'status' && event.phase === 'step_end')?.usage;
  const stdoutText = events.length
    ? String(finalEvent?.text || streamedText || '').trim()
    : rawStdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
  const text = stdoutText || String(result.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').trim();

  if (result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  if (result.code !== 0) return { status: 'failed', summary: `DeepSeek Harness 退出码 ${result.code}。\n${text.slice(-1200)}` };
  // 缺 Key 之类的启动错误也会以退出码 0 结束，只能从输出里认出来。
  const fatal = String(result.stderr || '').match(/^dsh: ([A-Z_]+): .*$/m);
  if (!rawStdout.trim() && fatal) {
    return { status: 'failed', retryable: false, summary: `DeepSeek Harness 没能开始：${fatal[0].replace(/^dsh: /, '')}` };
  }
  const reason = finalEvent?.reason?.kind;
  if (reason && reason !== 'completed') {
    return { status: 'failed', summary: `DeepSeek Harness 没有正常结束（${reason}）。\n${text.slice(-1200)}` };
  }
  return {
    status: 'done',
    summary: text || 'DeepSeek Harness 没有输出。',
    tokens: usage?.totalTokens || ctx.estimateTokens(text),
    sessionId: savedSession || null
  };
}

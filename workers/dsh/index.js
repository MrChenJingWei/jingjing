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

// 无头模式不读桌面版的登录凭据，只认 DEEPSEEK_API_KEY：用静静设置里的 DeepSeek Key，或者进程环境里已有的。
function hasApiKey(llmMode, env = process.env) {
  return llmMode === 'deepseek' || Boolean(env.DEEPSEEK_API_KEY);
}

export function detect(config, { which, llm } = {}) {
  const harness = findHarness({ which });
  if (!harness) return { available: false, detail: '没有找到 DeepSeek Harness（需要 dsh 命令或 /Applications 里的 DeepSeek Harness.app）' };
  if (!hasApiKey(llm?.mode)) {
    return { available: false, detail: '已找到 DeepSeek Harness，但还没有 DeepSeek API Key：在设置 → 模型里填好，无头模式要用它' };
  }
  return { available: true, detail: harness.detail };
}

export async function execute(task, ctx) {
  const harness = findHarness({ which: ctx.which });
  if (!harness) {
    return { status: 'failed', retryable: false, summary: '没有找到 DeepSeek Harness：需要 dsh 命令，或把 DeepSeek Harness.app 装在「应用程序」里。' };
  }
  const apiKey = ctx.secrets?.apiKey || '';
  if (!apiKey && !process.env.DEEPSEEK_API_KEY) {
    return { status: 'failed', retryable: false, summary: 'DeepSeek Harness 的无头模式需要 DeepSeek API Key，请先在设置 → 模型里填好。' };
  }
  const env = {
    ...harness.env,
    // 避免继承桌面会话的 profile/session 状态。
    DSH_PROFILE_DIR: null,
    DSH_SESSION_ID: null,
    DSH_WEB_URL: null,
    ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {})
  };
  await ctx.emit('DeepSeek Harness 已启动，正在自己的会话里工作…');
  const result = await ctx.exec(harness.cmd, [...harness.args, 'headless', task.prompt || task.title], {
    cwd: ctx.workspace,
    env
  });
  const text = String(result.stdout || result.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  if (result.code !== 0) return { status: 'failed', summary: `DeepSeek Harness 退出码 ${result.code}。\n${text.slice(-1200)}` };
  // 缺 Key 之类的启动错误也会以退出码 0 结束，只能从输出里认出来。
  const fatal = String(result.stderr || '').match(/^dsh: ([A-Z_]+): .*$/m);
  if (!String(result.stdout || '').trim() && fatal) {
    return { status: 'failed', retryable: false, summary: `DeepSeek Harness 没能开始：${fatal[0].replace(/^dsh: /, '')}` };
  }
  return { status: 'done', summary: text || 'DeepSeek Harness 没有输出。', tokens: ctx.estimateTokens(text) };
}

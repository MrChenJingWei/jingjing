// 内置 Worker：DeepSeek Harness。只在静静运行于 DeepSeek Harness 环境里时可用。
import path from 'node:path';

function harnessEnv() {
  const node = process.env.DSH_NODE_EXECUTABLE;
  const install = process.env.DSH_INSTALL_DIR;
  const home = process.env.DSH_HOME;
  return node && install && home ? { node, install, home } : null;
}

export function detect() {
  return harnessEnv()
    ? { available: true, detail: 'dsh headless' }
    : { available: false, detail: '未检测到 DeepSeek Harness 运行环境' };
}

export async function execute(task, ctx) {
  const harness = harnessEnv();
  if (!harness) {
    return {
      status: 'failed',
      retryable: false,
      summary: '当前进程没有 DeepSeek Harness 运行环境（DSH_NODE_EXECUTABLE / DSH_INSTALL_DIR / DSH_HOME）'
    };
  }
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    DSH_PROFILE: 'headless',
    DSH_HOME: harness.home,
    // 避免继承桌面会话的 profile/session 状态。
    DSH_PROFILE_DIR: null,
    DSH_SESSION_ID: null,
    DSH_WEB_URL: null,
    ...(ctx.settings.apiKey ? { DEEPSEEK_API_KEY: ctx.settings.apiKey } : {})
  };
  await ctx.emit('DeepSeek Harness 已启动，正在自己的会话里工作…');
  const result = await ctx.exec(harness.node, [path.join(harness.install, 'lib/bin.js'), 'headless', task.prompt || task.title], {
    cwd: ctx.workspace,
    env
  });
  const text = String(result.stdout || result.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  if (result.code !== 0) return { status: 'failed', summary: `DeepSeek Harness 退出码 ${result.code}。\n${text.slice(-1200)}` };
  return { status: 'done', summary: text || 'DeepSeek Harness 没有输出。', tokens: ctx.estimateTokens(text) };
}

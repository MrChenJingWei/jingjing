// 内置 Worker：Codex。调用本机 codex CLI 的 exec 模式。

export function detect(config, { which }) {
  const bin = which('codex');
  return { available: Boolean(bin), detail: bin || '未安装' };
}

export async function execute(task, ctx) {
  const bin = ctx.which('codex');
  if (!bin) return { status: 'failed', retryable: false, summary: '没有找到 codex 命令。' };
  const prompt = ctx.resume
    ? `${task.prompt}\n\n用户的选择：${ctx.resume.choice >= 0 ? ctx.resume.options?.[ctx.resume.choice] : '取消'}`
    : task.prompt;
  await ctx.emit('Codex 已启动…');
  const result = await ctx.exec(bin, ['exec', '--skip-git-repo-check', prompt], { cwd: ctx.workspace });
  if (result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  const text = (result.stdout || result.stderr).trim() || `Codex 退出码 ${result.code}`;
  if (result.code !== 0) return { status: 'failed', summary: text.slice(-1200) };
  return { status: 'done', summary: text, tokens: ctx.estimateTokens(text) };
}

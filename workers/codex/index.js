// 内置 Worker：Codex。调用本机 codex CLI 的 exec 模式。

export function detect(config, { which }) {
  const bin = which('codex');
  return { available: Boolean(bin), detail: bin || '未安装' };
}

export async function execute(task, ctx) {
  const bin = ctx.which('codex');
  if (!bin) return { status: 'failed', retryable: false, summary: '没有找到 codex 命令。' };
  const prompt = ctx.resume
    ? `${task.prompt}\n\n用户的${ctx.resume.answer ? `决定：${ctx.resume.answer}` : `选择：${ctx.resume.choice >= 0 ? ctx.resume.options?.[ctx.resume.choice] : '取消'}`}`
    : task.prompt;
  await ctx.emit('Codex 已启动…');
  // 静静明确允许改文件的任务才用 --full-auto（只能写工作目录）；其他任务按 codex 自己的默认沙箱。
  // `--` 之后都当成 prompt：以「-」开头的消息（比如 Markdown 列表）不会被当成命令行选项。
  const args = ['exec', ...(ctx.options?.allowEdits ? ['--full-auto'] : []), '--skip-git-repo-check', '--', prompt];
  const result = await ctx.exec(bin, args, { cwd: ctx.workspace });
  if (result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  const text = (result.stdout || result.stderr).trim() || `Codex 退出码 ${result.code}`;
  if (result.code !== 0) return { status: 'failed', summary: text.slice(-1200) };
  return { status: 'done', summary: text, tokens: ctx.estimateTokens(text) };
}

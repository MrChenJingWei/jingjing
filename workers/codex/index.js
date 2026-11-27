// 内置 Worker：Codex。调用本机 codex CLI 的 exec 模式。

export function detect(config, { which }) {
  const bin = which('codex');
  return { available: Boolean(bin), detail: bin || '未安装' };
}

export async function execute(task, ctx) {
  const bin = ctx.which('codex');
  if (!bin) return { status: 'failed', retryable: false, summary: '没有找到 codex 命令。' };
  // 接着做的那一轮，task.prompt 里已经拼好了前几轮的结果（Codex 没有可续的会话）。
  const base = ctx.resume
    ? `${task.prompt}\n\n用户的${ctx.resume.answer ? `决定：${ctx.resume.answer}` : `选择：${ctx.resume.choice >= 0 ? ctx.resume.options?.[ctx.resume.choice] : '取消'}`}`
    : task.prompt;
  // 工作区挂的其他文件夹：Codex 在主目录里执行，指令里告诉它另外几个在哪。
  const dirs = (ctx.extraDirs || []).length ? `\n\n这个工作区还包括这些文件夹：\n${ctx.extraDirs.map((dir) => `- ${dir}`).join('\n')}` : '';
  const prompt = ctx.approvalGuide ? `${base}${dirs}\n\n${ctx.approvalGuide}` : `${base}${dirs}`;
  await ctx.emit('Codex 已启动…');
  // 静静明确允许改文件的任务才用 --full-auto（只能写工作目录）；其他任务按 codex 自己的默认沙箱。
  // `--` 之后都当成 prompt：以「-」开头的消息（比如 Markdown 列表）不会被当成命令行选项。
  // 可改文件 / 改文件和跑命令（或插件草稿任务）：--full-auto 让它在工作区里改文件、跑命令；只读时用 Codex 自己的默认沙箱。
  const level = ctx.permissions?.level || (ctx.options?.allowEdits ? 'edit' : 'read');
  const args = ['exec', ...(level !== 'read' ? ['--full-auto'] : []), '--skip-git-repo-check', '--', prompt];
  const result = await ctx.exec(bin, args, { cwd: ctx.workspace });
  if (result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  const text = (result.stdout || result.stderr).trim() || `Codex 退出码 ${result.code}`;
  if (result.code !== 0) return { status: 'failed', summary: text.slice(-1200) };
  const approval = ctx.parseApproval?.(text);
  if (approval) return { status: 'needs_approval', summary: approval.text, approval: approval.approval, tokens: ctx.estimateTokens(text) };
  return { status: 'done', summary: text, tokens: ctx.estimateTokens(text) };
}

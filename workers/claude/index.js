// 内置 Worker：Claude Code。调用本机 claude CLI 的非交互模式。

export function detect(config, { settings, which }) {
  const bin = which('claude');
  const available = Boolean(bin) && settings.claude?.enabled !== false;
  return { available, detail: available ? bin : '未安装或已禁用' };
}

function resumePrompt(task, resume) {
  if (!resume) return task.prompt;
  const picked = resume.choice >= 0 ? resume.options?.[resume.choice] ?? String(resume.choice) : '取消';
  return `${task.prompt}\n\n用户刚刚对「${resume.question}」选择了：${picked}。请在此基础上继续完成。`;
}

export async function execute(task, ctx) {
  const bin = ctx.which('claude');
  if (!bin || ctx.settings.claude?.enabled === false) {
    return { status: 'failed', retryable: false, summary: '没有找到 claude 命令，或在设置里禁用了 Claude Code。' };
  }

  // 工具权限交给 Claude Code 自身的用户配置和 macOS 账户权限，静静不覆盖。
  const args = ['-p', resumePrompt(task, ctx.resume), '--output-format', 'json'];
  if (ctx.sessionId) args.push('--resume', ctx.sessionId);

  await ctx.emit('Claude Code 已启动，正在自己的上下文里工作…');
  const result = await ctx.exec(bin, args, { cwd: ctx.workspace });
  if (result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  if (result.code !== 0) {
    return { status: 'failed', summary: `Claude Code 退出码 ${result.code}。\n${(result.stderr || result.stdout).slice(-800)}` };
  }

  let text = result.stdout.trim();
  let sessionId = null;
  let cost = 0;
  try {
    const parsed = JSON.parse(text);
    text = parsed.result || parsed.message || text;
    sessionId = parsed.session_id || null;
    cost = parsed.total_cost_usd || 0;
  } catch { /* 非 JSON 输出按纯文本处理 */ }
  const tokens = ctx.estimateTokens(text);
  const approval = ctx.parseApproval(text);
  if (approval) {
    return { status: 'needs_approval', summary: approval.text, approval: approval.approval, sessionId, tokens, cost };
  }
  return { status: 'done', summary: text, sessionId, tokens, cost };
}

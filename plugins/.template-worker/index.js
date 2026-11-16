// Worker 插件模板：把这个目录复制成 <数据目录>/plugins/<你的 id>，改 plugin.json 的 id/name/worker 和下面的实现。
// 只通过 ctx 使用宿主能力，见 docs/PLUGIN.md「Worker 插件」。

export function detect(config, { which }) {
  const bin = config.bin || which('my-agent');
  return bin ? { available: true, detail: bin } : { available: false, detail: '没有找到 my-agent 命令' };
}

export async function execute(task, ctx) {
  const bin = ctx.config.bin || ctx.which('my-agent');
  if (!bin) return { status: 'failed', retryable: false, summary: '没有找到 my-agent 命令。' };

  await ctx.emit('my-agent 已启动…');
  // 存断点：服务重启后如果 recovery 是 resume，ctx.recovery.checkpoint 会带回来。
  await ctx.checkpoint({ startedAt: Date.now() });
  // ctx.exec 会在任务被取消或超时时自动终止子进程；子进程里有 JINGJING_REPORT_URL / JINGJING_RUN_TOKEN，
  // 可以自己 POST 进度回来：curl -X POST "$JINGJING_REPORT_URL" -H "Authorization: Bearer $JINGJING_RUN_TOKEN" -d '{"message":"..."}'
  const result = await ctx.exec(bin, ['run', task.prompt], { cwd: ctx.workspace });
  if (result.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  if (result.code !== 0) return { status: 'failed', summary: (result.stderr || result.stdout).slice(-1200) };

  const text = result.stdout.trim();
  // 输出里带 [[APPROVAL]] {"question":"…","options":[…]} 时，挂起等用户拍板。
  const approval = ctx.parseApproval(text);
  if (approval) return { status: 'needs_approval', summary: approval.text, approval: approval.approval };
  return { status: 'done', summary: text, tokens: ctx.estimateTokens(text) };
}

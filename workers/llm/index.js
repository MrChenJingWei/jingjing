// 内置 Worker：问答。只交付文本，不读写文件、不执行命令。

const SYSTEM_ACTION_RE = [
  /(?:保存|写入|创建|新建|建|生成|修改|删除|移动|运行|执行|安装|部署|推送|提交|下载|上传).{0,40}(?:文件|文档|txt|md|markdown|tex|json|csv|代码|仓库|git|github|命令|脚本|目录|文件夹)/i,
  /[A-Za-z0-9_\-一-龥]+\.(?:txt|md|markdown|tex|json|csv)/i,
  /(^|[^a-z])(git|github)([^a-z]|$)/i
];

export function detect(config, { settings }) {
  const demo = settings.provider === 'demo' || (settings.provider === 'deepseek' && !settings.apiKey);
  return { available: true, detail: `${demo ? '演示模式' : `模型：${settings.model}`} · 仅文本，不读写文件/不执行命令` };
}

function capableWorkers(workers) {
  const names = workers
    .filter((w) => w.abilities?.includes('write-file') || w.abilities?.includes('code'))
    .map((w) => `「${w.label}」`);
  return names.length ? names.join(' / ') : '具备文件或代码能力的 Worker';
}

export async function execute(task, ctx) {
  // 只看用户的原始请求：分隔线之后是静静附加的来源信息或工作流程步骤。
  const promptText = String(task.prompt || task.title || '').split(/\n-{3,}\n/)[0];
  if (SYSTEM_ACTION_RE.some((re) => re.test(promptText))) {
    return {
      status: 'failed',
      retryable: false,
      summary: `「问答」Worker 只能处理和回答文本，不能读写文件、执行命令或操作仓库。请在任务详情里把 Worker 改成 ${capableWorkers(ctx.workers)} 后重试。`
    };
  }
  if (ctx.resume && ctx.resume.choice < 0) {
    return { status: 'cancelled', summary: '已按你的选择停下，没有再继续。' };
  }

  if (ctx.llm.mode === 'demo') {
    await ctx.emit('正在读取任务上下文…');
    await ctx.sleep(500);
    await ctx.emit('检索记忆与近期任务…');
    await ctx.sleep(600);
    const text = ctx.llm.demoOutput();
    await ctx.emit('整理输出…');
    await ctx.sleep(400);
    return { status: 'done', summary: text, tokens: ctx.estimateTokens(text) };
  }

  const { settings, resume } = ctx;
  const memBlock = ctx.memories.map((m) => `- ${m.text}`).join('\n') || '-（暂无）';
  const taskBlock = ctx.tasks.slice(0, 8).map((t) => `- [${t.status}] ${t.title}`).join('\n') || '-（暂无）';
  const decision = resume
    ? `\n\n用户刚刚对「${resume.question}」选择了：${resume.choice >= 0 ? resume.options?.[resume.choice] ?? resume.choice : '取消'}。请据此继续完成，不要重复提问。`
    : '';

  const system = [
    '你是「静静」，运行在用户个人主机上的 AI 管家。',
    `风格：${settings.persona || '平静、具体、不奉承，像一个可靠的同事。'}`,
    '你在执行一个已经派给你的任务。直接交付结果，不要说「作为一个 AI」。',
    '你是「问答」Worker，只能处理和回答文本；你没有读写文件、执行命令、访问网络或修改系统的能力。',
    '不要声称「已保存」「已写入」「已执行」「已修改」任何文件或系统；需要落盘时告诉用户改用「文件生成」或编码 Worker。',
    '不要描述系统内部操作，不要声称「任务板已更新」「已写入数据库」；只交付内容本身。',
    `当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}。`,
    '需要用户拍板才能继续时，把问题写在最后，并单独输出一行：',
    '[[APPROVAL]] {"question":"要问的问题","options":["选项A","选项B"]}',
    '否则不要输出这个标记。',
    '',
    '你可以参考的长期记忆：',
    memBlock,
    '',
    '当前任务板：',
    taskBlock
  ].join('\n');

  const res = await ctx.llm.chat({
    system,
    messages: [{ role: 'user', content: `${task.prompt}${decision}` }],
    maxTokens: 1800
  });
  const parsed = ctx.parseApproval(res.text);
  if (parsed) {
    return { status: 'needs_approval', summary: parsed.text, approval: parsed.approval, tokens: res.tokens };
  }
  return { status: 'done', summary: res.text, tokens: res.tokens, cost: res.cost };
}

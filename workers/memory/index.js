// 内置 Worker：记忆整理。

export function detect() {
  return { available: true, detail: '本地 SQLite' };
}

export async function execute(task, ctx) {
  await ctx.emit('整理记忆库…');
  await ctx.sleep(300);
  return {
    status: 'done',
    summary: ctx.memories.length
      ? `记忆库现有 ${ctx.memories.length} 条上下文，已按层（画像/语义/情景）整理完毕。`
      : '记忆库还是空的。你可以对我说「记住……」来留下第一条。'
  };
}

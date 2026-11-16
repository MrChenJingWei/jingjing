// 内置 Worker：文件生成。让模型生成一份文本文件并写入任务工作区。
import fs from 'node:fs';
import path from 'node:path';

function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

export function detect() {
  return { available: true, detail: '生成文本文件并写入任务工作区' };
}

export async function execute(task, ctx) {
  const dir = ctx.workspace;
  if (!fs.existsSync(dir)) return { status: 'failed', retryable: false, summary: `目录不存在：${dir}` };
  const prompt = task.prompt || task.title;
  await ctx.emit('生成文件内容…');

  let filename = '';
  let content = '';
  const requested = prompt.match(/([A-Za-z0-9_\-一-龥]+\.(?:txt|md|markdown|tex|json|csv|html|css|js|py))/i);
  if (requested) filename = requested[1];

  if (ctx.llm.mode === 'demo') {
    content = `${prompt}\n`;
  } else {
    const system = [
      '你是静静的文件生成 Worker。根据用户要求生成一个文本文件。',
      '只输出 JSON，不要 Markdown 代码围栏。结构：',
      '{"filename":"abc.txt","content":"文件的完整内容"}',
      'filename 只能是文件名，不能带路径；用户没指定时自己取一个贴切的名字和扩展名。',
      'content 是最终文件内容，不要解释、不要额外说明。'
    ].join('\n');
    try {
      const res = await ctx.llm.chat({
        system,
        messages: [{ role: 'user', content: prompt }],
        json: true,
        temperature: 0.3,
        maxTokens: 5000
      });
      const text = res.text || '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (parsed.filename) filename = String(parsed.filename);
        if (parsed.content !== undefined) content = String(parsed.content);
      } else {
        content = text;
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      return { status: 'failed', summary: `生成文件内容失败：${err.message}` };
    }
  }

  if (!content) return { status: 'failed', summary: '模型没有返回文件内容。' };
  if (!filename) filename = 'generated.txt';
  filename = path.basename(filename).replace(/[^\w.\-一-龥]/g, '_').slice(0, 120) || 'generated.txt';
  if (!/\.[A-Za-z0-9]{1,8}$/.test(filename)) filename += '.txt';
  const target = path.resolve(dir, filename);
  if (!isInside(dir, target)) return { status: 'failed', retryable: false, summary: '文件名越出了任务工作区。' };
  if (ctx.signal.aborted) return { status: 'cancelled', summary: '任务已停止，没有写入文件。' };
  fs.writeFileSync(target, content, 'utf8');
  await ctx.emit(`已写入 ${filename}`);
  const preview = content.length > 600 ? `${content.slice(0, 600)}…` : content;
  return {
    status: 'done',
    summary: `已生成并保存到：${target}\n\n${preview}`,
    tokens: ctx.estimateTokens(content)
  };
}

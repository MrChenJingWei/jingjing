// 解析 `claude -p --output-format stream-json --verbose` 的逐行 JSON 事件。

/** 按行切分 stdout，把每行 JSON 交给 onEvent；不是 JSON 的行忽略。 */
export function createLineParser(onEvent) {
  let buffer = '';
  const handle = (line) => {
    const text = line.trim();
    if (!text) return;
    try { onEvent(JSON.parse(text)); } catch { /* 非 JSON 行 */ }
  };
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    },
    flush() {
      if (buffer) handle(buffer);
      buffer = '';
    }
  };
}

const short = (value, n = 60) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

const baseName = (file) => String(file || '').split('/').filter(Boolean).pop() || file;

/** 把一次工具调用写成一句人能看懂的进度。 */
export function describeTool(name, input = {}) {
  switch (name) {
    case 'Read': return `读取 ${baseName(input.file_path)}`;
    case 'Write': return `写入 ${baseName(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit': return `修改 ${baseName(input.file_path)}`;
    case 'Bash': return `运行 ${short(input.command, 50)}`;
    case 'Grep': return `搜索「${short(input.pattern, 30)}」`;
    case 'Glob': return `查找文件 ${short(input.pattern, 40)}`;
    case 'WebFetch': return `打开 ${short(input.url, 50)}`;
    case 'WebSearch': return `搜索网页「${short(input.query, 30)}」`;
    case 'TodoWrite': return '更新待办清单';
    case 'Task':
    case 'Agent': return `派出子任务：${short(input.description || input.prompt, 40)}`;
    default: return `使用 ${name}`;
  }
}

/** 一条事件对应的进度文字；没有值得显示的内容时返回 null。 */
export function describeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'system' && event.subtype === 'init') return 'Claude Code 已启动，正在读取上下文…';
  if (event.type !== 'assistant') return null;
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  const tool = [...content].reverse().find((block) => block?.type === 'tool_use');
  if (tool) return describeTool(tool.name, tool.input || {});
  const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join(' ');
  return text.trim() ? short(text, 80) : null;
}

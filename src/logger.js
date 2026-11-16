/** 内存日志环：给管理页看最近的服务日志，不写额外文件。 */
const MAX = 600;
const entries = [];
let installed = false;

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function installLogCapture() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      entries.push({
        level,
        message: args.map(stringify).join(' ').slice(0, 4000),
        at: new Date().toISOString()
      });
      if (entries.length > MAX) entries.shift();
      original(...args);
    };
  }
}

export function recentLogs(limit = 200) {
  const count = Math.min(MAX, Math.max(1, Number(limit) || 200));
  return entries.slice(-count);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = process.env.JINGJING_DATA_DIR
  ? path.resolve(process.env.JINGJING_DATA_DIR)
  : path.join(ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'jingjing.db');
export const SANDBOX_DIR = path.join(DATA_DIR, 'sandbox');

export const HOST = process.env.JINGJING_HOST || '127.0.0.1';
export const PORT = Number(process.env.JINGJING_PORT || 7777);

export const DEFAULT_SETTINGS = {
  assistantName: '静静',
  userName: '你',
  // demo（本地模拟）| openai（OpenAI 兼容接口：DeepSeek、Kimi、GLM、中转站、本地网关都走这条）| ollama
  provider: 'demo',
  model: 'deepseek-chat',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  ollamaUrl: 'http://127.0.0.1:11434',
  temperature: 0.6,
  proactive: true,
  concurrency: 2,
  defaultCwd: SANDBOX_DIR,
  workspaces: [
    { id: 'default', name: '默认工作区', path: SANDBOX_DIR }
  ],
  defaultWorkspaceId: 'default',
  autoRemember: true,
  // 没有流程、规则、点名时交给谁。空 = 自动（最便宜的文本 Worker）；指定的 Worker 不可用时也回到自动。
  fallbackWorker: '',
  maxHops: 6,
  // 额外读取工作流程（.md）的文件夹；<data>/workflows 总会被读取。
  workflowDirs: [],
  // 已结束超过 afterDays 天的任务和旧消息，打包到 <data>/archive 后从数据库清理。
  archive: { enabled: true, afterDays: 90 },
  queuePaused: false,
  persona: '平静、具体、不奉承，像一个可靠的同事。',
  // 静静的心智：记住聊过的事、有心情、认得人、每天反思一次。
  mind: {
    // 人设怎么进化：auto 她反思后自己改（留历史可回退）；propose 先在对话里提议，你点头才改；off 只有你能改。
    evolve: 'auto',
    // 每天几点反思：把这一天的经历整理成长期记忆、更新对人的印象、决定要不要调整自己。
    reflectAt: '03:30',
    // 有心情：心情随对话和任务变化，自然地影响语气；关掉后始终平静。
    moods: true
  },
  channels: {
    telegram: { enabled: false, token: '', chatId: '' },
    feishu: { enabled: false, webhook: '' },
    webhook: { enabled: false, url: '' }
  },
  claude: {
    enabled: true
  }
};

/**
 * 运行模式只有三种；旧版本把“OpenAI 兼容接口”存成 deepseek，读取时统一成 openai，
 * 这样已经存下的配置和会话不用迁移也能继续用。
 */
export function normalizeProvider(value) {
  if (value === 'ollama') return 'ollama';
  if (value === 'openai' || value === 'deepseek') return 'openai';
  return 'demo';
}

export function normalizeWorkspaces(settings) {
  const list = Array.isArray(settings.workspaces) ? settings.workspaces : [];
  const cleaned = [];
  const ids = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    const name = String(item.name || '').trim();
    const dir = String(item.path || '').trim();
    if (!id || !name || !dir || ids.has(id)) continue;
    ids.add(id);
    const aliases = Array.isArray(item.aliases)
      ? [...new Set(item.aliases.map((alias) => String(alias || '').trim().slice(0, 40)).filter(Boolean))].slice(0, 8)
      : [];
    cleaned.push({ id, name: name.slice(0, 60), path: dir, ...(aliases.length ? { aliases } : {}) });
  }
  if (!cleaned.length) {
    cleaned.push({
      id: 'default',
      name: '默认工作区',
      path: String(settings.defaultCwd || SANDBOX_DIR)
    });
  }
  settings.workspaces = cleaned;
  if (!cleaned.some((item) => item.id === settings.defaultWorkspaceId)) {
    settings.defaultWorkspaceId = cleaned[0].id;
  }
  return settings;
}

export const TASK_STATUS = {
  queued: '排队中',
  running: '执行中',
  waiting_approval: '等你拍板',
  done: '已完成',
  failed: '失败了',
  cancelled: '已取消'
};


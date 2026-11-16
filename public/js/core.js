// 公共的状态、文案、工具函数和接口调用。其他模块都从这里取，不互相塞全局变量。

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------- 文案 -------------------------------- */

export const STATUS_LABEL = {
  queued: '排队中',
  running: '执行中',
  waiting_approval: '等你拍板',
  done: '已完成',
  failed: '失败了',
  cancelled: '已取消'
};
export const PLUGIN_TYPE_LABEL = { poll: '轮询', webhook: 'Webhook 推送', stream: '长连接', manual: '手动', watch: '文件监听' };
export const ABILITY_LABEL = { text: '文本', 'write-file': '写文件', 'manage-files': '整理文件', code: '代码' };
export const LAYER_LABEL = { profile: '画像', semantic: '语义', episodic: '情景', working: '工作' };
export const MEMORY_DOMAIN_LABEL = { work: '业务记忆', persona: '人格记忆' };
export const WORKFLOW_STATUS_LABEL = { active: '生效', candidate: '候选', disabled: '已停用', dismissed: '已忽略' };
export const RUN_STATUS_LABEL = { running: '执行中', done: '完成', failed: '失败', cancelled: '取消', timeout: '超时', waiting_approval: '等拍板', interrupted: '被重启打断' };
export const ORIGIN_LABEL = { proactive: '规则发现', manual: '手动创建', seed: '演示数据', chat: '对话创建', web: '对话创建' };
export const EVENT_LABEL = {
  'task/created': '已创建',
  'task/started': '开始执行',
  'task/progress': '进度',
  'task/waiting_approval': '等待你拍板',
  'approval/resolved': '你已拍板',
  'task/retry': '失败重试',
  'task/done': '完成',
  'task/failed': '失败',
  'task/cancelled': '取消',
  'task/recovered': '进程重启后恢复',
  'task/proactive': '由规则触发',
  'task/edited': '已编辑',
  'task/retried': '重新排队',
  'workflow/proposed': '总结成工作流程',
  'task/merged': '合并了新事件',
  'workflow/skipped': '没有总结流程',
  'task/replied': '已发回原会话',
  'task/reply_failed': '发回原会话失败'
};
export const ACTIVE_STATUSES = ['queued', 'running', 'waiting_approval'];

/* ------------------------------- 状态 -------------------------------- */

export const state = {
  settings: null,
  workers: {},
  workerRules: [],
  workflows: { workflows: [], dirs: [], errors: [], root: '' },
  pluginDrafts: [],
  stats: {},
  tasks: [],
  approvals: [],
  memories: [],
  memoryStats: [],
  // 记忆页看的是哪个域：work 业务 / persona 人格；以及按层筛选。
  memDomain: 'work',
  memLayer: '',
  memQuery: '',
  memArchived: false,
  memArchivedCount: 0,
  // 静静的心智：心情、认识的人、上次反思、人设的历史。
  mind: null,
  memoryDomains: { work: 0, persona: 0 },
  messages: [],
  rules: [],
  plugins: [],
  pluginErrors: [],
  channels: {},
  server: {},
  sessionId: 'main',
  view: 'chat',
  taskFilter: 'all',
  taskQuery: '',
  // 任务详情：桌面在任务页右侧面板里看（selected），别的页面从右边滑出（drawer）。
  selectedTaskId: null,
  drawerTaskId: null,
  busy: false,
  connected: false,
  pairing: null,
  pairVisible: false,
  adminOverview: null,
  adminLogs: [],
  archives: null,
  settingsPage: null,
  pluginPage: 'list'
};

/* ----------------------------- 订阅更新 ------------------------------ */
// 数据变了就 changed('tasks')，关心它的界面自己决定要不要重画。

const listeners = new Map();

export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
}

export function changed(...topics) {
  const called = new Set();
  for (const topic of topics) {
    for (const fn of listeners.get(topic) || []) {
      if (called.has(fn)) continue;
      called.add(fn);
      try { fn(topic); } catch (err) { console.error(err); }
    }
  }
}

/* ------------------------------- 工具 -------------------------------- */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

/** 极简 Markdown：标题、列表、代码块、粗体、行内代码、链接。输入先转义，不会注入 HTML。 */
export function md(src) {
  const lines = esc(src).split('\n');
  const out = [];
  let list = null;
  let code = null;
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (code === null) { closeList(); code = []; continue; }
      out.push(`<pre class="codeblock">${code.join('\n')}</pre>`);
      code = null;
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (!line.trim()) { closeList(); continue; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) { closeList(); out.push(`<h3>${inline(h[1])}</h3>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (code !== null) out.push(`<pre class="codeblock">${code.join('\n')}</pre>`);
  return out.join('');
}

export function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 45) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 172800) return `昨天 ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function clock(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function durationText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

export function tokensText(n) {
  if (!n) return '0';
  return n > 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function sizeText(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d) return `${d}天 ${h}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function countsText(counts = {}) {
  const parts = [];
  if (counts.tasks) parts.push(`${counts.tasks} 个任务`);
  if (counts.task_events) parts.push(`${counts.task_events} 条事件`);
  if (counts.messages) parts.push(`${counts.messages} 条消息`);
  return parts.join('，') || '没有内容';
}

/** a 的版本号比 b 新。 */
export function versionNewer(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

export function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

export function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** 桌面布局（左侧栏 + 主从面板）。窄于这个宽度退回手机布局。 */
const wideQuery = window.matchMedia('(min-width: 860px)');
export const isWide = () => wideQuery.matches;
export function onWideChange(fn) {
  wideQuery.addEventListener?.('change', () => fn(wideQuery.matches));
}

export const isTyping = (el) => Boolean(el?.closest?.('input, textarea, select, [contenteditable="true"]'));

export async function copyText(text, okMessage = '已复制。') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
    return true;
  } catch {
    toast('复制失败，请手动选中复制。');
    return false;
  }
}

/* ----------------------------- 提示与登录 ---------------------------- */

export function toast(message, ms = 2800) {
  const box = $('#toasts');
  if (!box || !message) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  box.append(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

export function showLogin(message = '') {
  const box = $('#login');
  if (!box) return;
  box.hidden = false;
  const error = $('#login-error');
  if (error) error.textContent = message;
  setTimeout(() => $('#login-key')?.focus(), 80);
}

export function hideLogin() {
  const box = $('#login');
  if (box) box.hidden = true;
}

/* ------------------------------- 接口 -------------------------------- */

export async function api(path, { method = 'GET', body, timeoutMs = 0 } = {}) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller?.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，可能是页面连接太多或主机正忙；关掉多余标签页后再试。');
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    if (res.status === 401 && path !== '/api/auth/login') showLogin('配对已失效，请输入主机上的配对码。');
    throw err;
  }
  return data;
}

/** 上传 zip 安装插件（来源插件和 Worker 插件共用一个接口）。 */
export async function uploadPlugin(file) {
  const response = await fetch('/api/plugins/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `安装失败（${response.status}）`);
  return data;
}

/* ----------------------------- 领域小工具 ---------------------------- */

// Worker 的名称和图标都来自各自的 plugin.json；已删除的 Worker 显示 id。
export function workerLabel(id) {
  return state.workers?.[id]?.label || id || '自动';
}
export function workerGlyph(id) {
  return state.workers?.[id]?.glyph || '工';
}
export function workerIds() {
  return Object.keys(state.workers || {}).filter((id) => state.workers[id]?.available || !state.workers[id]?.source || state.workers[id]?.source === 'builtin');
}

export function taskById(id) {
  return state.tasks.find((t) => t.id === id) || null;
}

export function approvalFor(task) {
  if (!task) return null;
  return state.approvals.find((a) => a.task_id === task.id && a.status === 'pending') || null;
}

export function workflowById(id) {
  return (state.workflows?.workflows || []).find((w) => w.id === id) || null;
}

export function upsertTask(task) {
  if (!task) return;
  const index = state.tasks.findIndex((t) => t.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);
}

export function defaultWorkspaceName() {
  const list = state.settings?.workspaces || [];
  return list.find((ws) => ws.id === state.settings?.defaultWorkspaceId)?.name || '默认';
}

/** 选了一个文件夹：已有同路径的工作区就用它，没有就新建一个并保存。 */
export async function ensureWorkspaceForPath(dir) {
  const path = String(dir || '').trim();
  if (!path) throw new Error('没有选择目录');
  const list = state.settings?.workspaces || [];
  const existing = list.find((item) => item.path === path);
  if (existing) return existing;
  const name = path.split('/').filter(Boolean).pop() || '工作区';
  const workspace = { id: `ws_${Date.now().toString(36)}`, name, path };
  const data = await api('/api/settings', {
    method: 'PUT',
    body: { workspaces: [...list, workspace], defaultWorkspaceId: state.settings.defaultWorkspaceId }
  });
  state.settings = data.settings;
  changed('settings');
  return state.settings.workspaces.find((item) => item.path === path) || workspace;
}

export function pickFolder() {
  return api('/api/system/pick-folder', { method: 'POST' });
}

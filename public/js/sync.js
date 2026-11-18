// 和主机同步：首屏快照（/api/bootstrap）+ 实时事件（SSE）。收到数据只改 state 再广播，界面各自重画。
import { state, changed, toast, api, upsertTask, taskById } from './core.js';
import { setConnectionLive, updateBadges } from './shell.js';
import { noteIncoming } from './chat.js';
import { refreshTaskDetail, removeTask } from './tasks.js';

const ALL_TOPICS = ['settings', 'workers', 'workerRules', 'tasks', 'approvals', 'messages', 'memories', 'rules', 'workflows', 'drafts', 'plugins', 'stats', 'channels', 'mind'];

export function applySnapshot(data) {
  Object.assign(state, {
    settings: data.settings,
    workers: data.workers,
    capabilities: data.capabilities || state.capabilities,
    stats: data.stats,
    tasks: data.tasks,
    approvals: data.approvals,
    memories: data.memories,
    memoryStats: data.memoryStats,
    memoryDomains: data.memoryDomains || state.memoryDomains,
    messages: data.messages,
    rules: data.rules,
    workerRules: data.workerRules || [],
    workflows: data.workflows || { workflows: [], dirs: [], errors: [], root: '' },
    pluginDrafts: data.pluginDrafts || [],
    plugins: data.plugins || [],
    pluginErrors: data.pluginErrors || [],
    channels: data.channels,
    mind: data.mind || null,
    server: data.server,
    sessionId: data.sessionId
  });
  changed(...ALL_TOPICS);
  updateBadges();
  if (state.selectedTaskId) refreshTaskDetail(state.selectedTaskId);
  if (state.drawerTaskId) refreshTaskDetail(state.drawerTaskId);
}

export async function resync() {
  applySnapshot(await api('/api/bootstrap'));
}

let openedOnce = false;
let mindTimer = null;
let source = null;
let retryTimer = null;

export function disconnectEvents() {
  if (source) {
    source.close();
    source = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  setConnectionLive(false);
}

export function connectEvents() {
  if (document.hidden || source) return;
  const es = new EventSource('/api/stream');
  source = es;

  es.onopen = () => {
    setConnectionLive(true);
    if (openedOnce) resync().catch(() => {});
    openedOnce = true;
  };
  es.onerror = () => {
    setConnectionLive(false);
    if (source !== es) return;
    source = null;
    es.close();
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connectEvents();
    }, 3000);
  };

  const on = (type, fn) => es.addEventListener(type, (event) => {
    try { fn(JSON.parse(event.data).payload || {}); } catch (err) { console.warn(err); }
  });

  on('chat/message', ({ message }) => {
    if (!message || state.messages.some((m) => m.id === message.id)) return;
    // 只要主人这段对话里的消息。
    if (message.session_id && message.session_id !== state.sessionId) return;
    state.messages.push(message);
    changed('messages');
    noteIncoming(message);
  });

  on('task/created', ({ task }) => {
    upsertTask(task);
    changed('tasks');
  });

  on('task/updated', ({ task }) => {
    upsertTask(task);
    changed('tasks');
    refreshTaskDetail(task.id);
  });

  on('task/progress', ({ taskId, message }) => {
    const task = taskById(taskId);
    if (!task) return;
    task.progress = message;
    changed('progress');
  });

  on('task/deleted', ({ id }) => removeTask(id));

  on('approval/created', ({ approval }) => {
    if (!state.approvals.some((a) => a.id === approval.id)) state.approvals.unshift(approval);
    const task = taskById(approval.task_id);
    toast(`「${task?.title || '任务'}」在等你拍板。`, 3200);
    changed('approvals');
  });

  on('approval/resolved', ({ approval }) => {
    state.approvals = state.approvals.filter((a) => a.id !== approval.id);
    changed('approvals');
  });

  on('stats/updated', (stats) => {
    state.stats = stats;
    changed('stats');
  });

  on('rules/updated', ({ rules }) => {
    state.rules = rules || [];
    changed('rules');
  });

  on('plugin-drafts/updated', ({ drafts }) => {
    state.pluginDrafts = drafts || [];
    changed('drafts');
  });

  on('workflows/updated', (payload) => {
    state.workflows = payload;
    changed('workflows');
  });

  on('memory/updated', () => changed('memories'));
  on('memory/created', () => changed('memories'));
  on('memory/deleted', () => changed('memories'));

  // 心情、认识的人、反思、人设变了：拉一份最新的心智快照（连着来的几条合成一次）。
  on('mind/updated', () => {
    clearTimeout(mindTimer);
    mindTimer = setTimeout(() => {
      api('/api/mind').then((mind) => { state.mind = mind; changed('mind'); }).catch(() => {});
    }, 300);
  });

  on('settings/updated', ({ settings }) => {
    state.settings = settings;
    changed('settings');
  });

  // 拍板时选了「以后这类都交给它」会新建一条分配规则。
  on('worker-rules/updated', ({ rules }) => {
    if (!Array.isArray(rules)) return;
    state.workerRules = rules;
    changed('workerRules');
  });

  on('plugins/updated', ({ plugins, errors }) => {
    state.plugins = plugins;
    if (Array.isArray(errors)) state.pluginErrors = errors;
    changed('plugins');
  });

  on('plugin/status', ({ plugin }) => {
    if (!plugin) return;
    const index = state.plugins.findIndex((p) => p.id === plugin.id);
    if (index >= 0) state.plugins[index] = plugin;
    changed('pluginStatus');
  });

  on('task/replied', ({ label, by }) => {
    if (by === 'auto') toast(`任务结果已自动发到「${label}」。`);
  });
  on('channel/delivery', (item) => {
    if (!item.ok) toast(`${item.channel} 通知发送失败：${item.error || ''}`);
  });
}

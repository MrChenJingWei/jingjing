const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STATUS_LABEL = {
  queued: '排队中',
  running: '执行中',
  waiting_approval: '等你拍板',
  done: '已完成',
  failed: '失败了',
  cancelled: '已取消'
};
const PLUGIN_TYPE_LABEL = { poll: '轮询', webhook: 'Webhook 推送', stream: '长连接', manual: '手动', watch: '文件监听' };
const WORKER_LABEL = { llm: '问答', shell: '文件操作', file: '文件生成', claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness', memory: '记忆整理' };
const WORKER_OPTIONS = ['llm', 'shell', 'claude', 'codex', 'dsh', 'memory'];
function workerLabel(id) {
  return state.workers?.[id]?.label || WORKER_LABEL[id] || id;
}
function workerGlyph(id) {
  return state.workers?.[id]?.glyph || WORKER_GLYPH[id] || '工';
}
function workerIds() {
  return Object.keys(state.workers || {}).filter((id) => state.workers[id]?.available || !state.workers[id]?.source || state.workers[id]?.source === 'builtin');
}
const WORKER_GLYPH = { llm: '答', shell: '件', file: '文', claude: '码', codex: '码', dsh: 'H', memory: '忆' };
const LAYER_LABEL = { profile: '画像', semantic: '语义', episodic: '情景', working: '工作' };
const EVENT_LABEL = {
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
  'task/retried': '重新排队'
};

const state = {
  settings: null,
  workers: {},
  stats: {},
  tasks: [],
  approvals: [],
  memories: [],
  memoryStats: [],
  messages: [],
  rules: [],
  plugins: [],
  pluginErrors: [],
  channels: {},
  server: {},
  sessionId: 'main',
  view: 'chat',
  filter: 'all',
  memQuery: '',
  openTaskId: null,
  busy: false,
  connected: false,
  pairing: null,
  pairVisible: false,
  adminOverview: null,
  adminLogs: [],
  settingsPage: 'index'
};

/* ------------------------------- utils -------------------------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

function md(src) {
  const text = esc(src);
  const lines = text.split('\n');
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
    const h = line.match(/^#{2,4}\s+(.*)$/);
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

function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 45) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 172800) return `昨天 ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function clock(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function toast(message, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

async function api(path, { method = 'GET', body, timeoutMs = 0 } = {}) {
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

function showLogin(message = '') {
  const box = $('#login');
  if (!box) return;
  box.hidden = false;
  const error = $('#login-error');
  if (error) error.textContent = message;
  setTimeout(() => $('#login-key')?.focus(), 80);
}

function hideLogin() {
  const box = $('#login');
  if (box) box.hidden = true;
}

$('#login-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-btn');
  const error = $('#login-error');
  const key = $('#login-key').value.trim();
  if (!key) return;
  button.disabled = true;
  if (error) error.textContent = '';
  try {
    await api('/api/auth/login', { method: 'POST', body: { key } });
    location.reload();
  } catch (err) {
    if (error) error.textContent = err.message;
    button.disabled = false;
  }
});

/* ------------------------------- theme -------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#131511' : '#F5F2EC');
  localStorage.setItem('jingjing-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('jingjing-theme');
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

$('#theme-btn')?.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
let deferredInstallPrompt = null;

function updateInstallStatus() {
  const status = $('#install-status');
  const button = $('#install-btn');
  if (status) {
    status.textContent = standalone
      ? '已安装：当前是独立窗口运行。'
      : deferredInstallPrompt
        ? '可以安装：点上面的按钮，或浏览器菜单里的「安装应用」。'
        : isIOS
          ? 'iPhone / iPad 请用 Safari 的分享按钮 → 添加到主屏幕。'
          : '当前浏览器没有提供一键安装，请按上面的步骤手动添加。';
  }
  if (button) {
    button.hidden = standalone || (!deferredInstallPrompt && !isIOS);
  }
}

function showInstallHelp() {
  switchView('settings');
  openSettingsPage('install');
  setTimeout(() => {
    const panel = $('#install-panel');
    if (!panel) return;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    panel.classList.add('is-flash');
    setTimeout(() => panel.classList.remove('is-flash'), 1600);
  }, 220);
}

async function promptInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    try {
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') toast('正在安装静静…');
      else toast('已取消安装，随时可以在设置里再装。');
    } catch { /* ignore */ }
    deferredInstallPrompt = null;
    updateInstallStatus();
  } else {
    showInstallHelp();
    toast('请按设置页里的步骤添加到主屏幕。', 3600);
  }
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallStatus();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  toast('静静已安装到这台设备。');
  updateInstallStatus();
});

$('#install-btn')?.addEventListener('click', promptInstall);
$('#install-app')?.addEventListener('click', promptInstall);
$('#copy-install')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.origin);
    toast(`安装地址已复制：${location.origin}`);
    if (/127\.0\.0\.1|localhost/.test(location.origin)) {
      toast('手机安装请先换成局域网或 Tailscale 地址。', 4200);
    }
  } catch {
    toast(location.origin);
  }
});

$('#conn')?.addEventListener('click', () => location.reload());
$('#conn')?.setAttribute('title', '点击刷新页面并重新连接');

/* ------------------------------- views -------------------------------- */

function switchView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  if (name === 'tasks') renderTasks();
  if (name === 'admin') loadAdmin();
  if (name === 'memory') loadMemories();
  if (name === 'settings') { showSettingsIndex(); fillSettings(); }
  if (name === 'chat') { renderChat(); clearDot(); }
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

window.addEventListener('hashchange', () => {
  const name = location.hash.replace('#', '');
  if (['chat', 'tasks', 'memory', 'admin', 'settings'].includes(name)) switchView(name);
});

$$('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.tab)));

function clearDot() {
  const dot = $('#dot-chat');
  if (dot) dot.hidden = true;
}

/* ------------------------------- chat --------------------------------- */

let stickToBottom = true;

function taskById(id) {
  return state.tasks.find((t) => t.id === id) || null;
}

function approvalFor(task) {
  if (!task) return null;
  return state.approvals.find((a) => a.task_id === task.id && a.status === 'pending') || null;
}

function statusPill(status) {
  return `<span class="status-pill" data-s="${status}">${STATUS_LABEL[status] || status}</span>`;
}

function inlineTaskCard(task) {
  if (!task) return '';
  const approval = approvalFor(task);
  const progress = task.status === 'running' && task.progress
    ? `<div class="task-card-progress"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1.4s linear infinite"><path d="M12 3a9 9 0 109 9" stroke-linecap="round"/></svg>${esc(task.progress)}</div>`
    : '';
  const result = task.status === 'done' && task.result
    ? `<div class="task-card-body">${md(task.result.split('\n').slice(0, 3).join('\n'))}</div>`
    : task.status === 'failed'
      ? `<div class="task-card-body" style="color:var(--danger)">${esc((task.error || task.result || '').slice(0, 160))}</div>`
      : '';
  return `
    <div class="task-card" data-task-id="${task.id}">
      <div class="task-card-head">
        <div class="task-card-icon">${workerGlyph(task.worker)}</div>
        <div class="task-card-main">
          <div class="task-card-title">${esc(task.title)}</div>
          <div class="task-card-meta">
            ${statusPill(task.status)}
            <span>${workerLabel(task.worker)}</span>
            <span>·</span>
            <span>${timeAgo(task.created_at)}</span>
          </div>
        </div>
      </div>
      ${progress}
      ${result}
      ${approval ? approvalBlock(task, approval) : ''}
      <div class="task-card-actions">
        <button class="mini-btn" data-action="open-task" data-id="${task.id}">查看详情</button>
        ${['queued', 'running', 'waiting_approval'].includes(task.status)
          ? `<button class="mini-btn danger" data-action="cancel-task" data-id="${task.id}">停止</button>`
          : ''}
      </div>
    </div>`;
}

function approvalBlock(task, approval) {
  return `
    <div class="approval">
      <div class="approval-q">${esc(approval.question)}</div>
      <div class="approval-opts">
        ${(approval.options || []).map((opt, i) => `
          <button class="mini-btn ${i === 0 ? 'primary' : ''}" data-action="approve" data-id="${task.id}" data-choice="${i}">${esc(opt)}</button>
        `).join('')}
      </div>
      <div class="approval-note">选完后会从挂起点恢复，接着原来的上下文继续跑。</div>
    </div>`;
}

function messageHtml(msg, index) {
  const isUser = msg.role === 'user';
  const task = msg.task_id ? taskById(msg.task_id) : null;
  const body = isUser ? `<p>${esc(msg.text).replace(/\n/g, '<br>')}</p>` : md(msg.text);
  return `
    <div class="msg ${isUser ? 'user' : 'assistant'}" data-msg="${msg.id}">
      ${isUser ? '' : '<div class="msg-avatar">静</div>'}
      <div class="msg-body">
        <div class="msg-author">${isUser ? '你' : '静静'}</div>
        <div class="bubble">${body}</div>
        ${task ? inlineTaskCard(task) : ''}
        ${index === state.messages.length - 1 ? `<div class="msg-time">${clock(msg.created_at)}</div>` : ''}
      </div>
    </div>`;
}

function renderChat({ forceBottom = false, initial = false } = {}) {
  const scroller = $('#chat-scroll');
  const nearBottom = !initial && scroller.clientHeight > 0 &&
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  $('#messages').innerHTML = state.messages.map(messageHtml).join('');
  const pending = state.approvals.length;
  const running = state.tasks.filter((t) => ['running', 'queued'].includes(t.status)).length;
  $('#presence-title').textContent = pending
    ? `有 ${pending} 件事在等你拍板。`
    : running
      ? `我正盯着 ${running} 件事。`
      : '我在。';
  $('#presence-sub').textContent = pending
    ? '打开任务板，或者直接在这里选一个选项。'
    : '任务、记忆和 Agent 都留在本机。需要拍板时我会停下来等你。';
  const cta = $('#presence-cta');
  if (cta) {
    cta.hidden = pending === 0;
    cta.textContent = `去拍板 · ${pending}`;
  }
  if (forceBottom || nearBottom) {
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }
}

function scrollChatToBottom() {
  const scroller = $('#chat-scroll');
  requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}

async function sendMessage(text) {
  const value = String(text ?? $('#input').value).trim();
  if (!value || state.busy) return;
  state.busy = true;
  $('#send-btn').disabled = true;
  $('#typing').hidden = false;
  $('#input').value = '';
  autoGrow();

  const temp = {
    id: `tmp_${Date.now()}`,
    role: 'user',
    text: value,
    kind: 'text',
    created_at: new Date().toISOString(),
    pending: true
  };
  state.messages.push(temp);
  renderChat({ forceBottom: true });

  try {
    const data = await api('/api/chat', {
      method: 'POST',
      body: { text: value, sessionId: state.sessionId },
      timeoutMs: 60000
    });
    state.messages = state.messages.filter((message) => message.id !== temp.id);
    const add = (message) => {
      if (!message) return;
      if (!state.messages.some((item) => item.id === message.id)) state.messages.push(message);
    };
    add(data.userMessage);
    add(data.reply);
    if (data.stats) state.stats = data.stats;
    renderChat({ forceBottom: true });
  } catch (err) {
    state.messages = state.messages.filter((message) => message.id !== temp.id);
    renderChat({ forceBottom: true });
    toast(err.message);
    if (!$('#input').value) {
      $('#input').value = value;
      autoGrow();
    }
  } finally {
    state.busy = false;
    $('#send-btn').disabled = false;
    $('#typing').hidden = true;
  }
}

function autoGrow() {
  const el = $('#input');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 132) + 'px';
}

$('#composer')?.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});
$('#input')?.addEventListener('input', autoGrow);
$('#input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$$('#quick-chips .chip').forEach((chip) => {
  chip.addEventListener('click', () => sendMessage(chip.dataset.say));
});

/* ------------------------------- tasks -------------------------------- */

function filteredTasks() {
  if (state.filter === 'all') return state.tasks;
  if (state.filter === 'active') return state.tasks.filter((t) => ['queued', 'running'].includes(t.status));
  return state.tasks.filter((t) => t.status === state.filter);
}

function renderTasks() {
  const active = state.tasks.filter((t) => ['queued', 'running'].includes(t.status)).length;
  const waiting = state.tasks.filter((t) => t.status === 'waiting_approval').length;
  $('#stat-row').innerHTML = `
    <div class="stat"><div class="stat-value">${active}</div><div class="stat-label">进行中</div></div>
    <div class="stat warm"><div class="stat-value">${waiting}</div><div class="stat-label">等你拍板</div></div>
    <div class="stat"><div class="stat-value">${state.stats.doneToday ?? 0}</div><div class="stat-label">今日完成</div></div>
    <div class="stat accent"><div class="stat-value">${state.stats.memories ?? 0}</div><div class="stat-label">条记忆</div></div>`;

  const tasks = filteredTasks();
  if (!tasks.length) {
    $('#task-list').innerHTML = `<div class="empty"><div class="empty-mark">静</div><p>这个分类下还没有任务。<br>回对话里说一句，或者点右上角新建。</p></div>`;
    return;
  }
  $('#task-list').innerHTML = tasks.map((t) => {
    const approval = approvalFor(t);
    const subtitle = t.status === 'waiting_approval' && approval
      ? approval.question
      : t.status === 'running'
        ? t.progress || '执行中…'
        : t.status === 'failed'
          ? (t.error || '').slice(0, 80)
          : (t.result || t.prompt || '').split('\n')[0].slice(0, 80);
    return `
      <button class="task-row ${t.status === 'waiting_approval' ? 'is-waiting' : ''}" data-action="open-task" data-id="${t.id}">
        <span class="task-row-icon">${workerGlyph(t.worker)}</span>
        <span class="task-row-main">
          <span class="task-row-title">${esc(t.title)} ${statusPill(t.status)}</span>
          <span class="task-row-sub">${esc(subtitle || '—')}</span>
          <span class="task-row-meta">
            <span class="worker-tag">${workerLabel(t.worker)}</span>
            <span>${t.origin === 'proactive' ? '规则发现' : t.origin === 'manual' ? '手动创建' : t.origin === 'seed' ? '演示数据' : '对话创建'}</span>
            <span>·</span>
            <span>${timeAgo(t.created_at)}</span>
          </span>
        </span>
        <span class="task-row-arrow">›</span>
      </button>`;
  }).join('');
}

$$('#task-filters .filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter;
    $$('#task-filters .filter').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderTasks();
  });
});

/* ------------------------------- drawer ------------------------------- */

async function openTask(id) {
  state.openTaskId = id;
  $('#drawer-backdrop').hidden = false;
  $('#drawer').hidden = false;
  $('#drawer').innerHTML = '<div class="empty"><p>读取任务…</p></div>';
  try {
    const data = await api(`/api/tasks/${id}`);
    if (state.openTaskId === id) renderDrawer(data);
  } catch (err) {
    toast(err.message);
    closeDrawer();
  }
}

function closeDrawer() {
  state.openTaskId = null;
  $('#drawer').hidden = true;
  $('#drawer-backdrop').hidden = true;
}

function eventDetail(e) {
  if (!e.data) return '';
  if (e.type === 'task/created') return `${workerLabel(e.data.worker)}`;
  if (e.type === 'approval/resolved') return e.data.option ? `选择：${e.data.option}` : '';
  if (e.type === 'task/retry') return `第 ${e.data.attempt} 次尝试：${e.data.error || ''}`;
  if (e.type === 'task/waiting_approval') return e.data.question || '';
  if (e.type === 'task/failed') return (e.data.error || '').slice(0, 120);
  if (e.type === 'task/proactive') return e.data.rule || '';
  return '';
}

function renderDrawer({ task, events, approval }) {
  const pending = approval && approval.status === 'pending' ? approval : null;
  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div>
        <p class="eyebrow">任务详情</p>
        <h3>${esc(task.title)}</h3>
      </div>
      <button class="drawer-close" data-action="close-drawer" aria-label="关闭">✕</button>
    </div>
    <div class="drawer-meta">
      ${statusPill(task.status)}
      <span class="worker-tag">${workerLabel(task.worker)}</span>
      <span>${tokensText(task.tokens)} tokens</span>
      <span>创建于 ${timeAgo(task.created_at)}</span>
    </div>
    <div class="drawer-section">
      <h4>交给 Worker 的原始指令</h4>
      <div class="drawer-result">${esc(task.prompt)}</div>
    </div>
    <div class="drawer-section">
      <h4>工作目录</h4>
      ${task.status === 'running' ? `<div class="drawer-result">${esc(task.cwd || '未指定')}</div>` : `
        <div class="task-workspace-edit">
          <select data-task-worker="${task.id}" title="Worker">
            ${workerIds().map((worker) => `<option value="${worker}" ${task.worker === worker ? 'selected' : ''}>${workerLabel(worker)}</option>`).join('')}
          </select>
          <select data-task-workspace="${task.id}">
            ${(state.settings?.workspaces || []).map((ws) => `<option value="${esc(ws.path)}" ${ws.path === task.cwd ? 'selected' : ''}>${esc(ws.name)} · ${esc(ws.path)}</option>`).join('')}
            ${task.cwd && !(state.settings?.workspaces || []).some((ws) => ws.path === task.cwd) ? `<option value="${esc(task.cwd)}" selected>当前 · ${esc(task.cwd)}</option>` : ''}
            <option value="__custom__">选择自定义文件夹…</option>
          </select>
          <button type="button" class="mini-btn" data-action="save-task-workspace" data-id="${task.id}">应用</button>
        </div>
        <small class="field-help">当前：${esc(task.cwd || '未指定')}</small>`}
    </div>
    ${task.status === 'running' && task.progress ? `
      <div class="drawer-section">
        <h4>正在做</h4>
        <div class="drawer-result" style="color:var(--accent)">${esc(task.progress)}</div>
      </div>` : ''}
    ${task.result ? `
      <div class="drawer-section">
        <h4>${task.status === 'failed' ? '错误' : '结果'}</h4>
        <div class="drawer-result">${esc(task.result)}</div>
      </div>` : ''}
    ${pending ? `
      <div class="drawer-section">
        <h4>需要你拍板</h4>
        ${approvalBlock(task, pending)}
      </div>` : ''}
    <div class="drawer-actions">
      ${['queued', 'running', 'waiting_approval'].includes(task.status)
        ? `<button class="mini-btn danger" data-action="cancel-task" data-id="${task.id}">停止这个任务</button>`
        : ''}
      <button class="mini-btn" data-action="close-drawer">关闭</button>
    </div>
    <div class="drawer-section">
      <h4>事件时间线</h4>
      <ul class="timeline">
        ${(events || []).map((e) => `
          <li>
            <span>${EVENT_LABEL[e.type] || e.type}</span><span class="t-time">${clock(e.created_at)}</span>
            ${eventDetail(e) ? `<div class="t-data">${esc(eventDetail(e))}</div>` : ''}
          </li>`).join('')}
      </ul>
    </div>`;
}

function tokensText(n) {
  if (!n) return '0';
  return n > 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

$('#drawer-backdrop')?.addEventListener('click', closeDrawer);

$('#drawer')?.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-task-workspace]');
  if (!select || select.value !== '__custom__') return;
  try {
    const picked = await api('/api/system/pick-folder', { method: 'POST' });
    await ensureWorkspaceForPath(picked.path);
    const option = document.createElement('option');
    option.value = picked.path;
    option.textContent = `自定义 · ${picked.path}`;
    select.append(option);
    select.value = picked.path;
  } catch (err) {
    toast(err.message);
  }
});

async function approveTask(taskId, choice) {
  try {
    await api(`/api/tasks/${taskId}/approve`, { method: 'POST', body: { choice } });
    toast(choice >= 0 ? '收到，从停机点继续处理。' : '好，这件事停下了。');
  } catch (err) {
    toast(`${err.message}，正在同步最新状态…`, 4000);
    resync().catch(() => {});
  }
}

async function cancelTask(taskId) {
  try {
    await api(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
    toast('已停止。');
  } catch (err) {
    toast(`${err.message}，正在同步最新状态…`, 4000);
    resync().catch(() => {});
  }
}

/* ------------------------------- memory ------------------------------- */

async function loadMemories(q = state.memQuery) {
  state.memQuery = q;
  try {
    const data = await api(`/api/memories${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    state.memories = data.memories;
    state.memoryStats = data.stats;
    renderMemories();
  } catch (err) {
    toast(err.message);
  }
}

function renderMemories() {
  const total = state.memoryStats.reduce((sum, s) => sum + s.count, 0);
  $('#mem-stats').innerHTML = `
    <span class="mem-stat"><b>${total}</b> 条记忆</span>
    ${state.memoryStats.map((s) => `<span class="mem-stat">${LAYER_LABEL[s.layer] || s.layer} <b>${s.count}</b></span>`).join('')}`;

  if (!state.memories.length) {
    $('#memory-list').innerHTML = `<div class="empty"><div class="empty-mark">忆</div><p>${state.memQuery ? '没有搜到相关的记忆。' : '还没有记忆。对静静说「记住……」就会出现在这里。'}</p></div>`;
    return;
  }
  $('#memory-list').innerHTML = state.memories.map((m) => `
    <div class="memory-card">
      <span class="memory-layer" data-layer="${m.layer}">${LAYER_LABEL[m.layer] || m.layer}</span>
      <div class="memory-main">
        <div class="memory-text">${esc(m.text)}</div>
        <div class="memory-meta">
          ${(m.tags || []).map((t) => `<span class="memory-tag">${esc(t)}</span>`).join('')}
          <span>${timeAgo(m.created_at)}</span>
          <span>重要度 ${Math.round((m.importance || 0.5) * 100)}%</span>
          <button class="memory-del" data-action="edit-memory" data-id="${m.id}">编辑</button>
          <button class="memory-del" data-action="forget" data-id="${m.id}">删除</button>
        </div>
      </div>
    </div>`).join('');
}

let memTimer = null;
$('#mem-search')?.addEventListener('input', (e) => {
  clearTimeout(memTimer);
  memTimer = setTimeout(() => loadMemories(e.target.value.trim()), 260);
});

async function forgetMemory(id) {
  try {
    await api(`/api/memories/${id}`, { method: 'DELETE' });
    state.memories = state.memories.filter((m) => m.id !== id);
    loadMemories();
    toast('忘掉了。');
  } catch (err) {
    toast(err.message);
  }
}

/* ------------------------------- settings ----------------------------- */

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}


const SETTINGS_PAGES = [
  { id: 'model', group: '助手', glyph: '模', title: '模型与称呼', desc: '运行模式、模型、Key 和它怎么称呼你。', needsSave: true },
  { id: 'scheduler', group: '助手', glyph: '调', title: '调度器', desc: '并发、恢复次数、默认目录和每日简报开关。', needsSave: true },
  { id: 'worker', group: '助手', glyph: '工', title: 'Worker', desc: '执行器可用状态；权限由本机 CLI 和账户决定。', needsSave: true },
  { id: 'workspaces', group: '助手', glyph: '区', title: '工作区', desc: '任务来源落到的目录；每个来源可以单独绑定。', needsSave: false },
  { id: 'plugins', group: '来源', glyph: '插', title: '任务来源插件', desc: '邮箱、日历等发现来源，单独启用和配置。', needsSave: false },
  { id: 'rules', group: '助手', glyph: '报', title: '每日简报', desc: '每天定时汇总昨天完成和今天待处理的事。', needsSave: false },
  { id: 'pairing', group: '访问', glyph: '配', title: '配对与手机', desc: '配对码、手机地址与退出登录。', needsSave: false },
  { id: 'install', group: '访问', glyph: '装', title: '安装到手机', desc: '把 PWA 安装到手机或桌面。', needsSave: false },
  { id: 'channels', group: '访问', glyph: '通', title: '通知通道', desc: 'Telegram、飞书和通用 Webhook。', needsSave: true },
  { id: 'about', group: '系统', glyph: '关', title: '关于', desc: '版本、运行位置和数据信息。', needsSave: false }
];

function providerLabel(value) {
  return value === 'deepseek' ? 'DeepSeek' : value === 'ollama' ? 'Ollama' : '演示模式';
}

function settingsSummary(id) {
  const settings = state.settings || {};
  if (id === 'model') return `${providerLabel(settings.provider)} · ${settings.model || '—'}`;
  if (id === 'scheduler') return `并发 ${settings.concurrency || 2} · 每日简报${settings.proactive ? '开启' : '关闭'}`;
  if (id === 'worker') {
    const workers = Object.values(state.workers || {});
    const available = workers.filter((w) => w.available).length;
    return `${available}/${workers.length} 个可用`;
  }
  if (id === 'workspaces') {
    const list = state.settings?.workspaces || [];
    const current = list.find((item) => item.id === state.settings?.defaultWorkspaceId);
    return `${list.length} 个 · 默认 ${current?.name || '—'}`;
  }
  if (id === 'channels') {
    const channels = state.channels || {};
    const enabled = ['telegram', 'feishu', 'webhook'].filter((key) => channels[key]).length;
    return enabled ? `${enabled} 个通道已启用` : '都没有配置，仅应用内提醒';
  }
  if (id === 'pairing') return '配对码已启用';
  if (id === 'install') {
    if (standalone) return '已安装（独立窗口）';
    return '可以安装到手机 / 桌面';
  }
  if (id === 'plugins') {
    const list = state.plugins || [];
    return `${list.filter((p) => p.enabled).length}/${list.length} 个来源启用`;
  }
  if (id === 'rules') {
    const rule = (state.rules || []).find((item) => item.id === 'morning-digest');
    return rule ? `每天 ${rule.trigger.at} · ${rule.enabled ? '已启用' : '已暂停'}` : '未配置';
  }
  return `v${state.server?.version || '0.2.0'}`;
}

function renderSettingsIndex() {
  const container = $('#settings-list');
  if (!container) return;
  let currentGroup = '';
  const html = [];
  for (const page of SETTINGS_PAGES) {
    if (page.group !== currentGroup) {
      currentGroup = page.group;
      html.push(`<div class="settings-group-label">${esc(page.group)}</div>`);
    }
    html.push(`
      <button type="button" class="settings-item" data-settings-page="${page.id}">
        <span class="settings-item-icon">${esc(page.glyph)}</span>
        <span class="settings-item-main"><b>${esc(page.title)}</b><small>${esc(settingsSummary(page.id))}</small></span>
        <span class="settings-item-arrow">›</span>
      </button>`);
  }
  container.innerHTML = html.join('');
}

function showSettingsIndex() {
  state.settingsPage = 'index';
  const index = $('#settings-index');
  const detail = $('#settings-detail');
  if (index) index.hidden = false;
  if (detail) detail.hidden = true;
  renderSettingsIndex();
}

function openSettingsPage(id) {
  const page = SETTINGS_PAGES.find((item) => item.id === id);
  if (!page) return;
  state.settingsPage = id;
  const index = $('#settings-index');
  const detail = $('#settings-detail');
  if (index) index.hidden = true;
  if (detail) detail.hidden = false;
  const title = $('#settings-title');
  const desc = $('#settings-desc');
  if (title) title.textContent = page.title;
  if (desc) desc.textContent = page.desc;
  fillSettings();
  const save = $('#save-settings');
  if (save) save.hidden = !page.needsSave;
  for (const panel of $$('[data-settings-panel]')) {
    panel.hidden = panel.dataset.settingsPanel !== id;
  }
  if (id === 'workspaces') renderWorkspaces();
  if (id === 'plugins') { state.pluginPage = 'list'; renderPlugins(); }
  if (id === 'rules') renderRules();
  if (id === 'pairing') loadPairing();
  if (id === 'install') setTimeout(updateInstallStatus, 60);
  if (id === 'worker') { renderWorkerGrid(); renderWorkerRules(); }
  if (id === 'channels') renderChannelBadges();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

$('#settings-list')?.addEventListener('click', (event) => {
  const item = event.target.closest('[data-settings-page]');
  if (item) openSettingsPage(item.dataset.settingsPage);
});
$('#settings-back')?.addEventListener('click', showSettingsIndex);

function fillSettings() {
  if (!state.settings) return;
  const form = $('#settings-form');
  $$('[name]', form).forEach((input) => {
    const value = getPath(state.settings, input.name);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value ?? '';
  });
  renderWorkerGrid();
  renderChannelBadges();
  renderPlugins();
  renderRules();
  $('#about-host').textContent = `${location.host}`;
  $('#about-tz').textContent = state.server.timezone || '—';
}

function workerConfigFields(w) {
  return (w.configSchema || []).map((field) => {
    const value = w.config?.[field.key];
    const attrs = `name="worker.${field.key}"`;
    if (field.type === 'checkbox') {
      return `<label class="switch-field"><span>${esc(field.label)}</span><input type="checkbox" class="switch" ${attrs} ${value ? 'checked' : ''}></label>`;
    }
    if (field.type === 'select') {
      return `<label class="field"><span>${esc(field.label)}</span><select ${attrs}>${(field.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
    }
    if (field.type === 'textarea') {
      return `<label class="field span-2"><span>${esc(field.label)}</span><textarea rows="3" ${attrs}>${esc(value ?? '')}</textarea></label>`;
    }
    const type = field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text';
    return `<label class="field"><span>${esc(field.label)}</span><input type="${type}" ${attrs} value="${esc(value ?? '')}" placeholder="${esc(field.placeholder || '')}" /></label>`;
  }).join('');
}

function renderWorkerGrid() {
  const entries = Object.entries(state.workers || {});
  $('#worker-grid').innerHTML = entries.map(([key, w]) => `
    <div class="worker-item ${w.available ? '' : 'is-off'}" data-worker="${key}">
      <span class="worker-dot"></span>
      <span class="worker-item-main"><b>${esc(w.label || key)}</b><small>${esc(w.available ? w.detail || '可用' : w.detail || '不可用')}${w.source === 'plugin' ? ' · Worker 插件' : ''}</small></span>
      <span class="worker-item-actions">
        ${w.source === 'plugin' ? `<button type="button" class="mini-btn" data-worker-config="${key}">配置</button>
        <button type="button" class="mini-btn" data-worker-test="${key}">检测</button>` : ''}
        <button type="button" class="mini-btn danger" data-worker-delete="${key}">删除</button>
      </span>
    </div>`).join('');
}

function workerRuleCondition(rule) {
  const parts = [];
  if (rule.pattern) parts.push(`匹配 /${rule.pattern}/`);
  if (rule.source) parts.push(`来源 ${rule.source}`);
  if (rule.event_type) parts.push(`事件 ${rule.event_type}`);
  if (rule.workspace_id) {
    const ws = (state.settings?.workspaces || []).find((item) => item.id === rule.workspace_id);
    parts.push(`工作区 ${ws?.name || rule.workspace_id}`);
  }
  return parts.length ? parts.join(' · ') : '匹配所有任务';
}

function renderWorkerRules() {
  const box = $('#worker-rule-list');
  if (!box) return;
  const rules = state.workerRules || [];
  box.innerHTML = rules.length ? rules.map((rule, index) => `
    <div class="worker-rule ${rule.enabled ? '' : 'is-off'}" data-worker-rule="${esc(rule.id)}">
      <span class="worker-rule-order">${index + 1}</span>
      <span class="worker-rule-main"><b>${esc(rule.name)}</b><small>${esc(workerRuleCondition(rule))} → ${esc(workerLabel(rule.worker))}</small></span>
      <span class="worker-rule-actions">
        <button type="button" class="mini-btn" data-rule-move="up" data-id="${esc(rule.id)}" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="mini-btn" data-rule-move="down" data-id="${esc(rule.id)}" ${index === rules.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="mini-btn" data-rule-edit="${esc(rule.id)}">编辑</button>
        <input type="checkbox" class="switch" data-rule-enabled="${esc(rule.id)}" ${rule.enabled ? 'checked' : ''} title="启用" />
        <button type="button" class="mini-btn danger" data-rule-delete="${esc(rule.id)}">删除</button>
      </span>
    </div>`).join('') : '<div class="admin-note">还没有分配规则；所有任务按 Router/默认 Worker 执行。</div>';
}

function workerRuleForm(rule = {}) {
  return `
    <label class="field"><span>规则名称</span><input name="name" value="${esc(rule.name || '')}" placeholder="例如：GitHub 通知交给 Claude" /></label>
    <label class="field"><span>匹配文本（正则，可空）</span><input name="pattern" value="${esc(rule.pattern || '')}" placeholder="例如：github|pull request" /></label>
    <label class="field"><span>来源（可空，支持 plugin:*）</span><input name="source" value="${esc(rule.source || '')}" placeholder="web / plugin:* / plugin:email-imap" /></label>
    <label class="field"><span>事件类型（可空，支持 * / foo.*）</span><input name="event_type" value="${esc(rule.event_type || '')}" placeholder="email.unread / wecom.group_message / chat.message" /></label>
    <label class="field"><span>工作区（可空）</span><select name="workspace_id">
      <option value="">任意工作区</option>
      ${(state.settings?.workspaces || []).map((ws) => `<option value="${esc(ws.id)}" ${rule.workspace_id === ws.id ? 'selected' : ''}>${esc(ws.name)}</option>`).join('')}
    </select></label>
    <label class="field"><span>命中后使用 Worker</span><select name="worker">
      ${workerIds().map((id) => `<option value="${id}" ${rule.worker === id ? 'selected' : ''}>${workerLabel(id)}</option>`).join('')}
    </select></label>`;
}

function openWorkerRule(rule = null) {
  openDialog({
    title: rule ? '编辑分配规则' : '添加分配规则',
    desc: '从上到下第一个命中的规则生效；正则留空表示不限制文本。',
    body: workerRuleForm(rule || {}),
    onSubmit: async (values) => {
      if (!values.name.trim()) throw new Error('规则名称不能为空');
      const body = {
        name: values.name,
        pattern: values.pattern,
        source: values.source,
        event_type: values.event_type,
        workspace_id: values.workspace_id,
        worker: values.worker
      };
      const data = await api(rule ? `/api/worker-rules/${rule.id}` : '/api/worker-rules', {
        method: rule ? 'PATCH' : 'POST',
        body
      });
      state.workerRules = data.rules;
      renderWorkerRules();
      toast('分配规则已保存。');
    }
  });
}

$('#add-worker-rule')?.addEventListener('click', () => openWorkerRule());

$('#worker-rule-list')?.addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-rule-edit]');
  if (edit) {
    openWorkerRule((state.workerRules || []).find((rule) => rule.id === edit.dataset.ruleEdit));
    return;
  }
  const del = event.target.closest('[data-rule-delete]');
  if (del) {
    if (!confirm('删除这条分配规则？')) return;
    try {
      const data = await api(`/api/worker-rules/${del.dataset.ruleDelete}`, { method: 'DELETE' });
      state.workerRules = data.rules;
      renderWorkerRules();
      toast('规则已删除。');
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const move = event.target.closest('[data-rule-move]');
  if (move) {
    try {
      const data = await api(`/api/worker-rules/${move.dataset.id}/move`, { method: 'POST', body: { direction: move.dataset.ruleMove } });
      state.workerRules = data.rules;
      renderWorkerRules();
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#worker-rule-list')?.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-rule-enabled]');
  if (!input) return;
  try {
    const data = await api(`/api/worker-rules/${input.dataset.ruleEnabled}`, { method: 'PATCH', body: { enabled: input.checked } });
    state.workerRules = data.rules;
    renderWorkerRules();
  } catch (err) {
    input.checked = !input.checked;
    toast(err.message);
  }
});

async function refreshWorkers() {
  const data = await api('/api/settings');
  state.workers = data.workers;
  renderWorkerGrid();
}

$('#worker-grid')?.addEventListener('click', async (event) => {
  const config = event.target.closest('[data-worker-config]');
  if (config) {
    const id = config.dataset.workerConfig;
    const w = state.workers?.[id];
    if (!w) return;
    openDialog({
      title: `配置 ${w.label || id}`,
      desc: '这些配置只属于当前主机的这个 Worker。',
      body: `<div class="grid-2">${workerConfigFields(w)}<label class="switch-field"><span>启用</span><input type="checkbox" class="switch" name="worker.enabled" ${w.enabled ? 'checked' : ''}></label></div>`,
      onSubmit: async (values) => {
        const configValues = {};
        for (const field of w.configSchema || []) {
          const raw = values[`worker.${field.key}`];
          configValues[field.key] = field.type === 'checkbox' ? Boolean(raw) : field.type === 'number' ? Number(raw) : raw;
        }
        const data = await api(`/api/workers/${id}`, { method: 'PUT', body: { config: configValues, enabled: Boolean(values['worker.enabled']) } });
        state.workers = data.workers;
        renderWorkerGrid();
        toast('Worker 配置已保存。');
      }
    });
    return;
  }
  const test = event.target.closest('[data-worker-test]');
  if (test) {
    try {
      const result = await api(`/api/workers/${test.dataset.workerTest}/test`, { method: 'POST' });
      toast(`${result.available ? '✓' : '✗'} ${result.detail || ''}`);
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const del = event.target.closest('[data-worker-delete]');
  if (del) {
    const id = del.dataset.workerDelete;
    const worker = state.workers[id];
    const builtin = worker?.source === 'builtin';
    if (!confirm(`删除 Worker「${worker?.label || id}」？${builtin ? '删除后可以点「恢复内置 Worker」找回。' : '插件文件会一起移除。'}`)) return;
    try {
      const data = await api(`/api/workers/${id}`, { method: 'DELETE' });
      state.workers = data.workers;
      renderWorkerGrid();
      toast(builtin ? '内置 Worker 已隐藏。' : 'Worker 已删除。');
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#restore-workers')?.addEventListener('click', async () => {
  try {
    const data = await api('/api/workers/restore', { method: 'POST' });
    state.workers = data.workers;
    renderWorkerGrid();
    toast('内置 Worker 已恢复。');
  } catch (err) {
    toast(err.message);
  }
});

$('#worker-file')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const button = $('#install-worker-btn');
  button.classList.add('is-busy');
  button.textContent = '安装中…';
  try {
    const response = await fetch('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `安装失败（${response.status}）`);
    if (data.workers) state.workers = data.workers;
    if (data.plugins) state.plugins = data.plugins;
    renderWorkerGrid();
    toast('Worker 插件已安装，点「配置」填写主机参数。', 3600);
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    button.classList.remove('is-busy');
    button.textContent = '安装 Worker 插件';
  }
});

function renderChannelBadges() {
  const map = { telegram: state.channels.telegram, feishu: state.channels.feishu, webhook: state.channels.webhook };
  for (const [key, on] of Object.entries(map)) {
    const badge = $(`#badge-${key}`);
    if (badge) {
      badge.textContent = on ? '已启用' : '未配置';
      badge.classList.toggle('on', Boolean(on));
    }
  }
}

function renderRules() {
  $('#rules-list').innerHTML = (state.rules || []).map((r) => {
    const trigger = r.trigger.type === 'daily' ? `每天 ${r.trigger.at}` : `每 ${Math.round((r.trigger.seconds || 300) / 60)} 分钟`;
    return `
      <div class="rule-item">
        <span><b>${esc(r.name)}</b><small>${trigger} · 交给${workerLabel(r.action.worker)}${r.last_run ? ` · 上次 ${timeAgo(r.last_run)}` : ''}</small></span>
        <input type="checkbox" class="switch" data-rule="${r.id}" ${r.enabled ? 'checked' : ''} />
      </div>`;
  }).join('') || '<div class="empty"><p>还没有规则。</p></div>';
  $$('#rules-list [data-rule]').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        const data = await api(`/api/rules/${input.dataset.rule}/toggle`, { method: 'POST', body: { enabled: input.checked } });
        state.rules = data.rules;
        toast(input.checked ? '规则已启用。' : '规则已暂停。');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}



function defaultWorkspaceName() {
  const list = state.settings?.workspaces || [];
  const current = list.find((item) => item.id === state.settings?.defaultWorkspaceId);
  return current?.name || '默认工作区';
}

function renderWorkspaces() {
  const list = state.settings?.workspaces || [];
  const container = $('#workspace-list');
  if (!container) return;
  container.innerHTML = list.map((ws) => `
    <div class="workspace-row" data-ws-row="${esc(ws.id)}">
      <label class="field workspace-name"><span>名称</span><input data-ws-name="${esc(ws.id)}" value="${esc(ws.name)}" /></label>
      <label class="field"><span>目录</span><input data-ws-path="${esc(ws.id)}" value="${esc(ws.path)}" placeholder="/Users/you/code/project" /></label>
      <button type="button" class="mini-btn" data-ws-pick="${esc(ws.id)}">选择</button>
      <button type="button" class="mini-btn danger" data-ws-remove="${esc(ws.id)}" ${list.length <= 1 ? 'disabled' : ''}>删除</button>
    </div>`).join('') || '<div class="admin-note">还没有工作区。</div>';
  const select = $('#default-workspace');
  if (select) {
    select.innerHTML = list.map((ws) => `<option value="${esc(ws.id)}" ${state.settings.defaultWorkspaceId === ws.id ? 'selected' : ''}>${esc(ws.name)}</option>`).join('');
  }
}

function collectWorkspaces() {
  const rows = $$('#workspace-list .workspace-row');
  const list = [];
  const ids = new Set();
  for (const row of rows) {
    const id = row.dataset.wsRow;
    const name = row.querySelector('[data-ws-name]')?.value.trim() || '';
    const path = row.querySelector('[data-ws-path]')?.value.trim() || '';
    if (!name || !path) throw new Error('工作区的名称和目录都要填');
    if (ids.has(id)) continue;
    ids.add(id);
    list.push({ id, name, path });
  }
  if (!list.length) throw new Error('至少保留一个工作区');
  return { workspaces: list, defaultWorkspaceId: $('#default-workspace')?.value || list[0].id };
}

async function saveWorkspaces() {
  try {
    const payload = collectWorkspaces();
    const data = await api('/api/settings', { method: 'PUT', body: payload });
    state.settings = data.settings;
    renderWorkspaces();
    renderPlugins();
    toast('工作区已保存。');
  } catch (err) {
    toast(err.message);
  }
}

$('#add-workspace')?.addEventListener('click', () => {
  if (!state.settings) return;
  state.settings.workspaces = state.settings.workspaces || [];
  state.settings.workspaces.push({
    id: `ws_${Date.now().toString(36)}`,
    name: '新工作区',
    path: ''
  });
  renderWorkspaces();
});

$('#workspace-list')?.addEventListener('click', async (event) => {
  const pick = event.target.closest('[data-ws-pick]');
  if (pick) {
    const id = pick.dataset.wsPick;
    const row = pick.closest('.workspace-row');
    const input = row?.querySelector('[data-ws-path]');
    if (!input) return;
    pick.disabled = true;
    const old = pick.textContent;
    pick.textContent = '选择中…';
    try {
      const data = await api('/api/system/pick-folder', { method: 'POST' });
      input.value = data.path;
      toast('已选择文件夹，记得点「保存工作区」。');
    } catch (err) {
      toast(err.message);
    } finally {
      pick.disabled = false;
      pick.textContent = old;
    }
    return;
  }
  const remove = event.target.closest('[data-ws-remove]');
  if (!remove) return;
  const id = remove.dataset.wsRemove;
  const list = state.settings.workspaces || [];
  if (list.length <= 1) return;
  state.settings.workspaces = list.filter((item) => item.id !== id);
  if (state.settings.defaultWorkspaceId === id) {
    state.settings.defaultWorkspaceId = state.settings.workspaces[0].id;
  }
  renderWorkspaces();
});

$('#save-workspaces')?.addEventListener('click', saveWorkspaces);

async function ensureWorkspaceForPath(dir) {
  const path = String(dir || '').trim();
  if (!path) throw new Error('没有选择目录');
  const list = state.settings?.workspaces || [];
  const existing = list.find((item) => item.path === path);
  if (existing) return existing;
  const name = path.split('/').filter(Boolean).pop() || '工作区';
  const workspace = { id: `ws_${Date.now().toString(36)}`, name, path };
  const data = await api('/api/settings', {
    method: 'PUT',
    body: {
      workspaces: [...list, workspace],
      defaultWorkspaceId: state.settings.defaultWorkspaceId
    }
  });
  state.settings = data.settings;
  return state.settings.workspaces.find((item) => item.path === path) || workspace;
}

/* ---------------------------- source plugins --------------------------- */

function fieldInput(plugin, field) {
  const value = plugin.config?.[field.key];
  const attrs = `data-plugin-field="${field.key}"`;
  if (field.type === 'checkbox') {
    return `<label class="switch-field"><span>${esc(field.label)}</span>
      <input type="checkbox" class="switch" ${attrs} ${value ? 'checked' : ''}></label>`;
  }
  if (field.type === 'select') {
    return `<label class="field ${field.wide ? 'span-2' : ''}"><span>${esc(field.label)}</span>
      <select ${attrs}>${(field.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'textarea') {
    return `<label class="field span-2"><span>${esc(field.label)}</span>
      <textarea rows="3" ${attrs} placeholder="${esc(field.placeholder || '')}">${esc(value ?? '')}</textarea></label>`;
  }
  const type = field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text';
  return `<label class="field ${field.wide ? 'span-2' : ''}"><span>${esc(field.label)}</span>
    <input type="${type}" ${attrs} value="${esc(value ?? '')}"
      ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''}
      placeholder="${esc(field.placeholder || '')}" autocomplete="off" />
    ${field.help ? `<small class="field-help">${esc(field.help)}</small>` : ''}</label>`;
}

function pluginTypeLabel(plugin) {
  const type = plugin.type || 'poll';
  const label = PLUGIN_TYPE_LABEL[type] || type;
  if (type === 'poll') return `${label} · 每 ${plugin.intervalMinutes} 分钟`;
  return label;
}

function pluginCardHtml(plugin, { detail = false } = {}) {
  const fields = (plugin.configSchema || []).map((f) => fieldInput(plugin, f)).join('');
  const webhookUrl = plugin.webhookPath ? `${location.origin}${plugin.webhookPath}` : '';
  const type = plugin.type || 'poll';
  const typeLabel = PLUGIN_TYPE_LABEL[type] || type;
  const typeNote = type === 'stream'
    ? '长连接常驻，断线自动重连；不参与轮询。'
    : type === 'webhook'
      ? '由外部事件触发，不参与轮询。'
      : type === 'manual'
        ? '只在手动扫描时运行。'
        : type === 'watch'
          ? '文件监听类型预留，当前还没有实现。'
          : '';
  const caps = [plugin.capabilities?.read ? '只读' : '', plugin.capabilities?.write ? '可写' : '']
    .filter(Boolean).join(' · ');
  const status = plugin.status || {};
  const statusText = status.lastRun
    ? `${timeAgo(status.lastRun)}扫描 · ${status.lastSummary || ''}`
    : '还没有运行过';
  const labelField = detail ? `<label class="field"><span>来源名称</span><input data-plugin-label="${plugin.id}" value="${esc(plugin.label || plugin.name)}" maxlength="60" /></label>` : '';
  const head = detail ? '' : `
        <div class="plugin-head">
          <div class="plugin-glyph">${esc(plugin.icon || '插')}</div>
          <div class="plugin-title">
            <b>${esc(plugin.label || plugin.name)}</b>
            <small>v${esc(plugin.version)} · ${typeLabel}${type === 'poll' ? ` · 每 ${plugin.intervalMinutes} 分钟` : ''}${caps ? ` · ${caps}` : ''}</small>
          </div>
          <label class="switch-field compact" title="启用这个来源">
            <input type="checkbox" class="switch" data-plugin-enabled="${plugin.id}" ${plugin.enabled ? 'checked' : ''} />
          </label>
        </div>`;
  return `
      <div class="plugin-card ${plugin.enabled ? 'is-enabled' : ''}${detail ? ' is-detail' : ''}" data-plugin="${plugin.id}">
        ${head}
        ${labelField}
        <p class="plugin-desc">${esc(plugin.description)}</p>
        <label class="field plugin-workspace"><span>任务工作区</span>
          <select data-plugin-workspace="${plugin.id}">
            <option value="">跟随默认（${esc(defaultWorkspaceName())}）</option>
            ${(state.settings?.workspaces || []).map((ws) => `<option value="${esc(ws.id)}" ${plugin.workspaceId === ws.id ? 'selected' : ''}>${esc(ws.name)} · ${esc(ws.path)}</option>`).join('')}
            <option value="__custom__">选择自定义文件夹…</option>
          </select>
        </label>
        ${webhookUrl ? `
          <div class="webhook-box">
            <div class="webhook-label">Webhook 地址 <span>${plugin.enabled ? '已启用' : '启用后生效'}</span></div>
            <code class="webhook-url">${esc(webhookUrl)}</code>
            <div class="webhook-actions">
              <button type="button" class="mini-btn" data-copy-webhook="${esc(webhookUrl)}">复制地址</button>
              <span>外部服务 POST JSON 到这里；公网/Tailscale 地址才能被外部访问。</span>
            </div>
          </div>` : ''}
        ${type === 'poll' ? `<label class="field plugin-schedule"><span>获取频率（分钟）</span><input type="number" data-plugin-interval="${plugin.id}" min="1" max="1440" value="${plugin.intervalMinutes}" /><small>默认 ${plugin.defaultIntervalMinutes} 分钟；只影响这个来源。</small></label>` : `<p class="plugin-type-note">${typeNote}</p>`}
        <div class="plugin-fields">${fields}</div>
        <div class="plugin-foot">
          ${((plugin.configSchema || []).length || type === 'poll') ? `<button type="button" class="mini-btn" data-plugin-action="save" data-id="${plugin.id}">保存配置</button>` : ''}
          <button type="button" class="mini-btn" data-plugin-action="test" data-id="${plugin.id}">测试连接</button>
          ${(type === 'poll' || type === 'manual') ? `<button type="button" class="mini-btn" data-plugin-action="scan" data-id="${plugin.id}">立即扫描</button>` : ''}
          <button type="button" class="mini-btn danger" data-plugin-uninstall="${plugin.id}">删除来源</button>
          <span class="test-result" data-plugin-result="${plugin.id}"></span>
        </div>
        <div class="plugin-status ${status.lastStatus === 'error' ? 'is-error' : ''}">
          ${status.lastStatus === 'error' ? `上次失败：${esc(status.lastError || '')}${status.failCount ? ` · 连续 ${status.failCount} 次，下一轮自动退避` : ''}` : esc(statusText)}
        </div>
      </div>`;
}

function renderPluginDetail(id) {
  const plugin = (state.plugins || []).find((item) => item.id === id);
  const body = $('#plugin-detail-body');
  if (!body) return;
  if (!plugin) {
    state.pluginPage = 'list';
    renderPlugins();
    return;
  }
  const status = plugin.status || {};
  body.innerHTML = `
    <div class="subpage-head plugin-detail-head">
      <button type="button" class="back-btn" id="plugin-back" aria-label="返回插件列表">←</button>
      <div class="subpage-title">
        <p class="eyebrow">任务来源 · ${esc(plugin.name)}</p>
        <h2>${esc(plugin.label || plugin.name)}</h2>
        <p>${esc(pluginTypeLabel(plugin))}${plugin.capabilities?.read ? ' · 只读' : ''}${status.lastStatus === 'error' ? ' · 上次失败' : ''}</p>
      </div>
      <div class="plugin-detail-actions">
        ${plugin.multiInstance ? `<button type="button" class="mini-btn" data-plugin-add="${esc(plugin.pluginId)}">再添加一个</button>` : ''}
        <label class="switch-field compact" title="启用这个来源">
          <input type="checkbox" class="switch" data-plugin-enabled="${plugin.id}" ${plugin.enabled ? 'checked' : ''} />
        </label>
      </div>
    </div>
    ${pluginCardHtml(plugin, { detail: true })}
    <div class="plugin-recent" id="plugin-recent">
      <div class="plugin-recent-head"><h4>最近处理</h4><span>消息进来后，静静判断了什么</span></div>
      <p class="admin-note">加载中…</p>
    </div>
    <div class="plugin-recent" id="plugin-runs">
      <div class="plugin-recent-head"><h4>运行历史</h4><span>每次拉取的结果</span></div>
      <p class="admin-note">加载中…</p>
    </div>`;
  loadPluginRecent(plugin.id);
  loadPluginRuns(plugin.id);
}

async function loadPluginRecent(id) {
  try {
    const data = await api(`/api/plugins/${id}/items`);
    if (state.pluginPage !== id) return;
    const box = $('#plugin-recent');
    if (!box) return;
    const items = data.items || [];
    const label = { task: '已建任务', merged: '已合并', skipped: '跳过', new: '待处理' };
    box.innerHTML = `
      <div class="plugin-recent-head"><h4>最近处理</h4><span>消息进来后，静静判断了什么</span></div>
      ${items.length ? items.map((item) => `
        <div class="plugin-recent-row">
          <div class="plugin-recent-main">
            <b>${esc(item.title || '未命名')}</b>
            <small>${esc(timeAgo(item.createdAt))} · ${esc(item.reason || '没有记录判断理由')}</small>
          </div>
          <span class="plugin-recent-state ${item.status === 'task' || item.status === 'merged' ? 'is-task' : 'is-skip'}">${label[item.status] || esc(item.status)}</span>
          ${item.taskId ? `<button type="button" class="mini-btn" data-recent-task="${esc(item.taskId)}">看任务</button>` : ''}
        </div>`).join('') : '<p class="admin-note">还没有处理记录。</p>'}`;
  } catch (err) {
    const box = $('#plugin-recent');
    if (box) box.innerHTML = `<div class="plugin-recent-head"><h4>最近处理</h4></div><p class="admin-note">${esc(err.message)}</p>`;
  }
}

async function loadPluginRuns(id) {
  try {
    const data = await api(`/api/plugins/${id}/runs`);
    if (state.pluginPage !== id) return;
    const box = $('#plugin-runs');
    if (!box) return;
    const runs = data.runs || [];
    box.innerHTML = `
      <div class="plugin-recent-head"><h4>运行历史</h4><span>每次拉取的结果</span></div>
      ${runs.length ? runs.map((run) => `
        <div class="plugin-recent-row">
          <div class="plugin-recent-main">
            <b>${esc(run.status === 'ok' ? '成功' : run.status === 'error' ? '失败' : run.status)} · ${run.created ?? 0} 个任务</b>
            <small>${esc(timeAgo(run.started_at))} · ${run.scanned ?? 0} 条 · ${run.duration_ms ?? 0}ms${run.error ? ` · ${esc(run.error)}` : ''}</small>
          </div>
        </div>`).join('') : '<p class="admin-note">还没有运行记录。</p>'}`;
  } catch (err) {
    const box = $('#plugin-runs');
    if (box) box.innerHTML = `<div class="plugin-recent-head"><h4>运行历史</h4></div><p class="admin-note">${esc(err.message)}</p>`;
  }
}

function renderPluginList() {
  const list = state.plugins || [];
  const container = $('#plugin-list');
  if (!container) return;
  const errors = state.pluginErrors || [];
  const notice = errors.length
    ? `<div class="plugin-errors"><b>${errors.length} 个插件未通过规范检查</b><ul>${errors.map((e) => `<li><code>${esc(e.plugin)}</code>：${esc(e.error)}</li>`).join('')}</ul><span>修好后点「重新加载」。</span></div>`
    : list.length
      ? `<div class="plugin-ok">规范检查通过 · ${list.length} 个来源</div>`
      : '';
  if (!list.length) {
    container.innerHTML = notice + `<div class="empty"><p>还没有插件。点右上角「安装插件」上传 zip，或把插件目录放进数据目录的 <code>plugins/</code>。</p></div>`;
    return;
  }
  container.innerHTML = notice + list.map((plugin) => {
    const status = plugin.status || {};
    const broken = status.lastStatus === 'error';
    const subName = plugin.label && plugin.label !== plugin.name ? `${plugin.name} · ` : '';
    return `<button type="button" class="plugin-row ${plugin.enabled ? 'is-enabled' : ''}${broken ? ' is-error' : ''}" data-open-plugin="${plugin.id}">
      <span class="plugin-row-glyph">${esc(plugin.icon || '插')}</span>
      <span class="plugin-row-main">
        <b>${esc(plugin.label || plugin.name)}</b>
        <small>${esc(subName)}${esc(pluginTypeLabel(plugin))}${status.lastRun ? ` · ${esc(timeAgo(status.lastRun))}运行` : ''}${broken ? ` · ${esc(status.lastError || '上次失败')}` : ''}</small>
      </span>
      <span class="plugin-row-state">${plugin.enabled ? '已启用' : '未启用'}</span>
      <span class="plugin-row-arrow">›</span>
    </button>`;
  }).join('');
}

function renderPlugins() {
  const detailView = $('#plugin-detail-view');
  const listView = $('#plugin-list-view');
  if (!detailView || !listView) return;
  if (!state.pluginPage || state.pluginPage === 'list') state.pluginPage = 'list';
  const detail = state.pluginPage !== 'list';
  listView.hidden = detail;
  detailView.hidden = !detail;
  if (detail) renderPluginDetail(state.pluginPage);
  else renderPluginList();
}

function openPluginPage(id) {
  state.pluginPage = id;
  renderPlugins();
  $('#settings-detail')?.scrollIntoView({ block: 'start' });
}

function closePluginPage() {
  state.pluginPage = 'list';
  renderPlugins();
}

$('#plugin-detail-view')?.addEventListener('click', (event) => {
  if (event.target.closest('#plugin-back')) closePluginPage();
});


function onPluginContainers(eventName, handler) {
  for (const selector of ['#plugin-list', '#plugin-detail-body']) {
    $(selector)?.addEventListener(eventName, handler);
  }
}

function collectPluginConfig(id) {
  const card = document.querySelector(`.plugin-card[data-plugin="${id}"]`);
  const config = {};
  if (!card) return config;
  for (const input of card.querySelectorAll('[data-plugin-field]')) {
    const key = input.dataset.pluginField;
    if (input.type === 'checkbox') config[key] = input.checked;
    else if (input.type === 'number') config[key] = Number(input.value);
    else config[key] = input.value;
  }
  return config;
}

async function savePluginConfig(id, { silent = false } = {}) {
  const config = collectPluginConfig(id);
  const intervalInput = document.querySelector(`[data-plugin-interval="${id}"]`);
  const labelInput = document.querySelector(`[data-plugin-label="${id}"]`);
  const body = { config };
  if (intervalInput) body.intervalMinutes = intervalInput.value === '' ? null : Number(intervalInput.value);
  if (labelInput) body.label = labelInput.value;
  const data = await api(`/api/plugins/${id}`, { method: 'PUT', body });
  const index = state.plugins.findIndex((p) => p.id === id);
  if (index >= 0) state.plugins[index] = data.plugin;
  if (Array.isArray(data.errors)) state.pluginErrors = data.errors;
  if (!silent) toast('插件配置已保存。');
  return data.plugin;
}

onPluginContainers('click', async (event) => {
  const row = event.target.closest('[data-open-plugin]');
  if (row) {
    openPluginPage(row.dataset.openPlugin);
    return;
  }
  const recentTask = event.target.closest('[data-recent-task]');
  if (recentTask) {
    openTask(recentTask.dataset.recentTask);
    return;
  }
  const addInstance = event.target.closest('[data-plugin-add]');
  if (addInstance) {
    const pluginId = addInstance.dataset.pluginAdd;
    try {
      addInstance.disabled = true;
      const data = await api(`/api/plugins/${pluginId}/instances`, { method: 'POST', body: {} });
      state.plugins = data.plugins || state.plugins;
      state.pluginPage = data.plugin?.id || state.pluginPage;
      renderPlugins();
      toast('已添加一个来源实例，填好配置再启用。');
    } catch (err) {
      toast(err.message);
    } finally {
      addInstance.disabled = false;
    }
    return;
  }
  const btn = event.target.closest('[data-plugin-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.pluginAction;
  const setResult = (text, state) => {
    const el = document.querySelector(`[data-plugin-result="${id}"]`);
    if (!el) return;
    el.textContent = text;
    if (state) el.dataset.state = state;
    el.parentElement?.querySelector('.plugin-preview')?.remove();
  };
  try {
    btn.disabled = true;
    if (action === 'save') {
      await savePluginConfig(id);
      renderPlugins();
      toast('来源配置已保存。');
      return;
    } else if (action === 'test') {
      setResult('测试中…', 'pending');
      await savePluginConfig(id, { silent: true });
      setResult('测试中…', 'pending');
      const data = await api(`/api/plugins/${id}/test`, { method: 'POST' });
      setResult(`${data.ok ? '✓' : '✗'} ${data.detail || ''}${data.latencyMs ? ` · ${data.latencyMs}ms` : ''}`, data.ok ? 'ok' : 'error');
      if (data.preview?.length) {
        const el = document.querySelector(`[data-plugin-result="${id}"]`);
        el?.insertAdjacentHTML('afterend', `<ul class="plugin-preview">${data.preview.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`);
      }
      toast(data.ok ? '连接正常。' : (data.detail || '测试失败'));
    } else if (action === 'scan') {
      setResult('扫描中…', 'pending');
      await savePluginConfig(id, { silent: true });
      setResult('扫描中…', 'pending');
      const data = await api(`/api/plugins/${id}/scan`, { method: 'POST' });
      setResult(data.skipped ? '已跳过' : `✓ 扫描 ${data.scanned ?? 0} 条，新建 ${data.created ?? 0} 个任务`, 'ok');
      toast(data.created ? `发现 ${data.created} 件事，已建任务。` : '扫描完成，没有需要你动手的新内容。');
      if (data.plugins) state.plugins = data.plugins;
      if (Array.isArray(data.errors)) state.pluginErrors = data.errors;
      renderPlugins();
    }
  } catch (err) {
    setResult(`✗ ${err.message}`, 'error');
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#plugin-file')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const button = $('#install-plugin-btn');
  button.classList.add('is-busy');
  button.setAttribute('aria-busy', 'true');
  button.textContent = '安装中…';
  try {
    const response = await fetch('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `安装失败（${response.status}）`);
    state.plugins = data.plugins || state.plugins;
    state.pluginErrors = data.errors || [];
    state.pluginPage = 'list';
    renderPlugins();
    toast('插件已安装。点进详情填配置，再打开启用开关。', 3600);
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
    button.textContent = '安装插件';
  }
});

onPluginContainers('click', async (event) => {
  const copy = event.target.closest('[data-copy-webhook]');
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copyWebhook);
      toast('Webhook 地址已复制。');
    } catch {
      toast(copy.dataset.copyWebhook);
    }
    return;
  }
  const uninstall = event.target.closest('[data-plugin-uninstall]');
  if (!uninstall) return;
  const id = uninstall.dataset.pluginUninstall;
  const plugin = state.plugins.find((item) => item.id === id);
  if (!plugin) return;
  if (!confirm(`删除「${plugin.label || plugin.name}」？配置和启用状态会一起删除；如果这是最后一个实例，插件文件也会移除。已建的任务会保留。`)) return;
  try {
    const data = await api(`/api/plugins/${id}`, { method: 'DELETE' });
    state.plugins = data.plugins || [];
    state.pluginErrors = data.errors || [];
    state.pluginPage = 'list';
    renderPlugins();
    toast(data.purged ? '插件已删除。' : '来源已删除，插件本身还保留着。');
  } catch (err) {
    toast(err.message);
  }
});

onPluginContainers('change', async (event) => {
  const workspaceSelect = event.target.closest('[data-plugin-workspace]');
  if (workspaceSelect) {
    const id = workspaceSelect.dataset.pluginWorkspace;
    const previous = (state.plugins.find((plugin) => plugin.id === id)?.workspaceId) || '';
    try {
      let target = workspaceSelect.value;
      if (target === '__custom__') {
        const picked = await api('/api/system/pick-folder', { method: 'POST' });
        const workspace = await ensureWorkspaceForPath(picked.path);
        target = workspace.id;
        if (![...workspaceSelect.options].some((option) => option.value === target)) {
          workspaceSelect.insertAdjacentHTML('beforeend', `<option value="${esc(target)}">${esc(workspace.name)} · ${esc(workspace.path)}</option>`);
        }
        workspaceSelect.value = target;
      }
      const data = await api(`/api/plugins/${id}`, {
        method: 'PUT',
        body: { workspaceId: target || null }
      });
      const index = state.plugins.findIndex((plugin) => plugin.id === id);
      if (index >= 0) state.plugins[index] = data.plugin;
      toast(target ? '任务工作区已更新。' : '已改为跟随默认工作区。');
    } catch (err) {
      workspaceSelect.value = previous;
      toast(err.message);
    }
    return;
  }
  const input = event.target.closest('[data-plugin-enabled]');
  if (!input) return;
  const id = input.dataset.pluginEnabled;
  try {
    const data = await api(`/api/plugins/${id}`, { method: 'PUT', body: { enabled: input.checked } });
    const index = state.plugins.findIndex((p) => p.id === id);
    if (index >= 0) state.plugins[index] = data.plugin;
    if (Array.isArray(data.errors)) state.pluginErrors = data.errors;
    renderPlugins();
    toast(input.checked ? '插件已启用，会按间隔自动发现。' : '插件已停用。');
  } catch (err) {
    input.checked = !input.checked;
    toast(err.message);
  }
});

$('#reload-plugins')?.addEventListener('click', async () => {
  try {
    const data = await api('/api/plugins/reload', { method: 'POST' });
    state.plugins = data.plugins;
    state.pluginErrors = data.errors || [];
    state.pluginPage = 'list';
    renderPlugins();
    toast(`已加载 ${data.plugins.length} 个插件。`);
  } catch (err) {
    toast(err.message);
  }
});

$('#settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveSettings();
});

async function saveSettings({ silent = false } = {}) {
  const form = $('#settings-form');
  const patch = {};
  $$('[name]', form).forEach((input) => {
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number') value = Number(input.value);
    else value = input.value.trim();
    setPath(patch, input.name, value);
  });
  try {
    const data = await api('/api/settings', { method: 'PUT', body: patch });
    state.settings = data.settings;
    state.workers = data.workers;
    renderWorkerGrid();
    fillSettings();
    if (!silent) toast('设置已保存。');
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

$('#save-settings')?.addEventListener('click', () => saveSettings());

$('#test-model')?.addEventListener('click', async () => {
  const btn = $('#test-model');
  const out = $('#model-test-result');
  btn.disabled = true;
  out.textContent = '测试中…';
  out.dataset.state = 'pending';
  try {
    await saveSettings({ silent: true });
    const res = await api('/api/model/test', { method: 'POST' });
    out.textContent = `✓ ${res.model} · ${res.latencyMs}ms · ${res.tokens} tokens`;
    out.dataset.state = 'ok';
    toast('模型连接正常。');
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
    out.dataset.state = 'error';
  } finally {
    btn.disabled = false;
  }
});

$('#test-channel')?.addEventListener('click', async () => {
  try {
    const data = await api('/api/channels/test', { method: 'POST' });
    const sent = data.deliveries.filter((d) => d.ok && d.channel !== 'in-app');
    toast(sent.length ? `已通过 ${sent.map((s) => s.channel).join(' / ')} 发送。` : '当前没有启用外部通道，已用应用内提醒代替。');
  } catch (err) {
    toast(err.message);
  }
});

/* ------------------------------- dialog ------------------------------- */

function openDialog({ title, desc, body, onSubmit }) {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-desc').textContent = desc || '';
  $('#dialog-body').innerHTML = body;
  $('#dialog-form').onsubmit = async (e) => {
    e.preventDefault();
    if (e.submitter?.value === 'cancel') { dialog.close(); return; }
    const values = {};
    $$('[name]', $('#dialog-body')).forEach((input) => { values[input.name] = input.type === 'checkbox' ? input.checked : input.value; });
    try {
      await onSubmit(values);
      dialog.close();
    } catch (err) {
      toast(err.message);
    }
  };
  dialog.showModal();
  setTimeout(() => $('#dialog-body input, #dialog-body textarea')?.focus(), 60);
}

$('#new-task-btn')?.addEventListener('click', () => {
  openDialog({
    title: '新建任务',
    desc: '直接写给 Worker 的指令。任务会进入队列，按调度器规则执行。',
    body: `
      <label class="field"><span>任务名</span><input name="title" placeholder="例如：整理这周的会议纪要" /></label>
      <label class="field"><span>指令</span><textarea name="prompt" placeholder="要它具体做什么？"></textarea></label>
      <label class="field"><span>Worker</span>
        <select name="worker">
          ${workerIds().map((worker) => `<option value="${worker}">${workerLabel(worker)}</option>`).join('')}
        </select>
      </label>`,
    onSubmit: async ({ title, prompt, worker }) => {
      if (!title.trim() || !prompt.trim()) throw new Error('任务名和指令都要填');
      const data = await api('/api/tasks', { method: 'POST', body: { title, prompt, worker } });
      upsertTask(data.task);
      toast('任务已进队列。');
      switchView('tasks');
      openTask(data.task.id);
    }
  });
});

$('#add-memory-btn')?.addEventListener('click', () => {
  openDialog({
    title: '记一条',
    desc: '它会成为以后 Router 判断和 Worker 执行时的上下文。',
    body: `
      <label class="field"><span>内容</span><textarea name="text" placeholder="例如：每周三下午要做周报"></textarea></label>
      <label class="field"><span>放在哪一层</span>
        <select name="layer">
          <option value="profile">画像（长期偏好）</option>
          <option value="semantic">语义（事实/项目）</option>
          <option value="episodic">情景（发生过的事）</option>
        </select>
      </label>
      <label class="field"><span>标签（逗号分隔）</span><input name="tags" placeholder="偏好, 时间" /></label>`,
    onSubmit: async ({ text, layer, tags }) => {
      if (!text.trim()) throw new Error('内容不能为空');
      await api('/api/memories', {
        method: 'POST',
        body: { text: text.trim(), layer, tags: tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }
      });
      await loadMemories();
      toast('记住了。');
    }
  });
});


/* ------------------------------- admin -------------------------------- */

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

async function loadAdmin() {
  try {
    const [overview, logs, tasks] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/logs?limit=200'),
      api('/api/tasks')
    ]);
    state.adminOverview = overview;
    state.adminLogs = logs.logs || [];
    state.tasks = tasks.tasks;
    state.stats = tasks.stats;
    renderAdmin();
  } catch (err) {
    toast(err.message);
  }
}

function renderAdmin() {
  renderAdminOverview();
  renderAdminTasks();
  renderAdminLogs();
  const persona = $('#persona-input');
  if (persona && document.activeElement !== persona) {
    persona.value = state.settings?.persona || '';
  }
}

function renderAdminOverview() {
  const o = state.adminOverview;
  const container = $('#admin-overview');
  if (!o || !container) return;
  const paused = Boolean(o.settings?.queuePaused);
  const stats = o.stats || {};
  const plugins = o.plugins || [];
  const enabledPlugins = plugins.filter((p) => p.enabled).length;
  const mb = ((o.db?.size || 0) / 1024 / 1024).toFixed(1);
  container.innerHTML = `
    <div class="stat"><div class="stat-value">${formatUptime(o.uptime)}</div><div class="stat-label">运行时长</div></div>
    <div class="stat ${paused ? 'warm' : 'accent'}"><div class="stat-value">${stats.active ?? 0}</div><div class="stat-label">${paused ? '已暂停 · 队列积压' : '进行中'}</div></div>
    <div class="stat"><div class="stat-value">${stats.doneToday ?? 0}</div><div class="stat-label">今日完成</div></div>
    <div class="stat"><div class="stat-value">${tokensText(stats.tokens)}</div><div class="stat-label">累计 tokens</div></div>
    <div class="stat"><div class="stat-value">${stats.memories ?? 0}</div><div class="stat-label">条记忆</div></div>
    <div class="stat"><div class="stat-value">${enabledPlugins}/${plugins.length}</div><div class="stat-label">来源插件</div></div>
    <div class="stat"><div class="stat-value">${o.sse ?? 0}</div><div class="stat-label">实时连接</div></div>
    <div class="stat"><div class="stat-value">${mb}<small style="font-size:11px;color:var(--faint)"> MB</small></div><div class="stat-label">数据库</div></div>`;

  const queue = $('#queue-info');
  if (queue) {
    queue.textContent = `排队 ${stats.counts?.queued ?? 0} · 执行中 ${stats.counts?.running ?? 0} · 等你拍板 ${stats.counts?.waiting_approval ?? 0} · 调度${paused ? '已暂停' : '运行中'}`;
  }
  const toggle = $('#queue-toggle');
  if (toggle) toggle.textContent = paused ? '恢复调度' : '暂停调度';
}

function renderAdminTasks() {
  const container = $('#admin-task-list');
  if (!container) return;
  const q = ($('#admin-search')?.value || '').trim().toLowerCase();
  const status = $('#admin-filter')?.value || '';
  let list = state.tasks || [];
  if (status) list = list.filter((t) => t.status === status);
  if (q) list = list.filter((t) => `${t.title} ${t.prompt}`.toLowerCase().includes(q));
  list = list.slice(0, 40);
  if (!list.length) {
    container.innerHTML = '<div class="admin-note">没有符合条件的任务。</div>';
    return;
  }
  container.innerHTML = list.map((task) => `
    <div class="admin-task">
      <div class="admin-task-main">
        <b>${esc(task.title)}</b>
        <small>${STATUS_LABEL[task.status] || task.status} · ${workerLabel(task.worker)} · ${timeAgo(task.created_at)}${task.tokens ? ` · ${task.tokens} tokens` : ''}</small>
      </div>
      <div class="admin-task-actions">
        ${['failed', 'cancelled', 'done'].includes(task.status) ? `<button data-admin-action="retry" data-id="${task.id}">${task.status === 'done' ? '重跑' : '重试'}</button>` : ''}
        ${task.status !== 'running' ? `<button data-admin-action="edit" data-id="${task.id}">编辑</button>` : ''}
        ${task.status !== 'running' ? `<button class="danger" data-admin-action="delete" data-id="${task.id}">删除</button>` : ''}
        <button data-admin-action="open" data-id="${task.id}">详情</button>
      </div>
    </div>`).join('');
}

function renderAdminLogs() {
  const el = $('#admin-logs');
  if (!el) return;
  el.textContent = (state.adminLogs || [])
    .map((line) => `${line.at.slice(11, 19)} ${line.level.toUpperCase().padEnd(5)} ${line.message}`)
    .join('\n') || '暂无日志。';
  el.scrollTop = el.scrollHeight;
}

async function adminAction(action, id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  try {
    if (action === 'retry') {
      await api(`/api/tasks/${id}/retry`, { method: 'POST' });
      toast('任务已重新排队。');
    } else if (action === 'delete') {
      if (!confirm(`删除「${task.title}」？事件、审批记录会一起清掉。`)) return;
      await api(`/api/tasks/${id}`, { method: 'DELETE' });
      state.tasks = state.tasks.filter((t) => t.id !== id);
      toast('任务已删除。');
    } else if (action === 'open') {
      openTask(id);
      return;
    } else if (action === 'edit') {
      editTask(task);
      return;
    }
    await loadAdmin();
  } catch (err) {
    toast(err.message);
  }
}

function editTask(task) {
  openDialog({
    title: '编辑任务',
    desc: '修改后按原任务重新排队；正在执行的任务不能编辑。',
    body: `
      <label class="field"><span>任务名</span><input name="title" value="${esc(task.title)}" /></label>
      <label class="field"><span>指令</span><textarea name="prompt" rows="4">${esc(task.prompt)}</textarea></label>
      <label class="field"><span>Worker</span>
        <select name="worker">
          ${workerIds().map((w) => `<option value="${w}" ${task.worker === w ? 'selected' : ''}>${workerLabel(w)}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>优先级（1 最高）</span><input name="priority" type="number" min="1" max="5" value="${task.priority || 2}" /></label>`,
    onSubmit: async (values) => {
      await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: { ...values, priority: Number(values.priority) }
      });
      if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'queued') {
        await api(`/api/tasks/${task.id}/retry`, { method: 'POST' });
      }
      toast('任务已更新。');
      await loadAdmin();
    }
  });
}

$('#admin-refresh')?.addEventListener('click', loadAdmin);
$('#refresh-logs')?.addEventListener('click', async () => {
  try {
    const data = await api('/api/admin/logs?limit=200');
    state.adminLogs = data.logs || [];
    renderAdminLogs();
  } catch (err) {
    toast(err.message);
  }
});
$('#admin-search')?.addEventListener('input', renderAdminTasks);
$('#admin-filter')?.addEventListener('change', renderAdminTasks);

$('#queue-toggle')?.addEventListener('click', async () => {
  const paused = Boolean(state.adminOverview?.settings?.queuePaused);
  try {
    const data = await api('/api/admin/queue', { method: 'POST', body: { paused: !paused } });
    if (state.adminOverview) {
      state.adminOverview.settings.queuePaused = data.paused;
      state.adminOverview.stats = data.stats;
    }
    renderAdminOverview();
    toast(data.paused ? '队列已暂停，新任务只会排队。' : '队列已恢复。');
  } catch (err) {
    toast(err.message);
  }
});

$('#save-persona')?.addEventListener('click', async () => {
  const persona = $('#persona-input').value.trim();
  try {
    const data = await api('/api/settings', { method: 'PUT', body: { persona } });
    state.settings = data.settings;
    toast('助手人设已保存。');
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-admin-action]');
  if (!btn) return;
  adminAction(btn.dataset.adminAction, btn.dataset.id);
});

function editMemory(id) {
  const item = state.memories.find((m) => m.id === id);
  if (!item) return;
  openDialog({
    title: '编辑记忆',
    desc: '改完会立即影响 Router 和 Worker 拿到的上下文。',
    body: `
      <label class="field"><span>内容</span><textarea name="text" rows="4">${esc(item.text)}</textarea></label>
      <label class="field"><span>层级</span>
        <select name="layer">
          ${['profile', 'semantic', 'episodic', 'working'].map((l) => `<option value="${l}" ${item.layer === l ? 'selected' : ''}>${LAYER_LABEL[l]}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>重要度（0–1）</span><input name="importance" type="number" min="0" max="1" step="0.05" value="${item.importance}" /></label>`,
    onSubmit: async (values) => {
      await api(`/api/memories/${id}`, {
        method: 'PATCH',
        body: { text: values.text, layer: values.layer, importance: Number(values.importance) }
      });
      await loadMemories();
      toast('记忆已更新。');
    }
  });
}

/* ------------------------------- SSE ---------------------------------- */

function upsertTask(task) {
  if (!task) return;
  const index = state.tasks.findIndex((t) => t.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);
  updateBadges();
}

function updateBadges() {
  const waiting = state.approvals.filter((a) => a.status === 'pending').length;
  const badge = $('#badge-tasks');
  if (badge) {
    badge.hidden = waiting === 0;
    badge.textContent = String(waiting);
  }
  if (state.view !== 'chat') {
    const dot = $('#dot-chat');
    if (dot && state.messages.some((m) => m.role === 'assistant')) dot.hidden = waiting === 0;
  }
}

let sseOpenedOnce = false;
let sse = null;
let sseRetry = null;

function setConnectionLive(live) {
  state.connected = live;
  $('#conn').classList.toggle('is-live', live);
  $('#conn').classList.toggle('is-off', !live);
  $('#conn-label').textContent = live ? '实时连接' : '重连中';
}

function disconnectEvents() {
  if (sse) {
    sse.close();
    sse = null;
  }
  if (sseRetry) {
    clearTimeout(sseRetry);
    sseRetry = null;
  }
  setConnectionLive(false);
}

function connectEvents() {
  if (document.hidden || sse) return;
  const es = new EventSource('/api/stream');
  sse = es;

  es.onopen = () => {
    setConnectionLive(true);
    if (sseOpenedOnce) resync().catch(() => {});
    sseOpenedOnce = true;
  };
  es.onerror = () => {
    setConnectionLive(false);
    if (sse !== es) return;
    sse = null;
    es.close();
    if (sseRetry) return;
    sseRetry = setTimeout(() => {
      sseRetry = null;
      connectEvents();
    }, 3000);
  };

  const on = (type, fn) => es.addEventListener(type, (e) => {
    try { fn(JSON.parse(e.data).payload || {}); } catch (err) { console.warn(err); }
  });

  on('chat/message', ({ message }) => {
    if (!message || state.messages.some((m) => m.id === message.id)) return;
    state.messages.push(message);
    renderChat();
    if (message.role === 'assistant' && state.view !== 'chat') {
      const dot = $('#dot-chat');
      if (dot) dot.hidden = false;
    }
  });

  on('task/created', ({ task }) => {
    upsertTask(task);
    renderTasks();
    renderChat();
    if (state.view === 'admin') renderAdminTasks();
  });

  on('task/updated', ({ task }) => {
    upsertTask(task);
    if (task.status === 'waiting_approval' && !state.approvals.some((a) => a.task_id === task.id)) {
      // approval/created 会随后到达，这里只做提示
    }
    renderTasks();
    renderChat();
    if (state.view === 'admin') renderAdminTasks();
    if (state.openTaskId === task.id) openTask(task.id);
  });

  on('task/progress', ({ taskId, message }) => {
    const task = taskById(taskId);
    if (task) {
      task.progress = message;
      renderChat();
      if (state.openTaskId === taskId) {
        const node = $('#drawer .drawer-result');
        if (node) node.textContent = message;
      }
    }
  });

  on('task/deleted', ({ id }) => {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    if (state.view === 'tasks') renderTasks();
    if (state.view === 'admin') renderAdminTasks();
  });

  on('memory/updated', () => {
    if (state.view === 'memory') loadMemories();
  });

  on('approval/created', ({ approval }) => {
    if (!state.approvals.some((a) => a.id === approval.id)) state.approvals.unshift(approval);
    const task = taskById(approval.task_id);
    toast(`「${task?.title || '任务'}」在等你拍板。`, 3200);
    renderChat();
    renderTasks();
    updateBadges();
  });

  on('approval/resolved', ({ approval }) => {
    state.approvals = state.approvals.filter((a) => a.id !== approval.id);
    renderChat();
    renderTasks();
    updateBadges();
  });

  on('stats/updated', (stats) => {
    state.stats = stats;
    if (state.view === 'tasks') renderTasks();
    if (state.view === 'admin' && state.adminOverview) {
      state.adminOverview.stats = stats;
      renderAdminOverview();
    }
    updateBadges();
  });

  on('settings/updated', ({ settings }) => {
    state.settings = settings;
    if (state.view === 'settings') fillSettings();
  });

  on('plugins/updated', ({ plugins, errors }) => {
    state.plugins = plugins;
    if (Array.isArray(errors)) state.pluginErrors = errors;
    if (state.view === 'settings') renderPlugins();
  });

  on('plugin/status', ({ plugin }) => {
    if (!plugin) return;
    const index = state.plugins.findIndex((p) => p.id === plugin.id);
    if (index >= 0) state.plugins[index] = plugin;
    if (state.view === 'settings') renderPlugins();
  });

  on('channel/delivery', (item) => {
    if (!item.ok) toast(`${item.channel} 通知发送失败：${item.error || ''}`);
  });
}

/* ------------------------------- click -------------------------------- */

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'open-task') openTask(el.dataset.id);
  else if (action === 'jump-approval') {
    const card = document.querySelector('.task-card .approval')?.closest('.task-card');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('is-flash');
      setTimeout(() => card.classList.remove('is-flash'), 1600);
    }
  }
  else if (action === 'close-drawer') closeDrawer();
  else if (action === 'approve') approveTask(el.dataset.id, Number(el.dataset.choice));
  else if (action === 'cancel-task') {
    el.disabled = true;
    await cancelTask(el.dataset.id);
  } else if (action === 'save-task-workspace') {
    const id = el.dataset.id;
    const select = document.querySelector(`[data-task-workspace="${id}"]`);
    if (!select || !select.value || select.value === '__custom__') {
      toast('先选择一个工作目录。');
      return;
    }
    const worker = document.querySelector(`[data-task-worker="${id}"]`)?.value;
    try {
      await api(`/api/tasks/${id}`, { method: 'PATCH', body: { cwd: select.value, ...(worker ? { worker } : {}) } });
      toast('任务工作目录和 Worker 已更新。');
      await openTask(id);
    } catch (err) {
      toast(err.message);
    }
  } else if (action === 'forget') {
    if (confirm('要忘掉这条记忆吗？')) forgetMemory(el.dataset.id);
  } else if (action === 'edit-memory') {
    editMemory(el.dataset.id);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.openTaskId) closeDrawer();
});

/* ------------------------------- boot --------------------------------- */

function applySnapshot(data, { initial = false } = {}) {
  Object.assign(state, {
    settings: data.settings,
    workers: data.workers,
    stats: data.stats,
    tasks: data.tasks,
    approvals: data.approvals,
    memories: data.memories,
    memoryStats: data.memoryStats,
    messages: data.messages,
    rules: data.rules,
    workerRules: data.workerRules || [],
    plugins: data.plugins || [],
    pluginErrors: data.pluginErrors || [],
    channels: data.channels,
    server: data.server,
    sessionId: data.sessionId
  });
  renderChat({ initial });
  renderTasks();
  renderMemories();
  fillSettings();
  updateBadges();
  if (state.openTaskId) openTask(state.openTaskId);
}

async function resync() {
  const data = await api('/api/bootstrap');
  applySnapshot(data);
}

async function loadPairing(force = false) {
  if (state.pairing && !force) {
    renderPairing();
    return;
  }
  try {
    state.pairing = await api('/api/auth/pairing');
    state.pairVisible = false;
    renderPairing();
  } catch {
    /* 未配对时由全局 401 处理 */
  }
}

function renderPairing() {
  if (!state.pairing) return;
  const keyEl = $('#pair-key');
  const urlEl = $('#pair-url');
  if (keyEl) keyEl.textContent = state.pairVisible ? state.pairing.key : '••••••••-••••••••-••••••••';
  if (urlEl) urlEl.textContent = state.pairing.url;
  const show = $('#show-pair');
  if (show) show.textContent = state.pairVisible ? '隐藏' : '显示';
}

$('#show-pair')?.addEventListener('click', () => {
  state.pairVisible = !state.pairVisible;
  renderPairing();
});

$('#copy-pair')?.addEventListener('click', async () => {
  if (!state.pairing) return;
  const text = `静静\n地址：${state.pairing.url}\n配对码：${state.pairing.key}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('配对信息已复制。');
    if (/127\.0\.0\.1|localhost/.test(state.pairing.url)) {
      toast('手机访问请用局域网或 Tailscale 地址，不要用 127.0.0.1。', 4200);
    }
  } catch {
    toast('复制失败，请手动选中配对码。');
  }
});

$('#rotate-pair')?.addEventListener('click', async () => {
  if (!state.pairing) return;
  if (!confirm('重新生成后，所有手机/浏览器都需要用新配对码重新登录。继续吗？')) return;
  try {
    const data = await api('/api/auth/rotate', { method: 'POST' });
    state.pairing.key = data.key;
    state.pairVisible = true;
    renderPairing();
    toast('已生成新的配对码，请在所有设备上重新配对。', 4200);
  } catch (err) {
    toast(err.message);
  }
});

$('#logout-btn')?.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    location.reload();
  }
});

async function boot() {
  initTheme();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch(() => {});
  }
  updateInstallStatus();
  try {
    const status = await api('/api/auth/status');
    if (!status.authenticated) {
      showLogin();
      return;
    }
    hideLogin();
    const data = await api('/api/bootstrap');
    applySnapshot(data, { initial: true });
    connectEvents();
    const initial = location.hash.replace('#', '');
    if (['tasks', 'memory', 'admin', 'settings'].includes(initial)) switchView(initial);
  } catch (err) {
    toast(`启动失败：${err.message}`, 6000);
    $('#presence-sub').textContent = '连不上本地服务，确认 server.js 还在跑。';
  }
}

boot();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) disconnectEvents();
  else {
    connectEvents();
    resync().catch(() => {});
  }
});
window.addEventListener('focus', () => {
  if (state.view === 'tasks') renderTasks();
});

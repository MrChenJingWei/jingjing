// 外壳：导航、侧栏「正在发生」、深浅色、连接状态、安装、登录、快捷键。
import { $, $$, state, on, esc, api, toast, isTyping, approvalFor, timeAgo } from './core.js';
import { icon, anyDialogOpen, catMark, openMenu } from './ui.js';
import { renderChat } from './chat.js';
import { enterTasks, openTask, closeDrawer, toggleQueue } from './tasks.js';
import { enterMemory } from './memory.js';
import { enterSettings, leaveSettingsOk, settingsHasAttention } from './settings.js';

export const VIEWS = ['chat', 'tasks', 'memory', 'settings'];
const VIEW_TITLE = { chat: '对话', tasks: '任务', memory: '记忆', settings: '设置' };

/* ------------------------------- 导航 -------------------------------- */

/**
 * 切到某个页面。sub 是二级位置（设置的分页）。旧的「管理」页并进了设置 → 运行状态。
 * 设置页有没保存的改动时，离开前会先问。
 */
export async function switchView(name, { sub = null, force = false } = {}) {
  if (name === 'admin') { name = 'settings'; sub = sub || 'status'; }
  if (!VIEWS.includes(name)) name = 'chat';
  if (!force && state.view === 'settings' && name !== 'settings' && !(await leaveSettingsOk())) {
    syncHash();
    return;
  }
  const previous = state.view;
  state.view = name;
  closeDrawer();
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  $$('[data-nav]').forEach((t) => t.classList.toggle('is-active', t.dataset.nav === name));
  const title = $('#mobile-title');
  if (title) title.textContent = VIEW_TITLE[name];
  if (name === 'chat') {
    renderChat({ forceBottom: previous !== 'chat' });
    setDot('chat', false);
  }
  if (name === 'tasks') enterTasks();
  if (name === 'memory') enterMemory();
  if (name === 'settings') await enterSettings(sub);
  renderActivity();
  syncHash();
}

/** 地址栏 #hash 跟着当前位置走，刷新后能回到原处。 */
export function syncHash() {
  const target = state.view === 'settings' && state.settingsPage ? `#settings/${state.settingsPage}` : `#${state.view}`;
  if (location.hash !== target) history.replaceState(null, '', target);
}

export function parseHash(hash = location.hash) {
  const [view, sub] = hash.replace(/^#/, '').split('/');
  return { view: view || 'chat', sub: sub || null };
}

window.addEventListener('hashchange', () => {
  const { view, sub } = parseHash();
  if (view !== state.view || (view === 'settings' && sub && sub !== state.settingsPage)) switchView(view, { sub });
});

$$('[data-nav]').forEach((btn) => btn.addEventListener('click', () => {
  // 已经在设置页时再点「设置」：桌面保持当前分页，手机回到分类列表。
  if (btn.dataset.nav === state.view && state.view !== 'settings') return;
  switchView(btn.dataset.nav);
}));

export function setDot(name, visible) {
  $$(`[data-dot="${name}"]`).forEach((dot) => { dot.hidden = !visible; });
}

export function updateBadges() {
  const waiting = state.approvals.filter((a) => a.status === 'pending').length;
  $$('[data-badge="tasks"]').forEach((badge) => {
    badge.hidden = waiting === 0;
    badge.textContent = String(waiting);
  });
  setDot('settings', settingsHasAttention());
  document.title = waiting ? `(${waiting}) 静静` : '静静';
}

/* --------------------------- 侧栏：正在发生 --------------------------- */

const ACTIVITY_LIMIT = 5;

function activityItem(task, sub) {
  const current = state.view === 'tasks' && state.selectedTaskId === task.id;
  return `
    <button type="button" class="act-item ${current ? 'is-current' : ''}" data-act-task="${esc(task.id)}" title="${esc(task.title)}">
      <span class="sdot" data-s="${task.status}"></span>
      <span class="act-main"><b>${esc(task.title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    </button>`;
}

export function renderActivity() {
  const box = $('#activity');
  if (!box) return;
  const waiting = state.tasks.filter((t) => t.status === 'waiting_approval');
  const running = state.tasks.filter((t) => t.status === 'running');
  const queued = state.tasks.filter((t) => t.status === 'queued');
  const groups = [];
  if (waiting.length) {
    groups.push(`
      <div class="act-group">
        <div class="act-head is-warm"><b>等你拍板</b><span>${waiting.length}</span></div>
        ${waiting.slice(0, ACTIVITY_LIMIT).map((t) => activityItem(t, approvalFor(t)?.question || '')).join('')}
      </div>`);
  }
  if (running.length || queued.length) {
    const list = [...running, ...queued];
    groups.push(`
      <div class="act-group">
        <div class="act-head"><b>进行中</b><span>${running.length}${queued.length ? ` · 排队 ${queued.length}` : ''}</span></div>
        ${list.slice(0, ACTIVITY_LIMIT).map((t) => activityItem(t, t.status === 'running' ? (t.progress || '执行中…') : '排队中')).join('')}
      </div>`);
  }
  const hidden = waiting.length + running.length + queued.length - Math.min(waiting.length, ACTIVITY_LIMIT) - Math.min(running.length + queued.length, ACTIVITY_LIMIT);
  box.innerHTML = groups.length
    ? groups.join('') + (hidden > 0 ? `<button type="button" class="act-more" data-act-all>还有 ${hidden} 件，查看全部</button>` : '')
    : idleHtml();
  renderQueueChip();
}

/** 没有在跑的事：品牌那句「事办完，你静静」，下面带上一件做完的事（点了能打开）。 */
function idleHtml() {
  const last = state.tasks.find((t) => t.status === 'done');
  return `
    <div class="act-idle">
      ${catMark()}
      <b>事都办完了</b>
      <small>没有在跑的事，你静静。</small>
      ${last ? `<button type="button" class="act-last" data-act-task="${esc(last.id)}" title="${esc(last.title)}">
        <span class="sdot" data-s="done"></span><span class="act-main"><b>${esc(last.title)}</b><small>${esc(timeAgo(last.finished_at || last.updated_at || last.created_at))}完成</small></span>
      </button>` : ''}
    </div>`;
}

/** 侧栏底部的状态：连接 + 调度 + 手上有几件，合成一句话，竖条跟着状态动。 */
export function renderLiveStatus() {
  const chip = $('#live-status');
  if (!chip) return;
  const paused = Boolean(state.stats?.paused ?? state.settings?.queuePaused);
  const running = state.tasks.filter((t) => t.status === 'running').length;
  const queued = state.tasks.filter((t) => t.status === 'queued').length;
  let mode;
  let text;
  if (state.connected === false) { mode = 'offline'; text = '重连中…'; }
  else if (state.connected !== true) { mode = 'connecting'; text = '连接中…'; }
  else if (paused) { mode = 'paused'; text = queued ? `调度已暂停 · ${queued} 件在等` : '调度已暂停'; }
  else if (running) { mode = 'busy'; text = `正在做 ${running} 件${queued ? ` · 排队 ${queued}` : ''}`; }
  else if (queued) { mode = 'busy'; text = `马上开始 · 排队 ${queued}`; }
  else { mode = 'idle'; text = '在线 · 待命'; }
  chip.dataset.mode = mode;
  chip.title = text;
  chip.setAttribute('aria-label', `静静：${text}`);
}

function renderQueueChip() {
  renderLiveStatus();
}

$('#activity')?.addEventListener('click', (event) => {
  const item = event.target.closest('[data-act-task]');
  if (item) { openTask(item.dataset.actTask, { reveal: true }); return; }
  if (event.target.closest('[data-act-all]')) switchView('tasks');
});
$('#live-status')?.addEventListener('click', (event) => {
  const paused = Boolean(state.stats?.paused ?? state.settings?.queuePaused);
  const running = state.tasks.filter((t) => t.status === 'running').length;
  openMenu(event.currentTarget, [
    { heading: state.connected ? '已连上主机' : '和主机断开了' },
    running ? { label: `看看正在做的 ${running} 件`, icon: 'activity', onSelect: () => switchView('tasks') } : null,
    { label: paused ? '恢复调度' : '暂停调度（新任务只排队）', icon: paused ? 'play' : 'pause', onSelect: () => toggleQueue() },
    { label: '重新连接', icon: 'refresh', onSelect: () => location.reload() },
    canInstall() ? 'divider' : null,
    canInstall() ? { label: '安装到这台设备', icon: 'download', onSelect: () => promptInstall() } : null
  ], { align: 'start' });
});

on('tasks', renderActivity);
on('approvals', () => { renderActivity(); updateBadges(); });
on('stats', renderQueueChip);
on('settings', renderQueueChip);
on('workflows', updateBadges);
// 侧栏名字下面写她此刻的心情；平静时写回「个人 AI 工作站」。
on('mind', () => {
  const sub = $('.brand-text small');
  const mood = state.mind?.mood;
  if (!sub) return;
  const moody = mood?.enabled !== false && mood?.label && mood.label !== '平静';
  sub.textContent = moody ? `此刻${mood.label}` : '';
  // 字标里已经有品牌语，平静时不再多写一行。
  sub.hidden = !moody;
  sub.title = moody && mood.cause ? mood.cause : '';
});
on('plugins', updateBadges);

/* ------------------------------- 深浅色 ------------------------------ */

function applyTheme(theme, { save = true } = {}) {
  document.documentElement.dataset.theme = theme;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0E0C1C' : '#F4F3F8');
  if (save) {
    try { localStorage.setItem('jingjing-theme', theme); } catch { /* 存不了就只对本次生效 */ }
  }
  $$('[data-theme-toggle]').forEach((btn) => {
    btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
    btn.title = theme === 'dark' ? '切换到浅色' : '切换到深色';
  });
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('jingjing-theme'); } catch { /* ignore */ }
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  applyTheme(saved || (media?.matches ? 'dark' : 'light'), { save: false });
  // 没手动选过时，跟着系统变。
  media?.addEventListener?.('change', (event) => {
    let pinned = null;
    try { pinned = localStorage.getItem('jingjing-theme'); } catch { /* ignore */ }
    if (!pinned) applyTheme(event.matches ? 'dark' : 'light', { save: false });
  });
}

$$('[data-theme-toggle]').forEach((btn) => btn.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}));

/* ------------------------------- 连接 -------------------------------- */

export function setConnectionLive(live) {
  state.connected = live;
  $$('[data-conn]').forEach((el) => {
    el.classList.toggle('is-live', live);
    el.classList.toggle('is-off', !live);
  });
  $$('[data-conn-label]').forEach((el) => { el.textContent = live ? '已连接' : '重连中'; });
  renderLiveStatus();
}

$$('[data-conn]').forEach((el) => el.addEventListener('click', () => location.reload()));

/* ------------------------------- 安装 -------------------------------- */

export const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
export const nativeApp = /JingjingDesktop\//.test(navigator.userAgent);
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
let deferredInstallPrompt = null;

export function updateInstallStatus() {
  const status = $('#install-status');
  if (status) {
    status.textContent = nativeApp
      ? '你正在用 macOS App，这台电脑不需要再装；手机按上面的方式安装。'
      : standalone
        ? '已安装：当前是独立窗口运行。'
        : deferredInstallPrompt
          ? '可以安装：点上面的按钮，或浏览器菜单里的「安装应用」。'
          : isIOS
            ? 'iPhone / iPad 请用 Safari 的分享按钮 → 添加到主屏幕。'
            : '当前浏览器没有提供一键安装，请按上面的步骤手动添加。';
  }
  const hideButton = !canInstall();
  $$('[data-install-btn]').forEach((btn) => { btn.hidden = hideButton; });
  const installApp = $('#install-app');
  if (installApp) installApp.hidden = nativeApp || standalone;
}

/** 这台设备能不能装：原生 App / 已安装 / 浏览器不支持时都不提。 */
function canInstall() {
  return !(nativeApp || standalone || (!deferredInstallPrompt && !isIOS));
}

async function promptInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    try {
      const choice = await deferredInstallPrompt.userChoice;
      toast(choice.outcome === 'accepted' ? '正在安装静静…' : '已取消安装，随时可以在设置里再装。');
    } catch { /* ignore */ }
    deferredInstallPrompt = null;
    updateInstallStatus();
  } else {
    switchView('settings', { sub: 'pairing' });
    toast('按「安装到手机 / 桌面」里的步骤添加到主屏幕。', 3600);
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
$$('[data-install-btn]').forEach((btn) => btn.addEventListener('click', promptInstall));
$('#install-app')?.addEventListener('click', promptInstall);

/* ------------------------------- 登录 -------------------------------- */

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

/* ------------------------------ 快捷键 ------------------------------- */

document.addEventListener('keydown', (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && !event.shiftKey && !event.altKey && /^[1-4]$/.test(event.key)) {
    event.preventDefault();
    switchView(VIEWS[Number(event.key) - 1]);
    return;
  }
  if (event.key === 'Escape' && !anyDialogOpen() && state.drawerTaskId) {
    closeDrawer();
    return;
  }
  // 「/」随手聚焦：对话页是输入框，任务和记忆页是搜索框。
  if (event.key === '/' && !mod && !isTyping(event.target) && !anyDialogOpen()) {
    const target = { chat: '#input', tasks: '#task-search', memory: '#mem-search' }[state.view];
    if (target) {
      event.preventDefault();
      $(target)?.focus();
    }
  }
});

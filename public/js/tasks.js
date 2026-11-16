// 任务页：左边列表、右边详情（窄屏时详情从右侧滑出）。原「管理」页的重试 / 编辑 / 删除 / 暂停调度都在这里。
import {
  $, $$, state, on, changed, esc, md, timeAgo, clock, durationText, tokensText, toast, api,
  workerLabel, workerGlyph, workerIds, taskById, approvalFor, workflowById, upsertTask,
  ensureWorkspaceForPath, pickFolder, isWide, onWideChange, copyText,
  STATUS_LABEL, EVENT_LABEL, RUN_STATUS_LABEL, ORIGIN_LABEL, ACTIVE_STATUSES
} from './core.js';
import { icon, openDialog, ask } from './ui.js';
import { switchView, renderActivity } from './shell.js';

/* ------------------------------ 小部件 -------------------------------- */

export function statusPill(status) {
  return `<span class="pill" data-s="${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

export function elapsedHtml(task) {
  if (!task.started_at) return '';
  return `<span class="elapsed" data-started="${esc(task.started_at)}">· 已运行 ${durationText(Date.now() - new Date(task.started_at).getTime())}</span>`;
}

// Worker 不回传进度时，至少让人看到它还在跑、跑了多久。
setInterval(() => {
  for (const el of document.querySelectorAll('.elapsed[data-started]')) {
    el.textContent = `· 已运行 ${durationText(Date.now() - new Date(el.dataset.started).getTime())}`;
  }
}, 5000);

/** 任务来自能回消息的来源（比如企微机器人）且已完成：可以把结果发回原会话。 */
function replySourceOf(task) {
  if (!task || task.status !== 'done' || !task.reply_to || !String(task.origin || '').startsWith('plugin:')) return null;
  const plugin = (state.plugins || []).find((item) => item.id === task.origin.slice('plugin:'.length));
  return plugin?.canReply && plugin.enabled ? plugin : null;
}

export function replyButton(task, size = 'sm') {
  return replySourceOf(task) ? `<button type="button" class="btn ${size}" data-action="reply-source" data-id="${esc(task.id)}">${icon('reply')}发回原会话</button>` : '';
}

function originLabel(task) {
  const origin = String(task.origin || '');
  if (origin.startsWith('plugin:')) {
    const plugin = (state.plugins || []).find((item) => item.id === origin.slice(7));
    return `来自 ${plugin?.label || plugin?.name || origin.slice(7)}`;
  }
  if (origin.startsWith('rule:') || task.rule_id) return '自动化触发';
  return ORIGIN_LABEL[origin] || '对话创建';
}

/* ------------------------------- 拍板 -------------------------------- */

// 拍板输入框里没提交的文字：对话和详情会整块重绘，靠它把内容和光标还原回去。
const approvalDrafts = new Map();

export function approvalBlock(task, approval) {
  return `
    <div class="approval">
      <div class="approval-q">${icon('alert')}<span>${esc(approval.question)}</span></div>
      <div class="approval-opts">
        ${(approval.options || []).map((opt, i) => `
          <button type="button" class="btn sm ${i === 0 ? 'primary' : ''}" data-action="approve" data-id="${esc(task.id)}" data-choice="${i}">${esc(opt)}</button>`).join('')}
      </div>
      ${approval.custom ? `
        <div class="approval-custom">
          <input type="text" maxlength="500" data-approval-input="${esc(approval.id)}" data-task-id="${esc(task.id)}"
            value="${esc(approvalDrafts.get(approval.id) || '')}" placeholder="都不合适？直接写你的决定，比如：先问问产品再说" autocomplete="off" />
          <button type="button" class="btn sm" data-action="approve-custom" data-id="${esc(task.id)}" data-approval-id="${esc(approval.id)}">按这个办</button>
        </div>` : ''}
      <p class="approval-note">选完后会从挂起点恢复，接着原来的上下文继续跑。</p>
    </div>`;
}

/** 重绘一块区域时，保住拍板输入框的焦点和光标位置。 */
export function keepApprovalFocus(render) {
  const active = document.activeElement;
  const id = active?.dataset?.approvalInput;
  const selection = id ? [active.selectionStart, active.selectionEnd] : null;
  render();
  if (!id) return;
  const input = $$('[data-approval-input]').find((el) => el.dataset.approvalInput === id);
  if (!input) return;
  input.focus({ preventScroll: true });
  try { input.setSelectionRange(...selection); } catch { /* 不支持就算了 */ }
}

async function approveTask(taskId, choice, answer = '') {
  try {
    await api(`/api/tasks/${taskId}/approve`, { method: 'POST', body: answer ? { answer } : { choice } });
    toast(answer ? '收到，按你的决定继续。' : choice >= 0 ? '收到，从停机点继续处理。' : '好，这件事停下了。');
    return true;
  } catch (err) {
    toast(`${err.message}，正在同步最新状态…`, 4000);
    import('./sync.js').then((m) => m.resync()).catch(() => {});
    return false;
  }
}

async function submitApprovalAnswer(taskId, approvalId, el) {
  const answer = (approvalDrafts.get(approvalId) || '').trim();
  if (!answer) {
    toast('先写下你的决定，或者直接点上面的选项。');
    $(`[data-approval-input="${CSS.escape(approvalId)}"]`)?.focus();
    return;
  }
  el.disabled = true;
  if (await approveTask(taskId, null, answer)) approvalDrafts.delete(approvalId);
  el.disabled = false;
}

document.addEventListener('input', (event) => {
  const id = event.target.dataset?.approvalInput;
  if (id) approvalDrafts.set(id, event.target.value);
});

document.addEventListener('keydown', (event) => {
  const input = event.target.closest?.('[data-approval-input]');
  if (input && event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    submitApprovalAnswer(input.dataset.taskId, input.dataset.approvalInput, input);
  }
});

/* ------------------------------- 列表 -------------------------------- */

const FILTERS = [
  { id: 'all', label: '全部', test: () => true },
  { id: 'waiting_approval', label: '待拍板', test: (t) => t.status === 'waiting_approval', warm: true },
  { id: 'active', label: '进行中', test: (t) => ['queued', 'running'].includes(t.status) },
  { id: 'done', label: '已完成', test: (t) => t.status === 'done' },
  { id: 'failed', label: '失败', test: (t) => ['failed', 'cancelled'].includes(t.status) }
];

function filteredTasks() {
  const filter = FILTERS.find((f) => f.id === state.taskFilter) || FILTERS[0];
  const q = state.taskQuery.trim().toLowerCase();
  return state.tasks.filter((t) => filter.test(t) && (!q || `${t.title} ${t.prompt || ''} ${t.id}`.toLowerCase().includes(q)));
}

function taskSubtitle(t) {
  const approval = approvalFor(t);
  if (t.status === 'waiting_approval' && approval) return approval.question;
  if (t.status === 'running') return t.progress || '执行中…';
  if (t.status === 'queued') return '排队中，等空闲的执行槽位';
  if (t.status === 'failed') return t.error || t.result || '失败了';
  return (t.result || t.prompt || '').split('\n').find((line) => line.trim()) || '—';
}

function renderFilters() {
  const box = $('#task-filters');
  if (!box) return;
  const q = state.taskQuery.trim().toLowerCase();
  const base = q ? state.tasks.filter((t) => `${t.title} ${t.prompt || ''} ${t.id}`.toLowerCase().includes(q)) : state.tasks;
  box.innerHTML = FILTERS.map((f) => {
    const count = base.filter(f.test).length;
    if (f.id !== 'all' && f.id !== state.taskFilter && count === 0 && f.id !== 'active') return '';
    return `<button type="button" class="fchip ${f.id === state.taskFilter ? 'is-active' : ''} ${f.warm && count ? 'is-warm' : ''}" data-task-filter="${f.id}" role="tab" aria-selected="${f.id === state.taskFilter}">${f.label}<em>${count}</em></button>`;
  }).join('');
}

export function renderTaskList() {
  renderFilters();
  renderQueueInfo();
  const box = $('#task-list');
  if (!box) return;
  const tasks = filteredTasks();
  if (!tasks.length) {
    box.innerHTML = `<div class="empty"><div class="empty-mark">静</div><p>${state.taskQuery ? '没有搜到相关任务。' : '这个分类下还没有任务。回对话里说一句，或者点右上角新建。'}</p></div>`;
    return;
  }
  box.innerHTML = tasks.map((t) => `
    <button type="button" class="trow ${t.id === state.selectedTaskId && isWide() ? 'is-selected' : ''} ${t.status === 'waiting_approval' ? 'is-waiting' : ''}" data-select-task="${esc(t.id)}">
      <span class="sdot" data-s="${esc(t.status)}"></span>
      <span class="trow-main">
        <span class="trow-top"><b>${esc(t.title)}</b><time>${timeAgo(t.created_at)}</time></span>
        <span class="trow-sub">${esc(taskSubtitle(t).slice(0, 140))}</span>
        <span class="trow-meta">${statusPill(t.status)}<span>${esc(workerLabel(t.worker))}</span><span>·</span><span>${esc(originLabel(t))}</span></span>
      </span>
    </button>`).join('');
}

function renderQueueInfo() {
  const counts = state.stats?.counts || {};
  const paused = Boolean(state.stats?.paused ?? state.settings?.queuePaused);
  const parts = [
    paused ? '调度已暂停，新任务只排队' : '调度运行中',
    `排队 ${counts.queued ?? 0}`,
    `执行中 ${counts.running ?? 0}`,
    `等你拍板 ${counts.waiting_approval ?? 0}`,
    `今日完成 ${state.stats?.doneToday ?? 0}`
  ];
  const info = $('#queue-info');
  if (info) info.textContent = parts.join(' · ');
  for (const id of ['#queue-toggle', '#status-queue-toggle']) {
    const btn = $(id);
    if (!btn) continue;
    btn.innerHTML = paused ? `${icon('play', 'sm')}恢复调度` : `${icon('pause', 'sm')}暂停调度`;
    btn.classList.toggle('warm', paused);
  }
  const statusInfo = $('#status-queue-info');
  if (statusInfo) statusInfo.textContent = parts.join(' · ');
}

export async function toggleQueue() {
  const paused = Boolean(state.stats?.paused ?? state.settings?.queuePaused);
  try {
    const data = await api('/api/admin/queue', { method: 'POST', body: { paused: !paused } });
    state.stats = { ...state.stats, ...data.stats, paused: data.paused };
    if (state.settings) state.settings.queuePaused = data.paused;
    changed('stats');
    toast(data.paused ? '调度已暂停，新任务只会排队。' : '调度已恢复。');
  } catch (err) {
    toast(err.message);
  }
}

/** 进入任务页：拉一次最新列表；桌面上没选中时自动选第一件要处理的事。 */
export async function enterTasks() {
  renderTaskList();
  ensureSelection();
  try {
    const data = await api('/api/tasks');
    state.tasks = data.tasks;
    state.stats = data.stats;
    changed('tasks', 'stats');
    ensureSelection();
  } catch (err) {
    toast(err.message);
  }
}

function ensureSelection() {
  if (state.view !== 'tasks' || !isWide()) return;
  const list = filteredTasks();
  if (state.selectedTaskId && state.tasks.some((t) => t.id === state.selectedTaskId)) {
    if (!$('#task-pane .detail')) loadDetail(state.selectedTaskId, 'pane');
    return;
  }
  const first = list.find((t) => t.status === 'waiting_approval') || list[0];
  if (first) selectTask(first.id);
  else renderPaneEmpty();
}

function renderPaneEmpty() {
  const pane = $('#task-pane');
  if (pane) pane.innerHTML = `<div class="empty pane-empty"><div class="empty-mark">静</div><p>选一个任务，在这里看指令、结果和时间线。</p></div>`;
}

function selectTask(id) {
  state.selectedTaskId = id;
  $$('#task-list .trow').forEach((row) => row.classList.toggle('is-selected', row.dataset.selectTask === id));
  renderActivity();
  loadDetail(id, 'pane');
}

/**
 * 打开任务详情。reveal：先切到任务页再选中（侧栏、系统通知用）；
 * 否则在任务页桌面布局里就地选中，别的地方从右侧滑出，不打断当前页面。
 */
export async function openTask(id, { reveal = false } = {}) {
  if (!id) return;
  if (reveal && state.view !== 'tasks') {
    state.selectedTaskId = id;
    await switchView('tasks');
  }
  if (state.view === 'tasks' && isWide()) {
    if (!state.tasks.some((t) => t.id === id)) {
      // 不在当前筛选结果里：切到「全部」再选。
      state.taskFilter = 'all';
      state.taskQuery = '';
      const search = $('#task-search');
      if (search) search.value = '';
      renderTaskList();
    }
    selectTask(id);
    $(`#task-list [data-select-task="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  openDrawer(id);
}

function openDrawer(id) {
  state.drawerTaskId = id;
  $('#drawer-backdrop').hidden = false;
  const drawer = $('#drawer');
  drawer.hidden = false;
  drawer.innerHTML = '<div class="empty"><span class="spinner"></span><p>读取任务…</p></div>';
  loadDetail(id, 'drawer');
}

export function closeDrawer() {
  if (!state.drawerTaskId && $('#drawer')?.hidden) return;
  state.drawerTaskId = null;
  $('#drawer').hidden = true;
  $('#drawer').innerHTML = '';
  $('#drawer-backdrop').hidden = true;
}

$('#drawer-backdrop')?.addEventListener('click', closeDrawer);

/* ------------------------------- 详情 -------------------------------- */

const detailCache = new Map();

async function loadDetail(id, mode) {
  try {
    const data = await api(`/api/tasks/${id}`);
    detailCache.set(id, data);
    if (mode === 'pane' && state.selectedTaskId !== id) return;
    if (mode === 'drawer' && state.drawerTaskId !== id) return;
    renderDetail(data, mode);
  } catch (err) {
    toast(err.message);
    if (mode === 'drawer') closeDrawer();
    if (mode === 'pane' && err.status === 404) {
      state.selectedTaskId = null;
      ensureSelection();
    }
  }
}

/** 某个任务变了：正开着它的详情就重新拉一次。 */
export function refreshTaskDetail(id) {
  if (state.selectedTaskId === id && state.view === 'tasks' && isWide()) loadDetail(id, 'pane');
  if (state.drawerTaskId === id) loadDetail(id, 'drawer');
}

function eventDetail(e) {
  if (!e.data) return '';
  if (e.type === 'task/created') return `${workerLabel(e.data.worker)}${e.data.workflow ? ` · 按流程「${e.data.workflow}」` : ''}`;
  if (e.type === 'approval/resolved') return e.data.option ? (e.data.custom ? `你的决定：${e.data.option}` : `${e.data.by === 'habit' ? '按习惯自动' : ''}选择：${e.data.option}`) : '';
  if (e.type === 'task/recovered') return { resume: '从断点继续', restart: '重新执行', ask: '等你决定是否重跑' }[e.data.mode] || '';
  if (e.type === 'task/started') return e.data.attempt > 1 ? `第 ${e.data.attempt} 次执行` : '';
  if (e.type === 'task/retry') return `第 ${e.data.attempt} 次尝试：${e.data.error || ''}`;
  if (e.type === 'workflow/proposed') return `候选习惯「${e.data.name || ''}」`;
  if (e.type === 'workflow/skipped') return e.data.reason || '';
  if (e.type === 'task/waiting_approval') return e.data.question || '';
  if (e.type === 'task/failed') return (e.data.error || '').slice(0, 160);
  if (e.type === 'task/proactive') return e.data.rule || '';
  if (e.type === 'task/edited' && e.data.from?.worker && e.data.to?.worker) {
    return `${e.data.by === 'approval' ? '按你的决定' : ''}改派：${workerLabel(e.data.from.worker)} → ${workerLabel(e.data.to.worker)}`;
  }
  if (e.type === 'task/replied') return `${e.data.by === 'auto' ? '自动' : '你'}发到「${e.data.label || e.data.via}」`;
  if (e.type === 'task/reply_failed') return (e.data.error || '').slice(0, 160);
  return '';
}

function runsHtml(runs = []) {
  if (!runs.length) return '';
  return `
    <section class="dsec">
      <div class="dsec-head"><h4>执行记录</h4></div>
      <div class="run-list">
        ${runs.map((run) => {
          const end = run.finished_at ? new Date(run.finished_at) : new Date();
          const took = durationText(end - new Date(run.started_at));
          const cp = run.checkpoint ? Object.keys(run.checkpoint).join('、') : '';
          return `<div class="run-item"><span>第 ${run.attempt} 次 · ${esc(RUN_STATUS_LABEL[run.status] || run.status)} · ${esc(took)}</span><small>${esc(cp ? `断点：${cp}` : clock(run.started_at))}</small></div>`;
        }).join('')}
      </div>
    </section>`;
}

function execSection(task) {
  const workspaces = state.settings?.workspaces || [];
  if (task.status === 'running') {
    return `<div class="dbox pre">${esc(workerLabel(task.worker))} · ${esc(task.cwd || '未指定工作目录')}</div>`;
  }
  const known = workspaces.some((ws) => ws.path === task.cwd);
  return `
    <div class="exec-edit">
      <select data-task-worker="${esc(task.id)}" aria-label="Worker">
        ${workerIds().map((worker) => `<option value="${esc(worker)}" ${task.worker === worker ? 'selected' : ''}>${esc(workerLabel(worker))}</option>`).join('')}
        ${task.worker && !workerIds().includes(task.worker) ? `<option value="${esc(task.worker)}" selected>${esc(workerLabel(task.worker))}（不可用）</option>` : ''}
      </select>
      <select data-task-workspace="${esc(task.id)}" aria-label="工作目录">
        ${workspaces.map((ws) => `<option value="${esc(ws.path)}" ${ws.path === task.cwd ? 'selected' : ''}>${esc(ws.name)} · ${esc(ws.path)}</option>`).join('')}
        ${task.cwd && !known ? `<option value="${esc(task.cwd)}" selected>当前 · ${esc(task.cwd)}</option>` : ''}
        <option value="__custom__">选择其他文件夹…</option>
      </select>
      <button type="button" class="btn sm" data-action="save-task-exec" data-id="${esc(task.id)}">应用</button>
    </div>
    <p class="hint">改完点「应用」；下次执行（重试或恢复）时生效。</p>`;
}

function renderDetail({ task, events, approval, runs }, mode) {
  const container = mode === 'drawer' ? $('#drawer') : $('#task-pane');
  if (!container) return;
  const pending = approval && approval.status === 'pending' ? approval : null;
  const active = ACTIVE_STATUSES.includes(task.status);
  const id = esc(task.id);
  const workflow = task.workflow_id ? workflowById(task.workflow_id) : null;
  const scrollTop = container.scrollTop;
  const sameTask = container.dataset.taskId === task.id;
  keepApprovalFocus(() => {
    container.dataset.taskId = task.id;
    container.innerHTML = `
      <article class="detail">
        <div class="detail-bar">
          ${statusPill(task.status)}
          <span class="grow"></span>
          ${active ? `<button type="button" class="btn sm danger" data-action="cancel-task" data-id="${id}">${icon('stop', 'sm')}停止</button>` : ''}
          ${['failed', 'cancelled', 'done'].includes(task.status) ? `<button type="button" class="btn sm" data-action="retry-task" data-id="${id}">${icon('retry', 'sm')}${task.status === 'done' ? '重跑' : '重试'}</button>` : ''}
          ${replyButton(task)}
          ${task.status === 'done' && !task.workflow_id ? `<button type="button" class="btn sm" data-action="learn-task" data-id="${id}" title="把这次的做法总结成工作流程，下次同类请求按它执行">${icon('flow', 'sm')}总结成流程</button>` : ''}
          ${task.status !== 'running' ? `<button type="button" class="icon-btn" data-action="edit-task" data-id="${id}" title="编辑">${icon('edit')}</button>` : ''}
          ${task.status !== 'running' ? `<button type="button" class="icon-btn danger" data-action="delete-task" data-id="${id}" title="删除">${icon('trash')}</button>` : ''}
          ${mode === 'drawer' ? `<button type="button" class="icon-btn" data-action="close-drawer" title="关闭（Esc）" aria-label="关闭">${icon('x')}</button>` : ''}
        </div>
        <h2>${esc(task.title)}</h2>
        <div class="detail-meta">
          <span class="tag">${esc(workerGlyph(task.worker))} ${esc(workerLabel(task.worker))}</span>
          ${task.workflow_id ? `<span class="tag">流程：${esc(workflow?.name || '已移除')}</span>` : ''}
          <span>${esc(originLabel(task))}</span>
          <span>创建于 ${timeAgo(task.created_at)}</span>
          ${task.tokens ? `<span>${tokensText(task.tokens)} tokens</span>` : ''}
        </div>

        ${pending ? `
          <section class="dsec">
            <div class="dsec-head"><h4>需要你拍板</h4></div>
            ${approvalBlock(task, pending)}
          </section>` : ''}

        ${task.status === 'running' ? `
          <section class="dsec">
            <div class="dsec-head"><h4>正在做</h4></div>
            <div class="dbox progress-box"><span class="spinner"></span><span data-progress-text="${id}">${esc(task.progress || '执行中，等 Worker 回传进度…')}</span>${elapsedHtml(task)}</div>
          </section>` : ''}

        ${task.result ? `
          <section class="dsec">
            <div class="dsec-head"><h4>${task.status === 'failed' ? '错误' : '结果'}</h4>
              <button type="button" class="btn xs ghost" data-action="copy-result" data-id="${id}">${icon('copy', 'sm')}复制</button></div>
            <div class="dbox ${task.status === 'failed' ? 'is-error pre' : 'prose'}">${task.status === 'failed' ? esc(task.result) : md(task.result)}</div>
          </section>` : ''}

        <section class="dsec">
          <div class="dsec-head"><h4>交给 Worker 的指令</h4></div>
          <div class="dbox pre">${esc(task.prompt)}</div>
        </section>

        <section class="dsec">
          <div class="dsec-head"><h4>Worker 与工作目录</h4></div>
          ${execSection(task)}
        </section>

        ${runsHtml(runs)}

        <section class="dsec">
          <div class="dsec-head"><h4>时间线</h4></div>
          <ul class="timeline">
            ${(events || []).map((e) => `
              <li>
                <span>${esc(EVENT_LABEL[e.type] || e.type)}</span><span class="t-time">${clock(e.created_at)}</span>
                ${eventDetail(e) ? `<div class="t-data">${esc(eventDetail(e))}</div>` : ''}
              </li>`).join('')}
          </ul>
        </section>
      </article>`;
  });
  if (sameTask) container.scrollTop = scrollTop;
  else container.scrollTop = 0;
}

function patchProgressText() {
  for (const el of $$('#task-pane [data-progress-text], #drawer [data-progress-text]')) {
    const task = taskById(el.dataset.progressText);
    if (task?.progress) el.textContent = task.progress;
  }
}

/* ------------------------------- 操作 -------------------------------- */

function openReplyDialog(taskId) {
  const task = taskById(taskId);
  const plugin = replySourceOf(task);
  if (!plugin) { toast('这个任务现在不能发回原会话。'); return; }
  openDialog({
    title: '发回原会话',
    desc: `会通过「${plugin.label || plugin.name}」发给当初发消息的会话。发之前可以改。`,
    body: `<label class="field"><span>要发的内容</span><textarea name="text" rows="10" maxlength="20000">${esc(task.result || '')}</textarea></label>`,
    okText: '发送',
    onSubmit: async ({ text }) => {
      if (!String(text || '').trim()) throw new Error('内容是空的');
      const data = await api(`/api/tasks/${taskId}/reply`, { method: 'POST', body: { text }, timeoutMs: 30000 });
      toast(`已发到「${data.label}」。`);
    }
  });
}

async function cancelTask(taskId) {
  try {
    await api(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
    toast('已停止。');
  } catch (err) {
    toast(`${err.message}，正在同步最新状态…`, 4000);
    import('./sync.js').then((m) => m.resync()).catch(() => {});
  }
}

async function retryTask(taskId) {
  try {
    const data = await api(`/api/tasks/${taskId}/retry`, { method: 'POST' });
    if (data.task) upsertTask(data.task);
    changed('tasks');
    refreshTaskDetail(taskId);
    toast('任务已重新排队。');
  } catch (err) {
    toast(err.message);
  }
}

async function deleteTask(taskId) {
  const task = taskById(taskId);
  const ok = await ask({ title: `删除「${task?.title || '这个任务'}」？`, message: '事件、审批和执行记录会一起清掉，不能恢复。', okText: '删除', danger: true });
  if (!ok) return;
  try {
    await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
    removeTask(taskId);
    toast('任务已删除。');
  } catch (err) {
    toast(err.message);
  }
}

export function removeTask(taskId) {
  state.tasks = state.tasks.filter((t) => t.id !== taskId);
  detailCache.delete(taskId);
  if (state.drawerTaskId === taskId) closeDrawer();
  if (state.selectedTaskId === taskId) {
    state.selectedTaskId = null;
    ensureSelection();
  }
  changed('tasks');
}

function workspaceOptions(selectedPath = '') {
  const list = state.settings?.workspaces || [];
  const fallback = list.find((ws) => ws.id === state.settings?.defaultWorkspaceId);
  return list.map((ws) => `<option value="${esc(ws.path)}" ${(selectedPath ? ws.path === selectedPath : ws === fallback) ? 'selected' : ''}>${esc(ws.name)} · ${esc(ws.path)}</option>`).join('');
}

function editTask(taskId) {
  const task = taskById(taskId) || detailCache.get(taskId)?.task;
  if (!task) return;
  openDialog({
    title: '编辑任务',
    desc: '保存后按新的内容重新排队；正在执行的任务不能编辑。',
    body: `
      <label class="field"><span>任务名</span><input name="title" value="${esc(task.title)}" /></label>
      <label class="field"><span>指令</span><textarea name="prompt" rows="6">${esc(task.prompt)}</textarea></label>
      <div class="grid-2">
        <label class="field"><span>Worker</span>
          <select name="worker">${workerIds().map((w) => `<option value="${esc(w)}" ${task.worker === w ? 'selected' : ''}>${esc(workerLabel(w))}</option>`).join('')}</select>
        </label>
        <label class="field"><span>优先级（1 最高）</span><input name="priority" type="number" min="1" max="5" value="${task.priority || 2}" /></label>
      </div>`,
    okText: '保存',
    onSubmit: async (values) => {
      if (!values.title.trim() || !values.prompt.trim()) throw new Error('任务名和指令都要填');
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { ...values, priority: Number(values.priority) } });
      if (['failed', 'cancelled', 'queued'].includes(task.status)) {
        await api(`/api/tasks/${task.id}/retry`, { method: 'POST' });
      }
      toast('任务已更新。');
      refreshTaskDetail(task.id);
    }
  });
}

function newTask() {
  const workspaces = state.settings?.workspaces || [];
  openDialog({
    title: '新建任务',
    desc: '直接写给 Worker 的指令。任务会进入队列，按调度器规则执行。',
    body: `
      <label class="field"><span>任务名</span><input name="title" placeholder="例如：整理这周的会议纪要" /></label>
      <label class="field"><span>指令</span><textarea name="prompt" rows="5" placeholder="要它具体做什么？"></textarea></label>
      <div class="grid-2">
        <label class="field"><span>Worker</span>
          <select name="worker"><option value="">自动（兜底 Worker）</option>${workerIds().map((worker) => `<option value="${esc(worker)}">${esc(workerLabel(worker))}</option>`).join('')}</select>
        </label>
        ${workspaces.length ? `<label class="field"><span>工作区</span><select name="cwd">${workspaceOptions()}</select></label>` : ''}
      </div>`,
    okText: '加入队列',
    onSubmit: async ({ title, prompt, worker, cwd }) => {
      if (!title.trim() || !prompt.trim()) throw new Error('任务名和指令都要填');
      const data = await api('/api/tasks', { method: 'POST', body: { title, prompt, worker, ...(cwd ? { cwd } : {}) } });
      upsertTask(data.task);
      changed('tasks');
      toast('任务已进队列。');
      await openTask(data.task.id, { reveal: true });
    }
  });
}

async function saveTaskExec(id) {
  const workspace = $(`[data-task-workspace="${CSS.escape(id)}"]`);
  if (!workspace || !workspace.value || workspace.value === '__custom__') {
    toast('先选择一个工作目录。');
    return;
  }
  const worker = $(`[data-task-worker="${CSS.escape(id)}"]`)?.value;
  try {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { cwd: workspace.value, ...(worker ? { worker } : {}) } });
    toast('Worker 和工作目录已更新。');
    refreshTaskDetail(id);
  } catch (err) {
    toast(err.message);
  }
}

async function learnTask(el) {
  el.disabled = true;
  try {
    const data = await api(`/api/tasks/${el.dataset.id}/learn`, { method: 'POST', timeoutMs: 90000 });
    state.workflows = data;
    changed('workflows');
    toast(data.skipped || `已总结成候选习惯「${data.workflow?.name}」，在对话里确认。`, 3600);
    refreshTaskDetail(el.dataset.id);
  } catch (err) {
    el.disabled = false;
    toast(err.message);
  }
}

// 工作目录选「其他文件夹」：弹原生选择器，选完加进下拉框。
document.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-task-workspace]');
  if (!select || select.value !== '__custom__') return;
  try {
    const picked = await pickFolder();
    await ensureWorkspaceForPath(picked.path);
    if (![...select.options].some((o) => o.value === picked.path)) {
      select.insertAdjacentHTML('afterbegin', `<option value="${esc(picked.path)}">自定义 · ${esc(picked.path)}</option>`);
    }
    select.value = picked.path;
  } catch (err) {
    toast(err.message);
    select.selectedIndex = 0;
  }
});

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  if (action === 'open-task') openTask(id);
  else if (action === 'close-drawer') closeDrawer();
  else if (action === 'approve') approveTask(id, Number(el.dataset.choice));
  else if (action === 'approve-custom') submitApprovalAnswer(id, el.dataset.approvalId, el);
  else if (action === 'reply-source') openReplyDialog(id);
  else if (action === 'cancel-task') { el.disabled = true; await cancelTask(id); }
  else if (action === 'retry-task') { el.disabled = true; await retryTask(id); }
  else if (action === 'edit-task') editTask(id);
  else if (action === 'delete-task') deleteTask(id);
  else if (action === 'save-task-exec') saveTaskExec(id);
  else if (action === 'learn-task') learnTask(el);
  else if (action === 'copy-result') copyText(detailCache.get(id)?.task?.result || taskById(id)?.result || '', '结果已复制。');
});

$('#task-list')?.addEventListener('click', (event) => {
  const row = event.target.closest('[data-select-task]');
  if (!row) return;
  if (isWide()) selectTask(row.dataset.selectTask);
  else openDrawer(row.dataset.selectTask);
});

// 列表里上下键切换任务。
$('#task-list')?.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const rows = $$('#task-list .trow');
  const index = rows.indexOf(document.activeElement);
  const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    event.preventDefault();
    next.focus();
    if (isWide()) selectTask(next.dataset.selectTask);
  }
});

$('#task-filters')?.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-task-filter]');
  if (!chip) return;
  state.taskFilter = chip.dataset.taskFilter;
  renderTaskList();
  if (isWide() && !filteredTasks().some((t) => t.id === state.selectedTaskId)) {
    state.selectedTaskId = null;
    ensureSelection();
  }
});

let searchTimer = null;
$('#task-search')?.addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.taskQuery = event.target.value;
    renderTaskList();
  }, 120);
});

$('#new-task-btn')?.addEventListener('click', newTask);
$('#queue-toggle')?.addEventListener('click', toggleQueue);
$('#status-queue-toggle')?.addEventListener('click', toggleQueue);

on('tasks', () => { if (state.view === 'tasks') renderTaskList(); });
on('approvals', () => { if (state.view === 'tasks') renderTaskList(); });
on('stats', renderQueueInfo);
on('settings', renderQueueInfo);
on('progress', () => {
  patchProgressText();
  if (state.view === 'tasks') {
    for (const row of $$('#task-list .trow')) {
      const task = taskById(row.dataset.selectTask);
      if (task?.status === 'running') {
        const sub = row.querySelector('.trow-sub');
        if (sub) sub.textContent = taskSubtitle(task).slice(0, 140);
      }
    }
  }
});

// 窗口从窄变宽：抽屉里的任务改到右侧面板里看；从宽变窄：右侧面板隐藏，点列表改为滑出。
onWideChange((wide) => {
  if (state.view !== 'tasks') return;
  if (wide && state.drawerTaskId) {
    const id = state.drawerTaskId;
    closeDrawer();
    selectTask(id);
  } else if (wide) {
    ensureSelection();
  }
  renderTaskList();
});

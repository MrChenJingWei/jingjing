// 对话页：消息流、行内任务卡、插件草稿卡、流程卡、输入框。
import {
  $, $$, state, on, changed, esc, md, clock, timeAgo, toast, api,
  workerLabel, workerGlyph, taskById, approvalFor, workflowById,
  ensureWorkspaceForPath, pickFolder, ABILITY_LABEL, WORKFLOW_STATUS_LABEL, ACTIVE_STATUSES
} from './core.js';
import { icon, openDialog, ask } from './ui.js';
import { switchView, setDot } from './shell.js';
import { statusPill, approvalBlock, elapsedHtml, replyButton, keepApprovalFocus } from './tasks.js';
import { openPluginPage } from './plugins.js';

/* ------------------------------ 行内任务卡 ---------------------------- */

function inlineTaskCard(task) {
  if (!task) return '';
  const approval = approvalFor(task);
  const progress = task.status === 'running'
    ? `<div class="tcard-progress"><span class="spinner"></span><span data-progress-text="${esc(task.id)}">${esc(task.progress || '执行中…')}</span>${elapsedHtml(task)}</div>`
    : '';
  const result = task.status === 'done' && task.result
    ? `<div class="tcard-body prose">${md(task.result.split('\n').slice(0, 4).join('\n'))}</div>`
    : task.status === 'failed'
      ? `<div class="tcard-body is-error">${esc((task.error || task.result || '').slice(0, 200))}</div>`
      : '';
  const active = ACTIVE_STATUSES.includes(task.status);
  return `
    <div class="tcard ${approval ? 'is-waiting' : ''}" data-task-id="${esc(task.id)}">
      <div class="tcard-head">
        <span class="glyph">${esc(workerGlyph(task.worker))}</span>
        <div class="tcard-main">
          <div class="tcard-title">${esc(task.title)}</div>
          <div class="tcard-meta">${statusPill(task.status)}<span>${esc(workerLabel(task.worker))}</span><span>·</span><span>${timeAgo(task.created_at)}</span></div>
        </div>
        <button type="button" class="icon-btn" data-action="open-task" data-id="${esc(task.id)}" title="查看详情">${icon('chevronRight')}</button>
      </div>
      ${progress}
      ${result}
      ${approval ? approvalBlock(task, approval) : ''}
      ${active || replyButton(task) ? `
        <div class="tcard-actions">
          <button type="button" class="btn xs" data-action="open-task" data-id="${esc(task.id)}">查看详情</button>
          ${replyButton(task, 'xs')}
          ${active ? `<button type="button" class="btn xs danger" data-action="cancel-task" data-id="${esc(task.id)}">停止</button>` : ''}
        </div>` : ''}
    </div>`;
}

/* ------------------------- 插件工坊：静静写的插件 ------------------------- */

const DRAFT_STATUS = { writing: '正在写', checking: '正在检查', ready: '检查通过，待你确认', failed: '没通过检查', installed: '已安装', discarded: '已放弃' };
const CAPABILITY_LABEL = { network: '联网', read: '读文件', write: '写文件' };

function pluginDraftCard(msg) {
  const d = (state.pluginDrafts || []).find((item) => item.id === msg.meta?.draftId);
  if (!d) return '';
  const report = d.report || {};
  const info = report.info || {};
  const caps = Object.entries(info.capabilities || {}).filter(([, enabled]) => enabled).map(([key]) => CAPABILITY_LABEL[key] || key);
  const facts = [
    info.description,
    info.files?.length ? `${info.files.length} 个文件：${info.files.map((f) => f.name).join('、')}` : '',
    info.kind === 'source' ? `需要的权限：${caps.length ? caps.join('、') : '无'}` : '',
    info.abilities?.length ? `能力：${info.abilities.map((a) => ABILITY_LABEL[a] || a).join('、')}` : '',
    info.config?.length ? `需要你填的配置：${info.config.map((f) => f.label + (f.required ? '（必填）' : '')).join('、')}` : '',
    info.testSkipped || ''
  ].filter(Boolean);
  // 编码任务中途断了：没通过时算错误；文件已通过检查时只是提醒可能没写完整。
  const interrupted = report.interrupted
    ? `<li class="${d.status === 'failed' ? 'is-error' : 'is-warn'}">编码任务中途断了：${esc(report.interrupted.split('\n').filter(Boolean).join(' '))}${d.status === 'ready' ? '（文件已通过检查，但可能没写完整）' : ''}</li>`
    : '';
  const errors = interrupted + (report.errors || []).map((e) => `<li class="is-error">${esc(e)}</li>`).join('');
  const warnings = (report.warnings || []).map((w) => `<li class="is-warn">${esc(w)}</li>`).join('');
  const busyNow = d.status === 'writing' || d.status === 'checking';
  const id = esc(d.id);
  const actions = {
    ready: `<button type="button" class="btn xs primary" data-action="draft-install" data-id="${id}">安装</button>
            <button type="button" class="btn xs" data-action="draft-files" data-id="${id}">查看代码</button>
            <button type="button" class="btn xs" data-action="draft-discard" data-id="${id}">放弃</button>`,
    failed: `<button type="button" class="btn xs" data-action="draft-retry" data-id="${id}">再试一次</button>
             <button type="button" class="btn xs" data-action="draft-recheck" data-id="${id}" title="文件其实已经写好、或者你手动改过时用：只检查不重写，通过后照样要你确认安装">重新检查</button>
             <button type="button" class="btn xs" data-action="draft-files" data-id="${id}">查看代码</button>
             <button type="button" class="btn xs" data-action="draft-discard" data-id="${id}">放弃</button>`,
    installed: `<button type="button" class="btn xs" data-action="draft-open-plugin" data-id="${id}">去配置</button>
                <button type="button" class="btn xs" data-action="draft-files" data-id="${id}">查看代码</button>`,
    writing: `${d.taskId ? `<button type="button" class="btn xs" data-action="open-task" data-id="${esc(d.taskId)}">看进度</button>` : ''}
              <button type="button" class="btn xs" data-action="draft-discard" data-id="${id}">放弃</button>`,
    checking: ''
  }[d.status] || '';
  return `
    <div class="tcard" data-draft-id="${id}">
      <div class="tcard-head">
        <span class="glyph">${d.kind === 'worker' ? '工' : '插'}</span>
        <div class="tcard-main">
          <div class="tcard-title">${esc(d.name || info.name || d.request.slice(0, 40))}</div>
          <div class="tcard-meta">
            ${busyNow ? '<span class="spinner"></span>' : ''}
            <span>${esc(d.kindLabel)}</span><span>·</span>
            <span>${esc(DRAFT_STATUS[d.status] || d.status)}${busyNow && d.rounds > 1 ? `（第 ${d.rounds}/${d.maxRounds} 轮）` : ''}</span>
            ${info.id ? `<span>·</span><span>${esc(info.id)} v${esc(info.version || '')}</span>` : ''}
          </div>
        </div>
      </div>
      ${facts.length ? `<div class="tcard-body">${facts.map((f) => `<div>${esc(f)}</div>`).join('')}</div>` : ''}
      ${errors || warnings ? `<ul class="draft-checks">${errors}${warnings}</ul>` : ''}
      ${d.status === 'ready' ? '<div class="tcard-body"><div class="approval-note">插件会以你的账户权限在静静里运行，安装前建议先看一眼代码。</div></div>' : ''}
      ${actions.trim() ? `<div class="tcard-actions">${actions}</div>` : ''}
    </div>`;
}

async function handleDraftAction(action, el) {
  const id = el.dataset.id;
  const draft = (state.pluginDrafts || []).find((item) => item.id === id);
  const setDrafts = (data) => {
    state.pluginDrafts = data.drafts || state.pluginDrafts;
    changed('drafts');
  };
  try {
    if (action === 'draft-files') {
      const { files } = await api(`/api/plugin-drafts/${id}/files`);
      openDialog({
        title: `代码：${draft?.name || id}`,
        desc: '只读预览。插件会以你的账户权限运行，看到可疑的地方就别装。',
        body: files.map((f) => `<div class="draft-file"><b>${esc(f.name)}</b><small>${f.size} 字节</small><pre>${esc(f.content)}</pre></div>`).join('') || '<p>没有文件。</p>',
        wide: true,
        readonly: true
      });
      return;
    }
    if (action === 'draft-install') {
      const ok = await ask({ title: `安装「${draft?.name || id}」？`, message: '它会以你的账户权限在静静里运行。', okText: '安装' });
      if (!ok) return;
      el.disabled = true;
      const data = await api(`/api/plugin-drafts/${id}/install`, { method: 'POST', timeoutMs: 30000 });
      if (data.plugins) state.plugins = data.plugins;
      if (data.workers) state.workers = data.workers;
      setDrafts(data);
      changed('plugins', 'workers');
      toast(data.kind === 'worker' ? '已安装，在设置 → Worker 里可以看到它。' : '已安装，默认停用：去设置 → 任务来源里填好配置再启用。', 4200);
      return;
    }
    if (action === 'draft-discard') {
      const ok = await ask({ title: '放弃这个插件草稿？', message: '草稿文件会删除，还在写的任务会停掉。', okText: '放弃', danger: true });
      if (!ok) return;
      setDrafts(await api(`/api/plugin-drafts/${id}/discard`, { method: 'POST' }));
      return;
    }
    if (action === 'draft-retry') {
      setDrafts(await api(`/api/plugin-drafts/${id}/retry`, { method: 'POST' }));
      toast('好，再让它改一轮。');
      return;
    }
    if (action === 'draft-recheck') {
      el.disabled = true;
      const data = await api(`/api/plugin-drafts/${id}/recheck`, { method: 'POST', timeoutMs: 30000 });
      setDrafts(data);
      toast(data.draft?.status === 'ready' ? '检查通过了，看一眼代码就可以安装。' : '还是没通过，卡片上有最新的检查结果。', 3600);
      return;
    }
    if (action === 'draft-open-plugin') {
      if (draft?.kind === 'worker') { await switchView('settings', { sub: 'worker' }); return; }
      await switchView('settings', { sub: 'plugins' });
      if (draft?.pluginId && (state.plugins || []).some((p) => p.id === draft.pluginId)) openPluginPage(draft.pluginId);
    }
  } catch (err) {
    el.disabled = false;
    toast(err.message);
  }
}

// 设置里「让静静写一个」
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-forge]');
  if (!button) return;
  const kind = button.dataset.forge;
  openDialog({
    title: '让静静写一个插件',
    desc: '说清楚要从哪里拿数据 / 让它干什么。静静会交给能写代码的 Worker 去写，自动检查通过后再请你确认安装。',
    body: `
      <label class="field"><span>类型</span><select name="kind">
        <option value="source" ${kind === 'source' ? 'selected' : ''}>任务来源插件：接收 / 拉取外部消息、事件</option>
        <option value="worker" ${kind === 'worker' ? 'selected' : ''}>Worker 插件：执行任务</option>
      </select></label>
      <label class="field"><span>需求</span><textarea name="request" rows="5" required placeholder="${kind === 'worker' ? '例如：调用本机的 aider 命令行，在任务工作区里改代码' : '例如：每 30 分钟拉一次某个 RSS 地址，新文章交给静静判断'}"></textarea></label>`,
    okText: '开始写',
    onSubmit: async (values) => {
      const data = await api('/api/plugin-drafts', { method: 'POST', body: { kind: values.kind, request: values.request } });
      state.pluginDrafts = data.drafts || state.pluginDrafts;
      toast('开始写了，进度在对话里。', 3200);
      await switchView('chat');
    }
  });
});

/* ------------------------------- 流程卡 ------------------------------- */

function workflowCard(msg) {
  const w = workflowById(msg.meta?.workflowId);
  if (!w) return '<div class="tcard"><div class="tcard-head"><span class="glyph">流</span><div class="tcard-main"><div class="tcard-meta">这个流程文件已经被移走或删除了。</div></div></div></div>';
  const steps = (w.steps || '').split('\n').filter((line) => line.trim()).slice(0, 6).join('\n');
  const id = esc(w.id);
  const actions = w.status === 'candidate'
    ? `<button type="button" class="btn xs primary" data-action="workflow-status" data-id="${id}" data-status="active">保存为习惯</button>
       <button type="button" class="btn xs" data-action="workflow-open" data-id="${id}">先改一改</button>
       <button type="button" class="btn xs" data-action="workflow-status" data-id="${id}" data-status="dismissed">忽略</button>`
    : `<span class="tag">${esc(WORKFLOW_STATUS_LABEL[w.status] || w.status)}</span>
       <button type="button" class="btn xs" data-action="workflow-open" data-id="${id}">查看</button>`;
  return `
    <div class="tcard" data-workflow-id="${id}">
      <div class="tcard-head">
        <span class="glyph">流</span>
        <div class="tcard-main">
          <div class="tcard-title">${esc(w.name)}</div>
          <div class="tcard-meta">
            <span>${esc(w.when ? `触发：${w.when}` : '按名称匹配')}</span>
            ${w.worker ? `<span>·</span><span>${esc(workerLabel(w.worker))}</span>` : ''}
          </div>
        </div>
      </div>
      ${steps ? `<div class="tcard-body prose">${md(steps)}</div>` : ''}
      <div class="tcard-actions">${actions}</div>
    </div>`;
}

/* --------------------------- 人设调整的提议 ---------------------------- */

function personaProposalCard(msg) {
  const meta = msg.meta || {};
  const pending = state.mind?.proposal?.id && state.mind.proposal.id === meta.proposalId;
  const current = state.settings?.persona || '';
  const status = pending ? '' : current === meta.text ? '已采用' : '已处理';
  return `
    <div class="tcard ${pending ? 'is-waiting' : ''}">
      <div class="tcard-head">
        <span class="glyph">人</span>
        <div class="tcard-main">
          <div class="tcard-title">想调整一下自己的性格</div>
          <div class="tcard-meta"><span>${pending ? '等你点头' : esc(status)}</span></div>
        </div>
      </div>
      <div class="tcard-body persona-diff">
        <div><span class="tag">现在</span>${esc(meta.old || '')}</div>
        <div><span class="tag">想改成</span>${esc(meta.text || '')}</div>
      </div>
      ${pending ? `
        <div class="tcard-actions">
          <button type="button" class="btn xs primary" data-action="persona-accept">好，就这样</button>
          <button type="button" class="btn xs" data-action="persona-decline">不用改</button>
        </div>` : ''}
    </div>`;
}

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action="persona-accept"], [data-action="persona-decline"]');
  if (!el) return;
  el.disabled = true;
  try {
    const data = await api('/api/persona/proposal', { method: 'POST', body: { accept: el.dataset.action === 'persona-accept' } });
    state.settings = data.settings;
    state.mind = data.mind;
    changed('settings', 'mind');
    renderChat();
    toast(data.accepted ? '好，她的人设已经更新。' : '好，她不改了。');
  } catch (err) {
    el.disabled = false;
    toast(err.message);
  }
});

/* ------------------------------- 消息 -------------------------------- */

function messageHtml(msg, index, list) {
  const isUser = msg.role === 'user';
  const task = msg.task_id ? taskById(msg.task_id) : null;
  const prev = list[index - 1];
  // 同一方几分钟内连着说的合成一组；卡片、她主动的通知各自单独成条。
  const grouped = prev && prev.role === msg.role && !prev.task_id && msg.kind === 'text' && prev.kind === 'text'
    && new Date(msg.created_at) - new Date(prev.created_at) < 5 * 60 * 1000;
  const text = String(msg.text || '');
  const body = isUser ? `<p>${esc(text).replace(/\n/g, '<br>')}</p>` : md(text);
  return `
    <div class="msg ${isUser ? 'is-user' : 'is-assistant'} ${grouped ? 'is-grouped' : ''} ${msg.pending ? 'is-pending' : ''}" data-msg="${esc(msg.id)}">
      ${isUser ? '' : '<div class="msg-avatar" aria-hidden="true">静</div>'}
      <div class="msg-body" title="${esc(clock(msg.created_at))}">
        ${!isUser && !grouped ? `<div class="msg-head"><b>静静</b><time>${clock(msg.created_at)}</time></div>` : ''}
        ${text ? `<div class="msg-text ${isUser ? '' : 'prose'}">${body}</div>` : ''}
        ${task ? inlineTaskCard(task) : ''}
        ${msg.kind === 'workflow' ? workflowCard(msg) : ''}
        ${msg.kind === 'plugin-draft' ? pluginDraftCard(msg) : ''}
        ${msg.kind === 'persona' ? personaProposalCard(msg) : ''}
      </div>
    </div>`;
}

const CHAT_WORKSPACE_KEY = 'jingjing.chatWorkspace';

function storedWorkspace() {
  try { return localStorage.getItem(CHAT_WORKSPACE_KEY); } catch { return null; }
}
function storeWorkspace(id) {
  try { localStorage.setItem(CHAT_WORKSPACE_KEY, id); } catch { /* ignore */ }
}

/** 输入框里的「工作区」选择：列设置里的工作区，记住上次选的；也可以临时挑一个自定义文件夹。 */
function renderChatWorkspace() {
  const scope = $('#composer-scope');
  const select = $('#chat-workspace');
  if (!scope || !select) return;
  const list = state.settings?.workspaces || [];
  scope.hidden = list.length === 0;
  if (!list.length) return;
  const savedId = select.value && select.value !== '__custom__' ? select.value : storedWorkspace();
  const current = list.find((ws) => ws.id === savedId)
    || list.find((ws) => ws.id === state.settings?.defaultWorkspaceId)
    || list[0];
  select.innerHTML = list.map((ws) => `<option value="${esc(ws.id)}">${esc(ws.name)}</option>`).join('')
    + '<option value="__custom__">选择其他文件夹…</option>';
  select.value = current.id;
  scope.title = `这条消息建的任务放在「${current.name}」：${current.path}`;
}

async function pickChatWorkspace() {
  const select = $('#chat-workspace');
  try {
    const picked = await pickFolder();
    const workspace = await ensureWorkspaceForPath(picked.path);
    renderChatWorkspace();
    select.value = workspace.id;
    storeWorkspace(workspace.id);
    toast(`这条消息会建在「${workspace.name}」。`);
  } catch (err) {
    toast(err.message);
    renderChatWorkspace();
  }
}

function renderPresence() {
  const pending = state.approvals.length;
  const running = state.tasks.filter((t) => ['running', 'queued'].includes(t.status)).length;
  $('#presence-title').textContent = pending
    ? `有 ${pending} 件事在等你拍板。`
    : running ? `我正盯着 ${running} 件事。` : '我在。';
  $('#presence-sub').textContent = pending
    ? '可以直接在下面的卡片里选，也可以去任务页细看。'
    : '任务、记忆和 Agent 都留在本机。需要拍板时我会停下来等你。';
  const attention = $('#attention');
  if (attention) {
    attention.hidden = pending === 0;
    attention.innerHTML = `${icon('alert')}<span>有 ${pending} 件事在等你拍板</span>${icon('chevronRight')}`;
  }
}

export function renderChat({ forceBottom = false } = {}) {
  if (state.view !== 'chat') return;
  renderChatWorkspace();
  renderPresence();
  const scroller = $('#chat-scroll');
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  keepApprovalFocus(() => {
    $('#messages').innerHTML = state.messages.map(messageHtml).join('');
  });
  if (forceBottom || nearBottom) {
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }
}

/** 进度回传很频繁：只改那一行文字，不整页重画。 */
function patchProgress(taskId) {
  const task = taskById(taskId);
  if (!task) return;
  $$(`[data-progress-text="${CSS.escape(taskId)}"]`).forEach((el) => { el.textContent = task.progress || '执行中…'; });
}

on('messages', () => renderChat());
on('tasks', () => renderChat());
on('approvals', () => renderChat());
on('drafts', () => renderChat());
on('workflows', () => renderChat());
on('settings', () => { if (state.view === 'chat') renderChatWorkspace(); });
on('mind', () => { if (state.messages.some((m) => m.kind === 'persona')) renderChat(); });
on('progress', () => {
  if (state.view !== 'chat') return;
  for (const el of $$('#messages [data-progress-text]')) patchProgress(el.dataset.progressText);
});

/** 新消息到了但人不在对话页：标个小点。 */
export function noteIncoming(message) {
  if (message?.role === 'assistant' && state.view !== 'chat') setDot('chat', true);
}

/* ------------------------------- 发送 -------------------------------- */

async function sendMessage(text) {
  const input = $('#input');
  const value = String(text ?? input.value).trim();
  if (!value || state.busy) return;
  state.busy = true;
  $('#send-btn').disabled = true;
  $('#typing').hidden = false;
  input.value = '';
  autoGrow();

  const temp = { id: `tmp_${Date.now()}`, role: 'user', text: value, kind: 'text', created_at: new Date().toISOString(), pending: true };
  state.messages.push(temp);
  renderChat({ forceBottom: true });

  try {
    const workspaceId = $('#chat-workspace')?.value;
    const data = await api('/api/chat', {
      method: 'POST',
      body: {
        text: value,
        sessionId: state.sessionId,
        ...(workspaceId && workspaceId !== '__custom__' ? { workspaceId } : {})
      },
      timeoutMs: 60000
    });
    state.messages = state.messages.filter((m) => m.id !== temp.id);
    for (const message of [data.userMessage, data.reply]) {
      if (message && !state.messages.some((item) => item.id === message.id)) state.messages.push(message);
    }
    if (data.stats) state.stats = data.stats;
    renderChat({ forceBottom: true });
  } catch (err) {
    state.messages = state.messages.filter((m) => m.id !== temp.id);
    renderChat({ forceBottom: true });
    toast(err.message);
    if (!input.value) {
      input.value = value;
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
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

$('#composer')?.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});
$('#chat-workspace')?.addEventListener('change', (event) => {
  const select = event.target;
  if (select.value === '__custom__') {
    pickChatWorkspace();
    return;
  }
  storeWorkspace(select.value);
  const workspace = (state.settings?.workspaces || []).find((item) => item.id === select.value);
  if (workspace) $('#composer-scope').title = `这条消息建的任务放在「${workspace.name}」：${workspace.path}`;
});
$('#input')?.addEventListener('input', autoGrow);
$('#input')?.addEventListener('keydown', (event) => {
  // 输入法选词时的回车不算发送。
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    sendMessage();
  }
});
$$('#quick-chips .chip').forEach((chip) => chip.addEventListener('click', () => sendMessage(chip.dataset.say)));

/** 手机上顶部的「有 N 件事等你拍板」：滚到第一张待拍板的卡片，没有就去任务页。 */
$('#attention')?.addEventListener('click', () => {
  const card = $('#messages .tcard.is-waiting');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('is-flash');
    setTimeout(() => card.classList.remove('is-flash'), 1400);
  } else {
    state.taskFilter = 'waiting_approval';
    switchView('tasks');
  }
});

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action^="draft-"]');
  if (el) await handleDraftAction(el.dataset.action, el);
});

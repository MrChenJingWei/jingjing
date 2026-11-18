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

export const OUTCOME_LABEL = {
  completed: '已完成',
  proposed: '待确认方案',
  delivered: '已回复',
  partial: '部分完成',
  blocked: '等你决定'
};
const OUTCOME_OPTIONS = [
  ['', '本轮结束（未确认完成）'],
  ['completed', '已完成'],
  ['proposed', '待确认方案'],
  ['delivered', '已回复'],
  ['partial', '部分完成'],
  ['blocked', '等你决定']
];

/** done 只表示这轮跑完了；到底算不算完成，看 outcome。 */
export function statusPill(status, outcome = null) {
  const label = status === 'done' ? (OUTCOME_LABEL[outcome] || '本轮结束') : (STATUS_LABEL[status] || status);
  const attr = outcome ? ` data-o="${esc(outcome)}"` : '';
  return `<span class="pill" data-s="${esc(status)}"${attr}>${esc(label)}</span>`;
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

/* ---------------------------- 拍板 / 接着做 ---------------------------- */

// 卡片里没提交的文字（拍板的回答、接着做的话）：对话和详情会整块重绘，靠它把内容和光标还原回去。
// key：a:<审批 id> 是拍板的回答，f:<任务 id> 是接着做的话。
const drafts = new Map();
// 对话里收起着的「接着说」框，点开过的记在这里。
const openedFollowups = new Set();
// 详情里展开过「往来记录」的任务：重绘时保持展开。
const openedRounds = new Set();
const DAY_MS = 24 * 60 * 60 * 1000;

export function approvalBlock(task, approval) {
  const hostQuestion = approval.kind === 'routing' || approval.kind === 'recovery';
  return `
    <div class="approval">
      <div class="approval-q">${icon('alert')}<span>${esc(approval.question)}</span></div>
      <div class="approval-opts">
        ${(approval.options || []).map((opt, i) => `
          <button type="button" class="btn sm ${i === 0 ? 'primary' : ''}" data-action="approve" data-id="${esc(task.id)}" data-choice="${i}">${esc(opt)}</button>`).join('')}
      </div>
      ${approval.custom ? `
        <div class="approval-custom">
          <input type="text" maxlength="500" data-draft="a:${esc(approval.id)}" data-approval-input="${esc(approval.id)}" data-task-id="${esc(task.id)}"
            value="${esc(drafts.get(`a:${approval.id}`) || '')}" placeholder="都不合适？直接写你的决定，比如：先问问产品再说" autocomplete="off" />
          <button type="button" class="btn sm" data-action="approve-custom" data-id="${esc(task.id)}" data-approval-id="${esc(approval.id)}">按这个办</button>
        </div>
        <p class="approval-note">选一个，或者自己写决定；它会从停下的地方接着原来的上下文继续。</p>`
      : `<p class="approval-note">${hostQuestion ? '这是静静替你问的，只能从上面的选项里选。' : '这一步只能从上面的选项里选；选完从停下的地方继续。'}</p>`}
    </div>`;
}

/** 结果最后一句是在问人：提示主人可以直接回答。 */
export function endsWithQuestion(text) {
  const last = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).pop() || '';
  return /[?？]\s*[)）*_`]*$|吗[。.]?$/.test(last);
}

const FOLLOWUP_PLACEHOLDER = {
  done: '接着说：比如「再把测试补上」「第二点展开讲讲」',
  failed: '说说要怎么改，接着做；或者另起一张换个做法',
  cancelled: '停在半路了：说一句接着做，或者另起一张'
};

/**
 * 每张卡底部的同一个位置：现在能对它做什么。
 * 等拍板 → 回答问题；已结束 → 接着做 / 另起一张；排队、执行中 → 说明为什么现在不能说话。
 * compact：对话里的卡片，「接着说」默认收起，点开才出输入框。
 */
export function replyBox(task, approval, { compact = false } = {}) {
  if (!task) return '';
  const id = esc(task.id);
  if (task.status === 'waiting_approval') return approval ? approvalBlock(task, approval) : '';
  if (task.status === 'queued') {
    return compact ? '' : '<p class="reply-note">排队中，还没开始。要改指令点上面的「编辑」。</p>';
  }
  if (task.status === 'running') {
    return compact ? '' : '<p class="reply-note">正在做，现在不能插话；可以等它做完或停下后在这里接着说。</p>';
  }
  if (!FOLLOWUP_PLACEHOLDER[task.status]) return '';
  const key = `f:${task.id}`;
  const asked = task.status === 'done' && endsWithQuestion(task.result);
  // 对话里很早以前的问句就不再自动展开，免得翻历史时满屏输入框。
  const fresh = !task.finished_at || Date.now() - new Date(task.finished_at).getTime() < DAY_MS;
  if (compact && !openedFollowups.has(task.id) && !drafts.get(key) && !(asked && fresh)) {
    return `
      <div class="followup is-folded">
        <button type="button" class="btn xs ghost" data-action="followup-open" data-id="${id}">${icon('reply', 'sm')}接着说…</button>
      </div>`;
  }
  return `
    <div class="followup ${asked ? 'is-asked' : ''}">
      ${asked ? `<div class="followup-ask">${icon('alert', 'sm')}<span>它最后在问你，直接在这里回答就能接着做。</span></div>` : ''}
      <textarea rows="${compact ? 1 : 2}" maxlength="4000" data-draft="${esc(key)}" data-followup-input="${id}"
        placeholder="${esc(compact ? (asked ? '直接回答它，或者接着说…' : '接着说点什么…') : FOLLOWUP_PLACEHOLDER[task.status])}">${esc(drafts.get(key) || '')}</textarea>
      <div class="followup-actions">
        <button type="button" class="btn xs primary" data-action="followup-same" data-id="${id}" title="同一张卡，接着上次的上下文（能续会话的 Worker 会续上会话）">接着做</button>
        <button type="button" class="btn xs" data-action="followup-new" data-id="${id}" title="新开一张卡，带上这张的指令和结果，两张卡互相连着">另起一张</button>
        <span class="followup-hint">回车接着做 · Shift+回车换行</span>
      </div>
    </div>`;
}

/** 重绘一块区域时，保住卡片里输入框的焦点和光标位置。 */
export function keepApprovalFocus(render) {
  const active = document.activeElement;
  const key = active?.dataset?.draft;
  const selection = key ? [active.selectionStart, active.selectionEnd] : null;
  // 同一张卡在页面上可能出现在不同区域（对话 + 抽屉），按所在区域找回同一个框。
  const scope = key ? active.closest('#drawer, #task-pane, #messages') : null;
  render();
  if (!key) return;
  const pool = scope?.isConnected ? $$('[data-draft]', scope) : $$('[data-draft]');
  const input = pool.find((el) => el.dataset.draft === key);
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
  const answer = (drafts.get(`a:${approvalId}`) || '').trim();
  if (!answer) {
    toast('先写下你的决定，或者直接点上面的选项。');
    $(`[data-approval-input="${CSS.escape(approvalId)}"]`)?.focus();
    return;
  }
  el.disabled = true;
  if (await approveTask(taskId, null, answer)) drafts.delete(`a:${approvalId}`);
  el.disabled = false;
}

/** 接着做（mode = same）或另起一张（mode = new）。 */
async function submitFollowup(taskId, mode, el) {
  const key = `f:${taskId}`;
  const text = (drafts.get(key) || '').trim();
  if (!text) {
    toast(mode === 'new' ? '先写下新的一张要做什么。' : '先写下要接着做什么。');
    $(`[data-followup-input="${CSS.escape(taskId)}"]`)?.focus();
    return;
  }
  if (el) el.disabled = true;
  try {
    const data = await api(`/api/tasks/${taskId}/continue`, { method: 'POST', body: { text, mode } });
    drafts.delete(key);
    openedFollowups.delete(taskId);
    upsertTask(data.task);
    if (data.parent) upsertTask(data.parent);
    if (data.stats) state.stats = data.stats;
    changed('tasks', 'stats');
    if (mode === 'new') {
      toast(`另起了一张「${data.task.title}」，和原来那张连着。`, 3200);
      if (state.view === 'tasks' || state.drawerTaskId === taskId) openTask(data.task.id);
    } else {
      toast('好，接着做。');
      refreshTaskDetail(taskId);
    }
  } catch (err) {
    toast(err.message, 4000);
    import('./sync.js').then((m) => m.resync()).catch(() => {});
  } finally {
    if (el?.isConnected) el.disabled = false;
  }
}

document.addEventListener('input', (event) => {
  const key = event.target.dataset?.draft;
  if (key) drafts.set(key, event.target.value);
  if (event.target.matches?.('textarea[data-followup-input]')) growFollowup(event.target);
});

function growFollowup(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
}

document.addEventListener('toggle', (event) => {
  const id = event.target.dataset?.rounds;
  if (!id) return;
  if (event.target.open) openedRounds.add(id);
  else openedRounds.delete(id);
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  const input = event.target.closest?.('[data-approval-input]');
  if (input) {
    event.preventDefault();
    submitApprovalAnswer(input.dataset.taskId, input.dataset.approvalInput, input);
    return;
  }
  const followup = event.target.closest?.('[data-followup-input]');
  if (followup && !event.shiftKey) {
    event.preventDefault();
    submitFollowup(followup.dataset.followupInput, 'same', null);
  }
});

/* ------------------------------ 来源状态 ------------------------------ */

const SYNC_TEXT = {
  ok: '已同步',
  stale: '有一阵没同步了',
  error: '上次同步失败',
  paused: '已停止跟踪',
  passive: '随拉取更新'
};

function sourceStatusText(link) {
  if (link.providerState === 'removed') return '来源已删除';
  if (link.providerState === 'disabled') return '来源已停用';
  return link.status?.label || (link.externalId ? `#${link.externalId}` : '未知状态');
}

/** 列表和对话卡片上的来源标签：只显示主绑定（第一条），还有别的就标个数。 */
export function sourceTag(task) {
  const links = task?.sources || [];
  if (!links.length) return '';
  const link = links[0];
  const off = link.providerState !== 'enabled' || !link.tracking;
  const warn = link.syncState === 'error';
  const title = [link.title, link.syncError ? `同步失败：${link.syncError}` : ''].filter(Boolean).join('\n');
  return `<span class="src-tag ${off ? 'is-off' : ''}" data-c="${esc(off ? 'off' : link.status?.category || 'unknown')}" title="${esc(title)}">${warn ? icon('alert', 'sm') : ''}${esc(link.providerLabel)} · ${esc(sourceStatusText(link))}${links.length > 1 ? `<em>+${links.length - 1}</em>` : ''}</span>`;
}

/** 外部状态和本地任务对不上时的提示：只提示，不自动改任何一边。 */
function mismatchHint(task, link) {
  const category = link.status?.category;
  if (!category || !link.tracking) return '';
  const active = ACTIVE_STATUSES.includes(task.status);
  if (active && ['done', 'cancelled'].includes(category)) {
    return `${link.providerLabel} 那边已经${category === 'done' ? '完成' : '关闭'}了，这张卡还在${task.status === 'waiting_approval' ? '等你拍板' : '进行'}。不需要了可以点上面的「停止」。`;
  }
  if (task.status === 'done' && ['open', 'in_progress', 'blocked'].includes(category)) {
    return `这张卡做完了，${link.providerLabel} 那边还是「${link.status.label}」。记得去原单更新状态。`;
  }
  return '';
}

function sourcesSection(task) {
  const links = task.sources || [];
  if (!links.length) return '';
  const id = esc(task.id);
  return `
    <section class="dsec">
      <div class="dsec-head"><h4>来源</h4></div>
      <div class="src-list">
        ${links.map((link) => {
          const hint = mismatchHint(task, link);
          const lid = esc(link.id);
          const synced = link.syncedAt ? `同步于 ${timeAgo(link.syncedAt)}` : '还没同步过';
          const updated = link.status?.updatedAt ? ` · ${esc(link.providerLabel)} 更新于 ${timeAgo(link.status.updatedAt)}` : '';
          return `
            <div class="src-item">
              <div class="src-head">
                <b>${esc(link.providerLabel)}</b>
                <span class="src-ref">${esc([link.externalType, link.externalId ? `#${link.externalId}` : ''].filter(Boolean).join(' '))}</span>
                <span class="grow"></span>
                ${link.url ? `<a class="btn xs ghost" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${icon('external', 'sm')}打开原单</a>` : ''}
              </div>
              ${link.title ? `<div class="src-title">${esc(link.title)}</div>` : ''}
              <div class="src-state">
                <span class="src-tag ${link.tracking && link.providerState === 'enabled' ? '' : 'is-off'}" data-c="${esc(link.status?.category || 'unknown')}">${esc(sourceStatusText(link))}</span>
                ${link.status?.detail ? `<span class="src-detail">${esc(link.status.detail)}</span>` : ''}
              </div>
              <div class="src-sync ${link.syncState === 'error' ? 'is-error' : ''}">
                ${esc(SYNC_TEXT[link.syncState] || '')} · ${esc(synced)}${updated}
                ${link.syncError ? `<div>${icon('alert', 'sm')}${esc(link.syncError)}</div>` : ''}
              </div>
              ${hint ? `<div class="src-hint">${icon('alert', 'sm')}<span>${esc(hint)}</span></div>` : ''}
              <div class="src-actions">
                ${link.canRefresh ? `<button type="button" class="btn xs" data-action="source-refresh" data-id="${id}" data-link="${lid}">${icon('refresh', 'sm')}刷新状态</button>` : ''}
                ${link.providerState === 'enabled' ? `<button type="button" class="btn xs" data-action="source-track" data-id="${id}" data-link="${lid}" data-on="${link.tracking ? '0' : '1'}">${link.tracking ? `${icon('pause', 'sm')}停止跟踪` : `${icon('play', 'sm')}恢复跟踪`}</button>` : ''}
                <button type="button" class="btn xs ghost" data-action="source-unlink" data-id="${id}" data-link="${lid}">解除绑定</button>
              </div>
            </div>`;
        }).join('')}
      </div>
    </section>`;
}

async function sourceAction(action, el) {
  const { id, link } = el.dataset;
  if (action === 'source-unlink') {
    const ok = await ask({ title: '解除这个来源绑定？', message: '卡片上不再显示它的外部状态，也不再同步。任务本身和原单都不受影响。', okText: '解除' });
    if (!ok) return;
  }
  el.disabled = true;
  try {
    const path = `/api/tasks/${id}/sources/${link}`;
    const data = action === 'source-refresh'
      ? await api(`${path}/refresh`, { method: 'POST', timeoutMs: 40000 })
      : action === 'source-track'
        ? await api(path, { method: 'PATCH', body: { tracking: el.dataset.on === '1' } })
        : await api(path, { method: 'DELETE' });
    if (data.task) upsertTask(data.task);
    changed('tasks');
    refreshTaskDetail(id);
    toast({ 'source-refresh': '状态已刷新。', 'source-track': el.dataset.on === '1' ? '恢复跟踪了。' : '不再跟踪它的状态。', 'source-unlink': '已解除绑定。' }[action]);
  } catch (err) {
    toast(err.message, 4000);
    refreshTaskDetail(id);
  } finally {
    if (el.isConnected) el.disabled = false;
  }
}

/* ------------------------------ 卡片流转 ------------------------------ */

/** 卡片标题下的一行：这张是接着哪张做的。 */
export function parentLink(task, size = 'xs') {
  if (!task?.parent_id) return '';
  const parent = taskById(task.parent_id);
  return `<button type="button" class="link-chip ${size}" data-action="open-task" data-id="${esc(task.parent_id)}" title="打开上一张">${icon('chevronLeft', 'sm')}接着「${esc(parent?.title || '上一张')}」</button>`;
}

function linksSection(task, links) {
  const parent = links?.parent;
  const children = links?.children || [];
  if (!parent && !children.length) return '';
  const row = (item, dir) => item.status === 'deleted'
    ? `<div class="link-row is-gone"><span class="link-dir">${dir}</span><span>上一张已经删除了</span></div>`
    : `<button type="button" class="link-row" data-action="open-task" data-id="${esc(item.id)}">
        <span class="link-dir">${dir}</span><b>${esc(item.title || '（无标题）')}</b>${statusPill(item.status)}${icon('chevronRight', 'sm')}
      </button>`;
  return `
    <section class="dsec">
      <div class="dsec-head"><h4>前后的卡</h4></div>
      <div class="link-list">
        ${parent ? row(parent, '上一张') : ''}
        ${children.map((child) => row(child, '后续')).join('')}
      </div>
    </section>`;
}

/** 同一张卡接着做过几轮：按时间排出「指令 / 结果 / 你接着说」。 */
function roundsSection(task, events = []) {
  if (!events.some((e) => e.type === 'task/followup')) return '';
  const items = [{ who: '指令', text: task.prompt, round: 1 }];
  let round = 1;
  for (const e of events) {
    if (e.type === 'task/followup') {
      round = e.data?.round || round + 1;
      items.push({ who: '你接着说', text: e.data?.text || '', round, ask: true });
    } else if (['task/done', 'task/failed', 'task/cancelled'].includes(e.type)) {
      const text = e.data?.summary || e.data?.error || e.data?.reason || '';
      items.push({ who: e.type === 'task/done' ? '结果' : e.type === 'task/failed' ? '出错' : '停下', text, round, error: e.type !== 'task/done' });
    }
  }
  // 最新一轮的结果就是上面的「结果」，这里不重复整段。
  return `
    <section class="dsec">
      <details class="rounds" data-rounds="${esc(task.id)}" ${openedRounds.has(task.id) ? 'open' : ''}>
        <summary><h4>往来记录 · ${round} 轮</h4></summary>
        <ol class="round-list">
          ${items.map((item) => `
            <li class="${item.ask ? 'is-ask' : ''} ${item.error ? 'is-error' : ''}">
              <span class="round-who">第 ${item.round} 轮 · ${esc(item.who)}</span>
              <div class="round-text">${esc(String(item.text || '（空）').slice(0, 1200))}</div>
            </li>`).join('')}
        </ol>
      </details>
    </section>`;
}

/* ------------------------------- 列表 -------------------------------- */

const FILTERS = [
  { id: 'all', label: '全部', test: () => true },
  { id: 'waiting_approval', label: '待拍板', test: (t) => t.status === 'waiting_approval', warm: true },
  { id: 'active', label: '进行中', test: (t) => ['queued', 'running'].includes(t.status) },
  { id: 'done', label: '已结束', test: (t) => t.status === 'done' },
  { id: 'failed', label: '失败', test: (t) => ['failed', 'cancelled'].includes(t.status) }
];

const SOURCE_STATUS_LABEL = {
  open: '待处理',
  in_progress: '进行中',
  blocked: '阻塞',
  review: '待确认',
  done: '已完成',
  cancelled: '已关闭',
  unknown: '未知'
};
const OUTCOME_FILTER_LABEL = {
  unset: '本轮结束（未确认）',
  completed: '已完成',
  proposed: '待确认方案',
  delivered: '已回复',
  partial: '部分完成',
  blocked: '等你决定'
};

/** 任务来源：插件 id、对话、手动、自动化。 */
function sourceKey(task) {
  const origin = String(task.origin || '');
  if (origin.startsWith('plugin:')) return origin.slice('plugin:'.length);
  if (origin.startsWith('rule:') || task.rule_id) return '__automation';
  if (origin === 'schedule') return '__automation';
  return origin || 'chat';
}

function sourceName(key) {
  if (key === '__automation') return '自动化';
  const plugin = (state.plugins || []).find((item) => item.id === key);
  if (plugin) return plugin.label || plugin.name || key;
  if (key === 'chat') return '对话';
  if (key === 'manual') return '手动';
  return key;
}

/** 一个任务可能绑多个外部单子，状态分类取并集。 */
function sourceCategories(task) {
  return new Set((task.sources || []).map((link) => link.status?.category || 'unknown'));
}

function sourceStatusMatch(task, wanted) {
  if (wanted === 'all') return true;
  const links = task.sources || [];
  if (wanted === 'none') return links.length === 0;
  return [...sourceCategories(task)].includes(wanted);
}

function outcomeMatch(task, wanted) {
  if (wanted === 'all') return true;
  if (wanted === 'unset') return task.status === 'done' && !task.outcome;
  return task.outcome === wanted;
}

function baseFilteredTasks({ ignoreChip = false } = {}) {
  const q = state.taskQuery.trim().toLowerCase();
  return state.tasks.filter((t) => {
    if (!ignoreChip) {
      const filter = FILTERS.find((f) => f.id === state.taskFilter) || FILTERS[0];
      if (!filter.test(t)) return false;
    }
    if (state.taskSource !== 'all' && sourceKey(t) !== state.taskSource) return false;
    if (!sourceStatusMatch(t, state.taskSourceStatus)) return false;
    if (!outcomeMatch(t, state.taskOutcome)) return false;
    return !q || `${t.title} ${t.prompt || ''} ${t.id}`.toLowerCase().includes(q);
  });
}

function filteredTasks() {
  return baseFilteredTasks();
}

/** 来源 / 来源状态 / 完成情况三个下拉，选项从当前任务里现算。 */
function renderTaskFilterSelects() {
  const sources = [...new Set(state.tasks.map(sourceKey))].sort();
  if (state.taskSource !== 'all' && !sources.includes(state.taskSource)) state.taskSource = 'all';
  const sourceSel = $('#task-source-filter');
  if (sourceSel) {
    sourceSel.innerHTML = [
      `<option value="all">全部来源</option>`,
      ...sources.map((key) => `<option value="${esc(key)}">${esc(sourceName(key))}</option>`)
    ].join('');
    sourceSel.value = state.taskSource;
  }

  const categories = [...new Set(state.tasks.flatMap((t) => [...sourceCategories(t)]))].sort();
  const statusSel = $('#task-source-status');
  if (statusSel) {
    const options = [['all', '全部来源状态'], ['none', '未关联来源']];
    for (const category of categories) options.push([category, SOURCE_STATUS_LABEL[category] || category]);
    statusSel.innerHTML = options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    statusSel.value = state.taskSourceStatus;
  }

  const outcomeSel = $('#task-outcome-filter');
  if (outcomeSel) {
    const options = [['all', '全部完成情况'], ['unset', OUTCOME_FILTER_LABEL.unset], ...Object.entries(OUTCOME_FILTER_LABEL).filter(([key]) => key !== 'unset')];
    outcomeSel.innerHTML = options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    outcomeSel.value = state.taskOutcome;
  }
}

function taskSubtitle(t) {
  const approval = approvalFor(t);
  if (t.status === 'waiting_approval' && approval) return approval.question;
  if (t.status === 'running') return t.progress || '执行中…';
  if (t.status === 'queued') return '排队中，等空闲的执行槽位';
  if (t.status === 'failed') return t.error || t.result || '失败了';
  if (t.status === 'done' && endsWithQuestion(t.result)) return `它在问你：${(t.result || '').split('\n').map((l) => l.trim()).filter(Boolean).pop()}`;
  return (t.result || t.prompt || '').split('\n').find((line) => line.trim()) || '—';
}

function renderFilters() {
  const box = $('#task-filters');
  if (!box) return;
  renderTaskFilterSelects();
  const base = baseFilteredTasks({ ignoreChip: true });
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
        <span class="trow-meta">${statusPill(t.status, t.outcome)}${sourceTag(t)}<span>${esc(workerLabel(t.worker))}</span><span>·</span><span>${esc(t.parent_id ? '接着上一张' : originLabel(t))}</span></span>
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
      state.taskSource = 'all';
      state.taskSourceStatus = 'all';
      state.taskOutcome = 'all';
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

const RELAY_EVENT = { received: '收到回执', waiting_approval: '推了拍板卡片', done: '说做完了', failed: '说没做成', cancelled: '说停下了', result: '发了结果', chat: '回了一句' };

function eventDetail(e) {
  if (!e.data) return '';
  if (e.type === 'task/created') return `${workerLabel(e.data.worker)}${e.data.workflow ? ` · 按流程「${e.data.workflow}」` : ''}${e.data.parentId ? ' · 接着上一张' : ''}`;
  if (e.type === 'task/followup') return `第 ${e.data.round} 轮：${String(e.data.text || '').slice(0, 120)}`;
  if (e.type === 'task/spawned') return `另起「${e.data.title || ''}」`;
  if (e.type === 'source/status_changed') return `${e.data.label || e.data.provider}：${e.data.from || '（无）'} → ${e.data.to}`;
  if (e.type === 'source/linked') return `${e.data.label || e.data.provider} #${e.data.externalId}${e.data.status ? ` · ${e.data.status}` : ''}`;
  if (e.type === 'source/unlinked' || e.type === 'source/tracking_changed') return `${e.data.label || e.data.provider} #${e.data.externalId}${e.type === 'source/tracking_changed' ? (e.data.tracking ? ' · 恢复跟踪' : ' · 停止跟踪') : ''}`;
  if (e.type === 'source/sync_failed') return String(e.data.error || '').slice(0, 160);
  if (e.type === 'task/relayed') return `${e.data.label}：${RELAY_EVENT[e.data.event] || e.data.event}（${e.data.mode === 'updated' ? '更新了原来那条消息' : '发了一条新消息'}）`;
  if (e.type === 'task/relay_failed') return `${e.data.label}：${RELAY_EVENT[e.data.event] || e.data.event}，${String(e.data.error || '').slice(0, 120)}`;
  if (e.type === 'task/remote_action') return `${e.data.actorName || e.data.actor} 在${e.data.label}里${{ approve: '拍板', continue: '让它接着做', cancel: '停掉了它' }[e.data.action] || e.data.action}`;
  if (e.type === 'task/remote_denied') return `${e.data.label} 的用户 ${e.data.actor || '（未知）'} 想${e.data.action === 'approve' ? '拍板' : '操作'}，不在「能拍板的人」里`;
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
        ${runs.map((run, index) => {
          const end = run.finished_at ? new Date(run.finished_at) : new Date();
          const took = durationText(end - new Date(run.started_at));
          const cp = run.checkpoint ? Object.keys(run.checkpoint).join('、') : '';
          return `<div class="run-item"><span>第 ${index + 1} 次 · ${esc(RUN_STATUS_LABEL[run.status] || run.status)} · ${esc(took)}</span><small>${esc(cp ? `断点：${cp}` : clock(run.started_at))}</small></div>`;
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

function renderDetail({ task, events, approval, runs, links }, mode) {
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
          ${statusPill(task.status, task.outcome)}
          <span class="grow"></span>
          ${active ? `<button type="button" class="btn sm danger" data-action="cancel-task" data-id="${id}">${icon('stop', 'sm')}停止</button>` : ''}
          ${['failed', 'cancelled', 'done'].includes(task.status) ? `<button type="button" class="btn sm" data-action="retry-task" data-id="${id}">${icon('retry', 'sm')}${task.status === 'done' ? '重跑' : '重试'}</button>` : ''}
          ${task.status === 'done' ? `<label class="outcome-pick">结论
            <select data-task-outcome="${id}">
              ${OUTCOME_OPTIONS.map(([value, label]) => `<option value="${value}" ${(task.outcome || '') === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>` : ''}
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
        ${task.parent_id ? `<div class="detail-links">${parentLink(task, 'sm')}</div>` : ''}

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

        ${pending ? '' : `
          <section class="dsec">
            <div class="dsec-head"><h4>${['done', 'failed', 'cancelled'].includes(task.status) ? '接着做' : '现在'}</h4></div>
            ${replyBox(task, null)}
          </section>`}

        ${sourcesSection(task)}
        ${linksSection(task, links)}
        ${roundsSection(task, events)}

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
  else if (action === 'followup-same') submitFollowup(id, 'same', el);
  else if (action.startsWith('source-')) sourceAction(action, el);
  else if (action === 'followup-new') submitFollowup(id, 'new', el);
  else if (action === 'followup-open') {
    openedFollowups.add(id);
    changed('tasks');
    requestAnimationFrame(() => $(`#messages [data-followup-input="${CSS.escape(id)}"]`)?.focus());
  }
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
$('#task-source-filter')?.addEventListener('change', (event) => {
  state.taskSource = event.target.value;
  renderTaskList();
});
$('#task-source-status')?.addEventListener('change', (event) => {
  state.taskSourceStatus = event.target.value;
  renderTaskList();
});
$('#task-outcome-filter')?.addEventListener('change', (event) => {
  state.taskOutcome = event.target.value;
  renderTaskList();
});

// 详情里的「结论」：done 只代表跑完了，这里才是算不算完成。
document.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-task-outcome]');
  if (!select) return;
  const id = select.dataset.taskOutcome;
  select.disabled = true;
  try {
    const data = await api(`/api/tasks/${id}`, { method: 'PATCH', body: { outcome: select.value || null } });
    upsertTask(data.task);
    changed('tasks');
    renderTaskList();
    refreshTaskDetail(id);
    toast(select.value ? `已标记为「${OUTCOME_LABEL[select.value]}」。` : '已恢复为「本轮结束（未确认完成）」。');
  } catch (err) {
    toast(err.message);
    select.value = taskById(id)?.outcome || '';
  } finally {
    select.disabled = false;
  }
});

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

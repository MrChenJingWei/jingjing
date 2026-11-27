// 任务页：左边列表、右边详情（窄屏时详情从右侧滑出）。原「管理」页的重试 / 编辑 / 删除 / 暂停调度都在这里。
import {
  $, $$, state, on, changed, esc, md, timeAgo, clock, durationText, tokensText, toast, api,
  workerLabel, workerGlyph, workerIds, taskById, approvalFor, workflowById, upsertTask,
  ensureWorkspaceForPath, pickFolder, isWide, onWideChange, copyText, markTaskSeen,
  STATUS_LABEL, EVENT_LABEL, RUN_STATUS_LABEL, ORIGIN_LABEL, ACTIVE_STATUSES
} from './core.js';
import { icon, openDialog, ask, openPopover, openMenu, closePopover, catMark } from './ui.js';
import { switchView, renderActivity } from './shell.js';
import * as classify from './classify.js';
import {
  DIMENSIONS, SECTIONS, SOURCE_STATUS_LABEL, dimension, sectionOf, groupKeyOf, endsWithQuestion, awaitingReply, OUTCOMES_NEEDING_YOU
} from './task-views.js';

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
  const hostQuestion = approval.kind === 'routing' || approval.kind === 'recovery' || approval.kind === 'permission';
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

export { endsWithQuestion };

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
  if (task.status === 'held') {
    return compact ? '' : '<p class="reply-note">只跟踪：调度器不会执行它，来源状态照常同步。要交给 Worker 做，点上面的「开始执行」。</p>';
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
      ${asked ? `<div class="followup-ask">${icon('alert', 'sm')}<span>它最后在问你</span></div>` : ''}
      <div class="followup-row">
        <textarea rows="1" maxlength="4000" data-draft="${esc(key)}" data-followup-input="${id}" title="回车接着做 · Shift+回车换行"
          placeholder="${esc(compact ? (asked ? '直接回答它，或者接着说…' : '接着说点什么…') : (asked ? '直接回答它，回车就接着做' : FOLLOWUP_PLACEHOLDER[task.status]))}">${esc(drafts.get(key) || '')}</textarea>
        <button type="button" class="followup-new" data-action="followup-new" data-id="${id}" title="新开一张卡，带上这张的指令和结果，两张卡互相连着">另起一张</button>
        <button type="button" class="send-btn" data-action="followup-same" data-id="${id}" title="接着做（回车）：同一张卡，接着上次的上下文" aria-label="接着做">${icon('send')}</button>
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
  if (task.status === 'held' && ['done', 'cancelled'].includes(category)) {
    return `${link.providerLabel} 那边已经${category === 'done' ? '完成' : '关闭'}了。不用再跟踪的话，可以在「更多」里停掉这张卡。`;
  }
  if (task.status === 'done' && ['open', 'in_progress', 'blocked'].includes(category)) {
    return `这张卡做完了，${link.providerLabel} 那边还是「${link.status.label}」。记得去原单更新状态。`;
  }
  return '';
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
// 列表 = 顶上四块状态计数 + 分组方式（状态 / 来源 / 外部状态 / 归类 / 执行者 / 时间）+ 分好的段。
// 「只看」都是在列表上直接点：点状态块只看这一类，点段头的漏斗只看这一组。
// 只看的条件跨分组方式保留（只看 TAPD，再换成按外部状态分），在搜索框下面显示成可去掉的标签。

const GROUP_BY_KEY = 'jj.taskGroupBy';
const FOLD_KEY = 'jj.taskSections';
const readStore = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeStore = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存不下就只在这次生效 */ } };

state.taskGroupBy = readStore(GROUP_BY_KEY, 'status');
// 维度 -> { key, label }：status 是顶上四块，其他是段头的「只看这一组」。
state.taskFocus = {};
let sectionFold = readStore(FOLD_KEY, {});

/** 实际生效的分组方式：没开归类时「按归类」退回按状态。 */
function groupBy() {
  const by = dimension(state.taskGroupBy).id;
  return by === 'category' && !classify.groupingAvailable() ? 'status' : by;
}

function setGroupBy(by) {
  state.taskGroupBy = dimension(by).id;
  writeStore(GROUP_BY_KEY, state.taskGroupBy);
  renderTaskList();
  $('#task-list')?.scrollTo({ top: 0 });
}

function foldId(by, key) {
  return `${by}:${key}`;
}

/** 收起状态：主人点过就记住；没点过时，卡多的段默认收起。搜索或只看这一组时展开，免得命中的卡藏起来。 */
function isFolded(by, group) {
  if ((state.taskQuery || '').trim()) return false;
  if (state.taskFocus[by]?.key === group.key) return false;
  const id = foldId(by, group.key);
  if (id in sectionFold) return sectionFold[id];
  return Boolean(group.foldAt && group.list.length > group.foldAt);
}

function setFold(by, key, folded) {
  sectionFold = { ...sectionFold, [foldId(by, key)]: folded };
  writeStore(FOLD_KEY, sectionFold);
}

function matchesFocus(task, { except = null } = {}) {
  return Object.entries(state.taskFocus).every(([by, focus]) => by === except || groupKeyOf(by, task) === focus.key);
}

function searched() {
  const q = state.taskQuery.trim().toLowerCase();
  return q ? state.tasks.filter((t) => `${t.title} ${t.prompt || ''} ${t.id}`.toLowerCase().includes(q)) : state.tasks;
}

function filteredTasks() {
  return searched().filter((t) => matchesFocus(t));
}

function setFocus(by, key, label) {
  const next = { ...state.taskFocus };
  if (!key || next[by]?.key === key) delete next[by];
  else next[by] = { key, label };
  state.taskFocus = next;
  renderTaskList();
  if (isWide() && !filteredTasks().some((t) => t.id === state.selectedTaskId)) {
    state.selectedTaskId = null;
    ensureSelection();
  }
}

function clearFocus() {
  state.taskFocus = {};
}

/** 搜索框下面：分组方式（一排可点的词）+ 正在只看的条件。 */
function renderToolbar() {
  const box = $('#task-groupby');
  if (box) {
    const by = groupBy();
    const options = DIMENSIONS.filter((d) => d.id !== 'category' || classify.groupingAvailable());
    box.innerHTML = `<span class="groupby-label" title="分组方式">${icon('layers', 'sm')}</span>${options.map((d) => `
      <button type="button" class="groupby-opt ${d.id === by ? 'is-on' : ''}" data-group-by="${d.id}" role="tab" aria-selected="${d.id === by}">${esc(d.label)}</button>`).join('')}`;
  }
  const bar = $('#task-focus');
  if (bar) {
    const entries = Object.entries(state.taskFocus);
    bar.hidden = !entries.length;
    bar.innerHTML = entries.length ? `
      <span class="focus-label">${icon('filter', 'sm')}只看</span>
      ${entries.map(([by, focus]) => `<button type="button" class="focus-chip" data-clear-focus="${by}" title="去掉这个条件">${by === 'status' ? '' : `<em>${esc(dimension(by).label)}</em>`}${esc(focus.label)}${icon('x', 'sm')}</button>`).join('')}
      ${entries.length > 1 ? '<button type="button" class="focus-clear" data-clear-focus="__all">全部清除</button>' : ''}` : '';
  }
}

const firstLine = (text) => String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';

/** 外部单子的状态：一个带颜色圆点的小标签，颜色就是状态，字只有两三个。来源用首字母小方块。 */
function srcChip(task) {
  const link = (task.sources || [])[0];
  if (!link) return '';
  const off = link.providerState !== 'enabled' || !link.tracking;
  const category = off ? 'off' : link.status?.category || 'unknown';
  const label = off ? (link.tracking ? '来源停用' : '没在跟踪') : link.status?.label || SOURCE_STATUS_LABEL[category] || '未知';
  const more = (task.sources || []).length - 1;
  const title = [`${link.providerLabel}${link.externalId ? ` #${link.externalId}` : ''}`, link.title, link.syncError ? `同步失败：${link.syncError}` : ''].filter(Boolean).join('\n');
  return `<span class="schip" data-c="${esc(category)}" title="${esc(title)}"><i class="schip-src">${esc((link.providerLabel || '?').slice(0, 1).toUpperCase())}</i><i class="schip-dot"></i>${esc(label)}${more > 0 ? `<em>+${more}</em>` : ''}${link.syncState === 'error' ? icon('alert', 'sm') : ''}</span>`;
}

function chip(text, tone) {
  return `<span class="tchip" data-tone="${tone}">${esc(text)}</span>`;
}

/** 行的第二行：尽量是有颜色的小标签和进度条，只有等你回答的问题保留成一句话。 */
function rowLine(t) {
  const ask = t.status === 'done' && (!t.outcome || OUTCOMES_NEEDING_YOU.has(t.outcome)) ? awaitingReply(t.result) : '';
  const parts = [srcChip(t)];
  if (t.status === 'waiting_approval') {
    parts.push(`<span class="trow-ask">${esc((approvalFor(t)?.question || '等你拍板').slice(0, 120))}</span>`);
  } else if (t.status === 'done' && t.outcome && OUTCOMES_NEEDING_YOU.has(t.outcome)) {
    parts.push(chip(OUTCOME_LABEL[t.outcome], 'warm'), ask ? `<span class="trow-ask">${esc(ask.slice(0, 120))}</span>` : '');
  } else if (ask) {
    parts.push(chip('等你定', 'warm'), `<span class="trow-ask">${esc(ask.slice(0, 120))}</span>`);
  } else if (t.status === 'running') {
    parts.push(`<span class="tprog" title="${esc(t.progress || '执行中')}"><i></i></span>`);
  } else if (t.status === 'failed') {
    parts.push(chip('出错', 'danger'));
  } else if (t.status === 'queued' && Boolean(state.stats?.paused ?? state.settings?.queuePaused)) {
    parts.push(chip('等调度', 'muted'));
  } else if (t.status === 'done' && t.outcome) {
    parts.push(chip(OUTCOME_LABEL[t.outcome] || '本轮结束', ['completed', 'delivered'].includes(t.outcome) ? 'ok' : 'warm'));
  }
  const html = parts.filter(Boolean).join('');
  return html ? `<span class="trow-line">${html}</span>` : '';
}

/** 左边是有底色的状态方块，扫一眼颜色就知道是什么情况；标题一行；第二行是标签。 */
function taskRow(t) {
  return `
    <button type="button" class="trow trow-v2 ${t.id === state.selectedTaskId && isWide() ? 'is-selected' : ''} ${t.status === 'waiting_approval' ? 'is-waiting' : ''}" data-s="${esc(t.status)}" data-select-task="${esc(t.id)}" title="${esc(STATUS_LABEL[t.status] || t.status)}">
      <span class="tbadge" data-s="${esc(t.status)}"><span class="sdot" data-s="${esc(t.status)}"></span></span>
      <span class="trow-main">
        <span class="trow-top">${t.parent_id ? `<i class="trow-chain" title="接着上一张">${icon('link', 'sm')}</i>` : ''}<b>${esc(t.title)}</b><time>${timeAgo(t.updated_at || t.created_at)}</time></span>
        ${rowLine(t)}
      </span>
    </button>`;
}

/** 段头右边（按状态分时）：这一段里外部单子各是什么状态，用彩色圆点 + 数字。 */
function categoryDots(list) {
  const counts = new Map();
  for (const t of list) {
    const link = (t.sources || [])[0];
    if (!link || link.providerState !== 'enabled' || !link.tracking) continue;
    const c = link.status?.category || 'unknown';
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  if (!counts.size) return '';
  const order = ['blocked', 'open', 'in_progress', 'review', 'done', 'cancelled', 'unknown'];
  return `<span class="cdots">${[...counts].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([c, n]) => `<span class="cdot" data-c="${esc(c)}" title="外部单子${esc(SOURCE_STATUS_LABEL[c] || c)}：${n} 个"><i></i>${n}</span>`).join('')}</span>`;
}

/** 段头右边（按其他维度分时）：这一组里各状态几张，用状态图标 + 数字。 */
function statusDots(list) {
  const counts = new Map(SECTIONS.map((section) => [section.id, 0]));
  for (const t of list) counts.set(sectionOf(t).id, counts.get(sectionOf(t).id) + 1);
  return `<span class="sdots">${SECTIONS.filter((section) => counts.get(section.id)).map((section) => `
    <span class="sdot-n" data-tone="${section.tone}" title="${esc(section.label)}：${counts.get(section.id)} 张"><span class="sdot" data-s="${section.glyph}"></span>${counts.get(section.id)}</span>`).join('')}</span>`;
}

/** 列表顶上的四块：每类多少张，一眼看完；点了只看这一类，再点一次取消。 */
function overviewTiles() {
  const pool = searched().filter((t) => matchesFocus(t, { except: 'status' }));
  const focus = state.taskFocus.status?.key;
  return `
    <div class="tstats ${focus ? 'has-focus' : ''}">
      ${SECTIONS.map((section) => {
        const n = pool.filter((t) => sectionOf(t) === section).length;
        return `<button type="button" class="tstat ${focus === section.id ? 'is-on' : ''}" data-tone="${section.tone}" data-focus-status="${section.id}" ${n ? '' : 'data-empty'} aria-pressed="${focus === section.id}" title="${focus === section.id ? '再点一次看全部' : `只看${section.label}`}">
          <span class="tstat-top"><span class="sdot" data-s="${section.glyph}"></span><b>${n}</b></span>
          <span class="tstat-label">${esc(section.label)}</span>
        </button>`;
      }).join('')}
    </div>`;
}

function groupHead(by, group, folded) {
  const lead = group.glyph ? `<span class="sdot" data-s="${esc(group.glyph)}"></span>`
    : group.badge ? `<i class="tsec-badge">${esc(group.badge)}</i>`
      : group.dot ? `<i class="tsec-dot" data-c="${esc(group.dot)}"></i>` : '';
  const queued = by === 'status' && group.key === 'doing' ? (state.tasks || []).filter((t) => t.status === 'queued').length : 0;
  const focused = state.taskFocus[by]?.key === group.key;
  return `
    <div class="tsec-head" data-tone="${esc(group.tone || '')}">
      <button type="button" class="tsec-toggle" data-fold-section="${esc(group.key)}" aria-expanded="${!folded}">
        ${icon('chevronRight', 'sm')}${lead}<b>${esc(group.label)}</b><em>${group.list.length}</em>
        ${group.hint ? `<small>${esc(group.hint)}</small>` : ''}
      </button>
      ${by === 'status' ? categoryDots(group.list) : statusDots(group.list)}
      ${queued ? `<button type="button" class="tsec-act" data-action="hold-all-queued" title="把排队中的 ${queued} 个任务转为只跟踪：不执行，只看状态">排队的都只跟踪</button>` : ''}
      ${by !== 'status' && !focused ? `<button type="button" class="tsec-focus" data-focus-group="${esc(group.key)}" data-focus-label="${esc(group.label)}" title="只看这一组">${icon('filter', 'sm')}</button>` : ''}
    </div>`;
}

function renderGroups(tasks) {
  const by = groupBy();
  return dimension(by).bucket(tasks).filter((group) => group.list.length).map((group) => {
    const folded = isFolded(by, group);
    return `
      <section class="tsec ${folded ? 'is-folded' : ''}" data-section="${esc(group.key)}">
        ${groupHead(by, group, folded)}
        ${folded ? '' : `<div class="tsec-body">${group.list.map((t) => taskRow(t)).join('')}</div>`}
      </section>`;
  }).join('');
}

/** 从别处跳过来要看某一类（比如手机顶部「有 N 件事等你拍板」）：只看这一类，只生效一次。 */
function applyRequestedFilter() {
  const wanted = state.taskFilter;
  if (!wanted || wanted === 'all') return;
  state.taskFilter = 'all';
  const id = wanted === 'waiting_approval' ? 'attention' : wanted;
  const section = SECTIONS.find((item) => item.id === id);
  if (section) state.taskFocus = { status: { key: section.id, label: section.label } };
}

export function renderTaskList() {
  applyRequestedFilter();
  // 「按归类」沿用 classify.js 的渲染，它看 state.taskView。
  state.taskView = groupBy() === 'category' ? 'grouped' : 'flat';
  renderToolbar();
  renderQueueInfo();
  const box = $('#task-list');
  if (!box) return;
  const tasks = filteredTasks();
  const tiles = state.tasks.length ? overviewTiles() : '';
  if (!tasks.length) {
    const narrowed = Boolean(state.taskQuery.trim() || Object.keys(state.taskFocus).length);
    box.innerHTML = `${tiles}<div class="empty"><div class="empty-mark">${catMark({ sleeping: !narrowed })}</div><p>${narrowed ? '这样筛下来没有卡。换个词，或者去掉上面的「只看」条件。' : '这里还空着，静静在打盹。回对话里说一句，或者点右上角新建。'}</p></div>`;
    return;
  }
  box.classList.toggle('is-grouped', classify.grouped());
  box.innerHTML = tiles + (classify.grouped() ? classify.renderGrouped(tasks, taskRow) : renderGroups(tasks));
}

function renderQueueInfo() {
  const counts = state.stats?.counts || {};
  const paused = Boolean(state.stats?.paused ?? state.settings?.queuePaused);
  const parts = [
    paused ? '调度已暂停，排队的任务不会开始' : '调度运行中',
    ...(counts.running ? [`${counts.running} 个正在做`] : []),
    ...(state.stats?.doneToday ? [`今天做完 ${state.stats.doneToday} 个`] : [])
  ];
  const info = $('#queue-info');
  if (info) info.textContent = parts.join(' · ');
  // 状态页的那一行保留完整计数：那里没有分段列表。
  const full = [
    paused ? '调度已暂停，新任务只排队' : '调度运行中',
    `排队 ${counts.queued ?? 0}`,
    `执行中 ${counts.running ?? 0}`,
    ...(counts.held ? [`只跟踪 ${counts.held}`] : []),
    `等你拍板 ${counts.waiting_approval ?? 0}`,
    `今日完成 ${state.stats?.doneToday ?? 0}`
  ];
  for (const id of ['#queue-toggle', '#status-queue-toggle']) {
    const btn = $(id);
    if (!btn) continue;
    btn.innerHTML = paused ? `${icon('play', 'sm')}恢复调度` : `${icon('pause', 'sm')}暂停调度`;
    btn.classList.toggle('warm', paused);
  }
  const statusInfo = $('#status-queue-info');
  if (statusInfo) statusInfo.textContent = full.join(' · ');
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
  // 右侧正开着分类详情：不抢。
  if (classify.currentCategory() && $('#task-pane .cat-detail')) return;
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
  if (pane) pane.innerHTML = `<div class="empty pane-empty"><div class="empty-mark">${catMark()}</div><p>选一张卡，在这里看它做了什么。</p></div>`;
}

/** 打开了一张已结束的卡：记成看过，侧栏「静静替你办完的」就不再列它。还在跑的不记，免得结果出来时被跳过。 */
function noteSeen(id) {
  return ['done', 'failed', 'cancelled'].includes(taskById(id)?.status) && markTaskSeen(id);
}

function selectTask(id) {
  noteSeen(id);
  classify.forgetCategory();
  $$('#task-list .cgroup').forEach((g) => g.classList.remove('is-selected'));
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
    const target = taskById(id);
    if (target && !filteredTasks().some((t) => t.id === id)) {
      // 不在当前只看的范围里：去掉条件再选。
      clearFocus();
      state.taskQuery = '';
      const search = $('#task-search');
      if (search) search.value = '';
    }
    const by = groupBy();
    const key = target ? groupKeyOf(by, target) : null;
    if (key && sectionFold[foldId(by, key)]) setFold(by, key, false);
    if (!state.tasks.some((t) => t.id === id)) {
      state.taskFilter = 'all';
      state.taskQuery = '';
      clearFocus();
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
  if (noteSeen(id)) renderActivity();
  classify.forgetCategory();
  state.drawerTaskId = id;
  $('#drawer-backdrop').hidden = false;
  const drawer = $('#drawer');
  drawer.hidden = false;
  drawer.innerHTML = '<div class="empty"><span class="spinner"></span><p>读取任务…</p></div>';
  loadDetail(id, 'drawer');
}

export function closeDrawer() {
  classify.forgetCategory();
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
  if (e.type === 'task/permission-granted') {
    const bits = [e.data?.edit ? '改文件' : '', ...(e.data?.rules || []), ...(e.data?.dirs || []).map((dir) => `目录 ${dir}`)].filter(Boolean);
    return `${e.data?.scope === 'workspace' ? '以后这个工作区' : '这次'}放开：${bits.join('、') || '被拦下的操作'}`;
  }
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

/* ------------------------------ 详情：重新设计 ------------------------------ */
// 头部只留一个主动作（停止 / 重跑）和「⋯」菜单；状态标签本身就是「结论」选择器。
// 内容分三个页签：概览（拍板、结果、接着做、属性）· 指令与执行 · 记录。属性一行一项，操作收进行内的小菜单。

const detailTabs = new Map();
const TABS = [['overview', '概览'], ['exec', '指令与执行'], ['log', '记录']];

function statusControl(task) {
  if (task.status !== 'done') return statusPill(task.status, task.outcome);
  const label = OUTCOME_LABEL[task.outcome] || '本轮结束';
  return `<button type="button" class="pill pill-btn" data-s="done" ${task.outcome ? `data-o="${esc(task.outcome)}"` : ''} data-action="outcome-menu" data-id="${esc(task.id)}" aria-haspopup="menu" title="改结论：算不算做完了">${esc(label)}${icon('down', 'sm')}</button>`;
}

function primaryAction(task) {
  const id = esc(task.id);
  if (task.status === 'held') return `<button type="button" class="btn sm" data-action="release-task" data-id="${id}" title="交回调度器排队执行">${icon('play', 'sm')}开始执行</button>`;
  if (ACTIVE_STATUSES.includes(task.status)) return `<button type="button" class="btn sm ghost danger" data-action="cancel-task" data-id="${id}">${icon('stop', 'sm')}停止</button>`;
  if (['failed', 'cancelled', 'done'].includes(task.status)) return `<button type="button" class="btn sm" data-action="retry-task" data-id="${id}">${icon('retry', 'sm')}${task.status === 'done' ? '重跑' : '重试'}</button>`;
  return '';
}

function prop(label, value, { cls = '' } = {}) {
  if (!value) return '';
  return `<div class="prop ${cls}"><span class="prop-k">${esc(label)}</span><div class="prop-v">${value}</div></div>`;
}

function sourceProps(task) {
  return (task.sources || []).map((link) => {
    const off = link.providerState !== 'enabled' || !link.tracking;
    const hint = mismatchHint(task, link);
    const sync = link.syncError ? `<div class="prop-note is-error">${icon('alert', 'sm')}同步失败：${esc(link.syncError)}</div>`
      : `<div class="prop-note">${esc(SYNC_TEXT[link.syncState] || '')}${link.syncedAt ? ` · ${timeAgo(link.syncedAt)}` : ''}</div>`;
    return prop('来源', `
      <div class="src-line">
        <span class="src-tag ${off ? 'is-off' : ''}" data-c="${esc(off ? 'off' : link.status?.category || 'unknown')}">${esc(sourceStatusText(link))}</span>
        <span class="src-name" title="${esc(link.title || '')}">${esc(link.providerLabel)}${link.externalType || link.externalId ? ` · ${esc([link.externalType, link.externalId ? `#${link.externalId}` : ''].filter(Boolean).join(' '))}` : ''}</span>
        <span class="grow"></span>
        ${link.url ? `<a class="icon-btn xs" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" title="打开原单">${icon('external', 'sm')}</a>` : ''}
        <button type="button" class="icon-btn xs" data-action="source-menu" data-id="${esc(task.id)}" data-link="${esc(link.id)}" title="刷新 / 跟踪 / 解除" aria-haspopup="menu">${icon('more', 'sm')}</button>
      </div>
      ${link.title && link.title !== task.title ? `<div class="prop-sub">${esc(link.title)}</div>` : ''}
      ${hint ? `<div class="prop-note is-warn">${icon('alert', 'sm')}${esc(hint)}</div>` : sync}`);
  }).join('');
}

function linkProps(links) {
  const parent = links?.parent;
  const children = links?.children || [];
  const row = (item) => item.status === 'deleted'
    ? '<span class="muted">已经删除了</span>'
    : `<button type="button" class="link-line" data-action="open-task" data-id="${esc(item.id)}"><span class="sdot" data-s="${esc(item.status)}"></span><b>${esc(item.title || '（无标题）')}</b>${icon('chevronRight', 'sm')}</button>`;
  return [
    parent ? prop('上一张', row(parent)) : '',
    children.length ? prop('后续', children.map(row).join('')) : ''
  ].join('');
}

function execProp(task) {
  const workspace = (state.settings?.workspaces || []).find((ws) => ws.path === task.cwd);
  const where = workspace ? workspace.name : task.cwd ? task.cwd.replace(/^\/Users\/[^/]+/, '~') : '默认目录';
  return prop('执行', `
    <span class="exec-who">${esc(workerGlyph(task.worker))} ${esc(workerLabel(task.worker))}</span>
    <span class="exec-where" title="${esc([task.cwd, ...(workspace?.extraPaths || [])].filter(Boolean).join('\n'))}">${icon('folder', 'sm')}${esc(where)}${workspace?.extraPaths?.length ? `<em class="exec-more">+${workspace.extraPaths.length} 个文件夹</em>` : ''}</span>
    ${task.status !== 'running' ? `<button type="button" class="link-btn" data-action="edit-exec" data-id="${esc(task.id)}">换</button>` : ''}`);
}

function overviewTab(task, pending, links) {
  const id = esc(task.id);
  return `
    ${pending ? `<section class="dsec">${approvalBlock(task, pending)}</section>` : ''}
    ${task.status === 'running' ? `
      <section class="dsec"><div class="dbox progress-box"><span class="spinner"></span><span data-progress-text="${id}">${esc(task.progress || '执行中，等 Worker 回传进度…')}</span>${elapsedHtml(task)}</div></section>` : ''}
    ${task.result ? `
      <section class="dsec">
        <div class="result-card ${task.status === 'failed' ? 'is-error' : ''}">
          <div class="result-head"><h4>${task.status === 'failed' ? `${icon('alert', 'sm')}没做成，原因是` : '结果'}</h4>
            <button type="button" class="icon-btn xs" data-action="copy-result" data-id="${id}" title="复制">${icon('copy', 'sm')}</button></div>
          <div class="${task.status === 'failed' ? 'pre' : 'prose'}">${task.status === 'failed' ? esc(task.result) : md(task.result)}</div>
        </div>
      </section>` : ''}
    ${pending ? '' : `<section class="dsec">${replyBox(task, null)}</section>`}
    <section class="dsec props">
      ${classify.classificationProp(task) ? prop('归类', classify.classificationProp(task)) : ''}
      ${sourceProps(task)}
      ${linkProps(links)}
      ${execProp(task)}
      ${task.workflow_id ? prop('流程', esc(workflowById(task.workflow_id)?.name || '已移除')) : ''}
    </section>`;
}

function execTab(task, runs) {
  return `
    <section class="dsec">
      <div class="dsec-head"><h4>交给 Worker 的指令</h4>
        ${task.status !== 'running' ? `<button type="button" class="link-btn" data-action="edit-task" data-id="${esc(task.id)}">编辑</button>` : ''}</div>
      <div class="prompt-box ${task.prompt.length > 600 ? 'is-long' : ''}" data-prompt-box>
        <div class="dbox pre">${esc(task.prompt)}</div>
        ${task.prompt.length > 600 ? '<button type="button" class="prompt-more" data-action="prompt-toggle">展开全部</button>' : ''}
      </div>
    </section>
    <section class="dsec props">${execProp(task)}</section>
    ${runsHtml(runs) || '<p class="muted small">还没有执行记录。</p>'}`;
}

function logTab(task, events) {
  return `
    ${roundsSection(task, events)}
    <section class="dsec">
      <ul class="timeline">
        ${(events || []).map((e) => `
          <li>
            <span>${esc(EVENT_LABEL[e.type] || e.type)}</span><span class="t-time">${clock(e.created_at)}</span>
            ${eventDetail(e) ? `<div class="t-data">${esc(eventDetail(e))}</div>` : ''}
          </li>`).join('')}
      </ul>
    </section>`;
}

function renderDetail({ task, events, approval, runs, links }, mode) {
  const container = mode === 'drawer' ? $('#drawer') : $('#task-pane');
  if (!container) return;
  const pending = approval && approval.status === 'pending' ? approval : null;
  const id = esc(task.id);
  const scrollTop = container.scrollTop;
  const sameTask = container.dataset.taskId === task.id;
  const tab = detailTabs.get(task.id) || 'overview';
  const rounds = (events || []).filter((e) => e.type === 'task/followup').length;
  keepApprovalFocus(() => {
    container.dataset.taskId = task.id;
    container.innerHTML = `
      <article class="detail detail-v2">
        <header class="dhead">
          <div class="dhead-bar">
            ${statusControl(task)}
            ${task.parent_id ? parentLink(task, 'sm') : ''}
            <span class="grow"></span>
            ${primaryAction(task)}
            <button type="button" class="icon-btn" data-action="task-more" data-id="${id}" title="更多" aria-haspopup="menu">${icon('more')}</button>
            ${mode === 'drawer' ? `<button type="button" class="icon-btn" data-action="close-drawer" title="关闭（Esc）" aria-label="关闭">${icon('x')}</button>` : ''}
          </div>
          <h2>${esc(task.title)}</h2>
          <div class="dmeta">
            <span>${esc(originLabel(task))}</span><span>创建于 ${timeAgo(task.created_at)}</span>
            ${task.tokens ? `<span>${tokensText(task.tokens)} tokens</span>` : ''}
          </div>
          <nav class="dtabs" role="tablist">
            ${TABS.map(([key, label]) => `<button type="button" role="tab" class="dtab ${tab === key ? 'is-active' : ''}" aria-selected="${tab === key}" data-action="detail-tab" data-id="${id}" data-tab="${key}">${label}${key === 'log' && rounds ? `<em>${rounds + 1} 轮</em>` : ''}</button>`).join('')}
          </nav>
        </header>
        <div class="dbody">
          ${tab === 'exec' ? execTab(task, runs) : tab === 'log' ? logTab(task, events) : overviewTab(task, pending, links)}
        </div>
      </article>`;
  });
  if (sameTask) container.scrollTop = scrollTop;
  else container.scrollTop = 0;
}

/* ------------------------------ 详情：菜单与对话框 ------------------------------ */

function taskMenu(anchor, task) {
  const running = task.status === 'running';
  const items = [
    !running ? { label: '编辑任务', icon: 'edit', onSelect: () => editTask(task.id) } : null,
    !running ? { label: '换 Worker / 工作目录…', icon: 'cpu', onSelect: () => editExec(task.id) } : null,
    !running && task.status !== 'held' ? { label: '转为只跟踪（不执行）', icon: 'pause', onSelect: () => holdTask(task.id) } : null,
    task.status === 'held' ? { label: '停掉（不再跟踪）', icon: 'stop', onSelect: () => cancelTask(task.id) } : null,
    task.result ? { label: '复制结果', icon: 'copy', onSelect: () => copyText(task.result, '结果已复制。') } : null,
    replySourceOf(task) ? { label: '发回原会话', icon: 'reply', onSelect: () => openReplyDialog(task.id) } : null,
    task.status === 'done' && !task.workflow_id ? { label: '总结成流程', icon: 'flow', onSelect: () => learnTask({ dataset: { id: task.id }, disabled: false }) } : null
  ].filter(Boolean);
  const cls = classify.taskMenuItems(task);
  if (cls.length) items.push('divider', ...cls);
  if (!running) items.push('divider', { label: '删除任务', icon: 'trash', danger: true, onSelect: () => deleteTask(task.id) });
  openMenu(anchor, items);
}

function outcomeMenu(anchor, task) {
  openMenu(anchor, [
    { heading: '这件事算不算做完了？' },
    ...OUTCOME_OPTIONS.map(([value, label]) => ({ label, checked: (task.outcome || '') === value, onSelect: () => setOutcome(task.id, value) }))
  ], { align: 'start' });
}

function sourceMenu(anchor, task, linkId) {
  const link = (task.sources || []).find((item) => item.id === linkId);
  if (!link) return;
  const run = (action, extra = {}) => () => sourceAction(action, { dataset: { id: task.id, link: linkId, ...extra }, disabled: false });
  openMenu(anchor, [
    link.canRefresh ? { label: '刷新状态', icon: 'refresh', onSelect: run('source-refresh') } : null,
    link.providerState === 'enabled' ? { label: link.tracking ? '停止跟踪' : '恢复跟踪', icon: link.tracking ? 'pause' : 'play', onSelect: run('source-track', { on: link.tracking ? '0' : '1' }) } : null,
    link.url ? { label: '打开原单', icon: 'external', onSelect: () => window.open(link.url, '_blank', 'noopener') } : null,
    'divider',
    { label: '解除绑定', icon: 'x', danger: true, onSelect: run('source-unlink') }
  ]);
}

async function setOutcome(id, value) {
  try {
    const data = await api(`/api/tasks/${id}`, { method: 'PATCH', body: { outcome: value || null } });
    upsertTask(data.task);
    changed('tasks');
    renderTaskList();
    refreshTaskDetail(id);
    toast(value ? `已标记为「${OUTCOME_LABEL[value]}」。` : '已恢复为「本轮结束（未确认完成）」。');
  } catch (err) {
    toast(err.message);
  }
}

function editExec(taskId) {
  const task = taskById(taskId) || detailCache.get(taskId)?.task;
  if (!task) return;
  const workspaces = state.settings?.workspaces || [];
  const known = workspaces.some((ws) => ws.path === task.cwd);
  openDialog({
    title: '换 Worker / 工作目录',
    desc: '下次执行（重跑、重试或恢复）时生效。',
    body: `
      <label class="field"><span>Worker</span>
        <select name="worker">
          ${workerIds().map((worker) => `<option value="${esc(worker)}" ${task.worker === worker ? 'selected' : ''}>${esc(workerLabel(worker))}</option>`).join('')}
          ${task.worker && !workerIds().includes(task.worker) ? `<option value="${esc(task.worker)}" selected>${esc(workerLabel(task.worker))}（不可用）</option>` : ''}
        </select></label>
      <label class="field"><span>工作目录</span>
        <select name="cwd" data-task-workspace="${esc(task.id)}">
          ${workspaces.map((ws) => `<option value="${esc(ws.path)}" ${ws.path === task.cwd ? 'selected' : ''}>${esc(ws.name)} · ${esc(ws.path)}</option>`).join('')}
          ${task.cwd && !known ? `<option value="${esc(task.cwd)}" selected>当前 · ${esc(task.cwd)}</option>` : ''}
          <option value="__custom__">选择其他文件夹…</option>
        </select></label>`,
    okText: '保存',
    onSubmit: async ({ worker, cwd }) => {
      if (!cwd || cwd === '__custom__') throw new Error('先选一个工作目录');
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { cwd, ...(worker ? { worker } : {}) } });
      toast('已更新，下次执行时生效。');
      refreshTaskDetail(task.id);
    }
  });
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

async function holdTask(taskId) {
  try {
    const data = await api(`/api/tasks/${taskId}/hold`, { method: 'POST' });
    if (data.task) upsertTask(data.task);
    if (data.stats) state.stats = { ...state.stats, ...data.stats };
    changed('tasks');
    refreshTaskDetail(taskId);
    toast('已转为只跟踪：不会执行，来源状态照常同步。');
  } catch (err) {
    toast(err.message);
  }
}

async function releaseTask(taskId) {
  try {
    const data = await api(`/api/tasks/${taskId}/release`, { method: 'POST' });
    if (data.task) upsertTask(data.task);
    if (data.stats) state.stats = { ...state.stats, ...data.stats };
    changed('tasks');
    refreshTaskDetail(taskId);
    const paused = Boolean(state.stats?.paused ?? state.settings?.queuePaused);
    toast(paused ? '已加入队列；调度暂停中，恢复调度后才会执行。' : '已交给调度器，排队执行。');
  } catch (err) {
    toast(err.message);
  }
}

/** 排队中的一次全转为只跟踪：开调度前先把不想跑的拦下来。 */
async function holdAllQueued() {
  const n = state.stats?.counts?.queued ?? 0;
  const ok = await ask({
    title: `把排队中的 ${n} 个任务都转为只跟踪？`,
    message: '它们会留在列表里、来源状态照常同步，但调度器不会执行。之后想做哪个，点那张卡的「开始执行」。',
    okText: '都转为只跟踪'
  });
  if (!ok) return;
  try {
    const data = await api('/api/tasks/hold-queued', { method: 'POST' });
    if (data.stats) state.stats = { ...state.stats, ...data.stats };
    import('./sync.js').then((m) => m.resync()).catch(() => {});
    changed('stats');
    toast(data.count ? `${data.count} 个任务已转为只跟踪。` : '没有排队中的任务。');
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
      </div>
      <label class="switch-row"><span><b>只跟踪，不执行</b><small>留在列表里看状态，调度器不会去做；之后想做再点「开始执行」。</small></span><input type="checkbox" class="switch" name="held" /></label>`,
    okText: '加入队列',
    onSubmit: async ({ title, prompt, worker, cwd, held }) => {
      if (!title.trim() || !prompt.trim()) throw new Error('任务名和指令都要填');
      const track = held === true;
      const data = await api('/api/tasks', { method: 'POST', body: { title, prompt, worker, ...(cwd ? { cwd } : {}), held: track } });
      upsertTask(data.task);
      changed('tasks');
      toast(track ? '已加入，只跟踪不执行。' : '任务已进队列。');
      await openTask(data.task.id, { reveal: true });
    }
  });
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
  else if (action === 'release-task') { el.disabled = true; await releaseTask(id); }
  else if (action === 'edit-task') editTask(id);
  else if (action === 'delete-task') deleteTask(id);
  else if (action === 'edit-exec') editExec(id);
  else if (action === 'prompt-toggle') {
    const box = el.closest('[data-prompt-box]');
    const open = box.classList.toggle('is-open');
    el.textContent = open ? '收起' : '展开全部';
  }
  else if (action === 'task-more' || action === 'outcome-menu' || action === 'source-menu') {
    const task = detailCache.get(id)?.task || taskById(id);
    if (!task) return;
    if (action === 'task-more') taskMenu(el, task);
    else if (action === 'outcome-menu') outcomeMenu(el, task);
    else sourceMenu(el, task, el.dataset.link);
  } else if (action === 'detail-tab') {
    detailTabs.set(id, el.dataset.tab);
    const data = detailCache.get(id);
    if (data) renderDetail(data, el.closest('#drawer') ? 'drawer' : 'pane');
  }
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

$('#task-list')?.addEventListener('click', (event) => {
  const tile = event.target.closest('[data-focus-status]');
  if (tile) {
    const section = SECTIONS.find((item) => item.id === tile.dataset.focusStatus);
    setFocus('status', section.id, section.label);
    return;
  }
  const focus = event.target.closest('[data-focus-group]');
  if (focus) {
    setFocus(groupBy(), focus.dataset.focusGroup, focus.dataset.focusLabel);
    return;
  }
  const fold = event.target.closest('[data-fold-section]');
  if (fold) {
    const by = groupBy();
    const key = fold.dataset.foldSection;
    const group = dimension(by).bucket(filteredTasks()).find((item) => item.key === key);
    if (group) setFold(by, key, !isFolded(by, group));
    renderTaskList();
    return;
  }
  if (event.target.closest('[data-action="hold-all-queued"]')) holdAllQueued();
});

$('#task-groupby')?.addEventListener('click', (event) => {
  const option = event.target.closest('[data-group-by]');
  if (option) setGroupBy(option.dataset.groupBy);
});

$('#task-focus')?.addEventListener('click', (event) => {
  const chipEl = event.target.closest('[data-clear-focus]');
  if (!chipEl) return;
  if (chipEl.dataset.clearFocus === '__all') clearFocus();
  else setFocus(chipEl.dataset.clearFocus, null);
  renderTaskList();
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
on('plugins', () => { if (state.view === 'tasks') renderTaskList(); });
classify.setHooks({
  openTask: (id) => openTask(id),
  renderList: () => { if (state.view === 'tasks') renderTaskList(); },
  refreshDetail: (id) => refreshTaskDetail(id)
});
on('approvals', () => { if (state.view === 'tasks') renderTaskList(); });
on('stats', renderQueueInfo);
on('settings', renderQueueInfo);
on('progress', () => {
  patchProgressText();
  if (state.view === 'tasks') {
    for (const row of $$('#task-list .trow')) {
      const task = taskById(row.dataset.selectTask);
      if (task?.status === 'running') {
        const bar = row.querySelector('.tprog');
        if (bar) bar.title = task.progress || '执行中';
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

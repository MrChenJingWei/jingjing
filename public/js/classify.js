// 任务归类（docs/architecture/external.md「界面」）：任务页的「平铺 / 按归类」、分类头、分类详情（含知识区）、
// 卡片上的「属于 xxx」、歧义选择、「归到…」「记一条知识」，以及设置里的「归类与知识」。
// 默认安静：没开任何自动归类、也没建过手动分类时，任务页不出现切换和分类头。
import { $, $$, state, on, changed, esc, timeAgo, toast, api, taskById, upsertTask, workerLabel, isWide } from './core.js';
import { icon, openDialog, ask } from './ui.js';

const VIEW_KEY = 'jingjing-task-view';
const FOLD_KEY = 'jingjing-folded-groups';
const STATUS_TONE = { queued: 'queued', running: 'running', waiting_approval: 'waiting', done: 'done', failed: 'failed', cancelled: 'failed' };
const KIND_ORDER = ['status', 'cause', 'fix', 'symptom', 'decision', 'outcome', 'relation', 'note'];
const KIND_LABEL = { relation: '关系', status: '状态', outcome: '结论', cause: '因果', fix: '修复', symptom: '现象', decision: '决策', note: '备注' };
const WHO_LABEL = { auto: '自动', manual: '手动' };

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储不可用就不记 */ }
  }
};

state.categories = state.categories || [];
state.taskView = store.get(VIEW_KEY, 'grouped');
let folded = new Set(store.get(FOLD_KEY, []));
// tasks.js 注册：打开任务、刷新列表 / 详情（避免互相 import 成环）。
const hooks = { openTask: () => {}, renderList: () => {}, refreshDetail: () => {} };
export function setHooks(next) { Object.assign(hooks, next); }

/* ------------------------------- 数据 -------------------------------- */

export function enabled() {
  return state.settings?.classification?.enabled !== false;
}

/** 有没有东西可以「按归类」看：至少一个开启自动归类的来源，或者建过手动分类。 */
export function groupingAvailable() {
  if (!enabled()) return false;
  const anyOn = (state.plugins || []).some((plugin) => plugin.classification?.state === 'on');
  return anyOn || (state.categories || []).some((c) => c.axis === 'label');
}

export function grouped() {
  return groupingAvailable() && state.taskView === 'grouped';
}

let loadTimer = null;
export function loadCategories() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(async () => {
    try {
      const data = await api('/api/categories');
      state.categories = data.categories || [];
      changed('categories');
    } catch { /* 下次事件再拉 */ }
  }, 150);
}

const categoryById = (id) => (state.categories || []).find((c) => c.id === id) || null;

function relationOf(task) {
  return (task?.classifications || []).find((c) => c.axis === 'relation') || null;
}
function labelOf(task) {
  return (task?.classifications || []).find((c) => c.axis === 'label') || null;
}
/** 列表分组用：关系轴优先，其次手动标签。只有真正进组的成员（state = member）才算。 */
function groupOf(task) {
  const rel = relationOf(task);
  if (rel?.categoryId && rel.state === 'member') return rel;
  const label = labelOf(task);
  return label?.categoryId ? label : null;
}

function refText(category) {
  const ref = category?.ref;
  if (!ref) return category?.axis === 'label' ? '手动分类' : '';
  const status = category.shell ? '待同步' : ref.status?.label || '';
  return [ref.typeLabel || ref.type, ref.id ? `#${ref.id}` : '', status].filter(Boolean).join(' · ');
}

/* ------------------------------ 列表：切换 ------------------------------ */

export function viewToggleHtml() {
  if (!groupingAvailable()) return '';
  const view = state.taskView === 'grouped' ? 'grouped' : 'flat';
  return `
    <div class="seg seg-sm view-toggle" role="tablist" aria-label="列表视图">
      <button type="button" class="seg-item icon-only ${view === 'flat' ? 'is-active' : ''}" data-task-view="flat" role="tab" aria-selected="${view === 'flat'}" title="平铺" aria-label="平铺">${icon('list', 'sm')}</button>
      <button type="button" class="seg-item icon-only ${view === 'grouped' ? 'is-active' : ''}" data-task-view="grouped" role="tab" aria-selected="${view === 'grouped'}" title="按归类" aria-label="按归类">${icon('layers', 'sm')}</button>
    </div>`;
}

/* ------------------------------ 列表：分组 ------------------------------ */

/** 列表行里的归类标记：歧义时提示人选；单成员分类或平铺视图里显示「属于 xxx」。 */
export function classTag(task, { inGroup = false } = {}) {
  const rel = relationOf(task);
  if (rel?.ambiguous) return `<span class="cls-tag is-ambiguous" title="点开卡片选一个">${icon('split', 'sm')}关联 ${rel.candidates.length} 个 · 未归类</span>`;
  if (inGroup) return '';
  const group = groupOf(task) || (rel?.state === 'overflow' ? rel : null);
  if (!group?.title) return '';
  return `<span class="cls-tag" title="${esc(group.reason || '')}">${icon('layers', 'sm')}${esc(group.title)}</span>`;
}

/**
 * 按归类渲染列表。rowHtml(task, { inGroup }) 由 tasks.js 提供。
 * 规则：分类头不是卡片（不进统计、不可选中）；单成员不出头；筛选只作用于子卡，头上写「命中 n / 共 m」；未归类放最后。
 */
export function renderGrouped(tasks, rowHtml) {
  const groups = new Map();
  const loose = [];
  for (const task of tasks) {
    const group = groupOf(task);
    const category = group ? categoryById(group.categoryId) : null;
    const total = category?.rollup?.members ?? 0;
    if (!group || !category || total < 2) {
      loose.push(task);
      continue;
    }
    if (!groups.has(category.id)) groups.set(category.id, { category, tasks: [] });
    groups.get(category.id).tasks.push(task);
  }
  const ACTIVE = new Set(['queued', 'running', 'waiting_approval']);
  const list = [...groups.values()].sort((a, b) => {
    const activeA = a.tasks.some((t) => ACTIVE.has(t.status)) ? 1 : 0;
    const activeB = b.tasks.some((t) => ACTIVE.has(t.status)) ? 1 : 0;
    if (activeA !== activeB) return activeB - activeA;
    const latest = (g) => Math.max(...g.tasks.map((t) => Date.parse(t.updated_at || t.created_at) || 0));
    return latest(b) - latest(a);
  });
  const q = (state.taskQuery || '').trim();
  const html = list.map(({ category, tasks: members }) => {
    const roll = category.rollup || {};
    const total = roll.members || members.length;
    const pct = total ? Math.round(((roll.done || 0) / total) * 100) : 0;
    // 搜索命中子卡时自动展开。
    const isFolded = !q && (folded.has(category.id) || (category.state === 'dormant' && !folded.has(`open:${category.id}`)));
    const hit = members.length < total ? `命中 ${members.length} / 共 ${total}` : `${roll.done || 0}/${total} 完成`;
    const tone = roll.waiting ? 'waiting' : roll.running ? 'running' : roll.failed ? 'failed' : roll.active ? 'queued' : 'done';
    return `
      <div class="cgroup ${isFolded ? 'is-folded' : ''}" data-tone="${tone}" data-group="${esc(category.id)}">
        <div class="cgroup-head">
          <button type="button" class="cgroup-fold" data-fold-group="${esc(category.id)}" aria-expanded="${!isFolded}" aria-label="${isFolded ? '展开' : '收起'}">${icon('chevronRight', 'sm')}</button>
          <button type="button" class="cgroup-title" data-open-category="${esc(category.id)}">
            <b>${esc(category.title)}</b>
            <small>${esc(refText(category))}${category.state === 'dormant' ? ' · 都结束了' : ''}</small>
          </button>
          <span class="cgroup-progress" title="${esc(hit)}"><i style="--p:${pct}%"></i></span>
          <span class="cgroup-count">${esc(hit)}</span>
        </div>
        <div class="cgroup-body">${members.map((task) => rowHtml(task, { inGroup: true })).join('')}</div>
      </div>`;
  }).join('');
  const looseHtml = loose.length
    ? (list.length
      ? `<div class="cgroup is-loose ${folded.has('__loose') ? 'is-folded' : ''}" data-group="__loose">
          <div class="cgroup-head">
            <button type="button" class="cgroup-fold" data-fold-group="__loose" aria-expanded="${!folded.has('__loose')}">${icon('chevronRight', 'sm')}</button>
            <span class="cgroup-title"><b>未归类</b><small>${loose.length} 张</small></span>
          </div>
          <div class="cgroup-body">${loose.map((task) => rowHtml(task, { inGroup: false })).join('')}</div>
        </div>`
      : loose.map((task) => rowHtml(task, { inGroup: false })).join(''))
    : '';
  return html + looseHtml;
}

function toggleFold(id) {
  const category = categoryById(id);
  if (category?.state === 'dormant') {
    // 结束了的分类默认收起：记的是「展开过」。
    const key = `open:${id}`;
    if (folded.has(key)) folded.delete(key);
    else folded.add(key);
  } else if (folded.has(id)) folded.delete(id);
  else folded.add(id);
  store.set(FOLD_KEY, [...folded].slice(-300));
  hooks.renderList();
}

/* ------------------------------ 卡片详情：归属 ------------------------------ */

/** 详情里「属于」那一节：关系轴、标签轴各一行；歧义给候选；外加「归到…」「记一条知识」。 */
export function classificationSection(task) {
  if (!enabled()) return '';
  const id = esc(task.id);
  const rows = [];
  const rel = relationOf(task);
  const label = labelOf(task);
  if (rel?.ambiguous) {
    rows.push(`
      <div class="cls-ambiguous">
        <div class="cls-ambiguous-head">${icon('split', 'sm')}<b>关联了 ${rel.candidates.length} 个上级，拿不准归哪个</b></div>
        <div class="cls-candidates">
          ${rel.candidates.map((c) => `<button type="button" class="btn sm" data-cls-action="choose" data-id="${id}" data-key="${esc(c.key)}">${esc(c.title)}</button>`).join('')}
          <button type="button" class="btn sm ghost" data-cls-action="unassign" data-id="${id}" data-axis="relation">都别管</button>
        </div>
      </div>`);
  } else if (rel?.categoryId) {
    const how = rel.who === 'manual' ? '手动' : rel.state === 'overflow' ? '分类已满，未进组' : '自动';
    rows.push(`
      <div class="cls-row">
        <span class="cls-axis">${icon('layers', 'sm')}属于</span>
        <button type="button" class="cls-crumb" data-open-category="${esc(rel.categoryId)}">${esc(rel.title)} ${icon('chevronRight', 'sm')}</button>
        <span class="cls-how" title="${esc(rel.reason)}">${esc(how)}</span>
        <span class="grow"></span>
        ${rel.who === 'manual'
          ? `<button type="button" class="btn xs ghost" data-cls-action="auto" data-id="${id}" data-axis="relation">恢复自动</button>`
          : `<button type="button" class="btn xs ghost" data-cls-action="optout" data-id="${id}">不参与自动归类</button>`}
        <button type="button" class="btn xs ghost" data-cls-action="unassign" data-id="${id}" data-axis="relation" data-title="${esc(rel.title)}">移出</button>
      </div>`);
  }
  if (label?.categoryId) {
    rows.push(`
      <div class="cls-row">
        <span class="cls-axis">${icon('tag', 'sm')}标签</span>
        <button type="button" class="cls-crumb" data-open-category="${esc(label.categoryId)}">${esc(label.title)} ${icon('chevronRight', 'sm')}</button>
        <span class="grow"></span>
        <button type="button" class="btn xs ghost" data-cls-action="unassign" data-id="${id}" data-axis="label" data-title="${esc(label.title)}">移出</button>
      </div>`);
  }
  const scope = rel?.categoryId || label?.categoryId || '';
  return `
    <section class="dsec">
      <div class="dsec-head"><h4>归类</h4>
        <span class="dsec-actions">
          <button type="button" class="btn xs" data-cls-action="assign" data-id="${id}">${icon('folderPlus', 'sm')}归到…</button>
          ${scope ? `<button type="button" class="btn xs" data-cls-action="note" data-id="${id}" data-category="${esc(scope)}">${icon('bulb', 'sm')}记一条知识</button>` : ''}
        </span>
      </div>
      ${rows.join('') || '<p class="muted small">还没有归类。可以手动「归到…」一个分类；开了自动归类的来源会自己归。</p>'}
    </section>`;
}

/* ------------------------------ 卡片详情：属性行 + 菜单（新版详情用） ------------------------------ */

/** 详情「概览」里归类那一行的值：属于哪个分类（点开分类）、歧义时给候选；没有就是一个「归到…」。 */
export function classificationProp(task) {
  if (!enabled()) return '';
  const id = esc(task.id);
  const rel = relationOf(task);
  const label = labelOf(task);
  const parts = [];
  if (rel?.ambiguous) {
    parts.push(`<div class="cls-pick"><span class="cls-pick-q">${icon('split', 'sm')}关联了 ${rel.candidates.length} 个上级，归到哪个？</span>
      ${rel.candidates.map((c) => `<button type="button" class="chip-btn" data-cls-action="choose" data-id="${id}" data-key="${esc(c.key)}">${esc(c.title)}</button>`).join('')}
      <button type="button" class="chip-btn is-ghost" data-cls-action="unassign" data-id="${id}" data-axis="relation">都不归</button></div>`);
  } else if (rel?.categoryId) {
    const how = rel.who === 'manual' ? '手动' : rel.state === 'overflow' ? '分类已满' : '自动';
    parts.push(`<button type="button" class="cls-crumb" data-open-category="${esc(rel.categoryId)}" title="${esc(rel.reason)}">${icon('layers', 'sm')}${esc(rel.title)}</button><span class="cls-how">${esc(how)}</span>`);
  }
  if (label?.categoryId) {
    parts.push(`<button type="button" class="cls-crumb is-label" data-open-category="${esc(label.categoryId)}">${icon('tag', 'sm')}${esc(label.title)}</button>`);
  }
  if (!parts.length) parts.push(`<button type="button" class="link-btn" data-cls-action="assign" data-id="${id}">未归类 · 归到…</button>`);
  return parts.join('');
}

/** 「⋯」菜单里归类相关的几项。 */
export function taskMenuItems(task) {
  if (!enabled()) return [];
  const rel = relationOf(task);
  const label = labelOf(task);
  const run = (action, extra = {}) => () => taskAction({ dataset: { clsAction: action, id: task.id, ...extra } }).catch((err) => toast(err.message));
  const scope = rel?.categoryId || label?.categoryId;
  return [
    { label: '归到…', icon: 'folderPlus', onSelect: run('assign') },
    scope ? { label: '记一条知识', icon: 'bulb', onSelect: run('note', { category: scope }) } : null,
    rel?.categoryId ? { label: `移出「${esc(rel.title)}」`, icon: 'x', onSelect: run('unassign', { axis: 'relation', title: rel.title }) } : null,
    label?.categoryId ? { label: `移出「${esc(label.title)}」`, icon: 'x', onSelect: run('unassign', { axis: 'label', title: label.title }) } : null,
    rel?.who === 'manual' ? { label: '恢复自动归类', icon: 'refresh', onSelect: run('auto', { axis: 'relation' }) } : null,
    rel?.categoryId && rel.who !== 'manual' ? { label: '不参与自动归类', icon: 'eyeOff', onSelect: run('optout') } : null
  ].filter(Boolean);
}

/* ------------------------------ 分类详情 ------------------------------ */

let openCategoryId = null;

export function currentCategory() {
  return openCategoryId;
}

export function forgetCategory() {
  openCategoryId = null;
}

function categoryContainer() {
  if (state.view === 'tasks' && isWide()) return { el: $('#task-pane'), mode: 'pane' };
  const drawer = $('#drawer');
  $('#drawer-backdrop').hidden = false;
  drawer.hidden = false;
  return { el: drawer, mode: 'drawer' };
}

export async function openCategory(id) {
  openCategoryId = id;
  const { el, mode } = categoryContainer();
  if (!el) return;
  if (mode === 'pane') state.selectedTaskId = null;
  $$('#task-list .trow').forEach((row) => row.classList.remove('is-selected'));
  $$('#task-list .cgroup').forEach((g) => g.classList.toggle('is-selected', g.dataset.group === id));
  try {
    const data = await api(`/api/categories/${id}`);
    if (openCategoryId !== id) return;
    renderCategory(el, data.category, mode);
  } catch (err) {
    toast(err.message);
  }
}

export function refreshCategory() {
  if (openCategoryId && ($('#task-pane .cat-detail') || $('#drawer .cat-detail'))) openCategory(openCategoryId);
}

function knowledgeHtml(category) {
  const items = category.knowledge || [];
  if (!items.length) {
    return `<div class="empty-inline">${icon('bulb')}<span>${category.axis === 'relation' ? '这个分类下还没有知识，修完一张卡会自动积累。' : '还没有知识。可以点「记一条」写下这类事情要注意什么。'}</span></div>`;
  }
  const byKind = new Map();
  for (const item of items) {
    if (!byKind.has(item.kind)) byKind.set(item.kind, []);
    byKind.get(item.kind).push(item);
  }
  return KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => `
    <div class="kn-group">
      <div class="kn-kind" data-k="${esc(kind)}">${esc(KIND_LABEL[kind] || kind)}</div>
      <ul class="kn-list">
        ${byKind.get(kind).map((item) => {
          const flags = [
            item.conflict ? '<span class="kn-flag is-conflict">冲突</span>' : '',
            !item.confirmed ? '<span class="kn-flag is-pending">待确认</span>' : '',
            item.hidden ? '<span class="kn-flag">已隐藏</span>' : '',
            item.pinned ? `<span class="kn-flag is-pin">${icon('pin', 'sm')}</span>` : ''
          ].join('');
          const from = item.evidence?.taskId
            ? `<button type="button" class="kn-from" data-open-task="${esc(item.evidence.taskId)}">来自任务</button>`
            : item.source === 'manual' ? '<span class="kn-from">你记的</span>' : '';
          return `
            <li class="kn-item ${item.hidden ? 'is-hidden' : ''} ${item.conflict ? 'is-conflict' : ''}">
              <div class="kn-text">${flags}<span>${esc(item.text)}</span></div>
              <div class="kn-meta">${from}<span>${timeAgo(item.updatedAt)}</span>${item.usedCount ? `<span>用上 ${item.usedCount} 次</span>` : ''}
                <span class="grow"></span>
                ${item.conflict ? `<button type="button" class="btn xs" data-kn-action="choose" data-kn="${esc(item.id)}">以这条为准</button>` : ''}
                ${!item.confirmed ? `<button type="button" class="btn xs primary" data-kn-action="confirm" data-kn="${esc(item.id)}">确认</button>` : ''}
                <button type="button" class="icon-btn xs" data-kn-action="${item.pinned ? 'unpin' : 'pin'}" data-kn="${esc(item.id)}" title="${item.pinned ? '取消固定' : '固定（总是优先参考）'}">${icon('pin', 'sm')}</button>
                <button type="button" class="icon-btn xs" data-kn-action="edit" data-kn="${esc(item.id)}" title="改文字">${icon('edit', 'sm')}</button>
                <button type="button" class="icon-btn xs" data-kn-action="${item.hidden ? 'show' : 'hide'}" data-kn="${esc(item.id)}" title="${item.hidden ? '恢复' : '隐藏（不再参考）'}">${icon(item.hidden ? 'eye' : 'eyeOff', 'sm')}</button>
                <button type="button" class="icon-btn xs danger" data-kn-action="delete" data-kn="${esc(item.id)}" title="删除">${icon('trash', 'sm')}</button>
              </div>
            </li>`;
        }).join('')}
      </ul>
    </div>`).join('');
}

function renderCategory(el, category, mode) {
  const roll = category.rollup || {};
  const total = roll.members || 0;
  const pct = total ? Math.round(((roll.done || 0) / total) * 100) : 0;
  const ref = category.ref;
  const id = esc(category.id);
  const emptyText = category.axis === 'relation' ? '这个需求下的卡都处理完了。' : '还没有卡，可以在卡片详情里选「归到…」。';
  el.dataset.taskId = '';
  el.innerHTML = `
    <article class="detail cat-detail">
      <div class="detail-bar">
        <span class="pill" data-s="category">${category.axis === 'relation' ? '分类' : '手动分类'}</span>
        <span class="grow"></span>
        ${ref?.url ? `<a class="btn sm" href="${esc(ref.url)}" target="_blank" rel="noopener noreferrer">${icon('external', 'sm')}打开原单</a>` : ''}
        <button type="button" class="btn sm" data-cat-action="rename" data-cat="${id}" data-title="${esc(category.title)}">${icon('edit', 'sm')}改名</button>
        <button type="button" class="btn sm" data-cat-action="merge" data-cat="${id}">${icon('merge', 'sm')}合并到…</button>
        <button type="button" class="icon-btn danger" data-cat-action="delete" data-cat="${id}" data-origin="${esc(category.origin)}" title="${category.origin === 'manual' ? '删除分类' : '解散（不再自动归到这里）'}">${icon('trash')}</button>
        ${mode === 'drawer' ? `<button type="button" class="icon-btn" data-action="close-drawer" aria-label="关闭">${icon('x')}</button>` : ''}
      </div>
      <h2>${esc(category.title)}</h2>
      <div class="detail-meta">${refText(category) ? `<span class="tag">${esc(refText(category))}</span>` : ''}<span>${category.origin === 'auto' ? '自动归类' : '手动建的'}</span><span>更新于 ${timeAgo(category.updatedAt)}</span></div>
      <div class="cat-progress">
        <div class="cat-bar"><i style="--p:${pct}%"></i></div>
        <div class="cat-stats">
          <span><b>${roll.done || 0}</b>/${total} 完成</span>
          ${roll.running ? `<span class="is-running"><b>${roll.running}</b> 执行中</span>` : ''}
          ${roll.waiting ? `<span class="is-waiting"><b>${roll.waiting}</b> 等你拍板</span>` : ''}
          ${roll.failed ? `<span class="is-failed"><b>${roll.failed}</b> 失败</span>` : ''}
        </div>
      </div>
      ${category.why?.length ? `<div class="cat-why">${icon('info', 'sm')}<span>为什么在这里：${category.why.slice(0, 4).map(esc).join('；')}${category.why.length > 4 ? ` 等 ${category.why.length} 条` : ''}</span></div>` : ''}

      <section class="dsec">
        <div class="dsec-head"><h4>知识 <em class="count">${(category.knowledge || []).length}</em></h4>
          <button type="button" class="btn xs" data-cls-action="note" data-category="${id}">${icon('plus', 'sm')}记一条</button></div>
        <p class="muted small">分配同类任务时，静静会把确认过的知识附进指令（只用来判断，不影响交给谁做）。</p>
        ${knowledgeHtml(category)}
      </section>

      <section class="dsec">
        <div class="dsec-head"><h4>卡 <em class="count">${category.members.length}</em></h4></div>
        ${category.members.length ? `
          <div class="cat-members">
            ${category.members.map((m) => `
              <button type="button" class="cat-member" data-open-task="${esc(m.taskId)}">
                <span class="sdot" data-s="${esc(m.status)}"></span>
                <span class="cat-member-title">${esc(m.title)}</span>
                <span class="cat-member-meta">${esc(workerLabel(m.worker))}</span>
                <span class="cls-how ${m.pinned ? 'is-pinned' : ''}">${m.state === 'overflow' ? '已满未进组' : m.pinned ? '手动固定' : WHO_LABEL[m.who] || m.who}</span>
              </button>`).join('')}
          </div>` : `<div class="empty-inline">${icon('check')}<span>${emptyText}</span></div>`}
      </section>
    </article>`;
  el.scrollTop = 0;
}

/* ------------------------------ 动作 ------------------------------ */

async function afterTaskChange(data) {
  if (data?.task) {
    upsertTask(data.task);
    changed('tasks');
    hooks.refreshDetail(data.task.id);
  }
  if (data?.categories) {
    state.categories = data.categories;
    changed('categories');
  }
}

function categoryOptions(axisFilter = null, except = null) {
  return (state.categories || [])
    .filter((c) => (!axisFilter || c.axis === axisFilter) && c.id !== except)
    .map((c) => `<option value="${esc(c.id)}">${esc(c.title)}${c.axis === 'relation' ? ` · ${esc(refText(c))}` : ''}</option>`)
    .join('');
}

function assignDialog(taskId) {
  const task = taskById(taskId);
  openDialog({
    title: '归到…',
    desc: `把「${task?.title || '这张卡'}」放进一个分类。手动归入的不会被自动归类改掉。`,
    body: `
      <label class="field"><span>已有分类</span>
        <select name="categoryId"><option value="">— 选一个 —</option>${categoryOptions()}</select></label>
      <div class="or-line"><span>或者</span></div>
      <label class="field"><span>新建分类</span><input name="newTitle" placeholder="比如「本周要盯的」「登录改造」" maxlength="60" /></label>`,
    okText: '归进去',
    onSubmit: async ({ categoryId, newTitle }) => {
      if (newTitle?.trim()) {
        const data = await api('/api/categories', { method: 'POST', body: { title: newTitle.trim(), taskId } });
        state.categories = data.categories;
        changed('categories');
        const fresh = await api(`/api/tasks/${taskId}`);
        await afterTaskChange({ task: fresh.task });
        toast(`已新建「${newTitle.trim()}」并归进去。`);
        return;
      }
      if (!categoryId) throw new Error('选一个分类，或者填一个新名字');
      await afterTaskChange(await api(`/api/tasks/${taskId}/classification`, { method: 'POST', body: { categoryId } }));
      toast('已归入。');
    }
  });
}

function noteDialog(categoryId, taskId = null) {
  const category = categoryById(categoryId);
  openDialog({
    title: '记一条知识',
    desc: `这条会记在「${category?.title || '这个分类'}」下，下次同类任务会参考它。`,
    body: `
      <label class="field"><span>类型</span>
        <select name="kind">
          <option value="note">备注 / 要注意的</option>
          <option value="cause">因果（根因）</option>
          <option value="fix">修复方式</option>
          <option value="symptom">现象</option>
          <option value="decision">决策</option>
        </select></label>
      <label class="field"><span>一句话</span><textarea name="text" rows="3" maxlength="200" placeholder="比如：验证码服务限流会导致登录白屏，先查网关日志"></textarea></label>`,
    okText: '记下',
    onSubmit: async ({ kind, text }) => {
      if (!text?.trim()) throw new Error('写一句话');
      await api(`/api/categories/${categoryId}/knowledge`, { method: 'POST', body: { kind, text: text.trim(), taskId } });
      toast('记下了。');
      refreshCategory();
    }
  });
}

async function taskAction(button) {
  const { clsAction: action, id: taskId, axis = 'relation' } = button.dataset;
  if (action === 'assign') return assignDialog(taskId);
  if (action === 'note') return noteDialog(button.dataset.category, taskId || null);
  if (action === 'unassign') {
    const title = button.dataset.title;
    if (title) {
      const ok = await ask({
        title: `把这张卡移出「${title}」？`,
        message: axis === 'relation' ? '移出后不会再自动归到这里，可以随时手动归回。' : '只是移出这个分类，卡本身不受影响。',
        okText: '移出'
      });
      if (!ok) return;
    }
    await afterTaskChange(await api(`/api/tasks/${taskId}/classification?axis=${axis}`, { method: 'DELETE' }));
    toast(title ? '已移出。' : '好，这张卡不再提示归类。');
    return;
  }
  if (action === 'choose') {
    await afterTaskChange(await api(`/api/tasks/${taskId}/classification`, { method: 'POST', body: { key: button.dataset.key } }));
    toast('已归入。');
    return;
  }
  if (action === 'auto') {
    await afterTaskChange(await api(`/api/tasks/${taskId}/classification/auto?axis=${axis}`, { method: 'POST' }));
    toast('已恢复自动归类。');
    return;
  }
  if (action === 'optout') {
    await afterTaskChange(await api(`/api/tasks/${taskId}/classification/optout?axis=${axis}`, { method: 'POST' }));
    toast('这张卡不再参与自动归类。');
  }
}

async function categoryAction(button) {
  const { catAction: action, cat: id } = button.dataset;
  if (action === 'rename') {
    openDialog({
      title: '改名',
      body: `<label class="field"><span>分类名</span><input name="title" value="${esc(button.dataset.title || '')}" maxlength="60" /></label>`,
      onSubmit: async ({ title }) => {
        const data = await api(`/api/categories/${id}`, { method: 'PATCH', body: { title } });
        state.categories = data.categories;
        changed('categories');
        refreshCategory();
      }
    });
    return;
  }
  if (action === 'merge') {
    const category = categoryById(id);
    const options = categoryOptions(category?.axis || null, id);
    if (!options) return toast('没有可以合并进去的同类分类。');
    openDialog({
      title: '合并到…',
      desc: '这个分类的卡和知识都会搬过去；之后新卡也会自动进目标分类。',
      body: `<label class="field"><span>合并进</span><select name="into">${options}</select></label>`,
      okText: '合并',
      onSubmit: async ({ into }) => {
        const data = await api(`/api/categories/${id}/merge`, { method: 'POST', body: { into } });
        state.categories = data.categories;
        changed('categories', 'tasks');
        openCategory(data.category.id);
        toast('已合并。');
      }
    });
    return;
  }
  if (action === 'delete') {
    const manual = button.dataset.origin === 'manual';
    const ok = await ask({
      title: manual ? '删除这个分类？' : '解散这个分类？',
      message: manual ? '卡不会被删，只是回到未归类。分类里的知识还留着。' : '卡回到未归类，之后也不会再自动归到这里。',
      okText: manual ? '删除' : '解散',
      danger: true
    });
    if (!ok) return;
    const data = await api(`/api/categories/${id}`, { method: 'DELETE' });
    state.categories = data.categories;
    openCategoryId = null;
    changed('categories', 'tasks');
    reloadTasks();
    toast(manual ? '已删除。' : '已解散。');
  }
}

async function knowledgeAction(button) {
  const { knAction: action, kn: id } = button.dataset;
  const patch = {
    confirm: { confirmed: true },
    pin: { pinned: true },
    unpin: { pinned: false },
    hide: { hidden: true },
    show: { hidden: false },
    choose: { choose: true }
  }[action];
  if (patch) {
    await api(`/api/knowledge/${id}`, { method: 'PATCH', body: patch });
    refreshCategory();
    return;
  }
  if (action === 'edit') {
    const text = button.closest('.kn-item')?.querySelector('.kn-text span:last-child')?.textContent || '';
    openDialog({
      title: '改这条知识',
      body: `<label class="field"><span>一句话</span><textarea name="text" rows="3" maxlength="200">${esc(text)}</textarea></label>`,
      onSubmit: async ({ text: next }) => {
        await api(`/api/knowledge/${id}`, { method: 'PATCH', body: { text: next } });
        refreshCategory();
      }
    });
    return;
  }
  if (action === 'delete') {
    if (!(await ask({ title: '删除这条知识？', message: '删除后静静不会再参考它。', okText: '删除', danger: true }))) return;
    await api(`/api/knowledge/${id}`, { method: 'DELETE' });
    refreshCategory();
  }
}

async function reloadTasks() {
  try {
    const data = await api('/api/tasks');
    state.tasks = data.tasks;
    changed('tasks');
  } catch { /* 忽略 */ }
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-task-view], [data-fold-group], [data-open-category], [data-cls-action], [data-cat-action], [data-kn-action], .cat-detail [data-open-task]');
  if (!target) return;
  try {
    if (target.dataset.taskView) {
      state.taskView = target.dataset.taskView;
      store.set(VIEW_KEY, state.taskView);
      hooks.renderList();
    } else if (target.dataset.foldGroup) {
      toggleFold(target.dataset.foldGroup);
    } else if (target.dataset.openCategory) {
      openCategory(target.dataset.openCategory);
    } else if (target.dataset.clsAction) {
      await taskAction(target);
    } else if (target.dataset.catAction) {
      await categoryAction(target);
    } else if (target.dataset.knAction) {
      await knowledgeAction(target);
    } else if (target.dataset.openTask) {
      openCategoryId = null;
      hooks.openTask(target.dataset.openTask);
    }
  } catch (err) {
    toast(err.message);
  }
});

/* ------------------------------ 设置：归类与知识 ------------------------------ */

const STATE_LABEL = { off: '关', observing: '试运行', on: '开启' };

function groupAtOptions(plugin) {
  const labels = plugin.nodeLabels || {};
  const options = [['__default', `默认（${describePolicy(plugin.defaultGroupAt, labels)}）`]];
  for (const type of plugin.nodeTypes || []) options.push([JSON.stringify({ type }), `按${labels[type] || type}归（从卡自己开始找）`]);
  options.push([JSON.stringify({ levels: 1 }), '按直接上级']);
  return options;
}

function describePolicy(policy, labels = {}) {
  if (!policy) return '按直接上级';
  if (policy.type) return `按${labels[policy.type] || policy.type}归`;
  return policy.levels === 1 ? '按直接上级' : `往上 ${policy.levels} 层`;
}

function qualityText(q) {
  if (!q || !q.tasks) return '还没有可归类的卡';
  const parts = [`${q.classified} 张卡 → ${q.categories} 个分类`];
  if (q.ambiguous) parts.push(`${q.ambiguous} 张多关联未归`);
  if (q.singles) parts.push(`${q.singles} 个单成员`);
  if (q.overflow) parts.push(`${q.overflow} 张因分类已满未进组`);
  return parts.join(' · ');
}

export async function renderClassifySettings() {
  const box = $('#classify-plugins');
  if (!box) return;
  let data;
  try {
    data = await api('/api/classification/plugins');
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    return;
  }
  const declared = data.plugins.filter((p) => p.declared);
  const others = data.plugins.filter((p) => !p.declared);
  box.innerHTML = `
    ${declared.map((p) => {
      const current = p.customGroupAt ? JSON.stringify(p.groupAt) : '__default';
      return `
        <div class="cls-plugin" data-state="${esc(p.state)}">
          <div class="cls-plugin-head">
            <div class="cls-plugin-name"><b>${esc(p.label)}</b>${p.source === 'official' ? '<span class="tag xs">官方</span>' : ''}
              <small>已声明：${(p.nodeTypes || []).map((t) => esc(p.nodeLabels?.[t] || t)).join(' / ')}${p.enabled ? '' : ' · 来源已停用'}</small></div>
            <div class="tri" role="radiogroup" aria-label="${esc(p.label)} 的自动归类">
              ${['off', 'observing', 'on'].map((s) => `<button type="button" role="radio" aria-checked="${p.state === s}" class="tri-item ${p.state === s ? 'is-active' : ''}" data-cls-plugin="${esc(p.id)}" data-cls-state="${s}">${STATE_LABEL[s]}</button>`).join('')}
            </div>
          </div>
          ${p.state === 'observing' ? `<div class="cls-plugin-note">${icon('scan', 'sm')}<span>试运行中${p.since ? `（${timeAgo(p.since)}开始）` : ''}：只在后台算，任务列表不变、不写知识。${p.trialReady ? '<b>看起来可以开了。</b>' : ''}</span></div>` : ''}
          ${p.quality?.noNodes ? `<div class="cls-plugin-note is-warn">${icon('alert', 'sm')}<span>声明了归类能力，但最近 20 张卡都没有节点。</span></div>` : ''}
          <div class="cls-plugin-grid">
            <label class="field compact"><span>切层</span>
              <select data-cls-groupat="${esc(p.id)}">${groupAtOptions(p).map(([value, label]) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
            <div class="cls-quality"><span>质量</span><b>${esc(qualityText(p.quality))}</b></div>
          </div>
        </div>`;
    }).join('') || '<p class="muted">还没有声明归类能力的来源。</p>'}
    ${others.length ? `<div class="cls-others">${others.map((p) => `<span class="tag">${esc(p.label)}</span>`).join('')}<small>这些来源没有声明归类能力，只能手动归类。</small></div>` : ''}`;
}

document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-cls-plugin]');
  if (!btn) return;
  const next = btn.dataset.clsState;
  if (next === 'on' && btn.closest('.cls-plugin')?.dataset.state === 'off') {
    const ok = await ask({ title: '直接开启？', message: '建议先「试运行」一天：只在后台算归属，看看效果再决定要不要摆到任务列表上。', okText: '直接开启', cancelText: '先试运行' });
    if (!ok) return setPluginState(btn.dataset.clsPlugin, { state: 'observing' });
  }
  setPluginState(btn.dataset.clsPlugin, { state: next });
});

document.addEventListener('change', (event) => {
  const select = event.target.closest('[data-cls-groupat]');
  if (!select) return;
  setPluginState(select.dataset.clsGroupat, { groupAt: select.value === '__default' ? null : JSON.parse(select.value) });
});

async function setPluginState(id, body) {
  try {
    const data = await api(`/api/classification/plugins/${id}`, { method: 'PATCH', body });
    state.plugins = data.plugins;
    state.categories = data.categories;
    changed('plugins', 'categories');
    if (body.state === 'observing') toast('试运行开始了：会读取关联关系，只在后台算，任务列表不变。');
    else if (body.state === 'on') toast('已开启：任务页可以「按归类」看了。');
    else if (body.state === 'off') toast('已关闭：分类和归属都保留，再打开就恢复。');
    else toast('切层已更新，已重新归类。');
    renderClassifySettings();
    reloadTasks();
  } catch (err) {
    toast(err.message);
  }
}

$('#classify-reconcile')?.addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    const data = await api('/api/classification/reconcile', { method: 'POST', body: {} });
    state.categories = data.categories;
    changed('categories');
    reloadTasks();
    toast(`重新归类了 ${data.routed} 张卡。`);
    renderClassifySettings();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

on('categories', () => {
  hooks.renderList();
});

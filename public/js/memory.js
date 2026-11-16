// 记忆页：业务 / 人格两类，按层筛选、搜索、补充、编辑、删除。
// 人格记忆那一页顶上是静静的「心智」：此刻的心情、认识的人、上次反思。
import { $, $$, state, on, changed, esc, timeAgo, toast, api, LAYER_LABEL, MEMORY_DOMAIN_LABEL } from './core.js';
import { icon, openDialog, ask } from './ui.js';

const DOMAIN_NOTE = {
  work: '业务记忆：你的偏好、项目、做事经验和你们聊过的事。Router 派活、Worker 执行时会用到；会按遗忘曲线慢慢淡忘，常被想起的会记得更牢。',
  persona: '人格记忆：静静自己的设定和自我认知、她认识的人和聊过的事。只在她以自己的身份说话时用，任务和 Worker 看不到。'
};
const KIND_LABEL = { self: '自我认知', diary: '日记', conversation: '聊天', insight: '反思所得', task_result: '任务结果', preference: '偏好', note: '笔记' };

export function enterMemory() {
  renderMemories();
  loadMemories();
}

export async function loadMemories(q = state.memQuery) {
  state.memQuery = q;
  try {
    const params = new URLSearchParams({ domain: state.memDomain });
    if (q) params.set('q', q);
    if (state.memArchived) params.set('archived', '1');
    const data = await api(`/api/memories?${params}`);
    state.memories = data.memories;
    state.memoryStats = data.stats;
    state.memArchivedCount = data.archived || 0;
    if (data.domains) state.memoryDomains = data.domains;
    renderMemories();
  } catch (err) {
    toast(err.message);
  }
}

function personName(id) {
  if (!id) return '';
  if (id === 'owner') return '主人';
  if (id === 'self') return '她自己';
  return (state.mind?.people || []).find((p) => p.id === id)?.name || id.split(':').pop();
}

/** 记得多清楚：一条细进度条；情绪：一个小圆点（暖色开心、冷色难过，越激动越实）。 */
function memoryMarks(m) {
  const r = Math.max(0, Math.min(1, m.retention ?? 1));
  const label = r >= 0.8 ? '清楚' : r >= 0.5 ? '记得' : r >= 0.2 ? '模糊' : '快忘了';
  const feel = Math.abs(m.valence || 0) > 0.15 || (m.arousal || 0) > 0.3
    ? `<span class="feel-dot" data-v="${(m.valence || 0) > 0.15 ? 'pos' : (m.valence || 0) < -0.15 ? 'neg' : 'mid'}" style="opacity:${(0.45 + 0.55 * (m.arousal || 0)).toFixed(2)}" title="${(m.valence || 0) > 0.15 ? '开心' : (m.valence || 0) < -0.15 ? '难过' : '激动'}"></span>`
    : '';
  return `${feel}<span class="ret" title="记得${label}（${Math.round(r * 100)}%）"><i style="width:${Math.round(r * 100)}%"></i></span><span>${label}</span>`;
}

function renderMemories() {
  $$('[data-mem-domain]').forEach((btn) => {
    const domain = btn.dataset.memDomain;
    btn.classList.toggle('is-active', domain === state.memDomain);
    btn.innerHTML = `${MEMORY_DOMAIN_LABEL[domain]}<em>${state.memoryDomains?.[domain] ?? 0}</em>`;
  });
  const note = $('#mem-note');
  if (note) note.textContent = DOMAIN_NOTE[state.memDomain];
  renderMindPanel();

  const counts = {};
  for (const m of state.memories) counts[m.layer] = (counts[m.layer] || 0) + 1;
  const layers = ['profile', 'semantic', 'episodic', 'working'].filter((layer) => counts[layer] || state.memLayer === layer);
  if (state.memLayer && !layers.includes(state.memLayer)) state.memLayer = '';
  const archivedChip = state.memArchived || state.memArchivedCount
    ? `<button type="button" class="fchip ${state.memArchived ? 'is-active' : ''}" data-mem-archived title="快忘光的经历会归档到这里；想起来时会回去">已淡忘<em>${state.memArchived ? state.memories.length : state.memArchivedCount}</em></button>`
    : '';
  $('#mem-layers').innerHTML = state.memArchived
    ? `<button type="button" class="fchip" data-mem-archived>${icon('chevronLeft', 'sm')}回到记得的</button>${archivedChip}`
    : state.memories.length || archivedChip
      ? [`<button type="button" class="fchip ${state.memLayer ? '' : 'is-active'}" data-mem-layer="">全部<em>${state.memories.length}</em></button>`,
        ...layers.map((layer) => `<button type="button" class="fchip ${state.memLayer === layer ? 'is-active' : ''}" data-mem-layer="${layer}">${LAYER_LABEL[layer]}<em>${counts[layer] || 0}</em></button>`),
        archivedChip].join('')
      : '';

  const list = !state.memArchived && state.memLayer ? state.memories.filter((m) => m.layer === state.memLayer) : state.memories;
  if (!list.length) {
    const emptyText = state.memArchived
      ? '没有淡忘的记忆。'
      : state.memQuery
        ? '没有搜到相关的记忆。'
        : state.memDomain === 'persona'
          ? '还没有人格记忆。她在外面和人聊天、每天反思之后，这里会慢慢多起来；也可以手动记一条她的设定。'
          : '还没有记忆。和静静聊几句，或者对她说「记住……」，就会出现在这里。';
    $('#memory-list').innerHTML = `<div class="empty"><div class="empty-mark">忆</div><p>${emptyText}</p></div>`;
    return;
  }
  $('#memory-list').innerHTML = list.map((m) => {
    const about = m.subject && m.subject !== 'owner' && m.subject !== 'self' ? personName(m.subject) : '';
    return `
    <div class="mem-row ${m.archived ? 'is-faded' : ''}">
      <span class="mem-layer" data-layer="${esc(m.layer)}">${esc(LAYER_LABEL[m.layer] || m.layer)}</span>
      <div class="mem-main">
        <div class="mem-text">${esc(m.text)}</div>
        <div class="mem-meta">
          ${KIND_LABEL[m.kind] ? `<span class="mem-tag kind">${esc(KIND_LABEL[m.kind])}</span>` : ''}
          ${about ? `<span class="mem-tag who">关于 ${esc(about)}</span>` : ''}
          ${(m.tags || []).map((t) => `<span class="mem-tag">${esc(t)}</span>`).join('')}
          <span>${timeAgo(m.created_at)}</span>
          <span class="mem-strength">${memoryMarks(m)}</span>
          ${m.use_count ? `<span title="被想起的次数">想起 ${m.use_count} 次</span>` : ''}
        </div>
      </div>
      <div class="row-actions">
        ${m.archived ? `<button type="button" class="btn xs" data-mem-restore="${esc(m.id)}" title="让她重新想起来">想起来</button>` : ''}
        <button type="button" class="icon-btn sm" data-mem-edit="${esc(m.id)}" title="编辑">${icon('edit', 'sm')}</button>
        <button type="button" class="icon-btn sm danger" data-mem-forget="${esc(m.id)}" title="删除">${icon('trash', 'sm')}</button>
      </div>
    </div>`;
  }).join('');
}

/* ------------------------------ 心智面板 ------------------------------ */

function bar(value, label) {
  const v = Math.max(-1, Math.min(1, Number(value) || 0));
  const left = v < 0 ? 50 + v * 50 : 50;
  const width = Math.abs(v) * 50;
  return `<div class="pad-row"><span>${label}</span><div class="pad-track"><i class="${v < 0 ? 'neg' : ''}" style="left:${left}%;width:${width}%"></i></div></div>`;
}

function familiarityText(f) {
  return f >= 0.7 ? '很熟' : f >= 0.4 ? '比较熟' : f >= 0.15 ? '认识' : '不太熟';
}
function affinityText(a) {
  return a >= 0.4 ? '挺喜欢' : a >= 0.12 ? '印象不错' : a <= -0.4 ? '不太喜欢' : a <= -0.12 ? '有点提防' : '一般';
}

function reflectionText(r) {
  if (!r) return '还没反思过';
  if (r.skipped && !r.facts && !r.self && !r.owner) return `${timeAgo(r.at)} · ${r.skipped}`;
  const parts = [];
  if (r.facts || r.owner) parts.push(`记下 ${r.facts + r.owner} 条认识`);
  if (r.self) parts.push(`${r.self} 条自我认知`);
  if (r.impressions) parts.push(`更新 ${r.impressions} 个印象`);
  if (r.faded) parts.push(`淡忘 ${r.faded} 条`);
  if (r.consolidated) parts.push(`${r.consolidated} 段经历变成了事实`);
  if (r.persona?.status === 'applied') parts.push('调整了人设');
  if (r.persona?.status === 'proposed') parts.push('提议调整人设');
  return `${timeAgo(r.at)} · ${parts.join('，') || '没有新的收获'}`;
}

function renderMindPanel() {
  const panel = $('#mind-panel');
  if (!panel) return;
  const mind = state.mind;
  panel.hidden = state.memDomain !== 'persona' || state.memArchived || Boolean(state.memQuery) || !mind;
  if (panel.hidden) return;
  const mood = mind.mood || {};
  const peopleList = mind.people || [];
  const diary = mind.lastReflection?.diary;
  panel.innerHTML = `
    <section class="card mood-card">
      <div class="card-head row">
        <div><h3>她现在</h3><p>${mood.enabled === false ? '心情已在设置里关掉，始终平静。' : '心情随对话和任务变化，几个小时后慢慢回到平常。'}</p></div>
        ${mood.enabled !== false && mood.label !== '平静' ? `<button type="button" class="btn xs ghost" data-mind-calm title="让她的心情回到平常">让她平静下来</button>` : ''}
      </div>
      <div class="mood-now">
        <span class="mood-label" data-mood="${esc(mood.label || '平静')}">${esc(mood.label || '平静')}</span>
        ${mood.cause ? `<small>${esc(mood.cause)}${mood.causeAt ? ` · ${timeAgo(mood.causeAt)}` : ''}</small>` : ''}
      </div>
      <div class="pad">${bar(mood.p, '愉悦')}${bar(mood.a, '激动')}${bar(mood.d, '掌控')}</div>
      <div class="reflect-line">
        <span>上次反思：${esc(reflectionText(mind.lastReflection))}</span>
        <button type="button" class="btn xs" data-mind-reflect>现在反思</button>
      </div>
      ${diary ? `<p class="diary">「${esc(diary)}」</p>` : ''}
    </section>
    <section class="card people-card">
      <div class="card-head"><h3>认识的人</h3><p>来往越多越熟，久不联系会慢慢变淡；印象每天反思时更新。外人看不到你的任何事。</p></div>
      <div class="people-list">
        ${peopleList.length ? peopleList.map((p) => `
          <div class="person">
            <span class="glyph">${esc((p.name || '?').slice(0, 1))}</span>
            <div class="person-main">
              <b>${esc(p.name)}${p.id === 'owner' ? '<span class="badge on">主人</span>' : ''}</b>
              <small>${esc(p.source || (p.id === 'owner' ? '对话' : ''))}${p.source || p.id === 'owner' ? ' · ' : ''}来往 ${p.interactions} 次 · ${timeAgo(p.last_seen)} · ${familiarityText(p.familiarity)} · ${affinityText(p.affinity)}</small>
              <div class="fam"><i style="width:${Math.round(p.familiarity * 100)}%"></i></div>
              ${p.impression ? `<p class="impression">${esc(p.impression)}</p>` : ''}
            </div>
            <div class="row-actions">
              <button type="button" class="icon-btn sm" data-person-edit="${esc(p.id)}" title="改称呼或印象">${icon('edit', 'sm')}</button>
              ${p.id !== 'owner' ? `<button type="button" class="icon-btn sm danger" data-person-forget="${esc(p.id)}" title="忘掉这个人">${icon('trash', 'sm')}</button>` : ''}
            </div>
          </div>`).join('') : '<p class="note">还不认识谁。外面有人私聊或 @ 她、她回了话以后，这里会记下这个人。</p>'}
      </div>
    </section>`;
}

export async function reflectNow(button) {
  if (button) button.disabled = true;
  toast('她在回顾这段时间的经历…', 2000);
  try {
    const data = await api('/api/mind/reflect', { method: 'POST', timeoutMs: 180000 });
    state.mind = data.mind;
    changed('mind', 'memories');
    toast(`反思完了：${reflectionText(data.result).replace(/^[^·]*·\s*/, '')}`, 4200);
    return data.result;
  } catch (err) {
    toast(err.message);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function editPerson(id) {
  const person = (state.mind?.people || []).find((p) => p.id === id);
  if (!person) return;
  openDialog({
    title: `改改「${person.name}」`,
    desc: '称呼和印象都会写进她和这个人说话时的上下文。印象每天反思时也会被她自己更新。',
    body: `
      <label class="field"><span>称呼</span><input name="name" maxlength="40" value="${esc(person.name)}" /></label>
      <label class="field"><span>印象</span><textarea name="impression" rows="3" maxlength="200" placeholder="一句话，比如：爱开玩笑的产品经理">${esc(person.impression || '')}</textarea></label>`,
    okText: '保存',
    onSubmit: async (values) => {
      const data = await api(`/api/people/${encodeURIComponent(id)}`, { method: 'PATCH', body: values });
      state.mind = data.mind;
      changed('mind');
      toast('改好了。');
    }
  });
}

async function forgetPerson(id) {
  const person = (state.mind?.people || []).find((p) => p.id === id);
  const ok = await ask({ title: `忘掉「${person?.name || id}」？`, message: '熟悉度、好感和印象会清掉；和 ta 聊过的记忆还在人格记忆里，需要的话单独删。', okText: '忘掉', danger: true });
  if (!ok) return;
  try {
    state.mind = await api(`/api/people/${encodeURIComponent(id)}`, { method: 'DELETE' });
    changed('mind');
  } catch (err) {
    toast(err.message);
  }
}

/* ------------------------------- 编辑 -------------------------------- */

function memoryDomainField(current) {
  return `<label class="field"><span>归到哪类</span>
    <select name="domain">
      <option value="work" ${current !== 'persona' ? 'selected' : ''}>业务记忆（任务和 Worker 会用到）</option>
      <option value="persona" ${current === 'persona' ? 'selected' : ''}>人格记忆（静静自己的，任务里不出现）</option>
    </select>
  </label>`;
}

function addMemory() {
  openDialog({
    title: '记一条',
    desc: '业务记忆会成为以后 Router 判断和 Worker 执行时的上下文；人格记忆只在静静以自己的身份说话时用。',
    body: `
      <label class="field"><span>内容</span><textarea name="text" rows="4" placeholder="例如：每周三下午要做周报"></textarea></label>
      <div class="grid-2">
        <label class="field"><span>放在哪一层</span>
          <select name="layer">
            <option value="profile">画像（长期偏好，几乎不忘）</option>
            <option value="semantic">语义（事实 / 项目）</option>
            <option value="episodic">情景（发生过的事，会慢慢淡忘）</option>
          </select>
        </label>
        <label class="field"><span>标签（逗号分隔）</span><input name="tags" placeholder="偏好, 时间" /></label>
      </div>
      ${memoryDomainField(state.memDomain)}`,
    okText: '记住',
    onSubmit: async ({ text, layer, tags, domain }) => {
      if (!text.trim()) throw new Error('内容不能为空');
      await api('/api/memories', {
        method: 'POST',
        body: { text: text.trim(), layer, domain, tags: tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }
      });
      await loadMemories();
      toast('记住了。');
    }
  });
}

function editMemory(id) {
  const item = state.memories.find((m) => m.id === id);
  if (!item) return;
  openDialog({
    title: '编辑记忆',
    desc: '改完立即生效。改成人格记忆后，任务和 Worker 就看不到它了。',
    body: `
      <label class="field"><span>内容</span><textarea name="text" rows="4">${esc(item.text)}</textarea></label>
      <div class="grid-2">
        <label class="field"><span>层级</span>
          <select name="layer">
            ${['profile', 'semantic', 'episodic', 'working'].map((l) => `<option value="${l}" ${item.layer === l ? 'selected' : ''}>${LAYER_LABEL[l]}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>重要度（0–1）</span><input name="importance" type="number" min="0" max="1" step="0.05" value="${esc(item.importance)}" /></label>
      </div>
      ${memoryDomainField(item.domain)}`,
    okText: '保存',
    onSubmit: async (values) => {
      await api(`/api/memories/${id}`, {
        method: 'PATCH',
        body: { text: values.text, layer: values.layer, domain: values.domain, importance: Number(values.importance) }
      });
      await loadMemories();
      toast('记忆已更新。');
    }
  });
}

async function forgetMemory(id) {
  const item = state.memories.find((m) => m.id === id);
  const ok = await ask({ title: '删掉这条记忆？', message: item ? `「${item.text.slice(0, 60)}${item.text.length > 60 ? '…' : ''}」\n\n只是不想让她常想起的话，可以等它自己淡忘。` : '', okText: '删除', danger: true });
  if (!ok) return;
  try {
    await api(`/api/memories/${id}`, { method: 'DELETE' });
    state.memories = state.memories.filter((m) => m.id !== id);
    renderMemories();
    loadMemories();
    toast('删掉了。');
  } catch (err) {
    toast(err.message);
  }
}

async function restoreMemory(id) {
  try {
    await api(`/api/memories/${id}`, { method: 'PATCH', body: { archived: false } });
    await loadMemories();
    toast('她又想起来了。');
  } catch (err) {
    toast(err.message);
  }
}

$('#mem-domains')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-mem-domain]');
  if (!btn || btn.dataset.memDomain === state.memDomain) return;
  state.memDomain = btn.dataset.memDomain;
  state.memLayer = '';
  state.memArchived = false;
  loadMemories();
});

$('#mem-layers')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-mem-archived]')) {
    state.memArchived = !state.memArchived;
    state.memLayer = '';
    loadMemories();
    return;
  }
  const chip = event.target.closest('[data-mem-layer]');
  if (!chip) return;
  state.memLayer = chip.dataset.memLayer;
  renderMemories();
});

$('#memory-list')?.addEventListener('click', (event) => {
  const edit = event.target.closest('[data-mem-edit]');
  if (edit) { editMemory(edit.dataset.memEdit); return; }
  const forget = event.target.closest('[data-mem-forget]');
  if (forget) { forgetMemory(forget.dataset.memForget); return; }
  const restore = event.target.closest('[data-mem-restore]');
  if (restore) restoreMemory(restore.dataset.memRestore);
});

$('#mind-panel')?.addEventListener('click', async (event) => {
  const reflect = event.target.closest('[data-mind-reflect]');
  if (reflect) { reflectNow(reflect); return; }
  if (event.target.closest('[data-mind-calm]')) {
    try {
      state.mind = await api('/api/mind/mood/reset', { method: 'POST' });
      changed('mind');
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const edit = event.target.closest('[data-person-edit]');
  if (edit) { editPerson(edit.dataset.personEdit); return; }
  const forget = event.target.closest('[data-person-forget]');
  if (forget) forgetPerson(forget.dataset.personForget);
});

let memTimer = null;
$('#mem-search')?.addEventListener('input', (event) => {
  clearTimeout(memTimer);
  memTimer = setTimeout(() => loadMemories(event.target.value.trim()), 260);
});

$('#add-memory-btn')?.addEventListener('click', addMemory);

on('memories', () => { if (state.view === 'memory') loadMemories(); });
on('mind', () => { if (state.view === 'memory') renderMindPanel(); });

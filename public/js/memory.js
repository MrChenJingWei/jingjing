// 记忆页：业务 / 人格两类，按层筛选、搜索、补充、编辑、删除。
// 人格记忆那一页顶上是静静的「心智」：此刻的心情、认识的人、上次反思。
import { $, $$, state, on, changed, esc, timeAgo, toast, api, LAYER_LABEL, MEMORY_DOMAIN_LABEL } from './core.js';
import { icon, openDialog, ask, catMark } from './ui.js';

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

/** 记得多清楚：四格小信号（不用颜色）；情绪用字说，不用圆点。 */
function memoryMarks(m) {
  const r = Math.max(0, Math.min(1, m.retention ?? 1));
  const level = r >= 0.8 ? 4 : r >= 0.5 ? 3 : r >= 0.2 ? 2 : 1;
  const label = ['', '快忘了', '模糊', '记得', '记得清楚'][level];
  const v = m.valence || 0;
  const feel = Math.abs(v) > 0.15 || (m.arousal || 0) > 0.3 ? (v > 0.15 ? '开心' : v < -0.15 ? '难过' : '激动') : '';
  return `<span class="mem-meter" data-level="${level}" title="${label}（${Math.round(r * 100)}%）"><i></i><i></i><i></i><i></i></span><span>${label}</span>${feel ? `<span class="mem-feel">${feel}</span>` : ''}`;
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
    ? `<button type="button" class="stab ${state.memArchived ? 'is-active' : ''}" data-mem-archived title="快忘光的经历会归档到这里；想起来时会回去">已淡忘<em>${state.memArchived ? state.memories.length : state.memArchivedCount}</em></button>`
    : '';
  $('#mem-layers').innerHTML = state.memArchived
    ? `<button type="button" class="stab" data-mem-archived>${icon('chevronLeft', 'sm')}回到记得的</button>${archivedChip}`
    : state.memories.length || archivedChip
      ? [`<button type="button" class="stab ${state.memLayer ? '' : 'is-active'}" data-mem-layer="">全部<em>${state.memories.length}</em></button>`,
        ...layers.map((layer) => `<button type="button" class="stab ${state.memLayer === layer ? 'is-active' : ''}" data-mem-layer="${layer}">${LAYER_LABEL[layer]}<em>${counts[layer] || 0}</em></button>`),
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
    $('#memory-list').innerHTML = `<div class="empty"><div class="empty-mark">${catMark({ sleeping: false })}</div><p>${emptyText}</p></div>`;
    return;
  }
  $('#memory-list').innerHTML = list.map((m) => {
    const about = m.subject && m.subject !== 'owner' && m.subject !== 'self' ? personName(m.subject) : '';
    const tags = [
      KIND_LABEL[m.kind] ? `<span class="mem-tag">${esc(KIND_LABEL[m.kind])}</span>` : '',
      m.superseded_by ? '<span class="mem-tag" title="后来有新的说法，这条归档了；内容没删，可以点「想起来」恢复">已被新说法替代</span>' : '',
      about ? `<span class="mem-tag">关于 ${esc(about)}</span>` : '',
      ...(m.tags || []).map((t) => `<span class="mem-tag">#${esc(t)}</span>`)
    ].join('');
    return `
    <article class="mem-card ${m.archived ? 'is-faded' : ''} ${m.text.length > 140 ? 'is-long' : ''}" data-layer="${esc(m.layer)}">
      <header class="mem-card-head">
        <span class="mem-layer" data-layer="${esc(m.layer)}">${esc(LAYER_LABEL[m.layer] || m.layer)}</span>
        <span class="grow"></span>
        <span class="mem-actions">
          ${m.archived ? `<button type="button" class="btn xs" data-mem-restore="${esc(m.id)}" title="让她重新想起来">想起来</button>` : ''}
          <button type="button" class="icon-btn xs" data-mem-edit="${esc(m.id)}" title="编辑">${icon('edit', 'sm')}</button>
          <button type="button" class="icon-btn xs danger" data-mem-forget="${esc(m.id)}" title="删除">${icon('trash', 'sm')}</button>
        </span>
      </header>
      <p class="mem-text" data-mem-expand>${esc(m.text)}</p>
      ${tags ? `<div class="mem-tags">${tags}</div>` : ''}
      <footer class="mem-foot">
        <span class="mem-strength">${memoryMarks(m)}</span>
        <span class="grow"></span>
        ${m.use_count ? `<span title="被想起的次数">想起 ${m.use_count} 次</span>` : ''}
        <span>${timeAgo(m.created_at)}</span>
      </footer>
    </article>`;
  }).join('');
  applyGraphMode();
}

/* ------------------------------ 图谱 ------------------------------ */

const GRAPH_LAYER = { profile: '#c9a227', semantic: '#6a8cff', episodic: '#3fa9c4', working: '#9c99b3' };
const GRAPH_ENTITY = { workspace: '#8f7fe0', category: '#d9668f', person: '#3fa9c4', tool: '#c97a1e', file: '#5a9e6f' };
const GRAPH_EDGE = { same_topic: '#b9b4d6', similar: '#6a8cff', same_task: '#3fa9c4', before: '#5a9e6f', conflict: '#d9668f', supersedes: '#c97a1e' };
const GRAPH_SHORT = (text, n) => (String(text || '').length > n ? `${String(text).slice(0, n)}…` : String(text || ''));

/** 切到图谱时藏起列表，回来再显示。 */
function applyGraphMode() {
  const on = Boolean(state.memGraph);
  const list = $('#memory-list');
  const layers = $('#mem-layers');
  const box = $('#memory-graph');
  const search = $('#mem-search')?.closest('.search');
  const btn = $('#mem-graph-btn');
  if (list) list.hidden = on;
  if (layers) layers.hidden = on;
  if (search) search.hidden = on;
  if (box) box.hidden = !on;
  if (btn) btn.classList.toggle('is-active', on);
  if (!on) return;
  const mind = $('#mind-panel');
  if (mind) mind.hidden = true;
  loadGraph();
}

async function loadGraph() {
  const box = $('#memory-graph');
  if (!box) return;
  const domain = state.memDomain;
  box.innerHTML = '<p class="note">正在把记忆连成一张网…</p>';
  try {
    const data = await api(`/api/memories/graph?domain=${encodeURIComponent(domain)}&limit=120`);
    if (!state.memGraph || state.memDomain !== domain) return;
    renderGraph(box, data.graph || { nodes: [], links: [] });
  } catch (err) {
    box.innerHTML = `<p class="note">${esc(err.message)}</p>`;
  }
}

/** 放射状布局：实体在外圈，记忆在内圈；不追求物理精确，先让人看出"谁和谁连着"。 */
function renderGraph(box, graph) {
  const memories = graph.nodes.filter((node) => node.type === 'memory');
  const entities = graph.nodes.filter((node) => node.type === 'entity');
  if (!memories.length) {
    box.innerHTML = '<p class="note">这个域还没有能画出来的记忆。</p>';
    return;
  }
  const W = 1000;
  const H = 680;
  const cx = W / 2;
  const cy = H / 2;
  const pos = new Map();
  const entityCount = entities.length || 1;
  entities.forEach((entity, i) => {
    const angle = (i / entityCount) * Math.PI * 2 - Math.PI / 2;
    pos.set(entity.id, { x: cx + Math.cos(angle) * 330, y: cy + Math.sin(angle) * 300 });
  });
  memories.forEach((item, i) => {
    const angle = i * 2.399963;
    const radius = 40 + 215 * Math.sqrt((i + 1) / memories.length);
    pos.set(item.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius * 0.92 });
  });

  const lines = graph.links.map((link) => {
    const a = pos.get(link.source);
    const b = pos.get(link.target);
    if (!a || !b) return '';
    if (link.kind === 'ref') {
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" class="mg-ref" />`;
    }
    const color = GRAPH_EDGE[link.kind] || '#b9b4d6';
    const width = (1 + Math.min(2, Number(link.weight) || 0.5)).toFixed(1);
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${color}" stroke-width="${width}" opacity=".7" />`;
  }).join('');

  const entityNodes = entities.map((entity) => {
    const p = pos.get(entity.id);
    const color = GRAPH_ENTITY[entity.entityKind] || '#9c99b3';
    return `<g class="mg-node" data-graph-node="${esc(entity.id)}">
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="${color}" />
      <text x="${(p.x + 8).toFixed(1)}" y="${(p.y + 3).toFixed(1)}">${esc(GRAPH_SHORT(entity.title, 14))}</text>
    </g>`;
  }).join('');

  const memoryNodes = memories.map((item) => {
    const p = pos.get(item.id);
    const color = GRAPH_LAYER[item.layer] || '#9c99b3';
    const r = (3 + (Number(item.importance) || 0.5) * 4).toFixed(1);
    return `<g class="mg-node" data-graph-node="${esc(item.id)}">
      <title>${esc(item.text || item.title)}</title>
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${color}" />
    </g>`;
  }).join('');

  box.innerHTML = `
    <div class="mg-head">
      <span>${memories.length} 条记忆 · ${entities.length} 个触达点</span>
      <span>实线：记忆之间的边（相似 / 同一次 / 先后 / 冲突）· 虚线：挂的项目、人、工具、文件</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="记忆关系图">${lines}${entityNodes}${memoryNodes}</svg>
    <div class="mg-info" id="mem-graph-info">点一个点，看看它和什么连着。</div>`;
  box.onclick = (event) => {
    const hit = event.target.closest('[data-graph-node]');
    if (!hit) return;
    const id = hit.dataset.graphNode;
    const node = graph.nodes.find((item) => item.id === id);
    const info = box.querySelector('#mem-graph-info');
    if (!node || !info) return;
    const related = graph.links
      .filter((link) => link.source === id || link.target === id)
      .map((link) => graph.nodes.find((item) => item.id === (link.source === id ? link.target : link.source))?.title)
      .filter(Boolean);
    info.textContent = `${node.text || node.title}${related.length ? ` · 连着：${related.slice(0, 8).join('、')}` : ' · 还没有连线'}`;
  };
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
  const suggestions = mind.peopleSuggestions || [];
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
      <div class="card-head"><h3>认识的人</h3><p>来往越多越熟，久不联系会慢慢变淡；印象每天反思时更新，来源有通讯录的每天查一次姓名和部门。外人看不到你的任何事。</p></div>
      ${suggestions.map((s) => `
        <div class="person-merge-hint">
          <span>「${esc(s.keep.name)}」（${esc(sourceTag(s.keep))}）和「${esc(s.other.name)}」（${esc(sourceTag(s.other))}）可能是同一个人</span>
          <span class="actions">
            <button type="button" class="btn xs" data-person-merge-pair="${esc(s.keep.id)}" data-from="${esc(s.other.id)}">合并</button>
            <button type="button" class="btn xs ghost" data-person-distinct="${esc(s.keep.id)}" data-other="${esc(s.other.id)}">不是</button>
          </span>
        </div>`).join('')}
      <div class="people-list">
        ${peopleList.length ? peopleList.map((p) => `
          <div class="person">
            <span class="glyph">${esc((p.name || '?').slice(0, 1))}</span>
            <div class="person-main">
              <b>${esc(p.name)}${p.id === 'owner' ? '<span class="badge on">主人</span>' : ''}</b>
              ${p.profile && (p.profile.department || p.profile.title) ? `<small>${esc([p.profile.department, p.profile.title].filter(Boolean).join(' · '))}</small>` : ''}
              ${p.requested ? `<small>派过 ${p.requested} 个活</small>` : ''}
              ${identitiesHtml(p, { compact: true })}
              <small>${esc(p.source || (p.id === 'owner' ? '对话' : ''))}${p.source || p.id === 'owner' ? ' · ' : ''}来往 ${p.interactions} 次 · ${timeAgo(p.last_seen)} · ${familiarityText(p.familiarity)} · ${affinityText(p.affinity)}</small>
              <div class="fam"><i style="width:${Math.round(p.familiarity * 100)}%"></i></div>
              ${p.impression ? `<p class="impression">${esc(p.impression)}</p>` : ''}
            </div>
            <div class="row-actions">
              <button type="button" class="icon-btn sm" data-person-edit="${esc(p.id)}" title="改称呼或印象">${icon('edit', 'sm')}</button>
              ${p.id !== 'owner' && peopleList.length > 2 ? `<button type="button" class="icon-btn sm" data-person-merge="${esc(p.id)}" title="和另一个人合并（同一个人在不同来源）">${icon('merge', 'sm')}</button>` : ''}
              ${p.id !== 'owner' ? `<button type="button" class="icon-btn sm danger" data-person-forget="${esc(p.id)}" title="忘掉这个人">${icon('trash', 'sm')}</button>` : ''}
            </div>
          </div>`).join('') : '<p class="note">还不认识谁。外面有人私聊、@ 她或者通过来源找她办事，这里会记下这个人。</p>'}
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

/* ------------------------------ 身份与绑定 ------------------------------ */

// 称呼是从哪来的：后面的盖前面的，主人改的谁都盖不过。
const NAME_FROM_LABEL = { id: '来源里的 id', source: '来源给的', chat: '聊天里 ta 自己说的', directory: '通讯录', manual: '你改的' };

/** 「企微 · zhangsan」：来源名 + 来源里的 id，同名的人靠它分清。 */
function sourceTag(x) {
  const ext = x.externalId ?? x.id?.split(':').slice(1).join(':');
  return [x.source || '外部', ext].filter(Boolean).join(' · ');
}

const boundNote = (x) => [x.boundAt ? `${timeAgo(x.boundAt)}绑定` : '已绑定', x.name ? `那边叫「${x.name}」` : ''].filter(Boolean).join(' · ');
const identityTitle = (x) => (x.primary ? x.id : `${x.id}\n${boundNote(x)}`);

const findPerson = (id) => (state.mind?.people || []).find((p) => p.id === id);

/**
 * 这个人的身份：自己那个 + 绑进来的，每个都带来源和来源里的 id；绑进来的可以解绑。
 * compact：列表里的一行小标签；否则是编辑框里的一张小表。
 */
function identitiesHtml(p, { compact = false } = {}) {
  const ids = p.identities || [];
  if (!ids.length) return '';
  const unbind = (x) => `<button type="button" class="pid-unbind" data-person-unbind="${esc(p.id)}" data-alias="${esc(x.id)}" title="解绑：拆回成单独的一个人" aria-label="解绑 ${esc(sourceTag(x))}">${icon('x', 'sm')}</button>`;
  if (compact) {
    return `<div class="pids">${ids.map((x) => `
      <span class="pid${x.primary ? '' : ' bound'}" title="${esc(identityTitle(x))}">
        ${x.primary ? '' : icon('link', 'sm')}<em>${esc(x.source || '外部')}</em><code>${esc(x.externalId)}</code>${x.primary || ids.length < 2 ? '' : unbind(x)}
      </span>`).join('')}</div>`;
  }
  return `<div class="pid-table" data-identities>
    ${ids.map((x) => `
      <div class="pid-row">
        <span class="pid-src">${esc(x.source || '外部')}</span>
        <code title="${esc(x.id)}">${esc(x.externalId)}</code>
        <span class="pid-note">${x.primary ? (ids.length > 1 ? '主身份' : '') : esc(boundNote(x))}</span>
        ${x.primary ? '' : `<button type="button" class="btn xs ghost" data-person-unbind="${esc(p.id)}" data-alias="${esc(x.id)}">解绑</button>`}
      </div>`).join('')}
  </div>`;
}

function nameHint(person) {
  if (person.id === 'owner') return '主人的称呼跟着设置里的「你的称呼」走，要改去设置里改。';
  if (person.name_from === 'manual') return '这是你改的称呼，来源和通讯录不会再覆盖它。';
  const from = NAME_FROM_LABEL[person.name_from || 'id'] || '来源';
  return `现在的称呼来自：${from}。改了之后以你的为准，来源和通讯录不会再覆盖。`;
}

function editPerson(id) {
  const person = findPerson(id);
  if (!person) return;
  const owner = person.id === 'owner';
  const bound = (person.identities || []).length > 1;
  openDialog({
    title: `改改「${person.name}」`,
    desc: '称呼和印象都会写进她和这个人说话时的上下文。印象每天反思时也会被她自己更新。',
    body: `
      ${owner ? '' : `<div class="field"><span>${bound ? `身份（绑定了 ${person.identities.length} 个，都算这一个人）` : '身份'}</span>${identitiesHtml(person)}
        <small>${bound ? '从这些来源来的都认成 ta。绑错了点「解绑」，那个身份会拆回成单独的一个人。' : '来源名 · ta 在那个来源里的 id。同一个人在别的来源也出现时，可以用「合并」绑到一起。'}</small></div>`}
      <label class="field"><span>称呼</span><input name="name" maxlength="40" value="${esc(person.name)}" ${owner ? 'readonly' : ''} />
        <small data-name-hint>${esc(nameHint(person))}</small></label>
      ${!owner && person.name_from === 'manual' ? `<label class="switch-row"><span><b>交还给自动</b><small>不再锁定你改的称呼，下次来源或通讯录给出称呼时用它们的（称呼框没改时才生效）。</small></span><input type="checkbox" class="switch" name="auto" /></label>` : ''}
      <label class="field"><span>印象</span><textarea name="impression" rows="3" maxlength="200" placeholder="一句话，比如：爱开玩笑的产品经理">${esc(person.impression || '')}</textarea></label>`,
    okText: '保存',
    onSubmit: async (values) => {
      const body = { impression: values.impression };
      if (!owner) body.name = values.name;
      if (values.auto) body.auto = true;
      const nameChanged = !owner && values.name.trim() && values.name.trim() !== person.name;
      const data = await api(`/api/people/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      state.mind = data.mind;
      changed('mind');
      toast(nameChanged ? `改好了：以后叫 ta「${data.person.name}」。` : values.auto ? '称呼交还给自动了，下次通讯录或来源更新时会换上。' : '改好了。');
    }
  });
  // 打字时提示一下会发生什么。
  const input = $('#dialog-body input[name="name"]');
  input?.addEventListener('input', () => {
    const hint = $('#dialog-body [data-name-hint]');
    const next = input.value.trim();
    if (!hint || owner) return;
    hint.textContent = !next ? '称呼不能是空的，留空就不改。' : next === person.name ? nameHint(person) : `保存后叫 ta「${next}」，来源和通讯录不会再覆盖。`;
  });
}

async function unbindIdentity(personId, aliasId) {
  const person = findPerson(personId);
  const alias = person?.identities?.find((x) => x.id === aliasId);
  if (!person || !alias) return;
  const carried = (alias.carries || []).map((id) => person.identities.find((x) => x.id === id)).filter(Boolean);
  const who = alias.name ? `「${alias.name}」` : 'ta';
  const ok = await ask({
    title: `把「${sourceTag(alias)}」从「${person.name}」身上解绑？`,
    message: [
      `解绑后这个身份变回单独的一个人${alias.name ? `（叫「${alias.name}」）` : ''}，以后从${alias.source || '那个来源'}来的不再算到「${person.name}」头上，也不会再提示把他们合并。`,
      alias.restorable
        ? `合并前${who}的来往、熟悉度、印象、认识的时间，和当时并过来的聊天、记忆、派过的活都会还给${who}；合并之后新来的分不清是谁的，留在「${person.name}」这里。`
        : `这个身份是在旧版本里绑定的，当时没记下合并前的情况：${who}会从头开始，已经并到一起的聊天、记忆和派过的活都留在「${person.name}」这里。`,
      carried.length ? `跟着${who}一起绑进来的 ${carried.map((x) => `「${sourceTag(x)}」`).join('、')} 也会一起解绑。` : ''
    ].filter(Boolean).join('\n\n'),
    okText: '解绑'
  });
  if (!ok) return;
  try {
    const data = await api(`/api/people/${encodeURIComponent(personId)}/unbind`, { method: 'POST', body: { alias: aliasId } });
    state.mind = data.mind;
    changed('mind');
    // 编辑框开着时就地刷新身份那一块。
    const table = $('#dialog-body [data-identities]');
    const fresh = findPerson(personId);
    if (table && fresh) table.outerHTML = identitiesHtml(fresh);
    toast(`解绑了：「${data.restored?.name || sourceTag(alias)}」现在是单独的一个人${data.full ? '，合并前的记录都还给 ta 了' : ''}。`);
  } catch (err) {
    toast(err.message);
  }
}

async function forgetPerson(id) {
  const person = (state.mind?.people || []).find((p) => p.id === id);
  const ok = await ask({ title: `忘掉「${person?.name || id}」？`, message: '熟悉度、好感、印象、和 ta 的聊天、关于 ta 的记忆都会删掉，合并过的身份也一起忘掉。ta 派过的任务还在，只是不再记是谁派的。以后 ta 再来就是新认识的人。', okText: '忘掉', danger: true });
  if (!ok) return;
  try {
    state.mind = await api(`/api/people/${encodeURIComponent(id)}`, { method: 'DELETE' });
    changed('mind');
  } catch (err) {
    toast(err.message);
  }
}

function mergePerson(id) {
  const all = state.mind?.people || [];
  const person = all.find((p) => p.id === id);
  const others = all.filter((p) => p.id !== id && p.id !== 'owner');
  if (!person || !others.length) return;
  openDialog({
    title: `把谁并进「${person.name}」？`,
    desc: '同一个人在不同来源（企微、TAPD、邮件……）会被当成几个人。合并后来往、聊天、记忆、派过的活都算到一起，以后从那个来源来的也认成 ta。',
    body: `
      <label class="field"><span>并进来的人</span>
        <select name="from">${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}（${esc((p.identities || [{ id: p.id, source: p.source }]).map(sourceTag).join('，'))}）</option>`).join('')}</select>
      </label>
      ${(person.identities || []).length > 1 ? `<div class="field"><span>「${esc(person.name)}」已经绑定的身份</span>${identitiesHtml(person)}</div>` : ''}`,
    okText: '合并',
    onSubmit: async (values) => {
      await doMerge(id, values.from);
    }
  });
}

async function doMerge(id, from) {
  const data = await api(`/api/people/${encodeURIComponent(id)}/merge`, { method: 'POST', body: { from } });
  state.mind = data.mind;
  changed('mind');
  toast(`合并好了：现在都是「${data.person.name}」。`);
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

$('#mem-graph-btn')?.addEventListener('click', () => {
  state.memGraph = !state.memGraph;
  renderMemories();
});

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
  if (restore) { restoreMemory(restore.dataset.memRestore); return; }
  // 长记忆默认折起来，点正文展开 / 收起。
  const text = event.target.closest('[data-mem-expand]');
  if (text && !window.getSelection()?.toString()) text.closest('.mem-card')?.classList.toggle('is-open');
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
  if (forget) { forgetPerson(forget.dataset.personForget); return; }
  const merge = event.target.closest('[data-person-merge]');
  if (merge) { mergePerson(merge.dataset.personMerge); return; }
  const unbind = event.target.closest('[data-person-unbind]');
  if (unbind) { unbindIdentity(unbind.dataset.personUnbind, unbind.dataset.alias); return; }
  const pair = event.target.closest('[data-person-merge-pair]');
  if (pair) {
    pair.disabled = true;
    doMerge(pair.dataset.personMergePair, pair.dataset.from).catch((err) => { toast(err.message); pair.disabled = false; });
    return;
  }
  const distinct = event.target.closest('[data-person-distinct]');
  if (distinct) {
    api('/api/people/distinct', { method: 'POST', body: { a: distinct.dataset.personDistinct, b: distinct.dataset.other } })
      .then((mind) => { state.mind = mind; changed('mind'); })
      .catch((err) => toast(err.message));
  }
});

// 编辑 / 合并框里的「解绑」。
$('#dialog-body')?.addEventListener('click', (event) => {
  const unbind = event.target.closest('[data-person-unbind]');
  if (unbind) unbindIdentity(unbind.dataset.personUnbind, unbind.dataset.alias);
});

let memTimer = null;
$('#mem-search')?.addEventListener('input', (event) => {
  clearTimeout(memTimer);
  memTimer = setTimeout(() => loadMemories(event.target.value.trim()), 260);
});

$('#add-memory-btn')?.addEventListener('click', addMemory);

on('memories', () => { if (state.view === 'memory') loadMemories(); });
on('mind', () => { if (state.view === 'memory') renderMindPanel(); });

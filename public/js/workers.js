// 设置 → Worker：执行器列表、兜底 Worker、分配规则。所有操作即时生效。
import { $, state, changed, esc, toast, api, uploadPlugin, workerLabel, workerIds, ABILITY_LABEL } from './core.js';
import { icon, openDialog, ask } from './ui.js';

const WORKER_LIMIT_FIELDS = [
  { key: 'timeoutMinutes', label: '超时（分钟）', min: 1, max: 1440, help: '超过这个时长自动停止，且不自动重试' },
  { key: 'concurrency', label: '最多同时运行', min: 1, max: 4, help: '同时还受全局并发上限约束' },
  { key: 'retries', label: '失败自动重试次数', min: 0, max: 3, help: '编码类 Agent 建议保持 0，避免重复花费' }
];
const ORIGIN = { builtin: '内置', official: '官方插件', user: '我的插件' };

export function renderWorkerPage() {
  renderCapabilities();
  renderFallbackSelect();
  renderWorkerList();
  renderWorkerRules();
}

/* ------------------------------ 本机能力 ------------------------------- */
// 内置能力在 src/capabilities.json；自定义的存在 settings.capabilities，和内置目录合并后给 Worker 勾选、给路由匹配。

const RISK_LABEL = { read: '只读', write: '会改东西', deploy: '会发布 / 上线' };

function customCapabilities() {
  return (state.settings?.capabilities || []).filter(Boolean);
}

function capabilityUsers(id) {
  return Object.entries(state.workers || {}).filter(([, w]) => (w.capabilities || []).includes(id)).map(([wid, w]) => w.label || wid);
}

function renderCapabilities() {
  const box = $('#capability-list');
  if (!box) return;
  const catalog = state.capabilities || [];
  const custom = catalog.filter((item) => item.custom);
  const builtin = catalog.filter((item) => !item.custom);
  const chip = (item) => {
    const users = capabilityUsers(item.id);
    return `
      <div class="cap-chip ${item.custom ? 'is-custom' : ''}" title="${esc([item.description, item.keywords?.length ? `触发词：${item.keywords.join('、')}` : ''].filter(Boolean).join('\n'))}">
        <span class="cap-chip-main"><b>${esc(item.label)}</b><small>${users.length ? `${esc(users.join('、'))} 能用` : '还没有 Worker 勾它'}${item.hostTool ? ' · 需本机命令行' : ''}</small></span>
        ${item.custom ? `<button type="button" class="icon-btn xs" data-cap-edit="${esc(item.id)}" title="改">${icon('edit', 'sm')}</button>
          <button type="button" class="icon-btn xs danger" data-cap-remove="${esc(item.id)}" title="删除">${icon('trash', 'sm')}</button>` : ''}
      </div>`;
  };
  box.innerHTML = `
    ${custom.length ? `<div class="cap-group"><div class="cap-group-title">自定义</div><div class="cap-grid">${custom.map(chip).join('')}</div></div>` : ''}
    <div class="cap-group"><div class="cap-group-title">内置</div><div class="cap-grid">${builtin.map(chip).join('')}</div></div>`;
}

async function saveCapabilities(list) {
  const data = await api('/api/settings', { method: 'PUT', body: { capabilities: list } });
  state.settings = data.settings;
  if (data.workers) state.workers = data.workers;
  if (data.capabilities) state.capabilities = data.capabilities;
  changed('settings', 'workers');
  renderCapabilities();
}

function capabilityDialog(existing = null) {
  openDialog({
    title: existing ? `改「${existing.label}」` : '添加本机能力',
    desc: '告诉静静这台电脑还能做什么。加完到对应 Worker 的「配置」里勾上，派活时提到触发词就会优先交给它。',
    body: `
      <label class="field"><span>名称</span><input name="label" maxlength="40" value="${esc(existing?.label || '')}" placeholder="比如：公司发布系统" /></label>
      <label class="field"><span>触发词 <small class="field-help">逗号分隔，对话或来源里出现这些词时会想到这项能力</small></span>
        <input name="keywords" value="${esc((existing?.keywords || []).join(', '))}" placeholder="发版, release, 上线单" /></label>
      <label class="field"><span>说明（可选）</span><input name="description" maxlength="200" value="${esc(existing?.description || '')}" placeholder="比如：用 relctl 提交上线单" /></label>
      <label class="field"><span>风险</span>
        <select name="risk">${Object.entries(RISK_LABEL).map(([value, label]) => `<option value="${value}" ${(existing?.risk || 'write') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="switch-row"><span><b>需要本机命令行</b><small>没有 Worker 勾它时，能执行本机命令的 Worker 也算候选</small></span>
        <input type="checkbox" class="switch" name="hostTool" ${existing?.hostTool ? 'checked' : ''} /></label>`,
    okText: existing ? '保存' : '添加',
    onSubmit: async ({ label, keywords, description, risk, hostTool }) => {
      const name = label.trim();
      if (!name) throw new Error('写个名称');
      const words = keywords.split(/[,，、\n]/).map((word) => word.trim()).filter(Boolean);
      const item = {
        id: existing?.id || `c-${Date.now().toString(36)}`,
        label: name,
        keywords: words.length ? words : [name],
        description: description.trim(),
        risk,
        hostTool: Boolean(hostTool)
      };
      const list = customCapabilities().filter((cap) => cap.id !== item.id);
      await saveCapabilities(existing ? customCapabilities().map((cap) => (cap.id === item.id ? item : cap)) : [...list, item]);
      toast(existing ? '已保存。' : `加好了。去对应 Worker 的「配置」里勾上「${name}」。`, 3200);
    }
  });
}

$('#add-capability')?.addEventListener('click', () => capabilityDialog());
$('#capability-list')?.addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-cap-edit]');
  if (edit) {
    capabilityDialog(customCapabilities().find((cap) => cap.id === edit.dataset.capEdit));
    return;
  }
  const remove = event.target.closest('[data-cap-remove]');
  if (!remove) return;
  const cap = customCapabilities().find((item) => item.id === remove.dataset.capRemove);
  const users = capabilityUsers(remove.dataset.capRemove);
  const ok = await ask({ title: `删除「${cap?.label || '这项能力'}」？`, message: users.length ? `${users.join('、')} 勾了它，删除后派活时不再按它挑人。` : '删除后派活时不再按它挑人。', okText: '删除', danger: true });
  if (!ok) return;
  try {
    await saveCapabilities(customCapabilities().filter((item) => item.id !== remove.dataset.capRemove));
    toast('已删除。');
  } catch (err) {
    toast(err.message);
  }
});

/* ------------------------------ 执行器 ------------------------------- */

function renderFallbackSelect() {
  const select = $('#fallback-worker');
  if (!select || document.activeElement === select) return;
  const current = state.settings?.fallbackWorker || '';
  const entries = Object.entries(state.workers || {}).filter(([, w]) => w.enabled);
  const options = [['', '自动（最便宜的文本 Worker）'], ...entries.map(([id, w]) => [id, `${w.label || id}${w.available ? '' : '（现在用不了）'}`])];
  if (current && !entries.some(([id]) => id === current)) options.push([current, `${workerLabel(current)}（已停用，会按自动选）`]);
  select.innerHTML = options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
  select.value = current;
}

function renderWorkerList() {
  const box = $('#worker-grid');
  if (!box) return;
  const entries = Object.entries(state.workers || {});
  box.innerHTML = entries.map(([key, w]) => {
    const abilities = (w.abilities || []).map((a) => ABILITY_LABEL[a] || a).join(' · ');
    // 内置和官方 Worker 随静静发布，只能停用；自己装的插件才能删除。
    const removable = w.origin !== 'builtin' && w.origin !== 'official';
    // 开关只管「用不用」；开着但这台机器上跑不了（没装、缺 Key）时单独标出来，让用户知道差什么。
    const cls = !w.enabled ? 'is-off' : w.available ? '' : 'is-unavailable';
    const caps = w.capabilityLabels?.length ? w.capabilityLabels.join('、') : '';
    // 状态只用文字和透明度：用不了 / 停用的整行变淡，第二行写原因；能用的不多标。
    const reason = !w.enabled ? '已停用' : w.available ? '' : (w.detail || '这台机器上现在用不了');
    const line = `<small>${esc(reason || [w.detail, caps, abilities].filter(Boolean).join(' · '))}</small>`;
    const id = esc(key);
    return `
      <div class="lrow ${cls}" title="${esc([w.description, w.notes ? `本机补充：${w.notes}` : ''].filter(Boolean).join('\n'))}">
        <span class="glyph">${esc(w.glyph || '工')}</span>
        <div class="lrow-main">
          <b>${esc(w.label || key)}<span class="badge">${esc(ORIGIN[w.origin] || 'Worker 插件')}</span></b>
          ${line}
        </div>
        <div class="lrow-actions">
          <button type="button" class="btn xs" data-worker-config="${id}">配置</button>
          <button type="button" class="btn xs" data-worker-test="${id}">检测</button>
          ${removable ? `<button type="button" class="icon-btn sm danger" data-worker-delete="${id}" title="删除">${icon('trash', 'sm')}</button>` : ''}
          <input type="checkbox" class="switch" data-worker-enabled="${id}" ${w.enabled ? 'checked' : ''} title="${w.enabled ? '点击停用' : '点击启用'}" aria-label="启用 ${esc(w.label || key)}" />
        </div>
      </div>`;
  }).join('');
}

function workerConfigFields(w) {
  return (w.configSchema || []).map((field) => {
    const value = w.config?.[field.key];
    const attrs = `name="worker.${esc(field.key)}"`;
    if (field.type === 'checkbox') {
      return `<label class="switch-row span-2"><span><b>${esc(field.label)}</b></span><input type="checkbox" class="switch" ${attrs} ${value ? 'checked' : ''}></label>`;
    }
    if (field.type === 'select') {
      return `<label class="field"><span>${esc(field.label)}</span><select ${attrs}>${(field.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
    }
    if (field.type === 'textarea') {
      return `<label class="field span-2"><span>${esc(field.label)}</span><textarea rows="3" ${attrs}>${esc(value ?? '')}</textarea></label>`;
    }
    if (field.type === 'folder') {
      return `<div class="field"><span>${esc(field.label)}</span><input type="text" ${attrs} data-folder value="${esc(value ?? '')}" placeholder="${esc(field.placeholder || '')}" />${field.help ? `<small>${esc(field.help)}</small>` : ''}</div>`;
    }
    const type = field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text';
    const help = field.help ? `<small>${esc(field.help)}</small>` : '';
    return `<label class="field"><span>${esc(field.label)}</span><input type="${type}" ${attrs} value="${esc(value ?? '')}" placeholder="${esc(field.placeholder || '')}" />${help}</label>`;
  }).join('');
}

function workerRoutingFields(w) {
  const aliases = (w.aliases || []).join(', ');
  const chosen = new Set(w.capabilities || []);
  const catalog = state.capabilities || [];
  return `
    <label class="field span-2"><span>别名</span>
      <input name="worker.aliases" value="${esc(aliases)}" placeholder="claude, claude-cli" />
      <small>用户这样称呼它时算明确点名；大小写、全半角、标点都不影响。</small>
    </label>
    <div class="field span-2"><span>能用什么</span>
      <div class="cap-list">${catalog.map((item) => `<label class="cap-item" title="${esc(item.description || '')}"><input type="checkbox" name="cap.${esc(item.id)}" ${chosen.has(item.id) ? 'checked' : ''} /><span>${esc(item.label)}</span>${item.custom ? '<small class="cap-custom">自定义</small>' : ''}</label>`).join('')}</div>
      <small>只勾这台机器上它真能用的；本机装了 tapd-cli，就在对应的 Worker 上勾「TAPD 命令行」。列表里没有的，到「Worker → 本机能力」里添加。</small>
    </div>`;
}

function workerLimitFields(w) {
  return WORKER_LIMIT_FIELDS.map((field) => {
    const value = w.limits?.[field.key] ?? '';
    const fallback = w.limitDefaults?.[field.key];
    return `<label class="field"><span>${esc(field.label)}</span><input type="number" name="limit.${field.key}" min="${field.min}" max="${field.max}" step="1" value="${esc(value)}" placeholder="默认 ${esc(fallback ?? '-')}" title="${esc(field.help)}" /></label>`;
  }).join('');
}

function configureWorker(id) {
  const w = state.workers?.[id];
  if (!w) return;
  openDialog({
    title: `配置 ${w.label || id}`,
    desc: `${w.description ? `${w.description}\n` : ''}这些配置只属于当前主机的这个 Worker；运行限制留空表示用默认值。`,
    body: `
      <label class="switch-row"><span><b>启用</b><small>关掉后不会再派活给它。</small></span><input type="checkbox" class="switch" name="worker.enabled" ${w.enabled ? 'checked' : ''}></label>
      <div class="grid-2">${workerConfigFields(w)}${workerRoutingFields(w)}</div>
      <div class="grid-2">${workerLimitFields(w)}</div>
      <label class="field"><span>本机补充说明</span>
        <textarea name="worker.notes" maxlength="300" rows="3" placeholder="比如：已接入 TAPD MCP，能查需求、缺陷和迭代进度">${esc(w.notes || '')}</textarea>
        <small>静静挑 Worker 时会把这段和它的描述一起给模型看。写这台机器上它额外能做的事：接了哪些 MCP、能访问哪些系统。</small>
      </label>`,
    okText: '保存',
    onSubmit: async (values) => {
      const configValues = {};
      for (const field of w.configSchema || []) {
        const raw = values[`worker.${field.key}`];
        configValues[field.key] = field.type === 'checkbox' ? Boolean(raw) : field.type === 'number' ? Number(raw) : raw;
      }
      const limits = {};
      for (const field of WORKER_LIMIT_FIELDS) {
        const raw = String(values[`limit.${field.key}`] ?? '').trim();
        // 和默认值相同就不存覆盖，以后 Worker 升级默认值时能跟着变。
        if (raw !== '' && Number(raw) !== w.limitDefaults?.[field.key]) limits[field.key] = Number(raw);
      }
      const aliases = String(values['worker.aliases'] || '').split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
      const capabilities = Object.keys(values).filter((key) => key.startsWith('cap.') && values[key]).map((key) => key.slice(4));
      const data = await api(`/api/workers/${id}`, { method: 'PUT', body: { config: configValues, limits, notes: values['worker.notes'] ?? '', routing: { aliases, capabilities }, enabled: Boolean(values['worker.enabled']) } });
      state.workers = data.workers;
      changed('workers');
      toast('Worker 配置已保存。');
    }
  });
}

$('#worker-grid')?.addEventListener('click', async (event) => {
  const config = event.target.closest('[data-worker-config]');
  if (config) { configureWorker(config.dataset.workerConfig); return; }
  const test = event.target.closest('[data-worker-test]');
  if (test) {
    test.disabled = true;
    try {
      const result = await api(`/api/workers/${test.dataset.workerTest}/test`, { method: 'POST' });
      toast(`${result.available ? '✓' : '✗'} ${result.detail || (result.available ? '可用' : '不可用')}`, 3600);
    } catch (err) {
      toast(err.message);
    } finally {
      test.disabled = false;
    }
    return;
  }
  const del = event.target.closest('[data-worker-delete]');
  if (del) {
    const id = del.dataset.workerDelete;
    const worker = state.workers[id];
    const ok = await ask({ title: `删除 Worker「${worker?.label || id}」？`, message: '插件文件会一起移除。只是暂时不用的话，关掉开关就行。', okText: '删除', danger: true });
    if (!ok) return;
    try {
      const data = await api(`/api/workers/${id}`, { method: 'DELETE' });
      state.workers = data.workers;
      changed('workers');
      toast('Worker 已删除。');
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#worker-grid')?.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-worker-enabled]');
  if (!input) return;
  const id = input.dataset.workerEnabled;
  const enabled = input.checked;
  input.disabled = true;
  try {
    const data = await api(`/api/workers/${id}`, { method: 'PUT', body: { enabled } });
    state.workers = data.workers;
    changed('workers');
    const w = state.workers[id];
    if (enabled && w && !w.available) toast(`已启用，但这台机器上还用不了：${w.detail || '检测未通过'}`, 4200);
  } catch (err) {
    // 比如必填配置还没填：开关退回原位，提示去「配置」里补上。
    input.checked = !enabled;
    input.disabled = false;
    toast(err.message);
  }
});

$('#fallback-worker')?.addEventListener('change', async (event) => {
  const select = event.target;
  const previous = state.settings?.fallbackWorker || '';
  try {
    const data = await api('/api/settings', { method: 'PUT', body: { fallbackWorker: select.value } });
    state.settings = data.settings;
    changed('settings');
    toast(select.value ? `兜底 Worker 改为「${workerLabel(select.value)}」。` : '兜底 Worker 改为自动选择。');
  } catch (err) {
    select.value = previous;
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
    const data = await uploadPlugin(file);
    if (data.workers) state.workers = data.workers;
    if (data.plugins) state.plugins = data.plugins;
    changed('workers', 'plugins');
    toast('Worker 插件已安装，点「配置」填写主机参数。', 3600);
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    button.classList.remove('is-busy');
    button.textContent = '安装插件';
  }
});

/* ------------------------------ 分配规则 ------------------------------ */

function workerRuleCondition(rule) {
  const parts = [];
  if (rule.pattern) parts.push(rule.pattern_mode === 'keywords' ? `关键词 ${rule.pattern}` : `匹配 /${rule.pattern}/`);
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
  box.innerHTML = rules.length ? rules.map((rule, index) => {
    const id = esc(rule.id);
    return `
      <div class="lrow ${rule.enabled ? '' : 'is-off'}">
        <span class="lrow-order">${index + 1}</span>
        <div class="lrow-main"><b>${esc(rule.name)}</b><small>${esc(workerRuleCondition(rule))} → ${esc(workerLabel(rule.worker))}</small></div>
        <div class="lrow-actions">
          <button type="button" class="icon-btn sm" data-rule-move="up" data-id="${id}" title="上移" ${index === 0 ? 'disabled' : ''}>${icon('up', 'sm')}</button>
          <button type="button" class="icon-btn sm" data-rule-move="down" data-id="${id}" title="下移" ${index === rules.length - 1 ? 'disabled' : ''}>${icon('down', 'sm')}</button>
          <button type="button" class="icon-btn sm" data-wrule-edit="${id}" title="编辑">${icon('edit', 'sm')}</button>
          <button type="button" class="icon-btn sm danger" data-wrule-delete="${id}" title="删除">${icon('trash', 'sm')}</button>
          <input type="checkbox" class="switch" data-wrule-enabled="${id}" ${rule.enabled ? 'checked' : ''} aria-label="启用规则" />
        </div>
      </div>`;
  }).join('') : '<p class="note">还没有分配规则；所有任务按 Router 的判断和兜底 Worker 执行。</p>';
}

function workerRuleForm(rule = {}) {
  return `
    <label class="field"><span>规则名称</span><input name="name" value="${esc(rule.name || '')}" placeholder="例如：GitHub 通知交给 Claude" /></label>
    <label class="field"><span>匹配文本（可空）</span><input name="pattern" value="${esc(rule.pattern || '')}" placeholder="例如：github, pull request" /></label>
    <label class="field"><span>匹配方式</span><select name="pattern_mode">
      <option value="keywords" ${(rule.pattern_mode || (rule.id ? 'regex' : 'keywords')) === 'keywords' ? 'selected' : ''}>关键词（逗号/竖线分隔，推荐）</option>
      <option value="regex" ${(rule.pattern_mode || (rule.id ? 'regex' : 'keywords')) === 'regex' ? 'selected' : ''}>正则（高级）</option>
    </select></label>
    <div class="grid-2">
      <label class="field"><span>来源（可空，支持 plugin:*）</span><input name="source" value="${esc(rule.source || '')}" placeholder="web / plugin:* / plugin:email-imap" /></label>
      <label class="field"><span>事件类型（可空，支持 * / foo.*）</span><input name="event_type" value="${esc(rule.event_type || '')}" placeholder="email.unread / chat.message" /></label>
      <label class="field"><span>工作区（可空）</span><select name="workspace_id">
        <option value="">任意工作区</option>
        ${(state.settings?.workspaces || []).map((ws) => `<option value="${esc(ws.id)}" ${rule.workspace_id === ws.id ? 'selected' : ''}>${esc(ws.name)}</option>`).join('')}
      </select></label>
      <label class="field"><span>命中后交给</span><select name="worker">
        ${workerIds().map((id) => `<option value="${esc(id)}" ${rule.worker === id ? 'selected' : ''}>${esc(workerLabel(id))}</option>`).join('')}
      </select></label>
    </div>`;
}

function openWorkerRule(rule = null) {
  openDialog({
    title: rule ? '编辑分配规则' : '添加分配规则',
    desc: '从上到下第一个命中的规则生效；正则留空表示不限制文本。',
    body: workerRuleForm(rule || {}),
    okText: '保存',
    onSubmit: async (values) => {
      if (!values.name.trim()) throw new Error('规则名称不能为空');
      const body = {
        name: values.name,
        pattern: values.pattern,
        pattern_mode: values.pattern_mode,
        source: values.source,
        event_type: values.event_type,
        workspace_id: values.workspace_id,
        worker: values.worker
      };
      const data = await api(rule ? `/api/worker-rules/${rule.id}` : '/api/worker-rules', { method: rule ? 'PATCH' : 'POST', body });
      state.workerRules = data.rules;
      changed('workerRules');
      toast('分配规则已保存。');
    }
  });
}

$('#add-worker-rule')?.addEventListener('click', () => openWorkerRule());

$('#worker-rule-list')?.addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-wrule-edit]');
  if (edit) {
    openWorkerRule((state.workerRules || []).find((rule) => rule.id === edit.dataset.wruleEdit));
    return;
  }
  const del = event.target.closest('[data-wrule-delete]');
  if (del) {
    const ok = await ask({ title: '删除这条分配规则？', okText: '删除', danger: true });
    if (!ok) return;
    try {
      const data = await api(`/api/worker-rules/${del.dataset.wruleDelete}`, { method: 'DELETE' });
      state.workerRules = data.rules;
      changed('workerRules');
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
      changed('workerRules');
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#worker-rule-list')?.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-wrule-enabled]');
  if (!input) return;
  try {
    const data = await api(`/api/worker-rules/${input.dataset.wruleEnabled}`, { method: 'PATCH', body: { enabled: input.checked } });
    state.workerRules = data.rules;
    changed('workerRules');
  } catch (err) {
    input.checked = !input.checked;
    toast(err.message);
  }
});

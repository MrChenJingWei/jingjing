// 设置 → 任务来源：列表里直接开关，点进去配置；详情页不会被后台状态更新冲掉正在填的内容。
import {
  $, $$, state, on, changed, esc, timeAgo, toast, api, uploadPlugin, copyText,
  ensureWorkspaceForPath, pickFolder, defaultWorkspaceName, versionNewer, PLUGIN_TYPE_LABEL
} from './core.js';
import { icon, ask } from './ui.js';
import { openTask } from './tasks.js';

export function resetPluginPage() {
  state.pluginPage = 'list';
}

export function openPluginPage(id) {
  state.pluginPage = id;
  renderPlugins({ force: true });
  $('#settings-main').scrollTop = 0;
}

function closePluginPage() {
  state.pluginPage = 'list';
  renderPlugins({ force: true });
}

function pluginTypeLabel(plugin) {
  const type = plugin.type || 'poll';
  const label = PLUGIN_TYPE_LABEL[type] || type;
  return type === 'poll' ? `${label} · 每 ${plugin.intervalMinutes} 分钟` : label;
}

function statusText(plugin) {
  const status = plugin.status || {};
  if (status.lastStatus === 'error') {
    return `上次失败：${status.lastError || ''}${status.failCount ? ` · 连续 ${status.failCount} 次，下一轮自动退避` : ''}`;
  }
  return status.lastRun ? `${timeAgo(status.lastRun)}运行 · ${status.lastSummary || ''}` : '还没有运行过';
}

/**
 * 重画来源页。详情页已经画着同一个来源时，只更新状态行和开关（force 才整页重画），
 * 免得后台推来的状态把用户正在填的配置冲掉。
 */
export function renderPlugins({ force = false } = {}) {
  const detailView = $('#plugin-detail-view');
  const listView = $('#plugin-list-view');
  if (!detailView || !listView) return;
  const detail = state.pluginPage && state.pluginPage !== 'list';
  listView.hidden = detail;
  detailView.hidden = !detail;
  if (!detail) { renderPluginList(); return; }
  const body = $('#plugin-detail-body');
  if (!force && body?.dataset.pluginId === state.pluginPage) patchPluginDetail(state.pluginPage);
  else renderPluginDetail(state.pluginPage);
}

/* ------------------------------- 列表 -------------------------------- */

function renderPluginList() {
  const list = state.plugins || [];
  const container = $('#plugin-list');
  if (!container) return;
  const errors = state.pluginErrors || [];
  const notice = errors.length
    ? `<div class="plugin-errors"><b>${errors.length} 个插件未通过规范检查</b><ul>${errors.map((e) => `<li><code>${esc(e.plugin)}</code>：${esc(e.error)}</li>`).join('')}</ul><span>修好后点「重新加载」。</span></div>`
    : '';
  if (!list.length) {
    container.innerHTML = notice + '<div class="empty boxed"><p>还没有来源插件。点上面「安装插件」上传 zip，或把插件目录放进数据目录的 <code>plugins/</code>。</p></div>';
    return;
  }
  const row = (plugin) => {
    const status = plugin.status || {};
    const broken = status.lastStatus === 'error';
    const subName = plugin.label && plugin.label !== plugin.name ? `${plugin.name} · ` : '';
    const override = plugin.overridesOfficial
      ? ` · 覆盖了官方版本${versionNewer(plugin.officialVersion, plugin.version) ? '（官方有更新）' : ''}`
      : '';
    const id = esc(plugin.id);
    return `
      <div class="lrow prow ${plugin.enabled ? 'is-enabled' : 'is-off'}" data-open-plugin="${id}" role="button" tabindex="0">
        <span class="glyph">${esc(plugin.icon || '插')}</span>
        <div class="lrow-main">
          <b>${esc(plugin.label || plugin.name)}${broken ? '<span class="badge err">异常</span>' : ''}</b>
          <small class="${broken ? 'is-error' : ''}">${broken ? esc(status.lastError || '上次失败') : `${esc(subName)}${esc(pluginTypeLabel(plugin))} · v${esc(plugin.version)}${esc(override)}${status.lastRun ? ` · ${esc(timeAgo(status.lastRun))}运行` : ''}`}</small>
        </div>
        <div class="lrow-actions">
          <input type="checkbox" class="switch" data-plugin-enabled="${id}" ${plugin.enabled ? 'checked' : ''} title="${plugin.enabled ? '点击停用' : '点击启用'}" aria-label="启用 ${esc(plugin.label || plugin.name)}" />
          <span class="prow-arrow">${icon('chevronRight')}</span>
        </div>
      </div>`;
  };
  const official = list.filter((plugin) => plugin.source === 'official');
  const mine = list.filter((plugin) => plugin.source !== 'official');
  container.innerHTML = notice
    + (official.length ? `<div class="plist-group"><h4>官方<span>随静静更新</span></h4><div class="row-list">${official.map(row).join('')}</div></div>` : '')
    + `<div class="plist-group"><h4>我的<span>自己安装或让静静写的，升级不会覆盖</span></h4>${mine.length ? `<div class="row-list">${mine.map(row).join('')}</div>` : '<p class="note">还没有。可以「安装插件」上传 zip、把官方插件「复制为我的插件」来改，或者让静静帮你写一个。</p>'}</div>`;
}

/* ------------------------------- 详情 -------------------------------- */

function fieldInput(plugin, field) {
  const value = plugin.config?.[field.key];
  const attrs = `data-plugin-field="${esc(field.key)}"`;
  const help = field.help ? `<small class="field-help">${esc(field.help)}</small>` : '';
  if (field.type === 'checkbox') {
    return `<label class="switch-row"><span><b>${esc(field.label)}</b>${field.help ? `<small>${esc(field.help)}</small>` : ''}</span><input type="checkbox" class="switch" ${attrs} ${value ? 'checked' : ''}></label>`;
  }
  if (field.type === 'select') {
    return `<label class="field ${field.wide ? 'span-2' : ''}"><span>${esc(field.label)}</span>
      <select ${attrs}>${(field.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${help}</label>`;
  }
  if (field.type === 'textarea') {
    return `<label class="field span-2"><span>${esc(field.label)}</span>
      <textarea rows="3" ${attrs} placeholder="${esc(field.placeholder || '')}">${esc(value ?? '')}</textarea>${help}</label>`;
  }
  if (field.type === 'folder') {
    return `<div class="field ${field.wide ? 'span-2' : ''}"><span>${esc(field.label)}</span>
      <input type="text" ${attrs} data-folder value="${esc(value ?? '')}" placeholder="${esc(field.placeholder || '')}" />${help}</div>`;
  }
  const type = field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text';
  return `<label class="field ${field.wide ? 'span-2' : ''}"><span>${esc(field.label)}</span>
    <input type="${type}" ${attrs} value="${esc(value ?? '')}"
      ${field.min !== undefined ? `min="${esc(field.min)}"` : ''} ${field.max !== undefined ? `max="${esc(field.max)}"` : ''}
      placeholder="${esc(field.placeholder || '')}" autocomplete="off" />${help}</label>`;
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
  const pid = esc(plugin.id);
  const type = plugin.type || 'poll';
  const webhookUrl = plugin.webhookPath ? `${location.origin}${plugin.webhookPath}` : '';
  const typeNote = {
    stream: '长连接常驻，断线自动重连；不参与轮询。',
    webhook: '由外部事件触发，不参与轮询。',
    manual: '只在手动扫描或自动化扫描时运行。',
    watch: '文件监听类型预留，当前还没有实现。'
  }[type] || '';
  const status = plugin.status || {};
  const fields = (plugin.configSchema || []).map((f) => fieldInput(plugin, f)).join('');
  const canSave = (plugin.configSchema || []).length || type === 'poll';
  body.dataset.pluginId = plugin.id;
  body.innerHTML = `
    <button type="button" class="crumb" data-plugin-back>${icon('chevronLeft', 'sm')}任务来源</button>
    <div class="pdetail-head">
      <span class="glyph">${esc(plugin.icon || '插')}</span>
      <div class="lrow-main">
        <b>${esc(plugin.label || plugin.name)}</b>
        <small>${esc(plugin.name)} · v${esc(plugin.version)} · ${esc(pluginTypeLabel(plugin))}${plugin.capabilities?.read ? ' · 只读' : ''}</small>
      </div>
      <div class="lrow-actions">
        ${plugin.multiInstance ? `<button type="button" class="btn sm" data-plugin-add="${esc(plugin.pluginId)}">再添加一个</button>` : ''}
        <input type="checkbox" class="switch" data-plugin-enabled="${pid}" ${plugin.enabled ? 'checked' : ''} aria-label="启用这个来源" />
      </div>
    </div>
    <div class="stack" data-plugin-card="${pid}">
      <section class="card">
        ${plugin.description ? `<div class="card-head"><p>${esc(plugin.description)}</p></div>` : ''}
        <div class="grid-2">
          <label class="field"><span>来源名称</span><input data-plugin-label="${pid}" value="${esc(plugin.label || plugin.name)}" maxlength="60" /></label>
          ${type === 'poll'
            ? `<label class="field"><span>获取频率（分钟）</span><input type="number" data-plugin-interval="${pid}" min="1" max="1440" value="${esc(plugin.intervalMinutes)}" /><small class="field-help">默认 ${esc(plugin.defaultIntervalMinutes)} 分钟；只影响这个来源。</small></label>`
            : `<label class="field"><span>运行方式</span><input value="${esc(PLUGIN_TYPE_LABEL[type] || type)}" readonly /><small class="field-help">${esc(typeNote)}</small></label>`}
          <label class="field span-2"><span>任务工作区</span>
            <select data-plugin-workspace="${pid}">
              <option value="">跟随默认（${esc(defaultWorkspaceName())}）</option>
              ${(state.settings?.workspaces || []).map((ws) => `<option value="${esc(ws.id)}" ${plugin.workspaceId === ws.id ? 'selected' : ''}>${esc(ws.name)} · ${esc(ws.path)}</option>`).join('')}
              <option value="__custom__">选择其他文件夹…</option>
            </select>
          </label>
        </div>
        ${plugin.canReply ? `
          <label class="switch-row" style="margin-top:8px">
            <span><b>任务完成后自动发回原会话</b><small>默认关闭。打开后，结果不经你过目就直接发给对方；关着时，可以在完成的任务上点「发回原会话」，改好再发。</small></span>
            <input type="checkbox" class="switch" data-plugin-auto-reply="${pid}" ${plugin.autoReply ? 'checked' : ''} />
          </label>
          <label class="switch-row" style="margin-top:8px">
            <span><b>闲聊自动回</b><small>默认关闭。打开后，私聊或 @ 静静的闲聊由她按人格自己回；任务结果仍按上面那个开关处理，两者互不影响。</small></span>
            <input type="checkbox" class="switch" data-plugin-auto-chat="${pid}" ${plugin.autoChat ? 'checked' : ''} />
          </label>` : ''}
        ${plugin.canDeliver ? relaySection(plugin, pid) : ''}
      </section>
      ${webhookUrl ? `
        <div class="webhook-box">
          <div class="webhook-label">Webhook 地址 <span>${plugin.enabled ? '已启用' : '启用后生效'}</span></div>
          <code class="webhook-url">${esc(webhookUrl)}</code>
          <div class="webhook-actions">
            <button type="button" class="btn xs" data-copy-webhook="${esc(webhookUrl)}">${icon('copy', 'sm')}复制地址</button>
            <span>外部服务 POST JSON 到这里；公网 / Tailscale 地址才能被外部访问。</span>
          </div>
        </div>` : ''}
      ${fields ? `<section class="card"><div class="card-head"><h3>连接配置</h3></div><div class="plugin-fields">${fields}</div></section>` : ''}
      <div class="inline-actions" style="margin-top:0">
        ${canSave ? `<button type="button" class="btn primary" data-plugin-action="save" data-id="${pid}">保存配置</button>` : ''}
        <button type="button" class="btn" data-plugin-action="test" data-id="${pid}">${icon('test', 'sm')}测试连接</button>
        ${(type === 'poll' || type === 'manual') ? `<button type="button" class="btn" data-plugin-action="scan" data-id="${pid}">${icon('scan', 'sm')}立即扫描</button>` : ''}
        <span class="grow"></span>
        ${plugin.source === 'official' ? `<button type="button" class="btn sm ghost" data-plugin-fork="${pid}">复制为我的插件</button>` : ''}
        ${plugin.overridesOfficial ? `<button type="button" class="btn sm ghost" data-plugin-restore="${pid}">恢复官方版本</button>` : ''}
        ${plugin.removable ? `<button type="button" class="btn sm danger" data-plugin-uninstall="${pid}">删除来源</button>` : ''}
        <span class="test-result" data-plugin-result="${pid}"></span>
      </div>
      <p class="plugin-status ${status.lastStatus === 'error' ? 'is-error' : ''}" data-plugin-status="${pid}">${esc(statusText(plugin))}</p>
      <section class="card" id="plugin-recent">
        <div class="card-head"><h3>最近处理</h3><p>消息进来后，静静判断了什么。</p></div>
        <p class="note">加载中…</p>
      </section>
      <section class="card" id="plugin-runs">
        <div class="card-head"><h3>运行历史</h3><p>每次拉取的结果。</p></div>
        <p class="note">加载中…</p>
      </section>
    </div>`;
  loadPluginRecent(plugin.id);
  loadPluginRuns(plugin.id);
}

function patchPluginDetail(id) {
  const plugin = (state.plugins || []).find((item) => item.id === id);
  if (!plugin) { renderPluginDetail(id); return; }
  const status = $(`[data-plugin-status="${CSS.escape(id)}"]`);
  if (status) {
    status.textContent = statusText(plugin);
    status.classList.toggle('is-error', plugin.status?.lastStatus === 'error');
  }
  const toggle = $(`#plugin-detail-body [data-plugin-enabled="${CSS.escape(id)}"]`);
  if (toggle && !toggle.disabled) toggle.checked = Boolean(plugin.enabled);
}

async function loadPluginRecent(id) {
  const box = () => $('#plugin-recent');
  try {
    const data = await api(`/api/plugins/${id}/items`);
    if (state.pluginPage !== id || !box()) return;
    const items = data.items || [];
    const label = { task: '已建任务', merged: '已合并', skipped: '跳过', chat: '闲聊', new: '待处理', pending: '判断中' };
    box().innerHTML = `
      <div class="card-head"><h3>最近处理</h3><p>消息进来后，静静判断了什么。</p></div>
      ${items.length ? items.map((item) => `
        <div class="recent-row">
          <div class="lrow-main">
            <b>${esc(item.title || '未命名')}</b>
            <small>${esc(timeAgo(item.createdAt))} · ${esc(item.reason || '没有记录判断理由')}</small>
          </div>
          <span class="recent-state ${item.status === 'task' || item.status === 'merged' ? 'is-task' : ''}">${esc(label[item.status] || item.status)}</span>
          ${item.taskId ? `<button type="button" class="btn xs" data-recent-task="${esc(item.taskId)}">看任务</button>` : ''}
        </div>`).join('') : '<p class="note">还没有处理记录。</p>'}`;
  } catch (err) {
    if (box()) box().innerHTML = `<div class="card-head"><h3>最近处理</h3></div><p class="note">${esc(err.message)}</p>`;
  }
}

async function loadPluginRuns(id) {
  const box = () => $('#plugin-runs');
  try {
    const data = await api(`/api/plugins/${id}/runs`);
    if (state.pluginPage !== id || !box()) return;
    const runs = data.runs || [];
    box().innerHTML = `
      <div class="card-head"><h3>运行历史</h3><p>每次拉取的结果。</p></div>
      ${runs.length ? runs.map((run) => `
        <div class="recent-row">
          <div class="lrow-main">
            <b>${esc(run.status === 'ok' ? '成功' : run.status === 'error' ? '失败' : run.status)} · ${run.created ?? 0} 个任务</b>
            <small class="${run.error ? 'is-error' : ''}">${esc(timeAgo(run.started_at))} · ${run.scanned ?? 0} 条 · ${run.duration_ms ?? 0}ms${run.error ? ` · ${esc(run.error)}` : ''}</small>
          </div>
        </div>`).join('') : '<p class="note">还没有运行记录。</p>'}`;
  } catch (err) {
    if (box()) box().innerHTML = `<div class="card-head"><h3>运行历史</h3></div><p class="note">${esc(err.message)}</p>`;
  }
}

/* ------------------------------- 操作 -------------------------------- */

function replacePlugin(plugin) {
  const index = state.plugins.findIndex((p) => p.id === plugin.id);
  if (index >= 0) state.plugins[index] = plugin;
}

function collectPluginConfig(id) {
  const card = $(`[data-plugin-card="${CSS.escape(id)}"]`);
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

async function savePluginConfig(id) {
  const body = { config: collectPluginConfig(id) };
  const interval = $(`[data-plugin-interval="${CSS.escape(id)}"]`);
  const label = $(`[data-plugin-label="${CSS.escape(id)}"]`);
  if (interval) body.intervalMinutes = interval.value === '' ? null : Number(interval.value);
  if (label) body.label = label.value;
  const data = await api(`/api/plugins/${id}`, { method: 'PUT', body });
  replacePlugin(data.plugin);
  if (Array.isArray(data.errors)) state.pluginErrors = data.errors;
  return data.plugin;
}

async function setEnabled(input) {
  const id = input.dataset.pluginEnabled;
  input.disabled = true;
  try {
    const data = await api(`/api/plugins/${id}`, { method: 'PUT', body: { enabled: input.checked } });
    replacePlugin(data.plugin);
    if (Array.isArray(data.errors)) state.pluginErrors = data.errors;
    changed('plugins');
    toast(input.checked ? '来源已启用，会按设定的方式自动发现。' : '来源已停用。');
  } catch (err) {
    input.checked = !input.checked;
    // 缺必填配置时直接带去填，不让人自己找。
    if (/必填/.test(err.message) && state.pluginPage === 'list') {
      openPluginPage(id);
      toast(`${err.message}。填好后再打开开关。`, 4200);
    } else {
      toast(err.message);
    }
  } finally {
    input.disabled = false;
  }
}

async function runPluginAction(btn) {
  const id = btn.dataset.id;
  const action = btn.dataset.pluginAction;
  const setResult = (text, resultState) => {
    const el = $(`[data-plugin-result="${CSS.escape(id)}"]`);
    if (!el) return;
    el.textContent = text;
    el.dataset.state = resultState || '';
    el.parentElement?.querySelector('.plugin-preview')?.remove();
  };
  btn.disabled = true;
  try {
    if (action === 'save') {
      await savePluginConfig(id);
      setResult('✓ 已保存', 'ok');
      changed('plugins');
      toast('来源配置已保存。');
    } else if (action === 'test') {
      setResult('测试中…', 'pending');
      await savePluginConfig(id);
      const data = await api(`/api/plugins/${id}/test`, { method: 'POST' });
      setResult(`${data.ok ? '✓' : '✗'} ${data.detail || ''}${data.latencyMs ? ` · ${data.latencyMs}ms` : ''}`, data.ok ? 'ok' : 'error');
      if (data.preview?.length) {
        $(`[data-plugin-result="${CSS.escape(id)}"]`)?.insertAdjacentHTML('afterend', `<ul class="plugin-preview">${data.preview.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`);
      }
    } else if (action === 'scan') {
      setResult('扫描中…', 'pending');
      await savePluginConfig(id);
      const data = await api(`/api/plugins/${id}/scan`, { method: 'POST' });
      setResult(data.skipped ? '已跳过' : `✓ 扫描 ${data.scanned ?? 0} 条，新建 ${data.created ?? 0} 个任务`, 'ok');
      toast(data.created ? `发现 ${data.created} 件事，已建任务。` : '扫描完成，没有需要你动手的新内容。');
      if (data.plugins) state.plugins = data.plugins;
      if (Array.isArray(data.errors)) state.pluginErrors = data.errors;
      changed('plugins');
      loadPluginRecent(id);
      loadPluginRuns(id);
    }
  } catch (err) {
    setResult(`✗ ${err.message}`, 'error');
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function forkOrRestore(el, fork) {
  const id = fork ? el.dataset.pluginFork : el.dataset.pluginRestore;
  const plugin = state.plugins.find((item) => item.id === id);
  const ok = await ask(fork
    ? { title: `把「${plugin?.name}」复制到「我的」？`, message: '复制出来的是一个新插件（新 id），可以随便改；官方版本照常保留和更新。', okText: '复制' }
    : { title: `恢复「${plugin?.name}」的官方版本？`, message: '你改过的那份会挪到数据目录的 plugins/.migrated/ 备份，配置保留。', okText: '恢复' });
  if (!ok) return;
  try {
    const data = await api(`/api/plugins/${encodeURIComponent(id)}/${fork ? 'fork' : 'restore-official'}`, { method: 'POST' });
    state.plugins = data.plugins || [];
    state.pluginErrors = data.errors || [];
    if (data.workers) state.workers = data.workers;
    state.pluginPage = fork && data.forkedId ? data.forkedId : 'list';
    renderPlugins({ force: true });
    changed('plugins', 'workers');
    toast(fork ? '已复制到「我的」，现在可以改它了（文件在数据目录的 plugins/ 里）。' : '已恢复官方版本。');
  } catch (err) {
    toast(err.message);
  }
}

async function uninstall(id) {
  const plugin = state.plugins.find((item) => item.id === id);
  if (!plugin) return;
  const ok = await ask({ title: `删除「${plugin.label || plugin.name}」？`, message: '配置和启用状态会一起删除；如果这是最后一个实例，插件文件也会移除。已建的任务会保留。', okText: '删除', danger: true });
  if (!ok) return;
  try {
    const data = await api(`/api/plugins/${id}`, { method: 'DELETE' });
    state.plugins = data.plugins || [];
    state.pluginErrors = data.errors || [];
    state.pluginPage = 'list';
    renderPlugins({ force: true });
    changed('plugins');
    toast(data.purged ? '插件已删除。' : '来源已删除，插件本身还保留着。');
  } catch (err) {
    toast(err.message);
  }
}

async function addInstance(btn) {
  btn.disabled = true;
  try {
    const data = await api(`/api/plugins/${btn.dataset.pluginAdd}/instances`, { method: 'POST', body: {} });
    state.plugins = data.plugins || state.plugins;
    state.pluginPage = data.plugin?.id || state.pluginPage;
    renderPlugins({ force: true });
    changed('plugins');
    toast('已添加一个来源实例，填好配置再启用。');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function changeWorkspace(select) {
  const id = select.dataset.pluginWorkspace;
  const previous = state.plugins.find((plugin) => plugin.id === id)?.workspaceId || '';
  try {
    let target = select.value;
    if (target === '__custom__') {
      const picked = await pickFolder();
      const workspace = await ensureWorkspaceForPath(picked.path);
      target = workspace.id;
      if (![...select.options].some((option) => option.value === target)) {
        select.insertAdjacentHTML('beforeend', `<option value="${esc(target)}">${esc(workspace.name)} · ${esc(workspace.path)}</option>`);
      }
      select.value = target;
    }
    const data = await api(`/api/plugins/${id}`, { method: 'PUT', body: { workspaceId: target || null } });
    replacePlugin(data.plugin);
    toast(target ? '任务工作区已更新。' : '已改为跟随默认工作区。');
  } catch (err) {
    select.value = previous;
    toast(err.message);
  }
}

const RELAY_STATUS_LABEL = {
  off: '不播报：只回执，之后在静静里看',
  key: '关键节点：等拍板、做完、失败',
  progress: '关键节点 + 实时进度（同一条消息里刷新）'
};

/** 消息类来源（导出了 deliver()）往外说话的策略：静静决定说什么，插件决定在渠道里怎么显示。 */
function relaySection(plugin, pid) {
  const relay = plugin.relay || {};
  return `
    <div class="relay-box">
      <h4>在${esc(plugin.label || plugin.name)}里怎么回话</h4>
      <label class="switch-row">
        <span><b>收到消息先回执</b><small>先回「收到，正在看…」，判断完在同一条消息里说结果（建了任务 / 合并 / 不处理）。</small></span>
        <input type="checkbox" class="switch" data-plugin-relay="ack" data-id="${pid}" ${relay.ack !== false ? 'checked' : ''} />
      </label>
      <label class="field"><span>任务状态播报</span>
        <select data-plugin-relay="status" data-id="${pid}">
          ${Object.entries(RELAY_STATUS_LABEL).map(([value, label]) => `<option value="${value}" ${relay.status === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <small class="field-help">等拍板时会推一张带按钮的卡片。任务结果要不要发出去，看上面的「自动发回」。</small>
      </label>
      <label class="field"><span>能在群里拍板的人</span>
        <input data-plugin-relay="owners" data-id="${pid}" value="${esc(relay.owners || '')}" placeholder="渠道里的用户 id，多个用逗号分隔" maxlength="1000" />
        <small class="field-help">只有这些人点卡片按钮才算数，默认没有人。不知道自己的 id：在群里点一次按钮，任务时间线上会记下点按钮的人的 id。</small>
      </label>
    </div>`;
}

async function changeRelay(input) {
  const id = input.dataset.id;
  const key = input.dataset.pluginRelay;
  const value = input.type === 'checkbox' ? input.checked : input.value;
  try {
    const data = await api(`/api/plugins/${id}`, { method: 'PUT', body: { relay: { [key]: value } } });
    replacePlugin(data.plugin);
    toast({ ack: value ? '收到消息会先回执。' : '不再回执。', status: '状态播报已更新。', owners: '能拍板的人已更新。' }[key]);
  } catch (err) {
    if (input.type === 'checkbox') input.checked = !input.checked;
    toast(err.message);
  }
}

async function changeAutoChat(input) {
  const id = input.dataset.pluginAutoChat;
  try {
    const data = await api(`/api/plugins/${id}`, { method: 'PUT', body: { autoChat: input.checked } });
    replacePlugin(data.plugin);
    toast(input.checked ? '已打开：闲聊会由静静自己回。' : '已关闭闲聊自动回。', 3600);
  } catch (err) {
    input.checked = !input.checked;
    toast(err.message);
  }
}

async function changeAutoReply(input) {
  const id = input.dataset.pluginAutoReply;
  try {
    const data = await api(`/api/plugins/${id}`, { method: 'PUT', body: { autoReply: input.checked } });
    replacePlugin(data.plugin);
    toast(input.checked ? '已打开：之后从这里来的任务，完成后会自动把结果发回原会话。' : '已关闭自动发回，需要时在任务上手动发。', 3600);
  } catch (err) {
    input.checked = !input.checked;
    toast(err.message);
  }
}

const panel = $('[data-settings-panel="plugins"]');

panel?.addEventListener('click', async (event) => {
  if (event.target.closest('.switch')) return;
  if (event.target.closest('[data-plugin-back]')) { closePluginPage(); return; }
  const recent = event.target.closest('[data-recent-task]');
  if (recent) { openTask(recent.dataset.recentTask); return; }
  const add = event.target.closest('[data-plugin-add]');
  if (add) { addInstance(add); return; }
  const action = event.target.closest('[data-plugin-action]');
  if (action) { runPluginAction(action); return; }
  const copy = event.target.closest('[data-copy-webhook]');
  if (copy) { copyText(copy.dataset.copyWebhook, 'Webhook 地址已复制。'); return; }
  const fork = event.target.closest('[data-plugin-fork]');
  if (fork) { forkOrRestore(fork, true); return; }
  const restore = event.target.closest('[data-plugin-restore]');
  if (restore) { forkOrRestore(restore, false); return; }
  const remove = event.target.closest('[data-plugin-uninstall]');
  if (remove) { uninstall(remove.dataset.pluginUninstall); return; }
  const row = event.target.closest('[data-open-plugin]');
  if (row) openPluginPage(row.dataset.openPlugin);
});

panel?.addEventListener('keydown', (event) => {
  const row = event.target.closest?.('[data-open-plugin]');
  if (row && event.target === row && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openPluginPage(row.dataset.openPlugin);
  }
});

panel?.addEventListener('change', (event) => {
  const workspace = event.target.closest('[data-plugin-workspace]');
  if (workspace) { changeWorkspace(workspace); return; }
  const autoReply = event.target.closest('[data-plugin-auto-reply]');
  if (autoReply) { changeAutoReply(autoReply); return; }
  const autoChat = event.target.closest('[data-plugin-auto-chat]');
  if (autoChat) { changeAutoChat(autoChat); return; }
  const relayInput = event.target.closest('[data-plugin-relay]');
  if (relayInput) { changeRelay(relayInput); return; }
  const enabled = event.target.closest('[data-plugin-enabled]');
  if (enabled) setEnabled(enabled);
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
    const data = await uploadPlugin(file);
    state.plugins = data.plugins || state.plugins;
    state.pluginErrors = data.errors || [];
    if (data.workers) state.workers = data.workers;
    state.pluginPage = 'list';
    renderPlugins({ force: true });
    changed('plugins', 'workers');
    toast('插件已安装。点进去填配置，再打开启用开关。', 3600);
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
    button.textContent = '安装插件';
  }
});

$('#reload-plugins')?.addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    const data = await api('/api/plugins/reload', { method: 'POST' });
    state.plugins = data.plugins;
    state.pluginErrors = data.errors || [];
    state.pluginPage = 'list';
    renderPlugins({ force: true });
    changed('plugins');
    toast(`已加载 ${data.plugins.length} 个插件。`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

on('pluginStatus', () => {
  if (state.view === 'settings' && state.settingsPage === 'plugins') renderPlugins();
});

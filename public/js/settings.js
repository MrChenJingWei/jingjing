// 设置：左边分类、右边内容。表单类分页（模型、调度器、通知）统一用顶部「保存」，其余操作即时生效。
import {
  $, $$, state, on, changed, esc, toast, api, getPath, setPath, isWide, onWideChange, copyText, pickFolder
} from './core.js';
import { icon, ask } from './ui.js';
import { syncHash, updateInstallStatus, nativeApp, standalone } from './shell.js';
import { renderWorkerPage } from './workers.js';
import { renderPlugins, resetPluginPage } from './plugins.js';
import { renderWorkflows, renderRules } from './automation.js';
import { loadStatus, loadArchives } from './system.js';

export const SETTINGS_PAGES = [
  { id: 'model', group: '助手', icon: 'sparkle', title: '模型与人设', desc: '运行模式、模型和 Key，静静怎么称呼你、她的性格，以及她怎么记事、有没有心情、会不会自己成长。', needsSave: true },
  { id: 'scheduler', group: '助手', icon: 'gauge', title: '调度器', desc: '同时跑几个任务、单任务最多恢复几次、默认工作目录和每日简报。', needsSave: true },
  { id: 'worker', group: '助手', icon: 'cpu', title: 'Worker', desc: '谁来动手：启用、配置、检测执行器，以及按规则分配。', needsSave: false },
  { id: 'workflows', group: '助手', icon: 'flow', title: '工作流程', desc: '读取你写好的流程文档，确认静静学到的习惯，按流程派活。', needsSave: false },
  { id: 'rules', group: '助手', icon: 'clock', title: '自动化', desc: '按时间自己跑：建任务，或扫一遍来源并按流程处理。', needsSave: false },
  { id: 'workspaces', group: '助手', icon: 'folder', title: '工作区', desc: '任务在哪个目录里干活；每个来源可以单独绑定。', needsSave: false },
  { id: 'plugins', group: '来源与通知', icon: 'plug', title: '任务来源', desc: '邮箱、日历、企微等发现来源，单独启用和配置。', needsSave: false },
  { id: 'channels', group: '来源与通知', icon: 'bell', title: '通知通道', desc: 'Telegram、飞书和通用 Webhook。', needsSave: true },
  { id: 'pairing', group: '来源与通知', icon: 'phone', title: '手机与配对', desc: '配对码、手机访问地址，以及把静静装到手机上。', needsSave: false },
  { id: 'status', group: '系统', icon: 'activity', title: '运行状态', desc: '服务运行情况、调度队列和服务日志。', needsSave: false },
  { id: 'data', group: '系统', icon: 'database', title: '数据与归档', desc: '备份、导出，以及把旧任务打包归档。', needsSave: false },
  { id: 'about', group: '系统', icon: 'info', title: '关于与更新', desc: '版本、运行位置，以及从 GitHub 在线更新。', needsSave: false }
];

const pageById = (id) => SETTINGS_PAGES.find((page) => page.id === id);

function providerLabel(value) {
  if (value === 'openai' || value === 'deepseek') return 'OpenAI 兼容';
  return value === 'ollama' ? 'Ollama' : '演示模式';
}

/* ----------------------------- 模型选择器 ----------------------------- */
// 模型框是可输入的下拉：常见地址给一组预设，点「获取模型列表」再把接口返回的模型并进来。

const HOST_MODEL_PRESETS = {
  'api.deepseek.com': ['deepseek-chat', 'deepseek-reasoner'],
  'api.moonshot.cn': ['kimi-k2-0905-preview', 'moonshot-v1-32k'],
  'open.bigmodel.cn': ['glm-4.6', 'glm-4.5-air'],
  'dashscope.aliyuncs.com': ['qwen-plus', 'qwen-max'],
  'api.openai.com': ['gpt-5', 'gpt-4.1'],
  'openrouter.ai': ['deepseek/deepseek-chat']
};
const OLLAMA_PRESETS = ['qwen2.5:7b', 'llama3.1:8b', 'gemma3:4b'];
// 按运行模式分开存，免得 Ollama 的模型名跑到云端接口的列表里。
const fetchedModels = { openai: new Set(), ollama: new Set() };

function baseHost() {
  const raw = $('[name="baseUrl"]')?.value?.trim() || '';
  try {
    return new URL(raw || 'https://api.deepseek.com').host;
  } catch {
    return '';
  }
}

function renderModelOptions() {
  const list = $('#model-options');
  const input = $('#model-input');
  if (!list || !input) return;
  const provider = $('#provider-select')?.value || 'demo';
  const presets = provider === 'ollama'
    ? OLLAMA_PRESETS
    : HOST_MODEL_PRESETS[baseHost()] || HOST_MODEL_PRESETS['api.deepseek.com'];
  const all = [...new Set([...presets, ...(fetchedModels[provider] || fetchedModels.openai)])];
  list.innerHTML = all.map((id) => `<option value="${esc(id)}"></option>`).join('');
  input.placeholder = provider === 'ollama' ? 'qwen2.5:7b' : 'deepseek-chat';
  const help = $('#model-help');
  if (help) {
    help.textContent = provider === 'ollama'
      ? '可以直接填，也可以点输入框右侧箭头选本机 Ollama 里的模型；点「获取模型列表」会读本机的 /api/tags。'
      : '可以直接填，也可以点输入框右侧箭头选。换完地址点「获取模型列表」，会把接口支持的模型都列进来。';
  }
}

/** 分类旁的短标记（桌面）和一句话摘要（手机列表）。 */
function pageMeta(id) {
  const s = state.settings || {};
  const workers = Object.values(state.workers || {});
  const plugins = state.plugins || [];
  const flows = state.workflows?.workflows || [];
  const rules = state.rules || [];
  switch (id) {
    case 'model': return { meta: providerLabel(s.provider), sum: `${providerLabel(s.provider)} · ${s.model || '—'}` };
    case 'scheduler': return { meta: `并发 ${s.concurrency || 2}`, sum: `并发 ${s.concurrency || 2} · 每日简报${s.proactive ? '开启' : '关闭'}` };
    case 'worker': {
      const available = workers.filter((w) => w.available).length;
      const broken = workers.filter((w) => w.enabled && !w.available).length;
      return { meta: `${available}/${workers.length}`, sum: `${available}/${workers.length} 个可用${broken ? ` · ${broken} 个开着但用不了` : ''}`, tone: broken ? 'warn' : '' };
    }
    case 'workflows': {
      const active = flows.filter((w) => w.status === 'active').length;
      const candidates = flows.filter((w) => w.status === 'candidate').length;
      return { meta: candidates ? `${candidates} 待确认` : String(active), sum: `${active} 个生效${candidates ? ` · ${candidates} 个候选待确认` : ''}`, tone: candidates ? 'warn' : '' };
    }
    case 'rules': {
      const enabled = rules.filter((r) => r.enabled).length;
      const failed = rules.filter((r) => r.enabled && r.last_status === 'error').length;
      return { meta: rules.length ? `${enabled}/${rules.length}` : '', sum: rules.length ? `${rules.length} 条 · ${enabled} 条启用${failed ? ` · ${failed} 条上次失败` : ''}` : '未配置', tone: failed ? 'err' : '' };
    }
    case 'workspaces': {
      const list = s.workspaces || [];
      const current = list.find((item) => item.id === s.defaultWorkspaceId);
      return { meta: String(list.length), sum: `${list.length} 个 · 默认 ${current?.name || '—'}` };
    }
    case 'plugins': {
      const errors = (state.pluginErrors || []).length + plugins.filter((p) => p.enabled && p.status?.lastStatus === 'error').length;
      return { meta: errors ? `${errors} 个异常` : `${plugins.filter((p) => p.enabled).length}/${plugins.length}`, sum: `${plugins.filter((p) => p.enabled).length}/${plugins.length} 个来源启用${errors ? ` · ${errors} 个异常` : ''}`, tone: errors ? 'err' : '' };
    }
    case 'channels': {
      const enabled = ['telegram', 'feishu', 'webhook'].filter((key) => state.channels?.[key]).length;
      return { meta: enabled ? String(enabled) : '', sum: enabled ? `${enabled} 个通道已启用` : '都没有配置，仅应用内提醒' };
    }
    case 'pairing': return { meta: '', sum: nativeApp || standalone ? '配对码 · 手机访问地址' : '配对码 · 安装到手机或桌面' };
    case 'status': {
      const paused = Boolean(state.stats?.paused ?? s.queuePaused);
      return { meta: paused ? '已暂停' : '', sum: paused ? '调度已暂停' : '服务、队列与日志', tone: paused ? 'warn' : '' };
    }
    case 'data': return { meta: '', sum: '备份、导出与归档' };
    case 'about': return { meta: `v${state.server?.version || '—'}`, sum: `v${state.server?.version || '—'}` };
    default: return { meta: '', sum: '' };
  }
}

/** 设置里有需要人处理的东西（候选习惯、坏掉的插件）：导航上标个点。 */
export function settingsHasAttention() {
  const flows = state.workflows?.workflows || [];
  return flows.some((w) => w.status === 'candidate') || (state.pluginErrors || []).length > 0;
}

export function renderSettingsNav() {
  const nav = $('#settings-nav');
  if (!nav) return;
  let group = '';
  const html = [];
  for (const page of SETTINGS_PAGES) {
    if (page.group !== group) {
      group = page.group;
      html.push(`<div class="snav-label">${esc(group)}</div>`);
    }
    const { meta, sum, tone } = pageMeta(page.id);
    html.push(`
      <button type="button" class="snav-item ${state.settingsPage === page.id ? 'is-active' : ''}" data-settings-page="${page.id}">
        ${icon(page.icon)}
        <span class="snav-text"><span>${esc(page.title)}</span><small class="snav-sum">${esc(sum)}</small></span>
        ${meta ? `<small class="snav-meta ${tone || ''}">${esc(meta)}</small>` : ''}
        <span class="snav-arrow">${icon('chevronRight', 'sm')}</span>
      </button>`);
  }
  nav.innerHTML = html.join('');
}

/** 进入设置页。桌面直接打开上次（或第一个）分页；手机先显示分类列表。 */
export async function enterSettings(sub = null) {
  const target = sub || (isWide() ? state.settingsPage || 'model' : null);
  if (target && pageById(target)) await openSettingsPage(target);
  else showSettingsIndex();
}

export function showSettingsIndex() {
  state.settingsPage = null;
  $('#settings')?.classList.add('is-index');
  renderSettingsNav();
  syncHash();
}

export async function openSettingsPage(id, { force = false } = {}) {
  const page = pageById(id);
  if (!page) return;
  if (!force && state.settingsPage && state.settingsPage !== id && !(await leaveSettingsOk())) return;
  const samePage = state.settingsPage === id;
  state.settingsPage = id;
  $('#settings')?.classList.remove('is-index');
  $('#settings-title').textContent = page.title;
  $('#settings-desc').textContent = page.desc;
  $('#save-settings').hidden = !page.needsSave;
  for (const panel of $$('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== id;
  if (!samePage) settingsBaseline = null;
  fillSettings();
  if (id === 'plugins' && !samePage) resetPluginPage();
  renderPage(id, { entering: true });
  markSettingsClean();
  renderSettingsNav();
  if (!samePage) $('#settings-main').scrollTop = 0;
  syncHash();
}

/** 只重画当前分页；entering 表示刚进入（需要拉一次数据的分页在这时拉）。 */
function renderPage(id = state.settingsPage, { entering = false } = {}) {
  if (state.view !== 'settings' || !id) return;
  if (id === 'model') { syncProviderFields(); renderPersonaHistory(); }
  if (id === 'worker') renderWorkerPage();
  if (id === 'workflows') renderWorkflows();
  if (id === 'rules') renderRules();
  if (id === 'workspaces' && entering) renderWorkspaces();
  if (id === 'plugins') renderPlugins();
  if (id === 'channels') renderChannelBadges();
  if (id === 'pairing' && entering) { loadPairing(); updateInstallStatus(); }
  if (id === 'status' && entering) loadStatus();
  if (id === 'data' && entering) loadArchives();
  if (id === 'about') { fillAbout(); if (entering) refreshUpdateStatus(); }
}

$('#settings-nav')?.addEventListener('click', (event) => {
  const item = event.target.closest('[data-settings-page]');
  if (item) openSettingsPage(item.dataset.settingsPage);
});
$('#settings-back')?.addEventListener('click', async () => {
  if (await leaveSettingsOk()) showSettingsIndex();
});

onWideChange((wide) => {
  if (wide && state.view === 'settings' && !state.settingsPage) openSettingsPage('model');
});

/* ------------------------- 未保存的改动提醒 ------------------------- */

// 打开分页时记下表单的样子，之后和它比较，判断有没有没保存的改动。
let settingsBaseline = null;

function settingsFormValues() {
  const page = pageById(state.settingsPage);
  if (!page?.needsSave) return null;
  const panel = $(`[data-settings-panel="${page.id}"]`);
  if (!panel) return null;
  return JSON.stringify($$('[name]', panel).map((input) => [input.name, input.type === 'checkbox' ? input.checked : input.value]));
}

export function settingsDirty() {
  if (settingsBaseline === null) return false;
  const current = settingsFormValues();
  return current !== null && current !== settingsBaseline;
}

function markSettingsClean() {
  settingsBaseline = settingsFormValues();
  updateSettingsDirty();
}

function updateSettingsDirty() {
  const dirty = settingsDirty();
  $('#save-settings')?.classList.toggle('is-dirty', dirty);
  const hint = $('#settings-dirty');
  if (hint) hint.hidden = !dirty;
}

function askUnsaved() {
  const dialog = $('#unsaved-dialog');
  if (!dialog?.showModal) return Promise.resolve(window.confirm('设置还没保存，要保存吗？') ? 'save' : 'discard');
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue || 'stay'), { once: true });
    dialog.showModal();
  });
}

/** 离开当前设置分页前调用：没有改动直接放行；有改动时问「保存 / 不保存 / 继续编辑」。返回能否离开。 */
export async function leaveSettingsOk() {
  if (state.view !== 'settings' || !settingsDirty()) return true;
  const choice = await askUnsaved();
  if (choice === 'save') return saveSettings();
  if (choice === 'discard') {
    settingsBaseline = null;
    fillSettings();
    markSettingsClean();
    return true;
  }
  return false;
}

$('#settings-form')?.addEventListener('input', (event) => {
  updateSettingsDirty();
  // 换地址时把预设模型也换掉，免得 DeepSeek 的模型名留在别人家的列表里。
  if (event.target.name === 'baseUrl' || event.target.name === 'ollamaUrl') renderModelOptions();
});
$('#settings-form')?.addEventListener('change', (event) => {
  if (event.target.id === 'provider-select') syncProviderFields();
  updateSettingsDirty();
});
window.addEventListener('beforeunload', (event) => {
  if (state.view === 'settings' && settingsDirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

/* ------------------------------- 保存 -------------------------------- */

/** 把表单里的 [name] 字段填成当前设置；有没保存的改动时不覆盖。 */
export function fillSettings() {
  if (!state.settings) return;
  if (!settingsDirty()) {
    $$('[name]', $('#settings-form')).forEach((input) => {
      const value = getPath(state.settings, input.name);
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = value ?? '';
    });
  }
  syncProviderFields();
}

/** 只显示当前运行模式用得到的字段。 */
function syncProviderFields() {
  const provider = $('#provider-select')?.value || 'demo';
  $$('[data-for-provider]').forEach((field) => {
    field.hidden = !field.dataset.forProvider.split(' ').includes(provider);
  });
  renderModelOptions();
}

export async function saveSettings({ silent = false } = {}) {
  const patch = {};
  $$('[name]', $('#settings-form')).forEach((input) => {
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number') value = Number(input.value);
    else value = input.value.trim();
    setPath(patch, input.name, value);
  });
  const button = $('#save-settings');
  if (button) button.disabled = true;
  try {
    const data = await api('/api/settings', { method: 'PUT', body: patch });
    state.settings = data.settings;
    state.workers = data.workers;
    settingsBaseline = null;
    fillSettings();
    markSettingsClean();
    changed('settings', 'workers');
    if (!silent) toast('设置已保存。');
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

$('#save-settings')?.addEventListener('click', () => saveSettings());
$('#settings-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  // 只有表单类分页回车才保存；插件配置等分页有自己的保存按钮。
  if (pageById(state.settingsPage)?.needsSave) saveSettings();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && state.view === 'settings' && pageById(state.settingsPage)?.needsSave) {
    event.preventDefault();
    saveSettings();
  }
});

$('#test-model')?.addEventListener('click', async () => {
  const btn = $('#test-model');
  const out = $('#model-test-result');
  btn.disabled = true;
  out.textContent = '测试中…';
  out.dataset.state = 'pending';
  try {
    if (settingsDirty()) await saveSettings({ silent: true });
    const res = await api('/api/model/test', { method: 'POST' });
    out.textContent = `✓ ${res.model} · ${res.latencyMs}ms · ${res.tokens} tokens`;
    out.dataset.state = 'ok';
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
    out.dataset.state = 'error';
  } finally {
    btn.disabled = false;
  }
});

$('#fetch-models')?.addEventListener('click', async () => {
  const btn = $('#fetch-models');
  const out = $('#model-test-result');
  btn.disabled = true;
  out.textContent = '正在向接口要模型列表…';
  out.dataset.state = 'pending';
  try {
    if (settingsDirty()) await saveSettings({ silent: true });
    const res = await api('/api/model/list', { method: 'POST' });
    const provider = $('#provider-select')?.value === 'ollama' ? 'ollama' : 'openai';
    res.models.forEach((id) => fetchedModels[provider].add(id));
    renderModelOptions();
    out.textContent = `✓ 拿到 ${res.models.length} 个模型，点模型框右侧箭头就能选`;
    out.dataset.state = 'ok';
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
    out.dataset.state = 'error';
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------ 人设的历史 ------------------------------ */

function renderPersonaHistory() {
  const box = $('#persona-history');
  if (!box) return;
  const list = state.mind?.personaHistory || [];
  const current = state.settings?.persona || '';
  box.innerHTML = list.length ? list.map((v, index) => {
    const inUse = v.text === current && list.findIndex((x) => x.text === current) === index;
    return `
      <div class="lrow">
        <div class="lrow-main">
          <b>${esc(v.sourceLabel)}${inUse ? '<span class="badge on">正在用</span>' : ''}</b>
          <small class="wrap">${esc(v.text)}</small>
          <small>${esc(new Date(v.created_at).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}${v.reason ? ` · ${esc(v.reason)}` : ''}</small>
        </div>
        <div class="lrow-actions">${inUse ? '' : `<button type="button" class="btn xs" data-persona-use="${esc(v.id)}">用这一版</button>`}</div>
      </div>`;
  }).join('') : '<p class="note">还没有历史。你改了人设、或者她反思后调整了自己，这里会留底。</p>';
}

$('#persona-history')?.addEventListener('click', async (event) => {
  const use = event.target.closest('[data-persona-use]');
  if (!use) return;
  if (settingsDirty()) {
    toast('先保存或撤销这一页的改动，再切换人设。');
    return;
  }
  use.disabled = true;
  try {
    const data = await api('/api/persona/rollback', { method: 'POST', body: { id: use.dataset.personaUse } });
    state.settings = data.settings;
    state.mind = data.mind;
    settingsBaseline = null;
    fillSettings();
    markSettingsClean();
    changed('settings', 'mind');
    toast('人设已经换回这一版。');
  } catch (err) {
    use.disabled = false;
    toast(err.message);
  }
});

$('#reflect-now')?.addEventListener('click', async (event) => {
  const out = $('#reflect-result');
  out.textContent = '她在回顾这段时间的经历…';
  out.dataset.state = 'pending';
  const { reflectNow } = await import('./memory.js');
  const result = await reflectNow(event.currentTarget);
  if (!result) { out.textContent = ''; return; }
  out.dataset.state = result.skipped ? '' : 'ok';
  out.textContent = result.skipped || [
    result.facts + result.owner ? `记下 ${result.facts + result.owner} 条认识` : '',
    result.self ? `${result.self} 条自我认知` : '',
    result.impressions ? `更新 ${result.impressions} 个印象` : '',
    result.persona?.status === 'applied' ? '调整了人设' : result.persona?.status === 'proposed' ? '在对话里提议调整人设' : result.persona?.status === 'rejected' ? `没改人设：${result.persona.reason}` : ''
  ].filter(Boolean).join('，') || '没有新的收获';
});

/* ------------------------------ 通知通道 ------------------------------ */

function renderChannelBadges() {
  for (const key of ['telegram', 'feishu', 'webhook']) {
    const on = Boolean(state.channels?.[key]);
    const badge = $(`#badge-${key}`);
    if (!badge) continue;
    badge.textContent = on ? '已启用' : '未配置';
    badge.classList.toggle('on', on);
  }
}

$('#test-channel')?.addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    if (settingsDirty()) await saveSettings({ silent: true });
    const data = await api('/api/channels/test', { method: 'POST' });
    const sent = data.deliveries.filter((d) => d.ok && d.channel !== 'in-app');
    toast(sent.length ? `已通过 ${sent.map((s) => s.channel).join(' / ')} 发送。` : '当前没有启用外部通道，已用应用内提醒代替。');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------ 手机与配对 ---------------------------- */

async function loadPairing(force = false) {
  if (state.pairing && !force) {
    renderPairing();
    return;
  }
  try {
    state.pairing = await api('/api/auth/pairing');
    state.pairVisible = false;
    renderPairing();
  } catch { /* 未配对时由全局 401 处理 */ }
}

function renderPairing() {
  if (!state.pairing) return;
  $('#pair-key').textContent = state.pairVisible ? state.pairing.key : '••••-••••-••••-••••-••••';
  $('#pair-url').textContent = state.pairing.url;
  $('#show-pair').textContent = state.pairVisible ? '隐藏' : '显示';
}

$('#show-pair')?.addEventListener('click', () => {
  state.pairVisible = !state.pairVisible;
  renderPairing();
});

$('#copy-pair')?.addEventListener('click', async () => {
  if (!state.pairing) return;
  const ok = await copyText(`静静\n地址：${state.pairing.url}\n配对码：${state.pairing.key}`, '配对信息已复制。');
  if (ok && /127\.0\.0\.1|localhost/.test(state.pairing.url)) {
    toast('手机访问请用局域网或 Tailscale 地址，不要用 127.0.0.1。', 4200);
  }
});

$('#rotate-pair')?.addEventListener('click', async () => {
  if (!state.pairing) return;
  const ok = await ask({ title: '重新生成配对码？', message: '所有手机和浏览器都需要用新配对码重新登录。', okText: '重新生成', danger: true });
  if (!ok) return;
  try {
    const data = await api('/api/auth/rotate', { method: 'POST' });
    state.pairing.key = data.key;
    state.pairVisible = true;
    renderPairing();
    toast('已生成新的配对码，请在所有设备上重新配对。', 4200);
  } catch (err) {
    toast(err.message);
  }
});

$('#copy-install')?.addEventListener('click', async () => {
  const ok = await copyText(location.origin, `安装地址已复制：${location.origin}`);
  if (ok && /127\.0\.0\.1|localhost/.test(location.origin)) toast('手机安装请先换成局域网或 Tailscale 地址。', 4200);
});

$('#logout-btn')?.addEventListener('click', async () => {
  const ok = await ask({ title: '退出这台设备？', message: '退出后需要重新输入配对码。', okText: '退出' });
  if (!ok) return;
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    location.reload();
  }
});

/* ------------------------------ 关于与更新 ---------------------------- */

function fillAbout() {
  $('#about-host').textContent = location.host;
  $('#about-tz').textContent = state.server?.timezone || '—';
  const running = state.server?.version || '—';
  const installed = state.server?.update?.installed;
  const pending = installed && installed.version !== running ? installed : null;
  const pendingText = pending ? ` · 已装 v${pending.version}（重启生效）` : '';
  const brokenText = installed?.broken ? ' · 上次更新启动失败，已回退' : '';
  $('#about-version').textContent = `v${running}${pendingText}${brokenText}`;
}

function renderUpdatePanel(info) {
  const statusEl = $('#update-status');
  const notesEl = $('#update-notes');
  const actionsEl = $('#update-actions');
  const applyBtn = $('#update-apply');
  const rollbackBtn = $('#update-rollback');
  const installed = info?.installed || state.server?.update?.installed || null;
  rollbackBtn.hidden = !installed;
  if (!info) {
    notesEl.hidden = true;
    actionsEl.hidden = true;
    return;
  }
  if (info.error && !info.latest) {
    statusEl.textContent = `检查失败：${info.error}`;
    notesEl.hidden = true;
    actionsEl.hidden = !installed;
    applyBtn.hidden = true;
    return;
  }
  if (info.available && installed && installed.version === info.latest) {
    statusEl.textContent = `新版本 v${info.latest} 已装好，重启服务后生效。`;
    notesEl.hidden = !info.notes;
    notesEl.textContent = info.notes || '';
    actionsEl.hidden = false;
    applyBtn.hidden = true;
    return;
  }
  if (!info.available) {
    statusEl.textContent = info.latest ? `已是最新版本 v${info.current}` : '还没有可用的发布版本';
    notesEl.hidden = true;
    actionsEl.hidden = !installed;
    applyBtn.hidden = true;
    return;
  }
  statusEl.textContent = `发现新版本 v${info.latest}（当前 v${info.current}）`;
  notesEl.hidden = !info.notes;
  notesEl.textContent = info.notes || '';
  actionsEl.hidden = false;
  applyBtn.hidden = false;
}

async function refreshUpdateStatus(force = false) {
  const statusEl = $('#update-status');
  statusEl.textContent = '正在检查 GitHub…';
  try {
    renderUpdatePanel(await api(`/api/update/check${force ? '?force=1' : ''}`));
  } catch (err) {
    statusEl.textContent = `检查失败：${err.message}`;
  }
}

async function runUpdate(path, pending) {
  const applyBtn = $('#update-apply');
  const statusEl = $('#update-status');
  applyBtn.disabled = true;
  statusEl.textContent = pending;
  try {
    const data = await api(path, { method: 'POST' });
    statusEl.textContent = data.note ? `${data.note}（v${data.version}）` : `已安装 v${data.version}，重启服务后生效。`;
    toast(`v${data.version} 已就绪，重启服务后生效`);
    applyBtn.hidden = true;
    $('#update-rollback').hidden = false;
  } catch (err) {
    statusEl.textContent = `操作失败：${err.message}`;
    toast(err.message);
  } finally {
    applyBtn.disabled = false;
  }
}

$('#update-check')?.addEventListener('click', () => refreshUpdateStatus(true));
$('#update-apply')?.addEventListener('click', () => runUpdate('/api/update/apply', '正在下载并校验更新包…'));
$('#update-rollback')?.addEventListener('click', async () => {
  const ok = await ask({ title: '回退到上一版本？', message: '回退的是代码，数据不动；重启服务后生效。', okText: '回退' });
  if (ok) runUpdate('/api/update/rollback', '正在回退到上一版本…');
});

/* ------------------------------- 工作区 ------------------------------- */

function renderWorkspaces() {
  const list = state.settings?.workspaces || [];
  const container = $('#workspace-list');
  if (!container) return;
  container.innerHTML = list.map((ws) => `
    <div class="workspace-row" data-ws-row="${esc(ws.id)}">
      <label class="field"><span>名称</span><input data-ws-name value="${esc(ws.name)}" /></label>
      <label class="field"><span>目录</span><input data-ws-path value="${esc(ws.path)}" placeholder="/Users/you/code/project" /></label>
      <button type="button" class="btn" data-ws-pick title="用 Finder 选择文件夹">${icon('folder', 'sm')}选择</button>
      <button type="button" class="icon-btn danger" data-ws-remove title="删除" ${list.length <= 1 ? 'disabled' : ''}>${icon('trash')}</button>
    </div>`).join('') || '<p class="note">还没有工作区。</p>';
  const select = $('#default-workspace');
  if (select) {
    select.innerHTML = list.map((ws) => `<option value="${esc(ws.id)}" ${state.settings.defaultWorkspaceId === ws.id ? 'selected' : ''}>${esc(ws.name)}</option>`).join('');
  }
}

/** 从输入框读当前工作区列表（含还没保存的修改）。 */
function readWorkspaceRows() {
  return $$('#workspace-list .workspace-row').map((row) => ({
    id: row.dataset.wsRow,
    name: row.querySelector('[data-ws-name]')?.value.trim() || '',
    path: row.querySelector('[data-ws-path]')?.value.trim() || ''
  }));
}

async function saveWorkspaces() {
  try {
    const list = [];
    const ids = new Set();
    for (const ws of readWorkspaceRows()) {
      if (!ws.name || !ws.path) throw new Error('工作区的名称和目录都要填');
      if (ids.has(ws.id)) continue;
      ids.add(ws.id);
      list.push(ws);
    }
    if (!list.length) throw new Error('至少保留一个工作区');
    const data = await api('/api/settings', {
      method: 'PUT',
      body: { workspaces: list, defaultWorkspaceId: $('#default-workspace')?.value || list[0].id }
    });
    state.settings = data.settings;
    renderWorkspaces();
    changed('settings');
    toast('工作区已保存。');
  } catch (err) {
    toast(err.message);
  }
}

$('#add-workspace')?.addEventListener('click', () => {
  if (!state.settings) return;
  // 先把输入框里改了的内容收回来，再加一行，避免重画时丢掉。
  state.settings.workspaces = [...readWorkspaceRows(), { id: `ws_${Date.now().toString(36)}`, name: '新工作区', path: '' }];
  renderWorkspaces();
  $('#workspace-list .workspace-row:last-child [data-ws-path]')?.focus();
});

$('#workspace-list')?.addEventListener('click', async (event) => {
  const pick = event.target.closest('[data-ws-pick]');
  if (pick) {
    const input = pick.closest('.workspace-row')?.querySelector('[data-ws-path]');
    if (!input) return;
    pick.disabled = true;
    try {
      const data = await pickFolder();
      input.value = data.path;
      toast('已选择文件夹，记得点「保存工作区」。');
    } catch (err) {
      toast(err.message);
    } finally {
      pick.disabled = false;
    }
    return;
  }
  const remove = event.target.closest('[data-ws-remove]');
  if (!remove) return;
  const id = remove.closest('.workspace-row')?.dataset.wsRow;
  const rows = readWorkspaceRows();
  if (rows.length <= 1) return;
  state.settings.workspaces = rows.filter((item) => item.id !== id);
  if (state.settings.defaultWorkspaceId === id) state.settings.defaultWorkspaceId = state.settings.workspaces[0].id;
  renderWorkspaces();
});

$('#save-workspaces')?.addEventListener('click', saveWorkspaces);

/* ------------------------------- 订阅 -------------------------------- */

on('settings', () => {
  if (state.view !== 'settings') return;
  fillSettings();
  renderSettingsNav();
  if (state.settingsPage && state.settingsPage !== 'workspaces') renderPage();
});
on('mind', () => {
  if (state.view === 'settings' && state.settingsPage === 'model') renderPersonaHistory();
});

for (const topic of ['workers', 'plugins', 'rules', 'workflows', 'workerRules', 'stats', 'channels']) {
  on(topic, () => {
    if (state.view !== 'settings') return;
    renderSettingsNav();
    const affects = {
      workers: ['worker'], workerRules: ['worker'], plugins: ['plugins'], rules: ['rules'],
      workflows: ['workflows', 'rules'], channels: ['channels'], stats: []
    }[topic];
    if (affects.includes(state.settingsPage)) renderPage();
  });
}

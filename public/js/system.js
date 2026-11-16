// 设置 → 运行状态 / 数据与归档（原「管理」页）。
import {
  $, state, on, esc, timeAgo, toast, api, upsertTask, changed,
  formatUptime, tokensText, sizeText, countsText, STATUS_LABEL
} from './core.js';
import { ask } from './ui.js';

/* ------------------------------ 运行状态 ------------------------------ */

export async function loadStatus() {
  try {
    const [overview, logs] = await Promise.all([api('/api/admin/overview'), api('/api/admin/logs?limit=200')]);
    state.adminOverview = overview;
    state.adminLogs = logs.logs || [];
    if (overview.stats) state.stats = overview.stats;
    renderOverview();
    renderLogs();
  } catch (err) {
    toast(err.message);
  }
}

function renderOverview() {
  const o = state.adminOverview;
  const box = $('#admin-overview');
  if (!o || !box) return;
  const stats = state.stats || o.stats || {};
  const paused = Boolean(stats.paused ?? o.settings?.queuePaused);
  const plugins = o.plugins || [];
  const workers = Object.values(o.workers || {});
  box.innerHTML = `
    <div class="stat"><div class="stat-value">${formatUptime(o.uptime)}</div><div class="stat-label">运行时长 · v${esc(o.version || '')}</div></div>
    <div class="stat ${paused ? 'warm' : 'accent'}"><div class="stat-value">${stats.active ?? 0}</div><div class="stat-label">${paused ? '已暂停 · 队列积压' : '进行中的任务'}</div></div>
    <div class="stat"><div class="stat-value">${stats.doneToday ?? 0}</div><div class="stat-label">今日完成</div></div>
    <div class="stat"><div class="stat-value">${tokensText(stats.tokens)}</div><div class="stat-label">累计 tokens</div></div>
    <div class="stat"><div class="stat-value">${stats.memories ?? 0}</div><div class="stat-label">条记忆</div></div>
    <div class="stat"><div class="stat-value">${workers.filter((w) => w.available).length}<small>/ ${workers.length}</small></div><div class="stat-label">可用 Worker</div></div>
    <div class="stat"><div class="stat-value">${plugins.filter((p) => p.enabled).length}<small>/ ${plugins.length}</small></div><div class="stat-label">启用的来源</div></div>
    <div class="stat"><div class="stat-value">${((o.db?.size || 0) / 1024 / 1024).toFixed(1)}<small>MB</small></div><div class="stat-label">数据库 · ${o.sse ?? 0} 个实时连接</div></div>`;
}

function renderLogs() {
  const el = $('#admin-logs');
  if (!el) return;
  el.textContent = (state.adminLogs || [])
    .map((line) => `${line.at.slice(11, 19)} ${line.level.toUpperCase().padEnd(5)} ${line.message}`)
    .join('\n') || '暂无日志。';
  el.scrollTop = el.scrollHeight;
}

$('#refresh-logs')?.addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    const data = await api('/api/admin/logs?limit=200');
    state.adminLogs = data.logs || [];
    renderLogs();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

on('stats', () => {
  if (state.view === 'settings' && state.settingsPage === 'status') renderOverview();
});

/* ------------------------------ 数据与归档 ---------------------------- */

export async function loadArchives() {
  try {
    state.archives = await api('/api/admin/archives');
    renderArchives();
  } catch (err) {
    toast(err.message);
  }
}

function renderArchives() {
  const data = state.archives;
  if (!data) return;
  const enabled = $('#archive-enabled');
  const days = $('#archive-days');
  if (enabled) enabled.checked = data.settings?.enabled !== false;
  if (days && document.activeElement !== days) days.value = data.settings?.afterDays || 90;
  const last = data.lastRun;
  $('#archive-info').textContent = [
    `现在可归档：${countsText(data.pending)}`,
    last ? `上次${last.reason === 'auto' ? '自动' : '手动'}归档：${timeAgo(last.at)}，${last.file ? countsText(last.counts) : '没有需要归档的数据'}` : '还没有归档过'
  ].join(' · ');
  $('#archive-list').innerHTML = (data.archives || []).map((a) => `
    <div class="lrow">
      <div class="lrow-main"><b>${esc(a.name)}</b><small>${esc(`${timeAgo(a.createdAt)} · ${sizeText(a.size)} · ${countsText(a.counts)}`)}</small></div>
      <div class="lrow-actions"><a class="btn xs" href="/api/admin/archives/${encodeURIComponent(a.name)}" download>下载</a></div>
    </div>`).join('');
}

$('#archive-save')?.addEventListener('click', async () => {
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      body: { archive: { enabled: Boolean($('#archive-enabled')?.checked), afterDays: Number($('#archive-days')?.value) || 90 } }
    });
    state.settings = data.settings;
    await loadArchives();
    toast('归档设置已保存。');
  } catch (err) {
    toast(err.message);
  }
});

$('#archive-now')?.addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  const days = Number($('#archive-days')?.value) || state.archives?.settings?.afterDays || 90;
  const ok = await ask({ title: '现在归档？', message: `把已结束超过 ${days} 天的任务和旧对话打包归档，并从数据库清理。归档文件会保留在数据目录里。`, okText: '归档' });
  if (!ok) return;
  btn.disabled = true;
  try {
    const data = await api('/api/admin/archive', { method: 'POST', body: { days } });
    toast(data.result.file ? `已归档：${countsText(data.result.counts)}` : '没有需要归档的数据。', 3600);
    await loadArchives();
    const tasks = await api('/api/tasks');
    state.tasks = tasks.tasks;
    state.stats = tasks.stats;
    changed('tasks', 'stats');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

let archiveSearchTimer = null;
$('#archive-search')?.addEventListener('input', (event) => {
  clearTimeout(archiveSearchTimer);
  const q = event.target.value.trim();
  archiveSearchTimer = setTimeout(async () => {
    const box = $('#archive-results');
    if (!q) { box.innerHTML = ''; return; }
    try {
      const data = await api(`/api/admin/archives?q=${encodeURIComponent(q)}`);
      box.innerHTML = data.results.length ? data.results.map((r) => `
        <div class="lrow">
          <div class="lrow-main"><b>${esc(r.task.title)}</b><small>${esc(`${STATUS_LABEL[r.task.status] || r.task.status} · ${r.task.id} · ${r.events.length} 条事件 · ${r.archive}`)}</small></div>
          <div class="lrow-actions"><button type="button" class="btn xs" data-archive-restore="${esc(r.archive)}" data-task="${esc(r.task.id)}">恢复</button></div>
        </div>`).join('') : '<p class="note">归档里没有找到。</p>';
    } catch (err) {
      toast(err.message);
    }
  }, 300);
});

$('#archive-results')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-archive-restore]');
  if (!button) return;
  button.disabled = true;
  try {
    const data = await api(`/api/admin/archives/${encodeURIComponent(button.dataset.archiveRestore)}/restore`, { method: 'POST', body: { taskId: button.dataset.task } });
    if (data.task) {
      upsertTask(data.task);
      changed('tasks');
    }
    toast(`已恢复任务「${data.task?.title || button.dataset.task}」，可以在任务页看到。`, 3600);
  } catch (err) {
    button.disabled = false;
    toast(err.message);
  }
});

// 设置 → 工作流程 / 自动化。
import { $, state, changed, esc, timeAgo, toast, api, workerLabel, workerIds, workflowById, WORKFLOW_STATUS_LABEL } from './core.js';
import { icon, openDialog, ask } from './ui.js';

/* ------------------------------ 工作流程 ------------------------------ */

function workflowMeta(w) {
  const parts = [w.source === 'learned' ? '习惯' : '文档', WORKFLOW_STATUS_LABEL[w.status] || w.status];
  if (w.when) parts.push(`触发：${w.when}`);
  else if (w.source === 'doc') parts.push('按名称匹配');
  if (w.worker) parts.push(`→ ${workerLabel(w.worker)}`);
  if (w.stats?.uses) parts.push(`用过 ${w.stats.uses} 次，成功 ${w.stats.successes}`);
  if (w.answers?.length) parts.push(`记了 ${w.answers.length} 个选择${w.auto ? '，自动拍板' : ''}`);
  if (w.error) parts.push(`⚠ ${w.error}`);
  return parts.join(' · ');
}

export function renderWorkflows() {
  const box = $('#workflow-list');
  if (!box) return;
  const data = state.workflows || {};
  const list = [...(data.workflows || [])].sort((a, b) => (a.status === 'candidate' ? -1 : 0) - (b.status === 'candidate' ? -1 : 0));
  box.innerHTML = list.length ? list.map((w) => {
    const id = esc(w.id);
    return `
      <div class="lrow ${w.status === 'active' || w.status === 'candidate' ? '' : 'is-off'}" title="${esc(w.file)}">
        <span class="glyph">流</span>
        <div class="lrow-main">
          <b>${esc(w.name)}${w.status === 'candidate' ? '<span class="badge warn">待确认</span>' : ''}</b>
          <small class="${w.error ? 'is-error' : ''}">${esc(workflowMeta(w))}</small>
        </div>
        <div class="lrow-actions">
          ${w.answers?.length ? `<label class="switch-inline" title="执行中遇到记过的问题时自动拍板"><span>自动拍板</span><input type="checkbox" class="switch" data-workflow-auto="${id}" ${w.auto ? 'checked' : ''} /></label>` : ''}
          <button type="button" class="btn xs" data-action="workflow-open" data-id="${id}">${w.editable ? '编辑' : '查看'}</button>
          ${w.status === 'active'
            ? `<button type="button" class="btn xs" data-action="workflow-status" data-id="${id}" data-status="disabled">停用</button>`
            : `<button type="button" class="btn xs primary" data-action="workflow-status" data-id="${id}" data-status="active">${w.status === 'candidate' ? '保存为习惯' : '启用'}</button>`}
          ${w.editable ? `<button type="button" class="icon-btn sm danger" data-action="workflow-delete" data-id="${id}" title="删除">${icon('trash', 'sm')}</button>` : ''}
        </div>
      </div>`;
  }).join('') : '<p class="note">还没有工作流程。可以新建一个，或者在下面指定放流程文档的文件夹。</p>';
  const errors = data.errors || [];
  $('#workflow-errors').innerHTML = errors.length
    ? `<p class="note" style="margin-top:10px">${errors.map((e) => esc(`${e.dir ? `${e.dir}：` : ''}${e.error}`)).join('<br>')}</p>`
    : '';
  $('#workflow-root').textContent = data.root || '';
  const dirs = $('#workflow-dirs');
  if (dirs && document.activeElement !== dirs) dirs.value = (state.settings?.workflowDirs || []).join('\n');
}

function setWorkflows(data) {
  state.workflows = data;
  changed('workflows');
}

async function setWorkflowStatus(id, status) {
  try {
    setWorkflows(await api(`/api/workflows/${id}/status`, { method: 'POST', body: { status } }));
    toast(status === 'active' ? '已保存为习惯，同类请求会按它执行。' : status === 'dismissed' ? '已忽略，同类任务不会再提议。' : '已更新。');
  } catch (err) {
    toast(err.message);
  }
}

async function openWorkflow(id) {
  let data;
  try {
    data = await api(`/api/workflows/${id}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  const w = data.workflow;
  openDialog({
    title: w.name,
    desc: w.editable
      ? `文件：${w.file}\n头部的 when 是触发词（逗号分隔），worker / workspace 可选，正文是步骤。`
      : `这是你文件夹里的文件：${w.file}\n静静只读不改，请用编辑器修改，保存后会自动生效。`,
    body: `<label class="field"><textarea name="raw" rows="16" class="mono" ${w.editable ? '' : 'readonly'}>${esc(data.raw)}</textarea></label>`,
    wide: true,
    readonly: !w.editable,
    okText: '保存',
    onSubmit: async (values) => {
      setWorkflows(await api(`/api/workflows/${id}`, { method: 'PUT', body: { raw: values.raw } }));
      toast('工作流程已保存。');
    }
  });
}

$('#add-workflow')?.addEventListener('click', () => {
  const workers = Object.entries(state.workers || {}).filter(([, w]) => w.available);
  openDialog({
    title: '新建工作流程',
    desc: '保存到静静的工作流程目录。命中触发词的请求会直接按它派活，步骤会附进交给 Worker 的指令。',
    body: `
      <div class="grid-2">
        <label class="field"><span>流程名</span><input name="name" placeholder="例如：写周报" required /></label>
        <label class="field"><span>触发词</span><input name="when" placeholder="周报, weekly（逗号分隔，支持正则）" /></label>
        <label class="field"><span>Worker</span><select name="worker"><option value="">自动（按能力挑）</option>
          ${workers.map(([id, w]) => `<option value="${esc(id)}">${esc(w.label || id)}</option>`).join('')}</select></label>
        <label class="field"><span>工作区</span><select name="workspace"><option value="">自动</option>
          ${(state.settings?.workspaces || []).map((ws) => `<option value="${esc(ws.name)}">${esc(ws.name)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>步骤</span><textarea name="steps" rows="6" placeholder="1. 汇总本周完成的任务，按项目分组&#10;2. 每个项目写一句结论和下周计划&#10;3. 保存为 周报-日期.md"></textarea></label>`,
    okText: '创建',
    onSubmit: async (values) => {
      setWorkflows(await api('/api/workflows', { method: 'POST', body: values }));
      toast('工作流程已创建。');
    }
  });
});

$('#workflow-list')?.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-workflow-auto]');
  if (!input) return;
  try {
    setWorkflows(await api(`/api/workflows/${input.dataset.workflowAuto}/auto`, { method: 'POST', body: { auto: input.checked } }));
    toast(input.checked ? '已开启：执行中遇到记过的问题会按习惯自动拍板。' : '已关闭自动拍板。');
  } catch (err) {
    input.checked = !input.checked;
    toast(err.message);
  }
});

$('#reload-workflows')?.addEventListener('click', async () => {
  try {
    setWorkflows(await api('/api/workflows/reload', { method: 'POST' }));
    toast(`已读取 ${state.workflows.workflows.length} 个工作流程。`);
  } catch (err) {
    toast(err.message);
  }
});

$('#save-workflow-dirs')?.addEventListener('click', async () => {
  const dirs = ($('#workflow-dirs')?.value || '').split('\n').map((line) => line.trim()).filter(Boolean);
  try {
    const data = await api('/api/settings', { method: 'PUT', body: { workflowDirs: dirs } });
    state.settings = data.settings;
    setWorkflows(await api('/api/workflows/reload', { method: 'POST' }));
    toast(`已保存，读取到 ${state.workflows.workflows.length} 个工作流程。`);
  } catch (err) {
    toast(err.message);
  }
});

// 对话里的流程卡片和设置里的流程列表共用这些动作。
document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  if (action === 'workflow-status') await setWorkflowStatus(id, el.dataset.status);
  else if (action === 'workflow-open') await openWorkflow(id);
  else if (action === 'workflow-delete') {
    const w = workflowById(id);
    const ok = await ask({ title: `删除工作流程「${w?.name || ''}」？`, message: '文件会一起删除。', okText: '删除', danger: true });
    if (!ok) return;
    try {
      setWorkflows(await api(`/api/workflows/${id}`, { method: 'DELETE' }));
      toast('工作流程已删除。');
    } catch (err) {
      toast(err.message);
    }
  }
});

/* ------------------------------- 自动化 ------------------------------- */

function ruleTriggerText(trigger = {}) {
  if (trigger.type === 'interval') return `每 ${trigger.minutes || 60} 分钟`;
  return `每天 ${trigger.at || '08:00'}`;
}

function workflowName(id) {
  return workflowById(id)?.name || id;
}

function ruleActionText(action = {}) {
  if (action.kind === 'scan') {
    const plugin = (state.plugins || []).find((item) => item.id === action.source);
    const parts = [`扫描「${plugin?.label || action.source}」`];
    if (action.workflow) parts.push(`按流程「${workflowName(action.workflow)}」`);
    if (action.worker) parts.push(`交给「${workerLabel(action.worker)}」`);
    return parts.join('，');
  }
  const parts = [`创建任务「${action.title || '（用自动化名称）'}」`];
  if (action.worker) parts.push(`交给「${workerLabel(action.worker)}」`);
  if (action.workflow) parts.push(`按流程「${workflowName(action.workflow)}」`);
  return parts.join('，');
}

function ruleForm(rule = {}) {
  const trigger = rule.trigger || { type: 'daily', at: '08:00' };
  const action = rule.action || { kind: 'task', title: '', prompt: '', worker: '', cwd: '', workflow: '' };
  const isScan = action.kind === 'scan';
  const plugins = (state.plugins || []).filter((item) => ['poll', 'manual'].includes(item.type || 'poll'));
  const flows = state.workflows?.workflows || [];
  return `
    <label class="field"><span>名称</span><input name="name" value="${esc(rule.name || '')}" placeholder="例如：每天 2 点修 TAPD bug" /></label>
    <div class="grid-2">
      <label class="field"><span>什么时候</span>
        <select name="trigger_type">
          <option value="daily" ${trigger.type === 'interval' ? '' : 'selected'}>每天固定时间</option>
          <option value="interval" ${trigger.type === 'interval' ? 'selected' : ''}>每隔一段时间</option>
        </select>
      </label>
      <label class="field" data-trigger-daily><span>时间</span><input name="at" type="time" value="${esc(trigger.at || '08:00')}" /></label>
      <label class="field" data-trigger-interval><span>间隔（分钟，1–1440）</span><input name="minutes" type="number" min="1" max="1440" value="${esc(String(trigger.minutes || 60))}" /></label>
    </div>
    <label class="field"><span>做什么</span>
      <select name="action_kind">
        <option value="task" ${isScan ? '' : 'selected'}>创建一个任务</option>
        <option value="scan" ${isScan ? 'selected' : ''}>扫描一个来源</option>
      </select>
    </label>
    <div class="dialog-body-group" data-action-task>
      <label class="field"><span>任务名（可空）</span><input name="title" value="${esc(action.title || '')}" placeholder="默认用自动化名称" /></label>
      <label class="field"><span>给 Worker 的指令</span><textarea name="prompt" rows="4" placeholder="例如：用 tapd-cli 查我名下未完成的 bug，按「TAPD bug 修复」流程处理，最多 2 个。">${esc(action.prompt || '')}</textarea></label>
      <div class="grid-2">
        <label class="field"><span>工作流程（可空）</span><select name="task_workflow"><option value="">不指定</option>${flows.map((flow) => `<option value="${esc(flow.id)}" ${action.workflow === flow.id ? 'selected' : ''}>${esc(flow.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Worker</span><select name="task_worker"><option value="">自动（最便宜的文本 Worker）</option>${workerIds().map((id) => `<option value="${esc(id)}" ${action.worker === id ? 'selected' : ''}>${esc(workerLabel(id))}</option>`).join('')}</select></label>
        <label class="field span-2"><span>工作区</span><select name="cwd"><option value="">默认工作区</option>${(state.settings?.workspaces || []).map((ws) => `<option value="${esc(ws.path)}" ${action.cwd === ws.path ? 'selected' : ''}>${esc(ws.name)}</option>`).join('')}</select></label>
      </div>
    </div>
    <div class="dialog-body-group" data-action-scan>
      <label class="field"><span>来源插件</span><select name="source"><option value="">请选择</option>${plugins.map((plugin) => `<option value="${esc(plugin.id)}" ${action.source === plugin.id ? 'selected' : ''}>${esc(plugin.label || plugin.id)}</option>`).join('')}</select></label>
      <div class="grid-2">
        <label class="field"><span>新条目按流程处理（可空）</span><select name="scan_workflow"><option value="">照常判断，不强制</option>${flows.map((flow) => `<option value="${esc(flow.id)}" ${action.workflow === flow.id ? 'selected' : ''}>${esc(flow.name)}</option>`).join('')}</select></label>
        <label class="field"><span>强制 Worker（可空）</span><select name="scan_worker"><option value="">跟随流程 / 分配规则</option>${workerIds().map((id) => `<option value="${esc(id)}" ${action.worker === id ? 'selected' : ''}>${esc(workerLabel(id))}</option>`).join('')}</select></label>
      </div>
    </div>
    <label class="switch-row"><span><b>启用</b><small>关掉后保留配置，但到点不会运行。</small></span><input type="checkbox" class="switch" name="enabled" ${rule.enabled === false ? '' : 'checked'} /></label>`;
}

function openRuleDialog(rule = null) {
  openDialog({
    title: rule ? '编辑自动化' : '新建自动化',
    desc: '到点自动执行：建一个任务，或把某个来源扫一遍、按流程处理新条目。扫描只处理没见过的新条目，不会重复建卡。',
    body: ruleForm(rule || {}),
    okText: '保存',
    onSubmit: async (values) => {
      if (!values.name.trim()) throw new Error('给这条自动化起个名字');
      if (values.action_kind === 'scan' && !values.source) throw new Error('选一个要扫描的来源');
      const body = {
        ...(rule?.id ? { id: rule.id } : {}),
        name: values.name,
        enabled: Boolean(values.enabled),
        trigger: { type: values.trigger_type, at: values.at, minutes: Number(values.minutes) },
        action: values.action_kind === 'scan'
          ? { kind: 'scan', source: values.source, workflow: values.scan_workflow, worker: values.scan_worker }
          : { kind: 'task', title: values.title, prompt: values.prompt, workflow: values.task_workflow, worker: values.task_worker, cwd: values.cwd }
      };
      const data = await api('/api/rules', { method: 'POST', body });
      state.rules = data.rules;
      changed('rules');
      toast('自动化已保存。');
    }
  });
  const body = $('#dialog-body');
  const sync = () => {
    const interval = body.querySelector('[name="trigger_type"]').value === 'interval';
    body.querySelector('[data-trigger-daily]').hidden = interval;
    body.querySelector('[data-trigger-interval]').hidden = !interval;
    const scan = body.querySelector('[name="action_kind"]').value === 'scan';
    body.querySelector('[data-action-task]').hidden = scan;
    body.querySelector('[data-action-scan]').hidden = !scan;
  };
  body.querySelectorAll('[name="trigger_type"], [name="action_kind"]').forEach((el) => el.addEventListener('change', sync));
  sync();
}

export function renderRules() {
  const box = $('#rules-list');
  if (!box) return;
  const list = state.rules || [];
  box.innerHTML = list.map((r) => {
    const id = esc(r.id);
    const failed = r.last_status === 'error';
    const status = failed ? ' · 上次失败' : r.last_run ? ` · 上次 ${timeAgo(r.last_run)}` : '';
    return `
      <div class="lrow ${r.enabled ? '' : 'is-off'}">
        <span class="glyph">${icon('clock')}</span>
        <div class="lrow-main">
          <b>${esc(r.name)}${failed ? '<span class="badge err">上次失败</span>' : ''}</b>
          <small>${esc(ruleTriggerText(r.trigger))} · ${esc(ruleActionText(r.action))}${esc(failed ? '' : status)}</small>
          ${r.last_summary ? `<small class="wrap ${failed ? 'is-error' : ''}">${esc(r.last_summary)}</small>` : ''}
        </div>
        <div class="lrow-actions">
          <button type="button" class="btn xs" data-rule-run="${id}" title="不等时间，现在跑一次">${icon('play', 'sm')}运行</button>
          <button type="button" class="icon-btn sm" data-rule-edit="${id}" title="编辑">${icon('edit', 'sm')}</button>
          <button type="button" class="icon-btn sm danger" data-rule-delete="${id}" title="删除">${icon('trash', 'sm')}</button>
          <input type="checkbox" class="switch" data-rule-toggle="${id}" ${r.enabled ? 'checked' : ''} aria-label="启用" />
        </div>
      </div>`;
  }).join('') || '<div class="empty"><p>还没有自动化。点「新建自动化」加一条，比如每天 8 点汇总 TAPD 待办。</p></div>';
}

$('#rules-list')?.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-rule-toggle]');
  if (!input) return;
  try {
    const data = await api(`/api/rules/${input.dataset.ruleToggle}/toggle`, { method: 'POST', body: { enabled: input.checked } });
    state.rules = data.rules;
    changed('rules');
    toast(input.checked ? '自动化已启用。' : '自动化已暂停。');
  } catch (err) {
    input.checked = !input.checked;
    toast(err.message);
  }
});

$('#rules-list')?.addEventListener('click', async (event) => {
  const run = event.target.closest('[data-rule-run]');
  if (run) {
    run.disabled = true;
    try {
      const data = await api(`/api/rules/${run.dataset.ruleRun}/run`, { method: 'POST' });
      state.rules = data.rules;
      changed('rules');
      toast(data.result?.summary || '已经跑完了。');
    } catch (err) {
      toast(err.message);
    } finally {
      run.disabled = false;
    }
    return;
  }
  const edit = event.target.closest('[data-rule-edit]');
  if (edit) {
    openRuleDialog((state.rules || []).find((rule) => rule.id === edit.dataset.ruleEdit));
    return;
  }
  const del = event.target.closest('[data-rule-delete]');
  if (del) {
    const ok = await ask({ title: '删除这条自动化？', okText: '删除', danger: true });
    if (!ok) return;
    try {
      const data = await api(`/api/rules/${del.dataset.ruleDelete}`, { method: 'DELETE' });
      state.rules = data.rules;
      changed('rules');
      toast('自动化已删除。');
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#add-rule')?.addEventListener('click', () => openRuleDialog());

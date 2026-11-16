import { db, now, uid, getSettings } from './db.js';
import { bus } from './events.js';
import * as plugins from './plugins.js';
import { matchWorkerRule } from './worker-rules.js';
import { postAssistant } from './router.js';
import { chat as llmChat } from './llm.js';
import * as scheduler from './scheduler.js';

const MAX_ITEMS_PER_RUN = 10;
const running = new Set();
const lifecycles = new Map();
let timer = null;

const ACTION_RE = /(请|麻烦|确认|回复|截止|合同|发票|面试|邀请|会议|评审|报名|到期|续费|urgent|action required|deadline|due|asap)/i;

const truncate = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));

function alreadySeen(source, externalId) {
  return Boolean(db.prepare('SELECT 1 AS x FROM source_items WHERE source = ? AND external_id = ?').get(source, externalId));
}

function workspaceFor(plugin) {
  const settings = getSettings();
  const list = Array.isArray(settings.workspaces) ? settings.workspaces : [];
  const chosen = list.find((item) => item.id === plugin.workspaceId)
    || list.find((item) => item.id === settings.defaultWorkspaceId)
    || list[0];
  return {
    id: chosen?.id || 'default',
    name: chosen?.name || '默认工作区',
    path: chosen?.path || settings.defaultCwd
  };
}

function recordItem(source, item, status, taskId = null, reason = null) {
  db.prepare(`
    INSERT INTO source_items(id, source, external_id, title, summary, status, task_id, url, occurred_at, decision_reason, event_type, hops, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source, external_id) DO UPDATE SET
      status = excluded.status,
      task_id = excluded.task_id,
      url = excluded.url,
      occurred_at = excluded.occurred_at,
      decision_reason = excluded.decision_reason,
      event_type = excluded.event_type,
      hops = excluded.hops
  `).run(
    uid('si_'), source, item.externalId, truncate(item.title, 120), truncate(item.content, 500),
    status, taskId, item.url || null, item.occurredAt || null, reason ? truncate(reason, 200) : null,
    item.eventType || null, item.hops || 0, now()
  );
}

/**
 * 插件只能交“数据”，不能指定任务行为。
 * 核心在这里收口字段：未知字段直接丢弃。
 */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const externalId = String(raw.externalId || '').trim();
  const title = String(raw.title || raw.name || '').trim();
  const content = String(raw.content || raw.summary || '').trim();
  if (!externalId || (!title && !content)) return null;
  const kind = ['email', 'agenda', 'note'].includes(raw.kind)
    ? raw.kind
    : ['email', 'agenda', 'note'].includes(raw.category)
      ? raw.category
      : 'note';
  let occurredAt = null;
  if (raw.occurredAt) {
    const date = new Date(raw.occurredAt);
    if (!Number.isNaN(date.getTime())) occurredAt = date.toISOString();
  }
  return {
    externalId,
    kind,
    eventType: String(raw.eventType || raw.meta?.eventType || '').slice(0, 120),
    groupKey: String(raw.groupKey || raw.meta?.groupKey || '').slice(0, 200),
    hops: Math.max(0, Math.min(64, Number(raw.hops ?? raw.meta?.hops ?? 0) || 0)),
    title: title.slice(0, 200),
    content,
    url: raw.url ? String(raw.url).slice(0, 2000) : '',
    occurredAt,
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
  };
}

export function recentItems(source, limit = 20) {
  const rows = source
    ? db.prepare('SELECT * FROM source_items WHERE source = ? ORDER BY created_at DESC LIMIT ?').all(source, limit)
    : db.prepare('SELECT * FROM source_items ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows;
}

/* ----------------------------- 判断：要不要动手 ---------------------------- */

function heuristicDecision(item, index, pluginName) {
  const text = `${item.title}\n${item.content}`;
  const actionable = item.kind === 'agenda' ? true : ACTION_RE.test(text);
  return {
    index,
    actionable,
    priority: item.kind === 'agenda' ? 2 : 2,
    title: truncate(item.title || '未命名事项', 26),
    reason: actionable ? '关键词显示这条需要跟进' : '没有发现需要动手的信号',
    prompt: [
      `这是从「${pluginName}」发现的一条待处理事项。`,
      '请阅读后判断下一步，给出具体行动；如果是需要回复的邮件，直接起草一段可发送的回复草稿。',
      '',
      `标题：${item.title}`,
      item.content ? `内容：\n${item.content}` : ''
    ].join('\n')
  };
}

async function decide(items, pluginName) {
  const settings = getSettings();
  if (settings.provider === 'demo' || !items.length) {
    return items.map((item, index) => heuristicDecision(item, index, pluginName));
  }
  const payload = items.map((item, index) => ({
    index,
    kind: item.kind || 'note',
    title: truncate(item.title, 120),
    url: item.url || '',
    occurredAt: item.occurredAt || null,
    meta: item.meta || {},
    content: truncate(item.content, 1200)
  }));
  const system = [
    '你是「静静」的前台。静静运行在用户的个人电脑上，负责替用户发现需要处理的事情。',
    '现在给你一批来自来源插件的新条目，请判断每一条是否需要用户采取行动，并给出执行提示。',
    '只输出 JSON，不要解释。结构：',
    '{"items":[{"index":0,"actionable":true,"priority":2,"title":"不超过24字的任务名","reason":"不超过40字，说明为什么需要/不需要行动","prompt":"给执行助手的完整中文指令，包含必要背景"}]}',
    '判断标准：广告、营销、自动通知、订阅摘要、日历取消 → actionable=false；',
    '需要回复、有截止时间、要确认、要准备会议/行程、涉及合同/发票/面试 → actionable=true。',
    `当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}。`
  ].join('\n');
  try {
    const res = await llmChat({
      system,
      messages: [{ role: 'user', content: `来源插件：${pluginName}\n\n条目：\n${JSON.stringify(payload, null, 2)}` }],
      json: true,
      temperature: 0.1,
      maxTokens: 1600
    });
    const start = res.text.indexOf('{');
    const end = res.text.lastIndexOf('}');
    const parsed = JSON.parse(res.text.slice(start, end + 1));
    const byIndex = new Map();
    for (const entry of parsed.items || []) {
      if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= items.length) continue;
      byIndex.set(entry.index, {
        index: entry.index,
        actionable: Boolean(entry.actionable),
        priority: Math.min(3, Math.max(1, Number(entry.priority) || 2)),
        title: truncate(String(entry.title || items[entry.index].title), 26),
        reason: truncate(String(entry.reason || ''), 80),
        prompt: String(entry.prompt || '')
      });
    }
    return items.map((item, index) => byIndex.get(index) || heuristicDecision(item, index, pluginName));
  } catch (err) {
    console.warn(`[discovery] 模型判断失败，回退到关键词：${err.message}`);
    return items.map((item, index) => heuristicDecision(item, index, pluginName));
  }
}

/* ------------------------------- 执行一轮 -------------------------------- */

/**
 * 把一批通用条目交给核心处理：去重、判断、建任务、写回对话。
 * 插件（poll 或 webhook）只负责交条目，行为全部在这里。
 */
export async function ingestItems(id, rawItems, { verb = '接收' } = {}) {
  const plugin = plugins.getPlugin(id);
  if (!plugin) throw new Error('插件不存在');
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map(normalizeItem)
    .filter(Boolean)
    .slice(0, MAX_ITEMS_PER_RUN);
  const seenInBatch = new Set();
  const fresh = items.filter((item) => {
    const key = String(item.externalId);
    if (seenInBatch.has(key)) return false;
    seenInBatch.add(key);
    return !alreadySeen(id, key);
  });

  if (!fresh.length) {
    plugins.markPluginRun(id, { status: 'ok', summary: `${items.length} 条，没有新内容` });
    bus.emit('plugin/status', { plugin: plugins.listPlugins().find((p) => p.id === id) });
    return { scanned: items.length, created: 0, skipped: items.length };
  }

  const workspace = workspaceFor(plugin);
  const decisions = await decide(fresh, plugin.manifest.name);
  let created = 0;
  const createdTasks = [];
  const details = [];
  for (let i = 0; i < fresh.length; i++) {
    const item = fresh[i];
    const decision = decisions[i];
    if (item.hops > 8) {
      const reason = `事件链过深（hops=${item.hops}），已停止继续派发`;
      recordItem(id, item, 'skipped', null, reason);
      details.push({ externalId: item.externalId, title: item.title, status: 'skipped', taskId: null, reason });
      continue;
    }
    if (!decision?.actionable) {
      const reason = decision?.reason || '判断为不需要动手';
      recordItem(id, item, 'skipped', null, reason);
      details.push({ externalId: item.externalId, title: item.title, status: 'skipped', taskId: null, reason });
      continue;
    }
    const prompt = [
      decision.prompt || `处理来自「${plugin.manifest.name}」的这条事项。`,
      '',
      '---',
      `来源：${plugin.manifest.name}`,
      `工作区：${workspace.name}（${workspace.path}）`,
      `判断理由：${decision.reason || '需要跟进'}`,
      `标题：${item.title}`,
      item.url ? `链接：${item.url}` : '',
      item.content ? `内容：\n${item.content}` : ''
    ].filter(Boolean).join('\n');
    const matchedRule = matchWorkerRule({
      text: `${item.title}\n${item.content || ''}`,
      source: `plugin:${id}`,
      eventType: item.eventType,
      workspaceId: workspace.id
    });
    const worker = matchedRule?.worker || 'llm';
    if (item.groupKey) {
      const existing = scheduler.findMergeableTask({ groupKey: item.groupKey, worker, cwd: workspace.path });
      if (existing) {
        scheduler.mergeTask(existing.id, { title: item.title, text: item.content || item.title, source: id });
        const reason = decision.reason || '同一事项合并到已有任务';
        recordItem(id, item, 'merged', existing.id, reason);
        details.push({ externalId: item.externalId, title: existing.title, status: 'merged', taskId: existing.id, reason });
        continue;
      }
    }
    const task = scheduler.createTask({
      title: decision.title || item.title,
      prompt,
      worker,
      cwd: workspace.path,
      origin: `plugin:${id}`,
      sessionId: 'main',
      priority: decision.priority || 2,
      source: id,
      groupKey: item.groupKey,
      hops: item.hops
    });
    recordItem(id, item, 'task', task.id, decision.reason || '需要处理');
    details.push({ externalId: item.externalId, title: task.title, status: 'task', taskId: task.id, reason: decision.reason || '需要处理' });
    createdTasks.push(task);
    created += 1;
  }

  const summary = created
    ? `${verb} ${fresh.length} 条新内容，建了 ${created} 个任务`
    : `${verb} ${fresh.length} 条新内容，都不需要你动手`;
  plugins.markPluginRun(id, { status: 'ok', summary });
  bus.emit('plugin/status', { plugin: plugins.listPlugins().find((p) => p.id === id) });

  if (createdTasks.length) {
    const taskDetails = details.filter((item) => item.status === 'task');
    const lines = [
      `我通过「${plugin.manifest.name}」发现了 ${createdTasks.length} 件需要处理的事：`,
      ...taskDetails.map((item) => `- ${item.title}（${item.reason}）`),
      '',
      '已经分别建好任务，需要你拍板的地方我会停下来等你。'
    ];
    postAssistant(lines.join('\n'), { kind: 'task', taskId: createdTasks[0].id });
  } else if (details.length) {
    const merged = details.filter((item) => item.status === 'merged');
    const skipped = details.filter((item) => item.status === 'skipped');
    if (merged.length) {
      postAssistant(`我把 ${merged.length} 条新消息合并到了已有任务：\n${merged.map((item) => `- ${item.title}`).join('\n')}`, { kind: 'task', taskId: merged[0].taskId });
    } else if (skipped.length) {
      postAssistant(`我看过「${plugin.manifest.name}」的 ${skipped.length} 条新内容，这些先不动：\n${skipped.map((item) => `- ${item.title}（${item.reason}）`).join('\n')}`, { kind: 'text' });
    }
  }
  bus.emit('stats/updated', scheduler.stats());
  return { scanned: fresh.length, created, details };

}

export async function runPlugin(id, { force = false } = {}) {
  const plugin = plugins.getPlugin(id);
  if (!plugin) throw new Error('插件不存在');
  const type = plugin.manifest.type || 'poll';
  if (type !== 'poll' && !(type === 'manual' && force)) return { skipped: 'not-poll' };
  if (!plugin.enabled && !force) return { skipped: 'disabled' };
  if (running.has(id)) return { skipped: 'running' };

  running.add(id);
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90 * 1000);
  const logs = [];
  const log = (msg) => {
    logs.push(`[${new Date().toISOString()}] ${msg}`);
    if (logs.length > 50) logs.shift();
    console.log(`[plugin:${id}] ${msg}`);
  };

  try {
    const since = plugin.row.last_run;
    log(`开始拉取${since ? `（上次：${since}）` : ''}`);
    const result = await plugin.module.poll(plugin.config, {
      settings: getSettings(),
      now: new Date(),
      since,
      signal: controller.signal,
      log,
      instanceId: id,
      pluginId: plugin.pluginId,
      state: stateFor(id)
    });
    const rawItems = Array.isArray(result?.items) ? result.items : [];
    const ingested = await ingestItems(id, rawItems, { verb: '扫描' });
    plugins.recordRun(id, { startedAt, status: 'ok', scanned: ingested.scanned, created: ingested.created });
    return ingested;
  } catch (err) {
    const message = err.name === 'AbortError' ? '拉取超时（90 秒）' : err.message;
    console.warn(`[plugin:${id}] 失败：${message}`);
    plugins.markPluginRun(id, { status: 'error', summary: '拉取失败', error: message });
    plugins.recordRun(id, { startedAt, status: 'error', error: message });
    bus.emit('plugin/status', { plugin: plugins.listPlugins().find((p) => p.id === id) });
    throw err;
  } finally {
    clearTimeout(timeout);
    running.delete(id);
  }
}

export async function testPlugin(id, overrideConfig = {}) {
  const plugin = plugins.getPlugin(id);
  if (!plugin) throw new Error('插件不存在');
  if (typeof plugin.module.test !== 'function') {
    return { ok: true, detail: '这个插件没有提供 test()，保存后直接扫描即可' };
  }
  const config = { ...plugin.config, ...overrideConfig };
  for (const field of plugin.manifest.config || []) {
    if (field.type === 'password' && config[field.key] === plugins.MASK) config[field.key] = plugin.config[field.key];
  }
  const started = Date.now();
  const result = await plugin.module.test(config, {
    settings: getSettings(),
    now: new Date(),
    log: (msg) => console.log(`[plugin:${id}:test] ${msg}`),
    instanceId: id,
    pluginId: plugin.pluginId,
    state: stateFor(id)
  });
  if (result.ok) {
    plugins.clearPluginError(id);
    bus.emit('plugin/status', { plugin: plugins.listPlugins().find((p) => p.id === id) });
  }
  return { ...result, latencyMs: Date.now() - started };
}

export async function runAll({ force = false } = {}) {
  const results = [];
  for (const plugin of plugins.listPlugins()) {
    if (!plugin.enabled) continue;
    if ((plugin.type || 'poll') !== 'poll') continue;
    const last = plugin.status.lastRun ? new Date(plugin.status.lastRun).getTime() : 0;
    const baseInterval = (plugin.intervalMinutes || 30) * 60000;
    const failures = Number(plugin.status.failCount || 0);
    const retryFactor = plugin.status.lastStatus === 'error' ? Math.min(2 ** Math.min(failures, 4), 16) : 1;
    const due = force || !last || Date.now() - last >= baseInterval * retryFactor;
    if (!due) continue;
    try {
      results.push({ id: plugin.id, ...(await runPlugin(plugin.id, { force })) });
    } catch (err) {
      results.push({ id: plugin.id, error: err.message });
    }
  }
  return results;
}

export function isRunning(id) {
  return running.has(id);
}

/* --------------------------- 长连接插件生命周期 --------------------------- */

function lifecycleLogger(id) {
  return (message) => console.log(`[plugin:${id}] ${message}`);
}

function stateFor(id) {
  return {
    get: (key, fallback = null) => plugins.getPluginState(id, key, fallback),
    set: (key, value) => plugins.setPluginState(id, key, value),
    delete: (key) => plugins.deletePluginState(id, key)
  };
}

async function stopLifecycleEntry(id) {
  const entry = lifecycles.get(id);
  if (!entry) return;
  lifecycles.delete(id);
  try {
    if (typeof entry.stop === 'function') await entry.stop();
  } catch (err) {
    console.warn(`[plugin:${id}] 停止长连接失败：${err.message}`);
  }
}

export async function stopLifecycle(id, { mark = true } = {}) {
  await stopLifecycleEntry(id);
  if (mark) {
    plugins.markPluginStatus(id, { status: 'idle', summary: '已停用' });
    bus.emit('plugin/status', { plugin: plugins.listPlugins().find((p) => p.id === id) });
  }
}

export async function startLifecycle(id) {
  const plugin = plugins.getPlugin(id);
  if (!plugin || !plugin.enabled || plugin.manifest.type !== 'stream') return null;
  await stopLifecycleEntry(id);
  try {
    const stop = await plugin.module.start(plugin.config, {
      settings: getSettings(),
      log: lifecycleLogger(id),
      ingest: (items) => ingestItems(id, items, { verb: '接收' }),
      instanceId: id,
      pluginId: plugin.pluginId,
      state: stateFor(id)
    });
    const stopFn = typeof stop === 'function'
      ? stop
      : typeof plugin.module.stop === 'function'
        ? () => plugin.module.stop()
        : null;
    lifecycles.set(id, { stop: stopFn });
    plugins.markPluginStatus(id, { status: 'ok', summary: '长连接已启动' });
    bus.emit('plugin/status', { plugin: plugins.listPlugins().find((p) => p.id === id) });
    return { running: true };
  } catch (err) {
    plugins.markPluginStatus(id, { status: 'error', summary: '长连接启动失败', error: err.message });
    bus.emit('plugin/status', { plugin: plugins.listPlugins().find((p) => p.id === id) });
    console.warn(`[plugin:${id}] 长连接启动失败：${err.message}`);
    return { running: false, error: err.message };
  }
}

export async function restartLifecycle(id) {
  await stopLifecycleEntry(id);
  const plugin = plugins.getPlugin(id);
  if (!plugin || !plugin.enabled || plugin.manifest.type !== 'stream') {
    plugins.markPluginStatus(id, { status: 'idle', summary: '已停用' });
    bus.emit('plugin/status', { plugin: plugins.listPlugins().find((p) => p.id === id) });
    return;
  }
  return startLifecycle(id);
}

export async function startLifecycles() {
  for (const plugin of plugins.listPlugins()) {
    if (plugin.enabled && plugin.type === 'stream') await startLifecycle(plugin.id);
  }
}

export async function stopLifecycles() {
  for (const id of [...lifecycles.keys()]) await stopLifecycleEntry(id);
}

export function start() {
  setTimeout(() => runAll().catch((err) => console.warn('[discovery]', err.message)), 20000).unref();
  timer = setInterval(() => runAll().catch((err) => console.warn('[discovery]', err.message)), 60000);
  timer.unref();
  console.log('[discovery] 来源插件轮询已启动');
}

export function stop() {
  if (timer) clearInterval(timer);
}

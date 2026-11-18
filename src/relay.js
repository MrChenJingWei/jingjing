/**
 * 消息类来源（企微、飞书……长连接机器人）往外说话、以及从渠道里回过来的操作，统一走这里。
 *
 * 分工：插件拥有渠道（怎么显示：更新同一个气泡、发卡片、发新消息），静静拥有状态和策略：
 * - 说什么、什么时候说：收到回执、状态播报、结果交付、闲聊回复，都由这里按 relay 策略决定，调插件的 deliver()；
 * - 谁能改任务：渠道里点的「同意」、回的「继续」由插件转成 interact()，这里核对是不是主人，再调调度器；
 * - 留痕：发了什么、谁在渠道里做了什么，都记在任务时间线上。
 * 任务状态只存在静静这里，插件只拿到副本。
 *
 * 插件接口：
 *   deliver(config, { to, event, text, final, transient, task, approval }, ctx) → { mode: 'updated' | 'sent' | 'skipped' }
 *     event：received（收到后的判断结果）/ chat（闲聊回复）/ waiting_approval / progress / done / failed / cancelled / result
 *     final：这件事在这条消息上说完了（可以结束流式气泡）；transient：只在原地更新时才发，不要为它新发一条消息。
 *   旧的 reply(config, { to, text, task }, ctx) 仍然可用：只会收到 result 和 chat。
 */
import { event } from './db.js';
import { bus } from './events.js';
import * as plugins from './plugins.js';
import * as scheduler from './scheduler.js';

export const limits = {
  deliverMs: 15 * 1000,
  // 同一个任务的进度播报最少隔多久一次，免得刷屏。
  progressGapMs: 10 * 1000,
  maxText: 20000
};

const ACTIONS = new Set(['approve', 'continue', 'cancel']);
const chains = new Map();          // instanceId -> 串行发送的 Promise 链（保证同一个渠道里的先后顺序）
const gates = new Map();           // instanceId -> { depth, buffer }：处理收到的消息时，先攒着任务事件，回执发出后再放行
const lastProgress = new Map();    // taskId -> 上次播报进度的时间

const truncate = (text, max) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

function contextFor(instanceId, plugin) {
  return {
    instanceId,
    pluginId: plugin.pluginId,
    log: (message) => console.log(`[plugin:${instanceId}] ${message}`),
    state: {
      get: (key, fallback = null) => plugins.getPluginState(instanceId, key, fallback),
      set: (key, value) => plugins.setPluginState(instanceId, key, value),
      delete: (key) => plugins.deletePluginState(instanceId, key)
    }
  };
}

export function canDeliver(plugin) {
  return typeof plugin?.module?.deliver === 'function';
}

export function policyOf(plugin) {
  return plugins.relayPolicy(plugin?.row);
}

/** 任务属于哪个消息来源：从插件建的、带着回传地址的任务才往外说。 */
function sourceOf(task) {
  if (!task?.reply_to || !String(task.origin || '').startsWith('plugin:')) return null;
  const instanceId = task.origin.slice('plugin:'.length);
  const plugin = plugins.getPlugin(instanceId);
  if (!plugin || !plugin.enabled || !plugins.canSpeak(plugin.module)) return null;
  return { instanceId, plugin };
}

function taskView(task) {
  return task ? { id: task.id, title: task.title, status: task.status, updatedAt: task.updated_at } : null;
}

/** 真正调插件。同一个来源串行发，结果是 { mode } ；旧插件只有 reply() 时只发 result / chat。 */
function call(instanceId, plugin, payload) {
  const run = async () => {
    const ctx = contextFor(instanceId, plugin);
    if (canDeliver(plugin)) {
      const result = await withTimeout(Promise.resolve().then(() => plugin.module.deliver(plugin.config, payload, ctx)), limits.deliverMs, `${limits.deliverMs / 1000} 秒还没发出去`);
      return { mode: ['updated', 'sent', 'skipped'].includes(result?.mode) ? result.mode : 'sent' };
    }
    if (!['result', 'chat'].includes(payload.event)) return { mode: 'skipped' };
    await withTimeout(Promise.resolve().then(() => plugin.module.reply(plugin.config, { to: payload.to, text: payload.text, task: payload.task ? { id: payload.task.id, title: payload.task.title } : null }, ctx)), limits.deliverMs, `${limits.deliverMs / 1000} 秒还没发出去`);
    return { mode: 'sent' };
  };
  const previous = chains.get(instanceId) || Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  chains.set(instanceId, next.catch(() => {}));
  return next;
}

/** 往外说一句，并在任务时间线上记下来（进度这类原地刷新的不记，免得时间线刷屏）。 */
async function speak(instanceId, plugin, task, payload, { by = 'auto', record = true } = {}) {
  try {
    const result = await call(instanceId, plugin, payload);
    if (task && record && result.mode !== 'skipped') {
      event(task.id, 'task/relayed', { event: payload.event, mode: result.mode, via: instanceId, label: plugin.label, by });
    }
    return result;
  } catch (err) {
    if (task && record) event(task.id, 'task/relay_failed', { event: payload.event, via: instanceId, label: plugin.label, by, error: truncate(err.message, 300) });
    throw err;
  }
}

/** 处理收到的消息期间，先把这个来源的任务事件攒着：回执发出去之后再放行，渠道里的先后顺序才对。 */
export function hold(instanceId) {
  const gate = gates.get(instanceId) || { depth: 0, buffer: [] };
  gate.depth += 1;
  gates.set(instanceId, gate);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gate.depth -= 1;
    if (gate.depth > 0) return;
    gates.delete(instanceId);
    for (const job of gate.buffer) job();
  };
}

function later(instanceId, job) {
  const gate = gates.get(instanceId);
  if (gate) gate.buffer.push(job);
  else job();
}

/* --------------------------------- 收到回执 --------------------------------- */

function receivedText(detail, workerLabel) {
  if (!detail) return '这条之前已经处理过了。';
  if (detail.status === 'task') {
    if (detail.held) return `收到。「${detail.title}」要先等主人决定交给谁。`;
    return `收到，建了任务「${detail.title}」，交给「${workerLabel || detail.workerLabel || detail.worker}」去做。`;
  }
  if (detail.status === 'merged') return `收到，合并到了已有的任务「${detail.title}」。`;
  if (detail.status === 'chat') return '收到。';
  return `看过了，这条先不动：${truncate(detail.reason || '暂时不需要处理', 120)}`;
}

/**
 * 一批消息处理完：给每条带回传地址的消息说一声结果。闲聊有回复时，回复就是这一句。
 * 有任务的消息不结束（final=false）：之后的进度和结果还能接着写在同一条消息上。
 */
export async function acknowledge(instanceId, items = [], result = {}) {
  const plugin = plugins.getPlugin(instanceId);
  if (!plugin || !plugins.canSpeak(plugin.module)) return;
  const policy = policyOf(plugin);
  const details = new Map((result.details || []).map((detail) => [String(detail.externalId), detail]));
  for (const item of items) {
    if (!item?.replyTo) continue;
    const detail = details.get(String(item.externalId)) || null;
    const task = detail?.taskId ? scheduler.getTask(detail.taskId) : null;
    try {
      if (detail?.status === 'chat' && detail.replied && detail.reply) {
        await speak(instanceId, plugin, null, { to: item.replyTo, event: 'chat', text: truncate(detail.reply, limits.maxText), final: true, task: null });
        continue;
      }
      if (!policy.ack || !canDeliver(plugin)) continue;
      const open = detail?.status === 'task' && !detail.held && policy.status !== 'off';
      await speak(instanceId, plugin, detail?.status === 'task' ? task : null, {
        to: item.replyTo,
        event: 'received',
        text: receivedText(detail),
        final: !open,
        task: taskView(task),
        outcome: detail?.status || 'seen'
      }, { record: Boolean(task) });
    } catch (err) {
      console.warn(`[relay:${instanceId}] 回执没发出去：${err.message}`);
    }
  }
}

/* --------------------------------- 状态播报 --------------------------------- */

function approvalView(approval) {
  if (!approval) return null;
  return {
    id: approval.id,
    kind: approval.kind || 'worker',
    question: approval.question,
    options: approval.options || [],
    custom: Boolean(approval.custom)
  };
}

function onApproval(approval, task) {
  const source = sourceOf(task);
  if (!source || !canDeliver(source.plugin)) return;
  const policy = policyOf(source.plugin);
  if (policy.status === 'off') return;
  later(source.instanceId, () => {
    const current = scheduler.getApproval(approval.id);
    if (current?.status !== 'pending') return;
    const options = (current.options || []).map((opt, i) => `${i + 1}. ${opt}`).join('\n');
    speak(source.instanceId, source.plugin, task, {
      to: task.reply_to,
      event: 'waiting_approval',
      text: `「${task.title}」需要拍板：${current.question}\n${options}`,
      final: true,
      task: taskView(task),
      approval: approvalView(current)
    }).catch((err) => console.warn(`[relay:${source.instanceId}] 拍板没推出去：${err.message}`));
  });
}

function onProgress(taskId, message) {
  const task = scheduler.getTask(taskId);
  const source = sourceOf(task);
  if (!source || !canDeliver(source.plugin) || policyOf(source.plugin).status !== 'progress') return;
  const at = Date.now();
  if (at - (lastProgress.get(taskId) || 0) < limits.progressGapMs) return;
  lastProgress.set(taskId, at);
  later(source.instanceId, () => {
    speak(source.instanceId, source.plugin, task, {
      to: task.reply_to,
      event: 'progress',
      text: `「${task.title}」正在做：${truncate(message, 200)}`,
      final: false,
      transient: true,
      task: taskView(task)
    }, { record: false }).catch(() => {});
  });
}

function finishedText(task) {
  if (task.status === 'done') return `「${task.title}」做完了。结果等主人在静静里看过再发。`;
  if (task.status === 'failed') return `「${task.title}」没做成：${truncate(task.error || task.result || '出错了', 200)}`;
  return `「${task.title}」停下了。`;
}

function onFinished(task) {
  lastProgress.delete(task.id);
  const source = sourceOf(task);
  if (!source) return;
  const policy = policyOf(source.plugin);
  later(source.instanceId, () => {
    // 打开了「完成后自动发回」：结果本身就是这一句。
    if (task.status === 'done' && policy.autoResult) {
      deliverResult(task.id, { by: 'auto' }).catch((err) => {
        bus.emit('relay/failed', { task, message: `「${task.title}」的结果${err.message}。可以在任务详情里点「发回原会话」再试。` });
      });
      return;
    }
    if (!canDeliver(source.plugin) || policy.status === 'off') return;
    speak(source.instanceId, source.plugin, task, {
      to: task.reply_to,
      event: task.status,
      text: finishedText(task),
      final: true,
      task: taskView(task)
    }).catch((err) => console.warn(`[relay:${source.instanceId}] 结束状态没推出去：${err.message}`));
  });
}

bus.on(({ type, payload }) => {
  if (type === 'approval/created' && payload?.approval && payload?.task) onApproval(payload.approval, payload.task);
  else if (type === 'task/progress' && payload?.taskId) onProgress(payload.taskId, payload.message);
  else if (type === 'task/finished' && payload?.task) onFinished(payload.task);
});

/* --------------------------------- 结果交付 --------------------------------- */

function replyError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/** 任务能不能发回原会话：返回 { plugin, instanceId } 或抛出说明原因的错误。 */
export function replyTarget(task) {
  if (!task) throw replyError('任务不存在', 404);
  const instanceId = String(task.origin || '').startsWith('plugin:') ? task.origin.slice('plugin:'.length) : null;
  const plugin = instanceId ? plugins.getPlugin(instanceId) : null;
  if (!plugin || !task.reply_to) throw replyError('这个任务不是从能回消息的来源来的');
  if (!plugins.canSpeak(plugin.module)) throw replyError(`「${plugin.label}」插件不支持发回消息`);
  if (!plugin.enabled) throw replyError(`「${plugin.label}」已停用，先启用再发`);
  return { plugin, instanceId };
}

/** 把一段文字（默认是任务结果）发回原会话。主人点「发回原会话」和自动发回都走这里。 */
export async function deliverResult(taskId, { text, by = 'user' } = {}) {
  const task = scheduler.getTask(taskId);
  const { plugin, instanceId } = replyTarget(task);
  const body = String(text ?? task.result ?? '').trim();
  if (!body) throw replyError('没有可以发的内容');
  if (body.length > limits.maxText) throw replyError(`内容太长了（最多 ${limits.maxText} 字）`);
  try {
    await speak(instanceId, plugin, task, { to: task.reply_to, event: 'result', text: body, final: true, task: taskView(task) }, { by, record: false });
  } catch (err) {
    event(task.id, 'task/reply_failed', { via: instanceId, label: plugin.label, by, error: truncate(err.message, 300) });
    throw replyError(`没发出去：${err.message}`, 502);
  }
  event(task.id, 'task/replied', { via: instanceId, label: plugin.label, by, chars: body.length });
  bus.emit('task/replied', { taskId: task.id, label: plugin.label, by });
  return { ok: true, label: plugin.label };
}

/** 闲聊回复（没有任务）：旧插件走 reply()，新插件走 deliver(chat)。 */
export function sendChat(instanceId, plugin, to, text) {
  return call(instanceId, plugin, { to, event: 'chat', text: truncate(text, limits.maxText), final: true, task: null });
}

/* ------------------------------ 渠道里回来的操作 ------------------------------ */

/**
 * 插件把「渠道里谁点了什么、说了什么」转过来：{ taskId, action: approve|continue|cancel, choice?, answer?, text?, actor, actorName? }。
 * 只认这个来源自己建的任务；actor 必须在设置的「能在群里拍板的人」里。返回 { ok, message, task? }，message 可以直接回给渠道。
 */
export function interact(instanceId, request = {}) {
  const plugin = plugins.getPlugin(instanceId);
  if (!plugin) return { ok: false, code: 'gone', message: '这个来源已经不在了。' };
  const action = String(request.action || '');
  if (!ACTIONS.has(action)) return { ok: false, code: 'bad_action', message: '不认识这个操作。' };
  const task = scheduler.getTask(String(request.taskId || ''));
  if (!task || task.origin !== `plugin:${instanceId}`) return { ok: false, code: 'not_found', message: '找不到这个任务，可能已经删了。' };
  const actor = String(request.actor || '').trim();
  const who = String(request.actorName || actor || '有人').slice(0, 60);
  const policy = policyOf(plugin);
  if (!actor || !policy.owners.includes(actor)) {
    event(task.id, 'task/remote_denied', { via: instanceId, label: plugin.label, action, actor, actorName: who });
    return {
      ok: false,
      code: 'not_owner',
      message: policy.owners.length
        ? `只有主人能在这里${action === 'approve' ? '拍板' : '操作'}。`
        : `还没设置谁能在这里拍板：主人在静静「设置 → 任务来源 → ${plugin.label}」里填上自己的账号（${actor || '未知'}）就行。`
    };
  }
  try {
    let updated;
    let message;
    if (action === 'approve') {
      if (!task.approval_id) return { ok: false, code: 'no_approval', message: '这件事现在没有在等拍板。' };
      if (request.approvalId && request.approvalId !== task.approval_id) return { ok: false, code: 'stale', message: '这个问题已经处理过了。' };
      const answer = String(request.answer || '').trim();
      const approval = scheduler.getApproval(task.approval_id);
      const choice = answer ? null : Number(request.choice);
      ({ task: updated } = scheduler.approve(task.approval_id, choice, { by: `${plugin.label} · ${who}`, answer }));
      message = answer ? `${who} 的决定：${truncate(answer, 60)}` : `${who} 选了：${approval?.options?.[choice] ?? (choice < 0 ? '不处理' : choice)}`;
    } else if (action === 'continue') {
      updated = scheduler.continueTask(task.id, request.text, { by: `${plugin.label} · ${who}` });
      message = `好，接着做「${task.title}」。`;
    } else {
      updated = scheduler.cancel(task.id, `${who} 在${plugin.label}里停掉了`);
      message = `「${task.title}」停下了。`;
    }
    event(task.id, 'task/remote_action', { via: instanceId, label: plugin.label, action, actor, actorName: who });
    return { ok: true, message, task: taskView(updated) };
  } catch (err) {
    return { ok: false, code: 'failed', message: truncate(err.message, 200) };
  }
}

/** 测试用：等这个来源排着的发送都发完。 */
export async function drain(instanceId) {
  await (chains.get(instanceId) || Promise.resolve());
}


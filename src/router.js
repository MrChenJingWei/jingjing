import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, now, uid, getSettings, event } from './db.js';
import { bus } from './events.js';
import { SANDBOX_DIR } from './config.js';
import * as memory from './memory.js';
import * as scheduler from './scheduler.js';
import { workerCatalog, isWorker, defaultWorker } from './workers.js';
import { pickWorker } from './worker-routing.js';
import { matchWorkerRule } from './worker-rules.js';
import { classify, heuristicClassify, chat as llmChat, demoReply, makeTitle } from './llm.js';
import * as workflows from './workflows.js';

const MAIN_SESSION = 'main';

export function ensureSession(id = MAIN_SESSION) {
  const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (existing) return existing;
  const stamp = now();
  db.prepare('INSERT INTO sessions(id, title, created_at, updated_at) VALUES(?,?,?,?)')
    .run(id, id === MAIN_SESSION ? '和静静的对话' : id, stamp, stamp);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function parseMeta(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function messages(sessionId = MAIN_SESSION, limit = 100) {
  return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(sessionId, limit)
    .reverse()
    .map((row) => ({ ...row, meta: parseMeta(row.meta) }));
}

function addMessage({ sessionId = MAIN_SESSION, role, text, kind = 'text', taskId = null, meta = null }) {
  const msg = {
    id: uid('msg_'),
    session_id: sessionId,
    role,
    text,
    kind,
    task_id: taskId,
    meta,
    created_at: now()
  };
  db.prepare(`
    INSERT INTO messages(id, session_id, role, text, kind, task_id, meta, created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(msg.id, msg.session_id, msg.role, msg.text, msg.kind, msg.task_id, meta ? JSON.stringify(meta) : null, msg.created_at);
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(msg.created_at, sessionId);
  bus.emit('chat/message', { message: msg });
  return msg;
}

/** 供来源插件/调度器往主对话里补一条静静的消息 */
export function postAssistant(text, { kind = 'text', taskId = null, sessionId = MAIN_SESSION, meta = null } = {}) {
  return addMessage({ sessionId, role: 'assistant', text, kind, taskId, meta });
}

function statusReply() {
  const tasks = scheduler.listTasks({ limit: 30 });
  const waiting = tasks.filter((t) => t.status === 'waiting_approval');
  const active = tasks.filter((t) => ['running', 'queued'].includes(t.status));
  const done = tasks.filter((t) => t.status === 'done').slice(0, 3);
  const lines = [];
  if (!tasks.length) return '任务板还是空的。你可以直接把一件事丢给我，我来拆成可执行的步骤。';
  lines.push(`现在有 ${active.length + waiting.length} 件还在路上。`);
  if (waiting.length) {
    lines.push('', '**等你拍板：**');
    for (const t of waiting) lines.push(`- ${t.title}`);
  }
  if (active.length) {
    lines.push('', '**正在跑：**');
    for (const t of active.slice(0, 5)) {
      const state = t.status === 'running' ? t.progress || '执行中' : '排队中';
      lines.push(`- ${t.title} · ${state}`);
    }
  }
  if (done.length) {
    lines.push('', '**最近完成：**');
    for (const t of done) lines.push(`- ${t.title}${t.result ? `：${t.result.split('\n')[0].slice(0, 40)}` : ''}`);
  }
  return lines.join('\n');
}

function recallReply(text) {
  const hits = memory.search(text, 6);
  if (!hits.length) return '我这儿还没有相关的记忆。你告诉我一句「记住……」，我就能把它留下。';
  return ['我在记忆里找到这些：', '', ...hits.map((m) => `- ${m.text}`)].join('\n');
}

function resolveShellCwd(text, base) {
  try {
    const dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const name of dirs) {
      if (text.includes(name)) return path.join(base, name);
    }
    const quoted = text.match(/[「"'“]([^」"'”]+)[」"'”]/);
    if (quoted) {
      const candidate = path.join(base, quoted[1]);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    }
  } catch { /* ignore */ }
  return base;
}

function pickWorkspace(text, settings) {
  const list = Array.isArray(settings.workspaces) ? settings.workspaces : [];
  const matched = list.find((workspace) => text.includes(workspace.name) || text.includes(path.basename(workspace.path)));
  if (matched) return matched;
  if (/(桌面|desktop)/i.test(text)) {
    const desktop = path.join(os.homedir(), 'Desktop');
    if (fs.existsSync(desktop)) return { id: 'desktop', name: '桌面', path: desktop };
  }
  return list.find((workspace) => workspace.id === settings.defaultWorkspaceId)
    || list[0]
    || { name: '默认工作区', path: settings.defaultCwd };
}

function defaultWorkspacePath(settings) {
  return pickWorkspace('', settings).path || settings.defaultCwd;
}

export async function handleMessage(text, { sessionId = MAIN_SESSION, source = 'web' } = {}) {
  ensureSession(sessionId);
  const clean = String(text || '').trim();
  if (!clean) throw new Error('消息不能为空');

  const settings = getSettings();
  const priorMessages = messages(sessionId, 8);
  const userMsg = addMessage({ sessionId, role: 'user', text: clean });
  // 命中用户配置的工作流程（或确认过的习惯）就直接按流程派活，不用再让模型猜。
  // 明显是在提问、要记东西或问进度的消息不套流程。
  const quick = heuristicClassify(clean);
  const asking = /(?:[?？]|吗)\s*$/.test(clean) || ['remember', 'status', 'recall'].includes(quick.intent);
  const flowHit = asking ? null : workflows.matchWorkflow(clean);
  const decision = flowHit
    ? { intent: 'task', worker: null, title: makeTitle(clean), reason: 'workflow' }
    : await classify(clean, {
      history: priorMessages,
      workers: workerCatalog({ onlyAvailable: true }),
      workflows: workflows.catalog()
    });
  let reply = '';
  let task = null;

  if (decision.intent === 'remember') {
    const facts = memory.extractFacts(clean, settings.userName);
    if (!facts.length) {
      memory.remember({
        text: clean.replace(/^(记住|记一下|记下)[：:，,\s]*/, ''),
        layer: 'semantic',
        kind: 'note',
        importance: 0.6,
        source
      });
      reply = '好，我记下了。以后做计划和回话时，我会把它带在上下文里。';
    } else {
      for (const f of facts) {
        memory.remember({
          text: f.text,
          layer: f.kind === 'preference' ? 'profile' : 'semantic',
          kind: f.kind,
          importance: f.importance,
          tags: [source],
          source
        });
      }
      reply = `记住了 ${facts.length} 条：\n` + facts.map((f) => `- ${f.text}`).join('\n');
    }
    bus.emit('memory/created', { count: facts.length || 1 });
  } else if (decision.intent === 'status') {
    reply = statusReply();
  } else if (decision.intent === 'recall') {
    reply = recallReply(clean);
  } else if (decision.intent === 'task') {
    const workflow = flowHit?.workflow || (decision.workflow ? workflows.getWorkflow(decision.workflow) : null);
    const workspace = workflows.resolveWorkspace(workflow, settings) || pickWorkspace(clean, settings);
    const catalog = workerCatalog();
    // 优先级：工作流程指定的 Worker > Worker 分配规则 > 按能力挑选。
    const flowWorker = workflow?.worker ? catalog.find((w) => w.id === workflow.worker) : null;
    const matchedRule = workflow?.worker
      ? null
      : matchWorkerRule({ text: clean, source, eventType: 'chat.message', workspaceId: workspace.id });
    let worker;
    let note = '';
    let ruleNote = '';
    if (flowWorker?.available) {
      worker = flowWorker.id;
    } else if (matchedRule) {
      worker = matchedRule.worker;
      ruleNote = `（按分配规则「${matchedRule.name}」）`;
    } else {
      ({ worker, note } = pickWorker({
        text: clean,
        requested: workflow?.worker || decision.worker || null,
        decided: Boolean(workflow?.worker) || (decision.reason === 'llm' && Boolean(decision.worker)),
        workers: catalog
      }));
      worker ||= 'llm';
    }
    const picked = catalog.find((w) => w.id === worker);
    const base = workspace.path && fs.existsSync(workspace.path) ? workspace.path : settings.defaultCwd;
    const folderBase = base && fs.existsSync(base) ? base : SANDBOX_DIR;
    // 只整理文件、不碰代码的 Worker 直接落在用户点名的子目录里（比如「整理下载文件夹」）。
    const folderScoped = picked?.abilities?.includes('manage-files') && !picked.abilities.includes('code');
    const cwd = folderScoped ? resolveShellCwd(clean, folderBase) : base;
    const title = decision.title || makeTitle(clean);
    task = scheduler.createTask({
      title,
      prompt: clean + workflows.promptSection(workflow),
      worker,
      cwd,
      origin: 'chat',
      sessionId,
      source,
      priority: 2,
      workflowId: workflow?.id || null,
      workflowName: workflow?.name || ''
    });
    const workerLabel = picked?.label || worker;
    const flowNote = workflow ? `按${workflow.source === 'learned' ? '习惯' : '工作流程'}「${workflow.name}」，` : '';
    reply = `好，${flowNote}我把「${title}」派给了「${workerLabel}」Worker${note}${ruleNote}，工作区是「${workspace.name}」。进度会在这条对话里更新，需要你拍板时我会停下来等你。`;
  } else {
    const mem = memory.context(clean, { limit: 6 });
    const tasks = scheduler.listTasks({ limit: 8 });
    const recent = priorMessages.map((m) => `${m.role === 'user' ? '用户' : '静静'}：${String(m.text || '').slice(0, 500)}`).join('\n');
    const system = [
      '你是「静静」，用户的本地个人 AI 管家。回答简洁、具体、平静，不要客套和空话。',
      `风格：${settings.persona || '平静、具体、不奉承，像一个可靠的同事。'}`,
      '你熟悉用户的任务板和长期记忆。需要时主动提议把某件事变成任务，但不要编造已经完成的事。',
      '',
      '最近对话：',
      recent || '（这是第一轮）',
      '',
      '长期记忆：',
      memory.serializeForPrompt(mem) || '（暂无）',
      '',
      '当前任务：',
      tasks.map((t) => `- [${t.status}] ${t.title}`).join('\n') || '（暂无）'
    ].join('\n');
    let answer;
    if (settings.provider === 'demo') {
      answer = demoReply(clean);
    } else {
      try {
        const res = await llmChat({
          system,
          messages: [{ role: 'user', content: clean }],
          maxTokens: 900
        });
        answer = res.text;
      } catch (err) {
        answer = `${demoReply(clean)}\n\n（云端模型暂时连不上：${err.message}。先按本地回退回答。）`;
      }
    }
    reply = answer;

    // 即使是在闲聊，也顺手捕捉明确的偏好
    const facts = memory.extractFacts(clean, settings.userName);
    for (const f of facts) {
      if (f.kind !== 'fact' || clean.length < 40) {
        memory.remember({
          text: f.text,
          layer: f.kind === 'preference' ? 'profile' : 'semantic',
          kind: f.kind,
          importance: f.importance,
          tags: [source],
          source
        });
      }
    }
  }

  const assistantMsg = addMessage({ sessionId, role: 'assistant', text: reply, kind: task ? 'task' : 'text', taskId: task?.id || null });
  bus.emit('stats/updated', scheduler.stats());
  return { userMessage: userMsg, reply: assistantMsg, task, intent: decision.intent };
}

/* ------------------------------ 主动发现 ------------------------------- */

function ruleDue(rule) {
  const trigger = JSON.parse(rule.trigger);
  const last = rule.last_run ? new Date(rule.last_run) : null;
  const nowDate = new Date();
  if (trigger.type === 'interval') {
    if (!last) return true;
    return nowDate - last >= (trigger.seconds || 300) * 1000;
  }
  if (trigger.type === 'daily') {
    const [hh, mm] = String(trigger.at || '08:00').split(':').map(Number);
    const target = new Date(nowDate);
    target.setHours(hh, mm, 0, 0);
    const diff = nowDate - target;
    if (diff < 0 || diff > 3 * 60 * 60 * 1000) return false;
    if (!last) return true;
    return last < target;
  }
  return false;
}

export async function proactiveScan() {
  const settings = getSettings();
  if (!settings.proactive) return { created: 0 };
  const rules = db.prepare('SELECT * FROM rules WHERE enabled = 1').all();
  let created = 0;

  for (const rule of rules) {
    const trigger = JSON.parse(rule.trigger);
    if (trigger.type !== 'daily') continue;
    if (!ruleDue(rule)) continue;
    const action = JSON.parse(rule.action);

    const prompt = action.prompt;
    const title = action.title || rule.name;
    const task = scheduler.createTask({
      title,
      prompt,
      worker: isWorker(action.worker) ? action.worker : defaultWorker(),
      cwd: action.cwd || defaultWorkspacePath(settings),
      origin: 'proactive',
      sessionId: MAIN_SESSION,
      ruleId: rule.id,
      priority: 3,
      source: 'rule'
    });
    db.prepare('UPDATE rules SET last_run = ? WHERE id = ?').run(now(), rule.id);
    event(task.id, 'task/proactive', { rule: rule.name });
    addMessage({
      sessionId: MAIN_SESSION,
      role: 'assistant',
      text: `我按「${rule.name}」的安排起了一个任务：${title}。有结果我会回来告诉你。`,
      kind: 'task',
      taskId: task.id
    });
    created += 1;
  }

  if (created) bus.emit('stats/updated', scheduler.stats());
  return { created };
}

export function listRules() {
  return db.prepare('SELECT * FROM rules ORDER BY created_at').all().map((r) => ({
    ...r,
    enabled: Boolean(r.enabled),
    trigger: JSON.parse(r.trigger),
    action: JSON.parse(r.action)
  }));
}

export function setRuleEnabled(id, enabled) {
  db.prepare('UPDATE rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return listRules();
}

export function startProactiveLoop() {
  setInterval(() => {
    proactiveScan().catch((err) => console.warn('[proactive]', err.message));
  }, 60 * 1000).unref();
}

export { MAIN_SESSION };

/* ------------------------------ 流程学习 ------------------------------- */

function workerInfo(id) {
  return workerCatalog().find((w) => w.id === id) || null;
}

/**
 * 把一次完成的任务总结成候选习惯，并在对话里发一张确认卡片。
 * force=true 用于用户在任务详情里手动点「总结成工作流程」。
 */
export async function proposeWorkflow(taskId, { force = false } = {}) {
  const task = scheduler.getTask(taskId);
  if (!task) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
  if (task.status !== 'done') throw Object.assign(new Error('只有完成的任务才能总结成工作流程'), { statusCode: 400 });
  const settings = getSettings();
  const events = scheduler.taskEvents(task.id, 200);
  const info = workerInfo(task.worker);
  const workspaceName = (settings.workspaces || []).find((w) => w.path === task.cwd)?.name || '';
  const result = await workflows.learnFromTask(task, events, { workerLabel: info?.label || task.worker, workspaceName, force });
  if (result.skipped) {
    event(task.id, 'workflow/skipped', { reason: result.skipped });
    return result;
  }
  const workflow = result.workflow;
  event(task.id, 'workflow/proposed', { workflowId: workflow.id, name: workflow.name });
  bus.emit('workflows/updated', workflows.overview());
  addMessage({
    sessionId: task.session_id || MAIN_SESSION,
    role: 'assistant',
    kind: 'workflow',
    meta: { workflowId: workflow.id, fromTask: task.id },
    text: `我把「${task.title}」的处理过程总结成了工作流程「${workflow.name}」。保存为习惯后，下次遇到同类请求（触发词：${workflow.when}），我会直接按它派给「${info?.label || task.worker}」执行。`
  });
  return result;
}

async function onTaskFinished(task) {
  if (!task) return;
  if (task.workflow_id) workflows.recordOutcome(task.workflow_id, task.status);
  if (task.status !== 'done') return;
  const info = workerInfo(task.worker);
  const textOnly = !info || (info.abilities || []).every((ability) => ability === 'text');
  if (!workflows.shouldLearn(task, scheduler.taskEvents(task.id, 200), { textOnly })) return;
  await proposeWorkflow(task.id);
}

bus.on(({ type, payload }) => {
  if (type !== 'task/finished') return;
  onTaskFinished(payload.task).catch((err) => console.warn('[workflow] 总结流程失败：', err.message));
});

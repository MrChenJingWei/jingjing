import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, now, uid, getSettings, event } from './db.js';
import { bus } from './events.js';
import { SANDBOX_DIR, WORKER_LABEL } from './config.js';
import * as memory from './memory.js';
import * as scheduler from './scheduler.js';
import { availability, workerCatalog } from './workers.js';
import { matchWorkerRule } from './worker-rules.js';
import { classify, chat as llmChat, demoReply, makeTitle } from './llm.js';

const MAIN_SESSION = 'main';

export function ensureSession(id = MAIN_SESSION) {
  const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (existing) return existing;
  const stamp = now();
  db.prepare('INSERT INTO sessions(id, title, created_at, updated_at) VALUES(?,?,?,?)')
    .run(id, id === MAIN_SESSION ? '和静静的对话' : id, stamp, stamp);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

export function messages(sessionId = MAIN_SESSION, limit = 100) {
  return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(sessionId, limit)
    .reverse();
}

function addMessage({ sessionId = MAIN_SESSION, role, text, kind = 'text', taskId = null }) {
  const msg = {
    id: uid('msg_'),
    session_id: sessionId,
    role,
    text,
    kind,
    task_id: taskId,
    created_at: now()
  };
  db.prepare(`
    INSERT INTO messages(id, session_id, role, text, kind, task_id, created_at)
    VALUES(?,?,?,?,?,?,?)
  `).run(msg.id, msg.session_id, msg.role, msg.text, msg.kind, msg.task_id, msg.created_at);
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(msg.created_at, sessionId);
  bus.emit('chat/message', { message: msg });
  return msg;
}

/** 供来源插件/调度器往主对话里补一条静静的消息 */
export function postAssistant(text, { kind = 'text', taskId = null, sessionId = MAIN_SESSION } = {}) {
  return addMessage({ sessionId, role: 'assistant', text, kind, taskId });
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

function chooseWorker(requested) {
  const avail = availability();
  if (!avail.llm?.available) {
    return { worker: requested, note: '' };
  }
  if (!avail[requested] || !avail[requested].available) {
    return { worker: 'llm', note: `（本机没有可用的「${avail[requested]?.label || requested}」Worker，先用问答 Worker 跑）` };
  }
  return { worker: requested, note: '' };
}

export async function handleMessage(text, { sessionId = MAIN_SESSION, source = 'web' } = {}) {
  ensureSession(sessionId);
  const clean = String(text || '').trim();
  if (!clean) throw new Error('消息不能为空');

  const settings = getSettings();
  const priorMessages = messages(sessionId, 8);
  const userMsg = addMessage({ sessionId, role: 'user', text: clean });
  const decision = await classify(clean, { history: priorMessages, workers: workerCatalog() });
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
    const workspace = pickWorkspace(clean, settings);
    const matchedRule = matchWorkerRule({ text: clean, source, eventType: 'chat.message', workspaceId: workspace.id });
    let requested = decision.worker || 'llm';
    let ruleNote = '';
    if (matchedRule) {
      requested = matchedRule.worker;
      ruleNote = `（按分配规则「${matchedRule.name}」）`;
    } else {
      if (requested === 'shell' && /(github|git\b|repo|仓库|代码|提交|推送|部署|分支)/i.test(clean)) {
        requested = 'claude';
      }
      const wantsFile = /(?:生成|写|创建|新建|建|保存|导出|做一个|做一份).{0,40}(?:文件|文档|txt|md|markdown|tex|json|csv|html)/i.test(clean)
        || /(?:文件|文档).{0,40}(?:写|内容|保存)/i.test(clean)
        || /[A-Za-z0-9_\-\u4e00-\u9fa5]+\.(?:txt|md|markdown|tex|json|csv|html)/i.test(clean);
      if (wantsFile && !['claude', 'codex', 'dsh'].includes(requested)) requested = 'file';
    }
    const { worker, note } = chooseWorker(requested);
    const base = workspace.path && fs.existsSync(workspace.path) ? workspace.path : settings.defaultCwd;
    const shellBase = base && fs.existsSync(base) ? base : SANDBOX_DIR;
    const cwd = worker === 'shell' ? resolveShellCwd(clean, shellBase) : base;
    const title = decision.title || makeTitle(clean);
    task = scheduler.createTask({
      title,
      prompt: clean,
      worker,
      cwd,
      origin: 'chat',
      sessionId,
      source,
      priority: 2
    });
    const workerLabel = availability()[worker]?.label || WORKER_LABEL[worker] || worker;
    reply = `好，我把「${title}」派给了「${workerLabel}」Worker${note}${ruleNote}，工作区是「${workspace.name}」。进度会在这条对话里更新，需要你拍板时我会停下来等你。`;
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
      worker: action.worker || 'llm',
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

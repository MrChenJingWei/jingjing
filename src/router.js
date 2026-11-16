import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, now, uid, getSettings, event } from './db.js';
import { bus } from './events.js';
import { SANDBOX_DIR } from './config.js';
import * as memory from './memory.js';
import * as scheduler from './scheduler.js';
import { workerCatalog, isWorker, defaultWorker } from './workers.js';
import { pickWorker, describeWorker } from './worker-routing.js';
import { matchWorkerRule } from './worker-rules.js';
import { classify, heuristicClassify, chat as llmChat, chatWithTools, toolsSupported, demoReply, makeTitle, llmMode } from './llm.js';
import * as workflows from './workflows.js';
import * as forge from './plugin-forge.js';
import { ownerSelf } from './persona.js';
import * as mind from './mind.js';
import * as conversation from './conversation.js';

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
  // 主人在问「你还记得……吗」：两个域都按相关度回想（整句当关键词去搜几乎搜不到），人格记忆标出来；
  // 想起来的会记得更牢。
  const candidates = [
    ...memory.recall(text, { domain: 'work', limit: 8, reinforceHits: false }),
    ...memory.recall(text, { domain: 'persona', limit: 4, subjects: [null, 'self'], reinforceHits: false })
  ];
  const hits = candidates.filter((m) => memory.relevance(text, m.text) >= 0.2).slice(0, 6);
  for (const m of hits) memory.reinforce(m.id);
  if (!hits.length) return '我这儿还没有相关的记忆。你告诉我一句「记住……」，我就能把它留下。';
  return ['我记得这些：', '', ...hits.map((m) => `- ${m.text}${m.domain === 'persona' ? '（人格）' : ''}`)].join('\n');
}

function resolveFolderCwd(text, base) {
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

function mentionedWorkspace(text, settings) {
  const list = Array.isArray(settings.workspaces) ? settings.workspaces : [];
  return list.find((workspace) => text.includes(workspace.name) || text.includes(path.basename(workspace.path))) || null;
}

function workspaceById(id, settings) {
  if (!id) return null;
  const list = Array.isArray(settings.workspaces) ? settings.workspaces : [];
  return list.find((workspace) => workspace.id === id || workspace.path === id) || null;
}

function pickWorkspace(text, settings) {
  const matched = mentionedWorkspace(text, settings);
  if (matched) return matched;
  const list = Array.isArray(settings.workspaces) ? settings.workspaces : [];
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

/** 记忆里怎么称呼主人：设置里还是默认的「你」时写「主人」，和心智整理时的写法一致，才认得出是同一件事。 */
function ownerName(settings) {
  const name = String(settings.userName || '').trim();
  return name && name !== '你' ? name : '主人';
}

// 每次带给模型的原话轮数（更早的在对话摘要里）。小模型上下文有限，不要太多。
const HISTORY_MESSAGES = 12;

function chatSystemPrompt(clean, sessionId, settings) {
  // 主人自己的对话：人设、心情、和主人的关系、业务记忆和人格记忆（分开写），再加上更早对话的摘要和任务板。
  const tasks = scheduler.listTasks({ limit: 8 });
  const summary = conversation.summaryOf(sessionId);
  return [
    '你是「静静」，用户的本地个人 AI 管家。回答简洁、具体，不要客套和空话。',
    ...ownerSelf(clean, settings),
    '',
    '你熟悉用户的任务板和长期记忆，也记得你们聊过的事。需要时主动提议把某件事变成任务，但不要编造已经完成的事；记得不清楚的就说记不太清，不要编。',
    ...(summary ? ['', '你们更早聊过（摘要）：', summary] : []),
    '',
    '当前任务：',
    tasks.map((t) => `- [${t.status}] ${t.title}`).join('\n') || '（暂无）'
  ].join('\n');
}

/** 最近几轮原话 + 这句话，作为多轮消息交给模型。 */
function chatTurns(history, clean) {
  return conversation.asTurns([...history, { role: 'user', text: clean }], { maxChars: 600 });
}

function routerTools(workers, flows) {
  const workerIds = workers.map((w) => w.id);
  const flowIds = flows.map((f) => f.id);
  const fn = (name, description, properties = {}, required = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } }
  });
  return [
    fn('create_task', '用户明确要求你去做一件具体的事（写、做、整理、修复、生成、处理、执行……）时调用，把它变成任务交给 Worker。闲聊和咨询不要调用。', {
      title: { type: 'string', description: '不超过 24 字的任务名，不要带「帮我」之类的客套词' },
      worker: { type: 'string', description: '最合适、开销最低的 Worker id', ...(workerIds.length ? { enum: workerIds } : {}) },
      ...(flowIds.length ? { workflow: { type: 'string', description: '请求明显属于某个工作流程时填它的 id', enum: flowIds } } : {})
    }, ['title']),
    fn('create_plugin', '用户要你给静静写一个新的插件时调用：任务来源插件（接收 / 拉取外部消息、事件）或 Worker 插件（执行任务）。', {
      kind: { type: 'string', enum: ['source', 'worker'], description: 'source：来源插件；worker：Worker 插件' }
    }, ['kind']),
    fn('remember', '用户要求你记住一个事实或偏好时调用。'),
    fn('show_status', '用户询问任务进度、状态或待办情况时调用。'),
    fn('recall', '用户询问你之前记住过的内容时调用。')
  ];
}

/**
 * 一次模型调用完成「判断 + 回答」：闲聊直接拿到回复，要做事则拿到 create_task 的参数。
 * 返回 { decision, reply }；模型不支持工具调用时抛错，由调用方退回两步判断。
 */
async function routeWithTools(clean, { sessionId, history, settings }) {
  const workers = workerCatalog({ onlyAvailable: true });
  const flows = workflows.catalog();
  const system = [
    chatSystemPrompt(clean, sessionId, settings),
    '',
    '你可以直接用文字回答，也可以调用一个工具。只有用户明确要你去做一件事时才调用 create_task。',
    '可用的 Worker：',
    ...workers.map(describeWorker),
    ...(flows.length ? ['用户配置的工作流程：', ...flows.map((f) => `- ${f.id}：${f.name}${f.when ? `（触发词：${f.when}）` : ''}`)] : [])
  ].join('\n');
  const res = await chatWithTools({ system, messages: chatTurns(history, clean), tools: routerTools(workers, flows) });
  const call = res.toolCall;
  if (!call) return { decision: { intent: 'chat', reason: 'model' }, reply: res.text || '' };
  const args = call.arguments || {};
  if (call.name === 'create_task') {
    return {
      decision: {
        intent: 'task',
        reason: 'model',
        title: args.title ? String(args.title).slice(0, 30) : makeTitle(clean),
        worker: workers.some((w) => w.id === args.worker) ? args.worker : null,
        workflow: flows.some((f) => f.id === args.workflow) ? args.workflow : null
      },
      reply: null
    };
  }
  if (call.name === 'create_plugin') {
    return { decision: { intent: 'plugin', reason: 'model', pluginKind: args.kind === 'worker' ? 'worker' : 'source' }, reply: null };
  }
  const intents = { remember: 'remember', show_status: 'status', recall: 'recall' };
  return { decision: { intent: intents[call.name] || 'chat', reason: 'model' }, reply: intents[call.name] ? null : res.text || '' };
}

export async function handleMessage(text, { sessionId = MAIN_SESSION, source = 'web', workspaceId = null } = {}) {
  ensureSession(sessionId);
  const clean = String(text || '').trim();
  if (!clean) throw new Error('消息不能为空');

  const settings = getSettings();
  const priorMessages = messages(sessionId, 8);
  const history = conversation.recentMessages(sessionId, HISTORY_MESSAGES);
  const previousAt = [...history].reverse().find((m) => m.role === 'user')?.created_at || null;
  const userMsg = addMessage({ sessionId, role: 'user', text: clean });
  // 听到这句话：心情动一下，和主人又熟一点（规则计算，不调模型）。
  try { mind.onOwnerMessage(clean, { previousAt }); } catch (err) { console.warn('[mind]', err.message); }
  // 命中用户配置的工作流程（或确认过的习惯）就直接按流程派活，不用再让模型猜。
  // 明显是在提问、要记东西或问进度的消息不套流程。
  const quick = heuristicClassify(clean);
  const asking = /(?:[?？]|吗)\s*$/.test(clean) || ['remember', 'status', 'recall', 'plugin'].includes(quick.intent);
  const flowHit = asking ? null : workflows.matchWorkflow(clean);
  let decision;
  let directReply = null;
  if (flowHit) {
    decision = { intent: 'task', worker: null, title: makeTitle(clean), reason: 'workflow' };
  } else {
    if (toolsSupported(settings)) {
      try {
        ({ decision, reply: directReply } = await routeWithTools(clean, { sessionId, history, settings }));
      } catch (err) {
        console.warn('[router] 工具调用不可用，改用两步判断：', err.message);
      }
    }
    decision ||= await classify(clean, {
      history: priorMessages,
      workers: workerCatalog({ onlyAvailable: true }),
      workflows: workflows.catalog()
    });
  }
  let reply = '';
  let task = null;

  if (decision.intent === 'remember') {
    const facts = memory.extractFacts(clean, ownerName(settings));
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
          source,
          // 从主人的话里抽出来的，都是关于主人的事。
          subject: 'owner'
        });
      }
      reply = `记住了 ${facts.length} 条：\n` + facts.map((f) => `- ${f.text}`).join('\n');
    }
    bus.emit('memory/created', { count: facts.length || 1 });
  } else if (decision.intent === 'status') {
    reply = statusReply();
  } else if (decision.intent === 'recall' && llmMode(settings) === 'demo') {
    // 没有模型：把想起来的记忆列出来。有模型时走下面的闲聊分支，让她带着记忆自然地回答。
    reply = recallReply(clean);
  } else if (decision.intent === 'plugin') {
    const kind = decision.pluginKind || forge.inferKind(clean);
    // 官方已经有类似插件时先提示，免得重复造轮子；用户明确要另写时再动手。
    const official = /(另写|重新写|自己写|不用官方|新写一个)/.test(clean) ? null : forge.findSimilarOfficial(clean, kind);
    if (official) {
      const where = kind === 'worker' ? '设置 → Worker' : '设置 → 任务来源 → 官方';
      reply = `官方已经有「${official.name}」${official.description ? `：${official.description}` : ''}\n\n在${where}里启用、填好配置就能用。如果它不合适，跟我说「还是帮我另写一个」，我再动手写。`;
    } else {
      try {
        const draft = forge.createDraft({ kind, request: clean, sessionId });
        task = draft.taskId ? scheduler.getTask(draft.taskId) : null;
        const who = draft.mode === 'agent' ? `「${workerCatalog().find((w) => w.id === draft.worker)?.label || draft.worker}」` : '模型';
        reply = `好，我让${who}写一个${draft.kindLabel}。写完我会先自动检查（清单规范、只用 Node 自带模块、能不能正常加载），没通过就让它接着修，最多 ${draft.maxRounds} 轮。通过以后会把代码给你看，**你点「安装」才会装上**。`;
      } catch (err) {
        reply = err.message;
      }
    }
  } else if (decision.intent === 'task') {
    const workflow = flowHit?.workflow || (decision.workflow ? workflows.getWorkflow(decision.workflow) : null);
    // 工作区优先级：聊天框里显式选的 > 文字里点名的 > 流程指定的 > 兜底（桌面 / 默认工作区）。
    const workspace = workspaceById(workspaceId, settings)
      || mentionedWorkspace(clean, settings)
      || workflows.resolveWorkspace(workflow, settings)
      || pickWorkspace(clean, settings);
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
        decided: Boolean(workflow?.worker) || (decision.reason === 'model' && Boolean(decision.worker)),
        workers: catalog,
        fallback: settings.fallbackWorker || null,
        // 主人自己在聊天里说「用 deepseek 去做」= DeepSeek Harness；外部来源走 discovery，不认这个别名。
        aliases: true
      }));
    }
    if (!worker) {
      throw Object.assign(new Error('本机没有可用的 Worker，先在设置 → Worker 里启用或安装一个'), { statusCode: 400 });
    }
    const picked = catalog.find((w) => w.id === worker);
    const base = workspace.path && fs.existsSync(workspace.path) ? workspace.path : settings.defaultCwd;
    const folderBase = base && fs.existsSync(base) ? base : SANDBOX_DIR;
    // 只整理文件、不碰代码的 Worker 直接落在用户点名的子目录里（比如「整理下载文件夹」）。
    const folderScoped = picked?.abilities?.includes('manage-files') && !picked.abilities.includes('code');
    const cwd = folderScoped ? resolveFolderCwd(clean, folderBase) : base;
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
    let answer;
    if (directReply) {
      // 工具调用那一次已经给出了回答，不用再调一次模型。
      answer = directReply;
    } else if (llmMode(settings) === 'demo') {
      answer = demoReply(clean);
    } else {
      try {
        const res = await llmChat({
          system: chatSystemPrompt(clean, sessionId, settings),
          messages: chatTurns(history, clean),
          maxTokens: 900
        });
        answer = res.text;
      } catch (err) {
        answer = `${demoReply(clean)}\n\n（云端模型暂时连不上：${err.message}。先按本地回退回答。）`;
      }
    }
    reply = answer;

    // 即使是在闲聊，也顺手捕捉明确的偏好
    const facts = memory.extractFacts(clean, ownerName(settings));
    for (const f of facts) {
      if (f.kind !== 'fact' || clean.length < 40) {
        memory.remember({
          text: f.text,
          layer: f.kind === 'preference' ? 'profile' : 'semantic',
          kind: f.kind,
          importance: f.importance,
          tags: [source],
          source,
          // 从主人的话里抽出来的，都是关于主人的事。
          subject: 'owner'
        });
      }
    }
  }

  const assistantMsg = addMessage({ sessionId, role: 'assistant', text: reply, kind: task ? 'task' : 'text', taskId: task?.id || null });
  bus.emit('stats/updated', scheduler.stats());
  return { userMessage: userMsg, reply: assistantMsg, task, intent: decision.intent };
}

/* ------------------------------ 自动化 -------------------------------- */

/**
 * 自动化 = 触发器 + 动作，用户自己在设置里加。
 *   trigger: { type: 'daily', at: '08:00' } | { type: 'interval', minutes: 60 }
 *   action:  { kind: 'task', title, prompt, worker, cwd, workflow }
 *          | { kind: 'scan', source, workflow, worker }
 * task：按指令建一个任务；scan：立刻扫一遍某个来源，新条目按指定流程/Worker 处理。
 */
const runningRules = new Set();

/** 每日规则：到点后 3 小时内、今天还没跑过就该跑；间隔规则：距上次运行超过间隔。 */
export function ruleDue(rule, nowDate = new Date()) {
  let trigger;
  try { trigger = JSON.parse(rule.trigger); } catch { return false; }
  const last = rule.last_run ? new Date(rule.last_run) : null;
  if (trigger.type === 'interval') {
    const minutes = Math.min(1440, Math.max(1, Number(trigger.minutes) || 60));
    return !last || nowDate - last >= minutes * 60 * 1000;
  }
  if (trigger.type !== 'daily') return false;
  const [hh, mm] = String(trigger.at || '08:00').split(':').map(Number);
  const target = new Date(nowDate);
  target.setHours(hh, mm, 0, 0);
  const diff = nowDate - target;
  if (diff < 0 || diff > 3 * 60 * 60 * 1000) return false;
  return !last || last < target;
}

function normalizeTrigger(raw) {
  const trigger = raw && typeof raw === 'object' ? raw : {};
  if (trigger.type === 'interval') {
    const minutes = Math.round(Number(trigger.minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      throw Object.assign(new Error('间隔要在 1–1440 分钟之间'), { statusCode: 400 });
    }
    return { type: 'interval', minutes };
  }
  const at = String(trigger.at || '08:00').trim();
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) {
    throw Object.assign(new Error('时间要写成 HH:MM（比如 08:00）'), { statusCode: 400 });
  }
  return { type: 'daily', at: at.padStart(5, '0') };
}

function normalizeAction(raw) {
  const action = raw && typeof raw === 'object' ? raw : {};
  if (action.kind === 'scan') {
    const source = String(action.source || '').trim();
    if (!source) throw Object.assign(new Error('扫描来源要先选一个来源插件'), { statusCode: 400 });
    return {
      kind: 'scan',
      source,
      workflow: String(action.workflow || '').trim(),
      worker: String(action.worker || '').trim()
    };
  }
  const prompt = String(action.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('动作要写一段给 Worker 的指令'), { statusCode: 400 });
  return {
    kind: 'task',
    title: String(action.title || '').trim().slice(0, 60),
    prompt: prompt.slice(0, 4000),
    worker: String(action.worker || '').trim(),
    cwd: String(action.cwd || '').trim(),
    workflow: String(action.workflow || '').trim()
  };
}

/** 动作里的工作区：可以是 id、名称或路径；没写就跟随默认工作区。 */
function ruleWorkspace(value, settings) {
  const wanted = String(value || '').trim();
  const list = Array.isArray(settings.workspaces) ? settings.workspaces : [];
  if (wanted) {
    const matched = list.find((w) => w.id === wanted || w.name === wanted || w.path === wanted);
    if (matched) return matched.path;
    if (path.isAbsolute(wanted)) return wanted;
  }
  return defaultWorkspacePath(settings);
}

export function saveRule(input = {}) {
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) throw Object.assign(new Error('自动化名称不能为空'), { statusCode: 400 });
  const trigger = normalizeTrigger(input.trigger);
  const action = normalizeAction(input.action);
  const enabled = input.enabled === false ? 0 : 1;
  const id = String(input.id || '').trim();
  if (id) {
    const existing = db.prepare('SELECT id FROM rules WHERE id = ?').get(id);
    if (!existing) throw Object.assign(new Error('自动化不存在'), { statusCode: 404 });
    db.prepare('UPDATE rules SET name = ?, enabled = ?, trigger = ?, action = ? WHERE id = ?')
      .run(name, enabled, JSON.stringify(trigger), JSON.stringify(action), id);
  } else {
    db.prepare('INSERT INTO rules(id, name, enabled, trigger, action, last_run, created_at) VALUES(?,?,?,?,?,NULL,?)')
      .run(`auto_${uid()}`, name, enabled, JSON.stringify(trigger), JSON.stringify(action), now());
  }
  const rules = listRules();
  bus.emit('rules/updated', { rules });
  return rules;
}

export function deleteRule(id) {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  const rules = listRules();
  bus.emit('rules/updated', { rules });
  return rules;
}

export async function runRuleNow(id) {
  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
  if (!rule) throw Object.assign(new Error('自动化不存在'), { statusCode: 404 });
  return runRule(rule, { manual: true });
}

async function runRule(rule, { manual = false } = {}) {
  if (runningRules.has(rule.id)) return { skipped: 'running' };
  runningRules.add(rule.id);
  const action = JSON.parse(rule.action || '{}');
  const settings = getSettings();
  try {
    let summary = '';
    let taskId = null;
    if (action.kind === 'scan') {
      // 动态引入：discovery 依赖 router（发消息），静态引用会成环。
      const discovery = await import('./discovery.js');
      const override = { workflow: action.workflow || '', worker: action.worker || '' };
      const result = await discovery.runPlugin(action.source, { force: true, override });
      summary = `扫描了「${action.source}」：${result.scanned || 0} 条新内容，建了 ${result.created || 0} 个任务`;
      if (!result.created) {
        addMessage({ sessionId: MAIN_SESSION, role: 'assistant', text: `我按自动化「${rule.name}」${summary}。`, kind: 'text' });
      }
    } else {
      const flow = action.workflow ? workflows.getWorkflow(action.workflow) : null;
      const flowWorker = flow?.worker && isWorker(flow.worker) ? flow.worker : null;
      const worker = action.worker && isWorker(action.worker) ? action.worker : flowWorker || defaultWorker();
      if (!worker) throw new Error('本机没有可用的 Worker');
      const cwd = ruleWorkspace(action.cwd, settings);
      const title = action.title || rule.name;
      const prompt = action.prompt + workflows.promptSection(flow);
      const task = scheduler.createTask({
        title,
        prompt,
        worker,
        cwd,
        origin: 'proactive',
        sessionId: MAIN_SESSION,
        ruleId: rule.id,
        priority: 3,
        source: 'rule',
        workflowId: flow?.id || null,
        workflowName: flow?.name || ''
      });
      taskId = task.id;
      event(task.id, 'task/proactive', { rule: rule.name });
      const workerLabel = workerCatalog().find((w) => w.id === worker)?.label || worker;
      summary = `建了任务「${title}」，交给「${workerLabel}」`;
      addMessage({
        sessionId: MAIN_SESSION,
        role: 'assistant',
        text: `我按自动化「${rule.name}」起了任务「${title}」。有结果我会回来告诉你。`,
        kind: 'task',
        taskId: task.id
      });
    }
    db.prepare('UPDATE rules SET last_run = ?, last_status = ?, last_summary = ? WHERE id = ?')
      .run(now(), 'ok', summary.slice(0, 300), rule.id);
    bus.emit('rules/updated', { rules: listRules() });
    if (taskId) bus.emit('stats/updated', scheduler.stats());
    return { summary, taskId, manual };
  } catch (err) {
    db.prepare('UPDATE rules SET last_run = ?, last_status = ?, last_summary = ? WHERE id = ?')
      .run(now(), 'error', String(err.message).slice(0, 300), rule.id);
    bus.emit('rules/updated', { rules: listRules() });
    throw err;
  } finally {
    runningRules.delete(rule.id);
  }
}

// 到点了却没跑成（比如一个可用的 Worker 都没有）时，每条规则每天只提醒一次，不每分钟刷日志。
const ruleWarnings = new Map(); // rule id -> 日期

export async function proactiveScan() {
  const settings = getSettings();
  if (!settings.proactive) return { created: 0 };
  const rules = db.prepare('SELECT * FROM rules WHERE enabled = 1').all();
  let created = 0;
  for (const rule of rules) {
    if (!ruleDue(rule)) continue;
    try {
      const result = await runRule(rule);
      if (result?.taskId) created += 1;
    } catch (err) {
      const today = new Date().toDateString();
      if (ruleWarnings.get(rule.id) !== today) {
        ruleWarnings.set(rule.id, today);
        console.warn(`[automation] 「${rule.name}」失败：${err.message}`);
      }
    }
  }
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
    proactiveScan().catch((err) => console.warn('[automation]', err.message));
    // 静静的心智：整理停下来的对话、到点反思。
    mind.tick().catch((err) => console.warn('[mind]', err.message));
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
  // 静静自己想说的话（人设调整、提议）：发到主人的对话里。
  if (type === 'mind/say') {
    addMessage({ sessionId: MAIN_SESSION, role: 'assistant', kind: payload.kind || 'text', meta: payload.meta || null, text: payload.text });
    return;
  }
  if (type === 'approval/auto') {
    const { task, workflow, question, option } = payload;
    addMessage({
      sessionId: task?.session_id || MAIN_SESSION,
      role: 'assistant',
      kind: 'text',
      taskId: null,
      text: `按习惯「${workflow.name}」，「${question}」我替你选了「${option}」。不想这样可以在设置 → 工作流程里关掉它的自动拍板。`
    });
    return;
  }
  if (type !== 'task/finished') return;
  onTaskFinished(payload.task).catch((err) => console.warn('[workflow] 总结流程失败：', err.message));
});

import { getSettings } from './db.js';
import { normalizeProvider } from './config.js';

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

import { estimateTokens } from './worker-runtime.js';
import { describeWorker } from './worker-routing.js';

export { estimateTokens };

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

function toolsUnsupportedError(provider, status, detail) {
  const err = new Error(`${provider} ${status}: ${truncate(detail, 200)}`);
  // 模型或服务不支持工具调用时记住，后面直接走两步判断，不再反复试。
  if (/tool|function/i.test(detail)) err.toolsUnsupported = true;
  return err;
}

/** 报错时用接口地址的主机名当代号，接的是哪家一眼能看出来（接 DeepSeek 就是 api.deepseek.com）。 */
function serviceLabel(cfg) {
  try {
    return new URL(cfg.baseUrl || 'https://api.deepseek.com').host || '模型服务';
  } catch {
    return '模型服务';
  }
}

/**
 * OpenAI 兼容接口：任何实现了 POST /chat/completions 的服务都能接
 * （DeepSeek、Kimi、GLM、通义、公司网关、中转站、Ollama 的 /v1 等）。
 * Key 可选：本地网关不带鉴权时不发 Authorization。
 */
async function callOpenAICompatible({ messages, temperature, maxTokens, json, signal, tools }) {
  const cfg = getSettings();
  const label = serviceLabel(cfg);
  const base = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const body = {
    model: cfg.model || 'deepseek-chat',
    messages,
    temperature: temperature ?? cfg.temperature ?? 0.6,
    max_tokens: maxTokens || 1600,
    stream: false
  };
  if (json) body.response_format = { type: 'json_object' };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: withTimeout(signal, 120000)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (tools?.length && res.status >= 400 && res.status < 500) throw toolsUnsupportedError(label, res.status, detail);
    throw new Error(`${label} ${res.status}: ${truncate(detail, 200)}`);
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const call = message.tool_calls?.[0]?.function;
  return {
    text: message.content || '',
    toolCall: call?.name ? { name: call.name, arguments: parseArguments(call.arguments) } : null,
    tokens: data.usage?.total_tokens || 0,
    cost: 0,
    model: data.model || body.model
  };
}

async function callOllama({ messages, temperature, json, signal, tools }) {
  const cfg = getSettings();
  const url = (cfg.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model || 'qwen2.5:7b',
      messages,
      stream: false,
      format: json ? 'json' : undefined,
      ...(tools?.length ? { tools } : {}),
      options: { temperature: temperature ?? cfg.temperature ?? 0.6 }
    }),
    signal: withTimeout(signal, 180000)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (tools?.length && res.status >= 400 && res.status < 500) throw toolsUnsupportedError('Ollama', res.status, detail);
    throw new Error(`Ollama ${res.status}: ${truncate(detail, 200)}`);
  }
  const data = await res.json();
  const call = data.message?.tool_calls?.[0]?.function;
  return {
    text: data.message?.content || '',
    toolCall: call?.name ? { name: call.name, arguments: parseArguments(call.arguments) } : null,
    tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
    cost: 0,
    model: data.model || cfg.model
  };
}

/**
 * 实际生效的模型通道：demo / openai / ollama。
 * “OpenAI 兼容接口”不填 Key 也照样用（本地网关常常不鉴权），只有选演示模式才走 demo。
 */
export function llmMode(cfg = getSettings()) {
  const provider = normalizeProvider(cfg.provider);
  return provider === 'demo' ? 'demo' : provider;
}

/**
 * 向当前接口要一份模型列表：OpenAI 兼容服务读 GET /models，Ollama 读 GET /api/tags。
 * 只是便利手段，失败也不影响手动填模型名。
 */
export async function listModels({ signal, timeoutMs = 15000 } = {}) {
  const cfg = getSettings();
  const mode = llmMode(cfg);
  if (mode === 'demo') {
    throw Object.assign(new Error('演示模式没有模型列表，先把运行模式切到 OpenAI 兼容接口或 Ollama'), { statusCode: 400 });
  }
  const isOllama = mode === 'ollama';
  const base = (isOllama ? cfg.ollamaUrl || 'http://127.0.0.1:11434' : cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let res;
  try {
    res = await fetch(isOllama ? `${base}/api/tags` : `${base}/models`, { headers, signal: withTimeout(signal, timeoutMs) });
  } catch (err) {
    // 地址写错、服务没起来时，直接告诉用户是哪个地址连不上。
    const reason = err?.cause?.code || err?.message || '请求失败';
    throw new Error(`连不上 ${base}（${reason}）`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${isOllama ? 'Ollama' : serviceLabel(cfg)} ${res.status}: ${truncate(detail, 200)}`);
  }
  const data = await res.json().catch(() => null);
  const models = [];
  const push = (value) => {
    const id = typeof value === 'string' ? value : value?.id || value?.name || value?.model;
    if (id && !models.includes(String(id))) models.push(String(id));
  };
  if (Array.isArray(data?.data)) data.data.forEach(push);
  if (Array.isArray(data?.models)) data.models.forEach(push);
  if (!models.length) throw new Error('这个地址没有返回可识别的模型列表，手动填模型名也一样能用');
  return models.sort();
}

export async function chat({ messages, system, temperature, maxTokens, json = false, signal }) {
  const cfg = getSettings();
  const all = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const mode = llmMode(cfg);
  if (mode === 'openai') {
    return callOpenAICompatible({ messages: all, temperature, maxTokens, json, signal });
  }
  if (mode === 'ollama') {
    return callOllama({ messages: all, temperature, json, signal });
  }
  const text = demoChat(all);
  return { text, tokens: estimateTokens(text), cost: 0, model: 'demo' };
}

const toolsUnsupported = new Set(); // `${mode}:${model}`

export function toolsSupported(cfg = getSettings()) {
  const mode = llmMode(cfg);
  return mode !== 'demo' && !toolsUnsupported.has(`${mode}:${cfg.model}`);
}

/**
 * 带工具的一次调用：模型要么直接回答（text），要么调用一个工具（toolCall）。
 * 模型不支持工具时抛错，并记住这个模型，之后 toolsSupported() 返回 false。
 */
export async function chatWithTools({ messages, system, tools, temperature, maxTokens = 900, signal }) {
  const cfg = getSettings();
  const mode = llmMode(cfg);
  if (!toolsSupported(cfg)) throw new Error('当前模型不支持工具调用');
  const all = system ? [{ role: 'system', content: system }, ...messages] : messages;
  try {
    return mode === 'openai'
      ? await callOpenAICompatible({ messages: all, temperature, maxTokens, signal, tools })
      : await callOllama({ messages: all, temperature, signal, tools });
  } catch (err) {
    if (err.toolsUnsupported) toolsUnsupported.add(`${mode}:${cfg.model}`);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 演示模式：不联网也能完整体验，回复基于本地状态生成                     */
/* ------------------------------------------------------------------ */

function pick(list, seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

export function demoChat(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  return demoReply(last);
}

export function demoReply(text) {
  const t = String(text).trim();
  const who = getSettings().userName === '你' ? '' : `${getSettings().userName}，`;

  if (/^(你好|hi|hello|嗨|在吗|早上好|晚上好)/i.test(t)) {
    return pick(
      [
        `${who}我在。今天想先清掉哪件事？`,
        `${who}在的。要我先看一眼任务板，还是直接说你现在最想推进的那一件？`,
        `我在。你可以把事丢给我，也可以只说说现在的状态。`
      ],
      t
    );
  }
  if (/(你是谁|介绍一下自己|你能做什么|怎么用)/.test(t)) {
    return [
      '我是静静，住在你这台主机上的个人管家。',
      '',
      '我大致做三件事：把你的话变成可执行的任务并派给不同的 Agent；需要你拍板时停下来等你，而不是一直占着机器；把值得长期记住的事写进本地数据库。',
      '',
      '你可以试试：「帮我整理下载文件夹」「记住我晚上十点后不想被打扰」「看看今天的进度」。'
    ].join('\n');
  }
  if (/(谢谢|辛苦|感谢)/.test(t)) {
    return pick(['不客气。有事随时叫我，我就在这台机器上。', '嗯，我在。下件事也可以直接说。'], t);
  }
  if (/(累|烦|焦虑|难过|压力|不想动|失眠)/.test(t)) {
    return [
      '听起来今天有点消耗。',
      '',
      '你愿意的话，可以先只做一件很小的事：把现在压着你的那件事写成一句话。我可以替你拆成下一步，其他的先放到明天。',
      '',
      '也可以直接跟我说「记住我今天状态不好」，我会把它留在记忆里，之后少安排一点。'
    ].join('\n');
  }
  if (/(你是谁|安全|隐私|数据)/.test(t)) {
    return '所有任务、记忆和日志都在本机的 SQLite 里，默认不往外发。只有你在设置里打开飞书/Telegram 或接入云端模型时，必要的内容才会离开这台机器。';
  }
  if (/(记住|记一下|记下)/.test(t)) {
    return '好，我记下了。以后做计划和回话时，我会把它带在上下文里。';
  }
  // 只在问任务板时这样回，不能看到「任务」两个字就套用（比如「实现任务来源插件」）。
  if (/(任务板|任务列表|进度|待办|今天该做|怎么安排)/.test(t)) {
    return '我把当前的任务板整理在「任务」页了。要我现在把最该先做的一件挑出来，或者替你排个顺序吗？';
  }
  if (t.endsWith('?') || t.endsWith('？')) {
    return pick(
      [
        '这个问题我可以接着往下想。不过在这台机器上，我更擅长把它变成具体动作——要我顺手列一个三步的执行清单吗？',
        '先给你一个务实的角度：把它拆成「现在能做的」「需要等的」「需要你拍板的」三类，通常就清楚下一步了。要我按你的实际情况拆一遍吗？'
      ],
      t
    );
  }
  return pick(
    [
      `收到。${truncate(t, 24)}这件事，我可以直接开一个任务去跑；也可以先陪你把它想清楚，你说了算。`,
      `嗯，我明白你的意思了。要我现在把它落成一个任务，还是先记下来，等你腾出手再处理？`,
      `我在听。如果你愿意，我可以把这件事拆成下一步，然后派给合适的 Agent 去做。`
    ],
    t
  );
}

/** 演示模式下，问答 Worker 的输出（尽量基于真实本地数据） */
export function demoTaskOutput({ task, memories = [], tasks = [] }) {
  const title = task.title || task.prompt || '这件事';
  const prompt = task.prompt || '';
  const wantDigest = /简报|汇总|日报|回顾|总结/.test(title + prompt);
  const wantInbox = /收件箱|inbox|新内容/i.test(title + prompt);

  if (wantInbox) {
    const fromPrompt = [...String(prompt).matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
    const names = (task.inbox_files?.length ? task.inbox_files : fromPrompt).filter(Boolean);
    if (names.length) {
      return [
        `我在收件箱里看到 ${names.length} 份新内容：`,
        ...names.map((n) => `- ${n}`),
        '',
        names.length > 1
          ? '建议先处理带时间点的那一份，其余的放进今天的空档。要我把它们分别拆成任务吗？'
          : '我已经把它整理成一条任务。要现在就开始，还是先放到下午？'
      ].join('\n');
    }
    return '收件箱现在是空的。等有新文件落进 `inbox/`，我会在这里告诉你。';
  }

  if (wantDigest) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const done = tasks.filter((t) => t.status === 'done' && t.finished_at && new Date(t.finished_at) >= midnight).length;
    const open = tasks.filter((t) => ['queued', 'running', 'waiting_approval'].includes(t.status));
    const waiting = tasks.filter((t) => t.status === 'waiting_approval');
    const lines = [`今天到目前为止：完成 ${done} 件，手上有 ${open.length} 件在路上。`];
    if (waiting.length) lines.push(`其中 ${waiting.length} 件在等你拍板，最好先看一眼。`);
    if (memories.length) {
      lines.push('', '另外，记忆里有两条和今天相关：');
      lines.push(...memories.slice(0, 2).map((m) => `- ${truncate(m.text, 60)}`));
    }
    lines.push('', '我的建议：先处理等待拍板的那件，再用一个完整的时间块做最费脑的一件。');
    return lines.join('\n');
  }

  if (/记忆|整理记忆|归档/.test(title)) {
    return `我过了一遍记忆库，现在有 ${memories.length} 条可用的上下文。已经把重复的表达合并，把带时间的偏好标了更高的权重。`;
  }

  return [
    `「${truncate(title, 30)}」我按现在的上下文跑了一遍，给你一个可以直接接着做的版本：`,
    '',
    '1. 先把目标收窄成一句可验收的话，避免做着做着范围变大。',
    '2. 找出这件事里最不确定的一环，先花十分钟验证它，而不是先做最熟的部分。',
    '3. 做完后把结论写回记忆库，下次同类事情就不用重新解释背景。',
    '',
    memories.length
      ? `我参考了你之前留下的 ${memories.length} 条记忆，尤其是：${truncate(memories[0].text, 50)}。`
      : '你还没给我留下太多背景。顺手说一句「记住……」，下次我会更贴近你的习惯。',
    '',
    '要我把第 1 步真的派下去执行吗？'
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 意图识别                                                            */
/* ------------------------------------------------------------------ */

const INTENTS = new Set(['chat', 'remember', 'task', 'status', 'recall', 'plugin']);
// 要静静写一个新插件：「写一个 RSS 来源插件」「实现任务来源插件并安装它」
const PLUGIN_RE = /(写|做|开发|实现|生成|创建|新建|搞|弄)(一个|个|一份)?.{0,24}(插件|plugin)/i;

const ACTION_RE = /(帮我|帮忙|请|安排|提醒|整理|检查|修复|写|做一个|做个|跑一下|执行|部署|总结|生成|清洗|归档|清理|重命名|移动|看看|看一下|处理|实现|开发|安装|接入|配置|搭建|创建|新建|添加|加一个|改一下|修改|优化|升级|迁移|导出|导入|同步|翻译|调研|分析|我想要|我希望|我需要)/;

/**
 * 离线意图识别。只判断意图和标题；具体派给哪个 Worker 由 worker-routing 按能力决定。
 */
export function heuristicClassify(text) {
  const t = String(text || '').trim();
  const out = { intent: 'chat', worker: null, title: '', reason: 'heuristic' };
  // 以「？」「吗」结尾的是提问；但「能帮我看看这个吗？」这类带请求词的仍算要做事。
  const asking = /(?:[?？]|吗)\s*$/.test(t) && !/(帮我|帮忙|麻烦|请你|请帮)/.test(t);
  const isAction = ACTION_RE.test(t) && t.length >= 4 && !asking;

  if (/(记住|记一下|记下|帮我记)/.test(t) || /我(?:更)?(?:喜欢|偏好|习惯|通常|一般|不喜欢|讨厌)/.test(t)) {
    out.intent = 'remember';
    return out;
  }
  if (PLUGIN_RE.test(t) && !asking) {
    out.intent = 'plugin';
    out.title = makeTitle(t);
    return out;
  }
  // 「待办」「今天该做」既可能是问进度，也可能是要求做事：带动作词时按任务处理。
  if (/(进度|状态|任务板|在做什么|怎么样了|跑了哪些)/.test(t) || (/(待办|今天该做)/.test(t) && !isAction)) {
    out.intent = 'status';
    return out;
  }
  if (/(你还记得|记不记得|之前说过|我的偏好是什么)/.test(t)) {
    out.intent = 'recall';
    return out;
  }
  if (isAction) {
    out.intent = 'task';
    out.title = makeTitle(t);
  }
  return out;
}

export function makeTitle(text) {
  let t = String(text || '').trim();
  t = t.replace(/^(帮我|帮忙|请你|请|能不能|可以|麻烦你?|我想让你|我想要你)\s*/g, '');
  t = t.replace(/[。！!？?]+$/g, '');
  return truncate(t, 28);
}

export async function classify(text, { history = [], workers = [], workflows = [] } = {}) {
  const cfg = getSettings();
  if (llmMode(cfg) === 'demo') return heuristicClassify(text);

  const system = [
    '你是个人 AI 管家「静静」的 Router。结合最近对话，把用户当前这句话分类成一个意图，只输出 JSON。',
    'intent 取值：chat（闲聊/咨询）、remember（要求记住事实或偏好）、task（要求执行一件事）、status（询问任务进度）、recall（检索记忆）、plugin（要求给静静写一个新的任务来源插件或 Worker 插件）。',
    'pluginKind 仅在 intent=plugin 时填写：source（接收 / 拉取外部消息、事件的来源插件）或 worker（执行任务的 Worker 插件）。',
    'worker 仅在 intent=task 时填写，从下面的可用 Worker 里选最合适、开销最低的一个：',
    ...(workers.length
      ? workers.map(describeWorker)
      : ['-（当前没有可用的 Worker，worker 留空）']),
    'title 仅在 intent=task 时填写：不超过 24 字的任务名，不要带「帮我」等客套词。',
    ...(workflows.length ? [
      'workflow 仅在 intent=task 且请求明显属于下面某个用户配置的工作流程时填写它的 id，否则留空：',
      ...workflows.map((w) => `- ${w.id}：${w.name}${w.when ? `（触发词：${w.when}）` : ''}${w.hint ? `，${w.hint}` : ''}`)
    ] : []),
    'JSON 结构：{"intent":"...","worker":"...","title":"...","workflow":"","pluginKind":""}'
  ].join('\n');

  try {
    const recent = history.slice(-6)
      .map((m) => `${m.role === 'user' ? '用户' : '静静'}：${String(m.text || '').slice(0, 300)}`)
      .join('\n');
    const content = recent ? `最近对话：\n${recent}\n\n当前消息：${text}` : text;
    const res = await chat({
      system,
      messages: [{ role: 'user', content }],
      json: true,
      temperature: 0.1,
      maxTokens: 240
    });
    const parsed = JSON.parse(res.text);
    if (!INTENTS.has(parsed.intent)) throw new Error('bad intent');
    const allowed = new Set(workers.map((w) => w.id));
    return {
      intent: parsed.intent,
      // 模型选了不存在的 Worker 时交给 worker-routing 按能力兜底。
      worker: allowed.has(parsed.worker) ? parsed.worker : null,
      title: parsed.title ? truncate(String(parsed.title), 30) : makeTitle(text),
      workflow: workflows.some((w) => w.id === parsed.workflow) ? parsed.workflow : null,
      pluginKind: ['source', 'worker'].includes(parsed.pluginKind) ? parsed.pluginKind : null,
      reason: 'model',
      tokens: res.tokens
    };
  } catch (err) {
    console.warn('[llm] classify fallback:', err.message);
    return heuristicClassify(text);
  }
}

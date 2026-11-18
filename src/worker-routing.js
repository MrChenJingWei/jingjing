/**
 * 按「能力」把任务派给 Worker。这里不认识任何具体的 Worker id：
 * 内置 Worker 和插件 Worker 都通过 manifest 的 worker 段声明 abilities / cost / keywords，
 * Router 只问「谁能做这件事、谁最便宜」。
 *
 * 纯函数，方便单测；可用 Worker 列表由调用方（workers.workerCatalog）传入。
 */
import { matchTerm } from './routing-signals.js';
import { candidatesForCapabilities } from './capabilities.js';

const WRITE_FILE_RE = [
  /(?:生成|写|创建|新建|建|保存|导出|做一个|做一份).{0,40}(?:文件|文档|txt|md|markdown|tex|json|csv|html)/i,
  /(?:文件|文档).{0,40}(?:写|内容|保存)/i,
  /[A-Za-z0-9_\-一-龥]+\.(?:txt|md|markdown|tex|json|csv|html)/i
];
// 明确指向仓库/版本控制的词：即使模型已经选了 Worker，也要求对方具备 code 能力。
const CODE_STRONG_RE = /(github|git\b|repo|仓库|代码|提交|推送|部署|分支)/i;
// 只在离线启发式（没有模型判断）时使用的弱信号。
const CODE_WEAK_RE = /(bug|lint|测试|重构|接口|函数|脚本|编译|报错|依赖)/i;
const MANAGE_FILES_RE = /(文件夹|目录|下载|归档|清理|重命名|移动|复制|删除)/;

/**
 * 从任务文本推断它需要的能力。
 * decided=true 表示模型已经给出了选择，此时只用强信号纠偏，避免把模型的判断改得太激进。
 */
export function detectNeed(text, { decided = false } = {}) {
  const t = String(text || '');
  if (WRITE_FILE_RE.some((re) => re.test(t))) return 'write-file';
  if (CODE_STRONG_RE.test(t)) return 'code';
  if (decided) return null;
  if (MANAGE_FILES_RE.test(t)) return 'manage-files';
  if (CODE_WEAK_RE.test(t)) return 'code';
  return null;
}

const FILE_TERM_RE = /(文件|文档|txt|markdown|md|tex|json|csv|html)/i;

/**
 * 和 detectNeed 一样推断需要的能力，同时给出是哪个词触发的（比如「代码」「仓库」「文件」），
 * 用来向用户说明、或者生成一条看得懂的分配规则。没有信号时返回 null。
 */
export function needSignal(text, { decided = false } = {}) {
  const t = String(text || '');
  for (const re of WRITE_FILE_RE) {
    const hit = t.match(re);
    if (hit) return { need: 'write-file', term: hit[0].match(FILE_TERM_RE)?.[0] || hit[0] };
  }
  const strong = t.match(CODE_STRONG_RE);
  if (strong) return { need: 'code', term: strong[0] };
  if (decided) return null;
  const files = t.match(MANAGE_FILES_RE);
  if (files) return { need: 'manage-files', term: files[0] };
  const weak = t.match(CODE_WEAK_RE);
  if (weak) return { need: 'code', term: weak[0] };
  return null;
}

// 要调外部工具（MCP 服务、命令行工具）才能做：只有能执行命令的 Worker（code 能力）做得了。
const TOOL_RE = /\bmcp\b|\bcli\b|命令行/i;

/** 文本里写了要用 MCP / 命令行工具（比如「用 tapd-mcp 查」）：返回 { need: 'code', term }，没有返回 null。 */
export function toolSignal(text) {
  const hit = String(text || '').match(TOOL_RE);
  return hit ? { need: 'code', term: hit[0] } : null;
}

// Worker 给的拍板选项以「改用 / 换成 / 交给 …」开头，说的是换一个 Worker 来做；
// 「我去 Claude Code 里查」是让用户自己去用，不算。
const HANDOFF_RE = /^\s*(?:改用|换用|换成|改派给?|转交给?|交给|让)/;

// 只在主人自己的对话（网页 / Telegram 聊天、拍板里的自定义回复）里才认的口语别名：
// 说「用 deepseek 去做」=「DeepSeek Harness」。外部来源消息（插件、企微等）走 namedWorker
// 的默认分支，不带 aliases 开关，所以外部的「deepseek」不会改派。
const CHAT_ALIASES = [['deepseek', 'dsh']];

function aliasWorker(text, workers) {
  for (const [word, id] of CHAT_ALIASES) {
    const worker = workers.find((w) => w.id === id && w.available !== false);
    // matchTerm 会处理边界，避免把「deepseek-chat」这类模型名说成换 Worker。
    if (worker && matchTerm(text, word)) return worker;
  }
  return null;
}

/** 拍板选项是不是「换成某个可用 Worker 来做」，是的话返回那个 Worker，否则 null。 */
export function handoffWorker(option, workers = []) {
  return HANDOFF_RE.test(String(option || '')) ? namedWorker(option, workers) : null;
}

/** 能做这件事（具备 ability）的可用 Worker 里开销最低的一个。 */
export function cheapestWith(workers, ability) {
  return cheapest(workers.filter((w) => w.available !== false), (w) => can(w, ability));
}

function keywordRe(worker) {
  if (!worker.keywords) return null;
  try { return new RegExp(worker.keywords, 'i'); } catch { return null; }
}

/** Worker 的名字/别名（大小写、全半角、标点都不影响）。 */
function aliasHit(worker, text) {
  return (worker.aliases || []).some((alias) => matchTerm(text, alias));
}

/** 用户是不是点名了这个 Worker：先看别名，老插件的 keywords 正则继续兼容。 */
function namedHit(worker, text) {
  return aliasHit(worker, text) || Boolean(keywordRe(worker)?.test(text));
}

/** 开销低的优先；同开销时内置优先，再按 id 排，保证结果稳定。 */
function byPreference(a, b) {
  return (a.cost ?? 3) - (b.cost ?? 3)
    || Number(b.source === 'builtin') - Number(a.source === 'builtin')
    || String(a.id).localeCompare(String(b.id));
}

function cheapest(workers, predicate) {
  return workers.filter(predicate).sort(byPreference)[0] || null;
}

const can = (worker, ability) => Array.isArray(worker?.abilities) && worker.abilities.includes(ability);

/** 给模型看的一行 Worker 说明：描述 + 用户补充的本机能力（比如接了哪些 MCP）+ 能力标签。 */
export function describeWorker(w) {
  const desc = w.description ? `：${w.description}` : '';
  const notes = w.notes ? `；本机补充：${w.notes}` : '';
  const abilities = w.abilities?.length ? ` [能力：${w.abilities.join(', ')}]` : '';
  const aliases = w.aliases?.length ? ` [别名：${w.aliases.join('、')}]` : '';
  const capabilities = w.capabilityLabels?.length ? ` [能用：${w.capabilityLabels.join('、')}]` : '';
  return `- ${w.id}（${w.label || w.id}）${desc}${notes}${abilities}${aliases}${capabilities}`;
}

/**
 * 一句话里点名了哪个可用的 Worker（按 manifest 的 keywords 认，比如「用 claude 通过 tapd 查」→ Claude Code）。
 * 点名了多个时取开销最低的；没点名或点名的不可用时返回 null。
 * aliases=true 时额外认主人对话里的口语别名（目前只有「deepseek」→ dsh），外部来源不要传。
 */
export function namedWorker(text, workers = [], { aliases = false, includeUnavailable = false } = {}) {
  const t = String(text || '');
  if (!t) return null;
  const pool = workers.filter((w) => includeUnavailable || w.available !== false);
  if (aliases) {
    const alias = aliasWorker(t, pool);
    if (alias) return alias;
  }
  return pool.filter((w) => namedHit(w, t)).sort(byPreference)[0] || null;
}

/**
 * @param {object} input
 * @param {string} input.text       任务文本
 * @param {string|null} input.requested  模型或调用方建议的 Worker id
 * @param {boolean} input.decided   requested 是否来自模型判断
 * @param {Array} input.workers     [{ id, label, available, abilities, cost, keywords, source }]
 * @param {string|null} input.fallback  主人在设置里指定的兜底 Worker；不可用或没指定时用最便宜的文本 Worker
 * @param {boolean} input.aliases  是否认主人对话里的口语别名（外部来源不要传）
 * @returns {{ worker: string|null, need: string|null, reason: string, note: string }}
 */
export function pickWorker({
  text = '',
  requested = null,
  decided = false,
  workers = [],
  fallback: preferred = null,
  aliases = false,
  capabilityIds = [],
  capabilityCatalog = []
} = {}) {
  const usable = workers.filter((w) => w.available !== false);
  const byId = new Map(workers.map((w) => [w.id, w]));
  // 用户点名了一个本机不可用的 Worker（比如「用 codex 跑」但没装 codex）：按它被请求处理，好在回复里说明改派。
  if (!requested && !usable.some((w) => keywordRe(w)?.test(text))) {
    requested = workers.find((w) => w.available === false && keywordRe(w)?.test(text))?.id || null;
  }
  const requestedWorker = requested ? byId.get(requested) : null;
  const requestedUsable = Boolean(requestedWorker && requestedWorker.available !== false);
  const label = (w) => w?.label || w?.id || requested;
  const unavailableNote = (picked) => (requested && !requestedUsable && picked && picked.id !== requested
    ? `（本机没有可用的「${label(requestedWorker) || requested}」Worker，改派给「${label(picked)}」）`
    : '');

  // 1. 用户点名：别名（新）或插件关键词（老）优先。
  const hits = usable.filter((w) => namedHit(w, text));
  if (aliases) {
    const alias = aliasWorker(text, usable);
    if (alias && !hits.some((w) => w.id === alias.id)) hits.push(alias);
  }
  if (hits.length) {
    const picked = requestedUsable && hits.some((w) => w.id === requested) ? requestedWorker : hits.sort(byPreference)[0];
    return { worker: picked.id, need: null, reason: 'keywords', note: unavailableNote(picked) };
  }

  // 2. 文本里点到的具体能力（tapd-cli、git…）：先收窄候选。
  const wanted = [...new Set(capabilityIds.filter(Boolean))];
  const cap = wanted.length ? candidatesForCapabilities(wanted, usable, capabilityCatalog) : { workers: [], fallback: false };
  const showCapability = (worker) => wanted.length && cap.fallback
    ? `（它没声明具体工具，但能执行本机命令）`
    : '';

  // 3. 模型选择：可用、满足硬能力，并且符合文本提到的具体能力。
  const need = detectNeed(text, { decided });
  if (requestedUsable && (!need || can(requestedWorker, need))) {
    const fitsCapability = !wanted.length || !cap.workers.length || cap.workers.some((w) => w.id === requested);
    if (fitsCapability) {
      return { worker: requested, need, reason: decided ? 'model' : 'requested', note: '' };
    }
  }
  // 4. 能力候选：唯一直接选；多个按偏好；模型优先在候选里。
  if (cap.workers.length) {
    const picked = requestedUsable && cap.workers.some((w) => w.id === requested)
      ? requestedWorker
      : cap.workers.slice().sort(byPreference)[0];
    return {
      worker: picked.id,
      need,
      reason: 'capability',
      note: `${showCapability(picked)}${wanted.length ? `（按能力「${wanted.join('、')}」）` : ''}`
    };
  }
  // 5. 文本明确需要某种能力时，要求 Worker 具备它。
  if (need) {
    const picked = cheapest(usable, (w) => can(w, need));
    if (picked) return { worker: picked.id, need, reason: 'ability', note: unavailableNote(picked) };
  }

  // 6. 兜底：主人指定的兜底 Worker（比如舍得花钱的用 Claude Code），否则最便宜的文本 Worker。
  const fallback = (preferred ? usable.find((w) => w.id === preferred) : null)
    || cheapest(usable, (w) => can(w, 'text')) || usable.slice().sort(byPreference)[0] || null;
  if (fallback) {
    const note = unavailableNote(fallback)
      || (need ? `（本机没有具备「${need}」能力的 Worker，先交给「${label(fallback)}」）` : '');
    return { worker: fallback.id, need, reason: 'fallback', note };
  }
  return { worker: requested || null, need, reason: 'none', note: '' };
}

/**
 * 按「能力」把任务派给 Worker。这里不认识任何具体的 Worker id：
 * 内置 Worker 和插件 Worker 都通过 manifest 的 worker 段声明 abilities / cost / keywords，
 * Router 只问「谁能做这件事、谁最便宜」。
 *
 * 纯函数，方便单测；可用 Worker 列表由调用方（workers.workerCatalog）传入。
 */

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

/** 能做这件事（具备 ability）的可用 Worker 里开销最低的一个。 */
export function cheapestWith(workers, ability) {
  return cheapest(workers.filter((w) => w.available !== false), (w) => can(w, ability));
}

function keywordRe(worker) {
  if (!worker.keywords) return null;
  try { return new RegExp(worker.keywords, 'i'); } catch { return null; }
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
  return `- ${w.id}（${w.label || w.id}）${desc}${notes}${abilities}`;
}

/**
 * 一句话里点名了哪个可用的 Worker（按 manifest 的 keywords 认，比如「用 claude 通过 tapd 查」→ Claude Code）。
 * 点名了多个时取开销最低的；没点名或点名的不可用时返回 null。
 */
export function namedWorker(text, workers = []) {
  const t = String(text || '');
  if (!t) return null;
  return workers.filter((w) => w.available !== false && keywordRe(w)?.test(t)).sort(byPreference)[0] || null;
}

/**
 * @param {object} input
 * @param {string} input.text       任务文本
 * @param {string|null} input.requested  模型或调用方建议的 Worker id
 * @param {boolean} input.decided   requested 是否来自模型判断
 * @param {Array} input.workers     [{ id, label, available, abilities, cost, keywords, source }]
 * @returns {{ worker: string|null, need: string|null, reason: string, note: string }}
 */
export function pickWorker({ text = '', requested = null, decided = false, workers = [] } = {}) {
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

  // 1. 插件声明的关键词：用户点名了某个工具时优先交给它。
  const hits = usable.filter((w) => keywordRe(w)?.test(text));
  if (hits.length) {
    const picked = requestedUsable && hits.some((w) => w.id === requested) ? requestedWorker : hits.sort(byPreference)[0];
    return { worker: picked.id, need: null, reason: 'keywords', note: unavailableNote(picked) };
  }

  // 2. 文本明确需要某种能力时，要求 Worker 具备它。
  const need = detectNeed(text, { decided });
  if (requestedUsable && (!need || can(requestedWorker, need))) {
    return { worker: requested, need, reason: decided ? 'model' : 'requested', note: '' };
  }
  if (need) {
    const picked = cheapest(usable, (w) => can(w, need));
    if (picked) return { worker: picked.id, need, reason: 'ability', note: unavailableNote(picked) };
  }

  // 3. 兜底：最便宜的文本 Worker。
  const fallback = cheapest(usable, (w) => can(w, 'text')) || usable.slice().sort(byPreference)[0] || null;
  if (fallback) {
    const note = unavailableNote(fallback)
      || (need ? `（本机没有具备「${need}」能力的 Worker，先交给「${label(fallback)}」）` : '');
    return { worker: fallback.id, need, reason: 'fallback', note };
  }
  return { worker: requested || null, need, reason: 'none', note: '' };
}

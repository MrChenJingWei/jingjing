/**
 * 路由用的文本信号：归一化、别名匹配、关键词编译。
 *
 * 原则：人话在写入时编译成关键词；运行时只做归一化后的确定性匹配，
 * 不再把用户的话直接当正则。正则仍然支持，但要显式选择。
 */

/** 转义正则元字符，把用户写的词当字面量用。 */
export function escapeRegExp(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化：全半角统一、转小写、去掉空白和标点，只留文字和数字。 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 按逗号、顿号、竖线、换行拆关键词；去空、去重、保持顺序。 */
export function splitTerms(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  const out = [];
  for (const part of raw.split(/[,，、|\n]/)) {
    const term = part.trim();
    if (!term) continue;
    if (!out.includes(term)) out.push(term);
  }
  return out;
}

/**
 * 一个词能不能在这段话里认出来。
 * - 不含中文的词（claude、npm、tapd-cli、claude code）：按字面匹配，要求前后不是 ASCII 字母/数字/下划线/连字符，
 *   这样 dsh 不会命中 dshd、git 不会命中 github、deepseek 不会命中 deepseek-chat；
 * - 含中文的词：归一化后子串匹配（中文不靠空格分词）。
 */
export function matchTerm(text, term) {
  const literal = String(term ?? '').normalize('NFKC').toLowerCase().trim();
  if (!literal) return false;
  if (!/[\u3400-\u9fff]/.test(literal)) {
    const raw = String(text ?? '').normalize('NFKC').toLowerCase();
    const pattern = new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(literal)}(?=[^a-z0-9_-]|$)`);
    return pattern.test(raw);
  }
  const needle = normalizeText(literal);
  return needle ? normalizeText(text).includes(needle) : false;
}

/** 一组词里命中了哪些（保持传入顺序）。 */
export function matchTerms(text, terms = []) {
  return terms.filter((term) => matchTerm(text, term));
}

/**
 * 把用户写的触发词编译成运行时能用的形状。
 * - keywords（默认）：按逗号/顿号/竖线拆词，编译成「转义后的或正则」，运行时不会再被正则元字符误伤；
 * - regex：保留原来的正则语义（高级用法，兼容老配置）。
 * 返回的 terms 供归一化匹配用，regex 供兼容老代码使用。
 */
export function compileTerms(value, { mode = 'keywords', negatives = '' } = {}) {
  const rawMode = mode === 'regex' ? 'regex' : 'keywords';
  const terms = rawMode === 'keywords' ? splitTerms(value) : [];
  const negations = splitTerms(negatives);
  if (rawMode === 'regex') {
    const raw = String(value ?? '').trim();
    if (!raw) return { mode: rawMode, terms: [], negatives: negations, trigger: null, error: null };
    try {
      return { mode: rawMode, terms: [], negatives: negations, trigger: new RegExp(raw, 'i'), error: null };
    } catch (err) {
      return { mode: rawMode, terms: [], negatives: negations, trigger: null, error: `不是合法的正则：${err.message}` };
    }
  }
  if (!terms.length) return { mode: rawMode, terms: [], negatives: negations, trigger: null, error: null };
  const pattern = terms.map(escapeRegExp).join('|');
  return { mode: rawMode, terms, negatives: negations, trigger: new RegExp(pattern, 'i'), error: null };
}

/** 判断一句话是否命中编译好的触发词；negatives 命中即排除。返回命中的词和长度。 */
export function matchCompiled(text, compiled) {
  if (!compiled) return null;
  if (compiled.negatives?.length && matchTerms(text, compiled.negatives).length) return null;
  if (compiled.mode === 'regex') {
    const hit = compiled.trigger ? String(text ?? '').match(compiled.trigger) : null;
    return hit ? { term: hit[0], length: hit[0].length } : null;
  }
  let best = null;
  for (const term of compiled.terms || []) {
    if (!matchTerm(text, term)) continue;
    if (!best || term.length > best.length) best = { term, length: term.length };
  }
  return best;
}

/** 模型给的“点名证据”必须真的出现在原话里；空证据视为旧格式（放行，由调用方决定信任级别）。 */
export function evidenceMatches(text, evidence) {
  const quote = String(evidence ?? '').trim();
  if (!quote) return true;
  return normalizeText(text).includes(normalizeText(quote));
}

/** 别名列表：去空、去重、限长。 */
export function normalizeAliases(value, max = 8) {
  const raw = Array.isArray(value) ? value : splitTerms(value);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const alias = String(item ?? '').trim().slice(0, 30);
    const key = normalizeText(alias);
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= max) break;
  }
  return out;
}

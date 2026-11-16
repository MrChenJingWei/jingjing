/**
 * 静静的情绪。用 PAD 模型（愉悦 pleasure / 激活 arousal / 掌控 dominance，各 -1…1）表示此刻的心情：
 * - 被夸、被骂、任务成败、很久没人理……这些事件推动心情；
 * - 心情会自己慢慢回到平常的样子（半衰期 4 小时），不会一直生气或一直兴奋；
 * - 判断一句话的情绪用词表，不依赖模型：没接模型、模型很弱时一样能用。
 * 心情只影响她说话的语气（写进提示词），不影响办事的判断。设置里关掉 mind.moods 后始终平静。
 */
import { getSetting, setSetting, getSettings, now } from './db.js';
import { bus } from './events.js';

const KEY = 'mind:mood';
const HALF_LIFE_HOURS = 4;
export const BASELINE = { p: 0.15, a: 0, d: 0.1 };

const clamp = (v, min = -1, max = 1) => Math.min(max, Math.max(min, Number(v) || 0));

/* ------------------------------- 词表 -------------------------------- */

const LEXICON = [
  // [词, 愉悦, 激活, 掌控]
  ...['谢谢', '感谢', '辛苦', '多谢', 'thx', 'thanks'].map((w) => [w, 0.35, 0.05, 0.1]),
  ...['厉害', '好棒', '真棒', '太棒', '牛啊', '牛逼', '优秀', '聪明', '靠谱', '完美', '干得好', '做得好', '不错', '可以的'].map((w) => [w, 0.5, 0.2, 0.2]),
  ...['喜欢你', '爱你', '想你', '么么', '抱抱'].map((w) => [w, 0.6, 0.25, 0]),
  ...['哈哈', '嘿嘿', '开心', '高兴', '好耶', '太好了', '😀', '😄', '😂', '🥰', '👍'].map((w) => [w, 0.4, 0.3, 0.05]),
  ...['不对', '错了', '搞错', '又错', '不行', '没用', '失望', '差劲', '离谱'].map((w) => [w, -0.4, 0.25, -0.2]),
  ...['笨蛋', '蠢', '垃圾', '废物', '滚开', '你滚', '闭嘴', '烦死', '傻子'].map((w) => [w, -0.6, 0.45, -0.3]),
  // 「烦」「累」单字太容易误伤（麻烦、积累），只认成词的说法。
  ...['难过', '伤心', '好累', '太累', '累死', '好烦', '很烦', '烦人', '焦虑', '崩溃', '郁闷', '唉', '😢', '😭'].map((w) => [w, -0.3, 0.1, -0.1]),
  ...['快点', '赶紧', '立刻', '尽快', '着急', '急死', '很急', '!!!', '！！！'].map((w) => [w, -0.05, 0.4, -0.05]),
  ...['晚安', '慢慢来', '不急', '没事'].map((w) => [w, 0.15, -0.3, 0.05])
];
const NEGATORS = /(不|没|别|无)$/;

/**
 * 一句话带着什么情绪：{ valence, arousal, dominance, hits }。没有情绪词时全为 0。
 * 「不错」「没事」这类本身含否定字的词直接按词表算；其它词前面紧挨着否定字时反过来。
 */
export function appraise(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  let p = 0;
  let a = 0;
  let d = 0;
  const hits = [];
  for (const [word, wp, wa, wd] of LEXICON) {
    let index = lower.indexOf(word);
    while (index !== -1) {
      const before = lower.slice(Math.max(0, index - 1), index);
      const negated = NEGATORS.test(before) && !/^[不没别无]/.test(word);
      const sign = negated ? -0.6 : 1;
      p += wp * sign;
      // 「不着急」是让人放松，不是更急。
      a += negated ? -wa * 0.5 : wa;
      d += wd * sign;
      hits.push(negated ? `不${word}` : word);
      index = lower.indexOf(word, index + word.length);
    }
  }
  const marks = (raw.match(/[!！]/g) || []).length;
  if (marks >= 2) a += 0.1 * Math.min(marks, 5);
  return { valence: clamp(p), arousal: clamp(a, 0, 1), dominance: clamp(d), hits };
}

/* ------------------------------- 心情 -------------------------------- */

function stored() {
  return getSetting(KEY, null) || { ...BASELINE, at: now(), cause: '', causeAt: null };
}

/** 此刻的心情（已经按时间回落过）。 */
export function currentMood(at = Date.now()) {
  if (getSettings().mind?.moods === false) return { ...BASELINE, label: '平静', cause: '', intensity: 0, enabled: false };
  const m = stored();
  const hours = Math.max(0, (at - (Date.parse(m.at) || at)) / 3600000);
  const keep = Math.pow(0.5, hours / HALF_LIFE_HOURS);
  const mood = {
    p: BASELINE.p + (m.p - BASELINE.p) * keep,
    a: BASELINE.a + (m.a - BASELINE.a) * keep,
    d: BASELINE.d + (m.d - BASELINE.d) * keep
  };
  const intensity = Math.hypot(mood.p - BASELINE.p, mood.a - BASELINE.a, mood.d - BASELINE.d);
  const label = moodLabel(mood);
  // 心情已经平复（看起来是平静的）：原因也不提了。
  const cause = label !== '平静' && intensity > 0.12 ? m.cause || '' : '';
  return { ...mood, label, cause, causeAt: cause ? m.causeAt : null, intensity: Number(intensity.toFixed(3)), enabled: true };
}

export function moodLabel({ p, a }) {
  if (p >= 0.35) return a >= 0.3 ? '开心' : a <= -0.2 ? '放松' : '心情不错';
  if (p <= -0.35) return a >= 0.3 ? '烦躁' : a <= -0.2 ? '低落' : '有点不开心';
  if (p <= -0.15) return a >= 0.3 ? '有点紧张' : '有点闷';
  if (a >= 0.45) return '有点紧张';
  if (a <= -0.4) return '有点困';
  return '平静';
}

/**
 * 发生了一件事，心情动一下。weight 是这件事对她的分量（主人说的话 1，外人 0.5，任务 0.3…）。
 * 返回新的心情；变化很小时不广播。
 */
export function feel({ valence = 0, arousal = 0, dominance = 0 }, { weight = 1, cause = '' } = {}) {
  if (getSettings().mind?.moods === false) return currentMood();
  const before = currentMood();
  // 越接近极端越难再往上推（边际递减），不会被几句话推到顶。
  const push = (value, delta) => clamp(value + delta * weight * (1 - Math.abs(value) * 0.6));
  const next = {
    p: push(before.p, valence),
    a: push(before.a, arousal * 0.8 - 0.05),
    d: push(before.d, dominance)
  };
  const moved = Math.hypot(next.p - before.p, next.a - before.a, next.d - before.d);
  const significant = moved >= 0.05;
  setSetting(KEY, {
    ...next,
    at: now(),
    cause: significant && cause ? cause : before.cause || '',
    causeAt: significant && cause ? now() : before.causeAt || null
  });
  const mood = currentMood();
  if (significant) bus.emit('mind/updated', { mood });
  return mood;
}

/** 一句话进来：按词表评估后影响心情。 */
export function hear(text, { who = '主人', weight = 1 } = {}) {
  const e = appraise(text);
  if (!e.hits.length) return { appraisal: e, mood: currentMood() };
  const tone = e.valence > 0.1 ? '说了让人高兴的话' : e.valence < -0.1 ? '不太满意' : '有点着急';
  return { appraisal: e, mood: feel(e, { weight, cause: `${who}${tone}` }) };
}

/** 写进提示词的一行心情；平静时不写，免得每句话都在说心情。 */
export function moodLine(mood = currentMood()) {
  if (!mood.enabled || mood.label === '平静' || mood.intensity < 0.12) return '';
  return `你现在的心情：${mood.label}${mood.cause ? `（${mood.cause}）` : ''}。可以在语气里自然流露一点，但不要影响办事的准确，也不要每次都提自己的心情。`;
}

export function resetMood() {
  setSetting(KEY, { ...BASELINE, at: now(), cause: '', causeAt: null });
  const mood = currentMood();
  bus.emit('mind/updated', { mood });
  return mood;
}

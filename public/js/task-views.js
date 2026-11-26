// 任务列表的「分组方式」：同一批任务按状态、来源、外部状态、执行者、时间分成几段。
// 这里只管怎么分、怎么排、每段叫什么；行和段头怎么画在 tasks.js。按归类分组沿用 classify.js 的渲染。
import { state, workerLabel, workerGlyph } from './core.js';

/** 结果最后一句是在问人：提示主人可以直接回答。 */
export function endsWithQuestion(text) {
  const last = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).pop() || '';
  return /[?？]\s*[)）*_`]*$|吗[。.]?$/.test(last);
}

export const SOURCE_STATUS_LABEL = {
  open: '待处理',
  in_progress: '进行中',
  blocked: '阻塞',
  review: '待确认',
  done: '已完成',
  cancelled: '已关闭',
  unknown: '未知'
};

/** 任务来源：插件 id、对话、手动、自动化。 */
export function sourceKey(task) {
  const origin = String(task.origin || '');
  if (origin.startsWith('plugin:')) return origin.slice('plugin:'.length);
  if (origin.startsWith('rule:') || task.rule_id) return '__automation';
  if (origin === 'schedule') return '__automation';
  if (origin === 'web') return 'chat';
  return origin || 'chat';
}

export function sourceName(key) {
  if (key === '__automation') return '自动化';
  const plugin = (state.plugins || []).find((item) => item.id === key);
  if (plugin) return plugin.label || plugin.name || key;
  return { chat: '对话', manual: '手动', proactive: '规则发现', seed: '演示数据' }[key] || key;
}

/*
 * 按状态：按「这件事要你做什么」分四段，从上到下越来越不用操心。
 * 这四段也是列表顶上那四块计数，点一块就只看这一段。
 */
export const SECTIONS = [
  {
    id: 'attention', label: '要你处理', tone: 'warm', glyph: 'waiting_approval',
    test: (t) => t.status === 'waiting_approval' || t.status === 'failed' || (t.status === 'done' && !t.outcome && endsWithQuestion(t.result)),
    rank: (t) => (t.status === 'waiting_approval' ? 0 : t.status === 'failed' ? 1 : 2)
  },
  { id: 'doing', label: '在做', tone: 'run', glyph: 'running', test: (t) => ['running', 'queued'].includes(t.status), rank: (t) => (t.status === 'running' ? 0 : 1) },
  { id: 'held', label: '只跟踪', tone: 'muted', glyph: 'held', hint: '不执行，只看来源状态', test: (t) => t.status === 'held', foldAt: 6 },
  { id: 'finished', label: '已结束', tone: 'ok', glyph: 'done', test: () => true, foldAt: 6, by: (t) => t.finished_at || t.updated_at || t.created_at }
];

export function sectionOf(task) {
  return SECTIONS.find((section) => section.test(task));
}

const SECTION_RANK = Object.fromEntries(SECTIONS.map((section, i) => [section.id, i]));
const stamp = (t) => Date.parse(t.updated_at || t.created_at) || 0;

/** 非「按状态」的分组里，段内也是要你处理的排在前面，其次在做、只跟踪、已结束，同一档按最近排。 */
function byUrgency(a, b) {
  const sa = sectionOf(a);
  const sb = sectionOf(b);
  return (SECTION_RANK[sa.id] - SECTION_RANK[sb.id]) || ((sa.rank?.(a) ?? 0) - (sb.rank?.(b) ?? 0)) || stamp(b) - stamp(a);
}

/** 一段里最急的那张决定这段排第几：有要你处理的段排在前面，其次看数量。 */
function byGroupUrgency(a, b) {
  const top = (g) => Math.min(...g.list.map((t) => SECTION_RANK[sectionOf(t).id]));
  return (top(a) - top(b)) || b.list.length - a.list.length || a.label.localeCompare(b.label, 'zh');
}

function firstLink(task) {
  return (task.sources || [])[0] || null;
}

const EXTERNAL_ORDER = ['blocked', 'open', 'in_progress', 'review', 'done', 'cancelled', 'unknown', 'none'];

const DAY = 24 * 60 * 60 * 1000;
function timeBucket(task, at = Date.now()) {
  const t = stamp(task);
  const today = new Date(at);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (t >= start) return 'today';
  if (t >= start - DAY) return 'yesterday';
  if (t >= start - 6 * DAY) return 'week';
  if (t >= start - 29 * DAY) return 'month';
  return 'older';
}
const TIME_GROUPS = [
  ['today', '今天'], ['yesterday', '昨天'], ['week', '这一周'], ['month', '这个月'], ['older', '更早']
];

/**
 * 分组方式。bucket(tasks) 返回排好序的段：{ key, label, tone?, badge?, hint?, foldAt?, list }。
 * category（按归类）由 classify.js 渲染，这里只占个位置。
 */
export const DIMENSIONS = [
  {
    id: 'status', label: '状态',
    bucket(tasks) {
      return SECTIONS.map((section) => {
        const list = tasks.filter((t) => sectionOf(t) === section);
        const at = (t) => Date.parse(section.by ? section.by(t) : t.updated_at || t.created_at) || 0;
        list.sort((a, b) => ((section.rank?.(a) ?? 0) - (section.rank?.(b) ?? 0)) || at(b) - at(a));
        return { key: section.id, label: section.label, tone: section.tone, glyph: section.glyph, hint: section.hint, foldAt: section.foldAt, list };
      });
    }
  },
  {
    id: 'source', label: '来源',
    bucket(tasks) {
      const groups = new Map();
      for (const t of tasks) {
        const key = sourceKey(t);
        if (!groups.has(key)) groups.set(key, { key, label: sourceName(key), badge: sourceName(key).slice(0, 1).toUpperCase(), list: [] });
        groups.get(key).list.push(t);
      }
      return [...groups.values()].map((g) => ({ ...g, list: g.list.sort(byUrgency) })).sort(byGroupUrgency);
    }
  },
  {
    id: 'external', label: '外部状态',
    bucket(tasks) {
      const groups = new Map();
      for (const t of tasks) {
        const link = firstLink(t);
        const key = link ? link.status?.category || 'unknown' : 'none';
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            label: key === 'none' ? '没关联外部单子' : `外部${SOURCE_STATUS_LABEL[key] || key}`,
            dot: key,
            foldAt: ['done', 'cancelled', 'none'].includes(key) ? 6 : 0,
            list: []
          });
        }
        groups.get(key).list.push(t);
      }
      return [...groups.values()]
        .map((g) => ({ ...g, list: g.list.sort(byUrgency) }))
        .sort((a, b) => EXTERNAL_ORDER.indexOf(a.key) - EXTERNAL_ORDER.indexOf(b.key));
    }
  },
  { id: 'category', label: '归类', delegated: true },
  {
    id: 'worker', label: '执行者',
    bucket(tasks) {
      const groups = new Map();
      for (const t of tasks) {
        const key = t.worker || 'none';
        if (!groups.has(key)) groups.set(key, { key, label: key === 'none' ? '未指定' : workerLabel(key), badge: key === 'none' ? '?' : workerGlyph(key), list: [] });
        groups.get(key).list.push(t);
      }
      return [...groups.values()].map((g) => ({ ...g, list: g.list.sort(byUrgency) })).sort(byGroupUrgency);
    }
  },
  {
    id: 'time', label: '时间',
    bucket(tasks) {
      const at = Date.now();
      return TIME_GROUPS.map(([key, label]) => ({
        key,
        label,
        foldAt: key === 'older' || key === 'month' ? 6 : 0,
        list: tasks.filter((t) => timeBucket(t, at) === key).sort((a, b) => stamp(b) - stamp(a))
      }));
    }
  }
];

export function dimension(id) {
  return DIMENSIONS.find((d) => d.id === id) || DIMENSIONS[0];
}

/** 「只看这一组」：当前分组方式下，这张卡属于哪一组。 */
export function groupKeyOf(by, task) {
  if (by === 'status') return sectionOf(task).id;
  if (by === 'source') return sourceKey(task);
  if (by === 'external') {
    const link = firstLink(task);
    return link ? link.status?.category || 'unknown' : 'none';
  }
  if (by === 'worker') return task.worker || 'none';
  if (by === 'time') return timeBucket(task);
  return null;
}

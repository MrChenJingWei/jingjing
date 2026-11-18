// TAPD 状态 → 静静的通用分类。TAPD 的工作流状态可以按项目自定义（status_1、status_2……），
// 所以按项目的中文状态名推断；推不准的可以在插件设置里用「状态分类」手动指定。

export const CATEGORIES = ['open', 'in_progress', 'blocked', 'review', 'done', 'cancelled', 'unknown'];

// TAPD 系统内置状态 key 的默认分类：拿不到项目状态名时兜底用。
const SYSTEM_KEYS = {
  new: 'open',
  reopened: 'open',
  planning: 'open',
  in_progress: 'in_progress',
  developing: 'in_progress',
  assigned: 'in_progress',
  resolved: 'review',
  verified: 'done',
  closed: 'done',
  done: 'done',
  rejected: 'cancelled',
  suspended: 'blocked'
};

// 按顺序匹配，先命中先算。去掉「A0-」「F3-」这类排序前缀后再匹配。
const RULES = [
  ['unknown', /跳转|中间态/],
  ['cancelled', /拒绝|重复|暂不处理|不处理|作废|无效|不修复|取消|转.*需求|已有需求/],
  ['done', /已上线|&上线|发布线上|已发布|线上验证通过|线上确认|已验收|验收通过|已完成|已同步客户|已验证|^完成$|^done$/i],
  ['blocked', /搁置|挂起|阻塞|暂停|延期|延后|等待/],
  ['open', /重新打开/],
  ['in_progress', /打回/],
  ['review', /已解决|已实现|测试|验证|审核|准备|上线中|合代码|免测|待上线|验收|通过/],
  ['in_progress', /处理中|进行中|实现中|开发|设计中|设计完成|修复|转开发|分析/],
  ['open', /未解决|未开始|待评估|待设计|待处理|待办|新建|^新$|打开|规划/],
  ['done', /关闭/]
];

// 已关闭的单子要看「解决方法」：修好了关的算完成，「以后再修」「不修」之类关的算不做了。
const FIXED_RESOLUTIONS = new Set(['', 'fixed', 'fixed and verified', '已修改', '已修复']);

export function stripPrefix(label) {
  return String(label || '').replace(/^[A-Za-z]\d{1,2}\s*[-－.、]\s*/, '').trim();
}

/** 设置里的「状态分类」：每行「状态名或 key = 分类」，比如「已解决未上线 = review」。 */
export function parseOverrides(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n|[;；]/)) {
    const match = line.match(/^\s*(.+?)\s*[=:：]\s*([a-z_]+)\s*$/);
    if (match && CATEGORIES.includes(match[2])) map.set(match[1], match[2]);
  }
  return map;
}

/**
 * 推断一个状态的分类。key：TAPD 的状态 key；label：项目里的中文名；resolution：缺陷的解决方法。
 */
export function categorize({ key = '', label = '', resolution = '' } = {}, overrides = new Map()) {
  for (const candidate of [key, label, stripPrefix(label)]) {
    if (candidate && overrides.has(candidate)) return overrides.get(candidate);
  }
  const name = stripPrefix(label);
  let category = null;
  if (name) {
    const hit = RULES.find(([, re]) => re.test(name));
    if (hit) category = hit[0];
  }
  category ||= SYSTEM_KEYS[key] || 'unknown';
  if (category === 'done' && /关闭/.test(name || key) && !FIXED_RESOLUTIONS.has(String(resolution || '').trim().toLowerCase())) {
    return 'cancelled';
  }
  if (category === 'done' && key === 'closed' && !name && !FIXED_RESOLUTIONS.has(String(resolution || '').trim().toLowerCase())) {
    return 'cancelled';
  }
  return category;
}

/** 已经结束（不用再建卡）的分类。 */
export const isFinished = (category) => category === 'done' || category === 'cancelled';

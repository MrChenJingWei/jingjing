// TAPD 来源插件：调本机的 tapd-cli（只读：list / count / fields / user info / related-stories / comment list），
// 发现分给你、还没结束的缺陷 / 需求交给静静判断建卡；任务卡上跟踪它在 TAPD 里的状态（syncStatus）；
// 和你有关的新评论（@ 你、在你的单子上、你参与过讨论的单子上）也交给静静，见「评论和 @ 提醒」。
// 状态映射全在这里（status.js），静静核心不认识 TAPD。
//
// 归类（docs/architecture/external.md「插件怎么接」）：只交事实，不挑分类。
// - 需求：node = 需求；parent = 父需求（parent_id），没有就是树根（parent: null）；
// - 缺陷：node = 缺陷；parent = 唯一关联的需求；关联了多个需求时 TAPD 没有「主」的概念，
//   按协议给 parent: null + links，让静静提示主人选一个，绝不自己挑一个凑数。
// 自动归类关着（ctx.classify === 'off'）时不查关联，不多调一次接口。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { categorize, parseOverrides, isFinished } from './status.js';

const ENTITIES = {
  bug: { cmd: 'bug', wrap: 'Bug', label: '缺陷', owner: 'current_owner', title: 'title', view: (ws, id) => `${ws}/bugtrace/bugs/view?bug_id=${id}` },
  story: { cmd: 'story', wrap: 'Story', label: '需求', owner: 'owner', title: 'name', view: (ws, id) => `${ws}/prong/stories/view/${id}` }
};
const LIST_LIMIT = 100;
const SYNC_CHUNK = 50;
const LABEL_TTL_MS = 12 * 60 * 60 * 1000;
const CALL_TIMEOUT_MS = 25 * 1000;
const MAX_ITEMS = 10;
const REMEMBER = 3000;
const TREE_TTL_MS = 12 * 60 * 60 * 1000;
// 一次 poll / sync 里最多查多少个缺陷的关联需求（每个缺陷一次调用），其余用缓存或下次再补。
const MAX_RELATION_CALLS = 20;
const MAX_LINKS = 8;

/* ------------------------------ 调用 tapd-cli ------------------------------ */

function findBin(config) {
  const configured = String(config.bin || '').trim().replace(/^~(?=\/)/, os.homedir());
  if (configured) return configured;
  // 从「应用程序」打开时 PATH 里通常没有这些目录。
  const candidates = [
    path.join(os.homedir(), '.local/bin/tapd-cli'),
    '/opt/homebrew/bin/tapd-cli',
    '/usr/local/bin/tapd-cli',
    path.join(os.homedir(), '.bun/bin/tapd-cli')
  ];
  return candidates.find((file) => fs.existsSync(file)) || 'tapd-cli';
}

function envFor(config, bin) {
  const token = String(config.token || '').trim() || process.env.TAPD_TOKEN || '';
  if (!token) throw new Error('没有 TAPD 个人令牌：在插件设置里填「个人令牌」（或者在启动静静的环境里设 TAPD_TOKEN）');
  return {
    ...process.env,
    PATH: [path.dirname(bin), process.env.PATH || ''].filter(Boolean).join(':'),
    TAPD_API_ENDPOINT: String(config.endpoint || '').trim() || process.env.TAPD_API_ENDPOINT || 'https://api.tapd.cn',
    TAPD_TOKEN: token,
    TAPD_CLI_LOG: 'silent'
  };
}

/** 跑一条 tapd-cli 命令，返回 data。参数都是 key=value，不经过 shell。 */
export function runCli(config, args, { signal } = {}) {
  const bin = findBin(config);
  const env = envFor(config, bin);
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, signal, timeout: CALL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        reject(new Error(`找不到 tapd-cli（${bin}）。在插件设置里填它的完整路径，终端里 which tapd-cli 可以查到`));
        return;
      }
      let json = null;
      try { json = JSON.parse(String(stdout || '').trim()); } catch { /* 下面按出错处理 */ }
      if (!json) {
        const why = String(stderr || stdout || err?.message || '').trim().split('\n').slice(-3).join(' ');
        reject(new Error(`tapd-cli ${args.slice(0, 2).join(' ')} 没有返回 JSON：${why.slice(0, 300) || '无输出'}`));
        return;
      }
      if (json.status !== 1) {
        reject(new Error(`TAPD 返回失败：${String(json.info || json.message || JSON.stringify(json)).slice(0, 300)}`));
        return;
      }
      resolve(json.data);
    });
  });
}

/* --------------------------------- 配置 --------------------------------- */

/*
 * 一个 TAPD 来源里可以配多个项目（config.projects），每个项目一套设置：跟踪哪些、范围、筛选条件、状态分类——
 * 各项目的字段、状态、自定义字段都不一样。令牌、处理人、评论提醒这些是共用的。
 */

function kindsOf(entities) {
  if (entities === 'both') return ['bug', 'story'];
  return [entities === 'story' ? 'story' : 'bug'];
}

/** 老配置（一串项目 ID + 共用的跟踪类型 / 状态分类）转成「每个项目一套设置」。设置页读配置时由静静调用。 */
export function migrateConfig(config) {
  if (Array.isArray(config.projects) && config.projects.length) return config;
  const ids = String(config.workspaceIds || '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return config;
  return {
    ...config,
    projects: ids.map((workspaceId) => ({
      workspaceId,
      name: '',
      entities: ['bug', 'story', 'both'].includes(config.entities) ? config.entities : 'bug',
      scope: config.scope === 'any' && ids.length === 1 ? 'any' : 'mine',
      // 老版本只有一个项目时才可能配过筛选条件。
      filters: ids.length === 1 && Array.isArray(config.filters) ? config.filters : [],
      statusMap: String(config.statusMap || '')
    }))
  };
}

/** 归一化一个项目的设置。index 只用来在报错里说「第几个项目」。 */
function projectOf(raw, index = 0) {
  const ws = String(raw?.workspaceId ?? '').trim();
  const where = `第 ${index + 1} 个项目`;
  if (!ws) throw new Error(`${where}还没填项目 ID`);
  if (!/^\d+$/.test(ws)) throw new Error(`${where}的项目 ID 只能是数字：${ws}`);
  const name = String(raw?.name || '').trim().slice(0, 40);
  return {
    ws,
    name,
    label: name || `项目 ${ws}`,
    kinds: kindsOf(raw?.entities),
    scope: raw?.scope === 'any' ? 'any' : 'mine',
    filters: Array.isArray(raw?.filters) ? raw.filters : [],
    overrides: parseOverrides(raw?.statusMap)
  };
}

function projectsOf(config) {
  const list = migrateConfig(config).projects;
  if (!Array.isArray(list) || !list.length) throw new Error('先在插件设置里加一个项目');
  const projects = list.map(projectOf);
  const seen = new Set();
  for (const project of projects) {
    if (seen.has(project.ws)) throw new Error(`项目 ${project.ws} 配了两次：同一个项目只留一条，条件写在一起`);
    seen.add(project.ws);
  }
  return projects;
}

/** 某个项目的状态分类覆盖；项目已经从配置里删掉时用默认推断。 */
function overridesFor(config, ws) {
  try {
    return projectsOf(config).find((project) => project.ws === String(ws))?.overrides || parseOverrides('');
  } catch {
    return parseOverrides('');
  }
}

function webBase(config) {
  const endpoint = String(config.endpoint || '').trim() || process.env.TAPD_API_ENDPOINT || 'https://api.tapd.cn';
  try {
    const url = new URL(endpoint);
    if (url.hostname === 'api.tapd.cn') return 'https://www.tapd.cn';
    return url.origin;
  } catch {
    return 'https://www.tapd.cn';
  }
}

async function ownerNick(config, ctx) {
  const configured = String(config.owner || '').trim();
  if (configured) return configured;
  const cached = ctx.state?.get('nick');
  if (cached) return cached;
  const info = await runCli(config, ['user', 'info'], ctx);
  const nick = info?.nick || info?.name;
  if (!nick) throw new Error('没拿到令牌对应的 TAPD 用户，填一下「处理人昵称」');
  ctx.state?.set('nick', nick);
  return nick;
}

/** 项目里每个状态 key 的中文名（各项目可以自定义），缓存 12 小时。 */
async function statusLabels(config, ctx, ws, kind) {
  const key = `labels:${kind}:${ws}`;
  const cached = ctx.state?.get(key);
  if (cached && Date.now() - cached.at < LABEL_TTL_MS) return cached.map;
  try {
    const data = await runCli(config, [ENTITIES[kind].cmd, 'fields', `workspaceid=${ws}`], ctx);
    const options = data?.status?.options;
    const map = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    ctx.state?.set(key, { at: Date.now(), map });
    return map;
  } catch (err) {
    ctx.log?.(`读状态名失败（${kind} ${ws}）：${err.message}`);
    return cached?.map || {};
  }
}

/* --------------------------------- 整形 --------------------------------- */

/** TAPD 的时间是北京时间、不带时区。 */
function isoTime(text) {
  if (!text || /^0000/.test(text)) return null;
  const date = new Date(`${String(text).replace(' ', 'T')}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function plainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function statusOf(row, labels, overrides) {
  const key = String(row.status || '');
  const label = labels[key] || key;
  return {
    key,
    label,
    category: categorize({ key, label, resolution: row.resolution }, overrides),
    detail: row.resolution && /关闭|closed/i.test(label + key) ? `解决方法：${row.resolution}` : '',
    updatedAt: isoTime(row.modified)
  };
}

/* --------------------------------- 归类 --------------------------------- */

const classifying = (ctx) => Boolean(ctx?.classify) && ctx.classify !== 'off';

function cachedOr(ctx, key) {
  const hit = ctx.state?.get(key);
  return hit && Date.now() - hit.at < TREE_TTL_MS ? hit : null;
}

/** 缺陷关联的需求 id（TAPD 的 get_related_stories），缓存 12 小时。budget 用完返回 null（这次不说父）。 */
async function relatedStories(config, ctx, ws, bugId, budget) {
  const key = `rel:${ws}:${bugId}`;
  const cached = cachedOr(ctx, key);
  if (cached) return cached.ids;
  if (budget.calls <= 0) return null;
  budget.calls -= 1;
  try {
    const data = await runCli(config, ['bug', 'related-stories', `workspaceid=${ws}`, `bug-id=${bugId}`], ctx);
    const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : data ? [data] : [];
    const ids = [...new Set(list
      .map((entry) => entry?.story_id ?? entry?.StoryBugRelation?.story_id ?? entry?.Story?.id ?? entry?.id)
      .filter((id) => id !== undefined && id !== null && String(id) !== '0')
      .map(String))];
    ctx.state?.set(key, { at: Date.now(), ids });
    return ids;
  } catch (err) {
    ctx.log?.(`查缺陷 ${bugId} 关联的需求失败：${err.message}`);
    return null;
  }
}

/** 需求的标题 / 状态 / 父需求，按项目批量查、缓存 12 小时。 */
async function storyInfo(config, ctx, ws, ids, overrides) {
  const out = new Map();
  const missing = [];
  for (const id of new Set(ids)) {
    const cached = cachedOr(ctx, `story:${ws}:${id}`);
    if (cached) out.set(id, cached.info);
    else missing.push(id);
  }
  if (!missing.length) return out;
  const labels = await statusLabels(config, ctx, ws, 'story');
  for (let i = 0; i < missing.length; i += SYNC_CHUNK) {
    const part = missing.slice(i, i + SYNC_CHUNK);
    try {
      const rows = await runCli(config, ['story', 'list', `workspaceid=${ws}`, `id=${part.join(',')}`, `limit=${SYNC_CHUNK}`, 'fields=id,name,status,parent_id,modified'], ctx);
      for (const wrapped of Array.isArray(rows) ? rows : []) {
        const row = wrapped?.Story || wrapped;
        if (!row?.id) continue;
        const info = { title: String(row.name || '').slice(0, 200), parentId: normalizeParent(row.parent_id), status: statusOf(row, labels, overrides) };
        out.set(String(row.id), info);
        ctx.state?.set(`story:${ws}:${row.id}`, { at: Date.now(), info });
      }
    } catch (err) {
      ctx.log?.(`查需求标题失败（${ws}）：${err.message}`);
    }
  }
  return out;
}

function normalizeParent(value) {
  const id = String(value ?? '').trim();
  return id && id !== '0' ? id : null;
}

function storyRef(config, ws, id, info) {
  return {
    type: 'story',
    id,
    // 标题拿不到也照样建结构（壳节点），静静之后会回填。
    ...(info?.title ? { title: info.title } : {}),
    url: `${webBase(config)}/${ENTITIES.story.view(ws, id)}`,
    ...(info?.status ? { status: { label: info.status.label, category: info.status.category } } : {})
  };
}

/**
 * 给一批条目补上外部对象树（node / parent / links）。rows：externalId → { ws, kind, row }。
 * 查不到（预算用完、接口失败）就不写 parent，表示「这次没说」，静静保留已知的父。
 * 父需求的状态按它所在项目的状态分类来算（各项目的状态不一样）。
 */
async function attachTrees(config, ctx, entries) {
  if (!classifying(ctx) || !entries.length) return;
  const budget = { calls: MAX_RELATION_CALLS };
  // 先确定每个条目直接的父需求 id（缺陷要查关联，需求看 parent_id），再按项目批量拿父需求的标题。
  const plans = [];
  for (const entry of entries) {
    const { ws, kind, row } = entry;
    if (kind === 'story') {
      plans.push({ entry, parents: row.parent_id === undefined ? null : [normalizeParent(row.parent_id)].filter(Boolean) });
    } else {
      plans.push({ entry, parents: await relatedStories(config, ctx, ws, String(row.id), budget) });
    }
  }
  const wanted = new Map();
  for (const { entry, parents } of plans) {
    for (const id of parents || []) {
      if (!wanted.has(entry.ws)) wanted.set(entry.ws, new Set());
      wanted.get(entry.ws).add(id);
    }
  }
  const infos = new Map();
  for (const [ws, ids] of wanted) infos.set(ws, await storyInfo(config, ctx, ws, [...ids], overridesFor(config, ws)));
  for (const { entry, parents } of plans) {
    const { ws, kind, row, target } = entry;
    const entity = ENTITIES[kind];
    target.node = {
      workspace: ws,
      type: kind,
      id: String(row.id),
      title: String(row[entity.title] || '').slice(0, 200) || undefined,
      url: `${webBase(config)}/${entity.view(ws, row.id)}`
    };
    if (parents === null) continue;
    const info = infos.get(ws) || new Map();
    if (parents.length === 1) {
      target.parent = storyRef(config, ws, parents[0], info.get(parents[0]));
    } else {
      // 没有上级（树根），或者关联了多个需求、TAPD 也没有「主」：parent 置空，多的进 links。
      target.parent = null;
      if (parents.length > 1) {
        target.links = parents.slice(0, MAX_LINKS).map((id) => ({ kind: 'related', to: storyRef(config, ws, id, info.get(id)) }));
      }
    }
  }
}

function toItem(config, kind, project, row, status) {
  const { ws } = project;
  const entity = ENTITIES[kind];
  const title = String(row[entity.title] || `${entity.label} ${row.id}`).trim();
  const facts = [
    `TAPD ${entity.label}（${project.scope === 'any' ? '符合这个项目的筛选条件' : '分给你的'}），请查看并处理。`,
    project.name ? `项目：${project.name}` : '',
    `状态：${status.label}`,
    row.priority_label ? `优先级：${row.priority_label}` : '',
    row.severity ? `严重程度：${row.severity}` : '',
    row.iteration_id && row.iteration_id !== '0' ? `迭代 ID：${row.iteration_id}` : '',
    // 只交事实，不写「用某某工具去查」：外部内容不能替静静挑 Worker。
    `项目 ID：${ws}，${entity.label} ID：${row.id}`
  ].filter(Boolean);
  const description = plainText(row.description).slice(0, 1500);
  return {
    externalId: String(row.id),
    externalType: entity.label,
    kind: 'note',
    title: title.slice(0, 120),
    content: [facts.join('\n'), description].filter(Boolean).join('\n\n'),
    url: `${webBase(config)}/${entity.view(ws, row.id)}`,
    occurredAt: isoTime(row.modified),
    status,
    meta: { workspaceId: ws, entity: kind }
  };
}

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ME = new Set(['我', '@me', '$me']);

/**
 * 一个项目里这一类单子（缺陷 / 需求）的查询条件：范围（分给我的）+ 这个项目配的筛选条件，转成 TAPD list 的参数。
 * 筛选条件的字段写成「类型.字段」（bug.status、story.developer），只取这一类的；同一字段多个值用 | 表示「或」；
 * 值写「我」换成处理人昵称。返回 { params, statusFiltered }：选了状态就完全按用户的来，不再自动去掉已结束的。
 * project 是一个项目的设置（{ scope, filters, label }）。
 */
export function queryFor(project, kind, owner) {
  const entity = ENTITIES[kind];
  const params = new Map();
  if ((project.scope || 'mine') !== 'any') params.set(entity.owner, owner);
  for (const row of Array.isArray(project.filters) ? project.filters : []) {
    const [type, key] = String(row?.field || '').split('.');
    if (type !== kind || !FIELD_KEY_RE.test(key || '')) continue;
    const values = (Array.isArray(row.values) ? row.values : [])
      .map((value) => (ME.has(String(value).trim()) ? owner : String(value).trim()))
      .filter((value) => value && !value.includes('|'));
    if (values.length) params.set(key, [...new Set(values)].join('|'));
  }
  if (!params.size) {
    throw new Error(`${project.label ? `「${project.label}」` : ''}范围选了「不限」，${entity.label}至少要加一个筛选条件，不然会把整个项目的${entity.label}都拉进来`);
  }
  return {
    params: [...params].map(([key, value]) => `${key}=${value}`),
    statusFiltered: params.has('status') || params.has('v_status')
  };
}

async function listOpen(config, ctx, project, kind, owner) {
  const { ws, overrides } = project;
  const entity = ENTITIES[kind];
  const fields = ['id', entity.title, 'status', 'modified', 'resolution', 'priority_label', 'iteration_id', 'description', ...(kind === 'bug' ? ['severity'] : ['parent_id'])];
  const query = queryFor(project, kind, owner);
  const [labels, rows] = await Promise.all([
    statusLabels(config, ctx, ws, kind),
    runCli(config, [entity.cmd, 'list', `workspaceid=${ws}`, ...query.params, `limit=${LIST_LIMIT}`, 'order=modified desc', `fields=${fields.join(',')}`], ctx)
  ]);
  return (Array.isArray(rows) ? rows : [])
    .map((wrapped) => wrapped?.[entity.wrap] || wrapped)
    .filter((row) => row?.id)
    .map((row) => ({ row, status: statusOf(row, labels, overrides) }))
    .filter(({ status }) => query.statusFiltered || !isFinished(status.category))
    .map(({ row, status }) => {
      const item = toItem(config, kind, project, row, status);
      // 原始行只留在内存里，补归类关系时用；不交给静静。
      Object.defineProperty(item, '_tapd', { value: { ws, kind, row }, enumerable: false });
      return item;
    });
}

/* ------------------------------ 评论和 @ 提醒 ------------------------------ */
//
// TAPD OpenAPI（tapd-cli）没有消息通知接口，这里用增量拉评论拼出来：
// 每个项目一次 comment list（created > 游标），只留「不是我写的」且和我有关的——
// @ 了我、挂在分给我的单子上、或者是我参与过讨论（评论过）的单子。
// 评论交给静静判断：要处理的（测试打回、提了问题）建卡，只是知会的在对话里汇总一句。

const COMMENT_ENTRIES = {
  stories: { kind: 'story', label: '需求' },
  story: { kind: 'story', label: '需求' },
  bug: { kind: 'bug', label: '缺陷' },
  bug_remark: { kind: 'bug', label: '缺陷' },
  tasks: { kind: 'task', label: '任务' },
  task: { kind: 'task', label: '任务' }
};
const COMMENT_LIMIT = 200;
const COMMENT_OVERLAP_MS = 60 * 1000;
const COMMENT_QUEUE_MAX = 100;
const SEEN_COMMENTS = 1000;
const TALKED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TASK_VIEW = (ws, id) => `${ws}/prong/tasks/view/${id}`;

/** TAPD 用北京时间、不带时区的字符串：YYYY-MM-DD HH:MM:SS。 */
function tapdTime(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 有没有 @ 我：TAPD 界面里的 @ 是 <b class="at-who" data-userid="昵称">；用接口发的评论只有纯文本「@昵称」。 */
export function mentions(html, nick) {
  if (!nick) return false;
  const name = escapeRe(nick);
  return new RegExp(`data-userid="${name}"`).test(html) || new RegExp(`@\\s*${name}(?![\\p{L}\\p{N}])`, 'u').test(plainText(html));
}

/** 单子的标题（不是分给我的单子，评论里只有 id），按项目和类型批量查、缓存 12 小时。 */
async function entryTitles(config, ctx, ws, kind, ids) {
  const out = new Map();
  const entity = ENTITIES[kind];
  if (!entity) return out;
  const missing = [];
  for (const id of new Set(ids)) {
    const cached = cachedOr(ctx, `title:${ws}:${kind}:${id}`);
    if (cached) out.set(id, cached.title);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += SYNC_CHUNK) {
    const part = missing.slice(i, i + SYNC_CHUNK);
    try {
      const rows = await runCli(config, [entity.cmd, 'list', `workspaceid=${ws}`, `id=${part.join(',')}`, `limit=${SYNC_CHUNK}`, `fields=id,${entity.title}`], ctx);
      for (const wrapped of Array.isArray(rows) ? rows : []) {
        const row = wrapped?.[entity.wrap] || wrapped;
        if (!row?.id) continue;
        const title = String(row[entity.title] || '').slice(0, 200);
        out.set(String(row.id), title);
        ctx.state?.set(`title:${ws}:${kind}:${row.id}`, { at: Date.now(), title });
      }
    } catch (err) {
      ctx.log?.(`查单子标题失败（${kind} ${ws}）：${err.message}`);
    }
  }
  return out;
}

function commentItem(config, ws, comment, { title, mention }) {
  const entry = COMMENT_ENTRIES[comment.entry_type];
  const entryId = String(comment.entry_id);
  const name = title || `${entry.label} #${entryId.slice(-7)}`;
  const view = entry.kind === 'task' ? TASK_VIEW : ENTITIES[entry.kind].view;
  const flow = String(comment.title || '').trim();
  const body = plainText(comment.description).slice(0, 1500);
  const facts = [
    mention ? `${comment.author} 在 TAPD ${entry.label}「${name}」里 @ 了你。` : `TAPD ${entry.label}「${name}」有新评论。`,
    `评论人：${comment.author}`,
    flow ? `场景：${flow}` : '',
    // 只交事实：评论是外人写的，不能替静静挑 Worker。
    `项目 ID：${ws}，${entry.label} ID：${entryId}`
  ].filter(Boolean);
  return {
    externalId: `comment:${comment.id}`,
    externalType: '评论',
    kind: 'note',
    eventType: mention ? 'tapd.comment.mention' : 'tapd.comment',
    title: `${comment.author}${mention ? ' @ 了你' : ' 评论了'}：${name}`.slice(0, 120),
    content: [facts.join('\n'), body].filter(Boolean).join('\n\n'),
    url: `${webBase(config)}/${view(ws, entryId)}`,
    occurredAt: isoTime(comment.created),
    // 同一张单子上的多条评论：在排队的卡上合并，不各建一张。
    groupKey: `tapd:${ws}:${entry.kind}:${entryId}`,
    // 评论没有自己的状态可跟踪；单子的状态由单子本身那张卡跟。
    track: false,
    // 归类：评论挂在哪张单子上（父节点之前拉单子时已经交过，这次不说）。
    ...(ENTITIES[entry.kind] ? { node: { workspace: ws, type: entry.kind, id: entryId } } : {}),
    // 评论人：TAPD 里用昵称当身份。
    ...(comment.author ? { actor: { id: comment.author, name: comment.author } } : {}),
    meta: { workspaceId: ws, entity: entry.kind, entryId, commentId: String(comment.id), author: comment.author, mention }
  };
}

/**
 * 拉新评论，和我有关的放进待交队列（state.commentQueue）。第一次只记游标、认一下参与过的单子，不回补历史。
 * mine：这次拉到的、分给我且没结束的单子 id。
 */
async function collectComments(config, ctx, ws, nick, mine) {
  const state = ctx.state;
  const cursorKey = `comments:cursor:${ws}`;
  const talkedKey = `comments:talked:${ws}`;
  const cursor = state?.get(cursorKey);
  const now = Date.now();
  const args = ['comment', 'list', `workspaceid=${ws}`, `limit=${COMMENT_LIMIT}`, '--full'];
  // 往前多看一分钟，同一秒里的评论不会漏；重复的按评论 id 去掉。
  if (cursor) args.push(`created=>${tapdTime(cursor - COMMENT_OVERLAP_MS)}`);
  const rows = await runCli(config, args, ctx);
  const comments = (Array.isArray(rows) ? rows : [])
    .map((wrapped) => wrapped?.Comment || wrapped)
    .filter((c) => c?.id && COMMENT_ENTRIES[c.entry_type])
    .sort((a, b) => String(a.created).localeCompare(String(b.created)));

  const talked = Object.fromEntries(Object.entries(state?.get(talkedKey) || {}).filter(([, at]) => now - at < TALKED_TTL_MS));
  for (const c of comments) {
    if (c.author === nick) talked[String(c.entry_id)] = Date.parse(isoTime(c.created) || '') || now;
  }
  state?.set(talkedKey, talked);
  const latest = comments.length ? Date.parse(isoTime(comments[comments.length - 1].created) || '') : NaN;
  state?.set(cursorKey, Number.isFinite(latest) ? Math.max(latest, cursor || 0) : cursor || now);
  if (!cursor) {
    ctx.log?.(`评论提醒：第一次运行，项目 ${ws} 从现在开始看（认出参与过的单子 ${Object.keys(talked).length} 张）`);
    return 0;
  }

  const seen = new Set(state?.get('comments:seen') || []);
  const relevant = [];
  for (const c of comments) {
    if (seen.has(String(c.id)) || c.author === nick) continue;
    seen.add(String(c.id));
    const entryId = String(c.entry_id);
    const mention = mentions(c.description, nick);
    if (mention || mine.has(entryId) || talked[entryId]) relevant.push({ c, mention });
  }
  state?.set('comments:seen', [...seen].slice(-SEEN_COMMENTS));
  if (!relevant.length) return 0;

  // 单子标题：分给我的这次已经拉到了，其他的按类型批量查一次。
  const titles = new Map([...mine.entries()]);
  for (const kind of ['bug', 'story']) {
    const ids = relevant.map(({ c }) => c).filter((c) => COMMENT_ENTRIES[c.entry_type].kind === kind && !titles.has(String(c.entry_id))).map((c) => String(c.entry_id));
    if (ids.length) for (const [id, title] of await entryTitles(config, ctx, ws, kind, ids)) titles.set(id, title);
  }
  const queue = state?.get('commentQueue') || [];
  for (const { c, mention } of relevant) queue.push(commentItem(config, ws, c, { title: titles.get(String(c.entry_id)), mention }));
  state?.set('commentQueue', queue.slice(-COMMENT_QUEUE_MAX));
  return relevant.length;
}

/* --------------------------------- 入口 --------------------------------- */

const SKIP_FIELDS = new Set(['project_id', 'workspace_id', 'id', 'workitem_type_id', 'secret_workitem']);
const FIELD_ORDER = ['status', 'priority_label', 'severity', 'iteration_id', 'label', 'current_owner', 'owner', 'developer', 'de', 'te', 'fixer', 'reporter', 'creator', 'category_id', 'module'];
const ENUM_TYPES = new Set(['select', 'multi_select', 'radio', 'checkbox']);

function fieldOptions(options) {
  if (Array.isArray(options)) return options.map((o) => (o && typeof o === 'object' ? { value: String(o.value ?? o.id ?? ''), label: String(o.label ?? o.name ?? o.value ?? '') } : { value: String(o), label: String(o) }));
  if (options && typeof options === 'object') return Object.entries(options).map(([value, label]) => ({ value, label: String(label) }));
  return [];
}

/**
 * 设置页「筛选条件」可选的字段：某个项目实际的字段（含自定义字段）和候选值，按缺陷 / 需求分组。
 * 筛选条件在哪个项目卡片里，ctx.item 就是那个项目当前（可能还没保存）的设置；没有时取第一个项目。
 * 只给能直接拿来过滤的：下拉 / 多选（带候选值）和选人字段（填昵称，「我」表示自己）。
 */
export async function filterFields(config, ctx = {}) {
  const project = ctx.item ? projectOf(ctx.item) : projectsOf(config)[0];
  const { ws } = project;
  const out = [];
  for (const kind of project.kinds) {
    const entity = ENTITIES[kind];
    const data = await runCli(config, [entity.cmd, 'fields', `workspaceid=${ws}`], ctx);
    const fields = data && typeof data === 'object' ? data : {};
    const list = [];
    for (const [key, info] of Object.entries(fields)) {
      if (!info || typeof info !== 'object' || !FIELD_KEY_RE.test(key) || SKIP_FIELDS.has(key)) continue;
      // 新旧两个优先级字段都有时只留 priority_label（列表查询用它）。
      if (key === 'priority' && fields.priority_label) continue;
      const type = String(info.html_type || '');
      const label = String(info.label || info.name || key);
      if (type === 'user_chooser') {
        list.push({ key: `${kind}.${key}`, label, group: entity.label, input: 'user', help: '填昵称，多个用逗号分开；写「我」表示你自己' });
      } else if (ENUM_TYPES.has(type)) {
        const options = fieldOptions(info.options).filter((o) => o.value);
        if (options.length) list.push({ key: `${kind}.${key}`, label, group: entity.label, input: 'enum', options });
      }
    }
    const rank = (field) => {
      const index = FIELD_ORDER.indexOf(field.key.split('.')[1]);
      return index < 0 ? FIELD_ORDER.length : index;
    };
    out.push(...list.sort((a, b) => rank(a) - rank(b)));
  }
  return { fields: out };
}

export async function test(config, ctx = {}) {
  try {
    const bin = findBin(config);
    const info = await runCli(config, ['user', 'info'], ctx);
    const projects = projectsOf(config);
    const owner = String(config.owner || '').trim() || info?.nick;
    const lines = [];
    for (const project of projects) {
      const counts = [];
      for (const kind of project.kinds) {
        const entity = ENTITIES[kind];
        const query = queryFor(project, kind, owner);
        const data = await runCli(config, [entity.cmd, 'count', `workspaceid=${project.ws}`, ...query.params], ctx);
        counts.push(`${entity.label} ${data?.count ?? '?'} 条${query.statusFiltered ? '' : '（含已结束的）'}`);
      }
      lines.push(`${project.label}（${project.scope === 'any' ? '按筛选条件' : '分给我的'}）：${counts.join('，')}`);
    }
    return { ok: true, detail: `已连上 TAPD（${bin}），处理人「${owner}」。${lines.join('；')}` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

/** 一个项目这次的基线范围：类型、处理人、范围、条件变了就要重新记基线。 */
function baselineScope(project, owner) {
  return JSON.stringify([project.kinds.join(','), owner, project.scope, project.filters]);
}

/**
 * 老版本把所有项目记在一个基线里（scope 形如「项目1,项目2|类型|处理人[|范围|条件]」）。
 * 这个项目还没有自己的基线、而老基线覆盖了它且条件没变时，沿用老基线：升级后不会无故重记、漏掉中间新分来的单子。
 */
function legacyBaseline(state, project, owner) {
  const legacy = state?.get('baseline');
  if (!legacy?.scope) return null;
  const [ids, kinds, who, ...rest] = String(legacy.scope).split('|');
  if (!ids.split(',').includes(project.ws) || kinds !== project.kinds.join(',') || who !== owner) return null;
  const narrowed = project.scope !== 'mine' || project.filters.length;
  const same = rest.length ? rest.join('|') === `${project.scope}|${JSON.stringify(project.filters)}` : !narrowed;
  return same ? legacy.ids || [] : null;
}

export async function poll(config, ctx = {}) {
  const projects = projectsOf(config);
  const owner = await ownerNick(config, ctx);
  const state = ctx.state;
  const items = [];
  const failures = [];
  for (const project of projects) {
    // 一个项目出错（条件不对、没权限）只影响它自己，别的项目照常拉。
    let found = [];
    try {
      for (const kind of project.kinds) found.push(...await listOpen(config, ctx, project, kind, owner));
    } catch (err) {
      failures.push(`${project.label}：${err.message}`);
      ctx.log?.(`拉取失败（${project.label}）：${err.message}`);
      continue;
    }

    // 评论和 @ 提醒：拉不到只记日志，不影响单子本身。
    if (config.comments !== false) {
      const mine = new Map(found.map((item) => [item.externalId, item.title]));
      try {
        const added = await collectComments(config, ctx, project.ws, owner, mine);
        if (added) ctx.log?.(`${project.label} 有 ${added} 条和你有关的新评论`);
      } catch (err) {
        ctx.log?.(`拉评论失败（${project.label}）：${err.message}`);
      }
    }

    // 只为新出现的单子建卡：每个项目自己的基线。第一次（或改了类型 / 范围 / 条件）先记下已有的，这一轮不交。
    if (config.startFresh !== false) {
      const key = `baseline:${project.ws}`;
      const scope = baselineScope(project, owner);
      let baseline = state?.get(key);
      if (!baseline) {
        const adopted = legacyBaseline(state, project, owner);
        if (adopted) {
          baseline = { scope, at: new Date().toISOString(), ids: adopted };
          state?.set(key, baseline);
        }
      }
      if (!baseline || baseline.scope !== scope) {
        state?.set(key, { scope, at: new Date().toISOString(), ids: found.map((item) => item.externalId).slice(0, REMEMBER) });
        ctx.log?.(`${project.label}：第一次运行（或条件变了），记下已有的 ${found.length} 条，之后只为新出现的建卡`);
        continue;
      }
      const known = new Set(baseline.ids || []);
      found = found.filter((item) => !known.has(item.externalId));
    }
    items.push(...found);
  }
  if (failures.length === projects.length) throw new Error(failures.join('；'));

  // 静静一次最多处理 10 条：评论先交（有时效），剩下的名额给单子；没交完的评论留在队列里下次再交。
  const queue = state?.get('commentQueue') || [];
  const comments = queue.slice(0, MAX_ITEMS);
  state?.set('commentQueue', queue.slice(comments.length));
  // 单子：还没交过的排前面，交过的（静静已经见过，只会顺带更新状态）补在后面。
  const handed = new Set(state?.get('handed') || []);
  const ordered = [...items.filter((item) => !handed.has(item.externalId)), ...items.filter((item) => handed.has(item.externalId))].slice(0, MAX_ITEMS - comments.length);
  for (const item of ordered) handed.add(item.externalId);
  state?.set('handed', [...handed].slice(-REMEMBER));
  await attachTrees(config, ctx, ordered.map((item) => ({ ...item._tapd, target: item })));
  ctx.log?.(`${projects.length} 个项目，符合条件的 ${items.length} 条，这次交 ${ordered.length} 条${comments.length ? `，评论 ${comments.length} 条` : ''}${failures.length ? `；${failures.length} 个项目拉取失败` : ''}`);
  return { items: [...comments, ...ordered] };
}

/** 刷新已经绑在任务卡上的单子的状态：按项目和类型分组，一次查一批 id；状态按各自项目的状态分类来算。 */
export async function syncStatus(config, links, ctx = {}) {
  const groups = new Map();
  for (const link of links) {
    const ws = link.meta?.workspaceId;
    const kind = ENTITIES[link.meta?.entity] ? link.meta.entity : 'bug';
    if (!ws) continue;
    const key = `${ws}|${kind}`;
    if (!groups.has(key)) groups.set(key, { ws, kind, ids: [] });
    groups.get(key).ids.push(String(link.externalId));
  }
  const out = [];
  const trees = [];
  for (const { ws, kind, ids } of groups.values()) {
    const entity = ENTITIES[kind];
    const overrides = overridesFor(config, ws);
    const labels = await statusLabels(config, ctx, ws, kind);
    for (let i = 0; i < ids.length; i += SYNC_CHUNK) {
      const part = ids.slice(i, i + SYNC_CHUNK);
      const fields = `fields=id,${entity.title},status,modified,resolution${kind === 'story' ? ',parent_id' : ''}`;
      const rows = await runCli(config, [entity.cmd, 'list', `workspaceid=${ws}`, `id=${part.join(',')}`, `limit=${SYNC_CHUNK}`, fields], ctx);
      const found = new Map((Array.isArray(rows) ? rows : []).map((wrapped) => wrapped?.[entity.wrap] || wrapped).filter((row) => row?.id).map((row) => [String(row.id), row]));
      for (const id of part) {
        const row = found.get(id);
        const entry = row
          ? { externalId: id, status: statusOf(row, labels, overrides), title: row[entity.title] || undefined }
          : { externalId: id, missing: true };
        if (row) trees.push({ ws, kind, row, target: entry });
        out.push(entry);
      }
    }
  }
  // 同步时顺带交父节点：壳节点回填标题、父指针变了静静会重算归属。
  await attachTrees(config, ctx, trees);
  return out;
}

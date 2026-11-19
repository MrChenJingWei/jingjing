// TAPD 来源插件：调本机的 tapd-cli（只读：list / count / fields / user info / related-stories），
// 发现分给你、还没结束的缺陷 / 需求交给静静判断建卡；任务卡上跟踪它在 TAPD 里的状态（syncStatus）。
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

function workspaceIds(config) {
  const ids = String(config.workspaceIds || '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
  const bad = ids.find((id) => !/^\d+$/.test(id));
  if (bad) throw new Error(`项目 ID 只能是数字：${bad}`);
  if (!ids.length) throw new Error('先在插件设置里填项目 ID');
  return ids;
}

function entityKinds(config) {
  if (config.entities === 'both') return ['bug', 'story'];
  return [config.entities === 'story' ? 'story' : 'bug'];
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
 */
async function attachTrees(config, ctx, entries, overrides) {
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
  for (const [ws, ids] of wanted) infos.set(ws, await storyInfo(config, ctx, ws, [...ids], overrides));
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

function toItem(config, kind, ws, row, status) {
  const entity = ENTITIES[kind];
  const title = String(row[entity.title] || `${entity.label} ${row.id}`).trim();
  const facts = [
    `分给你的 TAPD ${entity.label}，请查看并处理。`,
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

async function listOpen(config, ctx, ws, kind, owner, overrides) {
  const entity = ENTITIES[kind];
  const fields = ['id', entity.title, 'status', 'modified', 'resolution', 'priority_label', 'iteration_id', 'description', ...(kind === 'bug' ? ['severity'] : ['parent_id'])];
  const [labels, rows] = await Promise.all([
    statusLabels(config, ctx, ws, kind),
    runCli(config, [entity.cmd, 'list', `workspaceid=${ws}`, `${entity.owner}=${owner}`, `limit=${LIST_LIMIT}`, 'order=modified desc', `fields=${fields.join(',')}`], ctx)
  ]);
  return (Array.isArray(rows) ? rows : [])
    .map((wrapped) => wrapped?.[entity.wrap] || wrapped)
    .filter((row) => row?.id)
    .map((row) => ({ row, status: statusOf(row, labels, overrides) }))
    .filter(({ status }) => !isFinished(status.category))
    .map(({ row, status }) => {
      const item = toItem(config, kind, ws, row, status);
      // 原始行只留在内存里，补归类关系时用；不交给静静。
      Object.defineProperty(item, '_tapd', { value: { ws, kind, row }, enumerable: false });
      return item;
    });
}

/* --------------------------------- 入口 --------------------------------- */

export async function test(config, ctx = {}) {
  try {
    const bin = findBin(config);
    const info = await runCli(config, ['user', 'info'], ctx);
    const ids = workspaceIds(config);
    const owner = String(config.owner || '').trim() || info?.nick;
    const counts = [];
    for (const ws of ids) {
      for (const kind of entityKinds(config)) {
        const entity = ENTITIES[kind];
        const data = await runCli(config, [entity.cmd, 'count', `workspaceid=${ws}`, `${entity.owner}=${owner}`], ctx);
        counts.push(`${ws} 的${entity.label} ${data?.count ?? '?'} 条`);
      }
    }
    return { ok: true, detail: `已连上 TAPD（${bin}），处理人「${owner}」：${counts.join('，')}（含已结束的）` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

export async function poll(config, ctx = {}) {
  const overrides = parseOverrides(config.statusMap);
  const owner = await ownerNick(config, ctx);
  const items = [];
  for (const ws of workspaceIds(config)) {
    for (const kind of entityKinds(config)) {
      items.push(...await listOpen(config, ctx, ws, kind, owner, overrides));
    }
  }
  const state = ctx.state;
  const scope = `${workspaceIds(config).join(',')}|${entityKinds(config).join(',')}|${owner}`;

  // 第一次启用：记下现在手上已有的单子，之后只为新分来的建卡，免得一启用就建一大堆。
  if (config.startFresh !== false) {
    const baseline = state?.get('baseline');
    if (!baseline || baseline.scope !== scope) {
      state?.set('baseline', { scope, at: new Date().toISOString(), ids: items.map((item) => item.externalId).slice(0, REMEMBER) });
      ctx.log?.(`第一次运行：记下手上已有的 ${items.length} 条，之后只为新分来的建卡`);
      return { items: [] };
    }
    const known = new Set(baseline.ids || []);
    items.splice(0, items.length, ...items.filter((item) => !known.has(item.externalId)));
  }

  // 静静一次最多处理 10 条：还没交过的排前面，交过的（静静已经见过，只会顺带更新状态）补在后面。
  const handed = new Set(state?.get('handed') || []);
  const ordered = [...items.filter((item) => !handed.has(item.externalId)), ...items.filter((item) => handed.has(item.externalId))].slice(0, MAX_ITEMS);
  for (const item of ordered) handed.add(item.externalId);
  state?.set('handed', [...handed].slice(-REMEMBER));
  await attachTrees(config, ctx, ordered.map((item) => ({ ...item._tapd, target: item })), overrides);
  ctx.log?.(`没结束的 ${items.length} 条，这次交 ${ordered.length} 条`);
  return { items: ordered };
}

/** 刷新已经绑在任务卡上的单子的状态：按项目和类型分组，一次查一批 id。 */
export async function syncStatus(config, links, ctx = {}) {
  const overrides = parseOverrides(config.statusMap);
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
  await attachTrees(config, ctx, trees, overrides);
  return out;
}

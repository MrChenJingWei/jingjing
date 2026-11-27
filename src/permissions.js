/**
 * Worker 的权限：能不能改文件、能跑哪些命令。
 *
 * 编码 Agent 在后台运行（Claude Code 的 -p），没有人能在它弹出的权限提示上点「允许」，
 * 所以凡是要提示的操作都会被直接拒绝。权限只能在启动时给：这里算出这一次执行能用的权限，
 * Worker 把它换成自己的参数（Claude Code：--permission-mode / --allowedTools / --add-dir）。
 *
 * 权限从三处来，合起来就是这一次执行的权限：
 * - 工作区：settings.workspaces[i].permission = { level, allow }，拍板时选「以后这个工作区都允许」写入（也可以直接改设置）；
 * - 任务：options.permissions = { level?（主人建任务时指定，可以比工作区低）, grant: { edit, allow, dirs } }，拍板时给的；
 * - 旧的 options.allowEdits（插件草稿任务）：等于可改文件。
 *
 * 从不自动用 bypassPermissions：放开的只是被拦下的那几条命令，或者主人自己选的级别。
 */
import path from 'node:path';

export const LEVELS = ['read', 'edit', 'full'];
export const LEVEL_LABEL = { read: '只读（要改时问你）', edit: '可改文件', full: '改文件和跑命令' };
const RANK = { read: 0, edit: 1, full: 2 };

const MAX_RULES = 40;
const MAX_DIRS = 8;
// 这些命令后面跟的子命令差别很大（git status 和 git push），放开时按「命令 + 子命令」，别一下全放开。
const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'pnpm', 'yarn', 'npx', 'bun', 'docker', 'kubectl', 'cargo', 'go', 'swift', 'gh', 'brew', 'pip', 'pip3', 'uv', 'poetry', 'make', 'xcrun']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function normalizeLevel(value, fallback = 'read') {
  return LEVELS.includes(value) ? value : fallback;
}

function higher(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

/** 一条放开规则：工具名，或「工具(参数)」，比如 Bash(git status:*)、WebFetch(domain:example.com)。 */
function validRule(rule) {
  const value = String(rule || '').trim();
  return /^[A-Za-z_][\w-]*(?:\([^()\n]{1,160}\))?$/.test(value) ? value : '';
}

export function normalizeRules(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(validRule).filter(Boolean))].slice(0, MAX_RULES);
}

function normalizeDirs(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((dir) => String(dir || '').trim()).filter((dir) => path.isAbsolute(dir)))].slice(0, MAX_DIRS);
}

/** 存在工作区上的权限，只保留认识的字段。 */
export function normalizeWorkspacePermission(value) {
  if (!value || typeof value !== 'object') return null;
  const level = normalizeLevel(value.level);
  const allow = normalizeRules(value.allow);
  return level === 'read' && !allow.length ? null : { level, ...(allow.length ? { allow } : {}) };
}

function parseOptions(options) {
  if (!options) return {};
  if (typeof options === 'object') return options;
  try { return JSON.parse(options) || {}; } catch { return {}; }
}

/** 任务在哪个工作区：主目录一样，或者在主目录里面。 */
export function workspaceFor(cwd, settings) {
  const dir = path.resolve(String(cwd || settings?.defaultCwd || '.'));
  const list = settings?.workspaces || [];
  return list.find((ws) => ws.path && path.resolve(ws.path) === dir)
    || list.find((ws) => ws.path && dir.startsWith(path.resolve(ws.path) + path.sep))
    || null;
}

/**
 * 这一次执行的权限：{ level, allow, dirs, workspaceId, source }。
 * level：主人给任务指定了就用它，否则用工作区的；拍板时允许过改文件就至少是 edit。
 */
export function effectivePermissions(task, settings) {
  const options = parseOptions(task?.options);
  const ws = workspaceFor(task?.cwd, settings);
  const fromWorkspace = normalizeWorkspacePermission(ws?.permission) || { level: 'read' };
  const own = options.permissions && typeof options.permissions === 'object' ? options.permissions : {};
  const grant = own.grant && typeof own.grant === 'object' ? own.grant : {};
  let level = LEVELS.includes(own.level) ? own.level : fromWorkspace.level;
  let source = LEVELS.includes(own.level) ? 'task' : ws?.permission ? 'workspace' : 'default';
  if (options.allowEdits) level = higher(level, 'edit');
  if (grant.edit) { level = higher(level, 'edit'); source = source === 'default' ? 'grant' : source; }
  const allow = normalizeRules([...(own.level === 'read' ? [] : fromWorkspace.allow || []), ...(grant.allow || [])]);
  if (allow.length && source === 'default') source = 'grant';
  return { level, allow, dirs: normalizeDirs(grant.dirs), workspaceId: ws?.id || null, source };
}

/* ----------------------------- 被拦下的操作 → 要放开什么 ----------------------------- */

/** 一条命令要放开的规则：git checkout -b x → Bash(git checkout:*)；node a.js → Bash(node:*)。 */
export function ruleForCommand(command) {
  const words = String(command || '').trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const head = path.basename(words[0]);
  if (!/^[\w.+-]+$/.test(head)) return '';
  const sub = words[1];
  if (SUBCOMMAND_TOOLS.has(head) && sub && /^[a-z][\w:-]*$/i.test(sub)) return `Bash(${head} ${sub}:*)`;
  return `Bash(${head}:*)`;
}

/** 一串命令（&& || ; | 连起来的）拆开，各自一条规则。 */
function commandRules(command) {
  return String(command || '')
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim().replace(/^\(+|\)+$/g, ''))
    .filter((part) => part && !/^(?:cd|echo|true|false|export)\b/.test(part))
    .map(ruleForCommand)
    .filter(Boolean);
}

function inside(dir, roots) {
  const target = path.resolve(dir);
  return roots.some((root) => root && (target === path.resolve(root) || target.startsWith(path.resolve(root) + path.sep)));
}

/**
 * 把 Claude Code 报上来的 permission_denials 整理成一份「要放开什么」：
 * { edit, files, commands: [{ command, rules }], rules, dirs, tools }。工作区外的文件要额外放开目录（--add-dir）。
 * 已经放开过的不再算：拿到一模一样的请求说明放开也没用，不能再问一遍绕圈子。
 * granted 可以是 effectivePermissions() 的结果（带 level），也可以直接是记在任务上的 grant（带 edit）。
 */
export function requestFromDenials(denials, { workspace = '', extraDirs = [], granted = null } = {}) {
  const roots = [workspace, ...extraDirs].filter(Boolean);
  const have = new Set(granted?.allow || []);
  const haveDirs = new Set(granted?.dirs || []);
  // 两种形状都认：任务上的 grant 是 { edit }，工作区/生效权限是 { level }。
  const haveEdit = Boolean(granted?.edit) || RANK[granted?.level] >= RANK.edit;
  const haveAnyCommand = granted?.level === 'full';
  const out = { edit: false, files: [], commands: [], rules: [], dirs: [], tools: [] };
  for (const item of Array.isArray(denials) ? denials : []) {
    const tool = String(item?.tool_name || item?.tool || '').trim();
    const input = item?.tool_input && typeof item.tool_input === 'object' ? item.tool_input : {};
    if (!tool) continue;
    const file = input.file_path || input.notebook_path || input.path || '';
    if (file && path.isAbsolute(String(file)) && roots.length && !inside(file, roots)) {
      const dir = path.dirname(String(file));
      if (!haveDirs.has(dir) && !out.dirs.includes(dir)) out.dirs.push(dir);
    }
    if (EDIT_TOOLS.has(tool)) {
      if (!haveEdit) out.edit = true;
      if (file && !out.files.includes(String(file))) out.files.push(String(file));
      continue;
    }
    if (tool === 'Bash') {
      const command = String(input.command || '').trim();
      if (haveAnyCommand) continue;
      const rules = commandRules(command).filter((rule) => !have.has(rule));
      if (!rules.length) continue;
      out.commands.push({ command: command.slice(0, 200), rules });
      for (const rule of rules) if (!out.rules.includes(rule)) out.rules.push(rule);
      continue;
    }
    if (tool === 'WebFetch' && input.url) {
      try {
        const rule = `WebFetch(domain:${new URL(String(input.url)).hostname})`;
        if (!have.has(rule) && !out.rules.includes(rule)) { out.rules.push(rule); out.tools.push(rule); }
      } catch { /* 网址不合法就不放开 */ }
      continue;
    }
    if (['Read', 'Glob', 'Grep', 'LS'].includes(tool)) continue; // 只读工具被拦，只可能是目录不在范围里，上面已经算进 dirs
    const rule = validRule(tool);
    if (rule && !have.has(rule) && !out.rules.includes(rule)) { out.rules.push(rule); out.tools.push(rule); }
  }
  out.rules = out.rules.slice(0, MAX_RULES);
  out.dirs = out.dirs.slice(0, MAX_DIRS);
  return out;
}

export function isEmptyRequest(request) {
  return !request || (!request.edit && !request.rules.length && !request.dirs.length);
}

const shortPath = (file, root) => {
  const rel = root ? path.relative(root, file) : file;
  return rel && !rel.startsWith('..') ? rel : file.replace(/^\/Users\/[^/]+/, '~');
};

/** 给主人看的一行行说明：改哪些文件、跑哪些命令、要用哪些目录。 */
export function describeRequest(request, { workspace = '' } = {}) {
  const lines = [];
  if (request.edit) {
    const files = request.files.slice(0, 6).map((file) => shortPath(file, workspace));
    lines.push(`改文件：${files.join('、') || '工作区里的文件'}${request.files.length > 6 ? ` 等 ${request.files.length} 个` : ''}`);
  }
  for (const item of request.commands.slice(0, 6)) lines.push(`跑命令：${item.command}`);
  if (request.commands.length > 6) lines.push(`还有 ${request.commands.length - 6} 条命令`);
  for (const tool of request.tools.slice(0, 4)) lines.push(`用工具：${tool}`);
  for (const dir of request.dirs) lines.push(`用工作区外的目录：${dir.replace(/^\/Users\/[^/]+/, '~')}`);
  return lines;
}

/** 把这次允许的合进任务已有的授权里。 */
export function mergeGrant(grant = {}, request) {
  return {
    edit: Boolean(grant.edit || request.edit),
    allow: normalizeRules([...(grant.allow || []), ...request.rules]),
    dirs: normalizeDirs([...(grant.dirs || []), ...request.dirs])
  };
}

/** 「以后这个工作区都允许」：改文件提到可改文件，命令规则记到工作区上。目录不记（换了任务未必还要）。 */
export function mergeWorkspacePermission(current, request) {
  const base = normalizeWorkspacePermission(current) || { level: 'read' };
  return normalizeWorkspacePermission({
    level: request.edit ? higher(base.level, 'edit') : base.level,
    allow: [...(base.allow || []), ...request.rules]
  });
}

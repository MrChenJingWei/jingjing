/**
 * 「怎么写插件」：把随 App 发布的插件文档、模板和官方插件源码交给界面看。
 * 读的都是这台机器上这个版本自带的文件，所以文档和用户手上的应用版本一定对得上，离线也能看。
 * 只读固定的几个位置：plugins/README.md、plugins/.template*、官方来源插件目录、内置 Worker 目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { PLUGIN_DIR, USER_PLUGIN_DIR, officialManifests, knownPluginIds } from './plugins.js';

const WORKER_DIR = path.join(ROOT, 'workers');
const GUIDE = path.join(PLUGIN_DIR, 'README.md');
const WORKER_HEADING = /^## Worker 插件\s*$/m;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const SHOW_EXT = new Set(['.js', '.mjs', '.json', '.md']);
const MAX_SHOW_BYTES = 120 * 1024;
const TEMPLATES = {
  source: { dir: '.template', base: 'my-source', name: '我的来源' },
  worker: { dir: '.template-worker', base: 'my-worker', name: '我的 Agent' }
};

const kindOf = (value) => (value === 'worker' ? 'worker' : 'source');
const notFound = (message) => Object.assign(new Error(message), { statusCode: 404 });

/** 写法说明：README.md 里「## Worker 插件」之前是来源插件，之后是 Worker 插件。 */
export function guide(kind) {
  if (!fs.existsSync(GUIDE)) throw notFound('这个版本没有带插件文档');
  const text = fs.readFileSync(GUIDE, 'utf8');
  const match = text.match(WORKER_HEADING);
  const cut = match ? match.index : text.length;
  const markdown = kindOf(kind) === 'worker'
    ? `# 写一个 Worker 插件\n\n${text.slice(cut).replace(WORKER_HEADING, '').trim()}`
    : text.slice(0, cut).trim();
  return { kind: kindOf(kind), markdown, examples: examples(kind) };
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 可以拿来照着写的例子：来源插件看官方来源插件，Worker 插件看内置 Worker（同一套接口）。 */
export function examples(kind) {
  if (kindOf(kind) === 'worker') {
    if (!fs.existsSync(WORKER_DIR)) return [];
    return fs.readdirSync(WORKER_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
      .map((entry) => ({ id: entry.name, manifest: readManifest(path.join(WORKER_DIR, entry.name)) }))
      .filter((item) => item.manifest)
      .map(({ id, manifest }) => ({ id, name: manifest.name || id, description: manifest.description || '' }));
  }
  return officialManifests()
    .filter((manifest) => manifest.kind !== 'worker')
    .map((manifest) => ({ id: manifest.id, name: manifest.name, description: manifest.description || '' }));
}

function listFiles(dir, prefix = '', depth = 0) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'BUILD.json') continue;
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (depth < 2) out.push(...listFiles(full, rel, depth + 1));
      continue;
    }
    if (!SHOW_EXT.has(path.extname(entry.name))) continue;
    const size = fs.statSync(full).size;
    out.push({ name: rel, size, content: size <= MAX_SHOW_BYTES ? fs.readFileSync(full, 'utf8') : null });
  }
  // plugin.json 和入口放前面，README 其次。
  const rank = (name) => (name === 'plugin.json' ? 0 : name === 'index.js' ? 1 : name.toLowerCase() === 'readme.md' ? 2 : 3);
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** 某个例子的源码（只读）。太大的文件（比如打包好的产物）只列名字不给内容。 */
export function exampleFiles(kind, id) {
  if (!ID_RE.test(String(id || ''))) throw notFound('没有这个例子');
  if (!examples(kind).some((item) => item.id === id)) throw notFound('没有这个例子');
  const dir = path.join(kindOf(kind) === 'worker' ? WORKER_DIR : PLUGIN_DIR, id);
  if (!fs.existsSync(path.join(dir, 'plugin.json'))) throw notFound('没有这个例子');
  return { id, files: listFiles(dir) };
}

/**
 * 把模板复制成「我的」插件：<数据目录>/plugins/<my-source…>，改好 id 和名字，附一份怎么改的说明。
 * 复制出来默认停用，改完点「重新加载」就能看到。返回 { id, dir }。
 */
export function createFromTemplate(kind) {
  const template = TEMPLATES[kindOf(kind)];
  const from = path.join(PLUGIN_DIR, template.dir);
  if (!fs.existsSync(path.join(from, 'plugin.json'))) throw notFound('这个版本没有带插件模板');
  const taken = knownPluginIds();
  let id = template.base;
  for (let i = 2; taken.has(id) || fs.existsSync(path.join(USER_PLUGIN_DIR, id)); i += 1) id = `${template.base}-${i}`;
  const dir = path.join(USER_PLUGIN_DIR, id);
  fs.mkdirSync(USER_PLUGIN_DIR, { recursive: true });
  fs.cpSync(from, dir, { recursive: true });
  const manifestPath = path.join(dir, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.id = id;
  manifest.name = id === template.base ? template.name : `${template.name} ${id.slice(template.base.length + 1)}`;
  // 模板里的 $schema 是相对官方目录写的，挪到数据目录就指不到了。
  delete manifest.$schema;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), [
    `# ${manifest.name}`,
    '',
    `这是从静静的${kindOf(kind) === 'worker' ? ' Worker ' : '来源'}插件模板复制出来的，可以随便改：`,
    '',
    '1. 改 `plugin.json` 里的 `name`、`description`、`config`（`id` 必须和目录名一致）；',
    '2. 改 `index.js`；',
    `3. 回到静静的「设置 → 任务来源」点「重新加载」（Worker 插件也一起重新加载），再到「${kindOf(kind) === 'worker' ? '设置 → Worker' : '设置 → 任务来源'}」里填配置、点「测试」。`,
    '',
    `完整写法在静静里点「怎么写插件」就能看到。不要了直接删掉这个目录。`,
    ''
  ].join('\n'));
  return { id, dir };
}

/** 「我的」插件目录（只认数据目录下已经存在的），给「在 Finder 中打开」用。 */
export function userPluginDir(id) {
  if (!ID_RE.test(String(id || ''))) throw notFound('没有这个插件目录');
  const dir = path.join(USER_PLUGIN_DIR, id);
  if (!fs.existsSync(dir)) throw notFound('没有这个插件目录');
  return dir;
}

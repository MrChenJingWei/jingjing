// 一个工作区可以挂多个文件夹：主目录（任务在这里执行）+ 附加文件夹（Claude Code 用 --add-dir 放开，其他 Worker 在指令里知道）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-wsdirs-'));
process.env.JINGJING_DATA_DIR = dataDir;
const { normalizeWorkspaces } = await import('../src/config.js');
const { extraDirsFor } = await import('../src/workers.js');
const claude = await import('../workers/claude/index.js');

test.after(() => removeTemp(dataDir));

test('normalizeWorkspaces：保留附加文件夹，去重、去掉和主目录相同的', () => {
  const settings = normalizeWorkspaces({ workspaces: [{ id: 'w', name: '前后端', path: '/a/web', extraPaths: ['/a/api', '/a/api', '/a/web', '', '/a/docs'] }] });
  assert.deepEqual(settings.workspaces[0].extraPaths, ['/a/api', '/a/docs']);
  const plain = normalizeWorkspaces({ workspaces: [{ id: 'p', name: '单个', path: '/b' }] });
  assert.equal(plain.workspaces[0].extraPaths, undefined, '没挂额外文件夹就不写这个字段');
});

test('extraDirsFor：按任务主目录找到工作区，返回它的附加文件夹', () => {
  const settings = { workspaces: [{ id: 'w', name: 'x', path: '/a/web', extraPaths: ['/a/api'] }] };
  // 返回的是解析过的绝对路径（Windows 上会带盘符）。
  assert.deepEqual(extraDirsFor('/a/web', settings), [path.resolve('/a/api')]);
  assert.deepEqual(extraDirsFor('/a/web/', settings), [path.resolve('/a/api')], '尾部斜杠不影响匹配');
  assert.deepEqual(extraDirsFor('/somewhere/else', settings), []);
});

test('Claude Code Worker：附加文件夹用 --add-dir 传进去', async () => {
  let seen = null;
  const ctx = {
    which: () => '/bin/claude',
    settings: { claude: { enabled: true } },
    workspace: '/a/web',
    extraDirs: ['/a/api', '/a/docs'],
    options: {},
    emit: async () => {},
    checkpoint: async () => ({}),
    exec: async (bin, args) => { seen = args; return { code: 0, stdout: '', stderr: '' }; },
    parseApproval: () => null,
    estimateTokens: () => 0
  };
  await claude.execute({ id: 't', prompt: '看看接口', title: 't' }, ctx).catch(() => {});
  assert.ok(seen, '应该调用了 claude');
  const pairs = seen.map((arg, i) => (arg === '--add-dir' ? seen[i + 1] : null)).filter(Boolean);
  assert.deepEqual(pairs, ['/a/api', '/a/docs']);
});

test('保存工作区时没带 permission 就沿用原来的，别顺手把拍板放开的权限抹掉', async () => {
  const { saveSettings, getSettings } = await import('../src/db.js');
  const permission = { level: 'edit', allow: ['Bash(npm test:*)'] };
  saveSettings({ workspaces: [{ id: 'w', name: '主', path: '/a/web', extraPaths: ['/a/api'], permission }] });
  // 设置页保存时只回传这几个字段（权限在界面上还没有可编辑的地方）。
  saveSettings({ workspaces: [{ id: 'w', name: '改了名', path: '/a/web', extraPaths: ['/a/api'] }] });
  const kept = getSettings().workspaces.find((item) => item.id === 'w');
  assert.equal(kept.name, '改了名');
  assert.deepEqual(kept.permission, permission);
  // 换了文件夹就当作新的工作区：权限跟着目录走，不继承。
  saveSettings({ workspaces: [{ id: 'w', name: '改了名', path: '/a/other' }] });
  assert.equal(getSettings().workspaces.find((item) => item.id === 'w').permission, undefined);
  // 显式传 null 才是清掉。
  saveSettings({ workspaces: [{ id: 'w', name: '改了名', path: '/a/other', permission: permission }] });
  saveSettings({ workspaces: [{ id: 'w', name: '改了名', path: '/a/other', permission: null }] });
  assert.equal(getSettings().workspaces.find((item) => item.id === 'w').permission, undefined);
});

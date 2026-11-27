// Worker 权限：工作区/任务/拍板放开怎么合成这一次执行的权限，以及被拦下的操作要怎么问主人。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkspacePermission,
  normalizeRules,
  effectivePermissions,
  ruleForCommand,
  requestFromDenials,
  isEmptyRequest,
  describeRequest,
  mergeGrant,
  mergeWorkspacePermission
} from '../src/permissions.js';

const settings = {
  defaultCwd: '/work/main',
  workspaces: [
    { id: 'w1', name: '主', path: '/work/main' },
    { id: 'w2', name: '只读放开', path: '/work/ro', permission: { level: 'read', allow: ['Bash(npm test:*)'] } },
    { id: 'w3', name: '可改', path: '/work/edit', permission: { level: 'edit' } }
  ]
};

test('normalizeWorkspacePermission：只认认识的级别和规则，什么都不放就返回 null', () => {
  assert.equal(normalizeWorkspacePermission(null), null);
  assert.equal(normalizeWorkspacePermission({ level: 'read' }), null);
  assert.deepEqual(normalizeWorkspacePermission({ level: 'edit' }), { level: 'edit' });
  // 认不出的级别退回只读；认不出的规则直接丢掉。
  assert.deepEqual(normalizeWorkspacePermission({ level: 'weird', allow: ['Bash(ls:*)', 'not a rule ('] }), { level: 'read', allow: ['Bash(ls:*)'] });
  assert.equal(normalizeRules(['Bash(ls:*)', 'Bash(ls:*)']).length, 1);
  assert.equal(normalizeRules(Array.from({ length: 50 }, (_, i) => `Tool${i}`)).length, 40);
});

test('effectivePermissions：工作区按主目录（含子目录）匹配，任务可以压低，拍板放开能抬高', () => {
  assert.deepEqual(effectivePermissions({ cwd: '/work/main' }, settings), { level: 'read', allow: [], dirs: [], workspaceId: 'w1', source: 'default' });

  const ro = effectivePermissions({ cwd: '/work/ro' }, settings);
  assert.equal(ro.level, 'read');
  assert.deepEqual(ro.allow, ['Bash(npm test:*)']);
  assert.equal(ro.workspaceId, 'w2');
  assert.equal(ro.source, 'workspace');

  const sub = effectivePermissions({ cwd: '/work/edit/src' }, settings);
  assert.equal(sub.level, 'edit');
  assert.equal(sub.workspaceId, 'w3');

  // 任务显式只读：工作区上的命令规则也一起不放。
  const lowered = effectivePermissions({ cwd: '/work/edit', options: { permissions: { level: 'read' } } }, settings);
  assert.equal(lowered.level, 'read');
  assert.equal(lowered.source, 'task');
  assert.deepEqual(lowered.allow, []);

  // 旧的 allowEdits 等于可改文件；任务上的 grant 记着拍板放开的内容。
  assert.equal(effectivePermissions({ cwd: '/work/main', options: { allowEdits: true } }, settings).level, 'edit');
  const granted = effectivePermissions({
    cwd: '/work/main',
    options: { permissions: { grant: { edit: true, allow: ['Bash(git status:*)'], dirs: ['/work/other'] } } }
  }, settings);
  assert.equal(granted.level, 'edit');
  assert.deepEqual(granted.allow, ['Bash(git status:*)']);
  assert.deepEqual(granted.dirs, ['/work/other']);
  assert.equal(granted.source, 'grant');

  // 不在任何工作区里：只读，没有工作区。
  assert.equal(effectivePermissions({ cwd: '/elsewhere' }, settings).workspaceId, null);
});

test('ruleForCommand：带子命令的工具按「命令 + 子命令」放开，其他按命令放开', () => {
  assert.equal(ruleForCommand('git checkout -b feature'), 'Bash(git checkout:*)');
  assert.equal(ruleForCommand('NODE_ENV=test npm test'), 'Bash(npm test:*)');
  assert.equal(ruleForCommand('node build.js'), 'Bash(node:*)');
  assert.equal(ruleForCommand(''), '');
  assert.equal(ruleForCommand('docker compose up -d'), 'Bash(docker compose:*)');
});

test('requestFromDenials：改文件、命令、工作区外目录分别整理，已经放开过的不再算', () => {
  const denials = [
    { tool_name: 'Write', tool_input: { file_path: '/work/main/out.md', content: 'x'.repeat(1000) } },
    { tool_name: 'Bash', tool_input: { command: 'cd /work/main && npm test -- --watch' } },
    { tool_name: 'Read', tool_input: { file_path: '/work/other/notes.md' } }
  ];
  const request = requestFromDenials(denials, { workspace: '/work/main' });
  assert.equal(request.edit, true);
  assert.deepEqual(request.files, ['/work/main/out.md']);
  assert.deepEqual(request.commands, [{ command: 'cd /work/main && npm test -- --watch', rules: ['Bash(npm test:*)'] }]);
  assert.deepEqual(request.rules, ['Bash(npm test:*)']);
  assert.deepEqual(request.dirs, ['/work/other']);

  // 同一批请求再跑一遍、把上次放开的当 granted：不该再问第二次。
  const grant = mergeGrant({}, request);
  assert.equal(isEmptyRequest(requestFromDenials(denials, { workspace: '/work/main', granted: grant })), true);
  // 直接传 effectivePermissions 那种形状（带 level）也认。
  assert.equal(isEmptyRequest(requestFromDenials(denials, {
    workspace: '/work/main',
    granted: { level: 'edit', allow: ['Bash(npm test:*)'], dirs: ['/work/other'] }
  })), true);
});

test('requestFromDenials：full 级别下命令不再拦，WebFetch 按域名放开', () => {
  const bash = [{ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }];
  assert.equal(isEmptyRequest(requestFromDenials(bash, { workspace: '/work/main', granted: { level: 'full' } })), true);

  const fetchRequest = requestFromDenials([
    { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/docs?a=1' } }
  ], { workspace: '/work/main' });
  assert.deepEqual(fetchRequest.rules, ['WebFetch(domain:example.com)']);
  assert.deepEqual(fetchRequest.tools, ['WebFetch(domain:example.com)']);
});

test('mergeGrant / mergeWorkspacePermission：任务上攒规则，工作区只记改文件和命令', () => {
  const request = { edit: true, files: [], commands: [], rules: ['Bash(npm test:*)'], dirs: ['/work/other'], tools: [] };
  assert.deepEqual(mergeGrant({ allow: ['Bash(ls:*)'] }, request), {
    edit: true,
    allow: ['Bash(ls:*)', 'Bash(npm test:*)'],
    dirs: ['/work/other']
  });
  // 目录不记到工作区上（换个任务未必还要）。
  assert.deepEqual(mergeWorkspacePermission({ level: 'read', allow: ['Bash(ls:*)'] }, request), {
    level: 'edit',
    allow: ['Bash(ls:*)', 'Bash(npm test:*)']
  });
  assert.equal(mergeWorkspacePermission(undefined, { edit: false, rules: [], dirs: ['/work/other'] }), null);
  assert.deepEqual(mergeWorkspacePermission({ level: 'read' }, { edit: false, rules: ['Bash(git status:*)'], dirs: [] }), {
    level: 'read',
    allow: ['Bash(git status:*)']
  });
});

test('describeRequest：给主人看的说明用相对路径，工作区外的目录标出来', () => {
  const lines = describeRequest({
    edit: true,
    files: ['/work/main/src/a.js'],
    commands: [{ command: 'npm test', rules: ['Bash(npm test:*)'] }],
    rules: ['Bash(npm test:*)'],
    dirs: ['/work/other'],
    tools: []
  }, { workspace: '/work/main' });
  assert.deepEqual(lines, ['改文件：src/a.js', '跑命令：npm test', '用工作区外的目录：/work/other']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectNeed, pickWorker, namedWorker, toolSignal, handoffWorker } from '../src/worker-routing.js';

const codeAbilities = ['code', 'write-file', 'manage-files', 'text'];
const builtins = [
  { id: 'llm', label: '问答', abilities: ['text'], cost: 1, source: 'builtin', available: true },
  { id: 'file', label: '文件生成', abilities: ['write-file'], cost: 1, source: 'builtin', available: true },
  { id: 'shell', label: '文件操作', abilities: ['manage-files'], cost: 1, source: 'builtin', available: true },
  { id: 'claude', label: 'Claude Code', abilities: codeAbilities, cost: 4, keywords: 'claude', source: 'builtin', available: true },
  { id: 'codex', label: 'Codex', abilities: codeAbilities, cost: 4, keywords: 'codex', source: 'builtin', available: false },
  { id: 'dsh', label: 'DeepSeek Harness', abilities: codeAbilities, cost: 4, source: 'builtin', available: false }
];

const pick = (text, extra = {}) => pickWorker({ text, workers: builtins, ...extra }).worker;

test('离线启发式：按能力挑最便宜的 Worker，和改造前的派活结果一致', () => {
  assert.equal(pick('帮我写一份本周工作总结'), 'llm');
  assert.equal(pick('帮我生成一个 notes.md 文件'), 'file');
  assert.equal(pick('帮我整理下载文件夹'), 'shell');
  assert.equal(pick('帮我修复登录页的 bug'), 'claude');
});

test('模型已选 Worker 时只用强信号纠偏', () => {
  // 模型选了 llm，但文本明确要写文件 / 操作仓库：改派给具备能力的 Worker。
  assert.equal(pick('把结果保存成 report.md', { requested: 'llm', decided: true }), 'file');
  assert.equal(pick('把改动提交并推送到 github', { requested: 'llm', decided: true }), 'claude');
  assert.equal(pick('整理仓库里的分支', { requested: 'shell', decided: true }), 'claude');
  // 弱信号（「测试」）不推翻模型的判断。
  assert.equal(pick('帮我想一个测试用例的思路', { requested: 'llm', decided: true }), 'llm');
  // 模型选的 Worker 本身具备能力时保持不动。
  assert.equal(pick('写一个 README.md 文件', { requested: 'claude', decided: true }), 'claude');
});

test('插件声明的关键词优先，点名不可用的 Worker 时说明改派', () => {
  const plugin = { id: 'lark', label: '飞书文档', abilities: ['write-file'], cost: 3, keywords: '飞书|lark', source: 'plugin', available: true };
  const workers = [...builtins, plugin];
  assert.equal(pickWorker({ text: '把周报写到飞书文档里', workers }).worker, 'lark');
  // 只有能力匹配时，同能力下内置且更便宜的 file 胜出。
  assert.equal(pickWorker({ text: '生成一个 a.md 文件', workers }).worker, 'file');

  const result = pickWorker({ text: '用 codex 跑一下单元测试', workers: builtins });
  assert.equal(result.worker, 'claude');
  assert.match(result.note, /Codex.*改派给「Claude Code」/);
});

test('请求的 Worker 不可用或缺失时有兜底', () => {
  const r = pickWorker({ text: '修一下这个函数', requested: 'codex', workers: builtins });
  assert.equal(r.worker, 'claude');
  assert.match(r.note, /本机没有可用的「Codex」/);

  const textOnly = builtins.map((w) => ({ ...w, available: w.id === 'llm' }));
  const fallback = pickWorker({ text: '修复登录页的 bug', workers: textOnly });
  assert.equal(fallback.worker, 'llm');
  assert.match(fallback.note, /没有具备「code」能力/);

  assert.equal(pickWorker({ text: '', workers: builtins }).worker, 'llm');
  assert.equal(pickWorker({ text: '随便', workers: [] }).worker, null);
});

test('detectNeed：写文件优先，弱信号只在离线判断时生效', () => {
  assert.equal(detectNeed('生成一个 data.json 文件'), 'write-file');
  assert.equal(detectNeed('推送到 github'), 'code');
  assert.equal(detectNeed('清理下载目录'), 'manage-files');
  assert.equal(detectNeed('清理下载目录', { decided: true }), null);
  assert.equal(detectNeed('跑一下编译'), 'code');
  assert.equal(detectNeed('跑一下编译', { decided: true }), null);
  assert.equal(detectNeed('写一首诗'), null);
});

test('一句话里点名了哪个可用的 Worker', () => {
  assert.equal(namedWorker('使用claude通过tapd mcp查了回他', builtins)?.id, 'claude');
  assert.equal(namedWorker('用 Claude Code 去查', builtins)?.id, 'claude');
  assert.equal(namedWorker('用 codex 跑一下', builtins), null, '点名的 Worker 本机不可用');
  assert.equal(namedWorker('先放着，下午再说', builtins), null);
  assert.equal(namedWorker('', builtins), null);
});

test('toolSignal：写了要用 MCP / 命令行工具才算，单词里带这几个字母的不算', () => {
  assert.deepEqual(toolSignal('使用tapd-mcp,或者tapd-cli查看进度'), { need: 'code', term: 'mcp' });
  assert.deepEqual(toolSignal('用 tapd-cli 查一下'), { need: 'code', term: 'cli' });
  assert.deepEqual(toolSignal('在命令行里跑一下'), { need: 'code', term: '命令行' });
  assert.equal(toolSignal('client 那边说进度正常'), null);
  assert.equal(toolSignal('蓝马的4.5需求做的怎么样了'), null);
  assert.equal(toolSignal(''), null);
});

test('handoffWorker：拍板选项是「改用 / 交给 X」才算换人，「我去 X 里查」不算', () => {
  assert.equal(handoffWorker('改用 Claude Code 在工作区调 tapd 工具查', builtins)?.id, 'claude');
  assert.equal(handoffWorker('改用「Claude Code」去查', builtins)?.id, 'claude');
  assert.equal(handoffWorker('交给 claude 处理', builtins)?.id, 'claude');
  assert.equal(handoffWorker('我去 Claude Code 查完贴给你', builtins), null);
  assert.equal(handoffWorker('我去TAPD查了贴给你', builtins), null);
  assert.equal(handoffWorker('改用 codex 跑一下', builtins), null, '点名的 Worker 本机不可用');
  assert.equal(handoffWorker('改成先发草稿', builtins), null, '没点名 Worker');
});

test('兜底 Worker：主人指定的优先；指定的不可用或没指定时用最便宜的文本 Worker；能力和点名照旧优先', () => {
  assert.equal(pick('帮我写一份本周工作总结', { fallback: 'claude' }), 'claude', '舍得花钱的可以让 Claude Code 兜底');
  assert.equal(pick('帮我写一份本周工作总结', { fallback: 'codex' }), 'llm', 'codex 本机不可用，回到自动');
  assert.equal(pick('帮我写一份本周工作总结', { fallback: 'nope' }), 'llm');
  assert.equal(pick('帮我写一份本周工作总结'), 'llm');
  assert.equal(pick('帮我生成一个 notes.md 文件', { fallback: 'llm' }), 'file', '需要的能力照旧优先');
});

test('口语别名「deepseek」只认主人自己的对话，外部来源不认', () => {
  const workers = [
    { id: 'llm', label: '问答', abilities: ['text'], cost: 1, source: 'builtin', available: true },
    { id: 'dsh', label: 'DeepSeek Harness', abilities: codeAbilities, cost: 4, keywords: 'deepseek harness|\\bdsh\\b', source: 'builtin', available: true }
  ];

  // 主人在聊天 / 拍板里说 deepseek：就是让 DeepSeek Harness 去做。
  assert.equal(namedWorker('改用 deepseek 去做这个任务', workers, { aliases: true })?.id, 'dsh');
  assert.equal(pickWorker({ text: '改用 deepseek 去做这个任务', workers, aliases: true }).worker, 'dsh');
  assert.equal(pickWorker({ text: '用 deepseek 把登录页的 bug 修了', workers, aliases: true, requested: 'llm', decided: true }).worker, 'dsh',
    '模型选了问答，但主人点名了 deepseek，照样改派');

  // 外部来源（discovery）不传 aliases：只有完整写「deepseek harness / dsh」才算点名。
  assert.equal(namedWorker('改用 deepseek 去做这个任务', workers), null);
  assert.equal(namedWorker('改用 DeepSeek Harness 去做这个任务', workers)?.id, 'dsh');
  assert.equal(pickWorker({ text: '改用 deepseek 去做这个任务', workers }).worker, 'llm', '外部不加别名，回到最便宜的文本 Worker');

  // 模型名 deepseek-chat 不算换 Worker。
  assert.equal(namedWorker('切到 deepseek-chat 模型再试', workers, { aliases: true }), null);
  // Worker 给的拍板选项维持原样：只认 manifest 的关键词。
  assert.equal(handoffWorker('改用 deepseek 去做', workers), null);
});

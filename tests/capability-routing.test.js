// 能力目录与 Worker 选择顺序：别名点名 > 模型 > 能力 > 兜底；本机能力覆盖 manifest。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-capability-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { capabilityCatalog, candidatesForCapabilities, matchCapabilities } = await import('../src/capabilities.js');
const { pickWorker, namedWorker } = await import('../src/worker-routing.js');
const workers = await import('../src/workers.js');
const { saveWorkerConfig } = workers;

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

await workers.loadBuiltinWorkers();

const catalog = capabilityCatalog();
const claude = {
  id: 'claude', label: 'Claude Code', available: true, cost: 4, source: 'builtin',
  abilities: ['code'], aliases: ['claude', 'claude code'], capabilities: ['shell', 'git']
};
const codex = {
  id: 'codex', label: 'Codex', available: true, cost: 4, source: 'builtin',
  abilities: ['code'], aliases: ['codex'], capabilities: ['shell', 'git']
};
const llm = {
  id: 'llm', label: '问答', available: true, cost: 1, source: 'builtin',
  abilities: ['text'], aliases: ['问答'], capabilities: []
};

test('能力目录：内置能力从数据文件读取，能按词命中', () => {
  assert.ok(catalog.length >= 10);
  assert.ok(catalog.some((item) => item.id === 'tapd-cli' && item.hostTool));
  assert.deepEqual(matchCapabilities('用 tapd 查一下分给我的缺陷', catalog), ['tapd-cli']);
  assert.deepEqual(matchCapabilities('帮我跑一下 npm install', catalog), ['npm']);
  assert.deepEqual(matchCapabilities('今天天气不错', catalog), []);
});

test('自定义能力：和内置目录合并，同 id 不覆盖内置', () => {
  const custom = capabilityCatalog({
    capabilities: [
      { id: 'figma', label: 'Figma', keywords: ['figma', '设计稿'] },
      { id: 'git', label: '假的 Git', keywords: ['git'] }
    ]
  });
  assert.ok(custom.some((item) => item.id === 'figma' && item.custom));
  assert.equal(custom.find((item) => item.id === 'git').label, 'Git');
});

test('能力候选：显式声明优先；hostTool 没有声明时回退到能跑命令的 Worker', () => {
  const explicit = candidatesForCapabilities(['tapd-cli'], [
    { ...claude, capabilities: ['shell', 'tapd-cli'] },
    codex
  ], catalog);
  assert.deepEqual(explicit.workers.map((w) => w.id), ['claude']);
  assert.equal(explicit.fallback, false);

  const fallback = candidatesForCapabilities(['tapd-cli'], [claude, codex, llm], catalog);
  assert.deepEqual(fallback.workers.map((w) => w.id).sort(), ['claude', 'codex']);
  assert.equal(fallback.fallback, true);

  const none = candidatesForCapabilities(['tapd-cli'], [llm], catalog);
  assert.deepEqual(none.workers, []);
});

test('选择顺序：点名 > 模型 > 能力 > 兜底', () => {
  const named = pickWorker({
    text: '用 claude 查一下缺陷',
    requested: 'codex',
    decided: true,
    workers: [claude, codex, llm]
  });
  assert.equal(named.worker, 'claude');
  assert.equal(named.reason, 'keywords');

  // 模型选的 Worker 不符合文本点到的能力时，能力候选优先。
  const capability = pickWorker({
    text: '用 tapd 查一下缺陷',
    requested: 'llm',
    decided: true,
    workers: [
      { ...claude, capabilities: ['shell', 'tapd-cli'] },
      codex,
      llm
    ],
    capabilityIds: ['tapd-cli'],
    capabilityCatalog: catalog
  });
  assert.equal(capability.worker, 'claude');
  assert.equal(capability.reason, 'capability');

  // 多个候选时，模型的选择如果在候选里就采纳。
  const multi = pickWorker({
    text: '用 tapd 查一下缺陷',
    requested: 'codex',
    decided: true,
    workers: [claude, codex, llm],
    capabilityIds: ['tapd-cli'],
    capabilityCatalog: catalog
  });
  assert.equal(multi.worker, 'codex');
  assert.equal(multi.reason, 'model');

  // 没有模型选择时走能力回退，并在说明里讲清楚为什么。
  const auto = pickWorker({
    text: '用 tapd 查一下缺陷',
    workers: [claude, codex, llm],
    capabilityIds: ['tapd-cli'],
    capabilityCatalog: catalog
  });
  assert.equal(auto.reason, 'capability');
  assert.match(auto.note, /能执行本机命令/);

  // 没有点名/能力/硬需求时按旧规则兜底。
  const fallback = pickWorker({ text: '随便聊聊', workers: [claude, codex, llm] });
  assert.equal(fallback.worker, 'llm');
});

test('点名：别名大小写/标点不影响，英文别名有边界', () => {
  const workersList = [claude, codex, llm];
  assert.equal(namedWorker('让 ＣＬＡＵＤＥ 改一下', workersList)?.id, 'claude');
  assert.equal(namedWorker('切到 deepseek-chat 模型', workersList), null);
});

test('本机覆盖：给 Worker 加别名和能力，读回来合并 manifest 默认值', () => {
  saveWorkerConfig('claude', { routing: { aliases: ['cc', '克劳德'], capabilities: ['shell', 'git', 'tapd-cli'] } });
  const saved = workers.availability().claude;
  assert.deepEqual(saved.aliases, ['claude', 'claude code', 'claude-cli', 'cc', '克劳德']);
  assert.deepEqual(saved.capabilities, ['shell', 'git', 'tapd-cli']);
  assert.ok(saved.capabilityLabels.includes('TAPD 命令行'));

  // 去掉一个能力：manifest 里有、本机不要了，也要能删。
  saveWorkerConfig('claude', { routing: { aliases: ['claude'], capabilities: ['shell', 'git'] } });
  const trimmed = workers.availability().claude;
  assert.deepEqual(trimmed.capabilities, ['shell', 'git']);

  // 不认识的 id 被丢掉，不会写进配置。
  saveWorkerConfig('claude', { routing: { aliases: ['claude'], capabilities: ['shell', '不存在的能力'] } });
  assert.deepEqual(workers.availability().claude.capabilities, ['shell']);
});

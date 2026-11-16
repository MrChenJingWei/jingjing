// Claude Code Worker：stream-json 解析、进度回传、会话断点与续跑。用假的 ctx.exec，不会调用真实的 claude。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineParser, describeEvent, describeTool } from '../workers/claude/stream.js';
import { execute } from '../workers/claude/index.js';
import { extractApproval, estimateTokens } from '../src/worker-runtime.js';

const line = (event) => `${JSON.stringify(event)}\n`;
const init = (id) => line({ type: 'system', subtype: 'init', session_id: id });
const toolUse = (name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const result = (text, extra = {}) => line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'sess-final', total_cost_usd: 0.12, ...extra });

function fakeCtx({ outputs, sessionId = null, recovery = null }) {
  const calls = [];
  const emitted = [];
  const checkpoints = [];
  const ctx = {
    which: () => '/fake/claude',
    settings: { claude: { enabled: true } },
    workspace: '/tmp',
    sessionId,
    recovery,
    resume: null,
    emit: async (text) => { emitted.push(text); },
    checkpoint: async (data) => { checkpoints.push(data); return data; },
    exec: async (bin, args, { onOutput }) => {
      const output = outputs[calls.length] || { chunks: [], code: 0 };
      calls.push(args);
      // 故意把一行拆成两段，验证跨块拼接。
      for (const chunk of output.chunks) {
        const mid = Math.floor(chunk.length / 2);
        onOutput(chunk.slice(0, mid));
        onOutput(chunk.slice(mid));
      }
      return { code: output.code ?? 0, stdout: output.chunks.join(''), stderr: output.stderr || '' };
    },
    parseApproval: extractApproval,
    estimateTokens
  };
  return { ctx, calls, emitted, checkpoints };
}

test('按行解析 stream-json，忽略非 JSON 行', () => {
  const events = [];
  const parser = createLineParser((event) => events.push(event));
  parser.push('{"type":"sys');
  parser.push('tem"}\nnot json\n{"type":"res');
  parser.push('ult"}');
  parser.flush();
  assert.deepEqual(events.map((e) => e.type), ['system', 'result']);
});

test('把事件写成人能看懂的进度', () => {
  assert.equal(describeTool('Read', { file_path: '/a/b/app.js' }), '读取 app.js');
  assert.equal(describeTool('Bash', { command: 'npm test' }), '运行 npm test');
  assert.equal(describeTool('Grep', { pattern: 'TODO' }), '搜索「TODO」');
  assert.equal(describeTool('Mystery', {}), '使用 Mystery');
  assert.equal(describeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '我先看看项目结构' }] } }), '我先看看项目结构');
  assert.equal(describeEvent({ type: 'user', message: {} }), null);
});

test('新会话：预先指定 session id 并存为断点，实时回传进度，返回结果和费用', async () => {
  const { ctx, calls, emitted, checkpoints } = fakeCtx({
    outputs: [{ chunks: [init('sess-new'), toolUse('Read', { file_path: '/x/app.js' }), toolUse('Bash', { command: 'npm test' }), result('改好了')] }]
  });
  const out = await execute({ prompt: '修 bug' }, ctx);
  const args = calls[0];
  assert.deepEqual(args.slice(0, 5), ['-p', '修 bug', '--output-format', 'stream-json', '--verbose']);
  const preset = args[args.indexOf('--session-id') + 1];
  assert.match(preset, /^[0-9a-f-]{36}$/);
  assert.equal(checkpoints[0].sessionId, preset, '启动前就存了断点');
  assert.ok(checkpoints.some((c) => c.sessionId === 'sess-new'), 'init 报告的会话 id 也会存下');
  assert.ok(emitted.includes('读取 app.js'));
  assert.ok(emitted.includes('运行 npm test'));
  assert.equal(out.status, 'done');
  assert.equal(out.summary, '改好了');
  assert.equal(out.sessionId, 'sess-final');
  assert.equal(out.cost, 0.12);
});

test('服务重启后续跑：用断点里的会话 --resume；会话不存在时换新会话重跑', async () => {
  const resumed = fakeCtx({ sessionId: 'sess-old', recovery: { checkpoint: { sessionId: 'sess-old' } }, outputs: [{ chunks: [result('继续做完了')] }] });
  const out = await execute({ prompt: '修 bug' }, resumed.ctx);
  assert.ok(resumed.calls[0].includes('--resume'));
  assert.equal(resumed.calls[0][resumed.calls[0].indexOf('--resume') + 1], 'sess-old');
  assert.ok(!resumed.calls[0].includes('--session-id'));
  assert.match(resumed.calls[0][1], /服务重启打断了你上一次的执行/);
  assert.equal(out.status, 'done');

  const missing = fakeCtx({
    sessionId: 'sess-gone',
    recovery: { checkpoint: { sessionId: 'sess-gone' } },
    outputs: [{ chunks: [], code: 1, stderr: 'No conversation found with session ID: sess-gone' }, { chunks: [result('从头做完了')] }]
  });
  const fresh = await execute({ prompt: '修 bug' }, missing.ctx);
  assert.equal(missing.calls.length, 2);
  assert.ok(missing.calls[1].includes('--session-id'));
  assert.equal(missing.calls[1][1], '修 bug', '换新会话时用原始指令');
  assert.equal(fresh.status, 'done');
  assert.equal(fresh.summary, '从头做完了');
});

test('结果里的审批标记、错误结果和没有结果的情况', async () => {
  const asking = fakeCtx({ outputs: [{ chunks: [result('要覆盖吗\n[[APPROVAL]] {"question":"要覆盖 a.js 吗？","options":["覆盖","跳过"]}')] }] });
  const approval = await execute({ prompt: 'x' }, asking.ctx);
  assert.equal(approval.status, 'needs_approval');
  assert.equal(approval.approval.question, '要覆盖 a.js 吗？');

  const errored = fakeCtx({ outputs: [{ chunks: [result('额度不够', { subtype: 'error_max_turns', is_error: true })] }] });
  assert.equal((await execute({ prompt: 'x' }, errored.ctx)).status, 'failed');

  const crashed = fakeCtx({ outputs: [{ chunks: [], code: 2, stderr: 'boom' }] });
  const failed = await execute({ prompt: 'x' }, crashed.ctx);
  assert.equal(failed.status, 'failed');
  assert.match(failed.summary, /没有返回结果.*退出码 2[\s\S]*boom/);
});

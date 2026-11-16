// 服务正常退出：中止执行、结束子进程（包括子进程再派生的进程）、任务保持 running 等重启恢复，且不算崩溃次数。
// shutdown() 之后整个调度器不再派活，所以单独一个文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-shutdown-'));
process.env.JINGJING_DATA_DIR = dataDir;

const { validateManifest } = await import('../src/plugin-spec.js');
const workers = await import('../src/workers.js');
const scheduler = await import('../src/scheduler.js');
const lifecycle = await import('../src/lifecycle.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

async function waitFor(fn, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}`);
}

test('退出时结束整组子进程，任务留给下次启动按断点恢复，不计入崩溃次数', async () => {
  const pidFile = path.join(dataDir, 'pids.json');
  // 子进程再派生一个孙进程（像 Claude Code 的 Bash 工具那样），两个都挂着不退出。
  const script = `
    const { spawn } = require('node:child_process');
    const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grand: grand.pid }));
    setInterval(() => {}, 1000);
  `;
  const manifest = validateManifest({ id: 'long-agent', kind: 'worker', name: 'long-agent', entry: 'index.js', worker: { recovery: 'resume' } });
  workers.registerWorkerPlugin({
    manifest,
    dir: path.join(dataDir, 'long-agent'),
    isolate: false,
    module: {
      execute: async (task, ctx) => {
        await ctx.checkpoint({ sessionId: 's-long' });
        const result = await ctx.exec(process.execPath, ['-e', script]);
        return result.error === 'aborted' ? { status: 'cancelled', summary: '停了' } : { status: 'done', summary: 'ok' };
      }
    }
  });

  const task = scheduler.createTask({ title: '长任务', prompt: 'x', worker: 'long-agent' });
  const pids = await waitFor(() => fs.existsSync(pidFile) && JSON.parse(fs.readFileSync(pidFile, 'utf8')), '子进程启动');
  assert.ok(alive(pids.child) && alive(pids.grand));

  await scheduler.shutdown({ graceMs: 1500 });
  await waitFor(() => !alive(pids.child) && !alive(pids.grand), '子进程和孙进程都被结束', 3000);

  const interrupted = scheduler.getTask(task.id);
  assert.equal(interrupted.status, 'running', '任务留给下次启动处理');
  const [run] = scheduler.taskRuns(task.id);
  assert.equal(run.status, 'interrupted');
  assert.match(run.error, /服务退出时中断/);

  // 下次启动：按 Worker 声明的 resume 带着断点重新入队，正常退出不算「连续被打断」。
  scheduler.recover();
  const recovered = scheduler.getTask(task.id);
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.recoveries, 0);
  assert.equal(recovered.resume_payload.recovered.checkpoint.sessionId, 's-long');
  assert.equal(lifecycle.getRun(run.id).status, 'interrupted');
});

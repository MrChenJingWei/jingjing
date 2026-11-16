/**
 * 第三方 Worker 插件的执行线程。
 *
 * 插件的 execute(task, ctx) 在这里运行，和主线程隔离：同步死循环、内存泄漏只影响这个线程，
 * 取消或超时时主线程会直接 terminate()。需要主线程才能做的事（存断点、调模型）通过消息转发。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runCommand, sleep, extractApproval, estimateTokens, which } from './worker-runtime.js';

const { entry, task, data } = workerData;
const controller = new AbortController();
const signal = controller.signal;
const pending = new Map();
let seq = 0;

parentPort.on('message', (msg) => {
  if (msg?.type === 'abort') {
    controller.abort(msg.reason || 'cancelled');
  } else if (msg?.type === 'rpc-result') {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error));
    else waiter.resolve(msg.result);
  }
});

function rpc(method, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'rpc', id, method, args });
  });
}

const ctx = {
  ...data.plain,
  signal,
  emit: async (message, meta = {}) => parentPort.postMessage({ type: 'emit', message: String(message), meta }),
  log: (message) => parentPort.postMessage({ type: 'log', message: String(message) }),
  checkpoint: (value) => rpc('checkpoint', [value]),
  llm: {
    mode: data.llmMode,
    chat: (options = {}) => {
      const { signal: _ignored, ...rest } = options;
      return rpc('llm.chat', [rest]);
    },
    demoOutput: () => data.demoOutput
  },
  exec: (cmd, args, options = {}) => runCommand(cmd, args, {
    ...options,
    env: { ...data.runEnv, ...(options.env || {}) },
    signal: options.signal || signal
  }),
  which,
  sleep: (ms) => sleep(ms, signal),
  parseApproval: extractApproval,
  estimateTokens
};

try {
  const module = await import(entry);
  if (typeof module.execute !== 'function') throw new Error('Worker 插件没有导出 execute()');
  const result = await module.execute(task, ctx);
  // 结果必须能跨线程传递：函数、类实例之类的会被丢掉。
  parentPort.postMessage({ type: 'result', result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
} catch (err) {
  parentPort.postMessage({
    type: 'error',
    error: err?.message || String(err),
    aborted: signal.aborted || err?.message === 'aborted' || err?.name === 'AbortError'
  });
}

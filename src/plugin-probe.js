/**
 * 检查插件草稿用的隔离线程：加载入口、列出导出的函数，Worker 试跑 detect()，来源插件试跑 test()。
 * 主线程给它 10 秒，超时直接结束线程（入口里有死循环也卡不住静静）。
 */
import { parentPort, workerData } from 'node:worker_threads';

const { entry, manifest, config, runTest } = workerData;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超过 ${ms / 1000} 秒没有返回`)), ms).unref?.())
  ]);
}

const stubState = { get: (key, fallback = null) => fallback, set: (key, value) => value, delete: () => {} };

try {
  const module = await import(entry);
  const out = { exports: Object.keys(module).filter((key) => typeof module[key] === 'function').sort(), detect: null, test: null };
  if (manifest.kind === 'worker' && typeof module.detect === 'function') {
    try {
      const result = module.detect(config, { settings: {}, which: () => null, llm: { mode: 'demo' } });
      out.detect = result && typeof result.then === 'function' ? { error: 'detect() 必须是同步函数' } : result ?? true;
    } catch (err) {
      out.detect = { error: err.message };
    }
  }
  if (manifest.kind !== 'worker' && runTest && typeof module.test === 'function') {
    const controller = new AbortController();
    try {
      out.test = await withTimeout(Promise.resolve(module.test(config, {
        settings: {}, now: new Date(), since: null, signal: controller.signal, log: () => {}, state: stubState
      })), 8000, 'test()');
    } catch (err) {
      out.test = { ok: false, detail: err.message };
    } finally {
      controller.abort();
    }
  }
  parentPort.postMessage({ ok: true, ...JSON.parse(JSON.stringify(out)) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message || String(err) });
}

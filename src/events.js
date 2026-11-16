/** 极简事件总线：SSE 客户端 + 内部订阅 */

// 浏览器对同一个站点的并发连接有限（HTTP/1.1 一般是 6 条），实时连接太多会把 POST 请求挤住。
// 这个限制是按浏览器算的，所以按「同一个浏览器」（IP + UA）只保留最近的几条；
// 不同设备、桌面 App 和手机各算各的，互不挤占。全局上限只防异常情况。
export const MAX_STREAMS_PER_CLIENT = 3;
export const MAX_STREAMS = 32;

class Bus {
  constructor() {
    this.clients = new Map(); // res -> client key
    this.listeners = new Set();
  }

  /** 关掉最早的一条连接；client 不为空时只在这个浏览器的连接里挑。被关掉的页面会按 retry 重连。 */
  dropOldest(client = null) {
    for (const [res, key] of this.clients) {
      if (client !== null && key !== client) continue;
      try { res.end(); } catch { /* ignore */ }
      this.clients.delete(res);
      return true;
    }
    return false;
  }

  subscribe(res, { client = '' } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const key = String(client);
    while ([...this.clients.values()].filter((value) => value === key).length >= MAX_STREAMS_PER_CLIENT) {
      if (!this.dropOldest(key)) break;
    }
    while (this.clients.size >= MAX_STREAMS) {
      if (!this.dropOldest()) break;
    }
    this.clients.set(res, key);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 20000);
    const cleanup = () => {
      clearInterval(ping);
      this.clients.delete(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return cleanup;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, payload = {}) {
    const packet = { type, payload, at: new Date().toISOString() };
    const frame = `event: ${type}\ndata: ${JSON.stringify(packet)}\n\n`;
    for (const res of this.clients.keys()) {
      try { res.write(frame); } catch { this.clients.delete(res); }
    }
    for (const fn of this.listeners) {
      try { fn(packet); } catch (err) { console.error('[bus]', err.message); }
    }
    return packet;
  }

  get size() {
    return this.clients.size;
  }
}

export const bus = new Bus();

/** 极简事件总线：SSE 客户端 + 内部订阅 */
class Bus {
  constructor() {
    this.clients = new Set();
    this.listeners = new Set();
  }

  subscribe(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    // 浏览器同域并发连接有限，实时连接太多会把 POST 请求挤住。
    // 只保留最近的几条；被关掉的页面会按 retry 重连。
    while (this.clients.size >= 4) {
      const oldest = this.clients.values().next().value;
      try { oldest.end(); } catch { /* ignore */ }
      this.clients.delete(oldest);
    }
    this.clients.add(res);
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
    for (const res of this.clients) {
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

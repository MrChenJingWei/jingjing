/**
 * 任务来源插件模板。
 * 规范见 plugins/README.md 和 plugins/plugin.schema.json。
 */

export async function test(config) {
  if (!config.endpoint) return { ok: false, detail: '还没有填数据地址' };
  const res = await fetch(config.endpoint, { signal: AbortSignal.timeout(8000) });
  return { ok: res.ok, detail: `HTTP ${res.status}` };
}

export async function poll(config, ctx) {
  if (!config.endpoint) throw new Error('还没有填数据地址');
  const res = await fetch(config.endpoint, { signal: ctx.signal });
  if (!res.ok) throw new Error(`拉取失败：HTTP ${res.status}`);
  const text = await res.text();

  // TODO: 把 text 解析成条目；externalId 必须稳定且唯一。
  const items = [];

  return { items: items.slice(0, Number(config.limit) || 10) };
}

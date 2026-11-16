import { loadCalendar } from './ics.js';

const splitKeywords = (value) => String(value || '')
  .split(/[,，]/)
  .map((s) => s.trim())
  .filter(Boolean);

function localDateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shortHash(text) {
  let h = 5381;
  for (const ch of String(text)) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

function timeText(iso, allDay) {
  if (allDay) return '全天';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function eventLine(event) {
  const start = new Date(event.start);
  const end = event.end ? new Date(event.end) : null;
  const allDay = start.getHours() === 0 && start.getMinutes() === 0;
  const when = end
    ? `${timeText(event.start, allDay)}–${timeText(event.end, allDay && end.getHours() === 0)}`
    : timeText(event.start, allDay);
  const extra = [event.location ? `地点：${event.location}` : '', event.description ? `说明：${event.description.slice(0, 300)}` : '']
    .filter(Boolean)
    .join('；');
  return `- ${when} ${event.title}${extra ? `（${extra}）` : ''}`;
}

function filterEvents(events, keywords) {
  if (!keywords.length) return events;
  return events.filter((event) => {
    const text = `${event.title}\n${event.description}\n${event.location}`;
    return keywords.some((k) => text.includes(k));
  });
}

export async function test(config) {
  if (!config.icsUrl) return { ok: false, detail: '还没有填 ICS 地址' };
  const { events, upcoming } = await loadCalendar({
    icsUrl: config.icsUrl,
    hoursAhead: Number(config.hoursAhead) || 24
  });
  const preview = upcoming.slice(0, 3).map(eventLine);
  return {
    ok: true,
    detail: `读到 ${events.length} 个日程，接下来 ${Number(config.hoursAhead) || 24} 小时有 ${upcoming.length} 个`,
    preview
  };
}

export async function poll(config, ctx) {
  if (!config.icsUrl) throw new Error('还没有配置 ICS 地址');
  const hoursAhead = Math.min(168, Math.max(1, Number(config.hoursAhead) || 24));
  const { events, upcoming, cached } = await loadCalendar({ icsUrl: config.icsUrl, hoursAhead, state: ctx.state, log: ctx.log || (() => {}) });
  if (cached) ctx.log?.('日历没有变化，使用本地缓存');
  const keywords = splitKeywords(config.keywords);
  const list = filterEvents(upcoming, keywords);

  if (!list.length) {
    ctx.log(`接下来 ${hoursAhead} 小时没有符合条件的日程`);
    return { items: [] };
  }

  const dateKey = localDateKey(ctx.now);
  const signature = list.map((e) => `${e.start}|${e.title}`).join(';');
  const content = [
    `接下来 ${hoursAhead} 小时的日程：`,
    '',
    ...list.map(eventLine),
    '',
    '请帮我把这些安排过一遍：指出时间冲突或准备不足的地方，并给每件事 1–2 个具体的准备动作。'
  ].join('\n');

  return {
    items: [
      {
        externalId: `agenda:${dateKey}:${shortHash(signature)}`,
        kind: 'agenda',
        eventType: 'calendar.upcoming',
        title: `准备接下来的日程（${list.length} 件）`,
        content,
        meta: { date: dateKey, count: list.length },
        occurredAt: new Date(ctx.now).toISOString()
      }
    ]
  };
}

/** 极简 ICS 解析器：够用、可读、无依赖。 */

const MONTH = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
};

const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function unescapeText(value) {
  return String(value ?? '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function tzOffset(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, Number(parts.hour) % 24, +parts.minute, +parts.second);
  return asUTC - ms;
}

function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    let ts = guess - tzOffset(guess, tz);
    ts = guess - tzOffset(ts, tz);
    return new Date(ts);
  } catch {
    return new Date(y, mo - 1, d, h, mi, s);
  }
}

export function parseIcsDate(value, params = {}) {
  const v = String(value || '').trim();
  if (!v) return null;
  const dateOnly = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly || params.VALUE === 'DATE') {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0);
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (params.TZID) return zonedToUtc(+y, +mo, +d, +h, +mi, +s, params.TZID);
  return new Date(+y, +mo - 1, +d, +h, +mi, +s);
}

function parseProperty(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const pieces = left.split(';');
  const name = pieces.shift().toUpperCase();
  const params = {};
  for (const piece of pieces) {
    const eq = piece.indexOf('=');
    if (eq > 0) params[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

function parseRrule(value) {
  const out = {};
  for (const part of String(value || '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k.toUpperCase()] = v;
  }
  return out;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function expandRecurring(event, horizonEnd) {
  const rule = event.rrule;
  if (!rule) return [event];
  const freq = String(rule.FREQ || '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return [event];
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const until = rule.UNTIL ? parseIcsDate(rule.UNTIL) : null;
  const byDay = rule.BYDAY ? String(rule.BYDAY).split(',').map((d) => WEEKDAY[d.slice(-2).toUpperCase()]).filter((n) => n !== undefined) : [];

  const out = [];
  const limit = new Date(Math.min(horizonEnd.getTime(), until?.getTime() ?? Infinity));

  if (freq === 'WEEKLY' && byDay.length) {
    let cursor = new Date(event.start);
    let guard = 0;
    while (cursor <= limit && out.length < count && guard < 400) {
      const diffDays = Math.floor((cursor - event.start) / 86400000);
      const weekIndex = Math.floor(diffDays / 7);
      if (weekIndex % interval === 0 && byDay.includes(cursor.getDay())) {
        out.push({ ...event, start: new Date(cursor), end: event.end ? new Date(event.end.getTime() + (cursor - event.start)) : null });
      }
      cursor = addDays(cursor, 1);
      guard += 1;
    }
    return out;
  }

  for (let i = 0; i < 400; i++) {
    if (out.length >= count) break;
    const current = freq === 'DAILY'
      ? addDays(event.start, i * interval)
      : freq === 'WEEKLY'
        ? addDays(event.start, i * 7 * interval)
        : addMonths(event.start, i * interval);
    if (current > limit) break;
    const duration = event.end ? event.end - event.start : 0;
    out.push({ ...event, start: new Date(current), end: event.end ? new Date(current.getTime() + duration) : null });
  }
  return out;
}

/**
 * 解析 ICS 文本，返回单个事件（RRULE 会展开到 horizonEnd）。
 * 只支持最常见的字段：SUMMARY/DTSTART/DTEND/LOCATION/DESCRIPTION/RRULE/UID。
 */
export function parseIcs(text, { horizonEnd = addDays(new Date(), 14) } = {}) {
  if (!text) return [];
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    if (current.start) {
      for (const event of expandRecurring(current, horizonEnd)) events.push(event);
    }
    current = null;
  };

  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) { current = { rrule: null }; continue; }
    if (/^END:VEVENT$/i.test(line)) { flush(); continue; }
    if (!current) continue;
    const prop = parseProperty(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID': current.uid = prop.value.trim(); break;
      case 'SUMMARY': current.title = unescapeText(prop.value).trim(); break;
      case 'DESCRIPTION': current.description = unescapeText(prop.value).trim(); break;
      case 'LOCATION': current.location = unescapeText(prop.value).trim(); break;
      case 'DTSTART': current.start = parseIcsDate(prop.value, prop.params); current.startParams = prop.params; break;
      case 'DTEND': current.end = parseIcsDate(prop.value, prop.params); break;
      case 'RRULE': current.rrule = parseRrule(prop.value); break;
      case 'STATUS': current.status = prop.value.trim().toUpperCase(); break;
      default: break;
    }
  }
  flush();

  return events
    .filter((e) => e.start && e.status !== 'CANCELLED')
    .map((e, index) => ({
      uid: e.uid || `event-${index}-${e.start.toISOString()}`,
      title: e.title || '(无标题日程)',
      description: e.description || '',
      location: e.location || '',
      start: e.start.toISOString(),
      end: e.end ? e.end.toISOString() : null
    }));
}

export function upcomingEvents(events, { hoursAhead = 24, now = new Date(), limit = 20 } = {}) {
  const from = now.getTime() - 2 * 3600 * 1000;
  const to = now.getTime() + hoursAhead * 3600 * 1000;
  return events
    .filter((e) => {
      const t = new Date(e.start).getTime();
      return t >= from && t <= to;
    })
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, limit);
}

export async function fetchIcs(url, { etag = '', lastModified = '' } = {}) {
  const headers = { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  if (res.status === 304) {
    return {
      notModified: true,
      text: '',
      etag: res.headers.get('etag') || etag,
      lastModified: res.headers.get('last-modified') || lastModified
    };
  }
  if (!res.ok) throw new Error(`下载 ICS 失败：HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 5 * 1024 * 1024) throw new Error('ICS 文件过大（>5MB）');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('这个地址返回的不是 ICS 日历');
  return {
    notModified: false,
    text,
    etag: res.headers.get('etag') || '',
    lastModified: res.headers.get('last-modified') || ''
  };
}

export async function loadCalendar({ icsUrl, hoursAhead = 24, state = null, log = () => {} }) {
  const cachedText = state?.get('icsText', '') || '';
  const etag = state?.get('etag', '') || '';
  const lastModified = state?.get('lastModified', '') || '';
  let fetched;
  try {
    fetched = await fetchIcs(icsUrl, { etag, lastModified });
  } catch (err) {
    if (!cachedText) throw err;
    log(`日历刷新失败，使用本地缓存：${err.message}`);
    fetched = { notModified: true, text: '', etag, lastModified };
  }

  let text = fetched.text;
  if (fetched.notModified) {
    if (!cachedText) throw new Error('日历返回未变化，但本地没有缓存；请稍后重试');
    text = cachedText;
  } else if (state) {
    state.set('icsText', text);
    state.set('etag', fetched.etag);
    state.set('lastModified', fetched.lastModified);
  }

  const events = parseIcs(text, { horizonEnd: addDays(new Date(), Math.max(14, hoursAhead / 24 + 7)) });
  return { events, upcoming: upcomingEvents(events, { hoursAhead }), cached: fetched.notModified };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, parseIcsDate, upcomingEvents, loadCalendar } from '../plugins/calendar/ics.js';

const single = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:evt-1',
  'SUMMARY:产品评审',
  'DTSTART;TZID=Asia/Shanghai:20261113T100000',
  'DTEND;TZID=Asia/Shanghai:20261113T110000',
  'LOCATION:会议室 A',
  'DESCRIPTION:带上上一版原型',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

const recurring = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:daily-1',
  'SUMMARY:晨会',
  'DTSTART:20261113T093000',
  'DTEND:20261113T094500',
  'RRULE:FREQ=DAILY;COUNT=5',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly-1',
  'SUMMARY:周报',
  'DTSTART:20261113T170000',
  'DTEND:20261113T173000',
  'RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=3',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

test('解析单个事件，保留时区与字段', () => {
  const events = parseIcs(single);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, '产品评审');
  assert.equal(events[0].location, '会议室 A');
  assert.equal(events[0].description, '带上上一版原型');
  assert.equal(new Date(events[0].start).toISOString(), '2026-11-13T02:00:00.000Z');
});

test('展开每日与每周重复事件', () => {
  const events = parseIcs(recurring, { horizonEnd: new Date('2026-12-31T00:00:00Z') });
  assert.equal(events.length, 8);
  const daily = events.filter((e) => e.uid === 'daily-1');
  const weekly = events.filter((e) => e.uid === 'weekly-1');
  assert.equal(daily.length, 5);
  assert.equal(weekly.length, 3);
  assert.ok(daily.every((e, i) => i === 0 || new Date(e.start) > new Date(daily[i - 1].start)));
});

test('时区转换：TZID 与 UTC', () => {
  assert.equal(parseIcsDate('20261113T100000', { TZID: 'Asia/Shanghai' }).toISOString(), '2026-11-13T02:00:00.000Z');
  assert.equal(parseIcsDate('20261113T100000Z').toISOString(), '2026-11-13T10:00:00.000Z');
  assert.equal(parseIcsDate('20261113', { VALUE: 'DATE' }).getHours(), 0);
});

test('只返回时间窗口内的事件', () => {
  const events = parseIcs(single);
  const now = new Date('2026-11-13T01:00:00Z');
  assert.equal(upcomingEvents(events, { now, hoursAhead: 24 }).length, 1);
  assert.equal(upcomingEvents(events, { now: new Date('2026-11-20T00:00:00Z'), hoursAhead: 24 }).length, 0);
});

test('跨行属性会被展开', () => {
  const folded = single.replace('DESCRIPTION:带上上一版原型', 'DESCRIPTION:带上上一版\r\n 原型');
  const events = parseIcs(folded);
  assert.equal(events[0].description, '带上上一版原型');
});

test('ICS 使用 ETag 缓存，未变化时复用本地内容', async () => {
  const http = await import('node:http');
  const body = single;
  const server = http.createServer((req, res) => {
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { ETag: '"v1"' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/calendar', ETag: '"v1"' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const store = new Map();
  const state = {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    set: (key, value) => store.set(key, value)
  };
  try {
    const first = await loadCalendar({ icsUrl: `http://127.0.0.1:${port}/cal.ics`, hoursAhead: 72, state });
    assert.equal(first.cached, false);
    assert.equal(first.events.length, 1);
    assert.equal(store.get('etag'), '"v1"');

    const second = await loadCalendar({ icsUrl: `http://127.0.0.1:${port}/cal.ics`, hoursAhead: 72, state });
    assert.equal(second.cached, true);
    assert.equal(second.events.length, 1);
    assert.equal(store.get('icsText'), body);
  } finally {
    server.close();
  }
});

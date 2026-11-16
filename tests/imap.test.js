import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { testImap, fetchUnread } from '../plugins/email-imap/imap.js';
import { parseMessage } from '../plugins/email-imap/mime.js';

const USER = 'me@example.com';
const PASS = 'app-password';

function makeRaw({ from, subject, body, messageId, date }) {
  const encoded = Buffer.from(body, 'utf8').toString('base64');
  return [
    `From: ${from}`,
    `To: ${USER}`,
    `Subject: ${subject}`,
    `Message-ID: <${messageId}>`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encoded
  ].join('\r\n');
}

function startMock() {
  const commands = [];
  const messages = [
    {
      uid: 101,
      raw: makeRaw({
        from: '=?UTF-8?B?546L5bel?= <wang@example.com>',
        subject: '=?UTF-8?B?5ZCI5ZCM56Gu6K6k?=',
        body: '请今天下班前确认合同最后一版。',
        messageId: 'abc@example.com',
        date: 'Thu, 13 Nov 2026 09:30:00 +0800'
      })
    },
    {
      uid: 102,
      raw: makeRaw({
        from: 'news@example.com',
        subject: 'Weekly digest',
        body: 'This is a newsletter.',
        messageId: 'news@example.com',
        date: 'Thu, 13 Nov 2026 08:00:00 +0800'
      })
    }
  ];

  const server = net.createServer((socket) => {
    socket.write('* OK Mock IMAP ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
      }
    });

    const send = (text) => socket.write(text);

    function handle(line) {
      commands.push(line);
      const match = line.match(/^(\S+) (.*)$/);
      if (!match) return;
      const [, tag, rest] = match;
      const upper = rest.toUpperCase();
      if (upper.startsWith('CAPABILITY')) {
        send(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (upper.startsWith('LOGIN')) {
        const ok = rest.includes(`"${USER}"`) && rest.includes(`"${PASS}"`);
        send(ok ? `${tag} OK LOGIN completed\r\n` : `${tag} NO [AUTHENTICATIONFAILED] bad credentials\r\n`);
      } else if (upper.startsWith('EXAMINE') || upper.startsWith('SELECT')) {
        send(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
      } else if (upper.startsWith('UID SEARCH')) {
        send(`* SEARCH ${messages.map((m) => m.uid).join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
      } else if (upper.startsWith('UID FETCH')) {
        const uid = Number(rest.match(/UID FETCH (\d+)/i)[1]);
        const msg = messages.find((m) => m.uid === uid);
        const raw = Buffer.from(msg.raw, 'utf8');
        send(`* 1 FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`);
        socket.write(raw);
        send(`)\r\n${tag} OK FETCH completed\r\n`);
      } else if (upper.startsWith('UID STORE')) {
        send(`${tag} OK STORE completed\r\n`);
      } else if (upper.startsWith('LOGOUT')) {
        send(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        send(`${tag} BAD unknown command\r\n`);
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        commands,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

const baseConfig = (port) => ({
  host: '127.0.0.1',
  port,
  secure: false,
  user: USER,
  pass: PASS,
  mailbox: 'INBOX',
  days: 2,
  max: 8,
  markSeen: false
});

test('IMAP：登录并读取未读邮件', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const testResult = await testImap(baseConfig(mock.port));
  assert.equal(testResult.ok, true);
  assert.match(testResult.detail, /2 封邮件/);

  const messages = await fetchUnread(baseConfig(mock.port));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].subject, '合同确认');
  assert.match(messages[0].from, /王工/);
  assert.match(messages[0].text, /请今天下班前确认/);
  assert.equal(messages[0].messageId, 'abc@example.com');
  assert.ok(!mock.commands.some((c) => /UID STORE/i.test(c)), '默认不应该标记已读');
});

test('IMAP：markSeen 会写回 \\Seen', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  await fetchUnread({ ...baseConfig(mock.port), markSeen: true });
  assert.ok(mock.commands.filter((c) => /UID STORE/i.test(c)).length >= 1);
});

test('IMAP：密码错误会报可读错误', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  await assert.rejects(
    () => testImap({ ...baseConfig(mock.port), pass: 'wrong' }),
    /IMAP 命令失败/
  );
});

test('MIME：multipart 优先取 text/plain', () => {
  const raw = [
    'From: a@example.com',
    'Subject: hello',
    'Content-Type: multipart/alternative; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>HTML <b>body</b></p>',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain body',
    '--XYZ--'
  ].join('\r\n');
  const message = parseMessage(Buffer.from(raw, 'utf8'));
  assert.equal(message.text, 'plain body');
});

test('MIME：quoted-printable 与主题解码', () => {
  const raw = [
    'From: =?UTF-8?B?546L5bel?= <wang@example.com>',
    'Subject: =?UTF-8?Q?=E5=90=88=E5=90=8C?=',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'line one=0Aline two'
  ].join('\r\n');
  const message = parseMessage(Buffer.from(raw, 'utf8'));
  assert.equal(message.subject, '合同');
  assert.equal(message.text, 'line one\nline two');
});

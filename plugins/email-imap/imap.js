import net from 'node:net';
import tls from 'node:tls';
import { parseMessage } from './mime.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const quote = (value) => `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function imapDate(date) {
  return `${date.getDate()}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

class Reader {
  constructor(socket) {
    this.buf = Buffer.alloc(0);
    this.ended = false;
    this.error = null;
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.wake();
    });
    socket.on('end', () => { this.ended = true; this.wake(); });
    socket.on('close', () => { this.ended = true; this.wake(); });
    socket.on('error', (err) => { this.error = err; this.wake(); });
  }

  wake() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  async waitForData() {
    if (this.error) throw this.error;
    if (this.ended) throw new Error('IMAP 连接已断开');
    await new Promise((resolve) => this.waiters.push(resolve));
    if (this.error) throw this.error;
    if (this.ended && !this.buf.length) throw new Error('IMAP 连接已断开');
  }

  async readLine() {
    while (true) {
      const index = this.buf.indexOf('\r\n');
      if (index >= 0) {
        const line = this.buf.subarray(0, index).toString('utf8');
        this.buf = this.buf.subarray(index + 2);
        return line;
      }
      await this.waitForData();
    }
  }

  async readBytes(length) {
    while (this.buf.length < length) await this.waitForData();
    const out = this.buf.subarray(0, length);
    this.buf = this.buf.subarray(length);
    return out;
  }
}

export class ImapClient {
  constructor(config) {
    this.config = config;
    this.seq = 0;
    this.socket = null;
    this.reader = null;
  }

  async connect() {
    const host = String(this.config.host || '').trim();
    if (!host) throw new Error('还没有填 IMAP 服务器地址');
    const port = Number(this.config.port) || (this.config.secure ? 993 : 143);
    const secure = this.config.secure !== false;

    this.socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    this.socket.setTimeout(30000, () => {
      this.socket.destroy(new Error('IMAP 连接超时（30 秒无响应）'));
    });

    await new Promise((resolve, reject) => {
      const ready = secure ? 'secureConnect' : 'connect';
      this.socket.once(ready, resolve);
      this.socket.once('error', (err) => reject(new Error(`连接 ${host}:${port} 失败：${err.message}`)));
    });

    this.reader = new Reader(this.socket);
    const greeting = await this.reader.readLine();
    if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) {
      throw new Error(`服务器没有正常问候：${greeting.slice(0, 120)}`);
    }
  }

  async command(command) {
    if (!this.socket || this.socket.destroyed) throw new Error('IMAP 连接不可用');
    const tag = `J${++this.seq}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const lines = [];
    const literals = [];
    while (true) {
      const line = await this.reader.readLine();
      const literal = line.match(/\{(\d+)\}$/);
      if (literal) {
        literals.push(await this.reader.readBytes(Number(literal[1])));
        continue;
      }
      lines.push(line);
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1).trim();
        if (!/^OK\b/i.test(status) && !/^PREAUTH\b/i.test(status)) {
          throw new Error(`IMAP 命令失败：${status.slice(0, 240)}`);
        }
        return { lines, literals };
      }
      if (/^\* BYE\b/i.test(line)) throw new Error('IMAP 服务器关闭了连接');
    }
  }

  async login() {
    if (!this.config.user) throw new Error('还没有填邮箱账号');
    await this.command(`LOGIN ${quote(this.config.user)} ${quote(this.config.pass)}`);
  }

  async selectMailbox(mailbox) {
    const res = await this.command(`EXAMINE ${quote(mailbox || 'INBOX')}`);
    const exists = res.lines.find((line) => /^\* \d+ EXISTS/i.test(line));
    const validity = res.lines.find((line) => /UIDVALIDITY\s+(\d+)/i.test(line));
    this.uidValidity = validity ? Number(validity.match(/UIDVALIDITY\s+(\d+)/i)[1]) : 0;
    return exists ? Number(exists.match(/\d+/)[0]) : 0;
  }

  async searchUnseen(days = 2) {
    const since = new Date(Date.now() - Math.max(1, Math.min(30, Number(days) || 2)) * 86400000);
    const res = await this.command(`UID SEARCH UNSEEN SINCE ${imapDate(since)}`);
    const line = res.lines.find((l) => /^\* SEARCH\b/i.test(l));
    if (!line) return [];
    return line
      .replace(/^\* SEARCH\s*/i, '')
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  async fetchRaw(uid) {
    const res = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    if (!res.literals.length) throw new Error(`没有取到 UID ${uid} 的正文`);
    return res.literals[0];
  }

  async markSeen(uid) {
    await this.command(`UID STORE ${uid} +FLAGS (\\Seen)`);
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch {
      /* server may close immediately after BYE */
    }
  }

  destroy() {
    try { this.socket?.destroy(); } catch { /* ignore */ }
  }
}

export async function testImap(config) {
  const client = new ImapClient(config);
  try {
    await client.connect();
    await client.login();
    const count = await client.selectMailbox(config.mailbox || 'INBOX');
    return { ok: true, detail: `登录成功，${config.mailbox || 'INBOX'} 里有 ${count} 封邮件` };
  } finally {
    await client.logout().catch(() => {});
    client.destroy();
  }
}

export async function fetchUnread(config, { log = () => {}, state = null } = {}) {
  const client = new ImapClient(config);
  const max = Math.min(10, Math.max(1, Number(config.max) || 8));
  const mailbox = config.mailbox || 'INBOX';
  try {
    await client.connect();
    await client.login();
    const exists = await client.selectMailbox(mailbox);
    log(`已登录，${mailbox} 共 ${exists} 封`);

    const accountKey = `${config.host}:${config.user}:${mailbox}`;
    const previousAccount = state?.get('account', '');
    const previousValidity = Number(state?.get('uidValidity', 0)) || 0;
    let lastUid = Number(state?.get('lastUid', 0)) || 0;
    if (state && (previousAccount !== accountKey || (previousValidity && client.uidValidity && previousValidity !== client.uidValidity))) {
      lastUid = 0;
    }

    const allUnseen = await client.searchUnseen(config.days || 2);
    const uids = allUnseen.filter((uid) => uid > lastUid);
    log(`未读 ${allUnseen.length} 封，其中 ${uids.length} 封是新游标之后的`);
    if (!uids.length) {
      if (state) {
        state.set('account', accountKey);
        state.set('mailbox', mailbox);
        state.set('uidValidity', client.uidValidity || 0);
      }
      return [];
    }

    const picked = uids.slice(0, max);
    const messages = [];
    for (const uid of picked) {
      const raw = await client.fetchRaw(uid);
      const message = parseMessage(raw);
      messages.push({ uid, ...message });
      if (config.markSeen) await client.markSeen(uid);
    }
    if (state) {
      state.set('account', accountKey);
      state.set('mailbox', mailbox);
      state.set('uidValidity', client.uidValidity || 0);
      state.set('lastUid', Math.max(...picked));
    }
    return messages;
  } finally {
    await client.logout().catch(() => {});
    client.destroy();
  }
}

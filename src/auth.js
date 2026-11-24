import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const KEY_PATH = path.join(DATA_DIR, 'access-key');
const COOKIE = 'jj_session';
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000;

let cachedKey = null;
const attempts = new Map();

function generateKey() {
  const bytes = crypto.randomBytes(20);
  let chars = '';
  for (let i = 0; i < 20; i++) chars += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  return chars.match(/.{4}/g).join('-');
}

export function normalizeKey(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function getAccessKey() {
  if (process.env.JINGJING_ACCESS_KEY) return process.env.JINGJING_ACCESS_KEY;
  if (cachedKey) return cachedKey;
  try {
    const stored = fs.readFileSync(KEY_PATH, 'utf8').trim();
    if (stored) {
      cachedKey = stored;
      return cachedKey;
    }
  } catch { /* generate below */ }
  const key = generateKey();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, key + '\n', { mode: 0o600 });
  cachedKey = key;
  console.log(`[auth] 已生成配对码，保存在 ${KEY_PATH}`);
  return key;
}

export function rotateAccessKey() {
  const key = generateKey();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, key + '\n', { mode: 0o600 });
  cachedKey = key;
  return key;
}

function sessionToken(key = getAccessKey()) {
  return crypto.createHmac('sha256', normalizeKey(key)).update('jingjing-session-v1').digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// Cookie 按主机共享、不分端口：同一台机器上别的程序写进来的 Cookie 也会带到这里。
// 遇到不合法的 % 编码就原样保留，不能因为一个无关的 Cookie 让配对校验抛异常。
function decodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeCookieValue(part.slice(index + 1).trim());
  }
  return out;
}

export function isAuthorized(req) {
  const key = getAccessKey();
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return safeEqual(normalizeKey(header.slice(7)), normalizeKey(key));
  }
  const cookie = parseCookies(req.headers.cookie)[COOKIE];
  if (!cookie) return false;
  return safeEqual(cookie, sessionToken(key));
}

export function checkKey(value) {
  return safeEqual(normalizeKey(value), normalizeKey(getAccessKey()));
}

function cookieAttributes(req) {
  const secure = Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '') === 'https';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
}

export function setSessionCookie(req, res, key = getAccessKey()) {
  res.setHeader('Set-Cookie', `${COOKIE}=${sessionToken(key)}; ${cookieAttributes(req)}`);
}

export function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

export function rateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const record = attempts.get(ip) || { count: 0, reset: now + WINDOW_MS };
  if (now > record.reset) {
    record.count = 0;
    record.reset = now + WINDOW_MS;
  }
  if (record.count >= MAX_ATTEMPTS) {
    attempts.set(ip, record);
    return { ok: false, retryAfter: Math.ceil((record.reset - now) / 1000) };
  }
  record.count += 1;
  attempts.set(ip, record);
  return { ok: true };
}

export function resetRateLimit(req) {
  attempts.delete(clientIp(req));
}

export function login(req, res, suppliedKey) {
  if (!checkKey(suppliedKey)) return false;
  resetRateLimit(req);
  setSessionCookie(req, res);
  return true;
}

export function pairingInfo(req) {
  return {
    key: getAccessKey(),
    url: `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host || '127.0.0.1'}`
  };
}

export function accessKeyPath() {
  return KEY_PATH;
}

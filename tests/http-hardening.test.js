// 畸形请求不能让服务退出：不合法的 % 编码、乱填的 Host 头、别的程序写进来的坏 Cookie，
// 都只换回一个错误码。这些请求不用配对就能发到，所以起一个真的服务来测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTemp } from './temp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'TEST-HTTP-HARD-ENIN-G234';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-http-'));

let child;
let port;
let output = '';

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: free } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return free;
}

// 用 http.request 而不是 fetch：fetch 会规范化地址、不让改 Host 头，发不出这里要的畸形请求。
function send({ method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('请求超时')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function healthy() {
  try {
    const res = await send({ path: '/api/health' });
    return res.status === 200 && JSON.parse(res.text).ok === true;
  } catch {
    return false;
  }
}

async function assertStillUp(label) {
  assert.ok(await healthy(), `${label}之后服务退出了：\n${output.slice(-2000)}`);
}

test.before(async () => {
  port = await freePort();
  const env = { ...process.env, JINGJING_DATA_DIR: dataDir, JINGJING_HOST: '127.0.0.1', JINGJING_PORT: String(port), JINGJING_ACCESS_KEY: KEY };
  delete env.JINGJING_PARENT_PID;
  delete env.JINGJING_GUARD_PID;
  delete env.JINGJING_OVERLAY_VERSION;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!(await healthy())) {
    if (child.exitCode !== null) throw new Error(`服务没起来（退出码 ${child.exitCode}）：\n${output}`);
    if (Date.now() > deadline) throw new Error(`等服务启动超时：\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  removeTemp(dataDir);
});

test('静态文件地址里有不合法的 % 编码：回 400，服务不退出', async () => {
  for (const target of ['/%E0%A4%A', '/%', '/js/%zz.js']) {
    const res = await send({ path: target });
    assert.equal(res.status, 400, target);
  }
  await assertStillUp('畸形地址');
});

test('Host 头乱填：照常响应，服务不退出', async () => {
  const res = await send({ path: '/api/health', headers: { Host: '[' } });
  assert.equal(res.status, 200);
  await assertStillUp('畸形 Host 头');
});

test('Cookie 里有不合法的 % 编码：没配对就是 401，已配对的照样认', async () => {
  const anonymous = await send({ path: '/api/tasks', headers: { Cookie: 'other=%' } });
  assert.equal(anonymous.status, 401);
  await assertStillUp('畸形 Cookie');

  const login = await send({
    method: 'POST',
    path: '/api/auth/login',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY })
  });
  assert.equal(login.status, 200);
  const session = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
  assert.match(session, /^jj_session=/);

  // 同一台机器上别的程序写的坏 Cookie 和静静的会话 Cookie 一起带过来。
  const status = await send({ path: '/api/auth/status', headers: { Cookie: `other=%E0%A4%A; ${session}` } });
  assert.equal(JSON.parse(status.text).authenticated, true);
});

test('已配对的接口路径参数里有不合法的 % 编码：回 400 而不是 500', async () => {
  const res = await send({ path: '/api/workers/%E0%A4%A', headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(res.status, 400);
  await assertStillUp('畸形路径参数');
});

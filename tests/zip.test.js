import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readZipEntries, extractZip, isSafeEntry, moveDir } from '../src/zip.js';
import { makeZip } from './zip-fixture.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('zip：存储和 deflate 两种条目都能解出来，中文文件名、子目录、可执行位都保留', () => {
  const big = 'console.log("hi");\n'.repeat(500);
  const buffer = makeZip([
    { name: 'app/' },
    { name: 'app/server.js', data: big },
    { name: 'app/说明.md', data: '# 静静\n', method: 0 },
    { name: 'app/scripts/run.sh', data: '#!/bin/sh\necho ok\n', mode: 0o100755 }
  ]);
  const entries = readZipEntries(buffer);
  assert.deepEqual(entries.map((e) => e.name), ['app/', 'app/server.js', 'app/说明.md', 'app/scripts/run.sh']);
  assert.equal(entries[0].directory, true);
  assert.ok(entries[1].compressedSize < entries[1].size, 'deflate 条目确实压缩过');

  const out = tmp('jj-zip-');
  try {
    extractZip(buffer, out);
    assert.equal(fs.readFileSync(path.join(out, 'app', 'server.js'), 'utf8'), big);
    assert.equal(fs.readFileSync(path.join(out, 'app', '说明.md'), 'utf8'), '# 静静\n');
    if (process.platform !== 'win32') {
      assert.ok(fs.statSync(path.join(out, 'app', 'scripts', 'run.sh')).mode & 0o100, '脚本保留可执行位');
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('zip：路径穿越、符号链接、超大、损坏、Windows 保留名都拒绝', () => {
  const out = tmp('jj-zip-bad-');
  try {
    assert.throws(() => extractZip(makeZip([{ name: '../evil.js', data: 'x' }]), out), /非法路径/);
    assert.throws(() => extractZip(makeZip([{ name: 'a\\..\\..\\evil.js', data: 'x' }]), out), /非法路径/);
    assert.throws(() => extractZip(makeZip([{ name: '/etc/evil', data: 'x' }]), out), /非法路径/);
    assert.throws(() => extractZip(makeZip([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]), out), /符号链接/);
    assert.throws(() => extractZip(makeZip([{ name: 'big.txt', data: 'x'.repeat(2000) }]), out, { maxBytes: 1000 }), /超过/);
    assert.throws(() => extractZip(makeZip([{ name: 'app/CON.txt', data: 'x' }]), out, { platform: 'win32' }), /Windows/);
    assert.throws(() => extractZip(makeZip([{ name: 'app/a:b', data: 'x' }]), out, { platform: 'win32' }), /Windows/);

    // 改掉一个字节：CRC 对不上。
    const buffer = makeZip([{ name: 'a.txt', data: 'hello world', method: 0 }]);
    buffer[30 + 'a.txt'.length] ^= 0xff;
    assert.throws(() => extractZip(buffer, out), /校验失败/);

    // 声明的大小比实际小：deflate 解出来超过声明就停下。
    const bomb = makeZip([{ name: 'bomb.txt', data: 'a'.repeat(100000) }]);
    const sizeAt = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24;
    bomb.writeUInt32LE(10, sizeAt);
    assert.throws(() => extractZip(bomb, out), /解压失败|大小不对/);

    assert.throws(() => readZipEntries(Buffer.from('not a zip at all, definitely not')), /不是 zip/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  assert.equal(isSafeEntry('app/server.js'), true);
  assert.equal(isSafeEntry('C:\\Windows\\evil'), false);
});

test('zip：系统工具打的包也能读（有 zip 命令或者 Windows 自带的 tar 时）', (t) => {
  const root = tmp('jj-zip-sys-');
  try {
    fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'server.js'), 'export {};\n'.repeat(200));
    // 系统工具写中文文件名的编码各不相同（Windows 的 tar 跟着系统代码页走），这里只用 ASCII；中文名在上面的用例里测。
    fs.writeFileSync(path.join(root, 'app', 'src', 'config.js'), 'export const ok = true;\n');
    const zipPath = path.join(root, 'app.zip');
    const made = process.platform === 'win32'
      ? spawnSync('tar', ['-a', '-c', '-f', zipPath, 'app'], { cwd: root })
      : spawnSync('zip', ['-qr', zipPath, 'app'], { cwd: root });
    if (made.error || made.status !== 0) return t.skip('没有可用的打包命令');
    const out = path.join(root, 'out');
    extractZip(fs.readFileSync(zipPath), out);
    assert.equal(fs.readFileSync(path.join(out, 'app', 'server.js'), 'utf8'), 'export {};\n'.repeat(200));
    assert.equal(fs.readFileSync(path.join(out, 'app', 'src', 'config.js'), 'utf8'), 'export const ok = true;\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('moveDir：Windows 上被占用时等一下重试，其他错误照常抛', () => {
  const root = tmp('jj-move-');
  try {
    fs.mkdirSync(path.join(root, 'a'));
    moveDir(path.join(root, 'a'), path.join(root, 'b'));
    assert.equal(fs.existsSync(path.join(root, 'b')), true);
    assert.throws(() => moveDir(path.join(root, 'missing'), path.join(root, 'c')), /ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 读 zip：在线更新包和插件包都用它解压，不依赖系统的 unzip（Windows 上没有）。
 *
 * 只认常见的 zip：存储（0）和 deflate（8）、不加密、不分卷、不用 zip64（更新包 50MB、插件包 20MB 以内用不到）。
 * 解压时每一项都要过检查：不能是绝对路径、不能带 ..、不能是符号链接、Windows 上不能用系统保留的文件名；
 * 声明的总大小超限直接拒绝，实际解压出来的大小和 CRC 必须和声明一致，压缩炸弹撑不大。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function zipError(message) {
  const err = new Error(message);
  err.code = 'BAD_ZIP';
  return err;
}

/** 条目路径是否安全：相对路径、不带盘符、不往上跳。反斜杠按分隔符算。 */
export function isSafeEntry(entry) {
  const normalized = String(entry || '').replace(/\\/g, '/').trim();
  if (!normalized) return false;
  if (normalized.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

// Windows 文件名里不能有的字符，以及 CON、NUL 这类设备名（带扩展名也不行），结尾是点或空格的会被系统悄悄去掉。
const WINDOWS_BAD_CHARS = /[<>:"|?*\x00-\x1f]/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

function entryParts(name, platform) {
  if (!isSafeEntry(name)) throw zipError(`非法路径：${name}`);
  const parts = String(name).replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (platform === 'win32') {
    for (const part of parts) {
      if (WINDOWS_BAD_CHARS.test(part) || WINDOWS_RESERVED.test(part) || /[. ]$/.test(part)) {
        throw zipError(`Windows 上不能用的文件名：${name}`);
      }
    }
  }
  return parts;
}

/** 列出 zip 里的条目（只读中央目录，不解压）。 */
export function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw zipError('不是 zip 文件');
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw zipError('不是 zip 文件（找不到目录）');
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) throw zipError('不支持分卷 zip');
  const count = buffer.readUInt16LE(eocd + 10);
  const dirSize = buffer.readUInt32LE(eocd + 12);
  const dirOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw zipError('不支持 zip64');
  if (dirOffset + dirSize > eocd) throw zipError('zip 目录损坏');

  const entries = [];
  let p = dirOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > eocd || buffer.readUInt32LE(p) !== CENTRAL) throw zipError('zip 目录损坏');
    const madeBy = buffer.readUInt16LE(p + 4);
    const flags = buffer.readUInt16LE(p + 8);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const external = buffer.readUInt32LE(p + 38);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    // Unix 上打的包（madeBy 高字节 = 3），external 高 16 位是文件类型和权限。
    const mode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    entries.push({
      name,
      method: buffer.readUInt16LE(p + 10),
      crc: buffer.readUInt32LE(p + 16),
      compressedSize: buffer.readUInt32LE(p + 20),
      size: buffer.readUInt32LE(p + 24),
      localOffset: buffer.readUInt32LE(p + 42),
      mode,
      directory: /[\\/]$/.test(name) || (external & 0x10) !== 0,
      symlink: (mode & S_IFMT) === S_IFLNK,
      encrypted: (flags & 1) !== 0
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryData(buffer, entry) {
  const p = entry.localOffset;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== LOCAL) throw zipError(`zip 条目损坏：${entry.name}`);
  const start = p + 30 + buffer.readUInt16LE(p + 26) + buffer.readUInt16LE(p + 28);
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw zipError(`zip 条目损坏：${entry.name}`);
  const raw = buffer.subarray(start, end);
  let data;
  if (entry.method === 0) {
    data = raw;
  } else if (entry.method === 8) {
    try {
      // 按声明的大小封顶：实际比声明大（压缩炸弹、损坏）直接失败。
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch (err) {
      throw zipError(`解压失败：${entry.name}（${err.message}）`);
    }
  } else {
    throw zipError(`不支持的压缩方式（${entry.method}）：${entry.name}`);
  }
  if (data.length !== entry.size) throw zipError(`zip 条目大小不对：${entry.name}`);
  if (zlib.crc32(data) >>> 0 !== entry.crc) throw zipError(`zip 条目校验失败：${entry.name}`);
  return data;
}

/**
 * 把 zip 解压到 outDir。entries 传 readZipEntries 的结果可以省一次解析（调用方通常先自己检查过一遍）。
 * maxBytes：解压后的总字节数上限。
 */
export function extractZip(buffer, outDir, { entries = readZipEntries(buffer), maxBytes = Infinity, platform = process.platform } = {}) {
  const root = path.resolve(outDir);
  fs.mkdirSync(root, { recursive: true });
  const declared = entries.reduce((sum, entry) => sum + (entry.directory ? 0 : entry.size), 0);
  if (declared > maxBytes) throw zipError(`解压后超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
  for (const entry of entries) {
    const parts = entryParts(entry.name, platform);
    if (entry.encrypted) throw zipError(`不支持加密的 zip：${entry.name}`);
    if (entry.symlink) throw zipError(`zip 里不能有符号链接：${entry.name}`);
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(root + path.sep)) throw zipError(`非法路径：${entry.name}`);
    if (entry.directory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const data = entryData(buffer, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    if (platform !== 'win32' && entry.mode & 0o111) fs.chmodSync(target, 0o755);
  }
  return entries.map((entry) => entry.name);
}

/**
 * 把刚解压出来的目录挪到位。Windows 上杀毒软件常常还在扫刚写出的文件，rename 会短暂地报 EPERM / EBUSY，
 * 等一下重试就好（和 graceful-fs 的做法一样）；其他系统、其他错误照常抛出。
 */
export function moveDir(from, to, { platform = process.platform, attempts = 10 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (platform !== 'win32' || attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
    }
  }
}

/**
 * 同一个数据目录只允许一个服务进程。
 *
 * 启动时 recover() 会把库里 status = running 的任务当成「上次被打断」重新安排；
 * 如果另一个进程其实还活着，这一步会让同一个任务被执行两次。所以业务代码开始前先拿这把锁。
 *
 * 锁用 SQLite 的独占锁实现：locking_mode = EXCLUSIVE 下写过一次就一直持有文件锁，
 * 进程退出（包括崩溃、被强制结束）时操作系统会自动释放，不会出现 pid 文件残留导致起不来的情况。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let held = null;

function readOwner(file) {
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(owner?.pid) ? owner : null;
  } catch {
    return null;
  }
}

/**
 * 拿锁。成功返回 { ok: true }；已经有进程拿着时返回 { ok: false, pid, startedAt }（能读到的话）。
 * 同一个进程重复调用直接成功。
 */
export function acquireInstanceLock(dataDir) {
  if (held) return { ok: true };
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, 'instance.lock');
  const ownerFile = path.join(dataDir, 'instance.json');
  let conn;
  try {
    conn = new DatabaseSync(lockFile);
    conn.exec('PRAGMA locking_mode = EXCLUSIVE');
    conn.exec('BEGIN EXCLUSIVE');
    conn.exec('CREATE TABLE IF NOT EXISTS owner (pid INTEGER, started_at TEXT)');
    conn.exec('DELETE FROM owner');
    conn.prepare('INSERT INTO owner(pid, started_at) VALUES(?, ?)').run(process.pid, new Date().toISOString());
    conn.exec('COMMIT');
  } catch (err) {
    try { conn?.close(); } catch { /* ignore */ }
    if (/locked|busy/i.test(String(err.message))) {
      const owner = readOwner(ownerFile);
      return { ok: false, pid: owner?.pid ?? null, startedAt: owner?.startedAt ?? null };
    }
    throw err;
  }
  held = conn;
  // 只是给人看的说明（锁被占时报出是哪个进程），真正的锁是上面那个文件锁。
  try {
    fs.writeFileSync(ownerFile, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  } catch { /* 写不了不影响加锁 */ }
  return { ok: true };
}

export function releaseInstanceLock() {
  if (!held) return;
  try { held.close(); } catch { /* ignore */ }
  held = null;
}

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { APP_ROOT, VERSION, compareVersions, normalizeVersion } from './version.js';

export const UPDATES_DIR = path.join(DATA_DIR, 'updates');
export const CURRENT_FILE = path.join(UPDATES_DIR, 'current.json');

function insideUpdates(dir) {
  const root = path.resolve(UPDATES_DIR) + path.sep;
  return path.resolve(dir).startsWith(root);
}

export function readCurrentRecord() {
  try {
    const raw = JSON.parse(fs.readFileSync(CURRENT_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (!normalizeVersion(raw.version) || typeof raw.dir !== 'string' || !raw.dir) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeCurrentRecord(record) {
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  const temp = `${CURRENT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2));
  fs.renameSync(temp, CURRENT_FILE);
}

/** 已安装但尚未生效的版本（不判断是否高于当前运行版本）。 */
export function installedUpdate() {
  const record = readCurrentRecord();
  if (!record) return null;
  const dir = path.resolve(record.dir);
  if (!insideUpdates(dir) || !fs.existsSync(path.join(dir, 'server.js'))) return null;
  return { ...record, dir };
}

/**
 * 启动时选择要运行的代码目录：
 * - 已安装目录必须是 updates/ 下的子目录；
 * - 版本必须严格高于当前运行的代码，否则忽略（避免反复重载与降级）。
 */
export function resolveOverlay() {
  if (process.env.JINGJING_NO_OVERLAY === '1') return null;
  const record = installedUpdate();
  if (!record || record.broken) return null;
  if (record.dir === path.resolve(APP_ROOT)) return null;
  if (compareVersions(record.version, VERSION) <= 0) return null;
  return record;
}

export function markOverlayBroken(record, reason) {
  try {
    writeCurrentRecord({
      ...record,
      broken: true,
      brokenAt: new Date().toISOString(),
      brokenReason: String(reason || '').slice(0, 400)
    });
  } catch (err) {
    console.error('[update] 无法记录启动失败：', err.message);
  }
}

/**
 * 如果数据目录里装了更新版本，则用它重新拉起服务并接管管控：
 * 父进程只做进程守护（转发信号、记录崩溃），业务代码全部由子进程执行。
 */
export async function activateOverlay() {
  if (process.env.JINGJING_OVERLAY_GUARD === '1') return;
  const overlay = resolveOverlay();
  if (!overlay) return;

  console.log(`[update] 使用已安装的新版本 ${overlay.version}（${overlay.dir}）`);
  const startedAt = Date.now();
  const child = spawn(process.execPath, [path.join(overlay.dir, 'server.js')], {
    cwd: overlay.dir,
    env: {
      ...process.env,
      JINGJING_DATA_DIR: DATA_DIR,
      JINGJING_OVERLAY_GUARD: '1',
      JINGJING_OVERLAY_VERSION: overlay.version,
      JINGJING_BUNDLED_VERSION: VERSION
    },
    stdio: 'inherit'
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        /* 子进程已退出 */
      }
    });
  }

  child.on('error', (err) => {
    markOverlayBroken(overlay, err.message);
    console.error(`[update] 新版本启动失败，下次启动回退内置版本：${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (code !== 0 && !signal && Date.now() - startedAt < 15000) {
      markOverlayBroken(overlay, `启动后立即退出（code ${code}）`);
      console.error('[update] 新版本启动后立即退出，下次启动回退内置版本');
    }
    process.exit(code ?? 0);
  });

  // 父进程保持存活，直到子进程结束；业务代码不再继续执行。
  await new Promise(() => {});
}

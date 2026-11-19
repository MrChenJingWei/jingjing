import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readZipEntries, extractZip, isSafeEntry, moveDir } from './zip.js';
import { VERSION, compareVersions, normalizeVersion, readVersion } from './version.js';
import { UPDATES_DIR, CURRENT_FILE, installedUpdate, writeCurrentRecord } from './overlay.js';

const DEFAULT_REPO = 'MrChenJingWei/jingjing';
export const REPO = (process.env.JINGJING_UPDATE_REPO || DEFAULT_REPO).trim();
export const API_BASE = (process.env.JINGJING_UPDATE_API_BASE || 'https://api.github.com').replace(/\/+$/, '');

const CACHE_FILE = path.join(UPDATES_DIR, 'cache.json');
const CACHE_TTL = 60 * 60 * 1000;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
const MAX_FILES = 4000;
const USER_AGENT = 'jingjing-updater';

function updaterError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fetchWithTimeout(url, options = {}, timeout = 20000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    fs.mkdirSync(UPDATES_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2));
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

export { isSafeEntry };

export function findAppRoot(outDir) {
  if (fs.existsSync(path.join(outDir, 'server.js'))) return outDir;
  const dirs = fs.readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__MACOSX')
    .map((entry) => entry.name);
  const roots = dirs.filter((name) => fs.existsSync(path.join(outDir, name, 'server.js')));
  if (!roots.length) throw updaterError('更新包里没有找到 server.js');
  if (roots.length > 1) throw updaterError(`更新包里有多个应用目录（${roots.join(', ')}）`);
  return path.join(outDir, roots[0]);
}

/** 校验 release 里的 latest.json 清单。 */
export function parseReleaseManifest(raw, { tagName = '', assets = [], notes = '' } = {}) {
  const version = normalizeVersion(raw?.version || tagName);
  if (!version) throw updaterError('发布清单缺少合法版本号', 502);
  const tagVersion = normalizeVersion(tagName);
  if (tagVersion && compareVersions(tagVersion, version) !== 0) {
    throw updaterError(`发布清单版本（${version}）与 tag（${tagName}）不一致`, 502);
  }
  const digest = String(raw?.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw updaterError('发布清单缺少 sha256 校验值', 502);
  const asset = (assets || []).find((item) => item?.name === `jingjing-app-${version}.zip`) || null;
  const url = String(raw?.url || asset?.browser_download_url || '');
  if (!/^https?:\/\//i.test(url)) throw updaterError('发布清单缺少可用的下载地址', 502);
  return {
    version,
    sha256: digest,
    url,
    notes: String(raw?.notes || notes || ''),
    node: String(raw?.node || ''),
    signature: String(raw?.signature || ''),
    size: Number(asset?.size) || 0
  };
}

/**
 * 可选的 Ed25519 清单签名：设置 JINGJING_UPDATE_PUBKEY（PEM）后强制校验。
 * 签名的消息是 `${version}\n${sha256}`。
 */
export function verifyManifestSignature(manifest, pubkey = process.env.JINGJING_UPDATE_PUBKEY) {
  if (!pubkey) return { required: false, ok: true, reason: '' };
  if (!manifest?.signature) return { required: true, ok: false, reason: '更新清单缺少签名' };
  try {
    const ok = crypto.verify(
      null,
      Buffer.from(`${manifest.version}\n${manifest.sha256}`),
      crypto.createPublicKey(pubkey),
      Buffer.from(manifest.signature, 'base64')
    );
    return { required: true, ok, reason: ok ? '' : '签名不匹配' };
  } catch (err) {
    return { required: true, ok: false, reason: err.message };
  }
}

export function status() {
  const installed = installedUpdate();
  return {
    current: VERSION,
    repo: REPO,
    overlayActive: process.env.JINGJING_OVERLAY_VERSION || null,
    installed: installed
      ? {
        version: installed.version,
        dir: installed.dir,
        installedAt: installed.installedAt || '',
        broken: Boolean(installed.broken),
        previous: installed.previous?.version || null
      }
      : null
  };
}

/** 查询 GitHub 最新 Release；结果缓存 1 小时，并用 ETag 做条件请求。 */
export async function checkForUpdate({ force = false } = {}) {
  const cache = readCache();
  if (!force && cache?.result && Date.now() - Number(cache.fetchedAt || 0) < CACHE_TTL) {
    return { ...cache.result, cached: true };
  }

  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  if (cache?.etag) headers['If-None-Match'] = cache.etag;

  let res;
  try {
    res = await fetchWithTimeout(`${API_BASE}/repos/${REPO}/releases/latest`, { headers });
  } catch (err) {
    if (cache?.result) return { ...cache.result, cached: true, stale: true, error: `无法连接 GitHub：${err.message}` };
    throw updaterError(`无法连接 GitHub：${err.message}`, 502);
  }

  if (res.status === 304 && cache?.result) return { ...cache.result, cached: true };
  if (res.status === 404) {
    return { current: VERSION, latest: null, available: false, error: '仓库还没有发布任何版本', cached: false };
  }
  if (!res.ok) {
    throw updaterError(`GitHub 返回 ${res.status}`, res.status === 403 || res.status === 429 ? 429 : 502);
  }

  let release;
  try {
    release = await res.json();
  } catch {
    throw updaterError('GitHub 返回的发布信息无法解析', 502);
  }
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const manifestAsset = assets.find((asset) => asset?.name === 'latest.json');
  if (!manifestAsset?.browser_download_url) {
    throw updaterError('这次发布缺少 latest.json 清单，无法校验更新包', 502);
  }

  const manifestRes = await fetchWithTimeout(manifestAsset.browser_download_url, { headers: { 'User-Agent': USER_AGENT } });
  if (!manifestRes.ok) throw updaterError(`下载发布清单失败（${manifestRes.status}）`, 502);
  const manifest = parseReleaseManifest(await manifestRes.json(), {
    tagName: release.tag_name,
    assets,
    notes: release.body
  });
  const signature = verifyManifestSignature(manifest);
  if (!signature.ok) throw updaterError(`更新清单签名校验失败：${signature.reason}`, 502);

  const result = {
    current: VERSION,
    latest: manifest.version,
    available: compareVersions(manifest.version, VERSION) > 0,
    notes: manifest.notes,
    publishedAt: release.published_at || '',
    size: manifest.size,
    sha256: manifest.sha256,
    url: manifest.url,
    node: manifest.node,
    signature: { required: signature.required, ok: signature.ok },
    cached: false
  };
  writeCache({ fetchedAt: Date.now(), etag: res.headers.get('etag') || '', result });
  return result;
}

async function downloadUpdate(info) {
  const declared = Number(info.size) || 0;
  if (declared > MAX_ZIP_BYTES) throw updaterError('更新包超过 50MB', 502);
  const res = await fetchWithTimeout(info.url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
    redirect: 'follow'
  }, 60000);
  if (!res.ok) throw updaterError(`下载更新包失败（${res.status}）`, 502);
  const length = Number(res.headers.get('content-length')) || 0;
  if (length > MAX_ZIP_BYTES) throw updaterError('更新包超过 50MB', 502);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_ZIP_BYTES) throw updaterError('更新包超过 50MB', 502);
  return buffer;
}

function pruneUpdates(record) {
  const keep = new Set([record.version, record.previous?.version].filter(Boolean).map((value) => path.resolve(path.join(UPDATES_DIR, value))));
  for (const entry of fs.readdirSync(UPDATES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const full = path.resolve(path.join(UPDATES_DIR, entry.name));
    if (keep.has(full)) continue;
    fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** 把已下载的 zip 安装到数据目录，并写入 current.json 指针。 */
export function installUpdate(buffer, { version, sha256: expected, source = '', notes = '' } = {}) {
  const targetVersion = normalizeVersion(version);
  if (!targetVersion) throw updaterError('更新版本号不合法');
  const digest = sha256(buffer);
  if (expected && digest !== String(expected).toLowerCase()) {
    throw updaterError('更新包校验失败（sha256 不匹配）', 502);
  }

  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(UPDATES_DIR, `.install-${targetVersion}-`));
  const outDir = path.join(work, 'out');

  try {
    let entries;
    try {
      entries = readZipEntries(buffer);
    } catch (err) {
      throw updaterError(`无法读取更新包：${err.message}`, 502);
    }
    if (!entries.length) throw updaterError('更新包是空的');
    if (entries.length > MAX_FILES) throw updaterError(`更新包文件太多（最多 ${MAX_FILES} 个）`);
    for (const entry of entries) {
      if (!isSafeEntry(entry.name)) throw updaterError(`更新包含非法路径：${entry.name}`);
    }
    if (entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_UNPACKED_BYTES) throw updaterError('更新包解压后超过 300MB');

    try {
      extractZip(buffer, outDir, { entries, maxBytes: MAX_UNPACKED_BYTES });
    } catch (err) {
      throw updaterError(`解压更新包失败：${err.message}`, 502);
    }

    const root = findAppRoot(outDir);
    const packagedVersion = normalizeVersion(readVersion(root));
    if (packagedVersion !== targetVersion) {
      throw updaterError(`更新包版本号不一致（包内 ${packagedVersion || '缺失'}，清单 ${targetVersion}）`);
    }
    if (!fs.existsSync(path.join(root, 'server.js'))) throw updaterError('更新包缺少 server.js');

    const destination = path.join(UPDATES_DIR, targetVersion);
    fs.rmSync(destination, { recursive: true, force: true, maxRetries: 3 });
    moveDir(root, destination);

    const previous = installedUpdate();
    const record = {
      version: targetVersion,
      dir: destination,
      installedAt: new Date().toISOString(),
      sha256: expected ? String(expected).toLowerCase() : digest,
      source,
      notes: String(notes || '').slice(0, 2000),
      previous: previous ? { version: previous.version, dir: previous.dir } : null
    };
    writeCurrentRecord(record);
    pruneUpdates(record);
    return record;
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function applyUpdate() {
  const info = await checkForUpdate({ force: true });
  if (!info.available) throw updaterError('已经是最新版本');
  const buffer = await downloadUpdate(info);
  if (sha256(buffer) !== info.sha256) throw updaterError('更新包校验失败（sha256 不匹配）', 502);
  const record = installUpdate(buffer, {
    version: info.latest,
    sha256: info.sha256,
    source: info.url,
    notes: info.notes
  });
  return {
    installed: true,
    version: record.version,
    previous: record.previous?.version || VERSION,
    restartRequired: true,
    notes: info.notes
  };
}

export function rollbackUpdate() {
  const record = installedUpdate();
  if (!record) throw updaterError('没有已安装的更新');
  const previous = record.previous;
  if (!previous?.dir || !fs.existsSync(path.join(previous.dir, 'server.js'))) {
    fs.rmSync(CURRENT_FILE, { force: true });
    return {
      rolledBack: true,
      version: process.env.JINGJING_BUNDLED_VERSION || VERSION,
      restartRequired: true,
      note: '已回退到内置版本'
    };
  }
  writeCurrentRecord({
    version: previous.version,
    dir: previous.dir,
    installedAt: new Date().toISOString(),
    previous: null,
    rolledBackFrom: record.version
  });
  return { rolledBack: true, version: previous.version, restartRequired: true };
}

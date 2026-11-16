import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-update-'));
process.env.JINGJING_DATA_DIR = DATA_DIR;
process.env.JINGJING_UPDATE_REPO = 'acme/jingjing';

function hasZip() {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeAppZip(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-app-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'jingjing', version, type: 'module' }));
  fs.writeFileSync(path.join(app, 'server.js'), 'console.log("stub");\n');
  fs.writeFileSync(path.join(app, 'src', 'config.js'), 'export const stub = true;\n');
  const zipPath = path.join(root, 'app.zip');
  execFileSync('zip', ['-qr', zipPath, 'app'], { cwd: root });
  return fs.readFileSync(zipPath);
}

const { VERSION, compareVersions, normalizeVersion } = await import('../src/version.js');
const overlay = await import('../src/overlay.js');
const update = await import('../src/update.js');

const zipAvailable = hasZip();

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('版本号唯一来源是 package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('semver 比较：主机号、补丁号与预发布', () => {
  assert.equal(compareVersions('0.3.0', '0.2.9'), 1);
  assert.equal(compareVersions('v1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0+build.2', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(compareVersions('bogus', '1.0.0'), 0);
});

test('版本号规范化拒绝非法输入', () => {
  assert.equal(normalizeVersion(' v0.3.0 '), '0.3.0');
  assert.equal(normalizeVersion('../../evil'), null);
  assert.equal(normalizeVersion(''), null);
  assert.equal(normalizeVersion(null), null);
});

test('zip 条目安全校验拒绝路径穿越与绝对路径', () => {
  assert.equal(update.isSafeEntry('app/server.js'), true);
  assert.equal(update.isSafeEntry('app\\server.js'), true);
  assert.equal(update.isSafeEntry('../evil.js'), false);
  assert.equal(update.isSafeEntry('app/../../evil.js'), false);
  assert.equal(update.isSafeEntry('/etc/passwd'), false);
  assert.equal(update.isSafeEntry('C:/Windows/system32'), false);
  assert.equal(update.isSafeEntry(''), false);
});

test('清单必须带 sha256、版本要对得上 tag', () => {
  const sha = 'a'.repeat(64);
  const manifest = update.parseReleaseManifest(
    { version: '0.3.1', sha256: sha },
    {
      tagName: 'v0.3.1',
      assets: [{ name: 'jingjing-app-0.3.1.zip', browser_download_url: 'https://example.com/a.zip', size: 12 }]
    }
  );
  assert.equal(manifest.version, '0.3.1');
  assert.equal(manifest.url, 'https://example.com/a.zip');
  assert.equal(manifest.size, 12);

  assert.throws(() => update.parseReleaseManifest({ version: '0.3.1' }, {}), /sha256/);
  assert.throws(
    () => update.parseReleaseManifest({ version: '0.3.1', sha256: sha }, { tagName: 'v0.4.0' }),
    /不一致/
  );
  assert.throws(() => update.parseReleaseManifest({ version: '0.3.1', sha256: sha }, {}), /下载地址/);
});

test('配置公钥后，签名缺失或错误都会被拒绝', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = { version: '0.3.1', sha256: 'b'.repeat(64), signature: '' };

  assert.equal(update.verifyManifestSignature(manifest, publicKey.export({ type: 'spki', format: 'pem' })).ok, false);

  const signature = crypto
    .sign(null, Buffer.from(`${manifest.version}\n${manifest.sha256}`), privateKey)
    .toString('base64');
  assert.equal(
    update.verifyManifestSignature({ ...manifest, signature }, publicKey.export({ type: 'spki', format: 'pem' })).ok,
    true
  );
  assert.equal(update.verifyManifestSignature(manifest, undefined).required, false);
});

test('安装、切换、回退的完整流程', { skip: zipAvailable ? false : '缺少 unzip/zip' }, () => {
  const buffer = makeAppZip('9.9.9');
  const record = update.installUpdate(buffer, { version: '9.9.9', sha256: update.sha256(buffer) });

  assert.equal(record.version, '9.9.9');
  assert.equal(fs.existsSync(path.join(record.dir, 'server.js')), true);
  assert.equal(overlay.installedUpdate().version, '9.9.9');
  assert.equal(overlay.resolveOverlay().version, '9.9.9', '更高版本应被选为运行目录');

  overlay.markOverlayBroken(record, '测试');
  assert.equal(overlay.resolveOverlay(), null, '崩溃过的版本不应再被加载');

  const rolled = update.rollbackUpdate();
  assert.equal(rolled.rolledBack, true);
  assert.equal(rolled.version, VERSION);
  assert.equal(fs.existsSync(overlay.CURRENT_FILE), false);
});

test('校验失败和版本不一致都会拒绝安装', { skip: zipAvailable ? false : '缺少 unzip/zip' }, () => {
  const buffer = makeAppZip('1.2.3');
  assert.throws(
    () => update.installUpdate(buffer, { version: '1.2.3', sha256: 'c'.repeat(64) }),
    /sha256 不匹配/
  );
  assert.throws(() => update.installUpdate(buffer, { version: '9.8.7' }), /版本号不一致/);
});

test('从模拟 GitHub 源检查更新', { skip: zipAvailable ? false : '缺少 unzip/zip' }, async () => {
  const zip = makeAppZip('9.9.9');
  const sha = update.sha256(zip);
  let base = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/repos/acme/jingjing/releases/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v1"' });
      res.end(JSON.stringify({
        tag_name: 'v9.9.9',
        body: '修好了很多事',
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          { name: 'latest.json', browser_download_url: `${base}/latest.json`, size: 120 },
          { name: 'jingjing-app-9.9.9.zip', browser_download_url: `${base}/app.zip`, size: zip.length }
        ]
      }));
      return;
    }
    if (req.url === '/latest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '9.9.9', sha256: sha, notes: '修好了很多事' }));
      return;
    }
    if (req.url === '/app.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(zip);
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.JINGJING_UPDATE_API_BASE = base;

  try {
    // API_BASE 在模块导入时读取，用带参数的重新导入拿到指向本地假源的实例。
    const mod = await import('../src/update.js?simulated=1');
    const info = await mod.checkForUpdate({ force: true });
    assert.equal(info.available, true);
    assert.equal(info.latest, '9.9.9');
    assert.equal(info.sha256, sha);
    assert.equal(info.notes, '修好了很多事');
  } finally {
    server.close();
  }
});

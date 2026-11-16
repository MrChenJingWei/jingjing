import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { USER_PLUGIN_DIR } from './plugins.js';
import { validateManifest } from './plugin-spec.js';

const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 1200;

function installError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function findPluginRoot(outDir) {
  if (fs.existsSync(path.join(outDir, 'plugin.json'))) return outDir;
  const dirs = fs.readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__MACOSX')
    .map((entry) => entry.name);
  const roots = dirs.filter((name) => fs.existsSync(path.join(outDir, name, 'plugin.json')));
  if (!roots.length) throw installError('压缩包里没有找到 plugin.json');
  if (roots.length > 1) throw installError(`压缩包里有多个插件（${roots.join(', ')}），一次只能安装一个`);
  return path.join(outDir, roots[0]);
}

function listZip(zipPath) {
  try {
    const output = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (err) {
    throw installError(`无法读取 zip：${err.message}`);
  }
}

/**
 * 安装一个插件 zip（不启用）。
 * zip 里可以是 plugins 根下的一个目录，也可以直接是 plugin.json + 入口文件。
 */
export async function installPluginZip(buffer) {
  if (!buffer?.length) throw installError('没有收到插件文件');
  if (buffer.length > MAX_ZIP_BYTES) throw installError('插件包不能超过 20MB');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(USER_PLUGIN_DIR, { recursive: true });
  const temp = fs.mkdtempSync(path.join(DATA_DIR, 'plugin-install-'));
  const zipPath = path.join(temp, 'plugin.zip');
  const outDir = path.join(temp, 'out');
  fs.writeFileSync(zipPath, buffer);

  try {
    const entries = listZip(zipPath);
    if (!entries.length) throw installError('插件包是空的');
    if (entries.length > MAX_FILES) throw installError(`插件包文件太多（最多 ${MAX_FILES} 个）`);
    for (const entry of entries) {
      const normalized = entry.replace(/\\/g, '/');
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
        throw installError(`插件包含非法路径：${entry}`);
      }
    }

    fs.mkdirSync(outDir, { recursive: true });
    try {
      execFileSync('unzip', ['-q', '-o', zipPath, '-d', outDir], { stdio: 'pipe', maxBuffer: 20 * 1024 * 1024 });
    } catch (err) {
      throw installError(`解压失败：${err.message}`);
    }

    const root = findPluginRoot(outDir);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
    } catch (err) {
      throw installError(`plugin.json 不是合法 JSON：${err.message}`);
    }
    const id = String(raw.id || '').trim();
    const manifest = validateManifest(raw, { dir: root, dirName: id });

    const destination = path.join(USER_PLUGIN_DIR, manifest.id);
    if (fs.existsSync(destination)) {
      throw installError(`插件「${manifest.id}」已经安装过，请先卸载`);
    }
    fs.renameSync(root, destination);
    return { id: manifest.id, manifest, dir: destination };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

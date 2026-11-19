// 官方插件随 App 发布、只读；「我的」插件在数据目录，可以覆盖官方同 id 插件；旧版本复制出来的副本自动迁移。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './temp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-official-'));
process.env.JINGJING_DATA_DIR = dataDir;

const plugins = await import('../src/plugins.js');
const { db } = await import('../src/db.js');

test.after(() => removeTemp(dataDir));

const userDir = (id) => path.join(plugins.USER_PLUGIN_DIR, id);
const copyOfficial = (id) => fs.cpSync(path.join(plugins.PLUGIN_DIR, id), userDir(id), { recursive: true });
const byPlugin = (id) => plugins.listPlugins().find((item) => item.pluginId === id && item.id === id);

test('迁移旧副本：没改过的挪去备份改用官方，改过的保留并覆盖官方', async () => {
  fs.mkdirSync(plugins.USER_PLUGIN_DIR, { recursive: true });
  copyOfficial('webhook');          // 和官方一模一样
  copyOfficial('calendar');         // 复制后改过
  const manifestPath = path.join(userDir('calendar'), 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  raw.name = '我改过的日历';
  fs.writeFileSync(manifestPath, JSON.stringify(raw));
  const later = new Date(Date.now() + 5 * 60 * 1000);
  fs.utimesSync(manifestPath, later, later);

  const moved = plugins.migrateSeededCopies();
  assert.deepEqual(moved, ['webhook']);
  assert.ok(!fs.existsSync(userDir('webhook')));
  assert.ok(fs.readdirSync(path.join(plugins.USER_PLUGIN_DIR, '.migrated')).some((name) => name.startsWith('webhook-')));
  assert.deepEqual(plugins.migrateSeededCopies(), [], '只迁移一次');

  await plugins.reloadPlugins();
  assert.deepEqual(plugins.pluginErrors(), []);
  const webhook = byPlugin('webhook');
  assert.equal(webhook.source, 'official');
  assert.equal(webhook.removable, false, '官方插件的默认实例不能删');
  const calendar = byPlugin('calendar');
  assert.equal(calendar.source, 'user');
  assert.equal(calendar.overridesOfficial, true);
  assert.equal(calendar.name, '我改过的日历');
  assert.equal(byPlugin('wecom').source, 'official', '带依赖的官方插件（打包产物）也能加载');
});

test('官方插件只能停用不能删；多出来的实例可以删', async () => {
  assert.throws(() => plugins.uninstallPlugin('webhook'), /官方插件不能删除/);
  const extra = plugins.createInstance('webhook', '第二个钩子');
  const result = plugins.uninstallPlugin(extra.id);
  assert.equal(result.purged, false);
  assert.ok(fs.existsSync(path.join(plugins.PLUGIN_DIR, 'webhook', 'plugin.json')), '官方文件不受影响');
});

test('复制为我的插件：新 id、新名字，官方版本照常保留', async () => {
  const id = plugins.forkOfficial('email-imap');
  assert.equal(id, 'email-imap-mine');
  await plugins.reloadPlugins();
  const mine = byPlugin(id);
  assert.equal(mine.source, 'user');
  assert.equal(mine.overridesOfficial, false);
  assert.match(mine.name, /（我的）$/);
  assert.equal(byPlugin('email-imap').source, 'official');
  assert.equal(plugins.forkOfficial('email-imap'), 'email-imap-mine2', '再复制一次不会撞 id');
  assert.throws(() => plugins.forkOfficial('not-exist'), /没有这个官方插件/);
});

test('恢复官方版本：挪走覆盖的那份，实例配置保留', async () => {
  db.prepare("UPDATE source_plugins SET label = '我的日历实例' WHERE id = 'calendar'").run();
  plugins.restoreOfficial('calendar');
  await plugins.reloadPlugins();
  const calendar = byPlugin('calendar');
  assert.equal(calendar.source, 'official');
  assert.equal(calendar.overridesOfficial, false);
  assert.equal(calendar.label, '我的日历实例', '实例按插件 id 保存，恢复后还在');
  assert.throws(() => plugins.restoreOfficial('calendar'), /已经是官方版本/);
  assert.ok(plugins.knownPluginIds().has('email-imap-mine'));
});

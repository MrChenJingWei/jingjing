import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DB_PATH, SANDBOX_DIR } from '../src/config.js';

const targets = [
  DB_PATH,
  `${DB_PATH}-wal`,
  `${DB_PATH}-shm`,
  path.join(DATA_DIR, 'seed.json')
];

for (const file of targets) {
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}
if (fs.existsSync(SANDBOX_DIR)) fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });

console.log('已清空静静的数据。下次启动会重新生成演示数据。');

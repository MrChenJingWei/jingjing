// 测试结束时删临时目录。Windows 上同一个进程还开着里面的 SQLite 数据库，文件删不掉：留给系统清理，不算测试失败。
import fs from 'node:fs';

export function removeTemp(...dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      if (process.platform !== 'win32') throw err;
    }
  }
}

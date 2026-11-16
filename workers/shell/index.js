// 内置 Worker：文件操作。扫描工作区文件，确认后按类型归档。
import fs from 'node:fs';
import path from 'node:path';

const GROUPS = [
  { name: '文档', exts: ['.md', '.txt', '.doc', '.docx', '.pdf', '.rtf', '.pages'] },
  { name: '图片', exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.svg'] },
  { name: '压缩包', exts: ['.zip', '.rar', '.7z', '.tar', '.gz'] },
  { name: '表格', exts: ['.xlsx', '.xls', '.csv', '.numbers'] }
];

function groupOf(file) {
  const ext = path.extname(file).toLowerCase();
  return GROUPS.find((g) => g.exts.includes(ext))?.name || '其他';
}

function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

export function detect() {
  return { available: true, detail: '由主机账户权限决定' };
}

export async function execute(task, ctx) {
  const cwd = task.cwd ? path.resolve(task.cwd) : ctx.paths.sandbox;
  if (!fs.existsSync(cwd)) return { status: 'failed', retryable: false, summary: `目录不存在：${cwd}` };

  let entries = [];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch (err) {
    return { status: 'failed', retryable: false, summary: `读取目录失败：${err.message}` };
  }

  const groups = {};
  for (const name of entries) (groups[groupOf(name)] ||= []).push(name);

  if (ctx.resume) {
    const choice = ctx.resume.choice;
    if (choice < 0 || choice === 1) {
      return { status: 'cancelled', summary: `好，${entries.length} 个文件都原地不动。` };
    }
    if (choice === 2) {
      return { status: 'done', summary: '清单：\n' + entries.map((n) => `- ${n}`).join('\n') };
    }
    await ctx.emit('准备归档目录…');
    await ctx.sleep(300);
    let moved = 0;
    for (const [group, files] of Object.entries(groups)) {
      const dir = path.join(cwd, '归档', group);
      fs.mkdirSync(dir, { recursive: true });
      for (const name of files) {
        if (ctx.signal.aborted) return { status: 'cancelled', summary: `已停止，归档了 ${moved} 个文件。` };
        const from = path.join(cwd, name);
        const to = path.join(dir, name);
        if (!isInside(cwd, from) || !isInside(cwd, to)) continue;
        fs.renameSync(from, to);
        moved += 1;
      }
      await ctx.emit(`归档「${group}」：${files.length} 个文件`, { done: moved, total: entries.length });
      await ctx.sleep(200);
    }
    return {
      status: 'done',
      summary: `已归档 ${moved} 个文件到：\n` + Object.entries(groups).map(([g, f]) => `- 归档/${g}/（${f.length} 个）`).join('\n')
    };
  }

  if (!entries.length) return { status: 'done', summary: '目录是空的，不用整理。' };

  await ctx.emit(`扫描到 ${entries.length} 个文件`, { total: entries.length });
  await ctx.sleep(400);
  const preview = Object.entries(groups).map(([g, f]) => `${g} ${f.length} 个`).join('、');
  return {
    status: 'needs_approval',
    summary: `「${path.basename(cwd)}」里有 ${entries.length} 个文件（${preview}）。我可以按类型归档到 归档/ 下的子目录。`,
    approval: {
      question: `要把这 ${entries.length} 个文件按类型归档吗？`,
      options: ['归档', '先不动', '只列个清单']
    }
  };
}

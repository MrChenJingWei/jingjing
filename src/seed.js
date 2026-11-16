import fs from 'node:fs';
import path from 'node:path';
import { db, now, uid, getSetting, setSetting, event } from './db.js';
import { SANDBOX_DIR } from './config.js';
import { remember } from './memory.js';

function iso(offsetMinutes = 0) {
  return new Date(Date.now() + offsetMinutes * 60000).toISOString();
}

function seedSandbox() {
  const downloads = path.join(SANDBOX_DIR, '下载');
  fs.mkdirSync(downloads, { recursive: true });
  const files = {
    '会议纪要-1103.md': '# 11 月 3 日 产品周会\n\n- 确认静静第一版只做「任务闭环 + 记忆」\n- 下周三前给出移动端原型\n',
    '发票-2026-10.pdf': '（这是演示用的假 PDF）\n云端服务 10 月账单  ¥ 128.00\n',
    '产品截图.png': '（演示用图片占位）\n',
    '旧项目备份.zip': '（演示用压缩包占位）\n',
    '灵感.txt': '静静的声音不要做成客服腔。\n它应该像房间里另一个安静的人。\n'
  };
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(downloads, name);
    if (!fs.existsSync(full)) fs.writeFileSync(full, content);
  }
}

function seedMemories() {
  remember({
    text: '用户是静静的唯一主人，住在杭州，常用设备是 MacBook + iPhone。',
    layer: 'profile',
    kind: 'profile',
    tags: ['基础信息'],
    importance: 0.95,
    source: 'seed'
  });
  remember({
    text: '用户上午 9:30–12:00 的专注时间不希望被打断，需要拍板的事尽量放下午。',
    layer: 'profile',
    kind: 'preference',
    tags: ['时间', '专注'],
    importance: 0.85,
    source: 'seed'
  });
  remember({
    text: '用户偏好「先跑通最小闭环，再补抽象」的做法，不喜欢一开始就过度设计。',
    layer: 'profile',
    kind: 'preference',
    tags: ['工程习惯'],
    importance: 0.8,
    source: 'seed'
  });
  remember({
    text: '项目「静静」是用户自建的个人 AI 工作站：Router 做前台，调度器做挂起恢复，Worker 负责执行，记忆存在本机 SQLite。',
    layer: 'semantic',
    kind: 'project',
    tags: ['静静', '架构'],
    importance: 0.9,
    source: 'seed'
  });
  remember({
    text: '2026-11-11 的决定：调度器优先实现「挂起零消耗」，等人拍板时进程必须退出，不占机器也不烧 token。',
    layer: 'episodic',
    kind: 'decision',
    tags: ['调度器', '设计决策'],
    importance: 0.75,
    source: 'seed'
  });
}

function seedTasks() {
  const doneId = uid('t_');
  const doneAt = iso(-180);
  db.prepare(`
    INSERT INTO tasks(id, title, prompt, worker, cwd, status, priority, origin, result, tokens, created_at, updated_at, started_at, finished_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    doneId,
    '梳理静静的架构分层',
    '把 Router、调度器、Worker、记忆四层的边界写清楚。',
    'llm',
    SANDBOX_DIR,
    'done',
    2,
    'seed',
    '已收敛成四层：Router 负责判断该做哪件事，调度器负责把一件事安全跑完并在需要时挂起，Worker 是无状态执行器，记忆层横向支撑三层。',
    1860,
    iso(-200), doneAt, iso(-195), doneAt
  );
  event(doneId, 'task/created', { worker: 'llm', origin: 'seed' });
  event(doneId, 'task/started', { worker: 'llm' });
  event(doneId, 'task/done', { summary: '已收敛成四层结构。' });

  const waitId = uid('t_');
  const approvalId = uid('a_');
  const downloadDir = path.join(SANDBOX_DIR, '下载');
  db.prepare(`
    INSERT INTO tasks(id, title, prompt, worker, cwd, status, priority, origin, approval_id, result, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    waitId,
    '整理下载文件夹',
    '把沙箱里的「下载」目录按类型归档。',
    'shell',
    downloadDir,
    'waiting_approval',
    1,
    'seed',
    approvalId,
    '「下载」里有 5 个文件（文档 2 个、图片 1 个、压缩包 1 个、其他 1 个）。我可以按类型归档到 归档/ 下的子目录。',
    iso(-12), iso(-11)
  );
  db.prepare(`
    INSERT INTO approvals(id, task_id, question, options, status, created_at)
    VALUES(?,?,?,?, 'pending', ?)
  `).run(approvalId, waitId, '要把这 5 个文件按类型归档吗？', JSON.stringify(['归档', '先不动', '只列个清单']), iso(-11));
  event(waitId, 'task/created', { worker: 'shell', origin: 'seed' });
  event(waitId, 'task/started', { worker: 'shell' });
  event(waitId, 'task/waiting_approval', {
    approvalId,
    question: '要把这 5 个文件按类型归档吗？',
    options: ['归档', '先不动', '只列个清单']
  });

  return { doneId, waitId, approvalId };
}

function seedMessages(waitId) {
  const stamp = iso(-30);
  const greeting = [
    '我在。',
    '',
    '今天可以先把「下载」文件夹整理掉——它已经在等你拍板了。也可以直接告诉我你现在最想推进的那件事。'
  ].join('\n');
  db.prepare('INSERT INTO messages(id, session_id, role, text, kind, task_id, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(uid('msg_'), 'main', 'assistant', greeting, 'text', null, stamp);
  db.prepare('INSERT INTO messages(id, session_id, role, text, kind, task_id, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(
      uid('msg_'), 'main', 'assistant',
      '另外，我起了「整理下载文件夹」这个任务。它已经扫完了文件，需要你决定要不要归档。',
      'task', waitId, iso(-11)
    );
}

export function seed() {
  if (getSetting('seeded')) return false;
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  seedSandbox();
  seedMemories();
  const { waitId } = seedTasks();
  seedMessages(waitId);
  setSetting('seeded', true);
  console.log('[seed] 演示数据已就绪');
  return true;
}

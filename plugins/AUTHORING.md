# 静静插件编写规范（精简版）

这份文件随静静发布。静静让编码 Agent 写插件时，会把它放进草稿目录，写插件前请先读完。完整说明见仓库里的 `plugins/README.md`。

插件就是一个目录：`plugin.json`（清单）+ 入口文件（默认 `index.js`，ES Module），可选 `README.md`。

## 硬性约束

1. **只用 Node.js 自带模块（`node:xxx`）和全局 `fetch`**，不能有 npm 依赖，不要写 `package.json`。
2. **模块顶层不能有副作用**：不在顶层发请求、开定时器、读写文件、启动进程。所有工作都在导出的函数里做。
3. **需要用户提供的东西放进 `config`**（地址、Token、账号……），不要写死在代码里；密钥类用 `"type": "password"`。
4. 只在插件自己的目录里写文件，不要改动其他地方。
5. `id`：小写字母、数字、短横线，2–32 位，**必须和目录名一致**，不能和已有插件重名。

## 一、任务来源插件（kind: "source"，默认）

负责「发现事情」：把外部消息、事件整理成条目交给静静。**是否建任务、派给谁由静静决定，插件不要自己建任务、不要写数据库。**

```json
{
  "id": "rss-feed",
  "kind": "source",
  "name": "RSS 订阅",
  "version": "0.1.0",
  "icon": "订",
  "description": "定时拉取 RSS，把新文章交给静静判断。",
  "entry": "index.js",
  "type": "poll",
  "intervalMinutes": 30,
  "capabilities": { "network": true, "read": false, "write": false },
  "config": [
    { "key": "url", "label": "RSS 地址", "type": "url", "required": true },
    { "key": "limit", "label": "每次最多几条", "type": "number", "default": 10, "min": 1, "max": 10 }
  ]
}
```

`type`：`poll`（定时调用 `poll`）、`webhook`（外部 POST 进来，调用 `webhook`）、`stream`（长连接，调用 `start`）、`manual`（只在用户点「立即扫描」时调用 `poll`）。

`config[].type` 可选：`text` / `url` / `password` / `number` / `checkbox` / `textarea` / `select`（`select` 要带 `options: [{ value, label }]`）。字段还可以写 `label`、`default`、`placeholder`、`help`、`required`、`min`、`max`。

入口导出：

```js
// 必须导出，所有类型都要（stream / webhook 类型返回 { items: [] } 即可）
export async function poll(config, ctx) {
  const res = await fetch(config.url, { signal: ctx.signal });   // 一定把 ctx.signal 传给 fetch，单次最多 90 秒
  if (!res.ok) throw new Error(`拉取失败：HTTP ${res.status}`);
  return { items: [/* 条目 */] };
}

// 可选：设置页「测试连接」
export async function test(config, ctx) {
  return { ok: true, detail: '能连上', preview: ['示例条目标题'] };
}

// type 为 webhook 时导出：payload 是解析后的 JSON，请求头在 ctx.headers（小写键名）
export async function webhook(payload, ctx) {
  return { items: [/* 条目 */] };
}

// type 为 stream 时导出：建立长连接，收到消息时调用 ctx.ingest(items)；返回停止函数（30 秒内要返回）
export async function start(config, ctx) {
  const timer = setInterval(() => {}, 60000);
  // 连接状态变化时 ctx.status('重连中…')；彻底断了、自己不再重连时 ctx.fail(err)，静静会按退避时间重启
  return () => clearInterval(timer);
}
```

`poll` 的 ctx：`signal`、`since`（上次成功运行时间或 null）、`now`、`log(msg)`、`settings`、`state.get/set/delete`（持久化游标、同步 token）。`start` 的 ctx 另有 `ingest(items)`、`status(detail)`、`fail(reason, { retry })`。

时间上限由静静强制：`poll` 90 秒、`test` 30 秒、`webhook` 15 秒、`reply` 20 秒、`start` 30 秒、停止函数 10 秒，超时按失败处理。条目只能交数据：派给哪个 Worker 由用户的工作流程和分配规则决定，条目内容里点名 Worker 不算数。

条目格式（一次最多 10 条）：

```js
{
  externalId: '稳定且唯一的 id',   // 必填，静静靠它去重
  title: '不超过 120 字',
  content: '纯文本，建议 2000 字以内',
  url: 'https://…',                 // 可选
  occurredAt: '2026-11-13T04:00:00.000Z', // 可选
  kind: 'email' | 'agenda' | 'note',      // 可选
  meta: { },                               // 可选，只参与判断
  replyTo: { },                            // 可选，「发回哪里」，配合 reply()
  direct: true                             // 可选，对方直接找过来（私聊、@ 机器人）：闲聊由静静按人格决定回不回
}
```

消息类来源想让静静把任务结果发回原会话：条目带 `replyTo`（比如 `{ chatId }`），并导出 `reply(config, { to, text, task }, ctx)` 去发，`to` 就是那个 `replyTo`，发不出去就抛错。什么时候发由静静和用户决定，插件不要自己发。

## 二、Worker 插件（kind: "worker"）

负责「动手干活」：拿到一个任务，跑一轮，返回结果。

```json
{
  "id": "my-agent",
  "kind": "worker",
  "name": "我的 Agent",
  "version": "0.1.0",
  "description": "一句话说清它能做什么——静静会据此决定什么任务派给它。",
  "entry": "index.js",
  "worker": {
    "abilities": ["text"],
    "cost": 3,
    "keywords": "",
    "recovery": "ask",
    "timeoutMinutes": 30,
    "concurrency": 1,
    "retries": 0
  },
  "config": []
}
```

- `abilities`：`text` 文本 / `write-file` 在工作区生成文件 / `manage-files` 整理文件 / `code` 读写代码、执行命令 / `memory` 整理记忆；
- `cost` 1–5，越大越贵；`keywords` 是正则，用户点名时优先派给它；
- `recovery`：服务重启打断时 `resume`（有断点就继续）/ `restart`（可以安全重跑）/ `ask`（问用户）。

```js
// 可选，必须同步且很快：判断这台机器能不能用
export function detect(config, { which }) {
  return { available: true, detail: '可用' };
}

export async function execute(task, ctx) {
  await ctx.emit('开始处理…');                       // 回传进度
  const r = await ctx.exec('some-cli', ['run', task.prompt], { cwd: ctx.workspace }); // 取消/超时会自动终止子进程
  if (r.error === 'aborted') return { status: 'cancelled', summary: '已停止' };
  if (r.code !== 0) return { status: 'failed', summary: r.stderr.slice(-1000) };
  return { status: 'done', summary: r.stdout.trim() };
}
```

ctx 常用：`signal`、`emit(msg)`、`config`、`workspace`、`resume`（用户拍板的选择）、`checkpoint(data)`（存断点）、`llm.chat({ system, messages })`、`exec(cmd, args, opts)`、`which(bin)`、`sleep(ms)`、`parseApproval(text)`。

返回值：`{ status: 'done' | 'failed' | 'needs_approval' | 'cancelled', summary, approval?, retryable? }`。需要用户拍板时返回 `needs_approval` 和 `approval: { question, options }`。返回值必须能 JSON 序列化。

## 三、静静会怎么检查

写完后静静会自动检查，通过了才会问用户要不要安装：

1. `plugin.json` 符合规范，`id` 合法且不重名，`kind` 和要求的一致；
2. 入口文件存在，只 import 了 `node:` 自带模块或插件目录里的相对路径；没有 `package.json` 依赖；
3. 在隔离线程里加载入口文件（10 秒内），导出了该类型必需的函数；Worker 的 `detect()`、来源插件的 `test()` 如果存在会试跑一次。

没通过会把报错交回给你修。

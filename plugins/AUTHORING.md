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

`config[].type` 可选：`text` / `url` / `password` / `number` / `checkbox` / `textarea` / `select` / `folder` / `filters`（`select` 要带 `options: [{ value, label }]`；`folder` 是本机文件夹路径，界面上是文件夹选择器；`filters` 是一组筛选条件，见下面「按实例的筛选字段」）。字段还可以写 `label`、`default`、`placeholder`、`help`、`required`、`min`、`max`。

**按实例的筛选字段**：同一个插件的不同实例可能有完全不同的字段（比如每个 TAPD 项目的状态、迭代、自定义字段都不一样），`select` 写死的选项不够用。这时给配置加一个 `type: "filters"` 的字段，并导出 `filterFields(config, ctx)`：

```js
// 可选：设置页「筛选条件」从这里拿可选字段。config 是表单里当前的配置（可能还没保存）。
export async function filterFields(config, ctx) {
  return {
    fields: [
      { key: 'bug.status', label: '状态', group: '缺陷', input: 'enum', options: [{ value: 'new', label: '未解决' }] },
      { key: 'bug.current_owner', label: '处理人', group: '缺陷', input: 'user', help: '写「我」表示自己' }
    ]
  };
}
```

`input` 是 `enum`（从候选值里点选）、`user`（填人名）或 `text`（自由填写）。用户配好的条件存成 `config.<key> = [{ field: 'bug.status', values: ['new', 'reopened'] }]`，怎么翻译成来源自己的查询由插件决定；核心只做归一化（最多 12 个条件、每个最多 50 个值）。

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

时间上限由静静强制：`poll` 90 秒、`test` 30 秒、`webhook` 15 秒、`reply` 20 秒、`deliver` 15 秒、`start` 30 秒、停止函数 10 秒，超时按失败处理。条目只能交数据：派给哪个 Worker 由用户的工作流程和分配规则决定，条目内容里点名 Worker 不算数。

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
  direct: true,                            // 可选，对方直接找过来（私聊、@ 机器人）：闲聊由静静按人格决定回不回
  actor: { id: 'zhangsan', name: '张三' }  // 可选，这条是谁说的 / 谁做的：静静靠它认人。id 在这个来源里稳定唯一，name 可以不给
}
```

认人（可选）：条目带 `actor`，派活的、直接找静静的人会记进「认识的人」。来源有通讯录时再导出 `lookupPeople(config, ids, ctx)`：`ids` 是 `actor.id` 的数组，返回 `{ people: [{ id, name, title?, department?, alias? }] }`，查不到的不返回、没配凭证返回空。新认识的人马上查一次，之后每天刷新，一批最多 50 个、30 秒超时；抛错下一小时重试。

消息类来源想让静静把任务结果发回原会话：条目带 `replyTo`（比如 `{ chatId }`），并导出 `reply(config, { to, text, task }, ctx)` 去发，`to` 就是那个 `replyTo`，发不出去就抛错。什么时候发由静静和用户决定，插件不要自己发。想让回执、状态播报、拍板卡片也回到渠道里，改为导出 `deliver(config, payload, ctx)`，渠道里的按钮和回复用 `ctx.interact()` 转给静静，见 README.md「消息类来源」。

### 归类（可选）：交外部对象树

外部系统里有「上级」概念（需求下挂缺陷、Epic 下挂 Story）的来源，可以让静静把卡自动归到上级下面、并按上级积累知识。完整说明见 `docs/architecture/external.md`「插件怎么接」。插件只交事实，切哪层、怎么显示都由静静决定。

1. manifest 里声明：

```json
"classification": {
  "tree": true,
  "nodeTypes": ["story", "bug"],
  "nodeLabels": { "story": "需求", "bug": "缺陷" },
  "defaultGroupAt": { "type": "story" }
}
```

`nodeTypes` 不能有项目 / 空间级类型（`project`、`workspace`……），项目由 `node.workspace` 表达。`defaultGroupAt` 是 `{ type }`（从卡自己开始找第一个这个类型的）或 `{ levels, anchor? }`。**声明不等于启用**：每个实例默认关，用户在设置 → 归类与知识里打开。

2. 条目（和 `syncStatus` 的返回项）多交三个字段：

```js
{
  node:   { workspace: '33349361', type: 'bug', id: '123', title: '登录闪退', url: 'https://…' }, // 必填
  parent: { type: 'story', id: '456', title: '登录改造' } | null,  // 唯一主父；null = 没有上级 / 不知道
  links:  [{ kind: 'related', to: { type: 'story', id: '789' } }]   // 可选，最多 8 条
}
```

- 只有一个上级：给 `parent`；
- 多个上级但来源有「主」的概念：给主的那个，其余进 `links`；
- 多个上级且没有主：`parent: null` + `links`，静静会请用户选一个。**不要自己挑一个凑数**；
- 这次没查到父（接口失败、预算用完）：不写 `parent` 字段（`undefined`），静静保留已知的父；
- `ctx.classify` 是这个实例的归类状态（`off` / `observing` / `on`），为 `off` 时可以跳过查上级的额外调用。

这些字段只影响归类，不影响派给哪个 Worker、在哪个工作区、要不要执行。参考实现：`plugins/tapd/index.js` 的 `attachTrees`。

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

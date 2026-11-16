# 写一个任务来源插件

静静把「从哪里发现事情」和「发现之后怎么处理」拆开了：

- **插件**只负责拉取和整理外部数据，交出条目；
- **核心**（`src/discovery.js`）负责去重、判断、建任务、写回对话。

所以邮箱、日历、RSS、GitHub 通知都可以是彼此独立、可开关、可替换的插件，而不是写死在 Router 里。

## 安装位置

所有插件都在数据目录，目录名必须等于 manifest 的 `id`：

| 版本 | 目录 |
| --- | --- |
| 命令行 | `data/plugins/` |
| App | `~/Library/Application Support/Jingjing/plugins/` |

安装包里的 `plugins/` 只是**种子**：首次启动会把随包发布的插件复制到数据目录，之后不再区分内置和外部。所有插件都可以编辑、停用、删除；删掉后不会因为重启又出现。

不需要重新打包项目。在设置 → 任务来源插件 →「安装插件」上传一个 zip 即可：

```
my-source.zip
└── my-source/          # 顶层目录名不要求和 id 一致，安装后会按 id 重命名
    ├── plugin.json
    └── index.js
```

zip 里也可以直接放 `plugin.json` + 入口文件，不带顶层目录。安装后插件默认停用，点进详情填配置再启用；所有插件都有「删除插件」。

加载失败会在设置页显示原因，不再只写控制台。

## 来源类型

| type | 触发方式 | 频率配置 |
| --- | --- | --- |
| `poll` | 核心按间隔调用 `poll()` | 每个插件单独设置 1–1440 分钟，默认取 manifest |
| `webhook` | 外部 POST 到 `/api/hooks/<token>` | 事件驱动，没有轮询间隔 |
| `stream` | 插件 `start()` 建立长连接 | 常驻连接，由 SDK/插件负责心跳和重连 |
| `manual` | 只在设置页点「立即扫描」 | 不自动运行 |
| `watch` | 预留：本地文件变化 | 暂未实现 |

旧的 `webhook: true` / `lifecycle: true` 会自动推导为对应类型；新插件建议直接写 `type`。

轮询频率不是全局的：manifest 里的 `intervalMinutes` 只是默认值，设置页每个来源卡片有独立的「获取频率」，保存在 `source_plugins.interval_minutes`，只影响该来源。

## 规范检查

仓库里有两样东西帮你写对：

- `plugins/plugin.schema.json`：manifest 的 JSON Schema，编辑器可以据此补全和报错；
- `plugins/.template/`：最小插件模板。

开发随包发布的种子插件时复制模板：

```bash
cp -R plugins/.template plugins/my-source
# 把 plugin.json 里的 id/name 改成你的，然后校验
npm run plugin:check
```

写第三方插件时可以在任意临时目录开发、校验，再打成 zip 从界面安装。

`plugin:check` 会检查：

- `plugin.json` 能否解析；
- id 格式、目录名是否一致、是否重复；
- entry 是否在目录内、文件是否存在；
- 入口是否导出了 `poll()`，`test` 是否是函数；
- config 字段的类型、select 的 options、默认值是否合法。

失败时退出码为 1，适合放进 CI。

## plugin.json

```json
{
  "$schema": "../plugin.schema.json",
  "id": "rss",
  "apiVersion": 1,
  "name": "RSS 订阅",
  "version": "0.1.0",
  "icon": "讯",
  "description": "订阅一个 RSS / Atom 地址，把新文章交给静静判断。",
  "entry": "index.js",
  "intervalMinutes": 30,
  "capabilities": { "network": true, "read": true, "write": false },
  "config": [
    {
      "key": "url",
      "label": "Feed 地址",
      "type": "url",
      "placeholder": "https://example.com/feed.xml",
      "required": true
    },
    {
      "key": "keywords",
      "label": "只关注这些关键词（逗号分隔）",
      "type": "text"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 小写字母/数字/短横线，唯一；也是去重时的 `source` |
| `apiVersion` | 目前固定为 `1` |
| `type` | `poll` / `webhook` / `stream` / `manual` / `watch`；默认从 webhook/lifecycle 推导 |
| `intervalMinutes` | 轮询型插件的**默认**间隔；用户可在设置页单独覆盖 |
| `webhook` | 为 `true` 时核心生成 `POST /api/hooks/<token>`，并调用插件的 `webhook()` |
| `lifecycle` | 为 `true` 时启用插件会调用 `start()`，停用/保存配置会调用 `stop()` |
| `multiInstance` | 为 `true` 时，同一个插件可以创建多份独立配置（多个邮箱、多个日历、多个机器人） |
| `capabilities` | 只用于界面展示和审阅，核心不强制 |
| `config` | 设置页自动生成表单；`type` 支持 `text` / `url` / `password` / `number` / `checkbox` / `textarea` / `select` |

`password` 类型的值在 API 和界面里会被打码，保存时回传打码值表示「不修改」；**数据库里仍然是明文**，不要存无关的高权限凭证。

运行时还会做这些校验：

- 目录名和 `id` 必须一致；
- `intervalMinutes` 是 1–1440 的整数；
- `entry` 不能是绝对路径或包含 `..`；
- `config` 最多 40 个字段，key 只允许字母/数字/下划线；
- manifest 顶层和 config 字段里的未知字段会被拒绝（防止拼写错误静默生效）；
- `select` 必须有非空 `options`，默认值必须在 options 里；
- `number` 的 `min` 不能大于 `max`，默认值必须在范围内。

来源插件在设置页还有一个**任务工作区**下拉框，这不是 manifest 字段，而是静静提供的核心配置：任务创建时会用该工作区的目录作为 `cwd`；没绑定就跟随默认工作区。工作区路径由用户在主机上用原生文件夹选择器添加，可以配置多条；它只决定起点，不是权限边界。

**保存配置时**会按字段类型归一化：数字转 number、复选框转 boolean、未知字段被丢弃、URL 只接受 http/https。

**启用插件时**会要求所有 `required` 字段非空；只保存不启用则允许先留空。

## index.js

```js
export async function test(config) {
  const res = await fetch(config.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
  return { ok: true, detail: `可以访问，共 ${(await res.text()).length} 字节` };
}

export async function poll(config, ctx) {
  const res = await fetch(config.url, { signal: ctx.signal });
  if (!res.ok) throw new Error(`拉取失败：HTTP ${res.status}`);
  const xml = await res.text();

  // 示意：真实项目请用 XML 解析器，别用正则硬解
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10).map((match, index) => {
    const title = (match[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || `条目 ${index + 1}`;
    return {
      externalId: `${config.url}#${title}`,
      kind: 'note',
      title,
      content: match[1].replace(/<[^>]+>/g, ' ').slice(0, 1500),
      meta: { url: config.url },
      occurredAt: new Date().toISOString()
    };
  });

  return { items };
}
```

`poll(config, ctx)` 的 `ctx`：

| 字段 | 说明 |
| --- | --- |
| `settings` | 当前全局设置（模型、时区等） |
| `now` | 本次运行时间（`Date`） |
| `since` | 上次成功运行时间（ISO 字符串或 `null`） |
| `signal` | 90 秒超时用的 `AbortSignal`，请传给 `fetch` |
| `log(message)` | 写进服务日志，便于排查 |

`test(config)` 可选。返回 `{ ok, detail, preview? }`，`preview` 是字符串数组，会显示在设置页。

## 入站 Webhook

除了轮询（`poll`），插件还可以声明自己接收推送：

```json
{
  "webhook": true
}
```

入口额外导出一个 `webhook(payload, ctx)`：

```js
export async function webhook(payload, ctx) {
  return {
    items: [{
      externalId: payload.id,
      title: payload.title,
      content: payload.message,
      url: payload.url,
      occurredAt: payload.timestamp
    }]
  };
}
```

核心会自动：

1. 为插件生成一个地址：`POST /api/hooks/<token>`；
2. 在插件详情页显示这个地址，可复制；
3. 收到 POST 后调用插件的 `webhook()`，再把返回的条目交给 `ingestItems()` 去重、判断、建任务；
4. 插件只需要把外部 payload 转成通用条目，不需要轮询，也不需要自己建任务。

`payload` 是解析后的 JSON；解析失败时是 `{ text: "原始文本" }`。请求头通过 `ctx.headers` 传入（小写键名），可以据此判断 `x-github-event` 等事件类型。

随包的 Webhook 插件是参考实现，能自动识别：

- GitHub：`repository.full_name`、`issue.title`、`html_url`、`x-github-delivery`；
- 通用 JSON：`title` / `subject` / `name`、`message` / `body` / `text`、`url` / `link`、`id` / `delivery`、`created_at` / `timestamp`。

启用后在详情页复制地址，直接测试：

```bash
curl -X POST 'http://<主机地址>:7777/api/hooks/<token>' \
  -H 'Content-Type: application/json' \
  -d '{"id":"alert-1","title":"服务器告警","message":"磁盘占用 92%","url":"https://example.com/alert/1"}'
```

注意：

- 这是**公开入口**，鉴权完全依赖地址里的随机 token，不要再套主配对码；
- 外部服务必须能访问到主机地址，局域网 IP 只适合内网；跨网络用 Tailscale 或 HTTPS 反向代理；
- 目前没有 HMAC 签名校验和 token 轮换按钮，不要把这个地址贴到公开仓库；
- 请求体上限 1MB，只接受 POST；处理是同步的，LLM 判断慢时外部服务可能会重试，`externalId` 会负责去重。

## 长连接插件

有些来源不是轮询，也不是 HTTP 回调，而是由插件主动建立一条长连接（企业微信智能机器人、Slack Socket Mode 等）。这类插件声明：

```json
{
  "lifecycle": true
}
```

并导出 `start(config, ctx)`，返回一个停止函数（或导出 `stop()`）：

```js
export async function start(config, ctx) {
  const client = await connectSomething(config);
  client.on('message', async (message) => {
    const result = await ctx.ingest([{
      externalId: message.id,
      title: '新消息',
      content: message.text
    }]);
    console.log('建了', result.created, '个任务');
  });
  return () => client.close();
}
```

`ctx` 提供：

| 字段 | 说明 |
| --- | --- |
| `ingest(items)` | 把条目交给核心去重、判断、建任务；返回 `{scanned, created, details}` |
| `log(msg)` | 写入服务日志 |
| `settings` | 全局设置 |
| `instanceId` / `pluginId` | 当前实例 id 和插件 id |
| `state.get(key, fallback)` | 读取当前实例的持久化状态（IMAP UID、syncToken 等） |
| `state.set(key, value)` | 写入当前实例状态，JSON 持久化到 SQLite |
| `state.delete(key)` | 删除状态 |

生命周期：

- 启用插件 → 核心调用 `start()`；
- 停用、保存配置、重新加载 → 核心先调用停止函数；
- 服务重启 → 所有已启用的 lifecycle 插件自动重新启动；
- `start()` 抛错或 15 秒内没有连上，插件状态会显示为错误，不会影响其他插件。

`poll()` 仍然必须导出，长连接插件返回 `{ items: [] }` 即可。

### 多实例

声明 `multiInstance: true` 后，同一个插件可以创建多份实例。每份实例有独立的：

- 配置和启用状态；
- 获取频率；
- 任务工作区；
- Webhook token（Webhook 类型）；
- `ctx.state` 和运行历史。

实例 id 形如 `email-imap~a1b2c3d4`；`pluginId` 仍是 `email-imap`。插件代码不用感知实例数量，核心会为每个实例单独调用 `poll()` / `start()` / `webhook()`。

### 状态与运行历史

核心提供 `plugins.plugin_state` 和 `plugin_runs`：

- `ctx.state` 用于游标、同步 token、上次扫描位置；
- 每次轮询记录开始/结束时间、状态、扫描条数、建任务数、错误和耗时；
- 连续失败会自动指数退避，成功一次后恢复；
- Web 插件详情页可以查看最近运行历史。

Webhook 的 `ctx` 还包含 `rawBody`、`headers`、`query`，方便插件做签名校验（安全功能尚未启用）。

企业微信的具体用法见 [docs/WECOM.md](WECOM.md)。

## 条目格式

```js
{
  externalId: 'message-id-or-uid', // 必须稳定，核心靠它去重
  kind: 'email' | 'agenda' | 'note',
  title: '不超过 120 字',
  content: '纯文本，建议 <= 2000 字',
  url: 'https://example.com/item/1',
  occurredAt: '2026-11-13T04:00:00.000Z',
  meta: { from: '...' }
}
```

- 一次最多交 10 条，核心会截断。
- `externalId` 相同就不会重复建任务。
- `kind=agenda` 会被当作「需要准备」的事项；`email` / `note` 交给判断层；
- `url` 和 `occurredAt` 会随条目持久化到 `source_items`，可用来回溯；`meta` 只参与判断，不持久化；
- 插件**只负责取数据和整形**，不能指定 Worker、优先级、任务模板、是否自动执行或是否需要审批——这些行为全部由静静决定；
- 插件不要自己建任务、不要写数据库、不要直接改界面；
- 单次 `poll()` 超过 90 秒会被中止；请把 `ctx.signal` 传给 `fetch`。

## 哪些行为由静静控制

| 行为 | 由谁决定 |
| --- | --- |
| 拉取频率、超时 | 静静（每个来源单独配置，manifest 的 `intervalMinutes` 是默认值） |
| 去重键、已读/跳过 | 静静 |
| 是否建任务、任务标题、Worker、优先级 | 静静（模型判断 + 本文规则） |
| 任务在哪个工作区执行 | 静静（来源插件在设置页绑定的工作区） |
| 是否等你审批、任务何时执行 | 静静 |
| 配置表单长什么样 | 静静按 manifest 的 `config` 渲染 |
| 下拉、数字、必填校验 | 静静 |
| 插件返回哪些数据字段 | 插件（只能是通用数据） |

插件不提供自定义 UI、自定义按钮或自己的调度逻辑；需要新行为时，应该改静静的核心，而不是在插件里绕过。

## 核心会怎么处理

1. 过滤已见过的 `externalId`；
2. 把新条目批量交给模型判断：要不要行动、优先级、任务标题、执行提示；
3. 模型不可用时退回关键词规则；
4. 需要行动的建任务（Worker 默认 `llm`），并在主对话里留一条汇总；
5. 不需要行动的记为 `skipped`，不打扰你；
6. 更新插件的「上次运行 / 结果 / 错误」，设置页可见。

## 安全边界

- 插件是**在服务进程内运行的普通 Node 模块**，拥有完整文件与网络权限，没有沙箱。只安装你自己写的或信得过的插件。
- 安装 zip 会拒绝绝对路径和 `..` 路径，但不会做代码签名；安装即信任。
- 配置存在本机 SQLite；密码字段只是界面打码，不是加密存储。
- 插件看到的邮件/日程内容，只有在需要判断时才会以摘要形式发给模型（如果你用的是云端模型）。不能接受就切到 Ollama，或不用插件。

## 调试

```bash
# 跑核心测试（含本地 mock IMAP、插件规范）
npm test

# 只检查插件规范
npm run plugin:check

# 看插件日志
tail -f data/logs/server.log
```

开发时可以在设置页点「测试连接」和「立即扫描」，比等轮询快。


## Worker 插件

Worker 插件和来源插件共用安装/删除机制，但 manifest 用 `kind: "worker"`：

```json
{
  "id": "my-worker",
  "kind": "worker",
  "name": "我的 Agent",
  "entry": "index.js",
  "config": [{ "key": "bin", "label": "CLI 路径", "type": "text" }]
}
```

入口导出：

```js
export function detect(config) {
  return { available: true, detail: '已检测到 CLI' };
}

export async function execute(task, ctx) {
  return { status: 'done', summary: '执行结果' };
}
```

`detect`、`test` 可选；`execute` 必须返回结果对象。配置按 Worker id 存在 `worker_configs`，每个主机可以不同。内置 Worker 删除后可用「恢复内置 Worker」恢复。

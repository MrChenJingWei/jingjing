# 写一个任务来源插件

静静把「从哪里发现事情」和「发现之后怎么处理」拆开了：

- **插件**只负责拉取和整理外部数据，交出条目；
- **核心**（`src/discovery.js`）负责去重、判断、建任务、写回对话。

所以邮箱、日历、RSS、GitHub 通知都可以是彼此独立、可开关、可替换的插件，而不是写死在 Router 里。

## 官方插件和「我的」插件

插件有两个来源，目录名都必须等于 manifest 的 `id`：

| | 目录 | 谁维护 | 更新 |
| --- | --- | --- | --- |
| **官方** | App 里的 `plugins/<id>/`（仓库里同名目录） | 项目维护者 | 随静静在线升级，只读 |
| **我的** | 数据目录的 `plugins/<id>/`：命令行是 `data/plugins/`，App 是 `~/Library/Application Support/Jingjing/plugins/` | 用户自己 / 让静静写的 | 升级永远不会覆盖 |

- 官方插件只能启用 / 停用，不能删也不能直接改；想改就点「复制为我的插件」，得到一个新 id（`<id>-mine`）的副本，随便改。
- 「我的」里出现和官方**同 id** 的插件时，加载「我的」那份（覆盖官方），设置页会标出「覆盖了官方版本」，官方版本更新时提示「官方有更新」；点「恢复官方版本」会把你那份挪到 `plugins/.migrated/` 备份，实例配置保留。
- 旧版本会在第一次启动时把官方插件复制到数据目录。升级后会迁移一次：没改过的副本挪到 `plugins/.migrated/` 备份并改用官方版本，改过的保留、当作覆盖官方的「我的」插件。

### 维护官方插件

- 不需要 npm 依赖的插件直接放在仓库的 `plugins/<id>/`；
- 需要依赖的插件源码放在 `plugin-src/<id>/`（带 `package.json`、`package-lock.json`），运行 `npm run plugins:build -- <id>`，会用 esbuild 把代码和依赖打成单个文件输出到 `plugins/<id>/`，并写入 `BUILD.json`（源码指纹）。**源码和产物一起提交**，用户机器上不需要 `npm install`；
- CI 会跑 `npm run plugin:check`（清单规范）和 `npm run plugins:check-built`（产物是否和源码一致）；
- 新增或修改官方插件后发版，用户在线升级就能拿到。

### 让静静写插件

对静静说「写一个拉取 RSS 的来源插件」「做一个调用 aider 的 Worker 插件」，或者在插件页 / Worker 页点「让静静写一个」：

1. 静静先看官方有没有类似的，有就提示你直接用官方的（明确说「另写一个」才继续）；
2. 在数据目录的 `plugin-drafts/<草稿 id>/` 准备草稿：模板 + `plugins/AUTHORING.md`（精简规范）+ JSON Schema；
3. 交给能写代码的 Worker（Claude Code、Codex……，允许它在草稿目录里直接改文件）去写；没有编码 Worker 但接了云端模型时，让模型直接生成文件；
4. 自动检查：清单规范、id 不重名、**只用 Node 自带模块和 fetch**（不能有 npm 依赖）、在隔离线程里加载入口并试跑 `detect()` / `test()`；没通过就把报错交回去修，最多 3 轮；
5. 通过后在对话里发卡片，列出它做什么、需要哪些权限和配置，可以「查看代码」；**只有你点「安装」才会装进「我的」插件**。来源插件装上后默认停用，填好配置再启用。

插件和静静跑在同一个进程里、拥有你的账户权限，所以安装这一步必须由人确认。

## 手动安装

不需要重新打包项目。在设置 → 任务来源 →「安装插件」上传一个 zip 即可：

```
my-source.zip
└── my-source/          # 顶层目录名不要求和 id 一致，安装后会按 id 重命名
    ├── plugin.json
    └── index.js
```

zip 里也可以直接放 `plugin.json` + 入口文件，不带顶层目录。zip 装进「我的」插件，默认停用，点进详情填配置再启用；「我的」插件都可以删除。

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

每个入口都有时间上限，到点由静静强制按失败处理，不等插件理会 `signal`：

| 入口 | 上限 |
| --- | --- |
| `poll()` | 90 秒 |
| `test()` | 30 秒 |
| `webhook()` | 15 秒 |
| `reply()` | 20 秒 |
| `start()` | 30 秒 |
| 停止函数 / `stop()` | 10 秒 |

超时后插件那边的调用不会被杀掉，只是结果被丢弃；所以仍然要把 `signal` 传给 `fetch`，别让请求一直挂着。

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
3. 收到 POST 后调用插件的 `webhook()`，拿到条目就回应 `200 {"ok":true,"accepted":<条数>}`；去重、判断、建任务在后台做，不让发送方等模型；
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
- 请求体上限 1MB，只接受 POST；`webhook()` 返回后立即回应，模型判断在后台做。外部服务重发同一条时，`externalId` 会负责去重（判断途中重发也不会建出两个任务）。

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
  client.on('reconnecting', (n) => ctx.status(`重连中（第 ${n} 次）`));
  client.on('reconnected', () => ctx.status('已连接'));
  client.on('gaveUp', (err) => ctx.fail(err));   // 插件自己不再重连了：交给静静重启
  return () => client.close();
}
```

`ctx` 提供：

| 字段 | 说明 |
| --- | --- |
| `ingest(items)` | 把条目交给核心去重、判断、建任务；返回 `{scanned, created, details}` |
| `status(detail)` | 连接正常，更新设置页上的状态说明（比如「已连接」「重连中（第 2 次）」） |
| `fail(reason, { retry })` | 连接彻底断了、插件自己不会再重连时调用。静静会调用停止函数，然后按退避时间自动重启（30 秒起，每次翻倍，最长 30 分钟；稳定跑满 5 分钟后退避清零）。`retry: false` 表示重连也没用（比如被别处的登录顶掉），停在错误状态等用户处理 |
| `log(msg)` | 写入服务日志 |
| `settings` | 全局设置 |
| `instanceId` / `pluginId` | 当前实例 id 和插件 id |
| `state.get(key, fallback)` | 读取当前实例的持久化状态（IMAP UID、syncToken 等） |
| `state.set(key, value)` | 写入当前实例状态，JSON 持久化到 SQLite |
| `state.delete(key)` | 删除状态 |

生命周期：

- 启用插件 → 核心调用 `start()`；
- 停用、保存配置、重新加载 → 核心先调用停止函数；
- 服务重启 → 所有已启用的 lifecycle 插件并行重新启动，不等它们连上，服务先起来；
- `start()` 抛错或 30 秒内没有返回，插件状态显示为错误，并按上面的退避时间自动重试，不会影响其他插件。超时后 `start()` 才连上的，静静会立刻调用停止函数关掉它；
- 停掉以后，旧连接迟到的 `ingest` / `status` / `fail` 一律忽略。

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
  meta: { from: '...' },
  replyTo: { chatId: '...' },      // 可选：任务结果发回哪里（配合导出的 reply()）
  direct: true                     // 可选：对方直接找过来的消息（私聊、群里 @ 机器人）
}
```

- 一次最多交 10 条，核心会截断。
- `externalId` 相同就不会重复建任务。
- `kind=agenda` 会被当作「需要准备」的事项；`email` / `note` 交给判断层；
- `direct: true` 表示对方直接找过来（私聊、群里 @ 机器人）：要办的事照常建任务；闲聊、打招呼这类不建任务，也不直接丢掉，由静静按设置里的人格决定回不回（要开这个来源的「自动发回」，并且插件导出了 `reply()`，回复时 `task` 为 `null`）。这类条目在 `ingest` 的结果里 `status` 为 `chat`。群里没 @ 的消息、通知、邮件不要标；
- `url` 和 `occurredAt` 会随条目持久化到 `source_items`，可用来回溯；`meta` 只参与判断，不持久化；
- 插件**只负责取数据和整形**，不能指定 Worker、优先级、任务模板、是否自动执行或是否需要审批——这些行为全部由静静决定；
- 插件不要自己建任务、不要写数据库、不要直接改界面；
- 单次 `poll()` 超过 90 秒会被中止；请把 `ctx.signal` 传给 `fetch`。

## 把任务结果发回原会话（可选）

消息类来源（企微、Slack、邮件……）可以让静静把任务结果发回给发消息的人：

1. 条目带上 `replyTo`：插件自己认识的「发回哪里」，比如 `{ chatId }`。不超过 2000 字符的 JSON，静静原样存在任务上、原样交回；
2. 导出 `reply(config, { to, text, task }, ctx)`：`to` 就是那个 `replyTo`，`text` 是要发的内容（可能很长，按渠道的长度限制自己截断），`task` 是 `{ id, title }`。发不出去就抛错，错误信息会显示给用户。长连接插件可以借 `start()` 建好的连接发；
3. 什么时候发由静静决定：
   - 完成的任务上有「发回原会话」按钮，用户可以先改再发；
   - 插件设置页有「任务完成后自动发回原会话」开关，**默认关闭**。打开后任务一完成就发，交给 Worker 的指令里会注明「结果会原样发回，直接写给对方」。

插件不要自己决定什么时候回消息（收到时回一句「收到」这种回执除外）。

## 哪些行为由静静控制

| 行为 | 由谁决定 |
| --- | --- |
| 拉取频率、超时 | 静静（每个来源单独配置，manifest 的 `intervalMinutes` 是默认值） |
| 去重键、已读/跳过 | 静静 |
| 是否建任务、任务标题、优先级 | 静静（模型判断 + 本文规则） |
| 交给哪个 Worker | 你（工作流程、分配规则；都没命中就用开销最低的文本 Worker） |
| 任务在哪个工作区执行 | 静静（来源插件在设置页绑定的工作区） |
| 是否等你审批、任务何时执行 | 静静 |
| 配置表单长什么样 | 静静按 manifest 的 `config` 渲染 |
| 下拉、数字、必填校验 | 静静 |
| 插件返回哪些数据字段 | 插件（只能是通用数据） |

插件不提供自定义 UI、自定义按钮或自己的调度逻辑；需要新行为时，应该改静静的核心，而不是在插件里绕过。

## 核心会怎么处理

1. 过滤已见过的 `externalId`（先占位再判断，判断途中同一条再进来也算见过）；
2. 把新条目批量交给模型判断：要不要行动、优先级、任务标题、执行提示、属于哪个工作流程；
3. 模型不可用时退回关键词规则；
4. 需要行动的建任务。**外部来源的条目不能自己指定 Worker**：消息里点名的（「用 deepseek 查一下」）、模型挑的、按文字推断出的能力都不算，只认你配置的——工作流程指定的 Worker > 分配规则 > 开销最低的文本 Worker。工作流程先用原消息匹配触发词，没命中再看模型挑的流程（只能在你配好的流程里选）和模型改写的任务名。比如企微群里有人 @ 机器人说「用 deepseek 查蓝马的 bug」，而你的「查 bug」流程配了 Claude Code，那就交给 Claude Code。只有你自己在对话里（Web、配对的 Telegram）才能点名 Worker。主对话里的汇总会写明交给了谁、按哪个流程或规则；
   - 流程和分配规则都没命中，但消息**点名了一个本机可用的 Worker**（按它声明的 `keywords`，比如「用 codex 查本地代码」），或**明显需要默认 Worker 没有的能力**（只认强信号：代码、仓库、git、生成文件……；「测试」「删除」这类日常用语不算）：任务建好先停在拍板，不执行，问你交给谁——「交给 Codex / 以后这类都交给 Codex / 只用问答回文字 / 不处理」。选「以后这类都交给它」会建一条只管这个来源的分配规则（点名的按 Worker 的 `keywords`，能力的按触发的那个词），同类消息下次直接交过去、不再问；规则可以在「设置 → Worker」里改或删。这个判断全靠关键词，不调模型；
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

Worker 是执行器：拿到一个任务，跑一轮，返回结果。它和来源插件共用安装/删除机制，manifest 用 `kind: "worker"`。

**内置 Worker 也是这种插件包**：`问答`、`文件生成`、`文件操作`、`Claude Code`、`Codex`、`DeepSeek Harness` 都在仓库的 `workers/<id>/` 里，和你写的 Worker 插件走同一个加载器、同一份规范、同一个 `ctx`。想看完整例子直接读它们；新插件可以从 `plugins/.template-worker/` 复制。

| | 内置 Worker | Worker 插件 |
| --- | --- | --- |
| 位置 | `<app>/workers/<id>/`，随在线升级更新 | `<数据目录>/plugins/<id>/` |
| 停用 | 设置里关掉开关，仍留在列表里 | 同左 |
| 删除 | 不能删除 | 文件和配置一起删除 |
| id 冲突 | — | 不能和内置 Worker 同名 |

### plugin.json

```json
{
  "id": "my-worker",
  "kind": "worker",
  "name": "我的 Agent",
  "description": "一句话说清它能做什么——Router 会把这段描述交给模型来挑 Worker。",
  "entry": "index.js",
  "worker": {
    "abilities": ["code", "write-file", "text"],
    "cost": 3,
    "keywords": "my-agent|我的agent",
    "recovery": "ask",
    "timeoutMinutes": 30,
    "concurrency": 1,
    "retries": 0
  },
  "config": [{ "key": "bin", "label": "CLI 路径", "type": "text" }]
}
```

`worker` 段可以整段省略，全部取默认值：

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `abilities` | `["text"]` | 能做什么，Router 只按能力派活。可选：`text` 文本问答 / `write-file` 在工作区生成文件 / `manage-files` 整理移动文件 / `code` 读写代码仓库、执行命令。记忆是静静内置的功能，不是 Worker 能力 |
| `cost` | `3` | 相对开销 1–5。多个 Worker 都具备所需能力时，选开销最低的（同开销内置优先） |
| `keywords` | `""` | 正则（忽略大小写）。任务文本命中时优先派给它，比如用户说「发到飞书」就交给飞书 Worker |
| `recovery` | `"ask"` | 服务重启打断执行后怎么还原：`resume` 带着断点（`ctx.checkpoint` 存的）继续，没有断点按 `ask`；`restart` 直接重跑（只读或结果可覆盖时用）；`ask` 先问用户「重新执行 / 放弃」。同一任务连续被打断 3 次会停下 |
| `timeoutMinutes` | `30` | 超过就中止，任务标记失败，**不自动重试** |
| `concurrency` | `2` | 这个 Worker 最多同时跑几个任务（1–4），同时受全局并发上限约束 |
| `retries` | `0` | 失败后自动重试几次（0–3）。对外部有副作用或很贵的 Agent 建议保持 0 |

`timeoutMinutes` / `concurrency` / `retries` 只是默认值，用户可以在「设置 → Worker → 配置」里按主机覆盖。

### Router 怎么挑 Worker

下面是你在对话里（Web、配对的 Telegram）发消息时的顺序。来源插件发现的条目（邮件、企微、Webhook……）只走第 1、2、6 步：外人写的内容不能点名 Worker，也不让模型替它挑。

按顺序：

1. 命中用户的工作流程（或确认过的习惯）且流程指定了 Worker，就用流程的；
2. 用户的「Worker 分配规则」命中就用规则指定的；
3. 任务文本命中某个可用 Worker 的 `keywords`，交给它；
4. 云端模型判断时会看到每个 Worker 的 `name`、`description` 和 `abilities`，先按它的选择；
5. 文本明确需要某种能力（写文件、操作仓库、整理文件夹）而选中的 Worker 不具备时，改派给具备该能力、开销最低的可用 Worker；
6. 都没有就交给开销最低的 `text` Worker。

按工作流程派活时，流程步骤附在 `task.prompt` 末尾的 `---` 分隔线之后；Worker 判断「用户要求了什么」时只看分隔线之前的部分。

被点名的 Worker 在本机不可用时，对话回复里会说明改派给了谁。

### index.js

```js
export function detect(config, { settings, which }) {
  const bin = config.bin || which('my-agent');
  return bin ? { available: true, detail: bin } : { available: false, detail: '没有找到 my-agent' };
}

export async function execute(task, ctx) {
  await ctx.emit('已启动…');
  const r = await ctx.exec(ctx.config.bin || ctx.which('my-agent'), ['run', task.prompt], { cwd: ctx.workspace });
  if (r.error === 'aborted') return { status: 'cancelled', summary: '任务已停止。' };
  if (r.code !== 0) return { status: 'failed', summary: r.stderr.slice(-1200) };
  return { status: 'done', summary: r.stdout.trim() };
}
```

`execute` 必须导出；`detect(config, ctx)`、`test(config, ctx)` 可选，返回 `{ available, detail }`（也可以返回布尔值）。`detect` 每次刷新 Worker 列表都会调用，必须同步且足够快；耗时的连通性检查放进 `test`，它只在用户点「检测」时运行，可以是 async。`detect` / `test` 的 ctx 是 `{ settings, which, llm: { mode } }`。

**线程隔离**：第三方 Worker 插件的 `execute` 在独立的 Worker 线程里运行（内存上限 512MB）。同步死循环、内存泄漏只影响它自己的线程；任务被取消或超时后，宿主给 2 秒宽限，然后直接结束这个线程。所以：

- `execute` 的返回值必须能 JSON 序列化；
- 入口模块会在主线程（给 `detect` / `test` 用）和执行线程里各加载一次，模块顶层不要有副作用；
- 内置 Worker（`workers/` 里的）在主线程执行。

### ctx：宿主能力

Worker 只通过 `ctx` 使用宿主能力，不要 import 静静的核心模块。

| 字段 | 说明 |
| --- | --- |
| `signal` | `AbortSignal`。任务被取消或超时会触发，`signal.reason` 是 `'cancelled'` 或 `'timeout'` |
| `emit(message, meta?)` | 上报进度，显示在任务卡和对话里 |
| `log(message)` | 写服务日志 |
| `config` | 这个 Worker 在本机的配置（按 manifest 的 `config` 校验过） |
| `settings` | 静静的全局设置快照（只读），**不含**模型 Key 和通知通道凭据 |
| `secrets` | 只有内置 Worker 能拿到 `{ apiKey }`；第三方插件是 `{}` |
| `workspace` | 任务工作目录的绝对路径 |
| `paths.sandbox` | 静静的沙箱目录 |
| `resume` | 从审批恢复时是 `{ question, options, choice, answer? }`，`choice < 0` 表示用户取消；用户没选选项、自己写了决定时带 `answer`（同时追加在 `options` 末尾、`choice` 指向它）；否则为 `null` |
| `sessionId` | 上一轮返回的 `sessionId`，或断点里存的 `sessionId`，用于续跑 |
| `checkpoint(data)` | 存断点（合并进本次执行记录，最多 64KB），返回合并后的断点。存了 `sessionId` 会同步到 `ctx.sessionId` |
| `recovery` | 服务重启后带着断点恢复时是 `{ at, runId, checkpoint }`，否则为 `null` |
| `run` | 本次执行 `{ id, token, reportUrl }`，给外部进程回传用（见下文） |
| `memories` / `tasks` | 与任务相关的记忆、最近的任务板 |
| `workers` | 当前可用的 Worker 列表（`id`、`label`、`abilities`…） |
| `llm.mode` | `'demo'` / `'deepseek'` / `'ollama'` |
| `llm.chat({ system, messages, json, temperature, maxTokens })` | 调用用户配置的模型，自动跟随 `signal` 中止；返回 `{ text, tokens, cost }` |
| `exec(cmd, args, { cwd, env, onOutput, timeoutMs })` | 运行外部命令；`signal` 触发时自动 SIGTERM → SIGKILL 并返回 `{ error: 'aborted' }`。`env` 里值为 `null` 的键会被删除；子进程自动带上 `JINGJING_RUN_ID` / `JINGJING_RUN_TOKEN` / `JINGJING_REPORT_URL` |
| `which(bin)` | 在 PATH 和常见安装目录里找可执行文件 |
| `sleep(ms)` | 可被取消的等待 |
| `parseApproval(text)` | 解析输出末尾的 `[[APPROVAL]] {...}` 标记 |
| `estimateTokens(text)` | 粗略估算 token 数 |

### 回传进度

进度是 Worker 自己的能力：在进程内可以随时 `ctx.emit()`；外部进程（Agent CLI、脚本、远程服务的回调）用回传接口：

```bash
curl -X POST "$JINGJING_REPORT_URL" \
  -H "Authorization: Bearer $JINGJING_RUN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"正在编译 3/10","progress":{"done":3,"total":10},"checkpoint":{"step":3}}'
```

- 三个字段都可选：`message` 显示为进度，`checkpoint` 合并进断点，任何一次上报都算心跳；
- 令牌只对这一次执行有效，库里只存哈希；执行结束或被取消后返回 `409 { "stop": true }`，外部进程看到就应该停下；
- 不回传进度的 Worker 也没关系：任务卡显示「等待 Worker 回传…」和已运行时长，直到 `execute` 返回结果。

内置的 Claude Code Worker 就是这么做的：用 `--output-format stream-json` 把它读了哪个文件、跑了什么命令实时转成进度，启动前用 `--session-id` 预先指定会话并存为断点，服务重启后 `--resume` 接着跑。

### 返回结果

```js
{ status: 'done', summary: '交付内容', tokens, cost, sessionId }
{ status: 'needs_approval', summary: '目前进展', approval: { question: '要覆盖吗？', options: ['覆盖', '换个名字'] }, sessionId }
{ status: 'failed', summary: '原因', retryable: false }  // retryable: false 表示重试也没用（缺配置、没装 CLI…）
{ status: 'cancelled', summary: '已停止' }
```

- 返回 `needs_approval` 后任务挂起、Worker 退出；用户拍板后会重新调用 `execute`，`ctx.resume` 里带着选择。
- `approval.custom: true` 时，拍板卡片上会多一个输入框，用户可以不选选项、直接写自己的决定（`ctx.parseApproval` 解析出来的审批默认开启）。按选项下标做不同操作的 Worker（比如「归档 / 取消 / 列清单」）不要开，免得自己写的决定落进默认分支。
- 换一个 Worker 来做：用户自己写的决定里点名了另一个可用 Worker（按它的 `keywords`），或者选了以「改用 / 换成 / 交给 …」开头、点名了可用 Worker 的选项（比如「改用 Claude Code 去查」），任务会改派给它从头做，`ctx.resume` 里带着这个选择。「我去 Claude Code 里查」这类是让用户自己去用，不会改派。
- 抛出异常或返回非法结果都按 `failed` 处理，不会卡住队列。
- 取消和超时由调度器负责：`signal` 触发后调度器立刻释放槽位，**之后 `execute` 返回的任何结果都会被丢弃**。请尽快响应 `signal`，尤其是自己启动的子进程（用 `ctx.exec` 就不用操心）。

配置和运行限制按 Worker id 存在 `worker_configs`，每个主机可以不同。`npm run plugin:check` 会同时检查数据目录里的插件和仓库 `workers/` 里的内置 Worker。

# 发现核心

> 代码：`src/discovery.js` · 依赖 `plugins.js` `relay.js` `source-links.js` `task-classification.js` `knowledge.js` `workflows.js` `worker-rules.js` `memory.js` `persona.js`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 职责

把**外部来源**交回来的条目变成任务。核心不关心来源是什么：邮件、日历、TAPD、企微都只是一批 `items[]`。

**做：**
- 按节奏拉 `poll` 来源、接 Webhook、管长连接的启停和重连；
- 去重、批量判断要不要动手、建任务或合并进已有任务；
- 外部状态同步（见过的条目、`syncStatus`）；
- 在主对话里汇总「发现了什么、交给了谁」；
- 有人在外面直接找静静闲聊时，交给人格决定回不回。

**不做：**
- 不执行任务——只调 `scheduler.createTask / mergeTask`；
- 不信外部内容选 Worker——只认主人配的流程和规则；
- 插件只做 I/O，去重、判断、建任务都在这里，插件不碰。

## 入口与触发

三种入口最后都汇到 `ingestItems(id, items)`：

| 类型 | 触发 | 插件导出 | 宿主限制 |
| --- | --- | --- | --- |
| `poll` | 每 60 秒 `runAll()` 检查是否到期；「立即扫描」或自动化扫描时 `runPlugin(id, { force })` | `poll(config, ctx)` → `{ items }` | 90 秒超时 |
| `manual` | 只在「立即扫描」或自动化扫描时拉，不参与定时轮询 | 同 `poll` | 同上 |
| `webhook` | `POST /api/hooks/<token>` → `receiveWebhook()` | `webhook(payload, ctx)` → `{ items }` | 15 秒；转成条目就回应发送方，判断放后台 |
| `stream` | `startLifecycle()` 调 `start(config, ctx)`，插件收到消息时调 `ctx.ingest(items)` | `start()` 返回停止函数 | 30 秒内要返回 |

> manifest 里还声明了 `watch` 类型，核心目前没有接，当作保留值。

## 调度节奏

`discovery.start()` 启动时：

1. 清掉上次进程在判断途中退出留下的 `pending` 占位，下次拉取重新判断；
2. 20 秒后首次 `runAll()`，之后每 60 秒一次；
3. 每 30 秒一次 `syncDue()`（外部状态同步）。

`runAll()` 对每个启用的 `poll` 插件：

| 规则 | 说明 |
| --- | --- |
| 是否到期 | 距上次运行 ≥ `intervalMinutes`（默认 30 分钟）× 退避倍数 |
| 失败退避 | 上次出错时倍数为 `2^失败次数`，最多 16 倍。默认 30 分钟的插件连续失败后最长约 8 小时才再试 |
| 单插件互斥 | `running` 集合：同一个插件正在拉就跳过 |
| 插件之间 | **串行**：一个一个 `await runPlugin()`。一个插件卡满 90 秒，后面的都要等 |

`runPlugin()` 给插件的 `ctx`：`settings`（不含 Key）、`now`、`since`（上次运行时间）、`signal`、`log`、`state`（插件自己的持久状态）、`classify`（归类状态）。超时不等插件理会 `signal`，直接按失败处理。每次运行记一条 `plugin_runs`。

## Ingest 流程

`ingestItems()` → `processFresh()`：

1. **规范化**：`normalizeItem()`，最多 10 条。
2. **记外部对象树**：自动归类开着时 `classification.observeItems()`，新旧条目都算一次观察。
3. **占位去重**：`reserveItem()` 往 `source_items` 插一条 `status=pending`，按 `(source, external_id)` 唯一；占不到的算「见过」。
   > 先占位再判断：判断要等模型，这期间同一条再进来（发送方重发、长连接重放）也不会建出两个任务。
4. **见过的条目**：`refreshKnown()` 用它带来的状态更新已绑定的卡（`sourceLinks.applyStatus`）；归类刚打开时补上节点并重算归属。
5. **消息类来源先攒住播报**：`relay.hold(id)`，保证渠道里是「收到 → 等拍板 / 做完」的顺序，见 [通道与回传](channels.md#消息类来源的回传)。
6. **判断**：
   - 带了自动化的 `override`（指定流程或 Worker）：全部算要做，跳过模型；
   - 否则 `decide()` 一次把这批条目交给模型，问每条「要不要动手、标题、执行提示、优先级、属于哪个流程」；模型不可用时退回关键词规则（`heuristicDecision`）。
7. **逐条处理**：

   | 情况 | 处理 | `source_items.status` |
   | --- | --- | --- |
   | `hops > 8` | 跳过，防事件链无限传递 | `skipped` |
   | 不用动手，但有人直接找她（`item.direct`） | `chatBack()`：按人格决定回不回（`persona.chatReply`，外人只碰人格记忆） | `chat` |
   | 不用动手 | 记下理由 | `skipped` |
   | 要动手，同 `groupKey` 有排队中的任务 | `scheduler.mergeTask()` 把内容追加进去 | `merged` |
   | 要动手 | 见下面「建任务」 | `task` |

8. **收尾**：`markPluginRun()` 更新插件状态；主对话发一条汇总（`router.postAssistant`）；消息类来源 `relay.acknowledge()` 回执；放开 `hold`。
9. **出错**：`releasePending()` 放掉这批占位，下次重来。插件抛错或超时只影响它自己。

## 建任务

要动手的条目：

1. **流程**：自动化强制的 > 原文命中触发词 > 模型挑的 > 用模型改写的标题再匹配一次。
2. **工作区**：流程指定的 > 条目自己带的（`item.workspace`，比如 TAPD 每个项目配的工作区）> 来源绑定的（`source_plugins.workspace_id`）> 默认工作区。条目带的工作区 id 找不到时按没带来处理。
3. **拼 prompt**：
   - 模型给的执行提示；
   - 来源、工作区路径、工作区里的目录、判断理由、标题、链接、原文；
   - 相关业务记忆 3 条（`memory.context`）；
   - 分类知识：`classification.scopeFor()` 现场算出分类域，`knowledge.context()` 取几条（只在来源开启自动归类时），见 [外部对象](external.md)；
   - 能发回原会话时，告诉 Worker「发消息是静静的事，你只写回复正文」；
   - 流程步骤（`workflows.promptSection`）。
4. **选 Worker**（外部来源的规则）：

   | 优先级 | 来源 |
   | --- | --- |
   | 1 | 自动化强制的 Worker |
   | 2 | 流程指定的 Worker（要可用） |
   | 3 | 分配规则（`matchWorkerRule({ source: 'plugin:<id>', eventType })`） |
   | 4 | 兜底 Worker（设置里指定，默认最便宜的文本 Worker） |

   **外部内容不能决定交给谁**：消息里点名的 Worker、模型挑的 Worker、按文字推断的能力都不算。

5. **先问主人**：流程和规则都没指定 Worker，而外部消息点名了本机可用的 Worker、或含有兜底做不了的强能力信号（代码、仓库、生成文件、命令行工具）时，`routingHold()` 生成一个 `hold`：任务建好就停在一条 `kind=routing` 的审批上，选项记着「交给谁 / 要不要顺手建规则 / 不处理」。主人选了才改派并入队，见 [调度器 · 拍板](scheduler.md#拍板)。这类任务不参与合并。
6. **建**：`scheduler.createTask({ origin: 'plugin:<id>', priority: 模型给的（默认 2）, groupKey, hops, replyTo, hold, sourceLink, workflowId })`。
   - `sourceLink`：条目带状态、或插件导出了 `syncStatus`、或带归类节点时才绑，写 `task_sources`；
   - 注入过知识时 `knowledge.recordInjection()` 留底。

## 外部状态同步

| 途径 | 时机 | 做什么 |
| --- | --- | --- |
| 见过的条目 | 每次 ingest | 条目带 `status` 就更新绑定的卡 |
| `syncStatus` | 每 30 秒 `syncDue()` 挑到期的绑定 | 调插件批量查外部状态，写 `task_sources`；返回里可以顺带交节点和父（壳节点回填、父指针变化），照常观察并重算归属 |
| 手动刷新 | 任务详情 `POST /api/tasks/:id/sources/:linkId/refresh` | `refreshLink()` |

状态协议（`provider / externalId / status{key,label,category,detail}`）见 [外部对象](external.md)。

## 长连接

`stream` 类来源（企业微信智能机器人）：

1. 启用 / 改配置 / 服务启动时 `startLifecycle(id)` 调插件的 `start(config, ctx)`，30 秒内要返回停止函数；
2. 插件收到消息调 `ctx.ingest(items)`，走同一条 ingest 流程；
3. 插件用 `ctx.status(detail)` 报连接状态；彻底断了调 `ctx.fail(reason)` 交回核心；
4. `ctx.fail()`、`start()` 抛错或超时，都按退避重启：30 秒起翻倍，最长 30 分钟；
5. 停用 / 卸载 / 退出时调停止函数。服务启动时长连接并行启动，不阻塞监听端口。

## 接口

| 接口 | 用途 |
| --- | --- |
| `POST /api/hooks/<token>` | Webhook 入口（不需要配对，token 即凭据） |
| `GET /api/plugins` · `PUT/DELETE /api/plugins/:id` | 来源列表、配置、删除 |
| `POST /api/plugins/:id/test` · `POST /api/plugins/:id/scan` | 测试连接、立即扫描 |
| `GET /api/plugins/:id/runs` · `GET /api/plugins/:id/items` | 运行记录、最近条目 |
| `POST/PATCH/DELETE /api/tasks/:id/sources/:linkId[/refresh]` | 绑定的外部对象：刷新、跟踪开关、解绑 |

## 相关文档

- [插件体系](plugins.md)：来源插件的协议和加载
- [通道与回传](channels.md)：消息类来源怎么往外说话
- [外部对象、归类与知识](external.md)
- [Router · 选 Worker](router.md#选-worker)：主人对话的裁决规则，和外部来源对照看

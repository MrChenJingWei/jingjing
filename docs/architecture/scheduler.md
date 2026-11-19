# 调度器与任务生命周期

> 代码：`src/scheduler.js` · `src/lifecycle.js` · 依赖 `workers.js` `channels.js` `workflows.js` `memory.js` `source-links.js`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 职责

所有任务的唯一执行层：排队、并发、交给 Worker、处理返回、挂起等拍板、重试、接着做、重启恢复。Router 和发现核心都只通过 `createTask()` 进来。

**做：** 队列和并发；任务状态机；拍板；执行记录、心跳、断点、回传令牌；终态的唯一出口 `finalize()`。

**不做：** 不碰会话消息，不读写长期记忆（唯一例外：任务完成时写一条情景记忆）；不判断意图、不选 Worker（建任务时已经定好，拍板改派除外）。

## 任务状态机

转换表在 `lifecycle.js` 的 `TRANSITIONS`，所有改状态都经 `setStatus()` 校验，非法转换抛 409。

```
                 createTask                       createTask({ hold })
                     │                                    │
                     ▼                                    ▼
   retry/continue ┌───────┐   pump()   ┌─────────┐  needs_approval  ┌──────────────────┐
  ┌──────────────▶│queued │──────────▶│ running │────────────────▶│ waiting_approval │
  │               └───────┘◀──────────└────┬────┘                  └────────┬─────────┘
  │                   ▲    Worker 失败可重试 │                                │
  │                   └─────────────────────┼──────── approve(choice) ───────┘
  │                                         │ Worker 返回 / 超时 / 取消 / 放弃
  │                                         ▼
  │                         ┌──────┬────────┬───────────┐
  └─────────────────────────│ done │ failed │ cancelled │
                            └──────┴────────┴───────────┘
```

| 从 | 可以到 |
| --- | --- |
| `queued` | `running` `cancelled` |
| `running` | `done` `failed` `cancelled` `waiting_approval` `queued`（重试 / 恢复） |
| `waiting_approval` | `queued` `cancelled` `failed` |
| `done` `failed` `cancelled` | `queued`（重试 / 接着做） |

一个任务的完整状态由三样东西还原：

- `tasks.status` 等字段：当前阶段（物化状态）；
- `task_runs`：每次执行一条，记第几次、Worker、心跳、断点、令牌哈希、结局（`running / done / failed / cancelled / timeout / waiting_approval / interrupted`），`tasks.run_id` 指向最近一次；
- `task_events`：只追加的时间线。

## 建任务

`createTask(opts)` 在**一个事务**里：

1. 校验 Worker（不传就用兜底 Worker；未知 Worker 报 400）；
2. 写 `tasks`：普通任务 `status=queued`；带 `hold` 时直接 `waiting_approval`；
3. 写 `task/created` 事件；
4. 写来源绑定 `task_sources`（`sourceLink` / `sourceLinksList`）；
5. 带 `hold` 时同时写一条 `approvals(kind=routing)` 和 `task/waiting_approval` 事件。

事务之后：推 `task/created`；带 `hold` 的推 `approval/created` 并发通知，否则 `pump()`。

主要参数：`title / prompt / worker / cwd / origin / sessionId / priority / workflowId / options / replyTo / hold / parentId / linkKind / sourceLink / groupKey / hops`。

`mergeTask(id, …)`：只对 `queued` 的任务，把新内容追加到 prompt（总长 3 万字以内），更新回传地址，补一条来源绑定，写 `task/merged`。

## 排队与并发

`pump()`，在建任务、执行结束、拍板、恢复后都会调用：

1. 正在 pump 或正在退出就返回；`settings.queuePaused` 时不动；
2. 全局上限 `concurrency`（默认 2，范围 1–4）；
3. 按 `priority ASC, created_at ASC` 取最多 200 条 `queued`（聊天和来源默认 2，自动化 3，数字越小越先）；
4. 每个 Worker 再按自己的 `limits.concurrency` 限额；某个 Worker 满了跳过它的任务，让别的 Worker 的任务先跑；
5. `UPDATE tasks SET status='running' WHERE id=? AND status='queued'` 原子占位，占到才 `execute()`。

## 执行

`execute(task)`：

1. `lifecycle.startRun()`：新建一条 `task_runs`，生成一次性令牌（库里只存 sha256），`tasks.run_id` 指向它；
2. 准备回调：
   - `onProgress(message)`：写 `tasks.progress`、心跳、推 `task/progress`（同样的内容不重复推）；
   - `checkpoint(data)`：断点存进 `task_runs` 和 `tasks.resume_payload`，带 `sessionId` 的一并记下；执行已结束后再存会被拒绝；
   - `report(body)`：回传接口的统一入口；
3. 登记到内存 `running` Map，起超时定时器（`limits.timeoutMinutes`），状态改 `running`，写 `task/started`；
4. `runWorker(task, ctx)`，`ctx` 主要内容：

   | 字段 | 内容 |
   | --- | --- |
   | `signal` | 取消 / 超时 / 退出时 abort |
   | `resume` | 上一次拍板的问题和选择 |
   | `recovery` | 重启恢复时的断点（只给这一次） |
   | `followup` | 接着做的轮次和新的一句话 |
   | `memories` | 按标题 + 指令检索的业务记忆 6 条 |
   | `tasks` | 最近 10 个任务 |
   | `run` | `{ id, token, reportUrl }` |

   Worker 侧的完整 `ctx` 见 [Worker](workers.md#宿主-ctx)。

5. 与 abort 赛跑：取消或超时**不再等 Worker**，立刻释放槽位，迟到的结果也不会覆盖状态；
6. 执行期间，外部 Agent 可以 `POST /api/runs/<runId>/report`（`Authorization: Bearer <令牌>`）上报 `{ message, progress, checkpoint }`；执行结束后令牌失效，返回 `{ ok: false, stop: true }` 让对方停下；
7. 按结果分支：

   | 结果 | 处理 |
   | --- | --- |
   | `needs_approval` | 事务里写 `approvals(kind=worker)`、状态 `waiting_approval`、记下 `session_id`；习惯允许就 `autoApprove()`，否则发通知 |
   | `failed` | Worker 声明了 `retries` 且没标 `retryable: false` 时回到 `queued`（`task/retry`）；否则 `finalize(failed)` |
   | `cancelled` | `finalize(cancelled)` |
   | `done` | `finalize(done)`；开了 `autoRemember` 时写一条情景记忆（截断 400 字） |
   | 超时 | `finalize(failed)`，超时不自动重试 |
   | 用户取消 | `finalize(cancelled)` |
   | 服务退出 | 什么都不改，任务保持 `running`，等 `recover()` |
   | 执行抛异常 | `finalize(failed)` |

8. `finally`：`finishRun()` 记这次执行的结局，移出 `running`，再 `pump()`。

**挂起零消耗**：`needs_approval` 落库后 Worker 的调用栈已经结束，等待期间不占 CPU、不烧 token。恢复时 Worker 拿到的是一次新的调用，`resume_payload` 里带着「上次问了什么、你选了什么、会话 id」。

## 拍板

`approve(approvalId, choice, { by, answer })`。入口：任务详情、对话卡片（`POST /api/tasks/:id/approve`、`/api/approvals/:id/resolve`）、Telegram 按钮、消息类来源渠道里的「同意」（`relay.interact`）、习惯自动拍板（`by: 'habit'`）。

| `kind` | 谁产生 | 选了之后 |
| --- | --- | --- |
| `worker` | Worker 返回 `needs_approval` | `hops + 1`，超过 `maxHops`（默认 6）直接失败；否则把选择写进 `resume_payload.approval`，回到 `queued` |
| `routing` | 发现核心：外部消息要先问交给谁 | 按 `meta.choices[i]` 改派 Worker 并入队（写 `task/edited`）；选「以后都交给它」顺手 `ensureWorkerRule()`；选「不处理」就 `finalize(cancelled)`。不算拍板次数、不传给 Worker、不记进习惯 |
| `recovery` | 重启时任务在跑、Worker 不支持自动恢复 | 「重新执行」回到 `queued`；「放弃」`finalize(cancelled)` |

- `choice < 0` 表示取消；
- Worker 允许时（`approval.custom`），主人可以不选选项、自己写一句决定（最长 500 字），追加在 `options` 末尾传给 Worker；
- 自己写的决定里点名了别的 Worker 时会改派；
- 状态写入、审批更新、事件都在一个事务里，崩溃时不会留下「审批已处理、任务还在等」的半截状态。

**自动拍板**：任务来自开了 `auto` 的习惯，且问题能匹配习惯里记过的 `answers`，就在下一轮事件循环替主人选，推 `approval/auto`，Router 在对话里说一声。

## 结束：`finalize()` 与扇出

终态（done / failed / cancelled）**只有一个出口** `finalize()`：

1. 同一事务写状态（清空 progress、记 `finished_at`）和事件；
2. 推任务对象；
3. 发 `task/finished`；
4. 推通知通道（用户自己取消的不推）；
5. 更新统计。

不管是 Worker 返回、超时、异常、用户取消、拍板次数超限还是重启后放弃，下游都只听 `task/finished`，互相不知道对方：

| 订阅者 | 做什么 | 详见 |
| --- | --- | --- |
| `router.js` | 流程效果统计、提议成习惯 | [Router · 习惯学习](router.md#习惯学习) |
| `relay.js` | 消息类来源：自动发回结果，或推结束状态 | [通道与回传](channels.md#消息类来源的回传) |
| `knowledge.js` | 学关系、结论，标记注入过的知识被用过 | [外部对象](external.md) |
| `task-classification.js` | 更新所属分类的最近活动 | [外部对象](external.md) |
| `mind.js` | 任务成败推动心情 | [记忆与心智](memory.md) |
| `plugin-forge.js` | 编码任务完成就检查草稿、进下一轮 | [插件体系 · 插件工坊](plugins.md#插件工坊) |

加一个下游只需要再订阅一次，不用改调度器。

## 接着做、另起一张、重试

| 操作 | 接口 | 做什么 |
| --- | --- | --- |
| 接着做 | `POST /api/tasks/:id/continue`（`mode: same`） | `continueTask()`：只允许终态。上一轮的要求和结果追加进 `resume_payload.followup.transcript`（保留 4 轮，每轮 3000 字），清零 `attempts / hops / recoveries`，作废未决审批，回到 `queued`，写 `task/followup`。能续会话的 Worker 只发新的那句 |
| 另起一张 | 同上，`mode: new` | `spawnFollowup()`：新任务带上一张的指令和结果，`parent_id` + `link_kind=followup`，继承外部对象绑定 |
| 重试 | `POST /api/tasks/:id/retry` | 清空 `attempts / hops`，作废旧审批，重新排队 |
| 取消 | `POST /api/tasks/:id/cancel` | 排队中的直接 `cancelled`；在跑的 abort |
| 编辑 / 删除 | `PATCH` / `DELETE /api/tasks/:id` | 只允许非运行态；删除发 `task/deleted` |

## 重启恢复

`scheduler.init()` → `recover()`，对每个 `status=running` 的任务：

1. 上一次执行记为 `interrupted`；正常退出打断的不计入 `recoveries`，崩溃 / 强杀才计；
2. 连续打断超过 2 次（`MAX_RECOVERIES`）：直接失败，避免「崩溃 → 重启 → 再执行 → 再崩溃」；
3. 按 Worker manifest 的 `recovery`：

   | `recovery` | 处理 |
   | --- | --- |
   | `resume` 且有断点 | 带 `resume_payload.recovered` 回到 `queued`，Worker 拿到 `ctx.recovery` 从断点继续（会话型 Worker 同时拿回 `session_id`） |
   | `restart` | 直接重新排队 |
   | `ask`（默认）或 `resume` 但没有断点 | 建一条 `kind=recovery` 审批问主人「重新执行 / 放弃」 |

4. 写 `task/recovered`，最后 `pump()`。

正常退出的流程见 [进程与运行时](runtime.md#正常退出)。

## 一致性

- 内存里只有 `running` 这个 Map；重启后以数据库为准；
- 所有状态变化都经 `setStatus()` 并同步写事件；建任务、拍板、挂起、重试、删除这类多步写入包在 `transaction()` 里；
- `pump()` 原子占位，保证同一任务不会被调度两次；
- 同一数据目录只跑一个进程（实例锁），`recover()` 不会误伤另一个进程正在跑的任务。

## 事件

```
task/created → task/started → task/progress* → task/waiting_approval
   → approval/resolved → task/started → task/done
```

其他：`task/retry` `task/failed` `task/cancelled` `task/recovered` `task/merged` `task/followup` `task/edited` `task/proactive`；删除发 `task/deleted`。

## 相关文档

- [Worker](workers.md)：`execute()` 怎么写、宿主给什么
- [数据与事件](data.md)：表结构和总线事件

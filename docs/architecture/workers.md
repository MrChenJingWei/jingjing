# Worker

> 代码：`src/workers.js` · `src/worker-runtime.js` · `src/worker-thread.js` · `src/worker-routing.js` · `src/worker-rules.js` · `src/capabilities.js` · `workers/*`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 职责

真正干活的执行器。Worker **无状态、可替换、全部插件化**：内置的和第三方的是同一种插件包，只有一个入口 `execute(task, ctx)`。

**做：** 拿到任务和 `ctx`，执行，返回结果；需要主人决定时返回 `needs_approval`。

**不做：** 不管排队、超时、重试、恢复（调度器按 manifest 的声明统一处理）；不直接写库（断点、进度通过 `ctx` 交给宿主）。

## 内置 Worker

随代码发布在 `<app>/workers/<id>/`，跟着在线升级一起更新：

| id | 名称 | 能力 | 开销 | 恢复 | 超时 / 并发 / 重试 |
| --- | --- | --- | --- | --- | --- |
| `llm` | 问答 | text | 1 | restart | 10 分钟 / 2 / 1 |
| `file` | 生成文件 | write-file | 1 | restart | 10 分钟 / 2 / 1 |
| `shell` | 文件操作 | manage-files | 1 | restart | 10 分钟 / 1 / 0 |
| `claude` | Claude Code | code · write-file · manage-files · text | 4 | resume | 60 分钟 / 1 / 0 |
| `codex` | Codex | code · write-file · manage-files · text | 4 | ask | 60 分钟 / 1 / 0 |
| `dsh` | DeepSeek Harness | code · write-file · manage-files · text | 4 | resume | 60 分钟 / 1 / 0 |

- `shell` / `file` 只在任务工作区里移动或写文件，越界（`isInside` 校验）直接失败；
- `claude` 以 `claude -p` 运行，工具权限交给 Claude Code 自己的用户配置，静静不追加权限参数；
- 编码类 Worker 存会话 id，拍板后、重启后能接着原来的会话。

用户安装的 Worker 插件在 `<data>/plugins/<id>/`，由 [插件体系](plugins.md) 加载后注册进来。

## Manifest 的 `worker` 段

```json
{
  "kind": "worker",
  "worker": {
    "abilities": ["code", "write-file", "manage-files", "text"],
    "cost": 4,
    "aliases": ["claude", "claude code"],
    "capabilities": ["shell", "git", "npm"],
    "recovery": "resume",
    "timeoutMinutes": 60,
    "concurrency": 1,
    "retries": 0
  }
}
```

| 字段 | 谁用 | 含义 |
| --- | --- | --- |
| `abilities` | 选 Worker | 硬能力：`text` / `write-file` / `manage-files` / `code` |
| `cost` | 选 Worker | 开销，越低越优先 |
| `aliases` `keywords` | 选 Worker | 主人点名用的叫法（本机可以再加） |
| `capabilities` | 选 Worker | 具体工具能力（`git`、`tapd-cli`…），本机可以增删 |
| `recovery` | 调度器 | 重启后：`resume` 带断点续 / `restart` 重跑 / `ask` 问主人（默认） |
| `timeoutMinutes` `concurrency` `retries` | 调度器 | 默认 30 / 2 / 0，本机可以在设置里覆盖 |

本机覆盖存在 `worker_configs`（启用、配置、限额、别名、能力、备注）。

## 宿主 `ctx`

`hostContext()` 组装，`execute(task, ctx)` 拿到：

| 字段 | 内容 |
| --- | --- |
| `signal` | 取消 / 超时 / 退出时 abort |
| `emit(message, meta)` | 报进度（写 `tasks.progress`，推到界面和渠道） |
| `checkpoint(data)` | 存断点（`data.sessionId` 会被记成会话 id） |
| `run` | `{ id, token, reportUrl }`，外部 Agent 回传用 |
| `resume` | 上一次拍板的问题、选项、选择、自定义回答 |
| `recovery` | 重启恢复时的断点 |
| `followup` | 接着做：`{ round, text }` |
| `sessionId` | 上次的会话 id |
| `approvalGuide` | 「怎么停下来问主人」的说明（`[[APPROVAL]]` 标记），转述给自己的 Agent |
| `config` | 这个 Worker 的配置（manifest 默认值 + 本机设置） |
| `settings` | 去掉 Key 和通道凭据的设置 |
| `options` | 任务级运行选项，比如插件草稿任务的 `{ allowEdits: true }` |
| `memories` `tasks` `workers` | 相关业务记忆、最近任务、可用 Worker |
| `workspace` `extraDirs` `paths` | 工作目录、工作区挂的其他文件夹、沙箱目录 |
| `llm.chat()` `llm.mode` | 通过宿主调模型，Key 不出宿主 |
| `exec(cmd, args)` | 起子进程，自动带 `JINGJING_RUN_ID / TOKEN / REPORT_URL`，跟着 `signal` 结束整组进程 |
| `which` `sleep` `parseApproval` `estimateTokens` `log` | 工具函数 |

## 返回值

```js
{ status: 'done' | 'failed' | 'cancelled' | 'needs_approval',
  summary: '给主人看的结果',
  approval: { question, options, custom },   // needs_approval 时必填 question
  outcome: 'completed' | 'proposed' | 'partial' | 'blocked' | 'delivered',  // 可选，只对 done 有用
  sessionId, tokens, cost, retryable }
```

`normalizeResult()` 校验：未知状态、`needs_approval` 没带问题都会变成失败。

**结论（outcome）**：`done` 只代表这一轮跑完了。事情还要主人接着定时（方案等确认、给了可选的下一步、只做完一部分、卡住了），带上 `outcome`；任务页会把 `proposed / partial / blocked` 放进「要你处理」。交给 Agent 的 Worker 可以不自己判断：`ctx.approvalGuide`（或单独的 `ctx.outcomeGuide`）已经告诉 Agent 在输出最后单独写一行 `[[OUTCOME]] proposed`，宿主在 `normalizeResult()` 里认出来、从 `summary` 里去掉，结果对象里的 `outcome` 优先。都没给时结论留空，任务页从结果的收尾推断（问句、主动提出下一步、请主人定的说法；客套话不算）。新的一轮（重试、接着做）开始时清空上一轮的结论。插件抛的异常一律转成 `failed`，被 abort 的转成 `cancelled`，不会抛到调度器。

## 执行方式

`runWorker(task, ctx)`：

1. Worker 不存在、已删除或已停用 → 直接 `failed`（`retryable: false`）；
2. **内置 Worker**：在主线程直接 `await execute()`；
3. **第三方 Worker 插件**：`runInThread()` 在 `worker-thread.js` 独立线程里跑（内存上限 512 MB）：
   - 函数型的 `ctx`（`emit`、`log`）通过消息转发；`checkpoint`、`llm.chat` 走 RPC 回主线程；
   - 取消 / 超时时先通知线程，宽限后 `terminate()`，同步死循环也卡不住静静；
   - 线程意外退出算失败。
   > 隔离线程只防卡死和内存泄漏，**不是安全沙箱**：同一个进程、同一个系统账户，能读写本机文件。

## 外部 Agent 回传

长时间运行的编码 Agent 可以不经过 `ctx`，直接用 HTTP 报进度：

```
POST $JINGJING_REPORT_URL
Authorization: Bearer $JINGJING_RUN_TOKEN
{ "message": "跑完单测了", "progress": { "step": 3, "total": 5 }, "checkpoint": { "sessionId": "…" } }
```

令牌只对这一次执行有效，执行结束后返回 `{ ok: false, stop: true }`。见 [调度器 · 执行](scheduler.md#执行)。

## 选 Worker

选择逻辑是纯函数（`worker-routing.js`），不认识任何具体的 Worker id，只看 manifest 声明：

- `workerCatalog()` 给出每个 Worker 的能力、开销、别名、可用性（`detect()` 检测本机命令；`which` 结果缓存 30 秒，点「检测」时清空）；
- `pickWorker()` 按 点名 > 流程 > 规则 > 模型 > 能力 > 硬能力 > 兜底 选；偏好开销低、内置优先、id 排序；
- 分配规则（`worker_rules`，`worker-rules.js`）按文本、来源、事件类型、工作区匹配；
- 能力目录在 `src/capabilities.json`，`hostTool` 类能力在没有 Worker 显式声明时由有 `shell` 能力的 Worker 承担。

谁说了算、冲突怎么裁决见 [Router · 选 Worker](router.md#选-worker)。主人对话和外部来源的差别见 [Router](router.md#派活) 和 [发现核心](discovery.md#建任务)。

## 接口

| 接口 | 用途 |
| --- | --- |
| `PUT /api/workers/:id` | 启用、配置、限额、别名、能力、备注 |
| `POST /api/workers/:id/test` | 检测本机是否可用 |
| `DELETE /api/workers/:id` | 删除（内置的可以恢复） |
| `PATCH/DELETE /api/worker-rules/:id` · `POST /api/worker-rules/:id/move` | 分配规则 |

## 相关文档

- `plugins/AUTHORING.md`：写 Worker 插件的完整说明
- [插件体系](plugins.md)：加载、安装、插件工坊

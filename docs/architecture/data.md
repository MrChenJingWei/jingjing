# 数据与事件

> 代码：`src/db.js` · `src/events.js` · `src/seed.js`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 存储

- 本地一个 SQLite 文件 `<data>/jingjing.db`（内置 `node:sqlite`，WAL 模式）；没有账号、没有云端同步，备份就是复制这个文件；
- 建表与迁移在 `db.js`，少数模块自己建表（`workflows.js`、`plugin-forge.js`）；
- `transaction(fn)` 包多步写入；`event(taskId, type, data)` 写任务事件；
- **事件日志和物化状态并存**：`tasks` 查询快，`task_events` 审计全。代价是写任务时多一条 insert，个人场景完全可接受。

不在库里的数据：

| 位置 | 内容 |
| --- | --- |
| `<data>/workflows/*.md` | 工作流程；`learned/` 下是静静学的习惯 |
| `<data>/plugins/` | 「我的」插件 |
| `<data>/plugin-drafts/` | 插件工坊草稿目录 |
| `<data>/archive/` | 归档包 |
| `<data>/updates/` | 在线升级下载的新版本 |
| `<data>/access-key` | 配对码 |

## 表

### 任务

| 表 | 用途 |
| --- | --- |
| `tasks` | 任务的物化状态：status、worker、cwd、prompt、result、progress、tokens、cost、attempts、hops、recoveries、resume_payload、reply_to、approval_id、run_id、parent_id、workflow_id、group_key… |
| `task_runs` | 每次执行一条：第几次、Worker、心跳、断点、令牌哈希、结局 |
| `task_events` | 只追加的事件日志，任务详情的时间线 |
| `approvals` | 待决问题、选项、结果；`kind` = `worker` / `routing` / `recovery`，`meta` 存改派选项 |

### 对话与心智

| 表 | 用途 |
| --- | --- |
| `sessions` | 会话（主人是 `main`，外人是 `ext:<id>`），带滚动摘要和 `encoded_upto` |
| `messages` | 消息（含 task_id 引用、kind、meta） |
| `memories` | 分层记忆，`domain` 分业务 / 人格；`memories_fts` 是 trigram 全文索引 |
| `people` | 认识的人（主人 id = `owner`）：熟悉度、好感、印象、来往次数 |
| `persona_versions` | 人设的每一版 |

### 来源

| 表 | 用途 |
| --- | --- |
| `source_plugins` | 插件实例：启用、配置、工作区、轮询间隔、回传策略、上次运行结果 |
| `source_items` | 插件交回的条目，按 `(source, external_id)` 唯一；去重账本，归档也不动 |
| `plugin_runs` | 每次轮询的记录 |
| `plugin_state` | 插件自己的持久状态（`ctx.state`） |
| `task_sources` | 任务 ↔ 外部对象绑定和外部状态 |

### 归类与知识

| 表 | 用途 |
| --- | --- |
| `external_nodes` `external_node_links` | 外部对象树和补充关系 |
| `task_categories` | 分类项（父卡） |
| `task_assignments` | 任务归属 |
| `task_class_suppressions` | 手动排除 |
| `task_knowledge` | 分类域上的知识 |

### 配置

| 表 | 用途 |
| --- | --- |
| `settings` | 单行 JSON 配置（读取时合并默认值） |
| `rules` | 自动化：`trigger`、`action` 两列 JSON + 上次运行结果 |
| `worker_rules` | 分配规则 |
| `worker_configs` | 每个 Worker 的启用、配置、限额、别名、能力、备注 |
| `workflow_stats` `workflow_state` | 工作流程效果统计和启停状态 |
| `plugin_drafts` | 插件工坊草稿 |

## 事件总线

`events.js` 是一个极简的进程内总线：`bus.emit(type, payload)` 同时分发给进程内订阅者（`bus.on`）和所有 SSE 客户端。

**进程内订阅关系**——模块之间靠事件解耦的地方：

| 事件 | 订阅者 |
| --- | --- |
| `task/finished` | router（习惯）、relay（回传）、knowledge（学习）、task-classification（活动）、mind（心情）、plugin-forge（草稿） |
| `task/created` · `source/linked` · `source/unlinked` | task-classification（重算归属） |
| `classification/assigned` · `classification/moved` | knowledge（学关系） |
| `approval/created` · `task/progress` | relay（拍板卡片、进度播报） |
| `task/deleted` | plugin-forge |
| `relay/failed` | discovery（转成主对话里的提醒） |
| `mind/say` · `approval/auto` | router（写进主对话） |

**推给前端的事件**：

| 类别 | 事件 |
| --- | --- |
| 任务 | `task/created` `task/updated` `task/progress` `task/finished` `task/deleted` `task/replied` |
| 拍板 | `approval/created` `approval/resolved` `approval/auto` |
| 对话 | `chat/message` |
| 记忆 / 心智 | `memory/created` `memory/updated` `memory/deleted` `mind/updated` `mind/say` |
| 配置 | `settings/updated` `rules/updated` `workflows/updated` `workers/updated` `plugins/updated` `plugin/status` |
| 归类 / 知识 | `categories/updated` `category/*` `classification/*` `knowledge/updated` |
| 其他 | `stats/updated` `channel/delivery` |

任务事件（写进 `task_events` 的时间线）见 [调度器 · 事件](scheduler.md#事件)。

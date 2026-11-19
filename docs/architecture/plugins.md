# 插件体系与插件工坊

> 代码：`src/plugins.js` · `src/plugin-spec.js` · `src/plugin-loader.js` · `src/plugin-install.js` · `src/plugin-forge.js` · `src/plugin-probe.js` · `src/plugin-docs.js` · `plugins/*`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 职责

管理两种插件包的存放、校验、加载、实例配置和热重载；让静静自己写插件。

| 种类 | `kind` | 干什么 | 谁调用 |
| --- | --- | --- | --- |
| 来源插件 | `source`（默认） | 只做 I/O：拉数据、接 Webhook、维持长连接、往外说话 | [发现核心](discovery.md)、[relay](channels.md) |
| Worker 插件 | `worker` | 执行任务 | [调度器](scheduler.md) → [Worker](workers.md) |

两种插件是同一种包结构：`plugin.json`（manifest）+ 入口模块，只能用 Node 自带模块。

## 存放位置

| 位置 | 内容 | 升级时 |
| --- | --- | --- |
| `<app>/plugins/` | 官方来源插件（邮箱、日历、TAPD、Webhook、企微） | 跟着在线升级更新，只读 |
| `<app>/workers/` | 内置 Worker | 跟着在线升级更新 |
| `<data>/plugins/` | 「我的」插件：安装的、自己写的、让静静写的 | 永远不覆盖 |

「我的」里出现和官方同 id 的插件时，加载「我的」那份（覆盖官方）；删掉就恢复官方版本。实例配置按插件 id 存，覆盖 / 恢复都不丢。「复制成我的」（`fork`）把官方插件拷一份到 `<data>/plugins/` 方便改。

## 加载流程

`reloadPlugins()`（启动时、安装 / 删除 / 改代码后）：

1. 扫描官方目录和用户目录，同 id 用户优先；
2. `plugin-spec.js` 校验 manifest（字段白名单、类型、`worker` 段范围、配置字段定义），不合格的记进 `pluginErrors()`，不影响其他插件；
3. `plugin-loader.js` 加载入口：URL 带上**整个插件目录的版本号**，再用模块钩子传给入口相对引用的每个子文件——多文件插件重装后不用重启就能拿到新代码；
4. `kind: worker` 的注册进 Worker 注册表（`registerWorkerPlugin`，默认在隔离线程执行）；
5. 来源插件按 `source_plugins` 里的实例生成可用列表；支持 `multiInstance` 的插件可以建多个实例（比如两个邮箱、每个 TAPD 项目一条）。每个实例的配置独立；一个实例里要配好几份同样结构的设置时用 `group` 类型（比如 TAPD 的多个项目，每个项目一张卡片，可以各自选工作区）。配了 `filters` 字段的插件还能导出 `filterFields()`，让每个实例（或分组里的每一项）从自己实际有的字段里选筛选条件（接口 `POST /api/plugins/:id/filter-fields`，用表单里当前的配置去问插件，30 秒内要返回）。

重新加载时先 `discovery.stopLifecycles()`，加载完再 `startLifecycles()`，长连接跟着换新代码。

## 来源插件协议

```js
// type: poll / manual
export async function poll(config, ctx) {
  return { items: [{ externalId: '稳定且唯一', kind: 'email', title: '…', content: '…', url: '…', occurredAt: '…' }] };
}
export async function test(config, ctx) { return { ok: true, detail: '…' }; }

// 可选
export async function webhook(payload, ctx) {}            // type: webhook
export async function start(config, ctx) { return stop; } // type: stream，收到消息调 ctx.ingest(items)
export async function deliver(config, payload, ctx) {}    // 消息类来源往外说话（新）
export async function reply(config, { to, text }, ctx) {} // 只发结果（旧）
export async function syncStatus(config, links, ctx) {}   // 批量查外部状态；可顺带交 node / parent（归类）
export async function filterFields(config, ctx) {}        // 按实例给「筛选条件」的可选字段（配合 config 类型 filters；在分组里时 ctx.item 是那一项）
export function migrateConfig(config) {}                  // 老配置转新结构（同步）；静静读配置时调用
```

条目的可选字段：

| 字段 | 作用 | 谁用 |
| --- | --- | --- |
| `externalId` | 去重键（必填） | 发现核心 |
| `groupKey` | 同一事项合并进排队中的任务 | 发现核心 |
| `hops` | 事件链深度，超过 8 停止派发 | 发现核心 |
| `direct` | 有人直接找静静（可以闲聊回复） | 发现核心 |
| `replyTo` | 回传地址，能发回原会话 | relay |
| `status` `track` | 外部状态、要不要跟踪 | source-links |
| `workspace` | 这条任务在哪个工作区里做（只认设置里的工作区 id） | 发现核心 |
| `node` `parent` `links` | 外部对象和上级（归类） | task-classification |
| `eventType` | 事件类型，给分配规则匹配 | worker-rules |

完整协议见 `plugins/AUTHORING.md` 和 `plugins/plugin.schema.json`。

## 宿主给插件的限制

| 入口 | 上限 |
| --- | --- |
| `poll` | 90 秒 |
| `webhook` | 15 秒 |
| `start` | 30 秒内返回 |
| `deliver` / `reply` | 15 秒 |
| 草稿检查 | 10 秒（隔离线程） |

来源插件在**主线程**运行：超时由宿主强制，但同步死循环仍会卡住整个服务。只安装可信插件。插件拿到的设置里没有模型 Key 和通知通道凭据；manifest 里的 `capabilities` 只是声明，不做强制。条目里的 `workspace` 也只认设置里已有的工作区 id，不是路径，插件不能借它指到任意目录。

## 安装与管理

- **上传 zip**：`POST /api/plugins/install` → `plugin-install.js` 解压校验后放进 `<data>/plugins/`，热重载；
- **复制官方 / 恢复官方**：`POST /api/plugins/:id/fork|restore-official`；
- **多实例**：`POST /api/plugins/:id/instances`；
- **启用、配置、工作区、轮询间隔、回传策略**：`PUT /api/plugins/:id`，存在 `source_plugins`；
- **插件自己的持久状态**：`ctx.state`，存在 `plugin_state`；
- **「怎么写插件」页**：`plugin-docs.js` 读随当前版本发布的 `plugins/README.md`、模板和官方插件源码，离线可看，并能拷一份模板成「我的」插件。

## 插件工坊

让静静自己写插件，检查通过后由主人确认安装。

1. **开草稿**：对话里意图为 `plugin`（[Router](router.md#处理一句话)）→ `forge.createDraft({ kind, request })`，在 `<data>/plugin-drafts/<id>/` 放模板、`AUTHORING.md`、JSON Schema，记一条 `plugin_drafts`；
2. **写**：
   - 有能写代码的 Worker（Claude Code、Codex…）：派一个 `origin=plugin-forge`、`options.allowEdits=true`、`cwd`=草稿目录的任务；
   - 没有但接了模型：让模型直接生成文件；
3. **检查**（编码任务 `task/finished` 后 `afterRound()`）：`plugin-probe.js` 在隔离线程里加载入口、列出导出，Worker 试跑 `detect()`、来源插件试跑 `test()`，10 秒上限；同时校验 manifest、只用 Node 自带模块；
4. **没过**：把问题交回编码 Worker 接着修，有轮数上限；任务失败时尝试抢救已写好的文件；
5. **过了**：对话里发卡片给主人看代码，**主人点「安装」才装上**，然后热重载插件；
6. 编码任务被取消或删除，草稿标记失败。

草稿接口：`GET /api/plugin-drafts/:id[/files]`、`POST /api/plugin-drafts/:id/install|discard|retry|recheck`。

## 相关文档

- `plugins/README.md`、`plugins/AUTHORING.md`：写插件的完整说明
- [发现核心](discovery.md)：来源插件交回的条目怎么处理
- [Worker](workers.md)：Worker 插件的 `ctx` 和返回值

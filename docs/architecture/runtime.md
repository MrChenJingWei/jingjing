# 进程与运行时

> 代码：`server.js` · `src/config.js` · `src/instance-lock.js` · `src/overlay.js` · `src/update.js` · `src/version.js` · `src/logger.js` · `src/archive.js`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 职责

把所有模块装配成一个进程：决定启动顺序、挂后台定时器、分发 HTTP 请求、退出时收尾。业务逻辑都不在这里，`server.js` 只做「接线」。

- 单进程 Node（≥ 23.4），零 npm 依赖，数据库用内置的 `node:sqlite`。
- 数据目录 `<data>`：命令行版 `data/`，App 版 `~/Library/Application Support/Jingjing/`，可以用 `JINGJING_DATA_DIR` 指定。
- 默认监听 `127.0.0.1:7777`（`JINGJING_HOST` / `JINGJING_PORT`）。

## 启动顺序

**先拿锁，再占端口，最后才动库里的任务。**

| # | 步骤 | 代码 | 为什么在这一步 |
| --- | --- | --- | --- |
| 1 | 被桌面 App 拉起时每 3 秒检查父进程，App 没了就退出 | `JINGJING_PARENT_PID` | 不留孤儿进程占端口 |
| 2 | 数据目录里有更高版本时，交给子进程跑新代码，父进程只守护 | `activateOverlay()` | 在线升级不用重装 App，见下文「升级」 |
| 3 | 接管 `console`，写进内存日志环（最近 600 条） | `installLogCapture()` | 设置 → 运行状态看日志 |
| 4 | 拿实例锁，拿不到直接退出 | `acquireInstanceLock()` | 防止两个进程同时 `recover()`，把同一个任务执行两遍 |
| 5 | 建表 / 迁移、写种子数据、生成配对码 | `seedIfEmpty()` `seed()` `auth.getAccessKey()` | |
| 6 | 加载内置 Worker（`<app>/workers/*`） | `loadBuiltinWorkers()` | |
| 7 | 复制官方插件种子、加载全部插件（含 Worker 插件） | `plugins.seedBuiltins()` `reloadPlugins()` | |
| 8 | 接好插件工坊和 Telegram 的回调 | `forge.configure()` `channels.setHandlers()` | 避免模块之间循环引用 |
| 9 | 监听端口，占不到就退出 | `server.listen()` | 端口起不来就不碰任务 |
| 10 | 恢复被打断的任务，开始调度 | `scheduler.init()` | 见 [调度器 · 重启恢复](scheduler.md#重启恢复) |
| 11 | 挂归档、归类的定时器 | `archive.maybeAutoArchive` `classification.reconcile/maintain` | |
| 12 | 每分钟：自动化 + 心智 | `router.startProactiveLoop()` | |
| 13 | 来源轮询、外部状态同步，清掉上次没判完的占位 | `discovery.start()` | |
| 14 | Telegram 长轮询 | `channels.restartTelegram()` | |
| 15 | 长连接来源并行启动，不等 | `discovery.startLifecycles()` | 一条连不上不影响服务 |

## 后台定时器

所有定时器都 `unref()`，不会阻止进程退出。

| 周期 | 做什么 | 入口 | 详见 |
| --- | --- | --- | --- |
| 15 秒 | 给正在跑的执行写心跳 | `scheduler.ensureHeartbeat` | [调度器](scheduler.md) |
| 30 秒 | 拉到期的外部状态和关系 | `discovery.syncDue` | [发现核心](discovery.md#外部状态同步) |
| 60 秒 | 检查哪些 `poll` 来源到期 | `discovery.runAll` | [发现核心](discovery.md#调度节奏) |
| 60 秒 | 检查哪些自动化到点 | `router.proactiveScan` | [Router](router.md#自动化) |
| 60 秒 | 整理停下来的对话、到点反思 | `mind.tick` | [记忆与心智](memory.md) |
| 启动 1 分钟后，之后每 6 小时 | 检查是否该归档（每天最多一次） | `archive.maybeAutoArchive` | 下文「归档」 |
| 启动 30 秒后，之后每天 | 归类重算、回收空分类 | `classification.reconcile / maintain` | [外部对象](external.md) |
| 30 秒起翻倍，最长 30 分钟 | 长连接断开后的重启 | `discovery.scheduleRestart` | [发现核心](discovery.md#长连接) |

## HTTP 请求分发

所有请求进 `server.js` 的同一个处理函数：

1. 非 `/api/*`：
   - `/pair?key=`：校验配对码，种 Cookie，302 回首页（主机 App 打开浏览器时用）；
   - 其余走静态资源（`public/`）；找不到且没有扩展名时回 `index.html`，给前端路由用。
2. `/api/*` 先过鉴权，三类例外：
   - 公开：`/api/health`、`/api/auth/status|login|logout`；
   - `POST /api/hooks/<token>`：按 token 找到插件，进 [Webhook 入口](discovery.md#入口与触发)；
   - `POST /api/runs/<runId>/report`：只认本次执行的一次性令牌，进 [回传接口](scheduler.md#执行)。
3. 其余按路径前缀分发给各模块（`/api/chat` → Router，`/api/tasks/*` → 调度器，`/api/plugins/*` → 插件 / 发现……）。
4. 异常统一转成 `{ error }`，状态码取 `err.statusCode`，默认 500。

鉴权细节见 [安全边界](security.md)。

## 正常退出

SIGINT / SIGTERM / 桌面 App 退出 / 父进程消失都走 `shutdown()`：

1. 停来源轮询、Telegram、长连接的重连定时器；
2. `scheduler.shutdown()`：所有执行以 `shutdown` 为原因中止，子进程整组 SIGTERM，1.5 秒后 SIGKILL；执行记录记为 `interrupted`，任务保持 `running`，等下次启动由 `recover()` 接手；
3. 关长连接、关 HTTP 服务；
4. 不管卡在哪，最多 4 秒后强制退出。

正常退出打断的任务不计入「连续被重启打断」的次数，只有崩溃、强杀才计。

## 单实例

`instance-lock.js` 在数据目录里拿一把 SQLite 独占文件锁，进程退出时由系统释放。拿不到就打印「已经在运行」并退出。要同时跑两个，用 `JINGJING_DATA_DIR` 指定不同的数据目录。

## 升级

- `update.js` 检查新版本（GitHub Release 或镜像），下载、校验 sha256 和签名后，解压到 `<data>/updates/<版本>/`，写 `current.json`。
- 下次启动时 `overlay.js` 发现更高版本，就用它拉起子进程跑新代码，父进程只守护和转发信号。只接受严格更高的版本，避免反复重载和降级。
- `POST /api/update/rollback` 回到安装包自带的版本。

发版流程见 [RELEASING.md](../RELEASING.md)。

## 归档

`archive.js` 把已结束（done / failed / cancelled）且超过 `afterDays` 天的任务，连同 `task_events`、`approvals`、`task_runs`、`task_sources` 和同期消息，打包成 `<data>/archive/archive-<时间>.jsonl.gz`，然后从库里删除。旁边的 `.json` 是同一份头信息，列表时不用解压。

不归档：记忆（长期上下文）、`source_items`（防重复派活的去重账本）。

可以在「设置 → 数据与归档」里搜索归档、把单个任务恢复回库。

## 运维接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 存活检查（公开） |
| `GET /api/bootstrap` | 前端首屏快照 |
| `GET /api/admin/overview` | 运行时长、队列、数据库大小、插件 / 通道状态 |
| `POST /api/admin/queue` | 暂停 / 恢复调度（写 `settings.queuePaused`） |
| `GET /api/admin/logs` | 内存日志环 |
| `GET /api/admin/backup` | WAL checkpoint 后下载 SQLite 文件 |
| `GET /api/admin/export` | 导出任务、记忆、规则和打码后的配置 |
| `GET /api/admin/archives` · `POST /api/admin/archive` · `POST /api/admin/archives/:name/restore` | 归档列表、立即归档、恢复 |
| `GET /api/update/status\|check` · `POST /api/update/apply\|rollback` | 在线升级 |

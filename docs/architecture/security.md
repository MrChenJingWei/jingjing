# 配对、工作区与安全边界

> 代码：`src/auth.js` · `server.js` · `src/workers.js` · `src/discovery.js` · `src/relay.js`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 配对与访问

- 首次启动在 `<data>/access-key` 生成配对码（20 位，分组显示）；
- 浏览器通过 `POST /api/auth/login` 换取 HttpOnly Cookie；脚本和外部客户端用 `Authorization: Bearer <配对码>`；
- `/pair?key=…` 是主机 App 打开浏览器时用的自动登录入口：校验后种 Cookie 并 302 回首页；
- 不需要配对的只有：`/api/health`、`/api/auth/status|login|logout`、`/api/hooks/<token>`（token 即凭据）、`/api/runs/<id>/report`（一次性令牌）；其余所有 `/api/*`（包括 SSE）都需要；
- 登录按 IP 限流（5 分钟 10 次）；重新生成配对码（`POST /api/auth/rotate`）会立即让所有设备失效；
- 静态资源（登录页、PWA 外壳）公开，里面的数据请求全部需要配对。

## 网络

- 服务默认只监听 `127.0.0.1`；开放到局域网需要显式设 `JINGJING_HOST=0.0.0.0`；
- 手机访问推荐 Tailscale，见 [MOBILE.md](../MOBILE.md)。

## 工作区

- `settings.workspaces` 保存命名目录（可以挂额外文件夹），`defaultWorkspaceId` 是兜底；设置页用 macOS 原生文件夹选择器添加；
- `source_plugins.workspace_id` 记录每个来源绑定的工作区，插件配置里的 `workspace` 字段（比如 TAPD 每个项目一个）是更细的绑定；建任务时解析出工作区写入 `tasks.cwd`；
- 条目也可以带 `workspace`（工作区 id）：只认 `settings.workspaces` 里已有的 id，找不到就按没带处理，所以插件指不到任意目录；
- 删除工作区时，失效的插件绑定会被清空；组里的失效工作区在下次建任务时回落到来源绑定的 / 默认工作区。

**工作区只决定任务的 `cwd`，不是权限边界**：Worker 以当前 macOS 账户运行，文件权限和工具权限由系统、Claude Code / Codex 自身配置决定，静静不注入工具白名单或权限模式。

## 谁能决定什么

| 能力 | 主人（Web、配对的 Telegram） | 外部来源（邮件、群消息、Webhook） |
| --- | --- | --- |
| 点名 Worker | 可以 | 不算；点名了别的 Worker 时先问主人 |
| 模型挑 Worker | 可以（要有原文依据） | 不算 |
| 按文字推断能力 | 可以 | 不算 |
| 用哪个工作区 | 可以 | 只能从主人建好的工作区里选一个 id（条目带 `workspace` 时），不能带路径 |
| 工作流程 / 分配规则 | 生效 | 生效（这是主人配的） |
| 拍板、接着做、取消 | 可以 | 只有策略里 `owners` 列出的人，经 `relay.interact()` 核对 |

能让有工具能力的 Worker 处理外部内容的，只有主人自己配的工作流程和分配规则。Telegram 只认设置里的 Chat ID。

## 执行边界

- `shell` / `file` Worker 只在任务工作区里移动或写入文件，目标路径越出工作区（`isInside` 校验）直接失败；
- Claude Code 以 `claude -p` 运行，工具权限交给 Claude Code 自身的用户配置，静静不追加权限参数，也不使用 `--dangerously-skip-permissions`；
- 第三方 Worker 插件的 `execute` 在独立线程里运行，取消 / 超时后强制结束；但它仍是同一个 Node 进程、同一个系统账户，能读写本机文件，**不是安全沙箱**；
- 来源插件在主线程运行，各入口有宿主强制的时间上限，但同步死循环仍会卡住整个服务；
- 只安装可信插件；manifest 里的 `capabilities` 只是声明，不做强制。

## 凭据

- 模型 Key、通知通道凭据存在本机 SQLite；接口返回时打码（`••••••••`），保存时遇到打码值保留原值；
- 插件拿到的设置（`ctx.settings`）里没有模型 Key 和通道凭据；要调模型走宿主的 `ctx.llm.chat()`，Key 不出宿主；
- Worker 回传令牌库里只存 sha256，执行结束即失效；
- 导出配置（`/api/admin/export`）是打码后的。

## 内容渲染

页面渲染对模型输出做 HTML 转义，Markdown 只支持白名单语法。

## 升级

在线升级包校验 sha256，配置了公钥时校验签名（`JINGJING_UPDATE_PUBKEY`）；解压时拒绝越界路径（`isSafeEntry`）。见 [进程与运行时 · 升级](runtime.md#升级)。

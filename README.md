# 静静

> 一个住在你自己电脑里的个人 AI 工作站。  
> Router 负责判断，调度器负责把事办完，Worker 负责动手，记忆留在本机。

静静是把一段关于「个人 AI 管家」的讨论落成的可运行 MVP：**手机可以遥控、任务会停下来等你拍板、Agent 跑完就退出、记忆写进本地 SQLite**。邮箱、日历这类「任务从哪里被发现」的能力做成了插件，想加 RSS、GitHub 通知，写一个目录丢进去就行。

它现在能完整跑通这条闭环：

```
你说一句话
  → Router 判断这是聊天 / 记忆 / 任务 / 查进度
  → 任务交给调度器排队
  → 对应的 Worker 执行，实时进度回到对话
  → 需要你确认时，进程退出、状态落库、发通知
  → 你点一下，调度器从挂起点恢复，接着原来的上下文继续
  → 结果写回对话，并沉淀成一条情景记忆
```

---

## 界面

桌面是「左侧栏 + 内容区」：侧栏放导航和正在发生的事（等你拍板、进行中），任务页左边列表、右边详情，设置页左边分类、右边内容。窗口拉窄或在手机上打开，自动换成底部标签栏的单列布局。

| 对话 | 任务（列表 + 详情） |
| --- | --- |
| ![对话](docs/screenshots/chat.png) | ![任务](docs/screenshots/tasks.png) |
| ![在对话里拍板](docs/screenshots/approval.png) | ![从对话里看任务详情](docs/screenshots/drawer.png) |
| ![记忆](docs/screenshots/memory.png) | ![任务来源](docs/screenshots/plugins.png) |
| ![运行状态](docs/screenshots/admin.png) | ![手机](docs/screenshots/install.png) |

<sub>深色模式见 [docs/screenshots/chat-dark.png](docs/screenshots/chat-dark.png)。快捷键：⌘1–4 切换对话 / 任务 / 记忆 / 设置，`/` 聚焦输入框或搜索框，设置页 ⌘S 保存，Esc 关闭详情。</sub>

系统架构图：[docs/diagrams/architecture.png](docs/diagrams/architecture.png)（可编辑源：[architecture.html](docs/diagrams/architecture.html)）

---

## 安装

三种方式任选一种。装完都能用同一个界面、同一套数据格式。

### 1. macOS App（推荐：菜单栏常驻 + 原生窗口 + 系统通知）

Apple Silicon（M 系列）。一条命令装好：

```bash
curl -fsSL https://github.com/MrChenJingWei/jingjing/releases/latest/download/install.sh | bash -s -- --app
```

也可以直接下载 Release 里的 `jingjing-<版本>-macos-arm64.pkg` 双击安装，或解压对应的 zip 把「静静.app」拖进「应用程序」。

装好后数据在 `~/Library/Application Support/Jingjing/`，配对码在同目录的 `access-key`。安装包没有 Apple 公证，第一次打开需要右键 →「打开」。

### 2. 命令行版（macOS / Linux）

```bash
curl -fsSL https://github.com/MrChenJingWei/jingjing/releases/latest/download/install.sh | bash
```

脚本会读取最新 Release、校验 sha256、装到用户目录（macOS 默认 `~/Library/Application Support/Jingjing/cli`，Linux 默认 `~/.local/share/jingjing`）；本机没有 Node.js 23.4+ 时自动下载官方 Node 24，所以**不需要预装 Node，也不需要 sudo**。

装好后：

```bash
jingjing                    # 前台启动，然后打开 http://127.0.0.1:7777
jingjing url                # 打印带配对码的地址
jingjing service install    # macOS：装成 LaunchAgent，开机自启、崩溃自动拉起
jingjing status             # 看服务是否在跑
```

数据目录是 `<安装目录>/data`；脚本会提示把 `<安装目录>/bin` 加进 PATH，之后就能直接用 `jingjing`。

常用参数：`--version v0.3.1` 装指定版本，`--prefix <目录>` 换安装位置，`--port` / `--host` 改监听，`--dry-run` 只演练，`--no-node` 禁止自动下载 Node。完整说明见 `bash scripts/install.sh --help`。

### 3. 从源码跑

要求 Node.js **23.4+**（用到了内置的 `node:sqlite`，推荐 24），不需要安装任何依赖。

```bash
git clone https://github.com/MrChenJingWei/jingjing.git
cd jingjing
npm start
```

打开 <http://127.0.0.1:7777>。

---

## 第一次使用

第一次打开需要配对码，它保存在数据目录的 `access-key`（从源码跑就是 `data/access-key`，命令行版是 `<安装目录>/data/access-key`）：

```bash
cat data/access-key
```

也可以直接打开 `http://127.0.0.1:7777/pair?key=<配对码>` 自动登录。配对码同时用于手机访问和 API。

首次启动会自动生成演示数据：5 条记忆、2 个任务，其中一个正在等你拍板（整理沙箱里的「下载」文件夹）。直接点「归档」就能看到**挂起 → 恢复 → 完成**的完整过程。

> 演示模式不需要任何 API Key，Router 的意图识别和 Worker 输出都由本地逻辑模拟，但任务、审批、记忆、事件日志都是真实写入 SQLite 的。

清空演示数据并重新开始：

```bash
# 先停掉服务
npm run reset
npm start
```

跑测试（日历解析、IMAP 协议、MIME 正文、插件规范）：

```bash
npm test
npm run plugin:check
```

---

## 它做了什么

### 1. Router：只判断，不干活

`src/router.js` 接收你从网页 / Telegram 发来的每一条消息，判断它属于：

| 意图 | 行为 |
| --- | --- |
| `chat` | 带上记忆和任务板上下文回答，不创建任务 |
| `remember` | 抽取偏好/事实，写进画像或语义记忆 |
| `task` | 选一个 Worker，交给调度器，并在对话里生成任务卡 |
| `status` | 汇总进行中 / 等你拍板 / 最近完成 |
| `recall` | 检索记忆库 |

演示模式用规则分类；接入 DeepSeek / Ollama 后会改为让模型输出 JSON 意图。Router **不启动任何 Agent 进程**，它只负责“该不该做、交给谁”。

### 2. 调度器：工头，负责“挂起零消耗”

`src/scheduler.js` 是整套东西的核心：

- **队列与并发**：按优先级取任务，默认同时跑 2 个。
- **挂起零消耗**：Worker 需要你拍板时返回 `needs_approval`，调度器把审批写进 `approvals` 表，任务状态变成 `waiting_approval`，**Worker 进程此时已经退出**。不占 CPU、不烧 token。
- **恢复执行**：你点选项后，审批结果写进任务的 `resume_payload`，任务重新入队，Worker 带着“你选了什么”重新启动，从原来的上下文继续。
- **事件溯源**：每一次创建、开始、等待、拍板、重试、完成都追加到 `task_events`，任务详情里就是一条可回放的时间线。
- **超时、重试与熔断**：每个 Worker 自带运行限制（超时、最多同时运行几个、失败重试几次），可在设置里按主机覆盖。问答/文件生成失败会重试 1 次，编码类 Agent 默认不重试，超时一律不重试；单个任务最多恢复 6 次（`maxHops`），防止 Agent 在“问—答—再问”里循环。
- **取消就是取消**：取消或超时后调度器立刻释放槽位，Worker 晚到的结果会被丢弃，不会把任务改回完成或重新排队。
- **生命周期在本地还原**：任务状态只能按固定路线变化（比如已取消的任务不能被改成已完成）；每次执行有一条运行记录（第几次、心跳、Worker 存的断点、结束原因），任务详情里能看到。服务重启时，被打断的任务按 Worker 声明的方式还原：带断点继续、直接重跑，或者问你要不要重跑；同一任务连续被打断 3 次就停下，避免崩溃循环。
- **进度由 Worker 回传**：Worker 可以在进程内上报进度，外部进程用 `POST /api/runs/<id>/report`（凭本次执行的令牌）回传进度和断点；不回传的显示「等待回传」和已运行时长。Claude Code 会实时显示它在读哪个文件、跑什么命令。
- **崩溃恢复**：服务重启时，把卡在 `running` 的任务放回队列，而不是假装它还在跑。

### 3. Worker：无状态、可替换、全部插件化

每个 Worker 都只做一件事：拿到任务，跑一轮，返回结果，退出。内置 Worker 和第三方 Worker 是同一种插件包（`plugin.json` + `index.js`），内置的放在 `workers/<id>/`，随在线升级一起更新；它们只通过 `execute(task, ctx)` 的 `ctx` 使用宿主能力。

| Worker | 能力 | 说明 |
| --- | --- | --- |
| `llm` | text | 问答、分析、总结、起草；只输出文本，演示模式本地生成 |
| `file` | write-file | 让模型生成一份文本文件，写入任务工作区 |
| `shell` | manage-files | 扫描工作区并按类型归档，动手前先请你确认 |
| `claude` | code / write-file / manage-files / text | 调用本机 `claude -p`，支持 `--resume` 续跑 |
| `codex` | 同上 | 调用本机 `codex exec`（需自行安装） |
| `dsh` | 同上 | 以 `dsh headless --json` 运行，工具调用和输出会实时显示在任务卡上；自动找 PATH 里的 `dsh` 或「应用程序」里的 DeepSeek Harness.app，需要在设置里填 DeepSeek API Key |

Router 不认具体的 Worker id，只按能力派活（`src/worker-routing.js`）：文本需要什么能力，就在可用的 Worker 里挑具备该能力、开销（`cost`）最低的一个；插件还可以声明 `keywords`，被点名时优先。所以装上一个新的 Worker 插件，不用改任何核心代码就能被自动派到活。

任何外部 Agent 都可以通过约定接入：需要人拍板时，在输出的最后单独写一行

```
[[APPROVAL]] {"question":"要覆盖这个文件吗？","options":["覆盖","换个名字"]}
```

调度器会识别它并进入挂起流程。

### 4. 记忆：三层，全部在本机

`src/memory.js` 使用 SQLite + FTS5（trigram，中文可搜）：

- `profile`：你的长期偏好、作息、习惯。
- `semantic`：事实、项目、常用信息。
- `episodic`：发生过的决定和任务结果。

记忆分两类，存在同一张表里（`memories.domain`）：

- **业务记忆**（`work`）：你的偏好、项目、做事经验。Router 派活、Worker 执行时用；「记住……」和任务结果都写在这里。
- **人格记忆**（`persona`）：静静自己的设定、她在外面认识的人和聊过的事。只在她以自己的身份说话时用（比如群里有人找她闲聊）；任务和 Worker 拿不到，外面的人也拿不到业务记忆。

对话时 Router 会注入相关记忆（两类分开写）；任务完成后自动写回一条情景记忆；你可以在「记忆」页切换两类，搜索、补充、删除，或把一条改到另一类。**没有任何一条记忆会离开这台机器**，除非你主动接入了云端模型或通知通道。

### 4.1 静静的心智：记得住、有心情、认得人、会成长

参考了几种心理学上的记忆和情绪模型，让她更像一个真实的人。所有计算都是确定的（遗忘曲线、检索打分、心情变化都是公式和词表），模型只用来整理和反思；没接模型时一样会记事、有心情，只是整理得粗一些、不做反思。

| 机制 | 依据 | 做什么 |
| --- | --- | --- |
| 工作记忆 | 短时记忆容量有限 | 每次带最近 12 句原话（真正的多轮对话），更早的压成一段滚动摘要一直带着 |
| 情景记忆 | 自传体记忆 | 对话停下来几分钟或攒够 6 句，就把这段对话整理成「经历」和「事实」写进长期记忆，记下当时的情绪；外面的人和主人的分开记 |
| 回想 | Generative Agents 的记忆流检索 | 打分 = 相关（中文二元组）+ 新近 + 重要 + 情绪强度，挑出最相关的几条带进提示词 |
| 遗忘 | 艾宾浩斯遗忘曲线 | 保持率 R = e^(−t/S)：越久越模糊；每次被想起 S 变大（间隔效应），情绪强烈的记得更牢；说法不同的同一件事并成一条、记得更牢 |
| 心情 | PAD 情绪模型（愉悦 / 激活 / 掌控） | 被夸、被骂、任务成败、隔了几天才回来都会影响心情，半衰期 4 小时，自然地带进语气 |
| 社交记忆 | 对人的印象 | 记得外面每个人（企微等来源的发言人）：熟悉度、好感、印象、聊过什么；接得上上次的话，但绝不说主人的事，也不把别人的事往外说 |
| 巩固与反思 | 睡眠中的记忆巩固 | 每天一次（默认 03:30）：快忘光的经历归档、反复想起的经历变成事实，再让模型提炼对自己和主人的新认识、更新对人的印象、写一句日记 |
| 自我进化 | 自我概念 | 反思后可能调整人设：每次只改一点、三天最多一次，每一版都留历史可回退；设置里可以改成「先提议、你同意才改」或关掉 |

在「记忆 → 人格记忆」里能看到她此刻的心情、认识的人和上次反思；每条记忆旁边有「记得多清楚」和情绪标记，快忘光的在「已淡忘」里，点「想起来」能找回。设置 → 模型与人设里调进化方式、反思时间、要不要有心情，查看和回退人设的每一版。

### 5. 来源插件：把「发现」做成可插拔的

邮箱、日历不是写死在 Router 里的。`plugins/` 下每个目录就是一个来源插件：

```
plugins/
├── email-imap/    只读 IMAP → 新未读邮件
└── calendar/      ICS 订阅 → 接下来 24 小时的日程
```

插件只做两件事：拉数据、整形为条目。判断「要不要动手、交给谁、写成什么任务」由核心 `src/discovery.js` 负责。所以：

- 想加 RSS / GitHub 通知 / 公司内部系统，只需要照着 [插件文档](plugins/README.md) 写一个目录；
- 不信任某个来源，关掉开关即可，不会影响调度器和记忆；
- 插件失败只会更新自己的状态，不会拖垮主循环。

### 6. 通道：网页 + 手机

- 网页同时适配桌面和手机，本身就是 PWA，可以“添加到主屏幕”。
- 配好 Telegram Bot 后，审批卡片会发到手机，点按钮就能恢复主机上的任务；你也可以直接在 Telegram 里给静静发指令。静静只认设置里填的 Chat ID，别人给这个 Bot 发的消息会被忽略（服务日志里会记下对方的 Chat ID，第一次配置时可以从这里找到自己的）。
- 飞书 / 通用 Webhook 用于接收提醒（单向）。

---

## 主机 App（macOS）

安装方式见上面「安装」：从 Release 下载 `jingjing-<版本>-macos-arm64.pkg` 双击安装，或运行 `install.sh --app` 一条命令装好。目前只发布 Apple Silicon 的 App 包，Intel Mac 用命令行版。

打开后菜单栏出现「静静」，服务自动启动，第一次会自动打开静静的窗口并完成配对。菜单里还可以显示/复制配对码、打开手机安装二维码、切换「仅本机访问」、开机时启动、重启和看日志。

- **原生窗口**：对话、任务、记忆、设置都在静静自己的窗口里（和手机 PWA 是同一套界面，窗口宽时是侧栏布局，拉窄自动换成手机布局）。标题栏和侧栏连成一体，菜单「前往」或 ⌘1–4 切换页面。窗口开着时出现在 Dock 和 ⌘Tab 里，关掉后退回菜单栏、服务继续跑；**⌥⌘J** 随时唤出 / 收起。下载的归档、备份存到「下载」文件夹，外部链接用系统浏览器打开；想用浏览器也可以点菜单里的「在浏览器中打开」。
- **系统通知**：任务需要你拍板时弹 macOS 通知，选项不超过 3 个可以直接在通知上点选；任务完成 / 失败也会通知（窗口在前台时不弹）。Dock 图标和菜单栏上显示待拍板的数量。第一次需要发通知时才会请求通知权限。
- **服务跟着 App 走**：退出、被强制结束甚至崩溃时，后台服务都会一起停止，不会残留进程占着端口。
- **数据位置**：`~/Library/Application Support/Jingjing/`。
- **手机安装**：菜单栏「手机安装二维码…」，手机扫码 → 自动配对 → Chrome 里「安装应用」。iPhone 用 Safari「添加到主屏幕」。

App 没有经过 Apple 公证，第一次打开需要右键 →「打开」。完整步骤、Tailscale 和排错见 [docs/MOBILE.md](docs/MOBILE.md)。

自己打安装包（需要 Xcode 命令行工具）：

```bash
bash packaging/macos/build.sh
# 产物：dist/jingjing-<版本>-macos-<架构>.pkg / .zip
#      dist/jingjing-app-<版本>.zip、dist/latest.json（在线升级用）
```

开发时可以直接用仓库里的代码构建并运行 App（默认用仓库的 `data/` 和 7787 端口，不影响已安装的静静）：

```bash
bash packaging/macos/dev.sh
```

也可以用命令行常驻（和 App 二选一，不要同时跑）：

```bash
JINGJING_HOST=0.0.0.0 bash scripts/install-service.sh
```

---

## 在线升级

从 v0.3.0 起，设置 →「关于与更新」里可以检查并安装新版本：

- **检查**：请求 GitHub 最新 Release（`gh` 不需要；匿名 API 1 次/小时，带 ETag 缓存，避免触发限流）。
- **校验**：只用 Release 里的 `latest.json` 清单，强制比对 `sha256`；设置 `JINGJING_UPDATE_PUBKEY`（Ed25519 公钥 PEM）后会额外验签，签名消息是 `版本号\nsha256`。
- **安装**：安装到数据目录 `~/Library/Application Support/Jingjing/updates/<版本>/`，不覆盖 App 包、不动数据库、不需要管理员权限。
- **生效**：装完在菜单栏点「重启服务」。启动时 `server.js` 发现数据目录里版本更高，就交给它运行；如果新版本启动后 15 秒内崩溃，会标记失效并在下次启动自动回退内置版本。
- **回滚**：关于页有「回退版本」，回到上一版或内置版本。

升级只覆盖代码层（`server.js`、`src/`、`public/`、`plugins/`）。Swift 菜单栏宿主和内置 Node 运行时的变更仍需重新安装 pkg/zip。

### 发布一个版本

版本号只写在 `package.json`，其余位置（健康检查、界面、`Info.plist`、安装包文件名）都从它读取。流程：

```bash
# 1. 改 package.json 的 version
# 2. 提交并打 tag，推送后由 GitHub Actions 自动打包并发布
git commit -am "chore: release v0.3.1"
git tag v0.3.1
git push origin main --tags
```

工作流 [.github/workflows/release.yml](.github/workflows/release.yml) 会先跑测试，然后分两个 job 发布：

- `release`（ubuntu）：`dist/jingjing-app-<版本>.zip`、`dist/latest.json`（含 sha256）、`scripts/install.sh`；
- `macos-app`（macos-latest / arm64，最低支持的系统版本按 `Info.plist` 编译）：`jingjing-<版本>-macos-arm64.pkg`、同名 zip、`SHA256SUMS`。

本地想验证发布产物：

```bash
npm test
bash scripts/package-update.sh   # 在线升级包：dist/
bash packaging/macos/build.sh    # App + pkg + zip（需要 macOS）
```

### 用镜像或本地模拟源调试

```bash
JINGJING_UPDATE_REPO=owner/repo \
JINGJING_UPDATE_API_BASE=https://api.github.com \
npm start
```

把 `JINGJING_UPDATE_API_BASE` 指向一个本地假 GitHub API（提供 `repos/:owner/:repo/releases/latest` 和清单/压缩包），就能完整演练检查、安装、重启和回滚。

---

## 运维：任务页 + 设置 → 系统

原来单独的「管理」页拆回了它该在的地方：

- **任务管理**（任务页）：按状态筛选、搜索；右侧详情里停止、重试 / 重跑、编辑标题 / 指令 / Worker / 优先级、删除任务及其事件与审批，改 Worker 和工作目录；
- **队列控制**（任务页右上角，侧栏底部也能看到状态）：一键暂停 / 恢复调度，暂停后新任务只排队、不执行；
- **运行状态**（设置 → 系统）：运行时长、进行中、今日完成、tokens、记忆、Worker、来源、数据库大小和实时连接数，以及最近 200 条服务日志；
- **数据与归档**（设置 → 系统）：下载 SQLite 数据库（可直接替换恢复）、导出不含密钥的 JSON、归档旧数据；
- **助手人设**（设置 → 模型与人设）：一段注入 Router 和 Worker 系统提示词的文字，保存后立即生效；
- **记忆维护**（记忆页）：按层筛选，编辑内容、层级和重要度。

![运行状态](docs/screenshots/admin.png)

## 工作区：每个来源绑定一个落点

任务来源决定「发现什么」，工作区决定「在哪个目录里干活」。设置 → 工作区里可以维护多个目录，点「选择」会打开 macOS 原生文件夹选择器；每个来源插件卡片上都有「任务工作区」下拉框，可以单独绑定，也可以直接选「自定义文件夹」。任务详情里同样可以改工作目录并应用。

- 没绑定的来源跟随默认工作区；
- 聊天框上方有「工作区」下拉：选中的工作区优先，会记住上次的选择，也可以临时选「自定义文件夹」；不选时按下面顺序：消息里点名的 > 流程指定的 > 默认工作区；
- 新建任务时，`cwd` 使用来源绑定的工作区，任务详情里能看到并修改工作目录（运行中的任务只读）；
- 插件不能自己指定目录，工作区由静静统一管理；
- 工作区只决定起点，不限制 Worker 能访问哪些目录；文件权限由 macOS 账户和 Worker CLI 自己的配置决定；
- 从任务学出来的流程不会把「默认工作区」写死进去，只有确实用了别的工作区才记下；这些流程也不会覆盖聊天里点名的工作区；
- 删除一个仍被插件使用的工作区时，那些插件会自动回到默认工作区。


## Worker 插件

Worker 是执行器，不是任务来源。内置 Worker 包括：问答、文件操作、文件生成、Claude Code、Codex、DeepSeek Harness。记忆（记住、检索、整理）是静静内置的功能，不是 Worker。

- 每个 Worker 右侧都有启用开关：关掉后它不再接任务，但仍留在列表里，随时能打开；自己装的 Worker 插件还可以删除；
- 也可以安装 `kind: "worker"` 的插件，接入自己主机上的 Agent/CLI；manifest 里用 `worker` 段声明能力、开销、关键词和运行限制，写法见 [plugins/README.md](plugins/README.md#worker-插件)，模板在 `plugins/.template-worker/`；
- 每个 Worker（包括内置的）都可以在设置里调整超时、最多同时运行几个、失败重试几次；插件还有独立配置和 `detect()`，可以按主机环境判断是否可用；
- Worker 插件以当前 macOS 用户权限运行，静静不控制它的工具权限。

DeepSeek Harness 已经是内置 Worker，任务里选「DeepSeek Harness」即可用 `dsh headless --json` 执行。只装了桌面 App、没有装命令行工具也能用，静静会直接调用 App 自带的 `dsh`；无头模式不读桌面版的登录状态，要用设置 → 模型里的 DeepSeek API Key。它跑起来以后，每一步工具调用、每段输出都会作为进度实时更新到对话里的任务卡（不用等全部结束）。

## 官方插件、我的插件，以及让静静自己写插件

- **官方插件**：项目维护的常用来源插件 / Worker 插件（邮箱、日历、Webhook、企业微信……），随静静发布和在线升级，只读；想改就「复制为我的插件」。
- **我的插件**：自己安装的、自己写的、让静静写的，放在数据目录，升级永远不会覆盖；和官方同 id 时覆盖官方，随时可以「恢复官方版本」。
- **让静静写**：对它说「写一个拉取 RSS 的来源插件」，或在插件页点「让静静写一个」。它会交给 Claude Code / Codex 等编码 Worker（没有的话用云端模型）在草稿目录里写，自动检查（规范、不重名、只用 Node 自带模块、能正常加载），没通过就让它接着修；通过后把代码给你看，**你点「安装」才会装上**。官方已经有类似插件时会先提示你用官方的。

细节和维护流程见 [plugins/README.md](plugins/README.md)。


### Worker 分配规则

设置 → Worker → 「添加规则」，可以按正则、来源、事件类型和工作区把任务分配给指定 Worker。规则从上到下匹配，第一条命中的生效；手动明确指定 Worker 的任务不经过规则。

来源插件发现的条目（邮件、企微、Webhook……）是外人写的，不能自己指定 Worker：消息里点名的、模型挑的、按文字推断出的能力都不算，只看工作流程指定的 Worker 和这里的分配规则，都没命中就交给开销最低的文本 Worker。想让某类外部消息交给 Claude Code 这类能调工具的 Worker，就配一条工作流程或分配规则。外部消息点名了某个 Worker（比如「用 codex 查本地代码」）或明显要读写代码时，静静会先停下问你交给谁，卡片上选「以后这类都交给它」就会自动建好这条规则。

示例：

- 正则 `github|pull request` + 来源 `plugin:*` → Claude Code
- 正则 `桌面|Desktop` → 文件生成
- 正则 `发票|invoice` + 来源 `plugin:email-imap` → 文件生成

来源支持 `web`、`plugin:*`、`plugin:email-imap` 等；事件类型支持 `email.unread`、`issues.*`、`*`。同一来源同一事项在排队时会合并成一条任务；事件的 `hops` 超过 8 层不再继续派发。规则里的 Worker 不可用时会被跳过，继续走默认 Router 判断。

## 工作流程与习惯

工作流程描述「遇到什么请求 → 派给哪个 Worker、在哪个工作区 → 按什么步骤做」。每个流程是一个 Markdown 文件：

```markdown
---
name: 写周报
when: 周报, weekly        # 触发词：逗号分隔，每段都可以是正则
worker: file              # 可选：派给哪个 Worker
workspace: 默认工作区      # 可选：工作区名称或 id
---

1. 汇总本周完成的任务，按项目分组
2. 每个项目写一句结论和下周计划
3. 保存为 周报-日期.md
```

- **读取你写好的流程**：设置 → 工作流程 → 「读取的文件夹」里填上放流程文档的文件夹（最多读 3 层、300 个 `.md`）。头部可以不写：没有 `when` 时按标题模糊匹配（比如「部署流程.md」能认出「帮我部署一下」）。静静**只读不改**这些文件，停用只记在本机；改完文件几秒内自动生效。
- **派活**：消息命中生效的流程时，不再让模型猜意图和 Worker，直接按流程派活，步骤会附在交给 Worker 的指令末尾。优先级：流程指定的 Worker > Worker 分配规则 > 按能力挑选。明显是提问（以「？」「吗」结尾）、要记东西或问进度的消息不套流程。来源插件发现的事项同样会匹配流程，并且只会交给流程（或分配规则）指定的 Worker，消息里点名的 Worker 不算数。
- **学习习惯**：对话或手动发起的任务完成后，如果过程不是一问一答（用了非纯文本 Worker、中途拍过板、被你改过 Worker 或重试过），静静会把经过总结成一个**候选习惯**，写到 `<数据目录>/workflows/learned/`，并在对话里发一张卡片：「保存为习惯 / 先改一改 / 忽略」。确认后同类请求就按它执行；忽略的不会再提议。任何完成的任务也可以在详情里手动点「总结成工作流程」。接了云端模型时由模型提炼步骤和触发词，演示模式按事件时间线生成。
- 每个流程会统计用过几次、成功几次，显示在设置页里。
- **自动拍板（可选）**：习惯会记下当时每个问题怎么选的（`answers: 要把这 \d+ 个文件归档吗？ => 归档`）。在设置 → 工作流程里打开它的「自动拍板」后，按这个习惯执行的任务遇到同样的问题会直接替你选，对话里留一句说明；遇到没记过的问题、或选项对不上时照常停下等你。默认关闭。

## 旧数据归档

设置 → 数据与归档 → 归档旧数据。已结束超过保留天数（默认 90 天）的任务，连同事件、审批、执行记录和同期的旧对话，会先打包成 `<数据目录>/archive/archive-<时间>.jsonl.gz`，读回校验无误后才从数据库删除；默认每天自动检查一次。记忆和来源去重记录不清理（后者删了会让旧邮件被重新派活）。归档可以下载、按任务 id 或标题搜索，也可以把单个任务恢复回数据库。

## 设置：左边分类，右边内容

桌面上设置分两栏：左边按「助手 / 来源与通知 / 系统」分组列出所有分类，旁边带一个小标记（比如 Worker 可用数、待确认的候选习惯、出错的来源）；右边是当前分类的内容，点左边直接切换，不用一层层返回。手机上先显示分类列表，点进去再看内容。

只有表单类分类（模型与人设、调度器、通知通道）用顶部的「保存」（也可以按 ⌘S），改了没保存就切走会先问；Worker、来源、自动化这类开关和操作都是即时生效的。来源可以直接在列表里开关，缺必填配置时会直接带你进去填。

![设置入口](docs/screenshots/settings.png)

## 接入真实模型

打开「设置 → 模型与人设」：

- **DeepSeek**：填 API Key（默认 `https://api.deepseek.com`，模型 `deepseek-chat`）。Key 存在本机 SQLite 里。
- **Ollama**：填本机地址（默认 `http://127.0.0.1:11434`）和模型名，例如 `qwen2.5:7b`。
- 保存后 Router 会改用模型做意图识别，`llm` Worker 也会走真实模型。

模型连不上时，对话会回退到本地演示回复，不会让你卡在错误里。

---

## 主动发现

现在有两条并行的发现路径。

### A. 来源插件（设置 → 任务来源）

随包提供 3 个，默认关闭：

| 插件 | 需要的配置 | 它会做什么 |
| --- | --- | --- |
| 邮箱（IMAP） | 服务器、账号、授权码 | 只读拉取新未读邮件，按 UID 游标增量处理，判断是否需要回复/跟进 |
| 日历（ICS） | 一个只读的 ICS 订阅地址 | 用 ETag 缓存订阅，发现接下来 N 小时的日程，生成「准备日程」任务 |
| Webhook 接收 | 无；启用后自动生成地址 | 接收外部服务 POST 的 JSON，转成条目并建任务 |

每个插件都可以单独启用、填配置、测试连接、立即扫描。来源分成几种类型，频率也按来源单独配置：

- **轮询**（邮箱、日历）：每个插件有自己的「获取频率」，不是全局值；
- **Webhook 推送**：外部事件触发，没有轮询；
- **长连接**（企业微信）：常驻连接、自动重连，没有轮询；
- **手动**：只在点「立即扫描」时运行。

同一类来源可以添加多份实例（多个邮箱、多个日历、多个 Webhook、多个企微机器人）；每份实例有独立的配置、频率、工作区和状态。插件详情里能看到最近处理、运行历史和连续失败后的自动退避。插件把条目交给核心后：

1. 按 `externalId` 去重，扫过的不会再建任务；
2. 批量交给模型判断「要不要行动」，模型不可用时退回关键词规则；
3. 需要行动的建任务并在对话里汇总，不需要的静默跳过；
4. 插件状态（上次运行、结果、错误）在设置页可见。

插件开发看 [plugins/README.md](plugins/README.md)。manifest 有 JSON Schema（`plugins/plugin.schema.json`），`plugins/.template/` 是模板；写完跑 `npm run plugin:check` 做规范检查，加载失败会直接显示在设置页。

**安装不需要重新打包**：所有插件都在数据目录（命令行版 `data/plugins/`，App 版 `~/Library/Application Support/Jingjing/plugins/`）。安装包自带插件会在首次启动时复制进去，之后不再区分内置和外部；所有插件都能删除，在设置 → 任务来源 →「安装插件」上传 zip 即可。

**入站 Webhook**：随包提供「Webhook 接收」插件，启用后卡片里会生成一个 `POST /api/hooks/<token>` 地址。外部服务把 JSON POST 过去，插件只负责转成通用条目，去重、判断、建任务仍由静静处理。

**企业微信智能机器人**：官方插件，默认停用，用 WebSocket 长连接接收单聊/群聊 `@机器人` 消息，不需要公网 IP。安装和配置见 [plugin-src/wecom/README.md](plugin-src/wecom/README.md)。

### B. 自动化：按时间自己跑

设置 → 自动化里可以加规则，不用改代码。每条规则 = **触发器 + 动作**：

- 触发器：每天固定时间（到点后 3 小时内补跑一次）或每隔 N 分钟；
- 动作一：**创建一个任务**——写一段给 Worker 的指令，可选工作流程 / Worker / 工作区。比如「每天 08:00 用 tapd-cli 汇总我名下未完成的需求和 bug」；
- 动作二：**扫描一个来源**——选一个来源插件，可选「新条目按某个工作流程处理」和「强制 Worker」。执行时立刻扫一遍，新条目不再让模型判断，直接按流程建卡；`source_items` 按 `externalId` 去重，同一条不会重复建卡。

典型用法是 TAPD 夜间修复：TAPD 来源插件 + 工作流程「TAPD bug 修复」（worker: dsh，workspace: 渔童）+ 每天 02:30 的扫描动作，早上在对话里看报告。细节和护栏见 [docs/AUTOMATION.md](docs/AUTOMATION.md)。

---

## 目录结构

```
jingjing/
├── server.js              HTTP + SSE + 静态资源
├── src/
│   ├── config.js          路径、默认设置、状态文案
│   ├── db.js              SQLite 连接、建表、设置读写
│   ├── events.js          SSE 事件总线
│   ├── memory.js          分层记忆与中文检索
│   ├── llm.js             意图识别 + 模型适配 + 演示回复
│   ├── workers.js         Worker 注册表、宿主 API（ctx）、运行限制
│   ├── worker-routing.js  按能力 / 开销 / 关键词挑 Worker
│   ├── workflows.js       工作流程：读取 .md、匹配、学习习惯、自动拍板
│   ├── lifecycle.js       任务状态规则、运行记录、断点、回传令牌
│   ├── worker-runtime.js  不依赖数据库的 Worker 工具函数（主线程和插件线程共用）
│   ├── worker-thread.js   第三方 Worker 插件的执行线程
│   ├── archive.js         旧数据打包、清理、搜索、恢复
│   ├── scheduler.js       队列、挂起恢复、事件日志、重试
│   ├── router.js          Router、规则、对话
│   ├── plugins.js         插件加载（官方 + 我的）、配置、状态
│   ├── plugin-spec.js     manifest / config 规范校验
│   ├── plugin-forge.js    插件工坊：让静静写插件、检查、确认后安装
│   ├── plugin-probe.js    检查插件草稿用的隔离线程
│   ├── discovery.js       去重、模型判断、建任务
│   ├── channels.js        Telegram / 飞书 / Webhook
│   ├── auth.js            配对码、会话 Cookie、限流
│   ├── version.js         版本号唯一来源与 semver 比较
│   ├── overlay.js         启动时切换到数据目录里的新版本
│   ├── update.js          Release 检查、下载校验、安装与回滚
│   └── seed.js            演示数据
├── workers/               内置 Worker（和 Worker 插件同一种格式）
│   ├── llm/ file/ shell/ memory/
│   └── claude/ codex/ dsh/
├── plugins/               官方插件（随 App 发布，只读）
│   ├── plugin.schema.json manifest 的 JSON Schema
│   ├── AUTHORING.md       精简编写规范（静静写插件时交给编码 Agent）
│   ├── .template/         新来源插件模板
│   ├── .template-worker/  新 Worker 插件模板
│   ├── email-imap/        IMAP 客户端 + MIME 解析
│   ├── calendar/          ICS 解析 + 日程任务
│   ├── webhook/           通用 Webhook 接收
│   └── wecom/             企业微信（构建产物，源码在 plugin-src/wecom）
├── plugin-src/            带 npm 依赖的官方插件源码，npm run plugins:build 打包到 plugins/
├── packaging/macos/       Swift 菜单栏 App + 打包脚本
├── .github/workflows/     tag 触发：测试、打包升级包、发 Release
├── scripts/               常驻服务安装 / 卸载 / 重置 / 升级包打包
├── tests/                 日历、IMAP、MIME 测试
├── docs/                  静静本体文档：架构、自动化、主机与手机
│   └── diagrams/          架构图（PNG + HTML 源）
├── public/                Web 界面 / PWA（桌面和手机自适应；js/ 下按页面拆分）
├── dist/                  构建出来的 pkg / zip（不入库）
├── data/                  SQLite、沙箱、日志（不入库）
```

更细的时序、状态机和数据表见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 设计取舍

- **不做“常驻 Agent”**：Agent 跑一轮就退出，连续性由调度器的事件日志负责。任何一个 Agent 崩了都不会拖垮系统。
- **审批不是弹窗，是一条状态**：审批存在于数据库里，所以服务重启、手机断网、你隔一天再点，都能恢复。
- **工作区只是起点，不是沙箱**：`shell`、Claude Code、Codex 都以你当前 macOS 账户运行；能访问哪些文件由系统权限和 CLI 自己的配置决定。给静静选目录前请自己确认权限边界。
- **本地优先**：任务、事件、记忆、设置都在 `data/jingjing.db`。没有账号，没有云端同步。
- **发现和执行分离**：插件只交数据，判断和建任务留在核心，所以来源可以随时增删而不影响调度器。
- **配对码是唯一入口**：主机和手机共用一个码；HTTP 是明文的，所以默认建议 Tailscale 或可信局域网。
- **Web 是主机界面**：主机 App 只做启动器和配对，不重复写一套 UI；手机是同一个 Web 的 PWA。
- **先跑通闭环，再长功能**：这一版刻意没有做多用户、向量数据库、邮件 OAuth、原生移动 App。

---

## 已知限制

- 演示模式的回复是本地模板，不代表模型能力。
- IMAP 插件用本地 mock 服务器验证了协议与正文解析，但真实邮箱（Gmail/QQ/163）需要你用自己的授权码试一次；它不读附件，也暂不支持 OAuth。
- 日历插件只展开常见的 `DAILY/WEEKLY/MONTHLY` 重复规则，复杂的 `BYDAY/BYMONTHDAY` 组合可能漏掉；不做写回。
- Telegram 的双向通道需要你自己建 Bot；飞书只做了 Webhook 单向提醒，按钮回调还没接。
- `claude` Worker 的权限参数是保守默认值，第一次用建议在一个测试仓库里跑。
- `codex` Worker 已实现但没有在真实环境验证。
- 来源插件在服务进程内运行，拥有当前用户权限；只安装你信得过的插件。
- PWA 在后台/锁屏时没有系统推送；后台通知需要配 Telegram，或后续接 Web Push / APNs。
- 主机 App 只支持 macOS，安装包没有 Apple 公证；Windows / Linux 还没有安装包。
- 在线升级只更新代码层，且默认只靠 HTTPS 与 sha256 保证完整性；要防篡改请配置 Ed25519 公钥验签。
- 热更新生效期间会多一个常驻的守护进程（负责转发信号与崩溃回退），内存约多占一个空载 Node 进程。
- 没有做「恢复备份」按钮：数据库备份需要停服务后手动替换文件。
- 没有做原生 Android / iOS 包，手机端是 PWA（Android 是真正的桌面安装）。

---

## 下一步可以做什么

1. **PWA 后台推送**：Web Push（Tailscale HTTPS）或接 FCM，让锁屏也能收到审批。
2. **更多来源插件**：RSS、GitHub 通知、飞书群消息，照 [plugins/README.md](plugins/README.md) 各写一个目录。
3. **主机 App 跨平台**：Windows / Linux 安装包，以及开机自启开关。
4. **记忆的自动整理**：定期把零散的情景记忆压缩成画像，淘汰过时偏好。
5. **任务依赖图**：让 Router 能派生子任务，调度器按 DAG 执行。
6. **多主机**：把 Worker 注册表拆成局域网内的执行节点，调度器统一排队。

---

静静不追求“什么都能做”。它先做到一件事：**你说的事，它记得住、接得下、卡住时会停下来等你，而你不在电脑前也能把它推完。**

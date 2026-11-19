# Router

> 代码：`src/router.js` · 依赖 `llm.js` `workflows.js` `worker-routing.js` `worker-rules.js` `routing-signals.js` `capabilities.js` `memory.js` `persona.js` `mind.js` `plugin-forge.js`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 职责

处理**主人自己说的话**，以及按时间触发的自动化：判断意图，要做事就选好 Worker、工作区、标题，交给调度器。

**做：**
- 主人对话：意图判断、闲聊回复、记住 / 回想、查进度、写插件；
- 派活：选 Worker、工作区、工作目录，`scheduler.createTask()`；
- 自动化：到点建任务，或让发现核心扫一个来源；
- 习惯学习：听 `task/finished`，统计流程效果，把值得记的任务提议成习惯；
- 主对话的消息读写（`postAssistant()` 也给其他模块用）。

**不做：**
- 不碰 `approvals` 表，不启动 Worker——执行全归 [调度器](scheduler.md)；
- 不处理外部来源的条目——那是 [发现核心](discovery.md)。

## 入口与触发

| 入口 | 触发方式 | 函数 |
| --- | --- | --- |
| Web 对话 | `POST /api/chat`，请求内同步完成（含等模型） | `handleMessage(text, { sessionId, source: 'web', workspaceId })` |
| Telegram | `channels.js` 收到主人消息后回调 | `handleMessage(text, { source: 'telegram' })` |
| 自动化 | 每 60 秒 `startProactiveLoop()` → `proactiveScan()` | `runRule(rule)` |
| 立即运行 | `POST /api/rules/:id/run` | `runRuleNow(id)` |
| 接着做 | `POST /api/tasks/:id/continue` | `continueTask(id, text, { mode })` → 调度器 |
| 任务结束 | 总线 `task/finished` | `onTaskFinished(task)` |

## 处理一句话

`handleMessage()` 分步：

1. **落库**：写一条 `messages(role=user)`；`mind.onOwnerMessage()` 按词表推一下心情、熟悉度（不调模型）。
2. **先看工作流程**：不是在提问（`？` / `吗` 结尾，或启发式判断为记东西、问进度、写插件）时，`workflows.matchWorkflow(text)` 命中就直接定为 `task`，跳过模型。
3. **判断意图**（没命中流程时）：
   - 模型支持工具调用：`routeWithTools()` 一次调用完成「判断 + 回答」。工具有 `create_task`、`create_plugin`、`remember`、`show_status`、`recall`；不调工具就是闲聊，回复直接拿来用，不用再调一次模型。
   - 不支持或调用失败：退回 `llm.classify()` 两步判断；演示模式用 `heuristicClassify()`。
4. **校验模型的选择**：
   - `evidence`（模型引用的原话）在原文里找不到 → 丢掉它选的 Worker；
   - 模型给的能力 id 必须在能力目录里；文本里直接点到的能力（`matchCapabilities`）一起收窄候选。
5. **按意图分支**：

   | 意图 | 做什么 |
   | --- | --- |
   | `remember` | `memory.extractFacts()` 抽事实，写 `memories`（`subject=owner`），推 `memory/created` |
   | `status` | 汇总队列、正在跑、待拍板 |
   | `recall` | 演示模式直接列记忆；接了模型走闲聊分支，带着记忆自然回答 |
   | `plugin` | 官方已有类似插件先提示；否则 `forge.createDraft()` 开草稿，见 [插件工坊](plugins.md#插件工坊) |
   | `task` | 见下面「派活」 |
   | 闲聊 | `chatSystemPrompt()` 拼人设（`persona.ownerSelf`）+ 记忆 + 摘要 + 最近原话调模型；顺手从这句话里抽偏好写记忆 |

6. **回复**：写一条 `messages(role=assistant, kind=task|text, task_id)`，推 `stats/updated`，返回给前端。

## 派活

意图为 `task` 时：

1. **工作流程**：第 2 步命中的流程，或模型挑的流程。
2. **工作区**：聊天框里选的 > 文字里点名的 > 流程指定的 > 兜底（`pickWorkspace`，默认工作区）。
3. **Worker**：按下面「选 Worker」的顺序裁决。
4. **工作目录**：只整理文件、不碰代码的 Worker（`manage-files` 且没有 `code`）落到文字里点名的子目录（`resolveFolderCwd`，比如「整理下载文件夹」）；其余用工作区路径。
5. **建任务**：`scheduler.createTask({ title, prompt: 原话 + 流程步骤, worker, cwd, origin: 'chat', priority: 2, workflowId })`。
6. 回复「我把「…」派给了「…」Worker，工作区是「…」」，附上点名 / 规则 / evidence 的说明。

## 选 Worker

原则是 **Agent 提名、代码裁决**：模型可以理解模糊说法并提出建议，但最终选择要经过代码校验，并且能解释。选择逻辑是纯函数（`worker-routing.js`），只看 Worker manifest 的声明，不认识任何具体的 Worker id。

### 决策顺序（主人的话）

只适用于主人自己的消息（Web、配对的 Telegram、拍板里自己写的决定）。外部来源的规则见 [发现核心 · 建任务](discovery.md#建任务)。

1. **明确点名**：文本命中某个 Worker 的 `aliases`（大小写、全半角、标点都不影响，按词边界匹配），或老插件的 `keywords` 正则。点名但不可用、或不具备所需硬能力时改派，并在回复里说明。
2. **工作流程指定的 Worker**：流程的 `worker` 字段优先于规则。
3. **分配规则**：命中的规则指定谁就是谁。
4. **模型选择**：模型给的 `worker` 必须同时满足：Worker 可用、具备所需硬能力、`evidence` 原文能在消息里找到（防幻觉）。任一条不满足就丢弃，继续往下。
5. **具体能力**：文本点到能力（`tapd-cli`、`git`…）时，声明了该能力的 Worker 优先；没人显式声明时，具 `shell` 能力（能执行本机命令）的 Worker 作为候选。
6. **硬能力兜底**：需要 `code` / `write-file` / `manage-files` 时，在具备该能力的 Worker 里按偏好选。
7. **兜底 Worker**：主人在设置里指定的，否则最便宜的可用文本 Worker。

偏好：开销低优先，同开销内置优先，再按 id 排序（保证结果稳定）。

### 每种信号谁说了算

| 信号 | 来源 | 控制方 |
| --- | --- | --- |
| 工作流程 / 分配规则 | 主人配置 | 代码（命中即用） |
| 别名点名 | Worker manifest + 本机配置 | 代码（归一化 + 词边界） |
| 模型选择 | Router 模型 | Agent 提名，代码校验 evidence / 可用性 / 硬能力 |
| 能力 | `src/capabilities.json` + 本机勾选 | 代码收窄候选 |
| 成本 | manifest 的 `cost` | 代码 |

### 冲突裁决

| 情况 | 结果 |
| --- | --- |
| 点名 A，模型 / 流程 / 规则说 B | A 赢；流程步骤、工作区保留 |
| 点名了但 A 不可用 / 不具备硬能力 | 改派并说明，不静默 |
| 模型选的 Worker 不满足文本点到的能力 | 丢弃模型选择，走能力候选 |
| 模型 evidence 在原文里找不到 | 丢弃模型选择 |
| 多个能力候选 | 模型的选择在候选里就用它，否则按偏好 |
| 外部来源出现点名 / 能力 / 模型信号 | 全部忽略，只认流程和规则；点名了别的 Worker 时先问主人 |

### 人话怎么变成规则

原则：人话在写入时编译成关键词，运行时只做归一化后的确定性匹配（`routing-signals.js`），不把用户的话直接当正则。

- **工作流程** `when`：默认按逗号 / 顿号 / 竖线拆成字面关键词；确实要正则时加 `whenRegex: true`；`notWhen` 排除问句和反例。
- **分配规则**：默认「关键词模式」（逗号 / 竖线分隔、自动转义）。
- **Worker 别名**：manifest 给默认，主人可以在「设置 → Worker → 配置」里加本机叫法。
- **能力**：内置目录在 `src/capabilities.json`；主人可以在 Worker 配置里勾选本机真能用的工具，自定义能力存在设置的 `capabilities` 里。

兼容老数据：老插件的 `keywords` 正则继续按点名工作；老流程的 `when` 默认按关键词解释，用了正则语法的要加 `whenRegex: true`；老分配规则没有 `pattern_mode` 时按正则解释。

### 已知边界

- 多个别名同时出现、或低置信时，还没有「这次交给 A 还是 B」的确认卡片；
- 质量 / 成本策略还没做成按能力配置；
- 自动探测本机工具（`which tapd`）并建议勾选能力，尚未实现。

## 自动化

自动化 = **触发器 + 动作**，在「设置 → 自动化」里加，不需要改代码。底层是 `rules` 表：`trigger`、`action` 两列 JSON，运行结果记在 `last_run / last_status / last_summary`。

### 触发器

到点判断在 `ruleDue()`：

| 类型 | 行为 |
| --- | --- |
| `daily` | 每天 `HH:MM` 到点后 3 小时内、当天还没跑过就执行一次；电脑睡过了窗口就不补 |
| `interval` | 距上次运行超过 N 分钟（1–1440）执行；同样要电脑醒着 |

### 动作

**建一个任务**（`kind: "task"`）：适合「每天 8 点汇总 TAPD 待办」这种不需要来源插件的定时活。

| 字段 | 含义 |
| --- | --- |
| `title` | 任务名，省略时用自动化名称 |
| `prompt` | 给 Worker 的指令 |
| `worker` | 可选；省略时用流程指定的，再省略用兜底 Worker |
| `cwd` | 工作区 id / 名称 / 路径，省略时跟随默认工作区 |
| `workflow` | 可选，把流程的步骤附进指令，并用流程的 Worker |

**扫描一个来源**（`kind: "scan"`）：适合「每天 2 点扫一遍 TAPD，把可自动修的 bug 交给 dsh」。

| 字段 | 含义 |
| --- | --- |
| `source` | 来源插件实例 id（`poll` / `manual` 类型） |
| `workflow` | 可选，新条目强制按这个流程处理（跳过模型判断，直接建任务） |
| `worker` | 可选，强制交给某个 Worker |

执行时等价于「立即扫描」：拉一次来源，只处理没见过的新条目（`source_items` 去重），再按流程 / Worker 建卡。只有绑定了流程或 Worker 时才强制建卡；不绑定时照常判断「要不要动手」。

### 执行

`runRule()`：

1. 同一条规则用 `runningRules` 防止同时跑两次；
2. 动作：
   - `kind: task` → `createTask({ origin: 'proactive', priority: 3, ruleId })`。Worker 取动作指定的 > 流程指定的 > 兜底，不经过模型判断；
   - `kind: scan` → `discovery.runPlugin(source, { force: true, override: { workflow, worker } })`，等价于「立即扫描」。带了 `override` 时发现核心跳过模型判断，见 [发现核心](discovery.md#ingest-流程)。
3. 结果写回 `rules.last_run / last_status / last_summary`，主对话里发一条说明。

`settings.proactive` 关掉时整个自动化停摆。到点但没跑成（比如没有可用的 Worker）时，每条规则每天只记一次日志。

### 护栏

- 扫描只处理没见过的新条目，同一条不会重复建卡，判断途中重发也不会；
- 自动化不会绕过审批：内置 Worker 的 `needs_approval` 仍会停下等你；dsh 这类外部 Agent 自己的操作由它自己的权限和指令决定，建议在流程里写清「测试通过才合 beta」「只推分支」等条件；
- 每天规则只在窗口内补跑一次，电脑长时间睡眠会错过；要准点跑请让主机不休眠。

### 例子：TAPD 夜间自动修 bug

1. 在 TAPD 里给允许自动修的 bug 打一个标签，比如 `可自动修`；
2. 写工作流程 `<data>/workflows/TAPD bug 修复.md`：

   ```markdown
   ---
   name: TAPD bug 修复
   when: TAPD, 可自动修
   notWhen: TAPD 怎么用, 查一下 TAPD
   worker: dsh
   workspace: 渔童
   ---

   1. 用 tapd-cli 查我名下带「可自动修」标签、未完成的 bug，最多 2 个
   2. 每个 bug：定位仓库 → 拉 v4.5 / beta → 修复 → lint / test
   3. 测试通过才提交、推分支；合并 beta 按下面的条件……
   4. 结果写明：改了什么、commit、分支、没修的为什么
   ```

3. 加一条自动化：每天 02:30 → 扫描 TAPD 来源 → 按「TAPD bug 修复」流程处理；
4. 想更稳就只自动推分支 + 开 MR，合 beta 留到早上自己点。

## 习惯学习

订阅 `task/finished`（`onTaskFinished`）：

1. 任务带 `workflow_id` 时，`workflows.recordOutcome()` 记一次成败；
2. 只看 `done` 的任务；`workflows.shouldLearn()` 判断值不值得学（比如有过拍板、不是纯文本问答）；
3. `proposeWorkflow()` 把任务总结成候选习惯（`<data>/workflows/learned/`），在对话里发卡片等主人确认；
4. 习惯可以开「自动拍板」：调度器遇到记过的问题时按习惯替主人选，见 [调度器 · 拍板](scheduler.md#拍板)。

## 工作流程

`workflows.js` 管理流程文件，Router 和发现核心都会用：

- 每个流程是一个 Markdown 文件，头部写 `name / when / notWhen / worker / workspace / status / auto / answers`，正文是步骤；
- 来源：用户写的放在 `<data>/workflows/` 或设置里指定的文件夹；静静学的放在 `<data>/workflows/learned/`；
- `when` 默认按逗号 / 顿号 / 竖线拆成字面关键词匹配，`whenRegex: true` 才当正则；
- 命中后：流程的 Worker / 工作区优先，`promptSection()` 把步骤附进指令；
- 静静不改写用户文件夹里的文件，启停状态记在库里（`workflow_state`），效果统计在 `workflow_stats`。

## 和其他模块的关系

```
handleMessage ──▶ workflows / worker-routing / worker-rules（纯判断）
              ──▶ scheduler.createTask
              ──▶ memory / persona / mind（读写记忆、拼人设）
runRule(scan) ──▶ discovery.runPlugin   （动态 import，避免循环引用）
discovery     ──▶ router.postAssistant  （来源汇总发到主对话）
task/finished ──▶ onTaskFinished        （流程统计、习惯提议）
```

## 接口

| 接口 | 用途 |
| --- | --- |
| `POST /api/chat` | 发一句话 |
| `GET /api/rules` · `POST /api/rules` · `POST /api/rules/:id/run` · `POST /api/rules/:id/toggle` · `DELETE /api/rules/:id` | 自动化 |
| `GET/PUT/DELETE /api/workflows/:id` · `POST /api/workflows/:id/status\|auto` | 工作流程 |
| `POST /api/tasks/:id/learn` | 手动把一个任务总结成习惯 |

## 相关文档

- [发现核心](discovery.md)：外部来源怎么派活（规则不同）
- [Worker](workers.md)：manifest 里声明的能力、开销、别名

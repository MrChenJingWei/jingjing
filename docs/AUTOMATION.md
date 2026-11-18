# 自动化：定时建任务，或定时处理来源

自动化 = **触发器 + 动作**，在 设置 → 自动化 里加，不需要改代码。

## 触发器

| 类型 | 行为 |
| --- | --- |
| `daily` | 每天 `HH:MM` 到点后 3 小时内、当天还没跑过就执行一次；电脑睡眠错过窗口就不补 |
| `interval` | 距上次运行超过 N 分钟（1–1440）执行；同样要等电脑醒着 |

## 动作

### 创建一个任务（`kind: "task"`）

- `title`：任务名，省略时用自动化名称；
- `prompt`：给 Worker 的指令；
- `worker`：可选，省略时按能力挑最便宜的文本 Worker；
- `cwd`：工作区 id / 名称 / 路径，省略时跟随默认工作区；
- `workflow`：可选，把工作流程的步骤附进指令，并用流程的 Worker/工作区。

适合「每天 8 点汇总 TAPD 待办」这种不需要来源插件的定时活。

### 扫描一个来源（`kind: "scan"`）

- `source`：来源插件 id（poll / manual 类型）；
- `workflow`：可选，新条目强制按这个流程处理（跳过模型判断，直接建任务）；
- `worker`：可选，强制交给某个 Worker。

执行时等价于「立即扫描」：拉一次来源、只处理没见过的新条目（`source_items` 按 `source + externalId` 唯一），再按流程/Worker 建卡。适合「每天 2 点扫一遍 TAPD，把可自动修的 bug 交给 dsh」。

## 护栏与边界

- 扫描只处理没见过的新条目，同一条不会重复建卡；判断途中重发也不会。
- 只有绑定了工作流程或 Worker 的扫描动作才会强制建卡；不绑定时照常判断「要不要动手」。
- 自动化不会绕过审批：内置 Worker 的 `needs_approval` 仍会停下等你；dsh 这类外部 Agent 自己的操作由它自己的权限/指令决定，建议在流程里写清「测试通过才合 beta」「只推分支」等条件。
- 每天规则只在窗口内补跑一次，电脑长时间睡眠会错过；要准点跑请让主机不休眠。

## TAPD 自动修 bug 的例子

1. 在 TAPD 里给允许自动修的 bug 打一个标签，比如 `可自动修`；
2. 写工作流程 `TAPD bug 修复`（`data/workflows/TAPD bug 修复.md`）：

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

> `when` 默认按逗号/顿号/竖线分隔的**字面关键词**匹配，不再当正则；确实要用正则时在头部加 `whenRegex: true`。`notWhen` 用来排除问句或反例。

3. 加一条自动化：每天 02:30（或 07:30）→ 扫描 TAPD 来源 → 按「TAPD bug 修复」流程处理；
4. 想更稳就只自动推分支 + 开 MR，合 beta 留到早上自己点。

## API

```text
GET    /api/rules                列出自动化
POST   /api/rules                新建（带 id 就是更新）
POST   /api/rules/:id/run        立即运行一次
POST   /api/rules/:id/toggle     启用 / 暂停
DELETE /api/rules/:id            删除
```

底层就是 `rules` 表：`trigger`、`action` 两列 JSON，运行结果记在 `last_run / last_status / last_summary`。

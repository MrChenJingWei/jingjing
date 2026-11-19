# 通道与回传

> 代码：`src/events.js` · `src/channels.js` · `src/relay.js` · 前端 `public/js/sync.js`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 职责

静静和外界说话的所有通道：

| 通道 | 方向 | 对谁 | 代码 |
| --- | --- | --- | --- |
| Web / PWA | 双向 | 主人 | HTTP + SSE（`events.js`） |
| Telegram | 双向 | 主人（只认配置的 Chat ID） | `channels.js` |
| 飞书 / 通用 Webhook | 单向通知 | 主人 | `channels.js` |
| 消息类来源（企微等） | 双向 | 外面的人 + 主人 | `relay.js` + 来源插件 |

## Web / PWA：快照 + 事件

1. 前端启动时 `GET /api/bootstrap` 拿完整快照：设置（打码）、主对话最近 120 条、任务 80 条、待拍板、记忆、自动化、Worker、插件、分类、心智、版本；
2. 然后连 `GET /api/stream`（SSE），只收变化；
3. 服务端模块通过 `bus.emit(type, payload)` 发事件，`events.js` 既分发给进程内订阅者，也推给所有 SSE 客户端；
4. 前端每次用服务端给的对象**覆盖**本地副本（`upsertTask` 等），不做增量推断；
5. 断线由浏览器自动重连，重连后重新拉快照。

同一个浏览器（IP + UA）最多保留 3 条实时连接，超出的关掉最旧的——浏览器对同一站点的并发连接有限，实时连接太多会把 POST 请求挤住。不同设备、桌面 App 和手机各算各的。

事件清单见 [数据与事件](data.md#事件总线)。

## Telegram

- `getUpdates` 长轮询，配置变更时 `restartTelegram()`；
- 只认设置里的 Chat ID（`fromOwner`），别的会话发来的消息和按钮一律丢弃，日志里记下对方的 Chat ID 方便第一次配置；
- 文字消息 → `router.handleMessage(text, { source: 'telegram' })`；
- 审批按钮的 `callback_data` 是 `approve:<approvalId>:<choice>` → `scheduler.approve()`。

## 通知

调度器在两个时刻调 `channels.js`：

- `notifyApproval(approval, task)`：任务停下等拍板（习惯自动拍板的不发）；
- `notifyTask(task)`：任务完成或失败（用户自己取消的不发）。

按设置发到 Telegram / 飞书 / 通用 Webhook。发送失败推 `channel/delivery` 事件，界面上提醒。`POST /api/channels/test` 发一条测试通知。

## 消息类来源的回传

企微这类长连接机器人既是任务来源，也是对外说话的渠道。

**分工**：插件拥有渠道（怎么显示：更新同一个气泡、发卡片、发新消息）；静静拥有状态和策略（说什么、什么时候说、谁能改任务）。任务状态只存在静静这里，插件只拿到副本。

**策略**（`plugins.relayPolicy`，存在 `source_plugins.relay`，插件代码里不放）：

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `ack` | 收到消息先回执 | 开 |
| `status` | 状态播报：`off` 不播 / `key` 只播等拍板、完成、失败 / `progress` 再加进度 | `key` |
| `owners` | 能在渠道里拍板、接着做的人（渠道里的用户 id） | 没有人 |
| `autoResult` | 完成后把结果原样发回（`auto_reply`） | 关 |

**流程**：

1. **收到**：发现核心处理一批消息前 `relay.hold(id)`，先攒住这批任务的播报；处理完 `relay.acknowledge()` 发回执（「收到，交给了谁 / 等主人决定」），再放行攒住的事件——渠道里的顺序永远是「收到 → 等拍板 / 做完」。
2. **过程**：订阅总线
   - `approval/created` → 拍板卡片；
   - `task/progress` → 进度播报（`status=progress` 时，同一任务至少隔 10 秒）；
   - `task/finished` → 开了 `autoResult` 且完成就 `deliverResult()`，否则推结束状态。
3. **调插件**：`speak()` → `deliver(config, { to, event, text, final, transient, task, approval }, ctx)`，15 秒上限。同一个渠道的发送串成一条 Promise 链，保证先后顺序。只有 `reply()` 的老插件只会收到结果和闲聊回复。
4. **渠道里回来的操作**：插件把按钮 / 回复转成 `ctx.interact({ action, taskId, by, … })` → `relay.interact()`：
   - `action` 只认 `approve` / `continue` / `cancel`；
   - 核对 `by` 在 `owners` 里，否则拒绝；
   - 再调 `scheduler.approve / continueTask / cancel`。
5. **手动发回**：任务详情点「发回原会话」→ `POST /api/tasks/:id/reply` → `relay.deliverResult()`，可以改了再发。
6. **留痕**：发了什么、谁在渠道里做了什么，都写进任务时间线（`task/replied` 等）。自动发回失败发 `relay/failed`，发现核心转成主对话里的一条提醒。

**闲聊**：有人在渠道里直接找静静、但不是要办的事时，发现核心交给 `persona.chatReply()` 决定回不回、回什么，通过 `relay.sendChat()` 发出去，主对话里留个底。外面的人只碰得到人格记忆，见 [记忆与心智](memory.md)。

## 相关文档

- [安全边界](security.md)：配对、Telegram Chat ID、渠道 owners
- [发现核心](discovery.md)：消息怎么变成任务

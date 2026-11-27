# 记忆与心智

> 代码：`src/memory.js` · `src/conversation.js` · `src/mind.js` · `src/affect.js` · `src/people.js` · `src/persona.js`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 职责

静静记得住事、有心情、认得人、会成长。记忆是横切能力：Router、发现核心、Worker 都通过 `memory.js` 读写，而不是各自持有上下文。

| 模块 | 管什么 |
| --- | --- |
| `memory.js` | 长期记忆：写入、检索、遗忘、回想 |
| `context.js` | 统一装配：常驻/按需分档、token 预算、「为什么被想起」 |
| `conversation.js` | 工作记忆：每段对话最近的原话 + 滚动摘要 |
| `affect.js` | 心情（PAD 模型） |
| `people.js` | 认识的人：熟悉度、好感、印象 |
| `mind.js` | 编码、反思、进化 |
| `persona.js` | 拼出说话时的「自我」 |

## 两个域

同一张 `memories` 表，用 `domain` 列区分。不写 `domain` 的读写都按业务处理。

| 域 | 内容 | 谁读 |
| --- | --- | --- |
| `work` 业务 | 主人的偏好、项目、任务经验、和主人聊过的事 | Router 派活、发现核心建任务、Worker 执行（`ctx.memories`）、主人的对话 |
| `persona` 人格 | 静静自己的设定和自我认知、她在外面认识的人和聊过的事 | `persona.chatReply()`（外面有人找她闲聊）、主人的对话（单独一节） |

**隔离**：外面的人只碰得到人格记忆；任务和 Worker 只碰得到业务记忆。外人的对话存在 `ext:<人的 id>` 会话里，不广播、不进主人的对话；给外人的提示词只用人格记忆里 `subject` 为空、`self` 或这个人的条目。

## 分层

| 层 | 内容 |
| --- | --- |
| `profile` 画像 | 偏好、作息、自我认知 |
| `semantic` 语义 | 事实、项目 |
| `episodic` 情景 | 经历、决定、任务结果 |

## 读写时机

| 时机 | 读 / 写 | 内容 |
| --- | --- | --- |
| 主人说「记住…」/ 明确的偏好 | 写 profile / semantic | 抽取后写入，去重 |
| Router 回答前 | 读 | 按当前问题检索，拼进 system prompt |
| 发现核心建任务前 | 读 | 3 条相关业务记忆拼进 prompt |
| Worker 执行时 | 读 | `ctx.memories`：`context(limit 6)`（会多取 4 条，实际约 10 条），按任务 `cwd` 和正文的实体触达 |
| 任务完成（开了 `autoRemember`） | 写 episodic | `任务「…」的结果：…`，截断 400 字 |
| 对话停下来 / 攒够几句 | 写 | `mind.encodePending()` 整理成经历和事实 |
| 每天反思 | 写 | 事实、自我认知、对主人的认识、印象、日记 |
| 记忆页手动增删改 | 写 | 任意层 |

检索优先用 FTS5 trigram；查询少于 3 个字符时退回 `LIKE`，保证中文两字词（如「周报」）也能命中。

## 遗忘与回想

`memories` 的心智相关列：`stability`（稳定度，天）、`valence` / `arousal`（记下时的情绪）、`subject`（关于谁：`owner`、`self` 或某个人的 id）、`archived`（已淡忘）。

- 保持率 `R = e^(−t/S)`，t 从上次想起算；
- 刚记下：`S = 基数(层) × (0.5 + 重要度) × (1 + 1.5 × 激动程度)`；
- 被想起：`S ← S × (1.1 + 0.8 × (1 − R))`，越是快忘了时想起，越记得牢；
- `recall()` 打分：`1.2·相关 + 0.5·R + 0.4·重要 + 0.25·激动 + 0.4·(关于眼前这个人) + 0.15·(画像)`。

## 实体引用与被更新

- 写入时按已知名单给记忆挂 `memory_refs`（工作区 / 分类域 / 人 / 工具 / 文件），见 `src/entities.js`；任务的 `cwd` 也算工作区触达。人格域不自动挂业务实体。
- `recall()` 在原有打分上给「正文提到当前实体」和「写入时挂过当前实体」加分，所以进了某个项目、消息里没提项目名，也能把项目里的旧经验带出来。
- 偏好 / 事实出现明确的更新说法（不再 / 不喜欢 / 改成 / 换成 / 取消…）且和旧说法相似度 ≥ 0.5 时，旧条目归档并记 `superseded_by`（`memories` 列）——不删除，记忆页显示「已被新说法替代」，可以点「想起来」恢复；旧说法再被提起时反过来恢复它、把替代它的那条归档。
- 老库启动后 3 秒在后台补一遍引用；`settings.memory_refs_backfill` 记版本，重复跑不会重复加。

完整的诊断、外部做法和后续规划见 [记忆的联想与图谱](memory-graph.md)。

## 联想与有效期

- 同一次被放进提示词的几条记忆互相连边（`memory_edges`，`same_topic`）：24 小时内只长一次，每次 +0.2，上限 2；任务结果和这次用到的背景记忆连 `same_task`；新旧说法连 `supersedes` + `conflict`；同一工作区的任务结果按时间串 `before`；可选 embedding 会把意思相近的连 `similar`。跨域不连。
- 记忆页右上角「图谱」：当前域的记忆（按层着色）和挂的项目 / 人 / 工具 / 文件（外圈）画成一张放射状的网，点节点看它连着什么。
- `recall()` 从基础分最高的 10 条出发，沿边扩散 1–2 跳（0.5 / 0.25 衰减，每跳设上限），候选池外的旧记忆也能被带回来；提示词里标「通过相关记忆联想」。
- 已淡忘（`archived`、且没有被替代）但挂在当前触达点上的记忆，按 0.7 折算参与召回；想起后自动恢复。
- 事实有有效期：被替代时记 `valid_to`，`recall` / `search(validOnly)` 默认过滤过期事实，记录保留。
- 每天 `maintain()` 让 `same_topic` 边衰减 2%、`similar` 边衰减 1%，剪掉太弱的边、清掉悬空边。
- 可选的相似边：设置 → 模型与人设 →「记忆的相似边」，用本机 Ollama 的 embedding 模型在后台每 30 分钟索引一批；也可以点「现在索引一批」。

## 统一装配

对话、派任务、来源都走 `src/context.js` 的 `buildMemoryContext()`：一次 recall + token 预算（业务常驻画像 300 / 按需 700；人格 200 / 150；来源任务缩到 200 / 500），每条记忆带「为什么被想起」。派任务时 `llm` Worker 用 `ctx.memories`，其他 Worker 在指令后带一段「背景」；每次注入记一条 `memory/injected` 事件（ids + 原因 + token 数）。

## 一句话进来之后

```
主人 / 外人说一句话
  → affect.hear()   词表评估情绪，推动心情（PAD，半衰期 4 小时）
  → people.touch()  熟悉度、好感
  → 回答：ownerSelf() / chatReply() 拼
        人设 + 自我认知 + 心情 + 关系 + recall() 选出的记忆 + 摘要 + 最近 12 句原话
```

判断情绪用词表，不依赖模型：没接模型、模型很弱时一样能用。心情只影响说话的语气，不影响办事的判断。任务成败（`task/finished`）也会推动心情。

## 每分钟：`mind.tick()`

由 Router 的每分钟循环调用，不在回复请求里，回复不变慢。

1. **编码** `encodePending()`：对话停了 5 分钟或攒够 6 句，模型（没接或失败时用规则）把对话整理成经历（情景记忆，带当时的情绪）和事实（语义 / 画像记忆），更新对话摘要；`encoded_upto` 记到哪条，整理过的不重复记。
2. **到 `mind.reflectAt` 时反思** `reflect()`：
   1. `maintain()`：归档快忘光的经历；复述 ≥ 3 次的经历转成事实；`people.drift()`（很久不联系熟悉度每天掉一点）；
   2. 模型反思：写事实、自我认知（`persona/profile/self`）、对主人的认识（`work/profile/owner`）、对人的印象、日记；
   3. `evolve()` 按 `mind.evolve`：
      - `auto`：直接改人设（和原来相似度 ≥ 0.25、72 小时冷却）；
      - `propose`：在对话里提议，主人确认；
      - `off`：不改。

人设的每一版都存进 `persona_versions`（最初、主人改的、她反思后改的、回退的），可以回退。

## 认人

外面的人从来源插件进来，身份是 `<来源实例 id>:<条目的 actor.id>`（企微 userid、邮箱、TAPD 昵称、GitHub login）。

- **什么时候记**：直接找静静的消息（`direct`，不管回不回）和建成任务 / 合并进任务的事项，都会 `people.touch()`。只是路过、判断为不用管的通知不记。闲聊由 `persona.chatReply()` 记（连同这次的情绪），其他由 `discovery.noteSpeaker()` 记（只动好感，不动心情）。
- **查通讯录**：来源插件导出了 `lookupPeople()` 时，新认识的人当场在后台查一次；之后每小时扫一遍，超过一天没查过的按来源成批再查。查到的部门、职位存在 `people.profile`，写进「正在和你说话的人」那一句。
- **名字优先级**（`people.name_from`）：主人改的 `manual` > 通讯录 `directory` > 聊天里对方说的 `chat` > 插件给的 `source` > `id`。低的盖不过高的。
- **合并同一个人**：同一个人在不同来源是不同的身份（企微 userid 和 TAPD 昵称）。不同来源里称呼或通讯录英文名一样时，人物页提示「可能是同一个人」，只提示不自动合并；主人点「合并」或「不是」（记在 `people_distinct`）。合并后旧身份记进 `people_aliases`，`people.get()` 先解析别名，以后从那个来源来的也算到主身份上；来往次数相加、熟悉度取高、好感按来往次数加权，聊天、记忆、派过的活都改到主身份名下。
- **派活的人**：来源建任务时 `tasks.requester` 记下说这件事的人，另起的后续卡沿用。主人的话里提到某个认识的人（称呼或英文名）时，`persona.mentionedPeople()` 把 ta 是谁、最近派过的活放进主人对话的提示词；外人那边看不到任务。
- **忘掉一个人**：人、和 ta 的聊天（原话和摘要）、关于 ta 的记忆、合并过的身份一起删掉；ta 派过的任务保留，只清掉 `requester`。

## 和分类知识的分工

[分类知识](external.md)（`task_knowledge`）属于某个分类域，只在派这个域的活时进 prompt；记忆是全局的。详见 [外部对象 · 和记忆的分工](external.md#和记忆的分工)。

记忆目前的检索、注入量和"三层发散"的诊断，以及以实体 / 联想图改造记忆的分阶段方案，见 [记忆的联想与图谱（方案）](memory-graph.md)。

## 接口

| 接口 | 用途 |
| --- | --- |
| `GET/POST /api/memories` · `PATCH/DELETE /api/memories/:id` | 记忆增删改查 |
| `GET /api/mind` · `POST /api/mind/reflect` · `POST /api/mind/mood/reset` | 心智概况、立即反思、心情复位 |
| `PATCH/DELETE /api/people/:id` | 改 / 删认识的人 |
| `POST /api/people/:id/merge` · `POST /api/people/distinct` | 合并同一个人（`{ from }` 并进 `:id`）、标记两个人不是同一个人 |
| `POST /api/persona/rollback` · `POST /api/persona/proposal` | 人设回退、处理提议 |

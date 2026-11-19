# 记忆与心智

> 代码：`src/memory.js` · `src/conversation.js` · `src/mind.js` · `src/affect.js` · `src/people.js` · `src/persona.js`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 职责

静静记得住事、有心情、认得人、会成长。记忆是横切能力：Router、发现核心、Worker 都通过 `memory.js` 读写，而不是各自持有上下文。

| 模块 | 管什么 |
| --- | --- |
| `memory.js` | 长期记忆：写入、检索、遗忘、回想 |
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
| Worker 执行时 | 读 | `ctx.memories`：6 条业务记忆 |
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

## 和分类知识的分工

[分类知识](external.md)（`task_knowledge`）属于某个分类域，只在派这个域的活时进 prompt；记忆是全局的。详见 [外部对象 · 和记忆的分工](external.md#和记忆的分工)。

## 接口

| 接口 | 用途 |
| --- | --- |
| `GET/POST /api/memories` · `PATCH/DELETE /api/memories/:id` | 记忆增删改查 |
| `GET /api/mind` · `POST /api/mind/reflect` · `POST /api/mind/mood/reset` | 心智概况、立即反思、心情复位 |
| `PATCH/DELETE /api/people/:id` | 改 / 删认识的人 |
| `POST /api/persona/rollback` · `POST /api/persona/proposal` | 人设回退、处理提议 |

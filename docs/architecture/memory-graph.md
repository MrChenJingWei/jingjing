# 记忆的联想与图谱（方案）

> 代码：`src/memory.js` · `src/entities.js` · `src/context.js` · `src/persona.js` · `src/router.js` · `src/discovery.js` · `src/scheduler.js` · `src/knowledge.js` · `src/workflows.js`
>
> 相关：[记忆与心智](memory.md) · [外部对象、归类与知识](external.md) · [Router](router.md)
>
> 返回 [总体架构](../ARCHITECTURE.md)
>
> 状态：**M0–M3 已实现**（触达点、refs、统一写入、统一装配与预算、联想边、有效期、冷层、流程按工作区优先）。实现记录见下方「进展」。

## 要解决的问题

1. **只增不减**：`profile` / `semantic` 层不会被归档（`maintain()` 只处理 `episodic` / `working`），语义记忆只增不减。
2. **很多记忆只在特定触点需要**：进了某个项目、碰了某个工具、和某个人有关时才该被想起；现在靠“字面 + 最近 + 重要度”去碰。
3. **并不是全量注入**：每轮只放十几条。真正的风险不是上下文撑爆，而是**记忆越多，该被想起的那条越难被检索到**。

## 现在到底怎么工作

### 每轮注入多少

| 场景 | 注入的记忆 | 代码 |
| --- | --- | --- |
| 主人对话 | 业务 `context(limit 6)`、人格 `context(limit 3)`（`context` 会向上多要 4 条，实际约 10 + 7）；另有自我认知 5 条、摘要 ≤1200 字、最近 12 句原话（每句 ≤600 字）、任务板 8 条 | `src/persona.js` `ownerSelf()`、`src/router.js` `chatSystemPrompt()` |
| 派给 Worker | `ctx.memories = context(limit 6)`，约 10 条；**只有 `llm` Worker 会渲染**，Claude / Codex / DSH 不看 `ctx.memories` | `src/scheduler.js`、`workers/llm/index.js` |
| 来源事件建任务 | `context(rawText, limit 3)` 约 7 条 + 按分类域取的 `task_knowledge`（≤8 条、1200 字），拼进任务 prompt | `src/discovery.js` |

### 召回怎么选

`recall()`（`src/memory.js`）：

- 候选池 = **最近 200 条** + **重要度前 60 条** + `search()` 命中的 30 条；
- 打分 = `1.2×字面相关 + 0.5×保持率 + 0.4×重要度 + 0.25×情绪强度 + 0.4×关于眼前这个人 + 0.15×画像层`；
- 字面相关是**中文二元组重合率**，没有向量、没有实体链接；
- 被选中的会 `reinforce()`，稳定度变大，下次更容易被选中。

三个结构性弱点：

- **候选池固定**（200 + 60 + 30），池外的记忆不参与打分；
- `search()` 把**整句**当短语去 MATCH（trigram），LIKE 也是 `%整句%`，长句几乎不可能命中——这条腿对自然语言长句实际是失效的；
- `hit / min(|query|, |memory|)` 让短记忆占优、长记忆吃亏（任务结果那类 400 字的情景记忆容易被埋没）。

### 三层发散

**1）检索入口发散。** `memory.context/recall` 有 4 处调用（对话、派任务、来源、外部闲聊），`knowledge.context` 1 处，`listTasks` 2 处，另有 `mentionedPeople`、对话摘要、记忆页 `list/search`——十几个调用点各自带自己的 query、limit、domain，互不知情。

**2）写入入口发散。** `remember()` 的调用点分布在：Router（记住 / 偏好）、`mind.encodePending`、`mind.reflect`、调度器（任务结果）、`knowledge.markUsed`（知识晋升）、`/api/memories`、`seed`。各写各的 layer / kind / tags / importance，没有统一实体抽取，也没有冲突消解。存储上分成五个孤岛：`memories`、`task_knowledge`、`people`、工作流程 Markdown + `workflow_stats`、`tasks` / `source_links`——除了 `subject=人`，彼此没有键相连。

**3）装配发散。** `ownerSelf()` → `chatSystemPrompt()` → Worker 自己的 prompt → `discovery` 的 prompt → `workflows.promptSection()`，五个 composer 各拼各的，条数各管各的。

发散造成的直接后果：

- 同一件事在对话里用「用户这句话」选，在任务里用「标题 + prompt」选，**两套选择标准**，可能选出不同结果；
- 对话派出去的任务拿不到记忆（只有 `llm` Worker 拿），而来源任务拿得到分类知识——同样的活，背景不一样；
- 知识晋升成记忆时只把分类名塞进文本（`knowledge.markUsed`），**边丢了**；
- 工作流程靠 `when` 关键词在平表里挑最长命中，和它所属的工作区、分类、知识、记忆没有边。

## 别人怎么解决

| 路线 | 代表 | 做法 | 对这里的启发 |
| --- | --- | --- | --- |
| 分层存储 | MemGPT/Letta、MemoryOS、MemOS | core（常驻）/ recall（可搜历史）/ archival（外部库）；按热度在短 / 中 / 长三层升降 | 解决“上下文有限”；热度淘汰和异步巩固可放进 `mind.tick()` |
| 图 / 实体记忆 | Zep/Graphiti、Mem0（graph 版）、Cognee | 对话切成 episode，抽实体和事实边；Zep 用**双时态**维护 `valid / invalid` 区间；Mem0 写入时做 **ADD / UPDATE / DELETE / NOOP** 冲突消解，关系软删除 | 正好补上缺的“时间失效”和“偏好变更” |
| 联想检索 | HippoRAG / HippoRAG 2、A-MEM | HippoRAG 用 **Personalized PageRank** 从命中点沿边扩散，一次做多跳；A-MEM 按 Zettelkasten 给笔记生成关键词/标签，写入时让 LLM 主动连历史笔记，并能反向更新旧笔记（记忆演化） | “触达某个点才想起”的学术版：**边在写入时建好，检索只是激活** |
| 文件 / 本地优先 | Basic Memory、Obsidian 图谱 | Markdown + wiki-link 存记忆，SQLite 做索引和同步，MCP 给模型读写，用户能直接看和改 | 与“单进程 + 单文件 SQLite”最贴；图不一定需要图数据库 |

参考：

- [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110)（NeurIPS 2025，Zettelkasten 式动态链接与记忆演化）
- [HippoRAG](https://arxiv.org/abs/2405.14831)（NeurIPS 2024，Personalized PageRank 做多跳检索）
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)
- [MemoryOS](https://arxiv.org/abs/2506.06326)
- [Graph-Based Personalized Memory for LLM Agents（综述）](https://arxiv.org/abs/2609.08599)
- [Basic Memory](https://basicmemory.com/integrations/obsidian) · [Awesome-GraphMemory](https://github.com/DEEP-PolyU/Awesome-GraphMemory)

### 五条共识

1. **写入时就结构化**：抽实体、抽关系、记时间，而不是只存一段散文。
2. **边要有类型**：时间先后、来源 / 证据、因果、替代（supersedes）、相关——传播权重不同。
3. **检索是多跳激活**，不是一次相似度；激活要有衰减、按度数归一。
4. **遗忘 / 合并 / 矛盾是核心功能**：旧信息要失效或替换，而不是堆着。
5. **评估用多跳 / 时序 / 跨会话场景**（LOCOMO、LongMemEval、DMR），不是单轮问答。

### 一个反直觉的数据

Mem0 论文里 **graph 版只比基础版高约 2%**（LOCOMO），主要收益来自“抽事实 + 冲突消解 + 压缩历史”，不是图结构本身；HippoRAG 的收益来自多跳检索。结论：**先做实体与冲突消解，再考虑全图，图数据库不是必需。**

### 别人踩过的坑

- LLM 抽实体 / 建边贵，错误会传播——能用规则（工作区名、分类 key、人名、工具名）就别用模型；
- 图会膨胀和重复，删除语义要想清楚（Mem0 后来把关系硬删除改成 `valid=false` 软删除）；
- 不区分“何时发生 / 何时记录”会导致时序错乱；
- 没有 benchmark 容易自嗨，先写场景断言再优化。

## 目标结构

不做“把十几个入口合成一个巨型查询”，而是让所有入口**共享同一份结构、同一份预算、同一份“为什么被选中”**。

| 层 | 现在 | 目标 |
| --- | --- | --- |
| 解析 | 每个入口自己从文本里找工作区 / 人 / 分类 | 每轮解析**一次**实体，产出一个 context bundle |
| 召回 | 3 个不相交候选池，每条腿自己算分 | 一次激活：实体种子 + 字面种子，沿边扩散 1–2 跳，度数归一、衰减、按源限额 |
| 预算 | 每处 `limit 6 / 3 / 8` 各管各的 | 全局 token 预算：常驻（画像 / 偏好 / 流程要点）+ 按需（激活出来的） |
| 装配 | 5 个 composer 各拼各的 | 一个 composer 从 bundle 渲染，只是排版不同 |
| 写入 | 7 个入口各写各的形状 | 一个 `write()`：抽 refs → 解析 → ADD / UPDATE / DELETE / NOOP → 建边 |
| 演化 | 相似度去重 + 归档 | 时间失效 + 冲突消解 + 反思时重建 / 剪边 |

### 数据模型

**已实现（M1）**：不单独建实体表，key 直接复用现有 id，避免同步漂移：

```text
memory_refs(memory_id, kind, key, role, weight, created_at)
   kind = workspace | category | person | tool | file
   key  = settings.workspaces[].id / task_categories.key / people.id / 工具名 / 文件名
   role = about（目前只有这一种）
```

- 工作区 / 分类 / 人 / 工具的显示名在读取时从各自的事实来源解析（`src/entities.js`），改名不用同步表。
- `memories.superseded_by`：被新说法替代的旧条目（归档、不删）。

**已实现（M3）**：

```text
memory_edges(a, b, kind, weight, co_count, created_at, last_fired_at)
   a/b 按字典序存，正反只留一条
   kind = same_topic（同一次被想起）| same_task（任务结果 ↔ 背景）| supersedes（替代）

memories.valid_from / valid_to
   被新说法替代时记失效时间；检索默认过滤，记录不删
```

- 目前只用了这三种边；`before / after / cause / conflict` 留给以后。
- 工作流程仍是 Markdown 文件（用户可改），图里只存索引和边。

### 检索打分与预算

**已实现（M0–M3）**：候选池不变（最近 200 + 重要 60 + 搜索 30），在原有打分上依次加三路：

```text
基础分 = 1.2×字面相关 + 0.5×保持率 + 0.4×重要度 + 0.25×情绪 + 0.4×聚焦人 + 0.15×画像
       + 0.8×min(正文提到当前实体数, 3)      # 记忆正文里直接提到
       + 1.0×min(挂过的当前实体数, 3)        # 写入时挂过（memory_refs）

激活分 = max over 1–2 跳(种子分 × 边权 × 0.5^跳数)
         种子取基础分前 10；每个种子最多 3 个邻居；第二跳最多 8 个来源、每个 2 个邻居

冷层：archived（且没有被替代）但挂在当前触达点上的记忆，按 0.7 折算参与
```

- 邻接在 SQLite 里查，两跳足够；实测 1 万条记忆 + 5 千条边时 `recall` P95 ≈ 16ms。
- 冷层解决"归档 = 永久失联"：淡忘的记忆被同一个工作区强命中时能回来，想起后自动恢复。

### 要保留的分支

- **域隔离**：`work` / `persona` 不能合并，图按域切，否则会成为泄漏通道（见 [安全边界](security.md)）；
- **并行与失败隔离**：多腿检索在延迟和降级上更稳，主干是共享结构，不是一条串行大脑；
- **流程文件是真相**：图只做索引，用户改 Markdown 仍然直接生效。

## 进展

| 里程碑 | 状态 | 实际改动 |
| --- | --- | --- |
| M0 情境解析 + 运行时实体命中 | 已完成 | 新增 `src/entities.js`；`recall/context` 支持 `refs`；对话 / 派任务 / 来源三处接入 |
| M1 refs 持久化 + 统一写入 + 冲突标记 | 已完成 | `memory_refs` 表、`memories.superseded_by`、`memory.write()`、启动回填、知识晋升保留分类引用、`people.merge` 同步引用、记忆页标记 |
| M2 统一装配与全局预算 | 已完成 | 新增 `src/context.js`；对话/派任务/来源共用 `buildMemoryContext()`；token 预算 + 「为什么被想起」；非 llm Worker 的指令带背景段；`memory/injected` 事件 |
| M3 边 / 时间失效 / 冷层 / 流程挂实体 | 已完成 | `memory_edges`（same_topic / same_task / supersedes）、两跳联想、`valid_from/valid_to`、冷层召回、流程命中同分时优先当前工作区 |

实现与草图的三处偏差（有意）：

1. **不建 `entities` 表**：refs 直接存 `(kind, key)`，key 复用工作区 id / 分类 key / people.id / 工具名 / 文件名，避免实体表与事实来源不同步。
2. **冲突先保守标记**：只在明确否定/更新且相似度 ≥ 0.5 时替代；不做自动语义替换，也不调模型判断。
3. **流程只按工作区做同分偏好**：流程没有分类字段，`learnFromTask` 仍只继承 workspace；按分类键绑定留到以后。

测试：`tests/entities.test.js`（6）、`tests/memory-refs.test.js`（10）、`tests/context-memory.test.js`（1）、`tests/context-budget.test.js`（4）、`tests/memory-edges.test.js`（7）、`tests/chat-task-context.test.js` 里的派任务背景（1）、`tests/workflows.test.js` 里的工作区优先（1），全量 350 通过。

## 分阶段

### P0 情境解析 + 运行时实体命中（已完成）

- `src/entities.js`：`listEntities()` / `matchEntities(text, { cwd })` / `hasName()` / `normalizeRefs()` / `refsForMemory()`；
- 规则：名字至少 2 字；拉丁名按词边界（`digit` 不会命中 `git`）；主人不参与匹配；每类限 2–3 个、总共 8 个；文件只认认识的后缀；
- `recall()` / `context()` 加 `refs`，在候选池上加「正文提到」和「挂过引用」两路加分（见上）；
- 已接：对话（`persona.ownerSelf`）、派任务（`scheduler`，`cwd` 也算触达）、来源（`discovery`，正文 + 工作区 + 分类域）；
- 验收已覆盖：`cwd=某工作区、消息不含关键词` 能带回该工作区下的记忆（`tests/context-memory.test.js`）。

### P1 持久化 refs + 统一写入 + 冲突标记（已完成）

- 建 `memory_refs`（不建实体表）；`memories.superseded_by` 记被谁替代；
- `memory.write()` 是唯一写入口：去重时合并引用；挂 refs；冲突标记；`remember()` 是兼容包装；
- 冲突规则（保守）：只有新说法带明确的更新/否定说法（不再 / 不喜欢 / 改成 / 换成 / 取消…）**且**与旧说法相似度 ≥ 0.5 才替代；单独一个「不」「没」「现在」不算；旧条目归档并记 `superseded_by`，不删除，记忆页显示「已被新说法替代」，可以「想起来」恢复；旧说法再被提起时反过来恢复它、把替代它的那条归档。
- 知识晋升保留 `category` 引用；`people.merge` / `unbind` 时同步搬 person 引用；任务结果记忆带上工作区引用；
- 老库启动后 3 秒后台回填（`memory_refs_backfill` 记版本，幂等可重跑）；
- 验收已覆盖：偏好变更后旧说法不再注入但可查（`tests/memory-refs.test.js`）。

### P2 统一装配与全局预算（已完成）

- `src/context.js`：`buildMemoryContext()` 一次 recall + 分常驻（画像/偏好，300 token）/ 按需（事实/经历，700 token）两档；`renderMemoryBlock()` 只输出选中的行；
- 每个入口都用它：对话（`persona.ownerSelf`）、派任务（`scheduler` 的 `ctx.memories`）、来源任务（`discovery`，预算缩到 200 / 500）；
- 每条记忆带「为什么被想起」（关于哪个实体 / 画像 / 和这句话相关 / 最近或重要），写进提示词和 `memory/injected` 事件；
- 补上缺口：对话派给**非 llm Worker** 的任务，指令后面拼一段「背景」；`llm` Worker 继续用 `ctx.memories`，调度器只在它身上记注入事件，避免同一条记忆两处重复；
- 验收已覆盖：预算不超、同轮不重复（`tests/context-budget.test.js`）；派任务指令带背景与注入事件（`tests/chat-task-context.test.js`）。

### P3 记忆之间建边 + 时间失效 + 冷层 + 流程挂实体（已完成）

- `memory_edges`：同一次注入的几条连 `same_topic`（24 小时冷却、每次 +0.2、上限 2）；任务结果和这次用到的背景连 `same_task`；被替代的新旧两条连 `supersedes`；跨域不连；
- `recall` 从基础分前 10 条出发沿边扩散 1–2 跳（0.5 / 0.25 衰减），每跳设上限；候选池外的旧记忆也能被带回来，并带上 `activated` 分（提示词里写「通过相关记忆联想」）；
- 冷层：`archived`（且非 `superseded`）但挂在当前触达点上的记忆按 0.7 参与召回，想起后自动复活；
- 有效期：`valid_from` / `valid_to`；被替代时记失效时间，`recall` / `search(validOnly)` 默认过滤；
- `maintain()` 让 `same_topic` 边每天衰减 2%、剪掉太弱且 90 天没一起出现的边、清掉悬空边；
- 工作流程：`matchWorkflow()` 接受 `refs`，只在「已经命中」的前提下，同分时优先当前工作区的流程（不制造新触发），`learnFromTask` 继续继承 workspace；
- 未做：`before / after / cause / conflict` 边；流程按分类键绑定（流程没有分类字段）。
- 验收已覆盖：两跳、冷层复活、过期过滤、域隔离、边维护、性能（`tests/memory-edges.test.js`）；流程工作区优先（`tests/workflows.test.js`）。

## 验收场景与指标

| 场景 | 期望 | 状态 |
| --- | --- | --- |
| 进入某工作区、消息不含关键词 | 带回该工作区下的历史坑 / 结论 | 已覆盖（`tests/context-memory.test.js`） |
| 偏好变更（“喜欢 A” → “不喜欢 A 了”） | 只注入新事实，旧事实不出现 | 已覆盖（`tests/memory-refs.test.js`） |
| 人格对话（外人） | 不出现任何业务记忆 | 已覆盖（`tests/memory-domain.test.js`） |
| 来源任务 | 分类知识 + 该分类下的记忆一起进 prompt | 已实现（分类知识仍用独立预算） |
| 归档（已淡忘）记忆 | 实体强命中时可被召回 | 已覆盖（`tests/memory-edges.test.js`） |
| 需要串两条记忆才能答对 | 两跳联想能带出候选池外的旧经验 | 已覆盖（`tests/memory-edges.test.js`） |
| 记忆过期 | 过期事实不再注入但记录保留 | 已覆盖（`tests/memory-edges.test.js`） |
| 两个同类流程 | 优先当前工作区的那个，不制造新触发 | 已覆盖（`tests/workflows.test.js`） |
| 一万条记忆、五千条边 | `recall` P95 < 80ms | 实测 ≈16ms（`tests/memory-edges.test.js`） |
| 同一轮多个入口 | 同一记忆不重复注入，总量不超预算 | 已覆盖（`tests/context-budget.test.js`） |

指标：人工标注 20 个“必须联想才能答对”的场景算**召回命中率**；孤立节点占比、平均度、每次注入 token、被主人纠正 / 重说的比例；每次注入记录激活路径（“为什么被想起”）。

## 明确不做

- 不引入图数据库（Neo4j 等），SQLite 两张表 + 两跳查询足够；
- 不让模型每轮“在图里游走”——图只当检索索引，模型只看最终选中的原子；
- 第一版不做 embedding（可作为后续额外种子，本地 ollama 可选）；
- 不把工作流程搬进不可见的图里，文件仍是真相；
- 不合并 `work` / `persona` 两个域。

## 参考

- 记忆模块现状：[记忆与心智](memory.md)
- 分类知识与域的现状：[外部对象、归类与知识](external.md)
- 工作流程（`src/workflows.js`）：[Router · 工作流程](router.md#工作流程)

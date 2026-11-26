# 前端

> 代码：`public/`
>
> 返回 [总体架构](../ARCHITECTURE.md)

## 形态

- 无构建、无框架的原生 ES Module 应用，由服务端直接提供静态文件（`.html/.js/.css` 走 `no-cache`）；
- PWA：`manifest.webmanifest` + `sw.js` + `offline.html`，手机可以加到主屏幕；
- 同一套页面在三处使用：主机浏览器、macOS App 的原生窗口、手机。

## 模块

| 文件 | 职责 |
| --- | --- |
| `app.js` | 入口：装配各页，给桌面 App 暴露 `window.jingjing`（点系统通知打开任务、菜单跳转页面） |
| `js/core.js` | 全局 `state`、`api()`、文案、工具函数；其他模块都从这里取，不互相塞全局变量 |
| `js/sync.js` | 首屏快照 + SSE 实时事件：收到数据只改 `state` 再广播，界面各自重画 |
| `js/shell.js` | 外壳：导航、侧栏「正在发生」、深浅色、连接状态、安装、登录、快捷键 |
| `js/ui.js` | 图标、对话框、确认框 |
| `js/chat.js` | 对话页：消息流、行内任务卡、插件草稿卡、流程卡、输入框 |
| `js/tasks.js` | 任务页：列表（顶上四块状态计数、分组方式、只看）、详情（窄屏从右侧滑出）、重试 / 编辑 / 删除 / 只跟踪 / 暂停调度 |
| `js/task-views.js` | 任务列表的分组方式：按状态 / 来源 / 外部状态 / 执行者 / 时间分段、段内排序、「只看这一组」的归属判断 |
| `js/classify.js` | 任务归类：「按归类」分组的渲染、分类详情（含知识）、手动归类；设置里的「归类与知识」 |
| `js/memory.js` | 记忆页：业务 / 人格两类，人格页顶上是心智（心情、认识的人、上次反思） |
| `js/settings.js` | 设置外壳：左边分类、右边内容；表单类分页统一用顶部「保存」 |
| `js/workers.js` | 设置 → Worker：执行器列表、兜底 Worker、分配规则 |
| `js/plugins.js` | 设置 → 任务来源：开关、配置、扫描、运行记录 |
| `js/plugin-docs.js` | 「怎么写插件」：文档、官方例子源码、复制模板 |
| `js/automation.js` | 设置 → 工作流程 / 自动化 |
| `js/system.js` | 设置 → 运行状态 / 数据与归档 |
| `js/select.js` | 自绘可搜索下拉框，替换所有原生 `<select>`（原生元素保留为数据来源） |
| `js/folder.js` | 文件夹选择器：`data-folder` 输入框用主机 Finder 选路径 |

## 数据流

```
启动 → GET /api/bootstrap → applySnapshot() → state
     → GET /api/stream（SSE）→ 事件 → 改 state → changed(key) → 订阅了这个 key 的界面重画
操作 → api() → 服务端 → 返回最新对象 → upsert 进 state
```

- 以服务端返回的对象为准，覆盖本地副本，不做增量推断；
- 断线重连后重新拉快照（`resync`）；
- 设置详情页正在编辑时，后台推来的状态更新不会冲掉正在填的内容。

实时连接和事件清单见 [通道与回传](channels.md#web--pwa快照--事件) 和 [数据与事件](data.md#事件总线)。

## 视觉

配色 token 在 `public/style.css` 的 `:root`，跟品牌 logo 走：夜墨主色、雾紫强调、少量青色，背景只留很淡的 logo 三色光，浮层用磨砂玻璃；深色模式另有一套 token。快捷键：⌘1–4 切换对话 / 任务 / 记忆 / 设置，`/` 聚焦输入框，设置页 ⌘S 保存，Esc 关闭详情。

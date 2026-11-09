# pi-todo

面向 [pi](https://github.com/earendil-works/pi) coding agent 的极简 replace-on-write `todo` tool，参考 Claude Code 的 `TodoWrite` 与 Codex CLI 的 `update_plan`。它替代 `@juicesharp/rpiv-todo`。

## 唯一语义

每次调用都传入**完整列表**，并替换上一次列表。新增、重排、改状态和移除任务是同一种操作；空列表会清空它。没有 id，也没有逐项 CRUD：model 无需维护账本，因此不会破坏它未持有的 state。

```json
{
  "explanation": "optional — only when the plan itself changes",
  "todos": [
    { "content": "Add schema",    "status": "completed",   "activeForm": "Adding schema" },
    { "content": "Write handler", "status": "in_progress", "activeForm": "Writing handler" },
    { "content": "Run tests",     "status": "pending",     "activeForm": "Running tests" }
  ]
}
```

## 状态如何存活

恢复来源是当前 branch 上最新的成功 `todo` tool result 的 `details`，或其压缩恢复快照；参数定义全量替换语义，内存只保留镜像。tool result 的正文只回简短 confirmation，完整列表在结构化 details 中供宿主恢复和展示，避免重复回显，但并非零 token，也不保证 provider 的 prompt-cache 命中。

- **compaction 后**（transcript 丢失 state 的唯一时刻）：打开的 list 会作为隐藏的 `todo-state` custom message 回注一次。
- **resume / branch navigation 时**：从该 branch 上最新的 snapshot（tool result `details` 或注入的 `todo-state` message）重建 state。
- **恢复失败时**：清理旧内存镜像并明确诊断，不把上一份列表当成新 branch 状态；不会持久追加一个空列表冒充成功恢复。
- **数据边界**：执行和恢复只投影拷贝 `content/status/activeForm`。输入数组、额外字段和消费者的修改不能反向污染镜像；恢复中缺失/无效的 activeForm 回退为 content，空 content 或未知 status 不恢复。

工具参数和恢复的任务文本仍会随正常上下文进入当前模型；本包不额外调用模型，不另设业务文件或数据库。状态推进约束通过 prompt guidelines 提供，不新增任务状态机。

## 界面

- 每个 call 内联 render checklist；result 只显示简短 muted line。
- `/todos` 展示当前 list。
- working spinner 下的 collapsible list 由 `pi-claude-style` 绘制，主要由 `todo:snapshot-v1` 驱动。语义 payload 为 `{version: 1, sessionId?, todos: [{id, subject, status, activeForm?}]}`；`todo:request:snapshot-v1` 为晚加载 consumer 提供 synchronous recovery。同一 consumer 还拥有 statusline count 及其 fold / unfold click，因此本包不发布 presentation state。旧的 `todo:changed` 与 result-details path 仅保留 compatibility。

`pi-session-compact` 只读同会话 snapshot（缺失时兼容已有持久 ABI）并按本包恢复文本核算容量，不写 todo、不发送恢复消息；恢复职责始终属于本包。

## 文档

设计决策（含被否决的替代方案）位于 `docs/adr/`；词汇表位于 `docs/glossary.md`。

## 开发

验证使用隔离 HOME/config/cache 与官方 Pi 1.5.0，不写日常 profile。无需 build 或 dist；Source/UI 单测不能替代真实终端与完整压缩链验收。


要求 Pi 1.5.0。status schema 用 TypeBox `Type.Enum` 保留 plain JSON enum 和静态类型。

```
npm ci # 在仓库根运行
npm run check   # tsc --noEmit + node --test
```

可选 Compact 的同步 `pi-session-compact:collect-recovery-v1` 协议在提交前收集本包现有恢复文本，回复声明 `order: 20`，不依赖固定 owner 名单。协议缺席时保留原有独立恢复路径；version 1 的 `compactionEntry.details.recovery` 包含本包 owner/customType 时跳过重复消息，无标记的旧记录仍走原路径。开放排序、请求和 details 兼容由 [pi-session-compact](../pi-session-compact/README.md) 定义；无需安装该插件，收集不改变任务准入、中止围栏或完成投递。
Todo 以 source entry ID 作为 identity；旧 carrier 被切出投影时，从当前 raw branch 上该确切持久来源恢复列表，再由更新的投影 todo 写入覆盖。

## 日常回归（需单独验收）

- 全量写入、重排和清空列表，确认工具短结果、`/todos` 和 consumer 看到同一份任务。
- 恢复/切 branch 后使用最近的成功快照；读取失败时有诊断，不回注旧任务。
- 压缩后未完成列表恢复一次，全部完成的列表不单独回注；启用 Compact 的 recovery marker 时不重复追加。
- CC Style 的折叠、状态栏、以及真实 TUI/IME 在相应插件另行确认装配后验证。本包不自动迁入这些插件或向 SDK child 注册 Todo。

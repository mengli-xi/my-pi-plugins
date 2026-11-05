# 术语表：pi-todo

- **全量替换（full replace）**：`todo` 工具的唯一写入语义——每次调用传完整列表，
  整体覆盖。新增/改状态/删除/重排是同一个操作。对应 CC 的 `TodoWrite`、Codex 的
  `update_plan`；反面是 rpiv-todo 的 CRUD（单条 create/update/delete）。
- **参数即状态（args-as-state）**：每次参数描述完整列表，不另设权威存储。持久恢复
  查找当前 branch 最新成功结果/恢复快照的 details，而非重新解析调用参数。
- **回注（reinjection）**：把当前 todo 状态重新追加到上下文末尾，让模型"照抄眼前
  最新状态再改"，防止凭远处记忆重写导致 drift。本包在 compaction 恢复流程提供文本，不做按轮提醒。
- **drift（状态漂移）**：模型对列表的认知与权威状态脱节——改错措辞、丢条目、
  update 错 id。全量替换 + 末尾可见的权威状态是主要防御。
- **缓存纪律（cache discipline）**：动态 todo 状态不放进 system prompt，不为更新
  任务改写历史；独立回注或 Compact summary 恢复遵循宿主的追加/压缩机制。避免不必要
  的 prefix 变化，不等于保证 cache 命中或零 token。
- **`content` / `activeForm`**：同一任务的两种文案。content 是祈使句
  （"Run tests"，列表展示用）；activeForm 是进行时态（"Running tests"，
  in_progress 时跟随 spinner 显示）。
- **`explanation`**：顶层可选字段，计划变更（拆分/合并/重排）时的理由，
  来自 Codex `update_plan`。UI 展示用，不参与状态。
- **compaction**：pi 在上下文过长时把历史压缩成摘要（`session_compact` 事件）。
  摘要可能丢 todo 状态，因此是唯一需要主动回注的时点。
- **widget（aboveEditor）**：pi 的 `setWidget` 常驻 UI 槽位，位于编辑器上方、
  streaming spinner 正后方。`pi-todo` 不拥有这里的 UI；`pi-claude-style` 消费
  `todo:snapshot-v1` 后，在此托管可折叠任务列表。
- **rpiv-todo**：被替换的前任 `@juicesharp/rpiv-todo`——id 寻址 CRUD、依赖图、
  墓碑删除、replay 分层。其痛点与否决理由见 ADR 0001。

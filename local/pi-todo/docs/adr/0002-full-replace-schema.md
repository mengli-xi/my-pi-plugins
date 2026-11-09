# ADR 0002: 全量替换语义，CC 三字段 + 顶层 explanation

## 决策

每次调用传入完整列表，整体覆盖当前状态。新增、改状态、删除、重排都是同一个操作。

```json
{
  "explanation": "可选：这次调整的理由（仅在计划变更时填）",
  "todos": [
    { "content": "Add schema",    "status": "completed",   "activeForm": "Adding schema" },
    { "content": "Write handler", "status": "in_progress", "activeForm": "Writing handler" }
  ]
}
```

JSON Schema 约束：

- `todos`（必填）：数组，每条 `{content, status, activeForm}` 全必填；现有 schema
  不新增额外属性拒绝规则，执行时只把这三字段投影到内存镜像；
- `content`：祈使句任务描述（minLength 1）；
- `status`：`pending | in_progress | completed` 三态，无 deleted——删除即"不出现在下一次列表里"；
- `activeForm`：进行时态文案，in_progress 时跟随 spinner 显示；
- `explanation`（可选，顶层）：计划变更理由，UI 展示用，来自 Codex 的 `update_plan`。

## 理由

- **无 id**：条目身份由内容承担。模型不需要记账，不存在"update 错 id"这类静默错误。
  CC 早期版本有 id/priority，后被主动删除；Codex 从一开始就没有。
- **行为约束放 prompt 不放 schema**（同 CC/Codex）：同一时刻恰好一个 in_progress、
  完成立即标记不攒批、失败不标 completed、简单任务不用 todo。

## 否决的替代方案

- **纯 CC 三字段（无 explanation）**：省一个字段，但中途改计划时变更理由没有结构化落点。
- **Codex 两字段（无 activeForm）**：spinner 只能显示任务原文，丢进行时态体验。
- **操作式 patch API**（`{op:"complete", index:2}`）：单次调用便宜，但要求模型与
  harness 对索引保持同步，错了是静默的语义错误；全量替换错了顶多是措辞变化。

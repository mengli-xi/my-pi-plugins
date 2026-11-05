# ADR 0004: UI 范围——内联渲染 + /todos；spinner 下列表由 pi-claude-style 托管

日期：2026-08-09 · 状态：已接受（实现阶段修正）

## 实现阶段的关键发现

设计阶段以为"跟随 spinner 的可折叠列表"是 rpiv-todo 的 overlay。实现前查证发现
**它其实是 pi-claude-style 画的**（`src/todo-state.ts` + `bootstrap.ts`）：

- `classifyTool` 把名为 `todo`/`todowrite` 等的工具归类为 todo 类；
- `tool_execution_end` 时读工具结果的 **`details`**，兼容
  `{tasks:[{subject}]}` 与 `{todos:[{content}]}` 两种形状，每条必须有
  `id`（number|string）和 `status`；
- 列表挂在 working row 下方（点击折叠/展开、完成项折叠为 `✓ N done`、
  runs 之间转为 aboveEditor widget），rpiv-todo 自己的 `rpiv-todo*` widget key
  反而是被它拦截吞掉的；
- 重启/`/reload` 后它自己从 session entries 里 seed（找最新 todo toolResult
  的 details）。

## 决策（修正后）

1. **不注册自己的 widget 或 statusline slot**。spinner 下的可折叠列表和
   `[[pi:slot:todo]]` 都由 pi-claude-style 托管，二者共享一份折叠状态；
   pi-todo 通过 `todo:snapshot-v1` 发布语义快照，并在工具结果 `details`
   中保留兼容用的全量快照：
   `{todos: [{id, content, status, activeForm}], explanation?}`——id 按位置
   生成（1-based index），只存在于 details，不进 LLM schema。
   自己再画一个 aboveEditor widget 或发布同名 slot 会形成双重 UI 所有权。
2. **内联渲染**（`renderCall`）：CC 风格 checklist——`✓` completed（划线）、
   `■` in_progress（高亮 content）、`□` pending；activeForm 供 working consumer 使用。有 `explanation` 时附
   一行变更理由。`renderResult` 渲染短确认。
3. **`/todos` 命令**：在支持 UI 的 host 中查看当前列表，保留列表顺序并显示计数头。

## 耦合记录

`todo:snapshot-v1` / `todo:request:snapshot-v1` 是与 pi-claude-style 的主
运行时 handshake；`details.todos`（`readTasks` 的 `toTask` 解析）只保留为
旧版本兼容路径。改动任一契约都需同步更新 packages.md 的 Coupled 记录。

## 否决的替代方案

- **自己实现 aboveEditor widget**（原设计）：与 pi-claude-style 的托管列表
  双重显示；且用户要的"当前渲染方式"本就是 pi-claude-style 的托管块。
- **只有内联渲染、无 /todos**：想看当前状态要往上翻 transcript。

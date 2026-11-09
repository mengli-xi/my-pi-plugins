# ADR 0004: UI 范围——内联渲染 + /todos；spinner 下列表由 pi-claude-style 托管

## 决策

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
旧版本兼容路径。改动协议时同步更新[根协议表](../../../../README.md)。

## 否决的替代方案

- **自己实现 aboveEditor widget**（原设计）：与 pi-claude-style 的托管列表
  双重显示；且用户要的"当前渲染方式"本就是 pi-claude-style 的托管块。
- **只有内联渲染、无 /todos**：想看当前状态要往上翻 transcript。

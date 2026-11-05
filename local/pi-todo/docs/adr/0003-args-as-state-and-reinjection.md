# ADR 0003: 参数即状态；compact 后回注；resume 从 transcript 恢复

日期：2026-08-09 · 状态：已接受

## 决策

**参数定义完整列表，持久恢复以当前 branch 上最新的成功结果/恢复快照为准。** 不把失败调用或未提交的内存镜像当作持久状态。由此推出三条规则：

1. **工具结果只回短确认**（如 `2/5 completed, 1 in progress`），不回显完整列表。
   全量替换语义下参数本身完整躺在上下文里，回显等于每次付双倍 token。
   （Codex 式；CC 式回显被否决。）
2. **`session_compact` 后回注一次**：compaction 摘要可能压丢 todo 状态，事件触发时
   用 `pi.sendMessage({customType: "todo-state", ...})` 把当前完整列表持久追加进
   session。这是唯一的回注点——不做 turn 计数式的 stale 提醒（已否决，多一套
   计数逻辑 + 偶发 cache miss，收益不明确）。
3. **resume / 分支切换时从 transcript 恢复**：`session_start`（及树导航事件）查找当前
   projected context 中最新的成功 `todo` tool result 的 details 或 `todo-state` 快照，
   不重新解析调用参数；必要时从 active branch 追溯 recovery marker 指定的 source entry。
   恢复失败清理旧内存镜像并诊断，不持久写入空状态。无独立存储文件，仍不需要额外
   store/reducer/replay 分层。

## 缓存纪律

动态任务状态不放进 system prompt，不为更新任务而回填历史。独立恢复消息由 Pi
追加；启用 Compact recovery 收集时，恢复文本随其 summary 提交并跳过重复独立消息。
这是避免不必要 prefix 变化的约束，不保证 provider cache 命中，也不代表工具调用零 token。

## 内部状态

当前实现保留单一 Todo owner 的模块内存镜像，并非 per-session Map；SDK child 不会
因此自动加载 Todo。本轮不扩展多实例架构。执行与恢复都投影拷贝三字段，内存只服务于
查看、快照广播和恢复文本生成，不是另一个权威存储。

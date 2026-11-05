# ADR 0001: 完全替换 rpiv-todo，接管工具名 `todo`

日期：2026-08-09 · 状态：已接受

## 背景

当前使用的 `@juicesharp/rpiv-todo` 是 id 寻址的 CRUD API（6 种 action、11 个参数、
4 态状态机、依赖图、owner、metadata、墓碑删除）。实际使用中的痛点：

1. 没有整体替换操作——铺新计划或中途改计划需要一串 create/update/delete 调用；
2. id 记账是 drift 高发区，update 错 id 是静默错误；
3. 工具结果只回 delta，模型对列表全貌的认知靠拼凑记忆；
4. schema + 8 条 guidelines 常驻 system prompt，面积大。

Claude Code 与 Codex CLI 两家独立迭代后收敛到同一形态：极简、无 id、全量替换。
CC 甚至是从"有 id、有 priority"的版本主动删减而来。

## 决策

新建原创包 `pi-todo`（无上游，不带 `-local` 后缀——该后缀标识 fork 包），
**完全替换** rpiv-todo：从 `~/.pi/agent/settings.json` 移除
`npm:@juicesharp/rpiv-todo`，新包接管工具名 `todo`。
旧会话的 replay 数据放弃（todo 是临时工作记忆，不是需要迁移的数据）。

## 否决的替代方案

- **fork rpiv-todo 加 replace action**：保留了它的 store/reducer/replay 分层，
  但那套复杂度只为 CRUD 语义服务；全量替换语义下"参数即状态"，分层自动失去意义。
- **并存过渡（新包用别名如 `plan`）**：两套 todo 同时在 system prompt 里互相干扰。
- **停用但保留（autoload:false）**：与移除等效，仅回滚便利性差异；配置里留死条目。

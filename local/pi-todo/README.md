# pi-todo

## 用途

提供全量替换的 `todo` 工具和 `/todos` 查看入口，不另设业务数据库。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。TypeScript 直接加载，没有 build/dist。

Pi 版本见[根要求](../../README.md#要求)；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

`todo({todos:[{content,status,activeForm}],explanation?})` 每次传完整列表，空数组清空；status 为 pending/in_progress/completed。`/todos` 查看当前列表。没有配置文件；成功结果 details 与压缩恢复快照是持久恢复来源。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

`todo:snapshot-v1`/`todo:request:snapshot-v1` 提供语义状态，`todo:changed` 只读兼容；CC 缺席时内联和 /todos 仍可用。Compact 的 collect-recovery-v1 可携带恢复文本；缺席时本包在公开 session_compact 后独立回注，带 recovery marker 时不重复。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-todo
npm test -w pi-todo
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/adr/0001-replace-rpiv-todo.md](docs/adr/0001-replace-rpiv-todo.md)：仍解释当前设计的 ADR。
- [docs/adr/0002-full-replace-schema.md](docs/adr/0002-full-replace-schema.md)：仍解释当前设计的 ADR。
- [docs/adr/0003-args-as-state-and-reinjection.md](docs/adr/0003-args-as-state-and-reinjection.md)：仍解释当前设计的 ADR。
- [docs/adr/0004-ui-scope.md](docs/adr/0004-ui-scope.md)：仍解释当前设计的 ADR。
- [docs/glossary.md](docs/glossary.md)：待办术语与设计边界。
- [docs/todo.md](docs/todo.md)：工具语义、持久恢复和展示协议。

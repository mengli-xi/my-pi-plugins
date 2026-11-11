# pi-subagents

## 用途

创建持久后台 Agent，协调 Task、等待、完成投递和同进程原生子视图。

## 加载与构建

按[根安装说明](../../README.md#安装与加载)加载本包。先在仓库根运行 `npm run build -w pi-subagents`。

目标 Pi 1.5.0；编译消费者改源码或共享库后须重建并启动新进程。

## 配置与命令

`/subagents [Agent ID|task path]` 打开管理器或目标视图。模型工具为 `spawn_agent`、`send_input`、`resume_agent`、`close_agent`、`wait_agents`、`list_agents`、`list_subagent_models`、`list_subagent_roles`；完整名称与状态矩阵见使用合同。配置为用户 `<agent-dir>/pi-subagents/config.json`、受信项目 `.pi/pi-subagents.json`，schemaVersion 2；默认 depth 1、open 32、Main/process active 各 10、Task timeout 30 分钟。数据位于独立 store-v2，不读、不转换、不删除 store-v1。

`<agent-dir>` 由 Pi 公开 `getAgentDir()` 提供，遵守 `PI_CODING_AGENT_DIR`。

## 可选协作与降级

CC presentation 缺席时使用 Pi 原生消息渲染；Completion 保留单行 fallback。已加载插件按 [child-capabilities-v1](../pi-runtime-contracts/docs/child-capabilities-v1.md) 的声明装入子会话，工具仍受 role/closure 约束；外部 SDK provider 保持独立批准，缺失不影响普通委派。选择已声明但未批准的 provider 开子 agent 时，明确提示 provider、target 和实际 grant 批准路径，不回退模型；见 [SDK provider 合同](docs/sdk-providers.md)。Compact recovery 收集缺席时保留独立恢复路径。

## 验证

仓库根运行：

```sh
npm run typecheck -w pi-subagents
npm test -w pi-subagents
```

自动测试使用临时配置、fixture 或 faux provider，不证明真实 provider、人工终端或完整 profile。跨插件联测见 [integration](../../integration/README.md)。

## 文档

- [docs/architecture.md](docs/architecture.md)：架构、Host 权限、运行模型、能力冻结与上下文选择。
- [docs/delivery.md](docs/delivery.md)：完整 Completion、Barrier、Wake、receipt 和 ACK 合同。
- [docs/mailbox-v1.md](docs/mailbox-v1.md)：信箱格式、稳定身份、投递与恢复合同。
- [docs/maintenance.md](docs/maintenance.md)：维护取舍、排障和验证入口。
- [docs/persistence.md](docs/persistence.md)：完整持久化 schema、journal、事务、升级和恢复合同。
- [docs/sdk-providers.md](docs/sdk-providers.md)：外部 SDK provider 声明、独立 grant 和生命周期。
- [docs/ui.md](docs/ui.md)：列表、输入、已读、主题与终端交接。
- [docs/usage.md](docs/usage.md)：配置来源、范围、工具参数与状态矩阵。
- [subagents 技能](skills/subagents/SKILL.md)：模型侧委派、等待和关闭指引。

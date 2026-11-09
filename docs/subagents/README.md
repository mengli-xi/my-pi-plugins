# pi-subagents 现行合同

公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0，唯一同进程 SDK；managed native thread UI 在原版上允许主题降级并首次提示，双面匹配补丁能力时支持热更新，边界见 [UI_SPEC §5](./UI_SPEC.md#5-主题与终端释放)。Agent identity/native history 持久，runtime 可显式关闭和恢复；Task 完成不关闭 Agent。旧 Supervisor/Owner IPC/PTY transport 已删除，现行事务与 ACK 约束分别归 Host 和 Delivery。

| 需要了解 | 文档 |
|---|---|
| 功能、工具与权限 | [FEATURE_SPEC](./FEATURE_SPEC.md)、[TOOL_CONTRACT](./TOOL_CONTRACT.md) |
| 生命周期、容量与配置 | [RUNTIME_MODEL](./RUNTIME_MODEL.md)、[CONFIG](./CONFIG.md) |
| Host、事务、持久化、投递 | [HOST_API](./HOST_API.md)、[PERSISTENCE_FORMAT](./PERSISTENCE_FORMAT.md)、[DELIVERY_PROTOCOL](./DELIVERY_PROTOCOL.md) |
| 界面、上下文与能力 | [UI_SPEC](./UI_SPEC.md)、[CONTEXT_SPEC](./CONTEXT_SPEC.md)、[CAPABILITY_SPEC](./CAPABILITY_SPEC.md) |
| 集成、信任、包布局、操作与验收 | [INTEGRATION](./INTEGRATION.md)、[SECURITY](./SECURITY.md)、[PACKAGE_LAYOUT](./PACKAGE_LAYOUT.md)、[OPERATIONS](./OPERATIONS.md)、[TEST_PLAN](./TEST_PLAN.md) |

现行合同保留 close/resume/send_input、默认 10 active/32 open、depth 1/2、用户 Enter/Alt 输入与 Running/Done。source-only 依赖已迁入，package 源码、技能与回归测试和本目录 16 份现行规范分开交付；mailbox-v1.0.5 仍须重建 compiled consumers 并 fresh process。旧存储不读、不转换、不删除，正式 profile 切换另行验收。

核心执行边界：已完成 open Agent 先 close/drain 再 delete；Process 正常排队不因 30 秒误变 record-only，连同 watchdog/cancel 收口；builtin consumer 仅补齐 codemode/tool-search canonical factory，保留 role/tools fences，以 `builtin_proof={version,pi_version}` 核对 canonical Pi.VERSION；非 builtin Search/Processes 的 `execution_factory` proof 才直接读取实际物理 factory 文件做 SHA 校验。旧 profile 仍可读取和列出，缺 proof 不创建可执行 SDK 会话。waiting activation 收尾只清理本 grant 捕获的 order；共享 mailbox 将有界读取竞争与真实损坏分开处理，不因正常并发追加持久停用。具体行为必须由测试与 fresh-process 验收证明，文档本身不是验收证据。

当前 MCP 使用 pi-mcp-adapter，child 继承须由 adapter 自己明确能力声明/工厂并独立迁移验收，现在不宣称支持；不以 stock MCP 替代，不解析其配置或冻结 raw 凭据。共享 Runtime 的通用显式 Builtin 接口默认全禁，其可选 MCP 支持保留但不授权本 consumer；未选中的 builtin 不启用，llama.cpp 非工具、不启服务。

真实 provider/cache、全 profile、规模性能和人工 TUI 尚未验收，不能用历史 process 验收或 faux 结果替代。现有 CC presentation 是子视图必需依赖；本轮不迁入、不提交 Processes/CC，仅在目标外使用真实源码构建产物作所需测试依赖，不算它们验收，也不删除功能假造通过。历史 IMPLEMENTATION*/IMPLEMENTABILITY 报告和 ADR 随原仓归档，未迁入；不再作为现行链接目标或新验收证据。

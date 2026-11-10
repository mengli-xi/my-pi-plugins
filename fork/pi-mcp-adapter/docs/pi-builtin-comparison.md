# 与 Pi 内建 MCP 的关系

这里说明当前 Adapter 的选择与 ownership，不维持旧 host 的性能排行榜。Pi 内建功能以所用 Pi 版本的[官方 MCP 文档](https://pi.dev/docs/latest/mcp)为准，不能把上游 Pi 0.99/1.3 的表格当 Pi 1.5.0 实测。

## 配置与命令归属

普通 file mode 中 Adapter 使用 Pi 公开 MCP config/registration API，注册 `/mcp` 后替代 session 内建 MCP extension；global settings 的 builtin switch 写入及卸载恢复见[配置](configuration.md#与内建-mcp-的-ownership)。Shell `pi mcp` 仍属于 Pi 自己，不被 Adapter CLI 接管。

隔离 `createMcpAdapter({config})` 不读 Pi MCP config，因此不替代内建 `/mcp`，只注册 `/mcp-adapter`；host-managed 是更窄的 supplied-transport 模式，见[SDK](extension-api.md)。

Server definitions 可以由 Pi mcp.json 共享，**OAuth 登录态不共享**。Adapter 不读取/导入/删除 Pi native credential files；已有 Adapter credentials 继续可用，只依赖旧 native import 的用户需重新认证。Pi 公开 provider-token 接口则继续支持。

## Adapter 提供什么

| 需求 | Adapter 当前合同 |
|---|---|
| 不把全部 schemas 常驻模型上下文 | Gateway + deferred/search/direct 的分层暴露 |
| 不让全部 server 常驻 | 默认 lazy，有效 metadata 可离线搜索；缺 metadata 默认 discovery，idle 后断开 |
| 导入多个 client 配置 | 显式 setup/imports，尊重 runtime overrides，外部配置不改写，project trust 不绕过 |
| 语义检索 | Pi classifier 与 Pi 登录，仅显式 semantic search 外发 metadata |
| 过滤长结果 | Pi codemode 本地经工具组合；或显式 opt-in extraction 外发结果给 Cloudflare |
| 长任务 | modern Tasks extension，交互式 handle + mailbox 结果；code/UI/headless 等待 |
| Server 交互 | prompts、form/URL elicitation、text sampling、Apps UI |
| Credentials | OS secure store，显式 encrypted-file 可选，store unavailable fail closed |
| 工具审批 | approveTools + legacy broker，正常 no-claim/abstain 回退自有 gate |
| 多个 Pi session 共享 stdio | 显式 rmcp-mux，daemon 与共享权限由外部管理 |

Codemode 用 Pi 自己的实现，Adapter 不自动开启，需 defaultTools `+codemode`。它可调用其他 Pi tools，并非 MCP-only 限制。ScriptTools 把重复流程变成 deferred named tool，不恢复已删除的 mcpScript。

## 不作的承诺

- 不承诺“首次运行不联网”：metadata 缺失、eager/keep-alive、Executor catalog discovery 等会连接。
- 不承诺 lazy 一定零成本：schema registration、first-use imports、server startup 都有成本，需要当前 profile fresh-process 实测。
- 不把上游旧 server RSS、token cost、classifier sample 排名当本地 Pi 1.5.0 测量。
- 不因关闭 HTTP/socket client 就声称远端服务退出。
- 不把 roots 当本地私有信息：默认向 server 发送 session cwd，需 roots false 才禁用。
- 不由 upstream main 的三项 Unreleased 说明推断 7.0.1 已具备对应 security 修复。

如何选功能、如何验证使用中的行为，见[README](../README.md#文档目录)与[使用回归](usage-regression.md)。

# Server 合同

`mcpServers.<name>` 定义连接。完整认证规则见[认证](auth.md)，global 默认值见[配置](configuration.md)。

## 全部字段

```json
{ "mcpServers": { "docs": { "command": "npx", "args": ["-y", "some-mcp-server"], "lifecycle": "lazy", "idleTimeout": 10 } } }
```

| 字段 | 含义 |
|---|---|
| `command` | stdio executable，与 url/socket 互斥 |
| `args` | command arguments |
| `socket` | 显式 `rmcp-mux` Unix socket，支持 env/`~`；与 command/url 互斥 |
| `env` | stdio env，支持 `${VAR}`、`$env:VAR`；`!command` 在连接时执行，`!!` 转义 literal `!` |
| `inheritEnv` | 默认 true 继承 host env；false 只留下 SDK platform defaults 和显式 env，不是空环境或 sandbox |
| `cwd` | stdio working directory，支持 env/`~` |
| `url` | Streamable HTTP endpoint，按规则 fallback SSE；支持 raw env interpolation，变量缺失时请求前失败 |
| `headers` | HTTP headers，支持 env/secret command |
| `requestHeadersCommand` | 每个 transport HTTP request 执行的可信 signer；stdin versioned JSON `method/url/bodyBase64`，stdout header object；command/args/env 支持 env，失败阻止请求 |
| `caFile` | HTTPS origin 的 PEM CA/bundle，**替换**默认 roots；relative 按 process cwd，支持 env/`~`；不可读/无效时 fail closed |
| `auth` | `bearer`、`oauth`、false，或 user-global `{provider:"name"}`；HTTP 省略自动探测 OAuth |
| `oauth.grantType` | `authorization_code` 默认，或 `client_credentials` |
| `oauth.clientId/clientSecret` | 预注册 client；secret 支持 `!command/!!`；clientId 高于 CIMD |
| `oauth.clientMetadataUrl` | opt-in 的 operator-hosted public HTTPS CIMD URL，非根 path；支持时作为 client_id，否则 DCR fallback；不内置/托管文档；配 secret 必须另有显式 clientId |
| `oauth.scope` | scope |
| `oauth.authorizationParams` | provider 额外 authorization 参数；不可覆盖 flow-owned fields |
| `oauth.redirectUri` | 浏览器 callback；loopback http 支持 exact port 或 `{port}`；https 预注册 callback 手动粘贴完成 |
| `oauth.clientName/clientUri/logoUri` | DCR metadata；clientUri 采用 host manifest piConfig.clientUri，rebranded host 缺省时省略不猜；logoUri 只能 absolute http(s) |
| `oauth.authServerMetadataUrl` | authoritative HTTPS OAuth/OIDC metadata，仍校验 issuer |
| `oauth.skipIssuerMetadataValidation` | 默认 false；true 弱化 mix-up protection，仅供临时兼容已知坏 metadata |
| `bearerToken/bearerTokenEnv` | 显式 token 或 env name，token 支持 env/secret command |
| `bearerTokenStore` | 默认 false；true 且无显式 token/env 时从 Adapter OS store 读，绑定 server name + resolved URL，不能由 config 自选 account |
| `lifecycle` | lazy/eager/keep-alive/lazy-keep-alive |
| `idleTimeout` | 分钟，覆盖 global；0 关闭 |
| `requestTimeoutMs` | 毫秒，省略/<=0 SDK 默认；progress 重置 tool timeout，Tasks 每次 request 独立计时；Executor execute/call 省略时至少 6 分钟 |
| `protocolVersion` | legacy 默认、auto、2026-07-28；modern opt-in |
| `tasks` | modern Tasks 默认 true，false 不用 Task path |
| `exposeResources` | 默认 true，resources 转 tools |
| `directTools` | false 默认、true、原始名字 string[]、search |
| `toolPrefix` | server/short/none/mcp，覆盖 global |
| `includeTools/excludeTools` | original/resource-generated/prefixed names 或 glob[]，exclude 后应用 |
| `searchKeywords` | tool/glob 到 string[]，只影响 Adapter search，不进 schema/cache |
| `openUi` | true 默认；false 不宣告 Apps UI capability，不开 UI/session，server 可改为 inline 返回 |
| `appendStructuredContent` | true 默认；false 且 content 非空时不重复把 structuredContent 展示给模型；content 空时仍展示 |
| `roots` | **true 默认，会发送 Pi session cwd**；false 不向该 server 披露 roots，可避免覆盖 filesystem server 自己 args 中目录 |
| `description` | server 用途，参与 search/panel/server listing；非 string 忽略并警告；未设时 panel 用 instructions 首行 |
| `debug` | 默认 false，显示 stderr；MCP log notifications 另写 `<Pi agent dir>/mcp.log`，超过 5 MB 轮换为 mcp.log.1 |
| `trace` | metadata-only JSONL；不存 raw payload/prompt/args/result/auth/URL |
| `disabled` | 仅 literal true 禁用连接/auth/tools/resources，配置/status 仍可见 |

`${VAR:-default}` 只在 unset 时取 default，已设为空仍为空，不报缺变量。`literalEnv: true` 让 stdio env 保持 literal。Transport 与 helper 的完整环境边界见下文。

## HTTPS 与网络诊断

`caFile` 适用于 Streamable HTTP、SSE、per-request headers command 走的 MCP origin；hostname/expiry 验证仍开，不信任其他 origins。带此 trust 的 request 拒绝所有 redirects，须配置最终 HTTPS URL。层叠配置换 URL 或离开 HTTP 会丢弃 inherited trust。它覆盖该 origin 的 connection-owned OAuth，不覆盖独立 interactive OAuth 或另一个 origin 的 private-CA auth server。

macOS 15+ 对 literal private/link-local IP 的 HTTP 连接若报 `EHOSTUNREACH/ENETUNREACH/EACCES`，会保留 cause 并提示 Local Network Privacy；不解析 hostname，也不能把此 hint 当隐私拒绝证明。检查 System Settings → Privacy & Security → Local Network 中真正 hosting app 的权限并重启；Apple Terminal/SSH 可用于诊断。给 unsigned CLI 签名不保证解决 responsible-code attribution。参见 [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)。

## Protocol negotiation

`legacy` 使用 classic initialize，不发 `server/discover` 或 2026 headers，兼容 deployed 2025-era servers。`auto` 探测 2026-07-28，只在明确 legacy evidence 时保守 fallback。Cloudflare Workers createMcpHandler 等 v2 stateless servers 可设置 auto。Stdio 每次 fresh auto connection 先短命 sibling 探测，再启动 session process，增加一次 spawn 并可能等待 request timeout；socket 原地探测。HTTP 用真实 Streamable connection；只有明确不支持 Streamable 的 404/405/406/415 等才 fallback SSE，auth/cancel/timeout/server error 不 fallback。

固定 `2026-07-28` 不支持 legacy/SSE fallback，server 未提供该 revision 就失败。全局默认仍 legacy。

## Tasks

支持 [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview) `io.modelcontextprotocol/tasks`（SEP-2663）；需要 modern connection 且 server 宣告 extension：

```json
{ "mcpServers": { "ci": { "url": "https://ci.example.com/mcp", "protocolVersion": "auto" } } }
```

未宣告时不改变正常调用；`tasks:false` 强制同步路径。不支持 legacy 2025-11-25 experimental tasks。

### 异步结果与投递

交互式普通 tool call 收到 Task handle 后立即返回 ID，agent 可继续工作；后台按 server 建议间隔 polling。Terminal result 通过[共享 durable mailbox](mailbox.md)进入模型，消息以 `MCP task <id> (<server>/<tool>) completed.` 开始，或 failed/cancelled/outcome unknown。结果走 output guard；failed 附错误，`isError:true` 按 tool error 处理。只有共享 mailbox 决定何时自动运行和合并 wake，Task 不再独立 sendMessage/triggerTurn。Durable acceptance 与 native projection 分开，失败不可冒充已送达。

`input_required` 仍打开原有 form/browser elicitation，答案经 `tasks/update` 返回。初始 call 等 handle 期间 Esc cooperative `tasks/cancel`；拿到 handle 后 Esc 不再取消它。用 `/mcp-adapter tasks` 查看 latest status，`tasks stop <server>/<taskId>` 停止；footer 显示运行数。模型可用 `mcp({cancelTask:"<server>/<taskId>"})` 停止自己发起的任务，不额外审批。隐藏 proxy 时不显示此提示，只能用 slash command。

以下调用需要值或无法接收后续自动消息，因此**等待**最终结果：codemode/其他工具/extension runtime event、UI tools/iframe calls、Executor、print/JSON/RPC（包括 subagent）。取消这些调用也发送 tasks/cancel；失败按同步错误返回。

### 恢复、取消与 owner

Health failure、HTTP session expiry、显式 reconnect 替换连接后继续跟踪原 task，不发送 cancel。Session switch/fork/reload/quit 保存 active tasks 到所属 session，重新打开同一 session 才恢复；fork/new session 不继承。Accepted terminal mail 的恢复归共享 mailbox，不重复跑 tool 或向 sibling branch 改投。

显式 stop/cancelTask、logout、以及连接彻底关闭且没有 replacement（如 server process 退出）会 cooperative cancel，并产生对应终态通知。Disable/remove 在 reload 生效：保存任务，不发 cancel；新 session runtime 找不到 server 时报告 outcome unknown，远端可能仍继续工作。

无法继续跟踪时只产生对应的 unknown outcome，不自动重试原 tool，避免重复副作用。原因包括 server removed/disabled、URL/command 改变、server 回 tasks/get `-32602`（expired）、连接/认证失败，或 connection change 后无法 follow。`env/headers` 改变不计入当前 task identity 检测。

Stdio process 通常随 Pi 退出，重启后任务多半 unknown。保存 active task 是恢复 polling 的记录，不是旧 volatile terminal result 的补偿 outbox；不能编造历史未持久化结果。当前 terminal delivery 的冻结身份、payload、lineage、ACK 与 owner 见[mailbox](mailbox.md)。

### 协议限制

Tasks 使用官方 `@modelcontextprotocol/ext-tasks` requester，在 SDK client 下接 dedicated raw channel，链上连接 transport handler，不替换 transport。Trace 可见双向 task frame 的 metadata；不消费 `notifications/tasks`，只 polling。Timeout 按 initiating call/每个 poll，不限制总 task duration；运行时保持连接不 idle stop。

有 active task 时该 connection 的所有 tools/call 走 task-aware path，不走 Client.callTool；SDK client-side structuredContent output-schema validation 与 SEP-2243 Mcp-Param-* header mirroring 因此不运行，不能把 server 自己的验证等同 client double-check。

SDK 负责不同协议年代的 envelope/result/list_changed/cancel/multi-round-trip sampling/elicitation。Embedded-input progress callback 没有 originating tool/resource identity，不能提供 durable per-tool waiting row；TUI 保留 dialog，proxy 可显示 progress。Issuer validation 默认保持开启。Roots 默认披露 session cwd；protocol cache-hint 配置/UI 尚未实现。

## Stdio 环境边界

`inheritEnv:false` 只约束实际 stdio child 和 modern negotiation sibling，保留 SDK platform defaults + explicit env；不影响别的 server。Env interpolation 仍可主动读取 host `${VAR}`、`$env:VAR`、`{env:VAR}`，因此不是 isolation sandbox。

以下 helpers 仍继承 full host env：npm/npx resolution/cache population、`!command` secret helper、HTTP requestHeadersCommand。需要更小暴露面时用 direct executable 且避免 secret helpers。Agent Plugins/OpenCode schema 不接受 Adapter-specific inheritEnv，要在 Adapter override 设置。

## 显式 rmcp-mux

```json
{ "mcpServers": { "memory": { "socket": "~/.rmcp-servers/rmcp-mux/sockets/memory.sock" } } }
```

Adapter 只拥有 client socket。Mux daemon 的启动/发现/adoption/停止、upstream process、routing、initialize cache、restart、client limits 和 socket permissions 都由外部 [rmcp-mux](https://github.com/VetCoders/rmcp-mux) 管理。本包不隐式运行 daemon；共享 endpoint 意味着共享 tools/state/credentials/filesystem scope，只对明确允许共享的项目/用户配置。

## URL install

```js
mcp({ action: "install", url: "https://example.com/mcp" })
```

先验证和连接，再保存新条目到 global Adapter config，name 默认来自 hostname；`server` 指定名字，`target:"project"` 写项目 `.mcp.json`。已有同 URL 复用不重写；unsafe URL、name collision、连接失败不持久化。`settings.allowInstall:false` 阻止 gateway install，不影响 search/connect/auth/runtime registration/setup。

Exclusive mode 的 project target 必须是 active config path；否则用 global。不能把 runtime registration 直接 promote 为 config，需手写完整 headers/transport/auth definition。

OAuth server 先打开 consent page 并观察 loopback callback；成功通知也走 mailbox，再由 agent 连接并检查 tools。Remote/headless 保留[手动完成](auth.md#remoteheadless-认证)，credential success 不等同通知已 durably accepted。

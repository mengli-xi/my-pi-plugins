# 扩展 API、plugins 与 SDK

本包可以独立加载，跨插件只走公开能力/event，不 import 别的插件或解析其私有存储。需要额外 MCP protocol 时见[protocol extensions](protocol-extensions.md)。

## Agent Plugins

```json
{ "settings": { "agentPluginPaths": ["./plugins/acme-tools"] } }
```

显式目录必须有合法 Agent Plugins 1.0 plugin.json；root mcp.json 的 mcpServers 按 `<plugin>__<server>` 前缀加载，使用声明 type，坏 entry 不阻塞其他 server。Stdio 在 args/env/cwd 展开 PLUGIN_ROOT/PLUGIN_DATA，并设置 child env；data 放 Pi agent directory。

`inheritEnv` 是 Adapter-specific，不可塞进 strict Agent Plugins/OpenCode schema，需在 Adapter override 用翻译后名字设置：

```json
{ "mcpServers": { "acme_tools__local": { "inheritEnv": false } } }
```

## Local Claude plugins

```json
{ "claudePlugins": [{ "path": "./plugins/acme-tools", "mcp": true, "skills": true }] }
```

每项 path 非空且至少启用 mcp/skills。任意普通 config 来源可设，较高优先级 array 整体替换。File config relative path 按 active project cwd；程序化 config 在 factory 创建时按 process.cwd() normalize，一次快照使早期注册/session 启动不随 host context cwd 漂移。

Mcp 只读 root `.mcp.json`；skills 发现 skills/**/SKILL.md 并交 Pi public resource discovery（含 startup/reload）。可选 `.claude-plugin/plugin.json` 若有须 valid JSON/kebab-case name/标准字段类型；不跟随 manifest path overrides。

Server name 原样，plugin 间冲突第一显式项胜，普通 Pi MCP config 高于 plugin defaults。CLAUDE_PLUGIN_ROOT 展开 server fields 并传 stdio env；skills 冲突/解析由 Pi 处理。

只信任显式 local directory，不自动发现/download/install/update plugin，不跑 hooks，不从 MCP instructions 拉 skills；组件逃逸目录的 symlink 拒绝。发现时读 config/skills，命令仍按 lazy/trust/lifecycle 运行。

## Pi package manifests

```json
{ "pi": { "mcp": "./mcp.json" } }
```

pi.mcp 也接受 package-relative paths array；只取 mcpServers，不取 settings/imports，名字加 sanitized package prefix（如 acme_tools__docs）。只加载 Pi settings 列出的 packages，不扫描 node_modules；普通 global/project config 优先。Project settings 带来的 package servers 仍需 project trust/approval。

## Runtime registration

Pi 公开 `pi.registerMcpServer(name,definition)`/unregister 可被 Adapter 接管。配置采用 Pi MCP grammar，按[配置](configuration.md#文件与目录发现)转换；不能执行的 entry 报告，不猜支持。Load-time registration 随 session 接入，之后实时应用；same config 复用连接，different config 替换，unregister 断开。

Runtime server 不主动 direct，cached tools 仍可 deferred；只解释 exposure hidden/enabled false 为 disabled，direct/deferred exposure 忽略并报告。Configured 同名胜出，早先 Adapter event registration 也胜出。

Adapter 的 versioned event：

```ts
const request = {
  version: 1,
  name: "acme__docs",
  definition: { url: "https://mcp.example.com/mcp" },
  result: undefined,
};
pi.events.emit("pi-mcp-adapter:runtime-register:v1", request);
// result: {ok:true,registration:{dispose():Promise<void>}} | {ok:false,error:Error}
```

`session_start` 或以后 emit，listener 已安装；result 同步设置，first response wins。无 result 表示能力缺失，消费者必须降级/报不可用，不能假设总安装 Adapter。无需 import runtime plugin。注册 session-scoped，不写 config，duplicate fail closed；正常 lazy/OAuth/approval/shutdown，不主动 direct，下一 sync 可见。换定义先 dispose 再 register；shutdown dispose 释放。

## Runtime tool call

```ts
const request = { version: 1, tool: "search", args: { query: "mcp" }, server: "docs", result: undefined };
pi.events.emit("pi-mcp-adapter:runtime-tool-call:v1", request);
// result?: Promise<{ok:true,result:{content:unknown[],details?:unknown}} | {ok:false,error:Error}>
```

Emit 内同步给 result promise，然后 await；无 result 是能力不可用。Session_start 后才可用，shutdown 后失败。Tool/server 解析如 gateway，disabled/approval 同规则；tool error/deny 返回 ok false。Event call 不经 Pi tool hooks，但仍过 legacy approval broker（origin script）与 output guard。

需要 full raw result 的自有 tool 可通过 Pi public ctx.executeTool nested call，按自己的输出负责限制；这不授权绕开 Adapter gates。

## SDK 配置

Public entries：package root、`/types`、`/oauth`、`/host-managed`、`/config`、`/metadata-cache`。本地构建生成 per-file JS 与 declarations，SDK/Pi 从 compiled exports 加载，不要求 standalone consumer 直接执行源码 `.ts`。不要 deep-import private implementation。

```ts
import { createMcpAdapter } from "pi-mcp-adapter";
const extension = createMcpAdapter({ config: { mcpServers: { docs: { url: "https://mcp.example.com/mcp", lifecycle: "eager" } } } });
```

Supplied config 是完整隔离快照，不 merge files/imports/global/project/--mcp-config、不修改原对象；每 factory/session clone。显式 claudePlugins 是快照指明的 local file 读取例外，relative path 在 factory 创建时 normalize。

Status/reconnect/explicit auth/proxy/direct 仍可用；setup/无参数 auth/status panel 不猜 ambient config，说明限制。内建 `/mcp` 留给 Pi，Adapter 只 `/mcp-adapter`。`configPath` 而无 config 时仍按正常 merge，path 高于 argv；default export 正常 file mode。

Credentials 按 configured name + URL binding，不按 oauthDir 隔离；oauthDir/MCP_OAUTH_DIR 仅 legacy plaintext import。State/PKCE flow-local，parallel flows 不共享 transient secrets。

### Public OAuth helpers

```ts
import { getMcpOAuthTokensForUrl, updateMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth";
const tokens = await getMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp");
await updateMcpOAuthTokensForUrl("jira", "https://jira.example.com/mcp", { accessToken: "..." });
```

Subpath 仅 token read/update 与 status，不暴露 client registration secrets/state/verifier。Async token read 可 refresh 后返回；service headers/pre-registered refresh 需要显式 `{definition:{headers,oauth}}`，不从 ambient config 偷读、不与 token 一起存，headers 只限 MCP origin。保持 secure-store/chunk/legacy import/URL/fail-closed 边界。

Status helper 与 mailbox credential guard 是只读 live-store 检查，不等同可 refresh 的 token read helper；不能为了 status 触发 OAuth/import/compact 或修改凭据。Adapter 不提供 native sign-in import。

## Host-managed

`pi-mcp-adapter/host-managed` 面向自己持有 transports/credentials、记录每次 dispatch 并决定 start/stop 的嵌入应用；只想提供 config 用 createMcpAdapter。

```ts
import { createHostManagedMcpAdapter } from "pi-mcp-adapter/host-managed";
const adapter = createHostManagedMcpAdapter({
  servers: { github: { createTransport: () => makeTransport(), tools: ["search_issues", "get_issue"] } },
  async onToolCall(call) {
    await journal.record(call.toolCallId, call.server, call.tool, call.arguments);
    return await call.dispatch();
  },
});
await adapter.ready();
// 把 adapter.extensionFactory 注册到 Pi 的 public resource loader。
// session settle 后 await adapter.close()。
```

Ready 前不连，每个 factory 只调一次；任意 server start 失败、selected tool 缺失或 `<server>_<tool>` Pi name 冲突时 ready reject 并关闭。Tools 省略选全 catalog，ready 后冻结。ExtensionFactory 在 ready 未完成或 close 后抛错。Close 拒绝新 calls、abort in-flight，最多 5 秒关闭 transports，不重连 dropped connection。

每次 call 先 legacy broker（origin direct），只有 allow_once/allow_for_session 执行；deny/abstain/no listener 一律 not_sent，onToolCall 不会看到。收到 frozen arguments/input schema/toolCallId/opaque connectionId，dispatch single-use，最多发一次 tools/call。Returned raw 或 transformed result 都 output-guard，isError 按 tool error。

HostManagedMcpError 原始错误只在 cause，模型固定安全文本：

| delivery | 含义 |
|---|---|
| not_sent | 未发，tool 未执行 |
| may_have_run | 已发但结果未知：timeout/cancel/lost connection/HTTP error；模型不得自动 retry |
| server_error | JSON-RPC error，带 protocolCode |
| invalid_result | 已返回但验证失败（含 outputSchema），可能已执行 |

Tools list_changed 重新 list：selected tool 改变/消失永久 retire；re-list 失败 retire 该 server 全部 selected tools。Call 等 re-list，并在 onToolCall 前和 dispatch 内双检，not_sent，提示新 session。

Dispatch 成功后 `call.linkedResource(uri)` 只允许该 result 的 resource_link，独立 broker（origin resource,args {uri}）、同 connection；返回 readId/single-use dispatch，可先 journal。非 linked URI throw，parent settled 后 not_sent。Deny 时错误带 denied true 与清理后的 denyReason（若有），abstain/lost broker 不带。

Supplied transport 不得有 authProvider 或 retry/replay。Adapter 关闭 SDK multi-round-trip autofulfilment，传 tool definition 避免 header mismatch resend，不做 recovery/reconnect。此模式不读 config/OAuth/store，不注册 commands/UI/gateway/resource tools/prompts，不答 sampling/elicitation，不含 Executor handling。

## Status snapshots

`MCP_STATUS_EVENT` 的值为 **`pi-mcp-adapter/status/v1`**，从 public package export 获得；消费者订阅 shared event bus，无 listener 时不能依赖 status。

Read-only copied snapshot：totalTools/totalResources/connectedCount/disabledCount；每 server name/status/toolCount/directToolCount/disabled，已知时 resourceCount，active failure 才有 failedAgoSeconds。Status 可为 connected/cached/failed/needs-auth/not-connected/disabled。

读取 status 不连 lazy server、不 auth、不泄露 SDK client/transport/credentials/definitions。初始化 authoritative metadata 与 active direct registry reconcile 后才 emit 首份；metadata/status 更新 emit，shutdown emit empty。Connected snapshot 因此在模型 surface sync 之后，包括 authoritative empty catalog 清旧工具。

## 协作与验证边界

新 event 都 versioned：runtime-register:v1、runtime-tool-call:v1、protocol:v1、status/v1；tool-approval-request 仅保留 legacy 兼容，不可据此给新协议沿用无版本命名。Approval abstain 与 host-managed 差异见[工具](tools.md#legacy-broker)。

Apps/OAuth/Task 用 shared Inject **library**，不是 plugin dependency。包内不加载 CC/其他插件；真实 CC/Inject/SDK 组合、缺失可选方与加载顺序测试放根 integration。Export availability 的隔离 import 不得读取真实 credentials 或连接 server，也不等于完整 SDK 联测。

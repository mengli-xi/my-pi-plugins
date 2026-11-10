# 工具调用

Gateway、search、direct/deferred tools、approval 与 output guard 的完整合同。

## `mcp` gateway

| 操作 | 例子 |
|---|---|
| 状态 | `mcp({})` |
| Server tools | `mcp({server:"docs"})` |
| Search | `mcp({search:"screenshot navigate",limit:12,offset:0})` |
| Describe | `mcp({describe:"tool_name"})` |
| Instructions | `mcp({instructions:"docs"})` |
| Call | `mcp({tool:"tool_name",args:{key:"value"}})` |
| Connect/刷新已连接 catalog | `mcp({connect:"docs"})` |
| Cancel Task | `mcp({cancelTask:"<server>/<taskId>"})` |
| UI messages | `mcp({action:"ui-messages"})` |
| OAuth | `mcp({action:"auth-start",server:"docs"})`、`auth-complete` |
| Save script | `mcp({action:"save-script",args:{name,description,code,inputSchema}})` |

`args` 优先 object，也兼容 JSON string。未知 action 返回错误并列 canonical valid actions，不能静默落入别的操作。Success 默认 compact self-rendered row：title、bounded input preview、首行结果及 Ctrl+O expand hint；模型仍收到完整 guarded 结果。可用 toolResultRendering boxed、collapsedResultLines 2/3；不保证消除 Pi 自己 separator 或 inline image。

### Search、describe 与 schema

Word search 按 name/server/tool description/server description/searchKeywords 加权排名，默认 limit 12，`details.nextOffset` 翻页；`regex:true` 不排名只分页。Semantic search 另见[脚本与模型](scripting.md#语义搜索)。Search 主要查 MCP catalog，word/regex 也能找到 scriptTools；semantic 不排名 scriptTools。

Tool name 宽松匹配 hyphen/underscore；describe/tool 查不到给 top suggestions。Server annotations 只在 describe 的 Hints/approval 展示，不在 search/direct description，且不是安全保证。

`includeSchemas` 显示 compact TypeScript parameter shape；无法无损表达或有 constraints/field guidance 时给 `mcp({describe,server})`，返回原始 JSON Schema，保留 refs/definitions/integer/bounds/annotations，不展开或 fetch external refs。Describe 也受 output guard，完整超长 schema 保存到文件。

Server listing 在每个 tool 后列顶层参数，required 在前、optional 带 `?`；无 properties 显示 `()`。缺 schema 或顶层 `$ref/allOf/anyOf/oneOf/not/if/then/else/dependent requirements` 时不显示参数括号，避免漏报。

无 outputSchema 的 tool 返回 structured/JSON text 后可积累 observed output shape：仅字段名/类型，绝无 values，标记 observed 非合同；重复 wide object 用 named type。非 private catalog 可存 cache；description/input schema/config 改变即丢弃。正式 `outputSchema` 支持 draft-07/2020-12，未声明 draft 用 SDK 2020-12 default，正常 proxy/direct structuredContent 校验；Task-aware path 的限制见[Tasks](servers.md#tasks)。

Server instructions 连接时捕获并 cache，server listing 预览、instructions 操作全文返回，离线也可读。

HTTP 503 当 transient，不加 immediate retry；keep-alive 保留 cache，30 秒到 5 分钟 bounded backoff。失败连接可做单次 endpoint shape probe，提示 HTML/非 MCP 等，healthy 不 probe；不暴露 remote body。

### Search keywords

```json
{ "mcpServers": { "github": { "searchKeywords": { "search_code": ["grep"], "*": ["gh"] } } } }
```

Keys 匹配 original/prefixed/glob，所有匹配叠加，权重类似 description，exact phrase 再 boost。只影响 Adapter ranked/regex search，离线可用；不影响 Pi searchTools/tool_search，不写 schema/describe/direct registration/cache。

## Direct tools

默认 proxy-only 的含义是“不主动向模型声明全部 schema”；在当前 Pi 中，cached tools 仍可注册 deferred 给 tool_search/codemode 使用。

`directTools:true` 声明全 server，`["original_name"]` 声明选定工具，false/省略不主动声明。Server 覆盖 global；`"search"` 注册真实 schema 但 inactive，search/call 才逐步激活。75 个以上给 advisory，不阻止注册；可 warnOnLargeDirectTools false。不要把上游 token estimate 当固定实际成本。

```json
{ "mcpServers": { "github": { "url": "https://example.com/mcp", "directTools": "search", "includeTools": ["get_*"], "excludeTools": ["get_secret"] } } }
```

Include 支持 original/generated resource `read_<resource>`/prefixed/glob，exclude 最后应用，同时过滤 direct、proxy search/list/describe 和 panel。

成功 search 激活匹配项，成功 proxy call 也激活 held tool；失败不激活。`addedToolNames` 报告新增。当前 Pi 用 deferred tools 与 server namespace，激活由 Pi 写入 session branch，resume/tree 可恢复；server annotations 可被 permission extension 读取。切 true 激活、切 search 重新 hold，不计 inactive 项进 75 advisory。

Cache 有效时不需为了注册 tools 连接；首次 metadata 缺失默认会 startup discovery，当前 session 随 metadata hot-load。显式 connect 返回 addedToolNames；list_changed 刷新工具/resources。Pi 若支持 unregister 则移除 stale tools；否则隐藏/停用，不把不可用工具留下可执行。Prompt slash commands 无 unregister 能力时见 defer 规则。

Cache 不按年龄自动过期，仅 config identity 变化、server-declared `ttlMs` 或重新连接更新。共享 cache 以稳定文件版本复用 parsed state，读取失败不以空 cache 覆写，canonical 内容不变不重写。它不缓存 tool 执行结果。

`deferWithMissingMetadata:true` 时，missing/expired/mismatched/non-cacheable entries 在首个 MCP operation 前不提供 tools/prompts/resources/search entries，gateway 保留；cached prompt commands 也等 live metadata，避免无法注销。Eager/keep-alive 和 cold MCP_DIRECT_TOOLS selection 仍立即启动，Executor 未缓存 catalog 另有例外。

每个 runtime discovery 后保有自身 schema-bearing catalog；另一个 session 写共享 cache、TTL（含 0）过期、cache 删除、idle 断开不撤销当前 runtime catalog。Disk TTL 只控制 startup reuse，不延长持久 TTL。Resource discovery 失败保留同 config 旧 resource；成功 empty 移除。Current identity/disabled/filter/backoff 仍适用，authoritative empty tool list 移除工具；替换 runtime 需 fresh discovery 或 valid disk cache。

`strictDirectToolArguments:true` 恢复 schema 中 object/array 的一层 JSON string，再验证完整输入。`directToolResultDetails:"bounded"` 保留 guarded raw fields，大字段摘要，完整结果 spill；默认 lean 只留 server/tool metadata。`freezeDirectTools:true` 初次 sync 后不再注册新 surface，但 proxy/search/cache 仍刷新。

Panel direct toggles 当前 session 生效；setup 文件结构变化依 Pi 正常 reload。Subagent 可通过其公开工具选择 grammar 请求 wrapper/direct tools；不要 import subagent 插件。

## Codemode 与 tool_search

所有可经 gateway 到达的 cached tools（含 resources、未选入 directTools 名单项）也作为 Pi deferred tools。Direct/search-mode 已有名字不变，其他用 `mcp__<server>__<tool>`：非字母数字下划线归一化为 `_`，超 64 字符或冲突加 8 位 hash；归一化碰撞双方都加 hash，session 内已定名字不能重新指向另一 tool。Load-time 其他 extension 的占名无法全部预检；suffix 仍冲突则跳过并警告，gateway 报 tool_not_registered。旧 full name 仍可用于 Adapter include/exclude/approve/mcp references/call/describe/search，但 Pi 自己的 tool allowlist 要用 shortened registered name。Public resolveServerFromToolName 若 shortened name 可能属于多 server，返回无 server，不猜一个错误 owner。

Deferred 不加入 model tool list/codemode description/prompt snippet；tool_search 激活后才声明。Codemode 可以在 inactive 时调用，得到 `CallToolResult` content/structuredContent/isError，Adapter 不能执行也置 isError。

Proxy/wrapper 尽可能作为 registered real tool 的 nested Pi call，permission hooks 看得到真实名/annotations；以下仍留在 proxy：MCP_DIRECT_TOOLS=__none__、freeze 前没注册、registered tool 不可调用、schema 不可评估。Runtime event 调用没有 Pi hooks。全部仍过 Adapter approval。

Pi 1.2+ 命名尚未注册 server 的 codemode call 会先连（最多等 10 秒）；全工具 search 只等已在进行的连接。List_changed 可立即注册新增项。`MCP_DIRECT_TOOLS=__none__` 不注册 deferred/direct/script/app tools；gateway 保留。Disabled/excluded/unapproved 项不注册；freeze 也管这个 surface。Pi 1.1+ `--tools` 未列 mcp__ 仍保留 deferred 可达；要完全排除用 `--exclude-tools 'mcp__*'`。

ScriptTools 作为 `mcp__script__<name>` deferred，Executor app tools 作为 `mcp__<server>__<app>_<tool>`；后者不被 directTools 主动声明。不能从 codemode/script 再调用 scriptTool，必须直接调用。详见[脚本](scripting.md)、[Executor](prompts-and-ui.md#executor-app-tools)。

## Tool approval

`approveTools:true` 每次审批；glob[] 匹配 original/prefixed names；server 覆盖 global。`"destructive"` 只放行 server 标记 readOnlyHint true 或 destructiveHint false 的 tool，缺 hints 也拦；resource read 不受 destructive 值拦截。其他 string 视为全部审批。Exclude 是隐藏，approve 是可见但执行前拦。

TUI 选项 Allow once、Allow for session、Allow server for this session、Deny。Tool session grant 和 iframe consent（含 deny）分别持久为 active session branch 的 non-LLM custom entries，resume/tree 恢复；仅存 server/tool 与 deterministic definition/argument hashes，不存 raw args/results/secrets。No UI 时 matching calls fail closed approval_required。Deny/abstain/once/approval_required 不产生 tool grant。

Allow server 是当前 server 全工具/全部 args 的 broad memory grant，含后发现工具；不持久化，reload/session replace/resume/tree/config replacement 清除。不能绕过 broker deny、exclude、host guard 或独立 iframe consent。需要窄授权用 Allow for session。

`mcp-approval-v1` 是 Adapter 私有持久 state，不是跨插件 API。公开 status 是 `pi-mcp-adapter/status/v1`。

### Legacy broker

保留兼容事件 **`pi-mcp-adapter:tool-approval-request`**，它是 legacy 名称，不因为缺版本 suffix 而改名。新协议须 versioned。

```ts
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "pi-mcp-adapter";
pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (request: McpToolApprovalRequest) => {
  request.claim(async () => "abstain");
});
```

请求包含 serverName/originalToolName/prefixedToolName/args/origin/可选 signal。必须同步 claim，first claim wins。每个到 gate 的 resolved call 都先 broker，包括已有 branch grant、approveTools false、proxy/direct/resource/iframe，以及 runtime event 的 script origin。

allow_once 当前调用；allow_for_session 按同一 cache/persistence 路径授权；deny 即使有 grant 也阻止本次，但不撤销旧 grant。**仅 no claim/abstain 才查 grant，再走 configured approval/UI fallback**。无 listener 不改变普通 fallback；host-managed 则 no claim/abstain 都拒绝，见[SDK](extension-api.md#host-managed)。

只有 `supportsDenyReason:true` 才返回 `{decision:"deny",reason:"..."}`，否则对象按普通 deny。Reason 在本次结果中说明未执行，移除 escape/control，最多 8 KB、按字符边界截断并标记。内置 dialog deny 也有固定说明。

Pi hooks 不能覆盖 runtime events 和留在 proxy 的内部真实 call，想管所有 MCP calls 用 broker。ScriptTool 内每个 MCP call 也按原名审批，approveTools 不匹配 scriptTool 外壳；permission extension 可匹配 mcp__script__name。若另一个 extension 另拦 mcp 外壳，可能出现两次 prompt。

## Output guard

默认只 guard 到模型的结果。Pi nested tool call 给 codemode/其他工具的结果完整，即使经 mcp/wrapper/direct；需要 registered tools（不是 MCP_DIRECT_TOOLS=__none__）。Runtime event 和 describe 仍 guarded。

- Text 最多 50 KiB/2000 lines；超出保留 head preview、完整 text 存 temp file，路径可 read/grep。
- Image blocks 原样传 provider，不按 text 截断。
- Binary resource ≤10 MiB 落 private temp file，替换 file reference；每 session ≤100 MiB/10000 files，teardown 删除这些 materialized files。
- Proxy details.mcpResult JSON ≤16 KiB 保 raw，否则 block/size/key preview summary + raw JSON spill。Direct 默认 lean，bounded 才同样保 guarded raw；script 已收到完整 result 时没有 details.mcpResult。

Consumer 必须检查 mcpResult 和 structuredContent 的 `omitted:true`，不能把 preview 当原 payload。Object preservedFields 只是部分，summary.keyCount 是原 cardinality，preservedCount/droppedCount 表示保留量。极小限制可能只剩 omission marker，无 spill metadata。

`outputGuard:{maxBytes:51200,maxLines:2000,detailsMaxBytes:16384}` 可调整；false 或 MCP_OUTPUT_GUARD=0 关闭 text/details guard，不关闭 binary safety。Text/raw spill mode 0600，在 system temp，**不自动清理**，可能含敏感数据；与 teardown 删除的 binary materialization 区别开。

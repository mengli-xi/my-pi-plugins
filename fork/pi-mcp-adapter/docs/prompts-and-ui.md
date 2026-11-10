# Prompts、elicitation、sampling 与 Apps

这些功能超出普通 tools/call；Apps 的异步投递另见[mailbox](mailbox.md)。

## MCP prompts

Server 宣告 prompts capability 后，cached definitions 注册为 `/mcp__<server>__<prompt>`，连接时刷新 metadata，不对无 capability server 探测。支持带 quoting 的 positional 和 key=value，required args 在 prompts/get 前验证并补全。

```text
/mcp__agent_board__create_plan "harden retry policy"
/mcp__agent_board__review_pipeline status=paused
/mcp-adapter prompts
```

Prompt 多条结果合并为一条 user message，保留 [user]/[assistant] role markers。显式 slash prompt 属于前台输入，不当后台 mailbox mail。Defer missing metadata 下 cached command 暂不注册，见[配置](configuration.md)。

## Elicitation

有 dialog UI 时宣告 form mode，用 Pi select/input，校验后 review/edit 再提交；空 form 一个 confirmation。明确拒绝为 decline，dismiss 为 cancel。

URL mode 只在 TUI 宣告；展示 requesting server、target host、完整 URL，每次 consent 后才开 browser。支持 URL-required tool error -32042 和 completion notification；browser 完成后需重试原 call。

回答 server prompt 的时间不计 requestTimeoutMs/SDK 默认 60 秒：该 server dialog 开启时暂停 timeout，关闭后继续剩余时间。Tasks 每次 request 的 timeout 不受此总调用暂停规则改变。

## Sampling

通过 Pi public ModelRegistry.complete 调模型，按 modelPreferences.hints 选择，再回退 current/default model。默认有 UI approval 才可用；samplingAutoApprove 显式启用可供 headless 使用。仅 text；context inclusion、tools、stop sequences、audio、image 都以明确错误拒绝。Server 的请求是外部输入，不因 sampling 获得额外工具权限。

## Executor approvals 与 accounts

只针对 Executor 默认 URL 的适配：默认 execute/call 暂停要求 app approval/input 时，Adapter 自己展示 form，用 resume 回传，只把最终结果给模型；不泄露 request ID，并拒绝模型直接 resume。无 dialog/headless/elicitation false 返回需要 interactive session，不让模型代用户批准。默认 execute/call timeout 至少 6 分钟，覆盖其 program 5 分钟限额；server 显式 requestTimeoutMs 优先。Browser 模式仍让用户在 browser 回答。

单个 call 因 app 未绑定 account 且尚未执行时，Adapter 获取其 connection link，经 URL consent 展示给用户（不给模型），浏览器完成后 Continue，检查一次并仅重试 call 一次；仍 pending 提示再试。Batch/execute/headless/non-TUI/拒绝或多个 missing accounts 返回 Executor 原消息，不自动重试。

### Executor app tools

Executor 自有 search/describe/call/execute/resume/skills 六项。默认 URL 的 app tools 另注册为 Pi deferred `mcp__<server>__<app>_<tool>`，例如 tools.github.issues.list → mcp__executor__github_issues_list；即使 directTools 也不主动声明。Gateway/search/tool_search/codemode 可找到；gateway tool 可用 `github.issues.list`。不暴露 tools.executor.* admin API。

调用相当于一个 Executor call；按 app path 审批一次，不再按 Executor call 审批。approveTools 规则用 `github.issues.list`/`github.*`，不加 `tools.`。原 pauses/account linking 仍适用；string 为 text，object/list 为 structured data（模型看到 JSON），error 保留 Executor message。

Executor 以 TypeScript 表达 input，不是 JSON Schema，所以 wrapper 接受 object，由 Executor 验证；description 带一行 input type，截断时 describe 请求完整 signature 一次并 cache。

每 server 最多 1000 app tools，按 Executor app/tool 顺序截取；panel 展示注册/总数和无法列 app 的 warning/reason。Server listing 只列六项并指向 search。连接后后台 search catalog；lazy 缺 catalog startup 连一次，runtime 即使 deferWithMissingMetadata 也启动，不能声称首次绝不联网。未取得 catalog 的 Executor 每 session 再试。

Catalog 写 mcp-cache，不含 linked-account labels；private tools 只留 session。缺 path 或失效 path 时（每 server 最多每分钟一次）、connect/reconnect/tools-list_changed，以及 catalog 超一小时后的首次真实 connect 刷新；刷新时旧 catalog 可用，不只因变老就启动 lazy server。

Exclude 以 app path glob 隐藏。MCP_DIRECT_TOOLS=__none__ 不注册/不发现 catalog，但可经 proxy 使用已缓存项；freeze 后继续 cache/proxy 刷新、不注册新工具直至 reload。Host-managed 不含 Executor 特殊处理；不能把本地/test fixture 覆盖当 hosted Executor 实测。

## MCP Apps/UI

Tool metadata `_meta.ui.resourceUri` 指向 UI resource，Adapter 取 HTML 放 iframe；UI 可调用 tools 和给 agent 发消息。支持 stdio 与 HTTP。

Mac 有 Glimpse 则 native WKWebView，否则 browser。`MCP_UI_VIEWER`：browser 强制浏览器；glimpse 要求 native；orca 尝试 Orca，不可用 fallback browser；none/off/disabled 隐藏窗口但 session 仍开、tool inline result 仍回、通知提供可手动打开 URL。第三方 viewer 不是本包运行时硬依赖。

Server `openUi:false` 不同于隐藏 viewer：不宣告 Apps capability、不创建 UI session/window，server 可直接 inline 执行而不依赖 App form；signin/URL elicitation 不受影响。切换该项重新读取 tool list，因为 server 可能返回不同 tools。

同 tool 的 UI 仍开时再次调用将新结果推入现有窗口，保留 view；不同 tool 替换 session。窗口 Cmd/Ctrl+Enter 或 Done 完成关闭，Esc/Cancel 取消关闭。

### UI 消息与 ACK

UI 可以送 prompt、intent（name+params）、notify、message，未知 type 作为 intent 转发。`mcp({action:"ui-messages"})` 可读取积累的 UI messages，包含 type/sessionId/serverName/toolName/timestamp，prompt 带 prompt，intent 带 intent/params。

Prompt/intent/context 等需要 agent 消费的 action 不直接 native triggerTurn，统一经[durable mailbox](mailbox.md)。Trusted host 在 HTTP 前冻结 ID 与完整 text/image payload；重试保持 ID/bytes，成功 ACK 只代表 durable acceptance，不是模型已读。Raw postMessage 使用 ui-message-ack；失败保持 intent 并显示 Retry，不 timer 重发。关闭 UI 不撤销已接受 mail，替换 session 不把旧 action 改投新 branch。

### UI 安全

Iframe tool consent（never/once-per-server/always）与 tool approval 是两个 gate，不能互相替代；mailbox 投影前还会检查 revoked consent。`_meta.ui.visibility`：app-only 不进模型 tool list，model-only 不能由 iframe 调。Provider HTML 不改写，HTTP response enforcing CSP 使用 `_meta.ui.csp` 和兼容 `_meta["openai/widgetCSP"]`。

Browser↔server 使用随包本地 AppBridge asset，不在首次打开时从 CDN 拉 bridge。UI 内容与 tool results 都视为外部数据。Server roots 默认披露 cwd，见[Server 字段](servers.md#全部字段)。

# pi-subagents

用于 persistent supervised background Subagent 的私有原创 Pi package。

它提供八个 model-facing tool（其中六个是 forwarded collaboration operation，`list_subagent_models` 和 `list_subagent_roles` 在 caller 本地查询）、durable Main-scoped Agent tree、每个 resident Agent 一个同进程 SDK session 与原生 Pi 会话界面、depth-2 nested delegation、asynchronous `wait_agents`、direct-parent completion delivery、`/subagents` Tree / terminal management，以及 editor 上方 status strip。`pi-processes`、本地 `pi-native-search` Fork、Goal Wake arbitration 和受支持的 custom provider 通过 Pi-free shared registry 与显式 SDK child factory 集成。

Tool authority 由 role 与 parent 当前 active tools 共同收窄：Pi 基础工具经同一 scope 校验传递；本轮 builtin extension consumer 仅受控装配 codemode/tool-search 的 canonical factory。其他 extension tool 只有声明 canonical child capability 时才会进入，当前包括 `process`、`web_search` 和 `web_fetch`。`pi-mcp-adapter` 的 MCP child 继承须由 adapter 自己明确能力声明/工厂，并另做联合验收，本包目前不宣称支持，也不用 stock MCP 替代。未声明能力的问答、todo 等工具同样安全省略。

`list_subagent_models({query})` 先把 query 去首尾空白、不分大小写精确匹配 canonical `provider/model`，命中只返回这一条，即使它不可用。无精确命中才按空白、`/`、`:` 分词，所有词都须出现在 ID 中，顺序不限；query 中多个词的顺序不影响匹配，canonical `provider/model` 可精确查询。返回 `{models: string[], unavailable: {id: string, reason: string}[], more?: number}`，不重复 query：缺少唯一 Subagent provider owner 的原因是 `provider has no subagent support`，超出 caller `--models` 范围的原因是 `outside --models scope`；两种限制同时存在时优先说明 provider。不允许用 unavailable ID spawn。分词结果去重并按 canonical ID 字节排序，总计最多返回 20 条，超出时仅用 `more` 表示省略数量；两个列表各自保留原有排序，无命中返回两个空列表。查询不改变 `spawn_agent` 的解析和权限规则。`list_subagent_roles` 同样先精确匹配 role 名称，否则分词匹配名称和 description，按原有名称排序最多返回 20 条，输出 `{roles, more?: number}`。

外部 SDK provider 不按品牌识别：它必须声明 `sdk_provider_factory`，并由实际 agentDir 的独立 `sdk-provider-grants.json` 精确批准；无 proof 的旧 frozen provider profile 只能看历史，不能自动执行。声明、grant 格式、scope 与 cooperative 边界见 [`docs/sdk-providers.md`](docs/sdk-providers.md)。

公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0；managed native thread UI 另需官方 1.5.0 加[显式 host patch](../../host-patches/pi/v1.5.0/README.md)，不宣称纯 stock Pi 的全部 UI 可用。UI host 合同与拒绝范围见 [UI_SPEC §5](../../docs/subagents/UI_SPEC.md#5-主题与终端释放)。codemode/tool-search 以 `builtin:<owner>` 和 `builtin_proof={version,pi_version}` 冻结，proof 核对 canonical Pi.VERSION，不把 builtin 标识当物理文件做 SHA 读取；role/tools fences 仍生效。共享 Runtime 的通用显式 Builtin 接口默认全禁，其可选 MCP 支持不代表本 consumer 已支持 MCP。未选中的 builtin 不启用，llama.cpp 不是工具，本轮不启动其服务；不解析 stock MCP 配置、不冻结 raw 凭据。SDK child 关闭自动扩展发现。配置、roles、journal 与 store 跟随 Pi 的 `getAgentDir()`，支持 `PI_CODING_AGENT_DIR` 隔离。

`subagent-completion-v1` 的模型可见 XML、digest、投递和持久化仍由本 package 独占。TUI fallback 始终只显示一行 Agent path、outcome/reason、token 与 duration，不展开 summary/result。若 CC Style 的 versioned presentation registry 可用，同一行可点击并在 Markdown TextPanel 中展示完整 Summary 与 Result；registry 缺失、版本不匹配或 provider 失败时继续使用单行 fallback，不改变模型上下文与 delivery proof。

未被 Compact summary 收录时，Main 收到公开 `session_compact` 后，若仍有未 settled 的 Task（包括 queued、starting、running、waiting），追加隐藏的 `subagent-compact-state-v1` 模型消息。开头为「这是压缩完成时的实时状态，与摘要冲突时以此为准」，逐项列 Agent ID、名称/path、Task ID、phase、最近已完成的模型正文/工具活动（不含 thinking），以及完成通知、`list_agents` / `wait_agents` 的结果获取方式。只读已有 owner/runtime；空会话不会因此初始化 service/store，没有未完成任务就不发。同一 compaction ID 只补一次，恢复会话和 `/reload` 不补发；这是 Main 的运行状态补注，不改变 child Task admission 或原有 Completion 协议。

消息通过公开 `pi.sendMessage({display:false}, {triggerTurn:false, deliverAs:"steer"})` 发送。空闲压缩时在 compaction entry 后立即落盘；运行中压缩（如工具批次之间的 threshold compaction、溢出恢复）由 stock Pi 延迟到最早安全的 `turn_end`，或 run 启动/结束时的原生 flush，仍在 compaction entry 后。它不会额外启动一轮模型请求，但**不承诺运行中压缩后紧接着的第一次请求能看到补注**；`nextTurn` 会推迟到下一外部输入，因此不使用。仅消费公开压缩事件，不依赖压缩插件或新增 Pi private seam。

手动压缩期间完成的任务仍走原有 durable Completion 队列。公开 `session_compact` / `session_compact_failed` 后等待 Pi 的 compaction guard 退出，再通知既有 Main idle 边界；活动 run 继续使用 `agent_settled`。短期 timer 受 session/runtime fence 和 shutdown cleanup 约束，不能在旧 session 送达，也不会复制结果或让完成消息落到 compaction 前。

现行规范位于 [`../../docs/subagents`](../../docs/subagents/README.md)。本包交付源码、技能与回归测试，根目录的 16 份现行规范另计；使用前必须显式 build。历史 IMPLEMENTATION*/IMPLEMENTABILITY 报告与 ADR 随原仓归档，未迁入，也不作 Pi 1.5.0 的新验收证据。

## 开发

跨插件与降级用例入口见 [根 integration](../../integration/README.md)。

包内 Wake 合同用公开 continuation registry 的 claim/receipt 对端驱动，只验证本包投递、重试、持久化和 barrier，不验证外部 Goal 的命令或排程。`test/contract/wake-policy-coalescing.test.ts` 参数化 `scheduled` / `coalesced` receipt，验证独立 Outbox 共享 continuation 身份时的结算、重开后的持久化和零额外 producer continuation。

```bash
npm install
npm run check
# Core fresh-host tests use the official Pi 1.5.0 CLI explicitly.
export PI_REAL_BINARY=/path/to/pi-1.5.0
npm run test:real # 本包 e2e；只加载 Subagents 与测试侧 faux provider
# 跨插件/SDK PTY 联测从仓库根运行
```

修改 TypeScript 或已迁入的 source-only 依赖后必须重建直接 compiled consumer；Subagents 运行 `npm run build`，Pi 加载逐文件 `dist/index.js` 与按需 SDK module，小型 fork grammar 单独 bundle；build 先清理旧 dist。mailbox transport build 为 `mailbox-v1.0.6`，相关 compiled consumer 必须重新 build 并 fresh process，不能混用旧 bundle。Main `/reload` 会 force-close 旧 Main tree，未结束的 Task 结算为 interrupted；`resume_agent` 恢复为 idle execution，并使用新的 runtime generation，另发输入才启动新 Task。

直接调用 child 的 SDK `session.reload()` 只允许真正 quiescent 的 execution：没有非终态 Task（包括 queued/waiting）、持有的 Task lease、未完成的 owner event、Wake/proof 或正在进行的控制。检查与 reload 共用 Host admission 边界，重载完成前该 child 不接受新 Task。拒绝发生在旧 `session_shutdown` 之前，会显示原因及完成/关闭 Task、等待投递结算后重试的提示；原 Task、generation、binding 和 lease 保持不变。子视图的 `/reload` 仍不在命令白名单中；不支持对活动 child 做跨 binding 的无损 SDK reload。

如果获准的 quiescent SDK reload 原生失败，该 execution 会保持“reload 失败、不可用”：不再接受新 Task、send_input、follow-up 或 owner admission，也不再次尝试 reload。错误会提示先 `close_agent`，再 `resume_agent` 建立新的 idle execution；新 execution 成功建立后，另发输入才继续工作。已有 Task 终态与 receipt 不变，不自动恢复或重试。

Main 首帧同步注册工具 schema、命令、message renderer 和隐藏的 strip。管理器/Tree/SDK view 与 service graph 通过逐文件输出中的真实 dynamic import 在首次操作时加载；`verify-dist` 会检查这些边界。空的新 Main 不创建 store 或 SDK execution owner；首次 `/subagents` 或 collaboration 操作等待同一条 ready 链，保留 frozen profile、tool、provider 与 project authority 校验。存在 durable Main 目录时仍在 `session_start` 立即执行完整恢复，包括待投递的历史结果。初始化失败会拒绝操作，后续操作可重试；session replacement/quit 会等待并退役未完成的初始化。

有效请求由 `file:../pi-session-runtime` 的共享内存 store 捕获。Main 与可嵌套的 child 只在启动时注册轻量 listener，首次业务 `context_with_system` 才加载原生投影和能力指纹逻辑；公开 provider `streamSimple` 是最终 normalized transcript 的真值。`before_provider_request` / `after_provider_response` 在对应 provider 调用的 async scope 中确认 Main 归属，session、signal 与一次性候选同时校验；带同一个 anchor 的 direct summary 不能占用候选，缺乏确认时拒绝使用。shutdown/reload 释放 owner。capture 表示 Main 最近一次实际发送的上下文，允许落后于 Magic 的后台 DB 更新；不订阅 epoch，不承诺与最新 DB 一致。失效只看 session/generation、分支/投影重置和模型/工具/能力指纹等结构条件；不 import Magic 的代码或读取它的 DB。完整契约由 [`pi-session-runtime`](../pi-session-runtime/README.md) 拥有。

`spawn_agent.fork_turns` 默认 `none`，也支持 `all` 或 `1..100000`。三种模式都通过共享有效上下文 selector 和 native seed builder；旧 raw branch builder 已删除。all 保留最近一次有效请求加稳定的新尾部；N 只取能可靠映射的最近 N 个完整业务 turn（user、bash/custom 输入、branch summary），只跨 turn 保留明确的 summary/memory/system preamble，正在执行的未配对工具批次不继承。seed 的隐藏 provenance 记录使用 fresh entry ID，让下一层 capture/N 保持摘要与业务 turn 的区别，boundary 只算附属正文。native-only 在 fork 时按当前 capture 验证，后续请求/失效即撤销旧结论；Magic 注册/marker、未知请求层变换或 capture 缺失时，all/N 返回结构化 `effective-context-unavailable`，模型应改用 none。schema 的 canonical keyword 候选、数字 grammar 与说明来自共享库。`/subagents [target]` 无参数打开管理入口，可选 target 为当前 Main 的 Agent ID 或 task path，动态补全来自同一 runtime 集合，包含 closed Agent。

管理器的 Running / Done 列表每行直接显示该 Agent 冻结的 `provider/model@effort`，不需要先选中查看详情，也不从当前 Main 模型猜值。状态 badge、tokens/耗时、完整详情和选择/鼠标语义保持不变。使用时可创建不同模型/effort 的两个 Agent，在两个 tab 对照列表身份；窄屏沿用现有裁剪，不改变执行配置。

## SDK execution and lifecycle

Subagents use the Pi 1.5.0 public in-process SDK owner; managed native views
add the explicit UI host contract in [UI_SPEC §5](../../docs/subagents/UI_SPEC.md#5-主题与终端释放). Agents have a persistent
`open | closing | closed` lifecycle independent of Task outcomes. Finishing a Task
keeps the agent open. `close_agent` closes an idle structural subtree;
`force: true` cancels every unfinished Task and waits for native drain before
returning the open slot. Slow cleanup remains closing and retains authority.
`resume_agent` opens only its target, idle, with the same session and frozen
permissions; it creates no Task, lease, provider request, or compaction request.

The model surface is `spawn_agent`, `send_input`, `resume_agent`, `close_agent`,
`wait_agents`, and `list_agents`, plus model/role queries and child `finish_task`.
Close/resume are Main-only. Ordinary busy input steers the same Task; waiting input
requests an active grant for the same Task and retains its dependency snapshot.
Idle input creates a new Task. Interrupting input creates a replacement Task before
other queued work. The internal stop-current and after-current admission ports
remain for UI; no old model-tool aliases are registered.

After a child barrier completes, the SDK starts the next turn with a public
custom message (`subagent-task-resume`), shown as a muted system notice. It names
subtask completion as the wake reason and never adds a synthetic user prompt or claims input was
accepted. Process exits retain their own process notification messages.

Config uses `schemaVersion: 2`. Defaults: `execution.maxDepth=1`,
`execution.taskTimeoutMs=1800000`, `capacity.openAgentsPerMain=32`,
`capacity.activeTasksPerMain=10`, and `capacity.activeTasksPerProcess=10`.
Closed agents do not count toward open capacity; waiting releases active capacity.
There is no resident cap, idle retention, or LRU eviction. Project limits only
tighten user-local values. Old resident/helper/liveView/storage agent-count keys
and any remaining `PI_SUBAGENTS_BACKEND` value produce Chinese source/key/remedy
diagnostics. Main continues to work; new spawn/input/resume reject while close,
list/history, and already accepted delivery remain available.

Persistence starts in the independent `<agent-dir>/pi-subagents/store-v2`
namespace. It never reads, converts, or deletes store-v1. Frozen profiles contain
an allowlisted settings snapshot and delegation ceiling. Each Task freezes its
initiator and owner conversation; Main/user new Tasks on any descendant return
to Main, while child-origin Tasks return to that child. Steering retains owner.
Generation and lifecycle fences revoke old execution/model authority, while
Completion, lease release and ACK can still drain during closing.

Quit, new session, switch, and reload force-close the previous Main's complete tree.
Reopening metadata never schedules old work. Each resumed agent must receive input
before execution. SDK children use `pi-session-runtime` assembly and lazy audited
Processes/native-search and explicitly approved provider factories; CC provides presentation and fullscreen adaptations. 展示按 `presentation/claude-style-v1` 能力选择，不按 owner 名选择；能力缺失时 child 视图使用 Pi 原生消息渲染，任务输入、历史、返回与生命周期功能不变。 Processes/CC/Goal/native-search are not migrated or committed in this round; required joint tests use them only as external-to-target dependencies built from real source, not as acceptance of those packages. Do not remove view features to claim this package passed. Native
settlement at `agent_settled` owns final text and usage. Cold recovery treats
unfinished ownerless work as interrupted and closes it; assistant tail is not a
completion proof.

### SDK child views

`/subagents [target]` (Agent ID or task path) and Tree Enter open a
second native `InteractiveMode` in the same process. 展示能力存在时使用其显式 presentation factory，缺失时使用 Pi 原生渲染； no transcript, viewport, or history renderer is
copied. Main keeps its editor object and only pauses its public TUI. Returning
saves the child draft, detaches presentation, binds the runtime headless, and
resumes Main without another Main session_start.

Alt+/ or `/subagent` returns to Main. In a child view `/side` asks the user to return
first; Subagents does not register Alt+/ in Main. Ctrl+C interrupts a running Task
through the durable Host port and stays in the view; when idle it returns. Empty
Ctrl+D returns and nonempty Ctrl+D keeps native forward-delete. Ctrl+Z is disabled.
`/exit`, `/quit`, and child ctx.shutdown return without terminating the process.

The canonical command table allows `/copy`, read-only `/session`, `/compact
[instructions]`, `/hotkeys`, `/changelog`, and `/help`. `/model` and `/thinking`
show the frozen profile; model/effort and session replacement shortcuts are
blocked. Unknown extension commands, package/account/settings actions and direct
shell submissions are rejected. Completion is derived from the same allowlist.

The controller's `admitViewInput` port accepts immediate or after-current intent.
Both go through Host durable admission. Immediate waiting input preserves the Task,
barrier/process wait, owner and deadline. The C batch connects Enter/Alt+Enter;
the D batch supplies lifecycle list controls. Draft text is cleared only after
admission succeeds; closing a view waits for its in-flight admission.

Unloaded settled history opens in an in-memory native SessionManager with the
same presentation factories and no active tools. Opening it does not restore
execution or change its JSONL. A successfully admitted follow-up restores the
execution owner and switches to its native view. History remains read-only until
then (including compaction); frozen capability drift rejects execution instead of
silently substituting a model or tool set.

Main session replacement/reload/quit first reclaims the child view. Signal and
stdio failure ownership stays with Main; runtime shutdown awaits all child cleanup.
Shared handoff behavior is owned by `pi-session-runtime`, including Terminal gates,
public process-listener reference differences, and headless rebinding. There are
no new private Pi names; managed native UI requires the explicit host patch above.
Run the real compiled-binary PTY gate with
`bun integration/subagents/real/sdk-child-view.mjs /path/to/patched-pi-1.5.0`; its faux provider makes no external
model requests. IME/real kitty terminal coverage is separate from PTY validation.
`bun integration/subagents/real/sdk-statusline.mjs /path/to/patched-pi-1.5.0` separately gates ten view
handoffs with a failing first statusline command, read-only CC footer ownership,
Main CP/MEM/cache restoration and stable listeners/presentation owners.
It replays every committed synchronized-output frame from PTY takeover, so even
a transient native footer before session_start fails the gate.
`bun integration/subagents/real/sdk-initialization.mjs /path/to/patched-pi-1.5.0` holds the real view-read
callback and first/second extension bindings: the 2000 ms fallback reveals a view,
Alt+/ returns without releasing the callback, and late completions preserve Main.

SDK views currently require an explicit single named Main theme selected by the
profile. Automatic theme pairs and anonymous themes
are rejected before handoff. The patched SDK owns file-version watching, loading,
cache invalidation and palette updates for initially present selected user-theme files;
package/project hot-reload scope is unchanged. The shared runtime restores Main by named
public API and retains its cache-only repaint bridge, without another loader/parser/timer
or a name-only restore skip. The
[Runtime README](../pi-session-runtime/README.md) and [UI_SPEC §5](../../docs/subagents/UI_SPEC.md#5-主题与终端释放)
define the handoff boundary. Full automatic theme ownership remains unsupported.

CC's audited factory is now installed during SDK child assembly so actual run
metrics and run separators are recorded even before the first view and after
returning to Main. It retains only the light recorder while detached; fullscreen adaptations and
view components still attach on first view entry. Existing history with missing
run facts is not backfilled with invented times. The stable Host self-interrupt
port commits a fenced interrupt before aborting, including a headless `ctx.abort()`
after Main reload. Main process quit reclaims views with the `quit` release reason
and never restarts its stopped TUI; reload/switch use ordinary return semantics.

Retired Pinned presentation entries in old frozen profiles are ignored without reading their deleted files. The remaining CC child entrypoint hash is still checked: a rebuilt CC can produce `capability-drift: pi-claude-style`, independently of Pinned retirement.

## 迁移修整与日常回归

执行边界：已完成的 open Agent 删除前先 close/drain，再 delete；Process continuation 正常等待 active 位不能因 30 秒而变成 record-only，watchdog 与 cancel 必须一同收口；waiting activation 收尾只清除当前 grant 持有的 order，不能覆盖之后收到的唤醒；codemode/tool-search canonical factory 的前端准入与后端装配必须一致，并遵守 role/tools 与 Pi.VERSION/proof 校验；非 builtin Search/Processes 的 `execution_factory` proof 才直接读取实际物理 factory 文件做 SHA 校验，不只校验 wrapper。旧 profile 仍可读取和列出，但缺少对应 proof 时不创建可执行 SDK 会话，不自动补授权。

日常回归清单见 [TEST_PLAN](../../docs/subagents/TEST_PLAN.md)：spawn、close/resume、wait、Process 排队、cancel、delete 与 frozen drift。真实 provider、全 profile、人工 TUI 和规模性能仍未验收，faux/PTY 结果不能替代这些验收。

后台 mailbox、completion/barrier cards 和 outbox continuation 使用统一 mailbox v1；稳定 key、legacy 导入、
Goal obligation、child grant/取消顺序见 [mailbox 合同](./docs/mailbox-v1.md)。原 journal/native hash 不变；
SDK completion resume 不再额外发 trigger。整批上线仍以共享 transport 与所有 producer 的联合 gate 为准。

Task settle 与 Main reconcile 按 Outbox ID 共用进程内整轮投递所有权，从卡片投递开始覆盖到随后
settleWake / retryOpenWake / settlePendingWake 返回或抛出。争用者以 skipped/delivering 推迟，
reconcile 记入 deferred、不报诊断，由持有者收尾；新旧 binding 共用同一张表，替换不提前释放。
所有权在 finally 中释放，失败仍按原持久状态在下一个 reconcile 边界重试。
启动恢复遇到缺少 `prepare.json`、且只有安全空子目录的 prepared 事务时，按 aborted 清理，并在
`<agent-dir>/pi-subagents/diagnostics/` 记录 `incomplete-prepare-aborted`。存在任何文件（包括空文件）、
链接或不安全目录时仍保留原目录并拒绝打开，不推断残留数据的归属。

Main append 现只通过公开 mailbox/readonly session API；旧三项 Main private probe 已随直接追加路径删除。

可选 Compact 的同步 `pi-session-compact:collect-recovery-v1` 协议在提交前收集本包现有恢复文本，回复声明 `order: 40`，不依赖固定 owner 名单。协议缺席时保留原有独立恢复路径；version 1 的 `compactionEntry.details.recovery` 包含本包 owner/customType 时跳过重复消息，无标记的旧记录仍走原路径。开放排序、请求和 details 兼容由 [pi-session-compact](../pi-session-compact/README.md) 定义；无需安装该插件，收集不改变任务准入、中止围栏或完成投递。

测试入口 `test/fixtures/test-commands.ts` 包装生产 extension 的已有 `list_agents` 工具完成惰性初始化，再从已有 service-cell 取本会话 binding，并在测试侧核对 session lifecycle。测试 profile 只加载此包装入口，不重复加载生产入口；生产代码不提供测试专用 binding 导出、resolver 映射或环境开关。

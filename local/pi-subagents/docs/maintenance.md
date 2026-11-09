# pi-subagents · Package 布局

## 1. 唯一 SDK 入口与加载

package.json 的 Pi extension 仅 dist/index.js，skill 目录 skills/subagents。Main/SDK 全部 tsc 按文件编译，scripts/build.mjs 先清 dist 再输出；Bun 仅将共享 fork grammar inline 到 dist/tools/schemas.js、validate.js，typebox external。没有 dist/child.js、supervisor.js、旧 OS child/channel/RuntimeController/terminal-handoff 产物。生成 dist 不提交。package 交付源码、技能和回归测试，仓库根目录 docs/subagents 下的 16 份现行规范另计；不提交生成的 dist，也不沿用历史 build/验收结论。历史 IMPLEMENTATION*/IMPLEMENTABILITY 报告和 ADR 随原仓归档，未迁入，也不作新验收证据。

src/index.ts 是 cold entry，工具 definitions/schema/validation、轻量 status/view 路由先加载；首次 context/工作才 import service/store/manager/SDK assembly。verify-dist 检查 cold 图/禁止机器绝对路径和旧 entry；不要用 rootbarrel 重新引入 eagerassembly。xterm 仅 devDependency 用于真实 MainPTYtest，不是 runtime backend。

## 2. 目录职责

| 目录/关键模块 | 单一职责 |
|---|---|
| config/{types,schema,load} | schema 2、来源/strictJSON、删除 key 诊断、新 capacity/depth/default |
| domain | opaqueIDs/path、Task 状态/timeout、persistent 结构 depth |
| tools/{schemas,validate,register,results,errors,local-query} | public 八工具 grammar、注册、envelope/错误、model/rolequery |
| roles/capabilities | rolebody/scope、descriptorclosure、tool/factory/promptfingerprint |
| context | public effectivecapture/select、frozencontext/profile/nativeartifact 准备 |
| host/core、types | 可信 caller、serialmutation、prepare/commit/owner/lifecycle/input/receipt |
| host/process-service、service-cell | process 内 Mainscope 绑定、lazy SDK 连接、Main ending 全树关闭；不是 OSprocessbackend |
| host/delivery-engine、main-append-port、producer-proof | frozenInbox/Outbox/card/native proof、Wake/Goalreceipt、safeMainappend |
| persistence | store-v2、lock/canonical/journal/checkpoint、prepare/receipt/recovery/cancel/unread/delete |
| scheduler | open/active 准入、MainFIFO/公平轮转、waitingactivation；无 LRU |
| runtime/child-session、sdk-controller | public SDK assembly、generation、Task grant/abort/drain、directviewinput 和 draft |
| runtime/child-tools、factory-catalog | child 本地 Host/Processbridge 与 approved namedexecution/presentationfactory |
| child/{tool-port,tools,lifecycle,conversation,events,mailbox-injection,process-wait-*} | 同进程小型领域端口、finish/lease/nativeappend/application/ACK，不是可执行 childentry |
| ui/{agent-presentation,manager,strip,statusline,sdk-child-view,completion-renderer} | 纯 classifier、Running/Done、确认动作、managednativeview 与精确已读 receipt |
| test/{unit,contract,fixtures,real} | 核心领域/集成/nativeTTY/faux 验证，helper/probe 不进生产 cold 入口 |

删除 OS 传输后复用的小型类型在 child/tool-port、conversation 和 SDK controller；canonical encoder 在 persistence/canonical，不保留 supervisorhelper。领域 kind=followup、DTO runtime=resident 等内部名称不代表旧 public 工具或 resident 预算。

## 3. 依赖与 factory

file: pi-li-uikit、pi-runtime-contracts、pi-session-runtime、pi-session-inject；目标 Pi 1.5.0 公开 peer/dev 包与 typebox。source-only shared libraries 已迁入，无 extension registration/独立 build，修改后重建直接 compiled consumer Subagents；mailbox-v1.0.5 要求相关 consumer 同步新 build/fresh process。approved Processes/Search 与受控外部 provider factory 登记 direct-source/provider contract；provider 纯身份判断由查询/准入/catalog 共用。本轮 builtin consumer 仅 codemode/tool-search canonical factory，遵守 role/tools fences，以 `builtin_proof={version,pi_version}` 核对 canonical Pi.VERSION；共享 Runtime 显式 Builtin 接口默认全禁，未选中的 builtin 不启用，llama.cpp 非工具、不启服务。当前 pi-mcp-adapter child 继承须有 adapter 自己的能力声明/工厂并独立验收，现不宣称支持，不以 stock MCP 替代。非 builtin Search/Processes 的 `execution_factory` proof 才直接读取实际物理 factory 文件做 SHA 校验，不靠 wrapper hash 代替；旧 profile 可读，缺 proof 不执行。CC descriptor 和 explicit factory 保留 owner identity，旧 Pinned entry 忽略、不加载；现有 CC presentation 是 child view 必需依赖；本轮不迁入、不提交 Processes/CC，只在目标外使用真实源码构建产物作所需测试依赖，不算它们验收，不删功能假造通过。其它 package 的 OS wrapper 不能当 Subagents loader 入口。

## 4. 开发命令

```sh
npm run typecheck
npm run build
npm run verify-dist
npm test
# Managed native UI host requirements: UI_SPEC §5.
仓库根 bun integration/subagents/real/sdk-child-view.mjs /path/to/patched-pi-1.5.0
```

test 使用 strip-onlyTS，避免 constructorparameterproperties；followpackage 脚本的 tsresolver。real-*名称可能沿用 process-child/followup，但实际 fixture 以 SDK 同 session/generation/closed 语义为准，不能据名称推 OSbackend。fresh process 加载，不用/reload 代替 build/restart；full-settings 仅隔离副本，productionprofile/日常 auth/store 不改。旧三项 Main append private probe 已退役，适用 consumer 的 probe 另验。共享 gate 详 TEST_PLAN；本轮文档修订不运行 build/测试/安装。

# pi-subagents · 操作与排障

## 1. 当前运行路径

公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0、唯一 SDK；managed native thread UI 支持原版主题降级，补丁宿主提供主题热更新，见 [UI_SPEC §5](./ui.md#5-主题与终端释放)。Main process 内独立 session/runtime，无 Agent Supervisor/PTY child 或 backend chooser。配置 user<agent-dir>/pi-subagents/config.json、trusted project<cwd>/.pi/pi-subagents.json，schema 2。数据<agent-dir>/pi-subagents/store-v2/mains/<mainKey>，diagnostics 按 package closed layout。日常 Pi 与迁移 profile 分开 agent-dir；均从各自运行环境/公开 Pi API 定位，不修改日常 agent-dir 或默认入口。

source-only 依赖已迁入；compiled Subagents 或其 source-only 依赖变更后重建直接 consumer，Subagents 用 npm run build/verify-dist，再 fresh Pi 1.5.0 process。mailbox-v1.0.5 要求相关 compiled consumers 同步新 build，不混用旧 bundle。旧三项 Main append private probe 已退役，适用 consumer 的 probe 仍须验证。source-loaded Side/Compact 不用 build，仍 fresh process。/reload 是生命周期测试动作，不能代替重建验证。

## 2. 生命周期排障

| 现象 | 查看/处理 |
|---|---|
| agent-closed/closing，输入拒绝 | closed 用 resume_agent/R/resume-agent 显式恢复，再单独 send/Enter；closing 等 drain，草稿保留 |
| open-agent-capacity | list/open count，收集结果后 close 闲子树；closed 不计，closing/queued 计；resume 不会自动腾名额 |
| agent-busy | 普通 input 只 steer 仍在运行 Task；停止中的 current 不收 input；需要新工作可 interrupt=true，UI Alt+Enter 另 FIFO |
| activation queued | waiting 输入或 Process continuation 等 active 位；原 Task/依赖/lease/deadline 未变，不重发。正常排队超过 30 秒不能误变 record-only；watchdog/cancel 必须同 Task/generation 收口 |
| cleanup_pending 超过 3 秒 | 仍 closing，检查未响应 tool/prompt/public idle、scope Process cleanup、lease/control ACK；不能硬 kill JS 或伪造 closed |
| frozen unavailable | 核对已登记 factory/hash/model scope/credentials/artifact；不重读 role 扩权或 fallback model 执行，history 可读 |
| native view 因 host-capability 被拒绝 | 核对 UI_SPEC §5 的 SDK export 与 native UI context 两面及 CLI/SDK 装配；缺失/未知时不绕过 guard，Main strip/Tree 与 headless 不受此 marker 限制 |
| config-invalid | 按中文 source/key 诊断移除旧 backend/resident/liveView 键；Main 仍可普通输入，new spawn/send/resume 禁用 |
| unread 不消 | successful view 清自产活动标记，descendant 需点精确卡片；失败 init/receipt/write 保持 unread，close/resume 不清 |

X/Ctrl+C 仅停 current，queued-only 无 current work，不删 FIFO；C 忙关闭须显式 Force close 确认、默认 Cancel。D 对已完成 open 子树先 close/drain，再复核 revision 与 delivery/lease/ACK/prepare 后 delete；未完成工作仍拒绝，不隐式 force，不用 delete 回收 active。close 本身是可恢复 runtime 关闭，不删除 history。不得手工编辑 journal/CURRENT/receipt，无法证明损坏保 bytes 并 unavailable。

## 3. Main 结束与冷恢复

quit/new/resume/switch/fork/clone/reload 都 ending fence 并撤销旧 append/view 权，Host 串行枚举 force-close 全树；异步 prepare/lease/assembly 最终检查 ending，rollback 自身 artifact/lease。quit 不重启 Main TUI。回旧 Main closed、zero auto work，显式 resume 恢复目标 idle 无 Task/lease/provider/compact，再 Enter/send 才新工作。

进程被 kill 后 cold reopen 在单 writer lock 下 replay 完整 commits，unfinished current/queue→interrupted/host-lost，一 Task 一 Completion，Agent closed、旧 input/event cancelled。正常 public agent_settled 才允许 native proof 提取 final/usage；assistant tail 不能证明冷恢复完成。pending Inbox/Outbox/Wake receipt 续对账不重跑模型。重复/冲突 ID/hash 按 Persistence/Delivery 处理。

## 4. profile 与旧存储边界

新代码只用独立 store-v2，没有 v1 reader/converter、封存浏览器或启动删除。旧存储不读、不转换、不删除，不能把本轮源码迁移当作旧数据清理授权。

1. 记录运行环境实际解析的 agent-dir、commit/build/binary/profile hash；使用隔离 profile，不做 global PID pattern 清理。
2. 在隔离环境更新 schema 2/移除 backend env，重建 compiled consumers 后 fresh process；不改旧 store、auth/Main history 或其它 package 数据。
3. 验证 spawn→close→closed send 拒绝→resume 零请求→send→Completion；quit/new/switch/reload 全树 closed，回旧 Main 无 auto work。旧 Main transcript card 只是历史，旧 ID 不自动重建/执行、不入新 Running/Done。
4. 回退先停本次新 writer，只切换隔离环境的 code/build/config，不让新旧代码交叉写存储；正式 profile 切换另排。正常 close/resume 永远保留 v2 history。

本文件同步未运行删除或正式 profile 切换。旧 card target not found 不代表旧 store 已删除；当前代码不读取它，也不提供专门 legacy-ID 迁移 diagnostic 或重跑旧任务。

## 5. 验收与诊断记录

以下是待执行的 gate，本轮文档修订不运行 build/测试/安装。先核心 typecheck/build/verify-dist/unit/contract、stock probe、适用 real SDK/TTY/faux；再共享 node scripts/check-dependencies.mjs/command gate/diff-check。report 列 actual commit/binary/profile、gate output 和未测。historical process/RSS 数字不抵当前 Pi 1.5.0 与 patched UI host 基线：完整 profile/10 并发 32 open 长 history/20close-resumecycle、heap/handler/FD/timer/p95 按既定门槛重测，不强制 GC 掩盖残留、不以离散 max 冒充峰值。

真实 provider 只按 coordinator 批准的小模型预算，faux 用于大控制流/容量矩阵；native TTY 非真实模型请求。真实 provider、全 profile、人工 TUI 与规模性能仍未验收；IME/physical kitty/SSH 人工验证单列。cleanup 只处理本次自起 process/temp 目录，不改他人 store/profile/auth/日常 checkout。

# pi-subagents · 验收合同

## 1. 分层与证据

公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0/唯一 SDK；managed native thread UI 的原版主题降级与补丁热更新边界见 [UI_SPEC §5](./ui.md#5-主题与终端释放)。验收须执行 package 脚本与 fresh process，不以本文或旧报告代替结果。历史 IMPLEMENTATION*/IMPLEMENTABILITY 报告、ADR 与旧 process benchmark 随原仓归档，不作新验收证据；现行行为以本文及 contracts 为准。回归必须覆盖删除资源收口、Process 排队与取消、builtin 权限、实际 factory 漂移、activation 归属及并发读取恢复；真实 provider、人工 TUI 与完整发行 profile 另行验收。

| 层 | 当前命令/验证 |
|---|---|
| 领域/类型 | Subagents npm run typecheck、npm test（unit/contract） |
| 产物/按需 | source-only 依赖已迁入；npm run build、verify-dist；mailbox-v1.0.5 相关 compiled consumers 新 build/fresh process；无 child/supervisor、cold service/store/SDK 不创建 |
| public Host | Main append 只走公开 mailbox/readonly session API；旧 appendCustomMessageEntry/getEntry/getEntries 三 probe 已退役 |
| freshSDK 控制流 | 适用 test:real /隔离 fauxfixture，native session ID/generation/unique writer |
| native TTY | 根 integration/subagents/real/sdk-{child-view,statusline,initialization}.mjs <patched-binary>，匹配具备 UI host-capability 的 SDK；Main 真实 PTY+faux，不当 AgentPTYbackend |
| sharedconsumer | session-runtime check；Side typecheck/test+两 probe+test:sdk-view；Compact check；Processes/CC 在目标外从真实源码构建，仅作所需测试依赖，不迁入/提交，不算它们验收 |
| workspace | node scripts/check-dependencies.mjs；node scripts/check-command-completions.mjs；git diff --check |

新增/修改有参数 slash 必须 sameparser/runtime 候选+getArgumentCompletions，empty/partial/unknown 验证；/subagents 含 closedID/path，/resume-agent 无参数，managedcompact 自由文本 null 但 usage 明确。不放宽 gate 或改生产 timing 迁就 fixture。

## 日常回归清单

- [ ] spawn：none/all/N、默认 depth 与工具冻结；codemode/tool-search canonical factory 前后端一致，role/tools fences 与 Pi.VERSION/builtin_proof 匹配；其他 builtin 默认禁用、llama.cpp 不启服务。pi-mcp-adapter 尚无独立 child 声明/工厂与验收时不继承，不以 stock MCP 替代。
- [ ] close/resume：idle、busy/force、整树 drain、closed send 拒绝、resume 零请求后另发输入；回旧 Main 无 auto work。
- [ ] wait：snapshot、释放 active 位、中间卡片/最终 aggregate Wake；future Task 不混入旧 barrier。
- [ ] Process 排队：active 满位持续超过 30 秒后仍正常激活；watchdog 不误判 record-only，deadline 不延长。
- [ ] cancel：interrupt/close/timeout/shutdown 在排队和激活边界撤销输入/等待，晚到 signal/grant 不发请求、不重复 Wake，observer/control 收口。
- [ ] delete：已完成 open 子树先 close/drain 再 delete；cleanup_pending、未退休投递债或 stale revision 保历史，busy 不隐式 force。
- [ ] frozen drift：非 builtin Search/Processes 实际 `execution_factory` 物理文件 SHA 漂移（wrapper 不变）、builtin Pi.VERSION/proof 与 owner/schema、provider/grant、CC hash 漂移在 import/request 前拒绝；旧 profile 可读历史，缺 proof 不执行。

记录 binary/build/profile 与结果，不删除能力以迁就 fixture。现有 CC presentation 是 native child view 必需依赖；本轮不迁入、不提交 Processes/CC，仅在目标外使用真实源码构建产物作为所需测试依赖，不算它们验收。未具备依赖时如实记未验，不用单行 renderer fallback 冒充完整视图。MCP child 支持须由 pi-mcp-adapter 自己明确能力声明/工厂，并另做迁移验收；共享 Runtime 保留的可选 MCP 接口不构成该支持，不解析 stock MCP 配置或冻结 raw 凭据。

## 2. 生命周期/容量/层级

idle close/repeat；busy 无 force 拒绝；force 整树 starting/running/tool/compacting/waiting/queued 及后代，已 closed 根下 resume 后代也关。intent 后/abort 后/Completion 后/ACK 前 recovery，3 秒未 drain，保持 closing 仍占位；late 旧 generation 结果不能改下一 Task，queued 无 started/usage0，每 Task 一 Completion。

resume 只目标同 nativeID、generation+1/unique writer，zero Task/grant/lease/provider/compact（包括超窗 history）；并行 resume 唯一成功/容量原子，closing 祖先拒绝，closed 祖先保持 closed 可 resume 孙。32 open/+1 拒绝、close 释放再 resume，default10activeMain/process、跨 3Main 公平内层 cap 检查，无 LRU/idleeviction。

defaultdepth 1 childregistered/active/profile/fingerprint/prompt 无 spawn，depth 2 孙同样无；Host 独立复核结构 depth。Main/user 给孙 Agent 新 Task 归 Main、child-origin 归 child；parentclosed 仍能目标 resume/send，owner/lease/Completion/wait 闭环，不吸 futureTask 入旧 barrier。配置收紧不强关 existing。

## 3. 输入与取消

send_input idle 新 Task、busy/starting/selected queue 同 Task steer、waiting activation 原依赖保留/满位等待；interrupt current 或未启动 head→interrupted+新 Task 优先、其余 FIFO 保留。closed/closing 两种 interrupt 都拒绝/零请求；旧 tools/aliases 不注册。

UI Enter immediate、Alt FIFO；工具/compact/执行位等待，已接纳 pending→started/cancelled，success 才清 draft/history，failure/detach 保 draft，稳定 ID retry 不重复。native ordinary Enter 无 Follow-up waiting。输入与 settle/dep/timeout/force/shutdown 同到，binding/task/generation 校验，旧 cancelled Mailbox/OwnerEvent 持久 terminalize、ACK/cursor 跳过，不 resume 新 Task 偷执行。waiting input 轮结束 dep 未满足回 waiting。

## 4. Main 结束、prepared 与持久投递

quit/new/switch/reload 全部 forceclose 树、回旧 Main closed/零 auto work；asyncspawncapture/lease/resumeassembly/FIFO 被 ending 越过时 finalcommit 拒绝并 rollback。coldSIGKILLreopenunfinishedhost-lost 一 Completion，recovery stateDiff 包含 Agent/mailbox/event 取消，不能 native-tail-only 推 success。

prepared fault/rollback/rescanuncertain、token TTL/digest/caller/generation/owner lease、writer lock/journalCRC/checkpoint/corrupttail/symlink/quota/ENOSPC。childconfirmTask/resultpersisted 后 ACK；lostapplicationresponse 仅 replay 原 proof、lostACK 仅 ACK，不 release/Wake 两次；cancelledcursor 连续、mixedgeneration/pendinggap 拒绝。Inboxnativeappend/proof 双提交域、chunkbudget/ACK 滑窗、barrier 聚合/catchup、Wake receiptpending→link、不 reacquire 已 settledlease。

Goal active/paused/clear/complete/no-consumer、late claimproducer proof、runtimecommit 失败、receipt 后 link 失败、exactturn_settlement；特定 runtime-before-receipt crash 允许 later duplicate epoch 但不丢 Completion。Process owner token/currentwait/late exit record-only、scope cleanup 和 Final precedence；合法 continuation 排队超过 30 秒仍可激活，不误 record-only，watchdog/cancel 一同收口，取消后的晚到 signal/grant 零请求。

## 5. UI/foreground

Running/Done 全状态表驱动，closing 优先/unavailable 附加/mutedancestor/subtreesort、ID/tab 稳定，width/time 不改序；unread 按 Inbox 去重，fulltuple/revision/widthcache。宽窄/mouse/Tab/arrows/Enter/X/Cidle/Cbusy 默认 Cancel/force/Dcancel/R，closedhistoryeditable 草稿、/resume-agent 零请求后单独 Enter。

成功 onLoaded 清自产 activity，不清收到 descendant；点击 onlyexactcard；坏/混合 receipt/写失败/unavailableinit/R/close/render/scroll 保 unread，不从 offscreenrender 推 tail 可见。当前协调规则与用户最终确认单列，不新 CCprivateviewportcallback。

UI host-capability gate 按 UI_SPEC §5 核对两面：双面均缺失时允许原版 managed native thread UI，须给一次降级提示且避免重复同名 setTheme；仅一面声明或任一未知值时须在 Main stop 前拒绝，而 tool-only/headless、Main strip/Tree 仍可用；不能藉 marker 扩 tools/model/provider 权限。正式 host artifact 须分别验证 CLI bundle/unbundled SDK 的 file-version watcher：metadata 未变不重复读/parse，inplace/atomic replace/删除重建/symlink 后沿用原 loader/cache 失效；child 前台期间文件变化后，按 named 返回 Main 的 cache/真实颜色与后续热更新均恢复。SDK patch、Runtime guard 与 consumer rebuild 后须 fresh process 重跑；隔离实验或测试文件复制不算正式 artifact 验收。

Main/Side/Subviewsingle foreground/single stdin，original editor/history/draft/theme/focus/mouse/resize/监听引用恢复，CC 后台 recorder/新 viewattach、return 不 abort、quit 不重启 Main。Side10roundtrip/model-effort/BTW/compact/destroy/externaleditor、两 visibilityprobe，不把 MaintestPTY 当 Sideprocessbackend。

## 6. 切换与性能剩余 gate

隔离 profile 验证独立 v2；旧存储不读、不转换、不删除，正式 profile 切换另行验收。测试必须 copied profile/auth symlink、自起 owned process cleanup，不能跑 global PID 清理或修改日常 agent-dir。

完整目标 Pi 1.5.0 与 patched UI host profile 首帧多样本、1/3/10/32 open、10stream、长 history/image/toolpayload、至少 20close/resumecycle，自然 GC 窗口、heapreachability/handlers/FD/timer/activewriter 与 Main 逐键 p95；不能旧 1.2 数字替代或强制 GC 掩盖稳态泄漏。旧 N3memory−30%/warmspawn−40%/p95 恶化≤10%门槛未获准改变，跨版本匹配不了标未验证。IME/actual kitty/SSH 人工一轮、provider/cache/effort 实际可观测性、小模型预算只由 coordinator 批准。真实 provider/cache、全 profile、人工 TUI 和规模性能均未验收；faux/PTY 不替代这些 gate。

## 7. 既有 C/D 审查回归要求

UIKit getRenderedItemAt 的 panel-local visible ID 在 filter/scroll 后仍准确，clip 不改 ID；disabled/bounds/non-item/failed render/input/invalidate/closed 无效命中。Subagents 20 个近似名 Done rows 隐藏 worker 后点击 worker18/worker17，极窄 width=5 同样 exact ID；stock mouse fixture 21 个 Done、滚动后点击 worker16，只清该 Agent 的自产活动标记，隐藏 worker 保持 unread。禁止文字子串回推 ID。

SDK assembly gate 验证正常 active starting 同 generation：Enter 绑定 first Task，Alt+Enter 接 second FIFO，两 Task/两 Completion；历史 unavailable runtime 仍拒绝。历史实现报告留在原仓；迁入后的 UIKit/直接 compiled consumers rebuild 与 faux/TTY 必须重新取证，本轮文档同步不将历史通过记为 Pi 1.5.0 或真实 provider 证据。

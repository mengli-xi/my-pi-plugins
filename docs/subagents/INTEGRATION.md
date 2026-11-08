# pi-subagents · 跨包集成

## 1. Shared libraries 与同进程范围

pi-runtime-contracts 是 Pi-free 源库，拥有 continuation-v1 blocking lease/Wake、process-wait-bridge-v2 和 approved child capability descriptor registry。pi-session-runtime 拥有 public effective capture/select/native seed/session assembly、factory loader、TerminalOwner/ManagedInteractive/InputPolicy；pi-session-inject 拥有 mailbox-v1 与 safe tail predicate，目标 transportBuildId=mailbox-v1.0.5。source-only 依赖已迁入；Subagents 以 file 依赖，compiled 源码或 source-only 依赖变化后显式重建直接 compiled consumers 并 fresh process，不能混用旧 bundle；Side/Session Compact 直接 source 加载。

唯一 SDK，Host/service 管理各 Main session scope，runtime/view/Task 状态各自独立。没有跨 process Owner IPC、Supervisor/PTY 或 child-env 传输。共享文件/网络/credentials 仍同 authority，不提供 sandbox/文件锁；Processes OS supervisor 本身保留，不能因删除 Agent 进程误删它。

## 2. Task lease、等待与 Goal

每 Task blocking lease ownerId=pi-subagents/logicalKey=原 Task ID；持有会话是 Task.owner_conversation。结构 parent 只管理 tree；Main/user 给孙 Agent 新 Task 归 Main，child-origin 归 child；steer/wait activation 不改 owner/lease/deadline。等待 active 位释放，但 Task lease 继续阻止 owner ordinary Goal continuation。

Goal consumer 使用同 runtime-contract registry，defer ordinary continuation 而非所有 completion；独立 Process/Subagent completion 即使其它 lease 还存在也可 Wake，后续 ordinary Goal 再评估 blocking。每 epoch 一个有效 continuation owner，producer proof registry 阻止 late Goal claim 重复 schedule，exact consumer receipt/producer native proof 持久后 Outbox 才终态；pause/clear/complete 撤销 claim 没有 receipt 时 Main producer 在同 epochfallback，不等 Goal 恢复。

Goal 只读共享 producer proof 与 runtime offer，不读 Subagents store。durable consumerId 固定 pi-goal-local，onSettledWithReceipt 的 proof/version/offer/generation/continuation identity 必须匹配。backgroundWaitCheckInMs（默认 1200000，可 null）是 Goal policy，不是 Subagentspolling。完整双提交域/Wake/turn settlement 见 DELIVERY_PROTOCOL；SDK child 只装 approved factories，无 Goal consumer，其 fallback 不能宣传为任意 child 插件兼容。

## 3. Processes

Processes 与 Subagents 无生产互 import，仅 shared contract 和 approved named factory；非 builtin Processes 的 `execution_factory` proof 直接读取实际物理 factory 文件做 SHA 校验，缺 proof 的旧 profile 只读历史、不执行。createProcessesChildFactory 绑定 SDK sessionScopeId/agentDir/getBridge；Subagent lifecycle 在本地提供 version2 bridge/captureOwnerToken，Host 按 owner token、Task/generation、waiting/current status 准入 trigger，否则 record-only。Process 满足先于 agent_settled 时暂存一个 signal，安全边界重试；正常等待 active 位超过 30 秒不能被误判 record-only，必须保留可激活信号。watchdog 应区分合法排队和 owner 失效，cancel/close/timeout 则撤销待激活工作并清理观察者，晚到信号或 grant 不得重启已取消 Task；具体接口由 Main 对齐，不预设新字段。消费一次后 late terminal 只 appendEntry TUI，不进入模型 context、不改已 finalTask。

waiting_on process 输入申请 active activation，不取消原 wait；barrier 等待同理。finish/interrupt/closed/stale generation 拒绝 continuation。Process OS 记录/log/watch/stdin/signal/group containment 仍 Processes 拥有，AgentHost 只管 SDK session/Task/lease/Completion。SDK scope 销毁 cooperative cleanup、失败如实报 closing，不宣称 Agent process kill 保障。

## 4. Presentation 与前台

CC Main 注册 target descriptor，Subagents/Side 按 owner/hash/package/export 解析显式 factory。CC execution assembly 安装轻量 run recorder，后台仍记真实 duration；UI 按 viewLifecycle attach/detach，不补造旧历史 run。CC 已拥有 fullscreen viewport/mouse/floating completion，Main 命令/config/telemetry 不进 child factory；旧 frozen Pinned entry 只忽略、不读文件。CC presentation 是 native child view 必需依赖；本轮不迁入、不提交 Processes/CC，仅在目标外使用真实源码构建产物作为所需测试依赖，不算它们验收。不删除视图功能或预先迁入它们来假造本轮通过。

单 process TerminalOwner 只允许 Main/Side/一个 Subagent 前台，暂停 Main 公开 TUI 而保留 editor/history/draft。ManagedInteractive 管理 native init、theme 恢复、listener 引用差集和 awaitdetach/stop/headless rebind；quit 只释放不重启 Main。InputPolicy 传 immediate/after-current，SubagentsdurableHost 输入/command drain；Side 保留 busy 拒绝新 prompt 和自己的 emptyDelete/external-editor yield。onLoaded 仅 Subagents 使用，成功 native 初始化才提交精确自产 Completion read receipts。

Subagent Completion 用 subagent-completion-v1 versioned semantic renderer，domain owns XML/digest/投递，CC 只绘单行与点击 TextPanel。Completion renderer 在 CC 缺席/坏 registry 时保留明确单行 fallback；native child view 缺少合法 CC factory 则拒绝，不能把 renderer fallback 当完整视图，不改模型 context 或 delivery proof。Subagents 列表鼠标另消费 UIKit getRenderedItemAt 的最后成功 frame 稳定 item ID，filter/scroll/clip 不靠文字猜测，input/invalidate/失败清旧命中；无新 Pi private seam。列表/strip/statusline 用同 agentPresentation，unread 精确 Inbox 去重；不读 Main private viewport 推断已读，规则见 UI_SPEC。

## 5. 上下文、记忆、压缩与 Side

effective capture 按 session/generation/branch/model/tools/capabilities 验证，native stable tail 不复活 raw history，none/all/N 与 MCformat contract 见 CONTEXT_SPEC。factory 不复制 Main 完整插件/Goal/Todo/skill owner state；权限冻结与 history fork 分开。

Side 默认且唯一 SDK，使用同 capture/assembly/view/TerminalOwner，ProcessesSidefactory 普通 scope，不用 SubagentTask bridge。Side 自有两 instance-only visibilityprobe；无新 shared private seam。Subagents/Side 未装 pi-cc-memory explicit role factory，继承 history 不授予 memoryowner 写权限。Session Compact 新增 library capture/select consumer，仅 Mainprofile whole-session compaction；child/Side 仍 native 自动压缩，父历史 provenance/support 未因此验收。

## 6. 跨包验收

本轮 builtin consumer 仅 codemode/tool-search canonical factory，前端 closure 与后端受控装配一致，遵守 role/tools fences；`builtin_proof={version,pi_version}` 核对 canonical Pi.VERSION，不对 builtin 标识做物理文件 SHA 读取。共享 Runtime 显式 Builtin 接口默认全禁，可选 MCP 能力不等于本 consumer 支持；未选中的 builtin 不启用，llama.cpp 非工具、不启服务。

当前 MCP 来自 pi-mcp-adapter，child 继承需 adapter 自己明确能力声明/工厂及后续独立迁移验收，现在不宣称支持。不使用 stock MCP 替代，不解析其配置或冻结 raw 凭据。非 builtin Search/Processes 的 `execution_factory` proof 才直接读取实际物理 factory 文件做 SHA 校验，不能只校验 wrapper；旧 profile 可读，缺 proof 不执行，也不从 Main ambient discovery 补权限。

至少共享 dependency/command gate、适用 owner/直接 consumer typecheck/test/build、stock 私有 probe，freshSDK/TTY/faux 回归。验证 Goal absent/paused/cleared、late claim/proof、simultaneousProcess/Subagent Wake、barrier 聚合、Main/user 孙 Agent 新 Task owner、Processlateexit record-only、Main/Side/Subagent 前台互斥及 draft 恢复。本轮只改文档，不运行 build/测试/安装；全 profile、真实 provider/cache、人工 TUI 与 10-32 长 history/20cycle RSS/FD/IME 均未验收，不用历史 process 数据替代。

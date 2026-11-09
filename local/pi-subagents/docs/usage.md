# 使用与配置

## 配置合同

### 1. 来源与错误处理

user `<agent-dir>/pi-subagents/config.json`，trusted project `<cwd>/.pi/pi-subagents.json`，defaults→user→project。agent-dir 走公开 Pi API/PI_CODING_AGENT_DIR。project 只能收紧 per-Main/per-Agent/timeout/maxDepth，放宽数值 clamp 到 user；process 级 capacity.activeTasksPerProcess/storage.maxStoreBytesPerProcess 仅 user，project 写入拒绝。未 trusted project 不加载。严格 JSON、无重复/未知 key、单文件≤65536 bytes；不自动改用户文件。

schemaVersion 必须 2。删除 execution.helperRuntime/runtimeStopGraceMs、capacity.residentChildrenPerMain/idleResidentsPerMain/residentChildrenPerProcess、storage.maxAgentsPerMain、全部 liveView；maxAgents 改 capacity.openAgentsPerMain（closed 不计）。PI_SUBAGENTS_BACKEND 任意已设置值（含 sdk/空串/process）都拒绝，删除变量。中文诊断带来源、完整 key、修改方式；Main 仍启动/普通输入可用，spawn/send_input/resume 拒绝，close/list/history/accepted delivery 仍可用。

### 2. 当前完整默认与范围

| key | 默认 | 整数范围 |
|---|---:|---|
| execution.taskTimeoutMs | 1800000 | 60000..86400000 |
| execution.maxDepth | 1 | 1..2 |
| capacity.activeTasksPerMain | 10 | 1..32 |
| capacity.activeTasksPerProcess | 10 | 1..64 |
| capacity.openAgentsPerMain | 32 | 1..32 |
| storage.maxTasksPerAgent | 256 | 1..256 |
| storage.maxTasksPerMain | 4096 | 32..4096 |
| storage.maxMailboxRecordsPerConversation | 1024 | 16..1024 |
| storage.maxConversationBytesPerAgent | 67108864 | 1048576..67108864 |
| storage.maxStoreBytesPerMain | 536870912 | 67108864..536870912 |
| storage.maxStoreBytesPerProcess | 2147483648 | 268435456..2147483648 |
| storage.maxMetadataBytesPerMain | 67108864 | 8388608..67108864 |
| storage.maxMailboxBodyBytesPerConversation | 4194304 | 65536..4194304 |
| storage.maxPendingDeliveryBytesPerMain | 16777216 | 1048576..16777216 |

关系：activeMain≤activeProcess 且≤openMain；maxTasksMain≥maxTasksAgent；storeMain≥conversationAgent+16777216；storeProcess≥storeMain；metadataMain≤storeMain。无 unlimited/0 特殊值。

最小配置：

```json
{"schemaVersion":2,"execution":{"maxDepth":1},"capacity":{"activeTasksPerMain":10,"activeTasksPerProcess":10,"openAgentsPerMain":32}}
```

### 3. 生效边界

Task timeout 优先显式 spawn > role > config > default，在 Agent profile 冻结，首次 execution grant 分配 deadline，waiting/retry/compaction 不延长。maxDepth 冻结为 profile.delegation_max_depth，实际 Host 结合当前限制重新核验结构 parent chain；默认 child/grandchild 在 ceiling 时不注册 spawn，不靠提示词禁止。

open 计 lifecycle 不等于 closed，含 idle/waiting/queued/closing；prepared spawn 有效 reservation 计入准入。Task 完成保持 open，只有 close 收口释放名额。active 只计已 grant 执行，waiting 释放、activation 排位，未 drain 取消不释放。配置收紧不能中断已 accepted 工作，只阻止新准入/grant 超过新限制；无 resident/LRU/idle timer。

profile.settings_snapshot 持久保存 allowlisted 公开 Pi settings，execution 深拷贝并固定 native compaction enabled、冻结 model 当前 window 预算；Main settings 不变，resume 不触发 compact。UI 使用 Main 已有 CC 配置，无 liveView override；旧 Pinned entry 只忽略、不加载。共享库使用 workspace 依赖，修改它或 compiled 源码后须重建直接 consumer；mailbox-v1.0.6 必须配套新 build/fresh process，不能用 /reload 代替。旧存储不读、不转换、不删除。

## 模型工具合同

目标 Pi 1.5.0，当前唯一 SDK。Schema/parser 以 local/pi-subagents/src/tools/{schemas,validate,register}.ts 为准，Host 不能信任模型提供 caller/generation。所有对象拒绝未知参数；string/collection 有界，target 是当前 Main 的 Agent ID 或 task path，不能指定 PID、路径或其它 Main。

### 1. 工具集合与权限

| 工具 | public 参数 | 权限/效果 |
|---|---|---|
| spawn_agent | task_name, message, fork_turns?, agent_type?, model?, reasoning_effort?, task_timeout_ms?, service_tier? | 创建直接 child 并 durable 准入 initial Task；达到 maxDepth 不注册也不准入 |
| send_input | target, message, interrupt?:boolean | Main/user 可操作当前 Main 后代；child 限直接 child。closed/closing 拒绝 |
| resume_agent | target | Main 模型/受信用户；只恢复目标 idle |
| close_agent | target, force?:boolean | Main 模型/受信用户；整结构子树 |
| wait_agents | targets:1..32 | caller-owned 已准入 Task 集合；child 限直接 child；单独一条 assistant tool 调用 |
| list_agents | path_prefix? | 当前 Main 全树有界 metadata，含 open/closing/closed，无历史正文 |
| list_subagent_models | query | caller 当前 scope 中的 canonical provider/model 精确优先、否则分词查询 |
| list_subagent_roles | query | caller 可用 role 名称精确优先、否则名称/description 分词查询 |

child 不注册 close/resume，保留 finish_task。旧 send_message/followup_task/interrupt_agent/kill_agent 及 alias 不注册；内部 FIFO/stop-current 不暴露模型。Main-only 生命周期操作不能通过 child 传 kind=user 伪装。

spawn task_name sibling 唯一，重复拒绝，不复用已完成/closed Agent。role 默认 default，builtin 另有 explorer/worker，trusted-project > user > builtin；role 仅收窄 scope。model 省略按 role/父默认解析，显式 provider/model 只取已授权 scope；bare id 仅唯一时可解析。effort 支持 off/minimal/low/medium/high/xhigh/max 且模型必须支持：显式值优先，之后 role，同模型继承 parent，否则 medium clamp。tier 同样校验，不能静默扩权。

fork_turns 省略 none，接受 none/all 或 canonical 整数 1..100000。N 保留能唯一映射的完整 business turn，MC 有损标签/跨 origin 歧义/未知 format 拒绝，提示`effective-context-unavailable: <reason>; use fork_turns=none.`；all 用有效请求原文而不回捞 raw 历史。timeout 范围 60000..86400000ms，优先显式 > role > execution.taskTimeoutMs > 1800000，在 Agent profile 冻结，所有以后 Task 沿用；首次 grant 才开始 wall time。

### 2. send_input 状态矩阵

| target 状态 | interrupt 省略/false | interrupt=true |
|---|---|---|
| idle open | 新 Task，owner/initiator 取 caller | 同左 |
| starting/running（含 tool/compact） | durable steer 绑定同 Task，保留 owner/lease/deadline | interrupt intent + 新 Task 优先；其余 FIFO 保留 |
| queued-only | 绑定 selected head 的 task-scoped input | 未启动 head 以 interrupted 结算/usage0，新 Task 优先 |
| waiting | 同 Task activation 申请位，原 barrier/Process wait 保留；满位等待 | 取消当前等待 Task 及其 input/barrier，新 Task 优先 |
| stopping current | agent-busy 拒绝普通输入 | 仍按 Host 当前 Task 与 revision 校验 |
| closed/closing | agent-closed/agent-closing，零模型请求 | 同左 |

durable 成功返回 agent_id/task_path/submission_id/task_id、disposition=steer|wake|new-task|interrupt-and-start、delivery=pending、task_state，替换时带 interrupted_task_id。accepted 不表示模型已消费；input-pending/取消与 native proof 由 Host 记录。input 与 settle 串行，不能写到下一 Task；取消的 Mailbox/OwnerEvent 不能 resume 重放。

Main/user 给任意后代新 Task 的 owner 为 Main，child 给直接 child 为 child；结构 parent 不改。steer 保持已有 owner。UI Enter 走 immediate（同矩阵），Alt+Enter 走 after-current（FIFO 新 Task，不 interrupt；starting 的匹配 generation 正常装配也允许）；public send_input 没有 FIFO 参数。

### 3. close/resume 结果

close 无 force 只允许整子树无未完 Task；force 先持久 closing，取消 current/queue/input/barrier，再叶节点 drain、结算、交付/lease/ACK、dispose。返回 agent_id/task_path/lifecycle、already_closed、affected_agent_ids、interrupted_task_ids、completion_ids、cleanup_pending、resumable、open_agents/open_agent_limit。三秒仍未清理时 closing/cleanup_pending，不假装 closed 或提前归还名额。重复 closed 根仍要检查后来 resume 的后代。

resume 返回 lifecycle=open、already_open、runtime_generation、task_started=false 与 open count/limit。串行容量检查，只装配目标；零新 Task/lease/Completion/provider/compact。已 open 幂等；closing 或 closing 祖先、frozen drift、open cap 拒绝。closed 祖先不阻止显式 resume 孙 Agent，但后代不可绕过 closing 子树。失败 dispose 装配并保留 closed；无自动输入。

### 4. wait/list/finish

wait 冻结当前/queued caller-owned Task IDs，idle 时可取该 target 的最近 settled owned Task；Main 跳过非自己拥有 Task，child 对不匹配 owner 拒绝。不吸收之后新 Task。返回 already_settled 含 completions，或 armed 含 barrier_id/task_ids/settled_task_ids/remaining_task_ids；已 active barrier 拒绝重复。等待释放 execution 位但保持同 Task/lease/deadline，输入可申请 activation，barrier 继续有效。

list 返回 agents/count；行包括 agent_id/task_name/task_path/parent/depth、state/current phase/queued IDs、lifecycle/revision/resumable、latest_outcome、model/effort/role、runtime=resident|unloaded、runtime_generation、availability 与 record revision。resident 这个 DTO 词仅指 SDK 实例存在，无 resident cap 或 OS PID。

finish_task({outcome:partial|blocked,text,reason?})只在 child 当前 Task 可用。blocked 必须 reason=user-input-required|approval-required|external-prerequisite；partial 带 reason 会忽略。text 非空 NFC 且≤65536 UTF-8 bytes。Host 先持久声明/digest/toolCall/request/generation，之后 terminate 当前 run，等公开 agent_settled 按 Delivery precedence 结算；普通 completed 用 final，不调用 finish。

### 5. 结果与错误

tool envelope 为{version:1,tool,outcome:ok|rejected,host_revision,data?或 error}；错误 code/message/correlation 有界，拒绝不伪装成功。核心错误：invalid-arguments/invalid-target/target-root/target-not-child/not-found/name-conflict/depth-limit/open-agent-capacity/agent-closed/agent-closing/agent-busy/task-capacity/active-barrier/no-current-task；model/effort/tier/role/capability/context unavailable；storage/protocol/delivery 故障；stale-binding/runtime/task/revision/cursor/confirmation、operation-expired、permission-denied、cancelled。完整 catalog 在 tools/errors.ts。

配置错误中文包含 source path/完整 key/改法；拒绝 spawn/send/resume 但 Main、close/list/history/accepted delivery 继续可用。内部 expected 生命周期/Task/runtime revision 只来自受信 UI/Host，public grammar 不暴露。/subagents [target] 无参数打开管理入口，可选 target 为 Agent ID 或 task path，补全同 runtime 目标集合并包含 closed，/resume-agent 是无参数 view 命令；有限候选从 parser/runtime 同源，自由 compact 文本可返回 null scaffold。

### 本地查询

list_subagent_models({query}) 先去首尾空白，不分大小写精确匹配 canonical provider/model，命中只返该项，即使不可用。否则按空白、/、: 分词，所有词都须出现在 ID，顺序不限。候选去重、按 canonical ID 字节排序，最多 20 条；返回 {models:string[],unavailable:{id,reason}[],more?}，不重复 query，无命中两个空列表。

缺唯一 Subagent provider owner 的 reason 是 provider has no subagent support，超 caller --models scope 是 outside --models scope；同时存在优先 provider。不允许用 unavailable ID spawn。此查询不改 spawn 的解析/权限。

list_subagent_roles 先精确 role 名，否则分词匹配名称/description，按名称排序最多 20，返回 {roles,more?}。

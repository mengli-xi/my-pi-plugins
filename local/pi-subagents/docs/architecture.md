# 架构与运行模型

## 同进程运行模型

### 1. 三种独立状态

Agent 持久 identity/profile/history，lifecycle=open|closing|closed；Task 是 durable 工作、phase=admitted|starting|running|waiting|settled；SDK execution 是易失 runtime generation。view 是每次进入创建的 native InteractiveMode，普通离开仅销毁 view，不结束 Task 或 execution。没有 Pi child process、Supervisor、PTY screen/attach、backend chooser 或 LRU。

open idle 仍占 open 名额。Task 完成不关闭 Agent。closing 先 fence 工作、保持清理权与容量，直到所有执行/控制 drain 才 closed；closed 历史可用，无模型工作。resume 串行只恢复目标 idle execution 并递增 generation，native session ID/frozen profile 不变，零 Task/lease/provider/compact。

### 2. 准入与调度

Host mutation queue 负责 target/caller/revision、Task owner、capacity、prepare/commit/receipt；Scheduler 只授予 execution 位，不能改 Task 结果。default activeTasksPerMain=10、activeTasksPerProcess=10、openAgentsPerMain=32；open 含 closing/queued，closed 排除，prepared spawn 的有效 reservation 计入准入。storage quotas 独立。

Main 内按 admission/activation order FIFO，跨 Main 公平轮转，每次内层 grant 复查 global cap；收紧配置不强关现存工作。waiting 保留 SDK/current Task/lease/deadline 但释放 active 位，依赖/用户输入只申请 active activation，满位继续排队。输入轮结束依赖未满足回 waiting；同时到达的满足信号合并，不重复恢复。Process continuation 正常等 active 位不能因 30 秒转 record-only；watchdog 不替代 Task deadline，cancel/close/timeout 撤销同 Task/generation 的待激活工作，晚到信号/grant 不得开工。starting 正常 active assembly 期间 Alt+Enter 可以 durable 接 FIFO 新 Task，匹配 current Task/generation 后不误报 historical model-unavailable；running/starting/tool/compact 普通输入绑定原 Task，队列 head 在启动前同样可绑定；settle 与 input 不交叉写下一 Task。

取消 current 先持久 intent 及 input 取消，等待 abort/prompt/public idle/control drain；不能在 JS 仍执行时释放 active 位。queued 未启动 Task 结算 usage0、无 started_at/deadline。Task replacement 优先，其余 FIFO 保留。没有 idle retention 或 resident 预算；close 是唯一生命周期回收入口。

### 3. 装配与 generation

空 Main 仅加载工具/schema/grammar，不创建 service/store/session。首次工作才 import process-service/store/SDK assembly；进程级 service 管理同 process Main scopes，非 daemon。public createAgentSessionServices/createAgentSessionFromServices/AgentSessionRuntime 装配独立 SessionManager、ModelRuntime、SettingsManager.inMemory/resource loader 和 scope；不改 process cwd/env、不扫描 ambient 插件。

profile 持久 allowlisted settings_snapshot 和 delegation_max_depth。每次 execution 从 snapshot 深拷贝并应用冻结 model/effort 及 native compaction 预算；无 per-Agent settings cache。role/prompt/artifact 不能 resume 再生成；catalog/credential drift 拒绝执行。resume 过大历史也不 compact，真正 Task grant 后才 preflight。

generation 由 Host 的 Agent.runtime_generation 管理，新装配、close 收口或 cold recovery retire 旧 generation 时增长，所有 callback/input/application/stop 都以 Task ID/generation/lifecycle 复核。失去 owner 的异步装配由同 cleanup Promise dispose，失败 resume 在释放 Host queue 后清理避免 self-drain 死锁。旧 generation 的 late abort/result 不碰下一 Task。

### 4. 生命周期与 Main 结束

close 先在一笔事务冻结整棵结构子树 closing、取消 current/queue/mailbox input/barrier；再从叶节点 abort/drain、每 Task 一 Completion、owner lease/Inbox/Outbox/ACK、dispose，最后 closed_at/close_reason/lifecycle_revision。3 秒未收口返回 cleanup_pending，仍 closing，继续等可合作释放；不能硬 kill JS 或改已有 settled outcome。closing 祖先禁止 resume 后代；closed 祖先下的目标可独立 resume。

已完成 open 子树的删除先沿上述 close/drain 收口，再重读 snapshot/revision 校验 delete 条件；closing 不得删除，未完成工作不隐式 force。close 保留 history，delete 是另一步持久操作。

Main 所有 session_shutdown 都先 ending fence、detach 旧 append/view 权限，Host 串行枚举整树 force-close。async prepare/lease/assembly 完成前后都再检查 ending，失败用现有 rollback 释放 artifacts/lease。quit close view 不重启 Main TUI；new/resume/switch/fork/clone/reload 恢复终端后关旧树。回原 Main 只读 closed history，显式 resume 才恢复。

cold reopen 在 writer lock 内 replay 完整 journal，ownerless current/queued 工作按正常事务结算 interrupted/host-lost 并关闭 Agent/取消 input，Completion 不重复；pending accepted delivery 继续对账。绝不从 assistant tail/native 文件或 process exit 推断成功。正常 SDK settlement 只在公开 agent_settled 读取 native proof 提取 result/usage。

### 5. 前台与交付

共享 TerminalOwner 保证 Main/Side/Subagent 互斥 stdin，ManagedInteractive 暂停同一 Main TUI、保留 editor/history，native view init 前 attach 可选 presentation，返回 await 输入/managed 命令 drain、detach、stop、headless rebind。CC execution recorder 始终收真实 run facts，UI 独立 attach/detach。命名主题/public listener 引用差集见 [界面合同](ui.md)。

ChildEventProcessor 直接调用同进程 conversation 端口，保留 durable OwnerEvent/result/ACK 状态机。Task owner 而非结构 parent 决定 lease/Completion；等待 barrier 只覆盖 caller-owned 准入快照，future Task 独立。Delivery 双提交域、Wake receipt/turn settlement 保留，closed 不会清 unread。完整格式与故障策略见 Persistence/Delivery/Host。

## Host API

这是 package 私有、同进程 SDK 的领域 authority。public 模型 grammar 见 [工具合同](usage.md)；durable schema 见 [持久化合同](persistence.md)，delivery/application/ACK 见 [投递合同](delivery.md)。本合同定义 prepare/commit、Task lease、generation、幂等 result 和 ACK；不定义 OS transport、nonce、fd、launch descriptor 或 PTY handshake。

### 1. 权限与可信 caller

AgentHostCoreV1 由 process service 按 Main session 绑定，writer lock/journal 是 metadata authority。HostCall 包含 request_id、caller、可选 expected_host_revision；模型只能给 public input，adapter 生成 caller，不能接受模型传 user/recovery 身份。

| caller | 可信身份/fence |
|---|---|
| main-model | main conversation/session_id + binding_generation |
| agent-model | agent conversation/session_id/agent_id + runtime_generation + owner_request_id |
| user | main_session_id + binding_generation + manager_generation，由实际 UI 构造 |
| recovery | main_session_id + recovery_generation，仅 store/service 恢复路径 |

解析 target 只在同 Main；Main/user 可给任意后代新工作，agent-model send/wait 限制直接后代，spawn 只创建直接 child；close/resume 仅 Main-model/user。Host 复核结构 parent chain、当前 maxDepth 和 frozen delegation ceiling，不相信缓存 depth 或工具是否隐藏。list 可看当前 Main 有界 metadata，不返回 history/prompt/secret。fork/clone 不转移原 tree ownership。

HostResult={ok:true,host_revision,value}|{ok:false,host_revision,error:{version:1,code,message,retryable,correlation_id?,current_host_revision}}。错误不能部分成功。expected revision 用于受信 UI 确认，stale confirmation 重做，不静默按旧 snapshot 执行。

### 2. 当前操作端口

| 方法 | 输入/authority | durable 结果/副作用 |
|---|---|---|
| spawnAgent | public spawn input +可信 caller | prepare frozen artifacts/profile、新 Agent/initial Task/owner lease/receipt，commit 后 schedule |
| sendInput | target/message/interrupt? | steer/wake 同 Task 或新 Task/replacement，submission_id/delivery pending；见 Tool 状态矩阵 |
| resumeAgent | target | 串行 open capacity 与 frozen assembly，open idle、generation+1，零 Task/grant/lease/provider/compact |
| closeAgent | target/force?/expected_lifecycle_revision? | 整子树先 closing，取消工作、leaf drain，closed 或 cleanup_pending |
| waitAgents | targets | caller-owned 当前/queued/latest Task 快照，already_settled 或 armed barrier |
| listAgents | path_prefix? | 所有 lifecycle/resumable/availability/current/queue/frozen model metadata |
| markCompletionsRead | receipts[{inbox_id,completion_id,projection_sha256,entry_id}],at | 精确 native entry/Inbox 身份校验，一笔首次 ui_read_at/revision |
| interruptAgent | target/expected_task_id?/expected_runtime_generation? | 仅受信 UI/timeout stop-current；fenced intent 后 abort，不创建 replacement |

followupTask 等内部 FIFO 方法不注册模型；UI after-current 用已可信 caller 和稳定 request ID 进入它；current Task 正在 starting 且 active runtime generation 匹配的正常装配允许 FIFO，unavailable history runtime 仍拒绝。模型 send_input 只有 interrupt boolean，没有内部 intent/stop-current 参数。Main shutdown/config diagnostic/closing 等 work fence 对所有新 spawn/send/resume/FIFO 生效，close/list/history/accepted delivery 继续可用。

### 3. 输入、生命周期与 receipt

sendInput 当前/selected head 存在且 interrupt=false：先持久 task-scoped Mailbox ID/body hash/source/sequence 和 operation receipt；waiting 设置 activation_order，保留 Task/owner/deadline/barrier/Process wait。finishWaitingActivation 携带该 grant 捕获的 expectedActivationOrder，仅匹配时清除；若期间已有较新的 order，不写回旧状态，继续由原 flush/准入链处理。idle 或 interrupt=true 建立新 Task，initiator 和 owner_conversation 取可信 caller；Main/user 归 Main，child-origin 归 child。replacement 优先，原 head 未启动也必须有 interrupted Completion/usage0，其余 FIFO 保留。

SdkRuntimeControllerV1.admitViewInput(agentId,caller,text,intent=immediate,requestId?)映射 Enter/Alt 意图。普通 Enter 不是 native followUp。稳定 ID 重试返回同结果，成功才清 draft；input 与 settle 串行，apply/send/native proof 前复核 Task/lifecycle/generation，取消 OwnerEvent/Mailbox 保持 terminal，resume 不能把旧输入放到新 Task。

resume 串行检查 open count 及 closing 祖先，只装配目标 idle；成功才 commit open，失败释放 Host queue 后 dispose，防止清理重入死锁。close 先事务冻结整结构子树、取消 pending input/barrier 和 current/queued，再从叶节点处理 abort→public idle/prompt→control delivery/lease ACK→dispose→closed。3 秒未收口返回 closing/cleanup_pending，容量保持，不改 settled outcome。重复 closed 根仍包含后来 resume 的后代；closing 子树拒绝恢复后代。

### 4. Prepare/commit/abort（从旧 Owner 合同保留）

所有 mutation 先分配 transactionId、写 sync 的 prepared record 和 artifact hashes。local admission 包含 structural_parent 和**独立 lease_owner**；intent.session_id 必须等于 lease_owner.session_id，logical_lease_key 恒等 reserved_task_id。Agent 结构 parent 不因 Main/user 的新 Task owner 改变。

child-local nested spawn 先捕获其公开 effective context 和 frozen capabilities，给 Host 提供 private artifacts；Host 校验 cwd/trust/model scope/tool definition/owner subset 及 artifact digests。不是任意文件路径/argv。内部 prepareOwnerTask/commitOwnerTask/acquireTaskLease/abortPreparedTask/collaborate/finish 通过同进程 ChildToolPort，不经 IPC。

prepared 阶段预留 opaque IDs/path/public result/digest；未 commit 不能 target/list/schedule 或对模型称成功。初始 base/proposed revision 只描述 snapshot，不预留未来 journal revision。最终在 writer queue 下加载 current revision，复核 binding/runtime/ending、name/parent/open/task/storage capacity、profile/artifacts 与 target，再 current+1 commit；中间异步 capture/lease/assembly 结束都再检查 ending。Main 结束先 fence，再串行枚举旧树，异步准入不能越界 commit。

child-owned prepare 保留 30 秒 TTL/明文 token 只在 live 内存、磁盘只有 hash、caller/runtime generation、operation digest、reserved ID、lease owner、冻结 public result 和 phase。阶段 prepared→lease-proved→commit-requested 都原子 sync；token 不是 lease 证明，重启不再生，查询已 commit receipt 返回冻结 public result，矛盾 ID/digest 拒绝。内部 followup kind 是历史领域名，不是 public tool。

获取 live blocking lease 必须在**Task owner 会话**，ownerId=pi-subagents/logicalKey=原 Task ID。Main-owned 本地 registry；child-owned 用已存在同进程 conversation map/handle，验证 lease ID/generation/key。不能把孙 Agent 的 Main 新 Task lease 挂回已 closed 结构 parent，也不建全树 lease registry。Task/Agent 和 OperationReceipt committed 同 journal 事务发布；child-owned confirm_task_commit event 同 commit 生成，应用证明后才 ACK，不能靠 tool response 说明 lease map 存在。

commit 前 abort 先 rescan 精确 journal/receipt：已 commit 不补偿、不重跑；确定无 commit 才 owner-aware releaseWithoutWake(cancelled)/artifact 清理。结果不确定保留 lease/prepare 并 fence，不自动 retry mutation 或 provider。release event/result 绑定 operation/caller/digest/task/key/sourceAgent/sourceGeneration，source-generation-gone 只能在原 generation 确已释放/消失时证明。明文 token/credential/prompt 不进 diagnostic；token cache 只是重放优化。

### 5. Execution 与 Scheduler 端口

HostRuntimePort 提供 residency、resumeAgent/closeAgent/drainControl、inputAccepted 和 Task/generation 精确 interrupt；Scheduler 负责 taskAdmitted/cancel 和 active grants，不能选择 outcome。runtime generation 与 native session ID 分离，同 session 恢复不复制 writer；close 收口与 cold recovery 也可递增 generation 以 fence 旧 writer，不等于实际请求或新 Task。默认 10 active Main/process、32 open Main，无 resident/LRU；waiting 保留 SDK/lease/deadline 释放 active。activation grant 和跨 Main 内层公平循环均复查 process cap，cancel 未 drain 不归还位。Process continuation 的正常排队不是 owner 失效，不能因等待超过 30 秒转 record-only；排队、watchdog 与 cancel 使用相同 Task/generation/lifecycle fence，取消后撤销待激活工作并收口 observer，晚到 grant 不得恢复已取消 Task。

正常 settle 只接受公开 agent_settled 对应 Task/generation；readNativeTerminalProofV1 在此提取真实 final/usage，不能用于 cold assistant-tail-only recovery。Finish/Interaction 声明先持久，之后 abort/settle 按 Delivery precedence。old generation late result/abort 不能修改下一 Task。

### 6. Delivery/application/ACK 端口

Host 生成 durable OwnerEvent，ChildEventProcessor 在同进程会话本地 append 冻结 card/mailbox、操作 lease/Wake 并回 application result；Host 验证 native/registry proof 并 journal commit 后返回 persisted，**再**ACK。ACK 丢失只补 ACK，已应用 result 丢失重放精确 result，不重做 lease release 或 Wake。eventId/sequence/payload hash/runtime generation/caller 是共同 fence，mutable runtime cache 不能代替 durable 记录。

Owner sequence 连续且不复用，pending 不含 generation，sent 绑定当代，acked/cancelled 为 terminal。cancelled 输入不参与 send/apply/ACK，连续 terminal 前缀推进 cursor，不能跨 pending/gap 或另 generation。每类 ACK completion 条件、chunk/budget、replacement 规则见 [投递合同 §14](delivery.md#14-同进程-ownerevent-application-与-ack)。不会因为删除 IPC 就把 ACK 改成“收到回调”。

Main active binding 用 Pi sendMessage 同步 TUI/native history，detached 旧 binding 拒绝 append；安全追加等待当前 tool batch 结束，immutable ID/digest 对账。non-current Main 只 pending，无 focus/模型权。Completion/Inbox/Outbox/Wake receipt 和 model turn settlement 为不同事实；关闭不会清 unread。

### 7. Main 结束与恢复

全部 session_shutdown 先 ending fence/撤销 append/view，再 force-close 旧树；quit 不重启 Main TUI。prepare/lease/assembly 完成后检查 ending，rollback 自身 artifacts/lease。cold reopen 在 writer lock 下 replay 完整 journal，unfinished current/queued 结算 interrupted/host-lost、关闭 ownerless Agent、取消旧 input；pending Completion 和控制交付仍对账，返回旧 Main 不自动 schedule。

Main append 已改用公开 mailbox/readonly session API，旧 appendCustomMessageEntry/getEntry/getEntries 三项 private probe 随直接追加路径退役；public SDK/ManagedInteractive 无新增 private seam。公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0，managed native thread UI 遵守 [界面合同 §5](ui.md#5-主题与终端释放) 的原版主题降级/补丁热更新合同；重建后用对应 host 的 fresh process 验证公开合同与适用 consumer probe；无法证明 binding/caller/native proof 则 fail closed，零静默降级。

### 8. Snapshot、查询与通知

Host snapshot 是同 Main 当前 revision 的 NormalizedStoreStateV1。list/UI 仅派生不可变 metadata；不得返回 mutable record 给模型或把 native history 复制成第二份 live transcript。binding_generation 递增只撤销旧 Main adapter 的调用权，runtime_generation 撤销旧 execution callback，manager_generation fence 用户确认，三者不可混用。subscribe 的 UI 定时/通知属于 presentation，每次读最新 snapshot，旧 timer dispose 后不得清 replacement status row。

native execution view 从现有 SDK runtime 取得 history；closed/unavailable history 用 in-memory SessionManager，不能同时开第二个原文件 writer。删 subtree 的受信用户确认携带目标 snapshot/revision。已完成但仍 open 的子树先走既有 close/drain；未收口保持 closing，不准 delete。关闭后重读 snapshot/revision 并复核确认范围，再校验无 unfinished Task/lease/delivery/OwnerEvent/prepare/cleanup，最后一笔 tombstone/cleanup intent，物理清理由持久 cleanup record 后续收口。delete 不隐式 force 未完成 Task，也不新增持久字段；Host 与 planner 同时拒绝未 closed 的子树，Host 还拒绝残留 SDK residency。取消事件是 terminal，不能当 pending 阻塞删除；未读可以明确确认删除，未交付权不能丢。

delivery-failed 当前处于隔离，公开 retry endpoint 尚未实现（Delivery §7.8），不能文档宣称 `/subagents` 可自动重试所有失败。operation timeout 或未知 commit 只保守 fence/rescan/query receipt；不能根据空 snapshot/response timeout 判失败后再发同业务模型请求。

## 能力与冻结执行配置

### 1. Authority 与显式 factory

公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0、唯一 SDK。capabilities/{closure,registry,fingerprint}.ts 和 runtime/factory-catalog.ts 定义准入。pi-runtime-contracts 拥有 versioned registry；Main package 注册 owner/target descriptor，Subagents 冻结 target=pi-subagents 的 closure，Side 直接解析 target=pi-side-chat。SDK factory 自身不注册 capability、不做 OS attestation；这层 SDK factory/provider 准入仍无 marker/nonce/ready handshake 前置。managed native thread UI 另有 [界面合同 §5](ui.md#5-主题与终端释放) 的 UI host-capability 检查；它只约束 handoff，不改变 provider grant、tool/model scope 或上述 attestation 边界。

registry conflict、target/package/export/hash 不匹配拒绝，不能扫描 Main extension paths 或复制未知 pure hooks。外部 provider 只通过已声明、独立批准的 `sdk_provider_factory` 装配，沿用实际 assembly 的 canonical 公开 Pi namespaces；loader 只 cache 模块/identity，不 cache instance/options。同路径代码或明确 delegates 变更要求 fresh process，不拿新磁盘 hash 给旧 Jiti cache 背书。

`pi-session-runtime/sdk-provider` 共用于查询、spawn 准入和执行。target 的纯数据声明定位实际 package.json、child、factory module/export/config/artifacts 与可选 observer；实际 agentDir 的 `sdk-provider-grants.json` 独立批准完整 owner/Main/target 身份。注册不授权，grant 与声明相同仍必须核验当前磁盘文件；查询不 import 工厂。provider ID 不再是品牌枚举，只有获批工厂可用，缺失或漂移拒绝、不悄换 provider。Core 固定传 `{version,target,agentDir,providerId,modelIds,config}`，config 不能覆盖核心参数。可选 observer 也须批准，只有声明 input 与已校验的 provider activity output；detach 不释放 execution，失败/dispose 释放。公开 provider 引用只作 cooperative replacement fence，不是 host-attested 来源证明或 OS sandbox。完整协议见 [sdk-providers.md](./sdk-providers.md)。

### 2. Tool closure

Main active tools、registered definitions 与 role allowlist 共同决定 child 工具。普通 read/bash/edit/find/grep/ls/write 保持同 public API。当前 builtin extension consumer 仅 codemode/tool-search 的 canonical factory，前端 `builtin:<owner>` 准入与后端受控装配一致，仍受 role/tools fences；未知 owner、定义漂移或不支持的公开合同拒绝，不以 ambient discovery 补齐。共享 Runtime 的通用显式 Builtin 接口默认全禁，其可选 MCP 能力不等于本 consumer 支持。未选中的 builtin 不启用，llama.cpp 不是工具，不启服务。role tools=*只选可证明 owner 的当前 active 工具，未知 SDK/未声明工具跳过并 diagnostic；显式列出不 active/undeclared 工具拒绝，不扩权。

当前 MCP owner 是 pi-mcp-adapter，不是 stock MCP。child 继承须由 adapter 自己明确能力声明/工厂，并通过独立集成验证，现在不宣称支持；不使用 native MCP 替代、不解析 stock MCP 配置或冻结 raw 凭据，也不增加配置 pinning。

mandatory collaboration tools 包含 send_input/wait/list/model/role 查询及允许 depth 的 spawn，child finish_task。close/resume 永远 Main-only；达到 ceiling 从 registered definitions、active tools、profile、fingerprint 与 prompt 同时去 spawn，Host 复核 persistent 结构 depth 和 min(frozen ceiling,current maxDepth)。默认 maxDepth 1，可配置 2，孙 Agent 始终不能再 spawn。

fingerprint 包含 canonical tool schema/description/promptGuidelines 及 owner、target hash 和完整 allowed tool 顺序/definition digest；dynamic ambient 插件新增不自动进入旧 Agent。未知/冲突 definition 不能靠同名工具替换。factory catalog 保留 Processes child、native-search、pi-bash-timeout、CC presentation 与经独立 grant 批准的外部 provider；非 builtin Search/Processes 的 `execution_factory` proof 必须覆盖实际 import 的物理 factory 文件及 export，直接读该文件做 SHA 校验，不能只校验转发 wrapper 后执行未校验文件；旧 frozen Pinned presentation 仅忽略、不加载，其它 Main 插件不复制。

`pi-bash-timeout` 是 source-only required-only tool owner，Main 的同名 `bash` override 归该 package；catalog 只接受匹配 owner/package、`extensions/child.ts`、target hash 和 `createBashTimeoutChildFactory` export。Main/child 共用同一个 definition factory，description/schema/promptGuidelines 指纹不匹配拒绝，不退回内置 bash；包未加载时 bash 仍归 builtin。本包只改 timeout 必填契约，child factory 不注册 capability 或读 ambient identity，执行仍用 child 的公开冻结 settings 和 Pi bash 实现。

### 3. FrozenProfileV1

profile.version 仍 1，store namespace 是 v2。持久字段包括 role{name,source,provenance,body,sha256}、provider/model/model_scope/reasoning_effort/service_tier?、task_timeout_ms/cwd/project_trusted、allowlisted 公开 settings_snapshot、delegation_max_depth、capabilities{version,fingerprint,active_tools,tool_definitions,entries}、prompt options/hash/assembler version/system-prompt path/bytes/hash 和 created_at。

builtin entry 使用 `builtin_proof={version,pi_version}`，核对 assembly 的 canonical Pi.VERSION；不对 builtin 标识做物理文件 SHA 读取。非 builtin Search/Processes 使用实际 `execution_factory` proof；旧 profile 仍可读历史，缺少对应 proof 不执行，不从当前环境自动补齐。

role 优先 trusted project > user > builtin，model/effort/tier 解析与范围见 [工具合同](usage.md)；child scope 只能是父 scope 子集，nested artifact/profile 重新复核 cwd/trust/model/tool/entry owner subset。model scope 冻结为授权 canonical IDs，credentials 通过 public ModelRuntime/Auth，不持久 secret。provider proof 包含完整批准 manifest 与确切 model_scope，并进入 fingerprint；nested 只能缩窄，旧无 proof 的外部 provider profile 只读历史，不自动补授权执行。

Pi 1.5 公开 before_agent_start.systemPromptOptions/builder，创建先解析公开 options 与 role instruction 再冻结 rendered prompt 和 system-prompt.txt，不在 resume 重跑 mutable Main hook；role/package/auth drift 不能静默扩权限。role 有变化不改已创建 Agent，必要时 spawn 新 identity。

### 4. SDK assembly、resume 与压缩

execution 使用 public services/session runtime，独立 SettingsManager.inMemory/ModelRuntime/resource loader/SessionManager，no ambient extensions/skills/context/templates/themes，只显式 execution factory。profile.settings_snapshot 深拷贝，每次按冻结 model 当前 window 重算 native compaction；不缓存新 Main mutable settings 作为旧 Agent authority。Main 默认配置与 env 不被改写。

resume 核对 frozen artifact/hash/model/credential/factory，只恢复目标 idle，零 Task/lease/provider/compact。超窗 preflight 必须在真实 Task grant 后，无法安全 summarize 拒绝并推荐 none；用户打开 closed history 可以用 provider-only/presentation 和 tools=[]的 in-memory runtime，不允许 fallback model 执行旧 Agent。

CC execution assembly 安装轻 recorder，Detached 仍写真实 run metrics；UI 每 view attach/detach。CC 只接受 `dist/child.ts` 与空 tools/providers/commands 的纯 presentation descriptor，不注册 builtin execution；标准 Main profile 显式选择七个内置工具。CC presentation 可选；有合法能力时装配其显式 factory，缺席时使用 Pi 原生消息渲染，输入、历史与生命周期不变。Main completion append 只用公开 branch API 与 mailbox，没有旧三项 private seam；Side 两 visibility probe 属于 Side，不当 SDK 能力 attestation。

assembly、approved factories、managed view 共用 `getSessionAssemblyPublicModules()` 的进程级 immutable Pi coding-agent/ai/tui 表；同版本不同 physical copy 不能当作同一 class identity。同一 factory 路径切 realm 在 import/cache 前拒绝，readonly history 也用 canonical SDK 创建。TerminalOwner 在 acquire 首次使用时保存并恢复 canonical TUI 的原始 keybindings 引用，await 后重验取消与 lease。协议与双 loader 回归见 [session-runtime](../../pi-session-runtime/README.md)。

### 5. Persistence 与验证

profile/工具/factory snapshot 是 admission proof，prepare/native artifact/hash 与 Task owner/lease proof 在 Host 事务验证；closed 不清持久权限。generation 是 Host runtime fence，不是 OS PID。正常 SDK agent_settled 才读 native result/usage；cold owner loss 不能从 tail 证明成功。

验证包括 codemode/tool-search canonical factory 前后端一致装配、role/tools fences、Pi.VERSION 与 builtin_proof 匹配、其他 builtin 默认禁用且 llama.cpp 不启服务、adapter MCP 无声明时不继承、非 builtin Search/Processes 实际 execution_factory 文件漂移在 import 前拒绝、closure/wildcard 与 explicit unknown、source canonical identity、schema hash/conflict、scope 缩窄、maxDepth 1/2 完整去 spawn、model/effort/tier/credential drift、resume 零请求、native compaction、真实 CC/Processes/Search/Timeout 装配与中性外部 provider factory；缺 grant、实际执行文件/observer/delegate drift、target 混用、await 撤销和 code-cache fence 必须在 import/request 前拒绝。public Pi API 由 typecheck/行为 test，CC 的独立 private catalog 与 Side 两项 probe 使用 stock Pi 1.5；faux 不证明真实 cache/provider 质量，见 [维护与测试](maintenance.md)。

## 有效 Context Fork 契约

目标 Pi 1.5.0 的 `spawn_agent.fork_turns` 接受 `none`、`all` 与 canonical 正整数 `1..100000`，省略为 `none`。选择与 seed 的 owner 是共享 source-only 库 [`pi-session-runtime`](../../pi-session-runtime/README.md)。Subagents 负责冻结权限、创建 boundary、session 生命周期与失败映射，不再维护 raw entry rebaser。

### 1. 真实请求 capture

Main 在公开 `context_with_system` 边界记录 candidate：session/generation、leaf、model/effort、active tool/capability 指纹、native provenance 与 run signal。library 用 SessionManager object identity 租用 generation；public provider `streamSimple` wrapper 只复制 normalized messages 与允许的 metadata，原 receiver/options/stream 保持不变。

仅包装 provider 被调用不等于 Main request。capture 还要在 `before_provider_request` / `after_provider_response` 确认同一 session、signal、async invocation、candidate 和 revision；direct summary 或复用相同 transcript 的调用不能消费 Main candidate。provider 不发 native callback、不可装饰或归属不明时 capture unavailable，不解析 provider payload 来冒充证明。

capture 是 Main 最近一次实际发出的 context，不是当前 Magic DB。状态只存内存，`Symbol.for("pi.session-runtime.effective-context.v1")` 使 bundled consumers 共用 owner；引用计数最后 release 清理 observation/capture，Main shutdown/reload retire generation，stale release 不影响 replacement。

### 2. 有效来源与失效

有效 capture 必须仍属于当前 session/generation、active branch，且 selected/physical model（可用时）、effort、tool/capability 指纹一致。capture leaf 后的 compaction/context_edit/branch_summary 等 projection reset 使其失效；只有新增 native tail 才可追加。

Magic 的 public tool/command sourceInfo provenance 或当前 branch 的 `compaction.details.source === "magic-context"` 要求有效 capture。未知 transformer state 同样不能 raw fallback；absence of marker 不证明 native-only。只有当前 capture 已明确证明 native-only 才可用公开 `buildSessionProjection` fallback，其 `exactRequestPrefix` 为 false。结构不匹配的 capture 必须先失效，不能借另一 branch 的证据授权 fallback。

`magic-context:context-epoch` 补丁已撤回，没有订阅。后台 historian/DB 更新不使同一轮 todowrite 后的 spawn 失效；从 Main 最近一次实际请求 fork 不会恢复比 Main 更早的未压缩历史。library 不读 Magic 私有 DB。

### 3. 选择规则

- `none`：无需 capture，不继承 parent history。
- `all`：有效 normalized request，加 capture leaf 后可安全追加的 native tail；绝不复制 append-only file 的所有历史或 abandoned branch。
- `N`：在有效内容内选择最近 N 个可可靠映射的完整 business turn。user、bash/custom input、branch summary 可起 turn；compaction 不计 turn。N 大于可用 turn 时只取有效来源内的全部 turn，不从 raw history 补回被压缩的消息。

numeric mapping 使用精确 provenance。只有明确的 system/compaction/memory preamble 可跨未选 turn 保留；普通 custom/bash text 不是全局 preamble，attached body 跟随所属 turn。未知 request-only custom injection 或含糊 user rewrite 使 N unavailable，all 仍可能可用。

Magic Context 0.41.1 的已知改写可用于身份匹配：只有识别到领先、未加 tag 的 m[0]/m[1] user pair，其有序 block vocabulary、content shape 和相对 body timestamp 均符合 producer 格式时，才识别 text block 上单个 canonical `§N§ ` prefix 和首 text block 上单个 temporal comment。去除这些已知附加项只用于比对，剩余完整消息（含 timestamp、images、metadata）必须按顺序匹配唯一 native origin；不同 timestamp 的重复正文可以区分，完全相同身份或跨 turn/preamble/body 的多候选拒绝 N。pair 作为 memory preamble 连同 system/native summary 原文保留，包括 folded history 与 memory updates；seed 不删标记、不恢复压掉的原文。

MC 会先删除已有 tag notation，再加新 tag，因此存在 MC envelope 时，任何 native user-shaped text block 以 `§` 加数字开头都保守拒绝 N，覆盖 well-formed、malformed、dangling 标签，以及继承 seed 中的已有标签；不区分 turn/preamble/body。没有 MC pair 时 literal 输入仍按 native exact identity 映射。未知 envelope/block、改文/metadata、重复 tag、未知 temporal 格式、origin/envelope 碰撞，以及首次 materialization 尚未被 compaction marker 消除的 dropped-user sentinel 同样拒绝 N。不能用 tag 序号猜身份；native 标签前缀触发有损映射拒绝时，仅保留 system 分类，不发布 turn/body/user-preamble 隐藏 provenance。有效 capture 下 `all` 的消息仍原样保留。

选择截到最大可 replay prefix：不继承 pending assistant 或未闭合 tool batch；duplicate/mismatched/unknown tool result、重复 toolCallId 在整个坏 batch 之前截断。完整 tool-call/result 配对不要求 result 顺序一致。不会为了更新 snapshot 等待或 abort Main。

native fallback 先走 Pi public projection，materialize repeated/self-retaining compaction 与 context edit，再选择稳定 prefix。source branch 的 malformed chain、dangling compaction/edit reference 或失效 capture 会拒绝。`EffectiveContextUnavailableError` 带 `code="effective-context-unavailable"` 与 machine-readable reason，提示为 `effective-context-unavailable: <reason>; use fork_turns=none.`。不静默换 raw 来源，也不无条件建议完成另一轮 Main；新 turn 不能修复未知格式或非单射身份。

### 4. Fresh native seed

`buildNativeChildSnapshot({ selection, cwd, model, boundary })` 接收完整 `EffectiveContextSelection`，输出 fresh native session JSONL 与 `inheritedEntryIds`。ID/parent chain 新分配，assistant thinking/signatures、toolCallId、usage、images 与 nestedCalls 保留。旧 compaction/edit 已投影，不复制会重新暴露 raw body 的 checkpoint/reference structure。

第一个隐藏 custom entry 是 `pi-session-runtime-provenance-v1`：`{version:1, entries: Record<freshEntryId, "turn"|"preamble"|"body"|"unknown">}`。它让 reopen/capture 与再次 numeric fork 恢复继承内容的真实归属，不根据摘要文字猜测；boundary 标为 body。native compaction 可正常丢弃这些消息。

Subagents 随后追加 `pi-subagents-creation-boundary-v1`，说明继承内容只作参考、委派 task 才是当前工作，并追加冻结 model/effort。Goal/Todo/Skills sidecar 等 owner state 不自动继承 authority；权限与 tool/profile policy 仍由 Host 冻结，fork 只改变 context。

### 4.1 SDK 原生压缩与前缀预检

SDK child 使用隔离内存 settings，compaction 固定 enabled；reserveTokens=min(16,384, floor(contextWindow/8))，keepRecentTokens=min(20,000, floor(contextWindow/16))，同时覆盖所选模型的 override。Main 设置不变。普通 settings 保存为 profile.settings_snapshot 的 allowlisted 公开快照，execution 深拷贝并从冻结模型当前 catalog 重算预算；不再有 per-Agent settings cache。resume 只装 idle，零 provider/compact；只有实际 Task grant 后才 preflight。

继承 seed 先用 Pi native estimate + system prompt 文本预算预检；接近阈值时能容纳 summary 输入才先原生压缩，已超过安全 summary 输入窗口则拒绝并要求 fork_turns=none。不是 provider 精确 tokenizer 或跨模型 signed reasoning/cache-hit 保证。Task usage 包含原生 compaction summary 与等待前后各轮。

### 5. 加载与验证边界

轻量 fork grammar inline 到 cold schema/parser；provider capture 的重模块与 selection/seed 在首次有效请求/实际 fork 按需加载。空 Main 会话不创建 service/store/SDK session。Subagents 和 Side 默认且唯一 SDK；Side/BTW 使用 capture/selection/seed，Side 另消费共享 native view，native-record fallback 仍每次打开显式接受。Session Compact 新增 public capture/select consumer，前缀不可靠/完整材料超窗转 small，不新增 privatecapture。共享库通过 workspace 依赖解析；faux 测试不证明真实 provider/cache、人工 TUI 或规模性能。旧存储不读、不转换、不删除。

核心验证在 `local/pi-session-runtime` 的 `npm run check`：fork matrix、stable prefix、fresh seed roundtrip、capture ownership/fence/invalidation、nested provenance，以及真实 public Pi SDK/faux provider 的 Main/native-callback negative controls。Subagents 的 typecheck/build/verify-dist 与 context contract tests 验证接线；这些不证明 remote cache hit 或实际 Magic DB 行为。

Magic Context 相关逻辑仅保留已捕获旧格式的兼容解码，当前共享库测试覆盖 legacy tags、temporal/preamble、多段文本/图片及有歧义的历史映射拒绝。不加载 Magic Context producer、配置或数据库。共享库升级运行 `npm run check -w pi-session-runtime`（仓库根），不能据 hash、静态 fixture 或 faux 结果声称覆盖真实 DB/pipeline。

## 信任与故障边界

### 1. 同进程信任

公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0、唯一 SDK；managed native thread UI 的原版主题降级与补丁热更新遵守 [界面合同 §5](ui.md#5-主题与终端释放) 的显式 host patch/UI capability，不构成 tools/model/provider 授权或 OS 隔离。Main、Side、Subagents 和 approved factory 同 JSprocess，共享 filesystem/network/credentials。frozen tool/model/role/ctx policy 减少误用但不构成 sandbox，任何 trustedextension 都能使用 process 权限。没有 socket/fd/nonce/env 构造的安全隔离、Agent process group 或 Supervisor hard kill；任意不响应 JS 工具只能 abort/fence，仍执行就 closing，不能声称已回收。

不自动 worktree/写锁，同 workspace 并发 read/edit/bash/Process 会 race；用户要协调文件所有权，package 不能隐式扩展外部 authority。Subagentprefix/taskpath 是领域身份，不是可执行路径。PI_SUBAGENTS_BACKEND 被彻底拒绝，不接受旧 marker 恢复权限。

### 2. 权限冻结与 caller

HostCaller 只由实际 Main/child/UI/recovery adapter 构造，模型 schema 不含 kind/generation/session 身份。Host 复核 binding/manager/runtime、Task ID、lifecycle/revision 与 Main owner；child 只操作直接 child 且 close/resume 仅 Main/可信用户。maxDepth 默认 1/max2，注册/active tools/profile/fingerprint/prompt/Host 全部执行 ceiling；不能通过手工 tool name 或伪 depth 越层。

创建冻结 role body/provenance/hash、model scope/model/effort/tier、cwd/trust/settings snapshot/delegation ceiling、tools/definition/approved factory hash；resume 不能读取变更 role 扩权、用 fallback model 执行或复制未知 Main plugin。public namespaces/factory module cache 不共享 runtime instance/options，provider auth 只在公开 ModelRuntime 解析，不持久 secret。closed history 仅 in-memory read view/空 tool，不自动 resume/模型请求。当前 builtin consumer 仅 codemode/tool-search canonical factory，前端/后端一致且受 role/tools fences；`builtin_proof={version,pi_version}` 核对 canonical Pi.VERSION，不对 builtin 标识做物理文件 SHA 读取。其他 builtin 默认不启用，llama.cpp 非工具、不启服务；未知 owner 拒绝而非扫描 ambient paths。非 builtin Search/Processes 的 `execution_factory` proof 才直接读取实际物理 factory 文件做 SHA 校验，wrapper hash 不证明未校验文件可信；旧 profile 可读历史，缺 proof 不执行。

当前 MCP 来自 pi-mcp-adapter；child 继承需 adapter 自己明确能力声明/工厂及后续独立验收，现在不宣称支持。不以 stock MCP 替代，不解析其配置、冻结 raw 凭据或增加配置 pinning。共享 Runtime 通用显式 Builtin 接口仍默认全禁，保留的可选 MCP 支持不授权本 consumer。

### 3. 持久性与路径

agent-dir 走公开 Pi API/PI_CODING_AGENT_DIR。store-v2 只读自身 closed-layout、same UID、no-follow 目录/文件，directory0700/file0600，单 writer lock、canonical JSON/digest/CRC/journal 连续 revision 保护 metadata authority；symlink/malformed/identity 不明保 bytes 并 degraded/unavailable，不能猜损坏或覆盖。native JSONL 和 journal 独立提交域，ID/hash proof 对账才能认 append，不从 text 猜成功。

prepare token 仅 live 内存，磁盘 hash 不授 commit 或 lease authority；before commit frozen artifacts 和 owner lease 完整验证，uncertain commit 保留 prepare/lease 并 fence，不能静默 retry。log 只 bounded code/correlation/health，不记 prompt、正文、tool args/results、credential、token 或完整 private path。旧存储不读、不转换、不删除。

### 4. 生命周期与取消

close 先持久 closing/取消 current/queue/input/barrier，再 leaf abort/public idle/control release/ACK/dispose，才 closed；JS 仍跑不释放 active/open。Task input/event 取消 terminalize 保 sequence/cursor，old generation callback 不能写下一 Task 或 resume 重放；late Process continuation 校验 owner token，确已失效/取消才 record-only；合法 active 位排队超过 30 秒不等于失效。watchdog/cancel 与同 Task/generation/lifecycle 收口，取消后不能由迟到 signal/grant 恢复工作。Main 所有 shutdown ending fence、撤销 append/view 权，再强关旧树；回旧 Main closed 不自动开工。

已完成 open 子树先 close/drain 再 delete；未 drain、投递债未退休或 revision 不符时拒绝，delete 不隐式 force 未完工作。forced queued Task 无 provider/usage0，已有 settled outcome 不可改；Completion/lease/Inbox/Outbox 需要继续收口，关闭不抹 unread 或 pending delivery。Main hard exit 后 cold recovery 以 host-lost 中断 unfinished/关闭 ownerless，不能 assistant tail 或 PID absence 推 success。

### 5. 投递与界面

Completion/body/XML/schema 均 bounded，unknown/malformed 消息降级 inert 文本，contradictory ID/hash 拒绝；tool call/result 未闭合不插普通 custom message。application 先 native/registry proof 再 journal persisted 再 ACK，transport 回调不当 proof；same ID 重放原 result，ACK 失败不再 release/Wake。Wake 每 epoch 唯一 owner 但特定 crash window 可 later 重复，逻辑幂等不宣传物理 exactly-once。

单前台 TerminalOwner/owner 引用 release，process listener 只删除 child public reference 差集，不动 Main；命名 theme 限制/return 恢复见 [界面合同](ui.md)。已读通过精确 Inbox receipt，onLoaded 自产活动标记与点击卡片是当前协调规则，不能以 render/scroll 或未挂载 CC panel 猜用户看到。

### 6. 非目标与验证

无恶意同 OS user/extension 隔离、OS 资源硬上限、hard kill JS 或跨 workspace 写事务。测试覆盖 caller 伪造/stale generation/depth/scope、artifact symlink/hash、prepared fault/lease 补偿、取消 input/recovery、foreground lease/listener 和 Wake proof；真实 provider/cache/IME/physical terminal、规模 heap/FD 自然释放独立验收，不用 faux 数据抵扣。

### 惰性启动与 SDK reload

Main 首帧同步注册 schema、命令、renderer 和隐藏 strip；manager/view/service graph 首次操作才 dynamic import，verify-dist 检查边界。空 Main 不建 store/execution owner，首次业务共享 ready 链；已有 durable Main 在 session_start 完整恢复。初始化失败拒绝操作、之后可重试；session replacement/quit 等待并退役未完初始化。

直接 child SDK session.reload() 只允许真正 quiescent execution：没有非终态 Task（含 queued/waiting）、持有 lease、未完成 OwnerEvent、Wake/proof 或控制。检查与 reload 共用 Host admission 边界，期间拒新 Task。拒绝发生在旧 session_shutdown 前，保留 Task/generation/binding/lease，提示先结算任务/投递。子视图 /reload 不在白名单，不支持活动 child 无损跨 binding reload。

获准 reload 原生失败后 execution 标不可用，拒 Task/send_input/follow-up/owner admission，也不再次尝试 reload；提示 close_agent 后 resume_agent 建新 idle execution，再另发输入。已有终态/receipt 不变，不自动重试工作。

Task settle 与 Main reconcile 按 Outbox ID 共用整轮投递所有权，从 card append 覆盖 settleWake/retryOpenWake/settlePendingWake 返回或抛错。争用只 deferred，不报故障；新旧 binding 共表，replacement 不提前释放，finally 释放，失败按持久状态在下个边界重试。

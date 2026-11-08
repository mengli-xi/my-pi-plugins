# pi-subagents · Host API

这是 package 私有、同进程 SDK 的领域 authority。public 模型 grammar 见 TOOL_CONTRACT；durable schema 见 PERSISTENCE_FORMAT，delivery/application/ACK 见 DELIVERY_PROTOCOL。旧 Supervisor/Owner IPC 中有效的 prepare/commit、Task lease、generation、幂等 result 和 ACK 约束已迁入本文及 Delivery；不再定义 OS transport、nonce、fd、launch descriptor 或 PTY handshake。

## 1. 权限与可信 caller

AgentHostCoreV1 由 process service 按 Main session 绑定，writer lock/journal 是 metadata authority。HostCall 包含 request_id、caller、可选 expected_host_revision；模型只能给 public input，adapter 生成 caller，不能接受模型传 user/recovery 身份。

| caller | 可信身份/fence |
|---|---|
| main-model | main conversation/session_id + binding_generation |
| agent-model | agent conversation/session_id/agent_id + runtime_generation + owner_request_id |
| user | main_session_id + binding_generation + manager_generation，由实际 UI 构造 |
| recovery | main_session_id + recovery_generation，仅 store/service 恢复路径 |

解析 target 只在同 Main；Main/user 可给任意后代新工作，agent-model send/wait 限制直接后代，spawn 只创建直接 child；close/resume 仅 Main-model/user。Host 复核结构 parent chain、当前 maxDepth 和 frozen delegation ceiling，不相信缓存 depth 或工具是否隐藏。list 可看当前 Main 有界 metadata，不返回 history/prompt/secret。fork/clone 不转移原 tree ownership。

HostResult={ok:true,host_revision,value}|{ok:false,host_revision,error:{version:1,code,message,retryable,correlation_id?,current_host_revision}}。错误不能部分成功。expected revision 用于受信 UI 确认，stale confirmation 重做，不静默按旧 snapshot 执行。

## 2. 当前操作端口

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

## 3. 输入、生命周期与 receipt

sendInput 当前/selected head 存在且 interrupt=false：先持久 task-scoped Mailbox ID/body hash/source/sequence 和 operation receipt；waiting 设置 activation_order，保留 Task/owner/deadline/barrier/Process wait。finishWaitingActivation 携带该 grant 捕获的 expectedActivationOrder，仅匹配时清除；若期间已有较新的 order，不写回旧状态，继续由原 flush/准入链处理。idle 或 interrupt=true 建立新 Task，initiator 和 owner_conversation 取可信 caller；Main/user 归 Main，child-origin 归 child。replacement 优先，原 head 未启动也必须有 interrupted Completion/usage0，其余 FIFO 保留。

SdkRuntimeControllerV1.admitViewInput(agentId,caller,text,intent=immediate,requestId?)映射 Enter/Alt 意图。普通 Enter 不是 native followUp。稳定 ID 重试返回同结果，成功才清 draft；input 与 settle 串行，apply/send/native proof 前复核 Task/lifecycle/generation，取消 OwnerEvent/Mailbox 保持 terminal，resume 不能把旧输入放到新 Task。

resume 串行检查 open count 及 closing 祖先，只装配目标 idle；成功才 commit open，失败释放 Host queue 后 dispose，防止清理重入死锁。close 先事务冻结整结构子树、取消 pending input/barrier 和 current/queued，再从叶节点处理 abort→public idle/prompt→control delivery/lease ACK→dispose→closed。3 秒未收口返回 closing/cleanup_pending，容量保持，不改 settled outcome。重复 closed 根仍包含后来 resume 的后代；closing 子树拒绝恢复后代。

## 4. Prepare/commit/abort（从旧 Owner 合同保留）

所有 mutation 先分配 transactionId、写 sync 的 prepared record 和 artifact hashes。local admission 包含 structural_parent 和**独立 lease_owner**；intent.session_id 必须等于 lease_owner.session_id，logical_lease_key 恒等 reserved_task_id。Agent 结构 parent 不因 Main/user 的新 Task owner 改变。

child-local nested spawn 先捕获其公开 effective context 和 frozen capabilities，给 Host 提供 private artifacts；Host 校验 cwd/trust/model scope/tool definition/owner subset 及 artifact digests。不是任意文件路径/argv。内部 prepareOwnerTask/commitOwnerTask/acquireTaskLease/abortPreparedTask/collaborate/finish 通过同进程 ChildToolPort，不经 IPC。

prepared 阶段预留 opaque IDs/path/public result/digest；未 commit 不能 target/list/schedule 或对模型称成功。初始 base/proposed revision 只描述 snapshot，不预留未来 journal revision。最终在 writer queue 下加载 current revision，复核 binding/runtime/ending、name/parent/open/task/storage capacity、profile/artifacts 与 target，再 current+1 commit；中间异步 capture/lease/assembly 结束都再检查 ending。Main 结束先 fence，再串行枚举旧树，异步准入不能越界 commit。

child-owned prepare 保留 30 秒 TTL/明文 token 只在 live 内存、磁盘只有 hash、caller/runtime generation、operation digest、reserved ID、lease owner、冻结 public result 和 phase。阶段 prepared→lease-proved→commit-requested 都原子 sync；token 不是 lease 证明，重启不再生，查询已 commit receipt 返回冻结 public result，矛盾 ID/digest 拒绝。内部 followup kind 是历史领域名，不是 public tool。

获取 live blocking lease 必须在**Task owner 会话**，ownerId=pi-subagents/logicalKey=原 Task ID。Main-owned 本地 registry；child-owned 用已存在同进程 conversation map/handle，验证 lease ID/generation/key。不能把孙 Agent 的 Main 新 Task lease 挂回已 closed 结构 parent，也不建全树 lease registry。Task/Agent 和 OperationReceipt committed 同 journal 事务发布；child-owned confirm_task_commit event 同 commit 生成，应用证明后才 ACK，不能靠 tool response 说明 lease map 存在。

commit 前 abort 先 rescan 精确 journal/receipt：已 commit 不补偿、不重跑；确定无 commit 才 owner-aware releaseWithoutWake(cancelled)/artifact 清理。结果不确定保留 lease/prepare 并 fence，不自动 retry mutation 或 provider。release event/result 绑定 operation/caller/digest/task/key/sourceAgent/sourceGeneration，source-generation-gone 只能在原 generation 确已释放/消失时证明。明文 token/credential/prompt 不进 diagnostic；token cache 只是重放优化。

## 5. Execution 与 Scheduler 端口

HostRuntimePort 提供 residency、resumeAgent/closeAgent/drainControl、inputAccepted 和 Task/generation 精确 interrupt；Scheduler 负责 taskAdmitted/cancel 和 active grants，不能选择 outcome。runtime generation 与 native session ID 分离，同 session 恢复不复制 writer；close 收口与 cold recovery 也可递增 generation 以 fence 旧 writer，不等于实际请求或新 Task。默认 10 active Main/process、32 open Main，无 resident/LRU；waiting 保留 SDK/lease/deadline 释放 active。activation grant 和跨 Main 内层公平循环均复查 process cap，cancel 未 drain 不归还位。Process continuation 的正常排队不是 owner 失效，不能因等待超过 30 秒转 record-only；排队、watchdog 与 cancel 使用相同 Task/generation/lifecycle fence，取消后撤销待激活工作并收口 observer，晚到 grant 不得恢复已取消 Task。

正常 settle 只接受公开 agent_settled 对应 Task/generation；readNativeTerminalProofV1 在此提取真实 final/usage，不能用于 cold assistant-tail-only recovery。Finish/Interaction 声明先持久，之后 abort/settle 按 Delivery precedence。old generation late result/abort 不能修改下一 Task。

## 6. Delivery/application/ACK 端口

Host 生成 durable OwnerEvent，ChildEventProcessor 在同进程会话本地 append 冻结 card/mailbox、操作 lease/Wake 并回 application result；Host 验证 native/registry proof 并 journal commit 后返回 persisted，**再**ACK。ACK 丢失只补 ACK，已应用 result 丢失重放精确 result，不重做 lease release 或 Wake。eventId/sequence/payload hash/runtime generation/caller 是共同 fence，mutable runtime cache 不能代替 durable 记录。

Owner sequence 连续且不复用，pending 不含 generation，sent 绑定当代，acked/cancelled 为 terminal。cancelled 输入不参与 send/apply/ACK，连续 terminal 前缀推进 cursor，不能跨 pending/gap 或另 generation。每类 ACK completion 条件、chunk/budget、replacement 规则已迁入 Delivery §14。不会因为删除 IPC 就把 ACK 改成“收到回调”。

Main active binding 用 Pi sendMessage 同步 TUI/native history，detached 旧 binding 拒绝 append；安全追加等待当前 tool batch 结束，immutable ID/digest 对账。non-current Main 只 pending，无 focus/模型权。Completion/Inbox/Outbox/Wake receipt 和 model turn settlement 为不同事实；关闭不会清 unread。

## 7. Main 结束与恢复

全部 session_shutdown 先 ending fence/撤销 append/view，再 force-close 旧树；quit 不重启 Main TUI。prepare/lease/assembly 完成后检查 ending，rollback 自身 artifacts/lease。cold reopen 在 writer lock 下 replay 完整 journal，unfinished current/queued 结算 interrupted/host-lost、关闭 ownerless Agent、取消旧 input；pending Completion 和控制交付仍对账，返回旧 Main 不自动 schedule。

Main append 已改用公开 mailbox/readonly session API，旧 appendCustomMessageEntry/getEntry/getEntries 三项 private probe 随直接追加路径退役；public SDK/ManagedInteractive 无新增 private seam。公开 Pi API 与 stock Core 支持目标仍为 Pi 1.5.0，managed native thread UI 另需 [UI_SPEC §5](./UI_SPEC.md#5-主题与终端释放) 的显式 host patch/UI capability；重建后用对应 host 的 fresh process 验证公开合同与适用 consumer probe；无法证明 binding/caller/native proof 则 fail closed，零静默降级。

## 8. Snapshot、查询与通知

Host snapshot 是同 Main 当前 revision 的 NormalizedStoreStateV1。list/UI 仅派生不可变 metadata；不得返回 mutable record 给模型或把 native history 复制成第二份 live transcript。binding_generation 递增只撤销旧 Main adapter 的调用权，runtime_generation 撤销旧 execution callback，manager_generation fence 用户确认，三者不可混用。subscribe 的 UI 定时/通知属于 presentation，每次读最新 snapshot，旧 timer dispose 后不得清 replacement status row。

native execution view 从现有 SDK runtime 取得 history；closed/unavailable history 用 in-memory SessionManager，不能同时开第二个原文件 writer。删 subtree 的受信用户确认携带目标 snapshot/revision。已完成但仍 open 的子树先走既有 close/drain；未收口保持 closing，不准 delete。关闭后重读 snapshot/revision 并复核确认范围，再校验无 unfinished Task/lease/delivery/OwnerEvent/prepare/cleanup，最后一笔 tombstone/cleanup intent，物理清理由持久 cleanup record 后续收口。delete 不隐式 force 未完成 Task，也不新增持久字段；Host 与 planner 同时拒绝未 closed 的子树，Host 还拒绝残留 SDK residency。取消事件是 terminal，不能当 pending 阻塞删除；未读可以明确确认删除，未交付权不能丢。

delivery-failed 当前处于隔离，公开 retry endpoint 尚未实现（Delivery §7.8），不能文档宣称 `/subagents` 可自动重试所有失败。operation timeout 或未知 commit 只保守 fence/rescan/query receipt；不能根据空 snapshot/response timeout 判失败后再发同业务模型请求。

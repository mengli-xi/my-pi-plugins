# pi-subagents · 同进程运行模型

## 1. 三种独立状态

Agent 持久 identity/profile/history，lifecycle=open|closing|closed；Task 是 durable 工作、phase=admitted|starting|running|waiting|settled；SDK execution 是易失 runtime generation。view 是每次进入创建的 native InteractiveMode，普通离开仅销毁 view，不结束 Task 或 execution。没有 Pi child process、Supervisor、PTY screen/attach、backend chooser 或 LRU。

open idle 仍占 open 名额。Task 完成不关闭 Agent。closing 先 fence 工作、保持清理权与容量，直到所有执行/控制 drain 才 closed；closed 历史可用，无模型工作。resume 串行只恢复目标 idle execution 并递增 generation，native session ID/frozen profile 不变，零 Task/lease/provider/compact。

## 2. 准入与调度

Host mutation queue 负责 target/caller/revision、Task owner、capacity、prepare/commit/receipt；Scheduler 只授予 execution 位，不能改 Task 结果。default activeTasksPerMain=10、activeTasksPerProcess=10、openAgentsPerMain=32；open 含 closing/queued，closed 排除，prepared spawn 的有效 reservation 计入准入。storage quotas 独立。

Main 内按 admission/activation order FIFO，跨 Main 公平轮转，每次内层 grant 复查 global cap；收紧配置不强关现存工作。waiting 保留 SDK/current Task/lease/deadline 但释放 active 位，依赖/用户输入只申请 active activation，满位继续排队。输入轮结束依赖未满足回 waiting；同时到达的满足信号合并，不重复恢复。Process continuation 正常等 active 位不能因 30 秒转 record-only；watchdog 不替代 Task deadline，cancel/close/timeout 撤销同 Task/generation 的待激活工作，晚到信号/grant 不得开工。starting 正常 active assembly 期间 Alt+Enter 可以 durable 接 FIFO 新 Task，匹配 current Task/generation 后不误报 historical model-unavailable；running/starting/tool/compact 普通输入绑定原 Task，队列 head 在启动前同样可绑定；settle 与 input 不交叉写下一 Task。

取消 current 先持久 intent 及 input 取消，等待 abort/prompt/public idle/control drain；不能在 JS 仍执行时释放 active 位。queued 未启动 Task 结算 usage0、无 started_at/deadline。Task replacement 优先，其余 FIFO 保留。没有 idle retention 或 resident 预算；close 是唯一生命周期回收入口。

## 3. 装配与 generation

空 Main 仅加载工具/schema/grammar，不创建 service/store/session。首次工作才 import process-service/store/SDK assembly；进程级 service 管理同 process Main scopes，非 daemon。public createAgentSessionServices/createAgentSessionFromServices/AgentSessionRuntime 装配独立 SessionManager、ModelRuntime、SettingsManager.inMemory/resource loader 和 scope；不改 process cwd/env、不扫描 ambient 插件。

profile 持久 allowlisted settings_snapshot 和 delegation_max_depth。每次 execution 从 snapshot 深拷贝并应用冻结 model/effort 及 native compaction 预算；无 per-Agent settings cache。role/prompt/artifact 不能 resume 再生成；catalog/credential drift 拒绝执行。resume 过大历史也不 compact，真正 Task grant 后才 preflight。

generation 由 Host 的 Agent.runtime_generation 管理，新装配、close 收口或 cold recovery retire 旧 generation 时增长，所有 callback/input/application/stop 都以 Task ID/generation/lifecycle 复核。失去 owner 的异步装配由同 cleanup Promise dispose，失败 resume 在释放 Host queue 后清理避免 self-drain 死锁。旧 generation 的 late abort/result 不碰下一 Task。

## 4. 生命周期与 Main 结束

close 先在一笔事务冻结整棵结构子树 closing、取消 current/queue/mailbox input/barrier；再从叶节点 abort/drain、每 Task 一 Completion、owner lease/Inbox/Outbox/ACK、dispose，最后 closed_at/close_reason/lifecycle_revision。3 秒未收口返回 cleanup_pending，仍 closing，继续等可合作释放；不能硬 kill JS 或改已有 settled outcome。closing 祖先禁止 resume 后代；closed 祖先下的目标可独立 resume。

已完成 open 子树的删除先沿上述 close/drain 收口，再重读 snapshot/revision 校验 delete 条件；closing 不得删除，未完成工作不隐式 force。close 保留 history，delete 是另一步持久操作。

Main 所有 session_shutdown 都先 ending fence、detach 旧 append/view 权限，Host 串行枚举整树 force-close。async prepare/lease/assembly 完成前后都再检查 ending，失败用现有 rollback 释放 artifacts/lease。quit close view 不重启 Main TUI；new/resume/switch/fork/clone/reload 恢复终端后关旧树。回原 Main 只读 closed history，显式 resume 才恢复。

cold reopen 在 writer lock 内 replay 完整 journal，ownerless current/queued 工作按正常事务结算 interrupted/host-lost 并关闭 Agent/取消 input，Completion 不重复；pending accepted delivery 继续对账。绝不从 assistant tail/native 文件或 process exit 推断成功。正常 SDK settlement 只在公开 agent_settled 读取 native proof 提取 result/usage。

## 5. 前台与交付

共享 TerminalOwner 保证 Main/Side/Subagent 互斥 stdin，ManagedInteractive 暂停同一 Main TUI、保留 editor/history，native view init 前 attach CC，返回 await 输入/managed 命令 drain、detach、stop、headless rebind。CC execution recorder 始终收真实 run facts，UI 独立 attach/detach。命名主题/public listener 引用差集见 UI_SPEC。

ChildEventProcessor 直接调用同进程 conversation 端口，保留 durable OwnerEvent/result/ACK 状态机。Task owner 而非结构 parent 决定 lease/Completion；等待 barrier 只覆盖 caller-owned 准入快照，future Task 独立。Delivery 双提交域、Wake receipt/turn settlement 保留，closed 不会清 unread。完整格式与故障策略见 Persistence/Delivery/Host。

# pi-subagents · 功能规格

## 1. 范围与身份

唯一同进程 SDK 运行持久 Agent，background 优先，Main 独占其树。Main depth 0，默认只允许 depth 1，可配置最多 depth 2；fork/clone Main 产生新 owner，复制引用只能作历史证据，不控制原树。opaque agent_id、sibling 唯一 task_name 和 task_path 不可变，名称冲突拒绝，不静默复用。Agent 拥有 frozen profile、native conversation、至多一个 current Task、FIFO queue、task-scoped mailbox 和 active barrier。

不提供全局 Agent、自动 worktree、文件写锁、workflow DAG 或退出后运行的 daemon。Main/Side/Subagents 同进程共享文件/网络/credentials；scope 释放是 cooperative，不能硬杀任意 JS。

## 2. 生命周期与工作

Agent 生命周期 open/closing/closed 和 Task admitted/starting/running/waiting/settled 独立。完成后 open idle，保持 history 供下次工作；模型收集结果后应 close 闲置子树，不能靠 LRU 自动回收。close 保留 metadata/history/unread，busy 无 force 拒绝；force 取消全结构子树 current/queued/input/barrier，完成 drain/Completion/lease/ACK 才 closed。超时 cleanup 仍 closing 并占容量。resume 只恢复目标 idle execution，不发 Task/lease/模型/compact 请求，不自动恢复其它树节点。

send_input 在 idle 创建新 Task；busy/starting/selected queue head 补当前 Task 信息；waiting 申请 active 位并保留原依赖；interrupt=true 停止选中 Task，优先新 Task，其余 FIFO 保留。closed/closing 必须先显式 resume。输入准入、settlement、shutdown 有 revision/generation 与持久 receipt 约束；取消输入 resume 不可重放。

Task initiator/owner_conversation 在新工作准入冻结。Main/user 给孙 Agent 新工作归 Main，child-origin 归 child；steer 不改 owner。Completion、lease 和 wait 都按 Task owner，结构 parent 只决定树关系。每 Task 恰一 Completion，outcome 为 completed/partial/blocked/failed/interrupted；child finish_task 声明 partial/blocked，普通 final 默认 completed，交互/approval 缺能力为 blocked，不在 Main 抢焦点。deadline 在首次 grant 冻结，等待/retry/compact 不延长。

## 3. 工具、上下文与冻结权限

Main 八工具：spawn_agent、send_input、resume_agent、close_agent、wait_agents、list_agents、list_subagent_models、list_subagent_roles。child 没有 close/resume，保留 finish_task；达到 depth ceiling 不注册 spawn。旧 send_message/followup_task/interrupt_agent/kill_agent 与 alias 删除。按需 subagents skill 说明委派策略，完整参数见 TOOL_CONTRACT。

fork_turns 默认 none，支持 none/all/canonical N，实际 effective request/stable tail 由 pi-session-runtime 选择并生成 fresh native seed；不复活被压缩/编辑删除的 raw 历史。fork 只影响 context，权限另冻结。role 解析 trusted project > user > builtin（default/explorer/worker），只能收窄父权限。创建冻结 role body/provenance/hash、model scope/model/effort/tier、cwd/trust、tools/definitions/factories、settings snapshot 和 delegation ceiling。resume 核对 hash/credentials，不能采用变更 role 扩权。

## 4. 容量与 Main 边界

schemaVersion 2 默认 active Main/process 各 10、open Main 32。open 包括 starting/waiting/idle/queued/closing，closed 不计；metadata/history 存储预算另算。无 resident/idle/LRU。Main 内 FIFO、跨 Main 公平轮转，waiting 释放 execution 位，用户/依赖激活重新准入，未 drain 取消不能提前释放位。收紧配置不强关已有执行，但新工作受新上限。

Main 所有 session_shutdown（quit/new/resume/switch/fork/clone/reload）先 fence 新工作和旧 append 权限，再强关整树。回旧 Main 只展示 closed 记录，不自动开工。cold owner loss 将未完成 Task 结算 interrupted/host-lost、关闭 Agent，绝不从 assistant tail 推断成功。store-v2 空库起步，旧存储不读、不转换、不删除；profile 切换另行验收，不由本轮迁移清理旧数据。

## 5. 界面与完成交付

Main `/subagents [target]`打开 editor panel 或目标 native view；补全来自同一 runtime 集合，包含 closed。Running 包含所有未完工作/activation/closing，Done 包含 idle/closed；muted 祖先保持树关系。X 仅停止 current，C 关子树、忙时默认 Cancel 确认 force，D 确认 delete，已完成的 open 子树先 close/drain、再复核删除准入；未完成工作仍拒绝 delete，不隐式 force。R 仅 closed 恢复。M/F 已删除。列表/strip/statusline 共享 classifier、排序、按 Agent 计数和按 Inbox 去重 unread。

native view Enter 同 Task 即时输入或 idle user 新 Task，Alt+Enter 排 FIFO 新 Task；durable 成功才清 draft/入 history。closed 可看 history/编辑 draft，Enter 不发送，用户用 R 或无参数/resume-agent 显式恢复后再发。view init 不发模型请求，不抢 Main editor/history，返回不 abort execution。当前 D 已读规则：成功 onLoaded 清 Agent 自产活动标记，点击卡片清该精确卡片，close/resume/render/scroll 不标读；用户最终规则确认仍独立记录。

Completion 先持久再在安全 Pi 边界 append 冻结 card，Wake 由 runtime-contract 和 durable receipt 选择唯一 continuation owner。wait_agents 冻结 caller-owned Task 集合，中间 Completion 仍交卡片、最终一个 aggregate Wake。不会 polling、抢前台、重跑 Task 或把模型已处理与已投递/人工已读混为同一事实。

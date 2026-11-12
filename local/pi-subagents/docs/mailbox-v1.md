# Subagents mailbox v1

目标为 stock Pi 1.5；transport 由 `pi-session-inject/mailbox-v1` 唯一拥有，当前 build 为 `mailbox-v1.0.6`，compiled consumers 必须重建并使用新进程。
Main 和每个 SDK child 是同一 agent directory 下不同的 session slot。Subagents 不直接发送后台
native message/control，也不保留超时重发循环；首个 Task prompt 和 compact-state 恢复投影仍由原 owner 处理。

## 稳定身份

| 会话/用途 | key | 载体与 wake |
| --- | --- | --- |
| Main 普通 mailbox | `mail:<messageId>` | 原 `subagent-mailbox-v1`；原 running 输入欠 wake，idle 普通输入不自动 wake |
| Main/child 单张卡片 | `card:<inboxId>` | 原 `subagent-completion-v1`；wake=false |
| Main outbox | `outbox:<id>:<wakeEpoch>` | 原有序 completion/barrier cards；直到有请求机会或持久 Main 成功证明 |
| Main producer fallback | `outbox:<id>:<wakeEpoch>:continuation` | 原 `subagent-continuation-v1`；只在需要 producer fallback 时接受 |
| child Task input | `agent:<id>:task:<taskId>:gen:<n>:<messageId>` | 原 mailbox body/hash/injected_into/source；空闲会话使用 task=`idle` |
| child outbox/fallback | `agent:<id>:task:<taskId>:gen:<n>:outbox:<id>:<epoch>[:continuation]` | cards 与 fallback 分开；同一原 Task/generation，恢复必须先获 grant |

原 customType、content、details、body hash、card projection hash 和 continuation hash 均不添加 mailbox metadata。
独立 model-invisible `subagent-mailbox-intent-v1` 保存冻结 Mail（含原 anchor/policy/wake），非空 origin 先写 intent 再 put；
空 branch 的 null origin 先由 A durable acceptance 承责，再写 intent，避免 intent 本身使 null origin 失效。
恢复同时对账 A 的公开 snapshot/terminal receipt，避免响应丢失后用新 leaf 改写 origin。
恢复 intent 身份扫描同一 session 的全部公开 entries；off-branch intent 仍保留原 entry ID 和冻结 Mail，
不能在 sibling 重新绑定。执行、投影和业务取消继续只认当前 active branch 的原 scope。
正文 proof 只读 active branch，完整比较原 identity/content/details/display；重复 native carrier、hash/正文不符均阻塞。

## 业务 ACK 与 Goal

`put` 返回只表示 durable handoff，不能冒充 native proof、Task grant 或成功 run。
Main `onRecorded` 只接收本 mail 的精确 native 事实：cards 补原 Inbox ID/projection 并按需推进 cards-appended；
continuation 与已有 Wake receipt 精确相同则直接 ACK，否则写 Outbox 的可选 `continuation_native={wake_epoch,entry_id,sha256}`。
session_start 先建立 source identity 并完成 transport 原 intent 恢复，再让 A attach 重放通知；不依赖无变化调度来弥补初始化竞态。
source 已有相同事实时零 journal 写入；保留原 session/anchor/epoch/完整 messageIndex 映射验证。
ACK 不执行全局 reconcile、不要求 Outbox delivered、不等待 sibling 或 Main turn settlement。source 持久写失败仍 reject。
child owner-event 的既有持久 handoff 规则不变。
没有 proof 的 child owner event 保持 sent，等 A 的 notice 后重放同一个 event，不创建轮询/重复 owner sequence。
`onTerminal` 只确认该 mail 的 source native 接收或原取消/handled 授权；不推进业务、不等待 turn settlement。Task final、输入取消和 Main turn settlement 继续归 Subagents。

Goal claim/producer proof 的既有接口不变。outbox cards 的 mail 始终 wake=true，guard 可暂不允许 producer wake。
`queryGoalContinuationObligationV1` 返回 owed 时依靠 Goal；none 时才接管独立 fallback key；unknown 时保留 pending 并诊断。
Goal claimed 路径不额外给模型追加 fallback 指令。Main 的原 context/run observer 仍须看到全部 cards 且真实成功 run 才提交
`turn_settlement`，不能从 transport fulfillment 推导业务已处理。
真实 `beforeRun` 先保留当前请求机会：Goal 在这个边界消费 owed marker 后，不能因此新建 fallback。
成功 run 的 card observation 或 active branch 的原 fulfilled receipt 阻止 successor wake；receipt 通过精确 native identity 连接 cards，不能限制为当前 Outbox key。无关合法 receipt 跳过，malformed/冲突不授权，canonical 保持严格。guard 只读；fallback 的创建由独立 Outbox driver 在 owed=none、无 active run、仍欠机会时执行。
真实 `agent_end` 成功时，Main turn owner 先持久化 model-invisible `subagent-main-run-completed-v1`，
保存本 session 的原 card entry/projection 和最终 assistant，再允许依赖它的 `settleOutboxTurn` 提交。
观察写入和所有 source turn settle 共用 Main turn owner 的同一串行边界；live 观察只抑制 wake，
read-only guard 不发布业务 handled，只有 fsync 成功或已恢复的有效持久记录才授予 Host commit 权限。
每项错误返回给自己的调用方，FIFO 尾部继续执行后面的项；settle 意外 throw 后保留 pending，下一正常边界可以重试。
观察写入失败的 run 单独排除恢复取证，即使 marker 已在 branch 中也不算持久；后续 run 仍可写入独立成功依据并结算。
重开时 attach 与独立 reconcile 验证该记录及 active branch 的原正文，补交同一 epoch/continuation 的 Host 事务，不需要新请求；recorded/terminal replay 只接受原事实。receipt（包括成功 toolUse）只证明请求机会，不恢复整轮成功；后续 abort/error 不写成功记录。
旧版本只有 fulfilled receipt、没有整轮成功证据时，保留原 source turn debt，不能猜测成 settled。

Main 新终态 `handled` 表示所有原 cards 已被持久的成功 run 处理，因而无需再建立 continuation。
owner 在原 FIFO 内导出逐 card 的 native ID/projection、成功 marker ID/hash 和 assistant ID；正常 barrier 可由多份成功 run 覆盖。
持有 per-Outbox driver 时，先补 native card proof，再由 Host writer 验证原 Main/epoch/全体 card，提交 `handling_proof` 和 handled。
epoch=0 也可收口；从未进入 A 的旧 native card 直接用原 `card:<inboxId>` 做 importFulfilled，生成真实 receipt 后可正常删除，不发送 native、不增加 epoch、不造 fallback。未释放的 source lease 按原 authority 无 Wake 释放并在该事务标 released。
已有 Wake receipt 的 pending 仍走 receipt→delivered→turn settled；已有 delivered 不改写为 handled。
handled 的 cards 保持 project=true/wake=false，使用原 importFulfilled；仅已 accepted 的 continuation 用原 key durable cancel，缺 native 也不重发。
已提交 native/control 的不可撤回事实仍由 A 追踪。handled commit 与 import/cancel 之间 crash 后按同 key/epoch 续作。

Main 已 accepted 的 fallback 无 native 时返回 waiting-native，保留 open/原 epoch；不 re-offer、不重复写 open，不把 acceptance 当 active producer proof。
新 native 观察或真实 lifecycle 再推进；driver 运行期间的新信号合并为再一次有界 pass，不能被 single-flight 丢弃。
source 转 delivered 后对原 prefix 重复 put 让 A 重查 guard，这不会重放 ACK；receipt 接管同一 continuation 证明后移除局部 observation。
store-v2 的 journal anchor 升到 3，正常打开会回放旧 1/2 并 checkpoint 到 3 后才写新语义，旧 reader 明确拒读。
`handling_proof` 与尚未移交 receipt 的 native observation 随 Outbox 保留；Main 的 delivered/handled Inbox 先满足已读、业务退休的原资格，再由 checkpoint 批量读取 A 退休证据：相关 card key、原 Outbox epoch/prefix、已存在 continuation、shared carrier 全部 ACK/GC，且有精确磁盘替代 receipt，才回收原投影。未附着、unknown、scope 冲突、pending/terminal 尚在时保留。child Inbox 沿用原规则；升级 checkpoint 同样不能跳过 A 证明。

`retirement-main` 是 retention、删除、冷 importer 和热态跳过共同使用的只读判定：

- pending 尚在且无匹配 terminal：仍需正常 handoff；
- 精确 terminal 尚在：已 handoff，ACK/GC 归 A，D 不重复 import/cancel；
- pending/terminal 都无：只有精确磁盘 receipt 与原身份见证齐全才视为已 GC；空 snapshot 本身不是证明，epoch 0 无 admission 仍需首次 import；
- holder/slot/session/generation 不可验证、恢复未完成或 scope/证据冲突：unknown，保留材料。

读取只使用 A 的公开 holder/slot committed snapshot 与公共 receipt。一次 checkpoint/pass 批量取证；热态仅复用经磁盘校验的不可变 receipt 索引，跟随 session/file/slot/generation/公开 entries 变化失效。checkpoint 和删除始终强制重读磁盘并重验当前 slot，不使用热态结果授权回收。
原 `completedMailPasses` 与其 complete 标记已删除，terminal pending 已足以证明后续责任归 A；部分失败只重试仍需 handoff 的 key。冷恢复先识别退休 receipt，已合法回收 Inbox 的 delivered/handled 不再被报成缺材料 unknown；handled 的原 proof 继续保留且不可变。

每次真实 tree 都保留旧 key/anchor。尚未接受的异步 put 失去 target 后，只有回到原 source intent/origin 才能重捕获；
已接受原文件事务可以完成，迟到结果不在 sibling 上追加 source intent。业务取消也先核对原 scope。

## child 激活、结算与取消

本进程新建的第一代 execution 在第一个真实 run 前调用 `activateNewExecution`，仅解除 transport hold。
从磁盘恢复的 execution 不调用；view detach/reattach 不更改 hold。live child view 转交 A 的 `/mailbox`
facade 和原 completion callback，支持 status/resume/recover，历史只读 view 不创造 owner。

`resumeFromCompletions` 只重新提交同一已接受 intent 以重核 grant，不再发送 `subagent-task-resume` 或第二个 trigger。
Process bridge 的同 admissionId trigger 回放重新检查 Task、generation、deadline、final 和当前 active grant。

finish declaration、成功 settle、interrupt/timeout、force-close 撤权事务先 await approved Processes child factory
`cancelPending()`，再 await D 自己当前 Task/generation keys 的 durable cancel，最后才撤销 authority/dispose。
只等待 tombstone，不等 source ACK；因此不与 Host writer 互相等待。put 响应不确定时以同冻结 Mail put 后 cancel。
main-session-ended/reload/quit 不走此取消流程；A 不因 session_shutdown 删除 pending。
native ACK 不代表 child 已经处理输入：有效 waiting Task 的临时 grant 保留到真实 A afterRun 观察该输入；
sent/ACK owner event 仍可能欠这次请求，恢复 grant 不能只检查 pending event。只有真实 run 留下的 input-settlement debt 才重试结算。
grant 到达后对同一 Task prefix 的冻结 keys 重新 put，让 A 重查 guard；不依赖已经 ACK/退出的 owner event 再触发调度。
Process lease 的释放先于 batch/admission，不能作为 mailbox run 结束 Task 的证据；Process 依赖只由原 bridge admission 恢复。

外部调用 D 持有的公开 SDK `runtime.dispose()` 会先通知 Host：在原 Host writer 内 durable cancel 当前 Task 的 B/D keys、
提交 `failed/host-lost` 并取消 source pending，然后销毁 SDK 并撤销 grant。它不冒充 user-interrupt；取消失败时保留 runtime/authority 供重试。

## legacy 导入

Main attach 先按原 rules 打开 store；mailbox importer 路径保留 wake_epoch，不通过增加 epoch 绕过冲突。
从旧 snapshot/source intent 或 legacy source 接管的 put 带 `{recovered:true}`，只在可信输入或 `/mailbox resume` 后允许自动唤醒。
旧 epoch=0 Outbox 在 reconcile 后新生成的 card/epoch key 仍属于恢复流量；本进程新业务 mail 不带该标记，`importFulfilled` 不变。
分类前先恢复 Main owner 成功证据，按热态同一个 per-Outbox driver/Host 事务尝试 handled；不写修复脚本、不改原 key/epoch。
原 cards 以真实 marker/assistant/native proof 调用 importFulfilled；旧 delivered+turn settled 沿用原 carrier/assistant proof。
不再要求「晚到 continuation 再见一次 assistant」；已有 accepted continuation 直接 cancel，没有 accepted fallback 就不创建新 key。
只有 fulfilled receipt、没有 owner 成功 marker 时仍保留业务 debt；未知 scope/正文/hash 或 root input running/idle authority 仍 visible-unknown。
重放顺序允许 recorded ACK 与 handled 先后互换；两者都不等待对方，A 的 receipt、terminalId、recordedToken 与 GC 规则不变。

`subagent-mailbox-import-v1` 在所有 put/import/cancel 完成后持久记录 source revision 和分类清单；相同计划重跑不重复写 marker。
import revision 完成前保留独立暂态 fence，不启用 sender。revision 完成后将 visible-unknown 的原 key/原因保存在 binding 的 hold 集合；
Outbox unknown 同时 hold 该 Outbox 的所有 epoch/card/continuation 入口，即时投递、idle reconcile 和 mailbox guard 使用相同范围。
身份无关的新 Completion/Outbox 正常投递、唤醒；hold 不升级为 Main 级禁用。原 import marker 与 mailbox-import-hold diagnostics
记录精确 key 和原因，warning 说明独立投递仍启用；不新增命令或公开 invalidation/callback API。
这些 hold 只限制新的投递/Wake，不否认 transport 已验证 carrier 的既有通知。
所有 source 状态的 recorded/terminal 都仅验证并接收本 mail 原事实，不经过 sibling hold，不授予新的投递权限；不再存在仅终态 source 可 ACK 的特例。
已取消的旧 child input/owner event 继续使用原 journal 终态和连续 sequence；旧 generation 的 transport intent 不能投给新 Task。

共享 holder、fsync/ACK debt、native submitted、命令注册、冷启动 policy、abort/reload/crash 机制归 A。
本包 source 测试替身只验证 adapter 协议；真实 faux/新进程/多 producer 验收必须使用 A1，不能用 A0 实现桩宣称通过。

删除准入只检查本次子树相关的 Main Outbox：公开 A snapshot 中不得仍有相关 pending/terminal 收尾记录，原 card 必须有可验证的磁盘 fulfilled receipt。
同一检查覆盖 delivered 与 handled，不限制无关子树；未附着原 Main 或尚在收尾时返回「还有投递在收尾，稍后再删」，A 正常收口后重试即可删除。
检查只读，不调用 callbacks、不激活 delivery、不添持久字段。关闭 Main 后从后台 API 请求删除会遇到未附着拒绝，正常使用是在原 Main 的管理界面重试。

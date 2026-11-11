# Processes Mailbox 合同

Processes Main、Side 和 Subagent child 通过 `pi-session-inject/mailbox-v1` 发送后台通知。
Notification Broker 继续拥有事实聚合、有界 repeat/overflow、每 epoch 一批、wait lease 与 re-arm successor；
mailbox transport（下文 A）唯一拥有持久 acceptance、native append/proof、compaction 正文恢复与原生 control。
Subagent execution owner（下文 D）拥有 Task/grant；它们都不是本包读取其他插件私有存储的许可。
本包不直接发送 notification batch 或 trigger，也不注册 `/mailbox` 命令。
压缩后的 `process-compact-state-v1` 仍是无 wake 的 owner snapshot，不属于新邮件。

## 身份与交接

- source ID 固定为 `pi-processes`，key 为 `batch:<batchId>`。Main、Side、child 分别使用自己的
  `(canonical agentDir, sessionId)` slot；异步 admission 前捕获 endpoint target。
- 原 `process-notification-batch-v1` 的 content、details、display 与 strict parser 不变。
  `proveNative` 校验原 scope、batch ID、完整规范化内容和唯一 native entry ID；缺少 proof 只是一份观察，
  source 不据此补发 native 消息。
- `process-notification-intent-v1` 是 model-invisible 的 source identity entry，保存完整冻结 mail。
  child 额外保存原 opaque owner token 和 prepared lease membership 导出的 continuationSignal。
  同 key retry/重开读取这份 identity，不以新的 leaf、policy 或 wake 覆写 acceptance。
- durable intent 与 target 在异步 child admission 之前冻结。tree 后旧 target 不重投到 sibling；
  只有原 intent 位于当前 branch，且已存在的唯一 canonical carrier 也在该 lineage 时，才重取 target。
  全树查询仅用于拒绝 off-branch carrier，不用 sibling 的成功证明完成原 branch。
- `put` 成功才表示 transport 接管；source 在失败、丢回复、reload 时保留原 prepared batch，按同 identity 重试。
  acceptance 不提交原 lease，不表示模型或 run 已成功。
- `onRecorded` 必须验证完整 canonical proof，先写 `process-notification-status-v1/pending`，
  再 commit broker/wake/lease。marker 写失败会抛出并保留 A 的 ACK debt；重复 notice 幂等。
  原 lease 的独立隐藏 receipt 仍必须已持久化。
- Main 在 marker 落盘前允许 body projection、暂缓 wake。mail 的冻结 `wake:true` 不因此改变；
  A 完成正文 proof、调用 onRecorded 后重评 guard，提交唯一 control。
- 成功 run 的真实 `afterRun` membership 与真实 `settled` 才写 `turn-settled`；abort/error 不写。
  transport fulfilled 不替代这个业务成功判据。取消用 durable terminal ACK 结算 source skipped，
  不伪造 `turn-settled`。

## 受管 terminal wake 与状态投影

agentDir 的 `managed.terminalWake=required` 只改变 terminal attention：退出/超时必须进入 turn lane，模型的 notify ignore/context、detached 和已满足的 watch wait 均不能取消这份 obligation。已 sealed 的 epoch 保留 successor，仍由原 coordinator 在当前 run settled 后合批，不另加 wake 队列，不绕开 mailbox 的 pause/request permit 或 abort/closing fence。

`processes:managed-snapshot-v1.wakePending` 直接投影 Host 已有 broker open/prepared turn window、Main pending/receipt 和未消费 mailbox source batch。terminal 与 broker observation 完成后才发布状态；recorded ACK 不能把 pending 变成 false，成功有效 round 消费/settled 或取消才释放原 source 状态。它与 command live count 使用同一 Host snapshot，并有独立于 statusline v2 的业务 revision。

## admission 与 lifecycle

Main 的 PromptBoundaryCandidate 仍只接受非 streaming 的 interactive/rpc input；handled/missing/
ambiguous/extension candidate 不解 abort fence。批准、prepare 和 next-user `put` 在 producer 的
真实 `beforeRun` 中完成，A 在 await participants 后取 ingress cutoff。context mail 不自动 wake。
Main turn mail 用 next-request；新 re-arm wait 在 final response 期间到达时保留 successor，
当前 run settled 后才形成下一批。普通 repeat/detached successor 仍受 broker epoch 限制。

Goal claim 后 mail 仍保留 `wake:true`。ProcessHost 保存实际 WakeConsumerReceipt，
`process-notification-claim-v1` 保存其 source branch identity；发送 guard 经
`queryGoalContinuationObligationV1({sessionId,continuationId})` 查询：owed 仅暂缓 producer wake，
none 允许 fallback，unknown hold 并诊断。不能把历史 claimed boolean 当永久 live claimant。

child 首先经 `ProcessWaitBridgeV2.admitContinuation({ admissionId: batchId,
ownerToken, continuationSignal })` 获得 trigger admission，再 put。
mailbox 的两个 guard checkpoint 都核对 `captureOwnerToken()`、await 同 admissionId 的 admission，
并在 await 后再次核对 owner。D 必须在幂等回放时重验当前 Task/grant；record-only、final 或旧
Task/generation 不得借历史 trigger 续跑。缺失 owner/bridge 时 hold；初次缺 bridge 保留同一 receipt/prepared batch 并显示诊断，在 recoverPrepared、真实 beforeRun、turn_end/settled 或 receipt persistence 边界重试，不靠缺失观察结算 record-only。拒绝 admission 的 batch 仍按原
record-only/TUI receipt 协议结算。子 Task 初始 prompt 和 grant 继续由 execution owner 掌握。

reload 只 dispose 本代 coordinator；mailbox 的 native-submitted facts 不存于 Processes。
Main/Side 树导航前先确保原 source intent 已接管，canonical proof 与 marker 已可提交；未完成就取消
导航并给出原因。新 wait successor 以独立 source parking marker 留在出发 branch；其 mail 仍保留
wake obligation，但 guard 暂缓自动 wake，返回后由自然请求处理。sibling 不投影或结算该 batch。
Side view detach 不卸载 execution factory；destroy 由 Side execution owner 结束 scope。

## 旧数据导入

sender ready 前只扫描当前 session/active branch，不重执行 process 或 Task：

恢复 intent 与旧 carrier 的首次接管均用 `put(mail, target, { recovered: true })`。
A 在可信用户输入或 `/mailbox resume` 前 hold 这些 key；本进程新产生的通知仍是普通两参 put。
同 identity 已正常 accepted 或已解除 hold 的重复 put 不会重新 hold，reload/重绑/tree 返回不改其 live 义务。

- pending、未 settled batch：稳定 key 接管剩余 wake；原 native proof 不重写正文。
- 已 turn-settled：找到原 status entry 与其前的成功 assistant，调用 `importFulfilled`；
  A 再独立核验磁盘 proof，零模型调用。缺少成功证据保留 visible-unknown。
- 无 pending marker 的 batch：不能忽略。user-boundary 可恢复 next-user context；main-admission
  orphan 无法重建 wait authority时按 next-user context 保存，写 visible-unknown，不伪造 lease。
- child batch 必须有 surviving Task/grant identity；仅有旧 native carrier 不猜测 owner。
- parent fork/foreign session 的 carrier 只作为历史；不导成当前 scope 的 pending。

`process-notification-migration-v1` 持久保存 accepted/fulfilled/cancelled/visible-unknown 裁决；
visible-unknown 同时显示诊断；未裁决的 unknown 不得当作已消费或已取消。
以上 source entries 使用空 renderer，绝不改写原 carrier。回退工具须识别这些 source obligations；
只允许整批离线检查和明确放弃，不提供 native-send fallback。

## 验证边界

包内离线测试覆盖 broker、真实 ProcessHost、隔离 endpoint 的 adapter 故障点及 compiled Supervisor/UI；endpoint stub 只证明 adapter 行为，不能代替真实 mailbox transport。持久 SDK/faux-provider 场景必须核对请求次数与 durable proof，并把 profile、session 和故障文件放在独立临时目录。

仅本包与共享库组成的 Main/Side/双 child 隔离、tree 前异步 put fencing、SIGKILL/compaction/marker 故障、取消和 terminal ACK 重放/GC，可由包内持久 SDK/faux 测试覆盖。加载真实 Goal/Subagents 的 claim/grant、Task deadline、撤权及加载顺序验证放在[根 integration](../../../integration/README.md)，不读其他插件的私有 store，也不把 bridge stub 称为真实 Task 验证。运行入口统一见[本包 README](../README.md#验证)；source-only library 变更后重建并新开 process，不用 `/reload` 替代 rebuild/restart。

## Execution owner 结束接点

`createProcessesChildFactory` 与 `createProcessesSideFactory` 返回 callable ExtensionFactory，
并附 `cancelPending(ctx?: ExtensionContext): Promise<void>`。省略 ctx 使用该 factory 捕获的当前
session context；未安装/未 session_start 时没有 source authority，返回 no-op。
已绑定后 stale context 或已撤销的 child owner token 明确拒绝。

D 在撤销 Task token/grant 前 await child factory 的方法；只取消冻结 child.ownerToken 匹配的
Process keys。Side 的 pre-dispose（所有 destroy，包括 Main shutdown/quit/reload）先 await Side
factory 的方法，然后才 retire policy、interrupt、dispose 和删除 ephemeral session 目录。
两者同步 fence 新 intent，再用公共 getEntries 扫本 session tree，取消本 producer 的 keys；
其它 Task/slot 不受影响。只 await mailbox durable acceptance/cancel，不 await Host admission
或 source ACK，因此允许 D 在 Host 撤权事务中调用。已在途 admission 返回后因 closing fence
转 record-only；不会向后继 Task 发送。取消失败保留 runtime/源目录，caller 可重试。Supervisor 失联/containment 只撤销执行 Host，不撤销仍绑定的 conversation source ownership：当前 Side 仍可 durable cancel（及记录 cancelled evidence），然后 dispose/delete；不允许因 Host disposed 而永久拒绝销毁。ownership 固定到 coordinator 首次激活的 session manager；即使 sessionId 相同，替换 manager 也必须创建新 coordinator。stale context、已卸载 coordinator 和非取消投递仍拒绝。disposed Host 上的 source 取消只清理本 batch 的内存投影，不重启 helper、不 re-arm successor，也不改变 execution containment 结果。

取消终态优先于旧 pending status。收到 A 的 cancelled evidence（callback 或 put 返回）后，source
用现有 `process-notification-migration-v1/classification=cancelled` 持久确认业务取消，不写成功
`turn-settled`。同步树恢复从本 scope 的公共 session tree 读取这些 source 取消确认，较早 leaf
或新 coordinator 不得用旧 pending marker 重建已取消义务；成功证明仍只取 active branch。

## Notification 模型投影

`matcher-error` batch item 与 `watch-match` 一样保留 `watchKey/watchGeneration`，用于定位失效的 watch；只有 `watch-match` 带 `matchedCount/suppressedCount`。包括 worker 启动超时在内的 matcher 故障必须通过同一严格 carrier 校验、恢复与取消流程，不能把完整的错误通知当成损坏 intent。

ProcessHost-owned Notification Broker 按 owner/process/watch generation 聚合 repeat watch；`context` 在下一 external user boundary 注入一批，`turn` 经 Main wake 或 Subagent Host admission。`process-event-v2` 只服务 TUI/history renderer，模型只消费 `process-notification-batch-v1`。每个 blocking lease 另有独立、隐藏的 `process-notification-receipt-v1` 持久凭据。

Main 在处理上一批通知的 run 中显式创建或重新 arm 的 wait，仍拥有一次 `turn` 唤醒机会。完成信号若在最后回复生成期间到达，先保留 successor，等当前 run settled、旧 receipt 清理后再投递新 batch 并唤醒。每个 run 仍最多一批；没有重新 arm 的 repeat watch 和 detached 通知保持原有 successor 限流，`context` 与 abort fence 不变。`process start` 的 wait 提示只要求模型结束本轮等唤醒，不改变调度。

## 压缩状态恢复

Main 和复用同一 conversation installer 的 Side 安装 `createCompactReinjection`；Subagent child 不安装这个 helper。它只读当前 Host record，不启动 helper、不读日志，没有 live record 就不生成正文，也不改变 child 的 Task admission/notification 协议。

正文以「这是压缩完成时的实时状态，与摘要冲突时以此为准」开头，只列 `starting | running | stopping` 进程的 ID、名称、状态、完整 command 和 Supervisor 滚动日志路径 `<private-root>/records/<process-id>.*.jsonl`，并说明用 `process({action:"logs",target:"ID"})` 读取输出，不要重复启动。

### 同步 collector

可选 `pi-session-compact:collect-recovery-v1` 在 compaction commit 前同步收集本 owner 的现有恢复正文。helper 验证 `version=1`、字符串 `operationId`、`reply` callback 和当前 session ID；有 live snapshot 才回复：

```ts
{
  owner: "pi-processes",
  customType: "process-compact-state-v1",
  content: "...当前 live process 状态...",
  identity: { processIds: ["..."] }
}
```

本 owner 不指定 `order`，使用 collector 合法缺省值 100，不要求固定 summary order。collector 的完整输入、identity 与 recovery details 版本兼容规则由 [pi-session-compact](../../pi-session-compact/README.md) 定义；本包只提供自己的正文，不代表其他 owner 已恢复。

`session_compact` 后，若 `compactionEntry.details.recovery` 的 `version=1` 且 `items` 列出同一 `owner/customType`，就不再单独补注。没有该 marker 的记录保留独立恢复路径，普通原生压缩或消费者缺失也能使用。

### 独立补注与去重

公开 `session_compact` 后，helper 用 `process-compact-state-v1` 发送隐藏模型消息，`details` 保存 `{compactionId}`。同一 session/compaction ID 只处理一次；当前 branch 已有同 ID 的消息时也不重发，恢复和 `/reload` 不补发。

发送只用公开 `pi.sendMessage({display:false}, {triggerTurn:false, deliverAs:"steer"})`：空闲压缩时直接落在 compaction entry 后；运行中压缩（例如工具批次间 threshold compaction、溢出恢复）由 stock Pi 在最早安全 `turn_end` 或 run 启动/结束的原生 flush 落盘，仍在 compaction entry 后。**不承诺紧接着的第一次请求能看到补注**，也不会为此额外请求模型；`nextTurn` 会延迟到下一外部输入，因此不用它。

压缩期间完成的 Main/Side process turn 通知仍走原 Broker。公开 `session_compact` / `session_compact_failed` 后，短期 timer 受当前 session/coordinator fence 约束，等 compaction guard 退出再调用原有 idle drain；活动 run 仍由正常 `agent_settled` 收口。失败或取消不让 pending turn notification 卡到下一条用户输入；context lane 仍只在下一 external user boundary 投影。这与 live snapshot 补注是两条独立路径。

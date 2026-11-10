# Durable mailbox 合同

[返回包入口](../README.md)。transport 的共同合同归 [Session Inject](../../../local/pi-session-inject/README.md)，这里定义 Goal 作为 source/consumer 的 authority。Goal 拥有迭代、安全限制、budget、usage、暂停/清除/完成以及后台 claim receipts；mailbox 拥有 durable body、native carrier、trigger、去重、恢复 hold 和 request receipts。

## 身份与冻结内容

自动 continuation、owed background continuation、idle check-in、延迟 queue activation 和 budget wrap-up 使用 `pi-session-inject/mailbox-v1`；手动 start/resume/edit 仍是 user input。轻入口为 `mailbox-v1/light`，build splitting 保留 engine/store 首次使用边界。缺失/不兼容 transport 必须可见失败，不回退 Pi private native delivery。

Goal 在 put 前先写 optional `goal-state.mailbox` source intent，冻结原 anchor、marker、prompt、kind、policy、started flag。key 是 `continue:<goalId>:<marker>`；新 custom carrier 为 `goal-mailbox-continuation-v1`，payload 严格为 `{version:1, goalId, continuationMarker}` 加原 prompt。公共 `custom_message` branch shape 证明新 entry；旧 user continuation marker 映射同一逻辑身份。source bookkeeping 不是 transport pending/terminal 证据，也不是业务 ACK。

put 失败保留原 intent，后续 reconciliation 重试**同 key/同 payload**，不造新 marker。成功接受后即使 Main busy 也由 mailbox 拥有 mail；只在返回 transport terminal 后移除 source bookkeeping。Goal 不注册 onTerminal 业务回调；terminal index 使重复 source replay 不重复 delivery。

## 源 session 与 branch lineage

首次 source append 冻结 `sourceSessionId`。`originEntryId` 指向 original anchor 的确切 parent edge 和 matching frozen intent；首次 checkpoint 本身足以在 SIGKILL 或 append reply 丢失后重建 origin，不要求为 origin 再 append 一次。如果实际没写入，只能在未变的 live binding/leaf 重试。

同 Goal id、共享 anchor 或 fork 拷贝的 entry id 都不能转移 put/cancel authority；必须在原 session 的当前 branch 找到 original checkpoint。sibling 缺 checkpoint 不能 retarget/cancel。较旧、无 identity 的 intent 只有公开 session header 能证明它是无 parentSession 的 original root session file 才能采用；forked/unidentifiable 记录保留 visible-unknown，不凭相似内容猜 origin。

`pendingContinuation` 第一次 receipt checkpoint 就冻结 sourceSessionId，早于异步 guard 或 submit；后来的 intent 复制同一 scope。这样 Goal 在 fork 内新建 owed-only 记录也能恢复，而后代把它当 foreign history。coalesced offers 保留第一个 marker/offer identity，归还 receipt 前先持久化 scope。

fork 保留 parent pending 为历史，只有 source session 能 resume/cancel 对应 intent。restore/tree 只恢复目的 branch，dispatch 在 await guard 后重验 generation/binding/Goal；不能借 sibling 的 proof。

## 恢复 hold 与 owed continuation

恢复的 source keys 以 `put(..., {recovered:true})` reconcile，包括还没有 transport record 的 owed marker。整个 session restore phase 都算 recovery：从旧 queue 新 materialize 的 activation 也要 hold。只有 live runtime 在 recovery 外创建的新 intent 用普通 put。terminal lookup/importFulfilled 不重跑模型。

恢复 pending 等待可信 user input 或 `/mailbox resume`；后者只解除 transport hold，**不恢复 paused Goal**。paused 仍需 `/goal resume`。不通过 idle/pending count、后来的 run、timer 或 reload 推断 native queue loss。

Process/Subagent consumer receipt 标识仍为 `pi-goal-local`。Goal 先 durable 记“欠这一轮”，才返回接管 receipt；producer 已认领完成，不会再通知，故 Goal 必须保留确切 owed marker。admitted marker 只清匹配 owed；重复 callback 不推进两次。恢复 started marker 可能还没发出首次 provider request，每个 real run 只进入 accounting 一次。

`beforeRun`、`afterRun`、`settled` 是 mailbox participant callbacks，request-scoped active/paused policy 由 context 提供，不能用 display message 边界把控制 carrier 误分类为无关 follow-up。普通 continuation 计 automatic；check-in、queue activation、budget wrap-up 保持 manual accounting；自然 user run 仍 manual。

普通 continuation/check-in/activation 用 `new-run`。新 budget wrap-up 用 `next-request`：自然 tool follow-up 能接就合入下一请求，否则最多一 wake。旧记录缺 policy 按 `new-run`，reconcile 不改 accepted key 的冻结 payload。

## 取消失败不能伪装成功

pause、clear、complete、replace、安全上限、budget stop、settings freeze 在撤回 authority 前，都等待全部已知 Goal keys durable cancel；single-flight 并重验 generation。I/O 失败保留当前 Goal、持久 `cancelling` hold、owed marker和可见诊断，不宣布已暂停/清除/完成。成功后才执行相应状态变更；pause 保留 owed，resume 换 Goal identity。

queue advance/prioritize 的 pending action 贯穿取消 barrier，包括失败时。只有 cancel 成功，且 binding generation、Goal 和 exact pending action 仍匹配，才消费 action。clear、只剩一项的 drop-last/skip 传播 boolean 结果，真正 clear 后才报成功。reconcile 不为现有 unstarted intent 另造 marker，compaction/tree 也一样。

cancel failure hold 需要可完成 durable cancellation 的 Goal action；修复 storage 后重试，不删除 source intent 或原始 history 来假装成功。这个 hold 与 transport recovery hold 不同，单独 resume transport 不能绕过它。

## 旧 carrier 与成功证明

legacy import 只扫描当前 session 的 active branch：

- owed 没 carrier 时生成同一 stable mail；paused authority 继续 hold。
- old user marker 直接跟随成功 assistant，Goal 可清 exact owed 并持久化，不 put/importFulfilled、不增加 iteration、不发请求。
- 中间夹 user/custom activity、或缺成功证据，保持 visible-unknown，不 resend。
- new custom carrier 使用 source-start/assistant proof 和批准的 importFulfilled。
- new mail 若在自然 USER run 已完成，先读 public delivery receipt，再以 idempotent put 确认 exact frozen mail；只有 A 返回 terminal 才清 source intent。lookup 暂 hold key，未确认 receipt 不得造 wake，也不能借其他 user request 的成功 assistant。

custom-carrier import 只有前置 sealed attempt receipt 在本 session 精确命名 Goal key 与 origin anchor，才可跨过自己的 control；无关/未证明 request boundary 不 put、不 import，维持 unknown。

## 备份与离线回退

`src/mailbox-rollback.ts` 只提供纯投影，不自动 abandon。release owner 必须先锁定受影响 session、备份、预览选定 keys/carriers 并显式确认；owner 还负责 public control projection、所有 branch 重写和 old-reader 验证，不能直接在活动 session 上运行猜测修复。

投影暂停受影响 unfinished Goal，保留 objective/usage，仅移除选定 exact marker obligations、neutralize 选定新 custom carriers，不删普通 user history 或业务结果。离线 pause 去掉 activeStartedAt，避免后来旧 reader 把 offline 间隔计入 Goal；不能用 live transition 做这步。恢复时以备份和已确认计划为依据，不能把删除 transport evidence 当正常恢复操作。

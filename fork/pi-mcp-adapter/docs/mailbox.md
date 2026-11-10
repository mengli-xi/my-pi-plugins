# Durable mailbox 投递

Apps、后台 OAuth 与异步 Task 结果注册同一个 `pi-mcp-adapter` producer。**只有 `pi-session-inject/mailbox-v1` 共享库**拥有 durable acceptance、native projection、pending recovery、branch fencing 与 wake coalescing。Adapter 不导入 Inject/CC 插件，没有第二条 native send/Task wake，也没有独立 pending store。显式 MCP prompt slash command 仍为前台输入。

Transport 不存在/不兼容时显式失败，不能偷偷 fallback native queue。调用方必须区分业务成功、durable put 接受与模型收到三件事。

## 身份与冻结

Trusted UI host 在 HTTP 前分配 immutable UI session UUID 和递增 sequence：`ui:<uiSessionId>:<sequence>`。完整 prompt/intent/context payload（含原文和 image bytes）先冻结，message/context/raw actions 共用一条顺序 queue；failed action 挡住 successors，用户显式 Retry 才重试，不能 timer 生成新 action。

同一次 retry 保持原 ID 与 bytes；server 校验 supplied ID、返回已接受结果，payload 改变或 sequence 乱序 HTTP 409。两次文字完全相同的真实点击仍有不同 IDs。Browser-local pre-acceptance queue 不是另一份 durable transport。

每个 OAuth watcher 在开始 auth 前分配 attempt UUID，ID 为 `oauth:<server>:<attemptId>:<status>`。UI/OAuth ID 也存为 native details.deliveryId。Carrier content 是 native text/image array，synchronous ingress clone 原文/image bytes，异步 resource/auth 等待不得修改。

Task 在原工具请求发出前捕获 origin：`deliveryId = task:<sessionId>:<UUID>`，`anchorEntryId` 为原 leaf。它不是 server task ID；task key 为 `<server>/<taskId>`。恢复复用已保存 deliveryId/anchorEntryId，旧 pending entry 无 origin 时才在其原 record 所在 branch 创建一次新 capture。

Terminal result 在 put 前冻结 output-guard 后的 carrier：customType `mcp-task-result`、display true、content 为状态首行 + rendered text/image array；details 保留 rendered details，再加 `server`、`deliveryId`、`task:{id,server,tool,status}`，有错误再加 error。Status 为 completed/failed/cancelled/unknown（unknown 显示 outcome unknown）。不能给不同 payload 复用同一 delivery。

Session 的 Adapter-owned `mcp-task-v1` custom entries 使用 version 1：

- `pending`：sessionId/key/server/tool/reference，加可选 deliveryId/anchorEntryId/scope；reference 为 `{endpointId,generation:"v2",taskId,originalOperation}`。
- `result`：sessionId/key/server/tool/deliveryId/anchorEntryId/message，加可选 scope，保存完整冻结 carrier，先于 put 持久化。
- `accepted`：sessionId/key/deliveryId/anchorEntryId，只有 durable put 成功后记录；它不是模型消费 ACK。
- `checkpoint`：sessionId/items，items 保存本次 shutdown 尚未被 transport 接管的 pending/result records。同一条 checkpoint 覆盖多个任务，避免仅最后一条 handoff 恰好在 leaf 上时漏掉前面的任务。

Adapter 从公开 session tree 读取本包自己的 records，sessionId 必须精确匹配。`scope:"branch"` 只证明保存时仍在原 lineage；恢复还必须停在该 record/checkpoint 的**精确 leaf**，或精确返回 captured origin leaf。Record 出现在 active branch 的祖先链不够：它可能已成为新 B 的共享 ancestor。后续 user/owner entry、tree navigation 或无法证明的 crash 都不能靠旧 checkpoint 重新捕获 B 的 target。

若工作期间发生 tree navigation，且保存时不在精确原 leaf，result 和 pending handoff 都写 `scope:"origin-leaf"`：即使该 record/checkpoint 本身是 B 的 leaf，B 重启也只能 hold，不能借 B 的新 target 改投。旧 capture 若缺 scope proof，只允许精确返回 origin leaf；没有 origin 的旧 pending 只在其 record 的精确 leaf、且全树没有现代 deliveryId 已接管同 key 时创建一次 capture。无法关联的旧引用保持 held，不能在已有冻结结果或 accepted 身份之外再生成另一个 deliveryId。

Held records 不删除、不取消、不重新生成 payload。它们会触发 lazy runtime 初始化并显示提示；返回精确 origin leaf 后，Adapter 能从全树找到 off-branch records，再用同 ID/bytes 恢复。初始化和提示本身不授投递许可。

Source 根据公开 `session_tree` 判断 live lineage，不把 shutdown 退役 transport binding 当成 tree 跳转。Clean shutdown 会把仍未接受的 frozen bytes/handed-off references 合成新的 leaf checkpoint：仍 current 的保留 branch scope，已跨 tree 的改为 origin-leaf scope。它不刷新 carrier/key，也不重新取结果。若 checkpoint 写失败，原 records 仍保留，但无法证明的 branch 恢复保持 held。Checkpoint 之后又出现其他 entry，或崩溃时没有留下精确 checkpoint，也按 held 处理；这不能被推断成正常关闭。

获准恢复的 pending 只跟随已保存 reference；未 accepted 的 result 只重 put 原 bytes，不再取结果/render/执行原 tool。Accepted 后共享 mailbox 接管；同 session 全树的同 deliveryId accepted record 会抑制旧 result/pending，避免返回旧 branch 再次接管。Legacy native task outcome 仅证明该历史 task 已结束，不授权重跑。这些 entries 是本包内部恢复格式，不是给其他插件读取的 API，也不是第二套 transport outbox。

## Target、lineage 与 owner

在 UI resource/auth/task 异步工作前捕获 session target/branch anchor，等待期间不改变。Producer 请求 next-request + wake，**何时自动 run/合并 wake 由共享 transport 决定**。

每次 tree navigation 改变 generation。未接受 action 保留原 key/carrier/target，切 sibling 后 retry 可见地 hold；只有同 session slot 且 exact original leaf 回来才允许更新 target capture。共享 ancestor 不是改投 sibling 的许可。Runtime/session replacement 拒绝 retired owner，不能把迟到结果移入下一 session。

Accepted mail 归共享 mailbox，即使 source UI 关闭/producer registration 释放也不能删 mail 或重发 native carrier。Task polling/session record 是业务恢复，不是另一个 delivery owner；fork/new session 不拾取原任务。Task 取消与 unknown outcome 规则见[Tasks](servers.md#tasks)。

## ACK 与失败

App RPC 只有 put **durably accepts** 才 resolve success；storage/stale-owner 错误返回未接受。Raw postMessage 回 `ui-message-ack`，带 original deliveryId、accepted、失败 error。Trusted page 展示失败并保留 intent，Retry button 或 `{type:"ui-message-retry",deliveryId}` 复用原 intent。成功 ACK 不保证模型已读。

OAuth credentials 成功与通知 put 成功分别处理；通知接受失败显式报告，不撤销已成功 credentials，也不能假装通知已送达。Accepted mail 之后由 mailbox retry/recover，绝不重新 OAuth。

Task terminal result 只有 durable acceptance 后才可作为已提交投递处理；失败不能先标为已送达或独立唤醒 agent。Accepted terminal mail 的 duplicate/recovery 按同 ID/exact payload 判定，不能因 lost reply 再生成一个 terminal action。

## 投影前 source guard

每次检查 current runtime ready、effective configured/enabled server、project approval，以及 Apps iframe consent 是否已撤销。OAuth success 还以**当前 effective URL**实时只读 secure-store 检查；不能信任旧 capture URL/普通 process token cache，不能触发 auth/refresh/import/compact/store write/delete。Task result 也保留发起 owner/server identity 与 lineage，不因 reconnect/recovery 放宽。

Guard hold/cancel 与 transport acceptance 分层；不可用来源不能通过已接受消息恢复绕过当前安全策略。Producer close 只释放 registration，不删除 durable mail。主动 stop/logout/server shutdown 的业务取消不能改写已冻结 ID/payload 造一次新投递。

## Native proof 与兼容

Proof 要 exact match custom type、display、content、details、deliveryId；缺 proof 只能 observation，不能证明已投影。旧无 deliveryId 的 UI/OAuth custom_message 只是 history，不是新 action。旧 native volatile queue 没留下 recoverable outbox，不能编造未持久化 click/OAuth/Task result 的 import。

恢复只投原 carrier，不重放 renderer、tool、UI action、OAuth 或用户命令。Output-guard spill 的数据保留风险见[工具](tools.md#output-guard)。

## 加载与验证边界

Source-only hard dependency 从 `pi-session-inject/mailbox-v1/light` 接入；共享 process engine 到实际 mail/recovery/mailbox command 才加载。本包不额外加 command namespace/timer/Pi private seam。共享库提供的 delivery holder、存储与 `/mailbox` 不是本包复制实现。

包内用冻结 producer interface 做离线合同回归；真实 stock Pi/CC/Inject/SDK 联测在根 integration，需覆盖 load order、images、session replacement、disabled source recovery、append-before-wake crash。替身测试不能证明 native proof 或全组合联测已通过。

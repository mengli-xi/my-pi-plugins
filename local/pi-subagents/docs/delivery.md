# pi-subagents · 交付协议 V1

本文档规定 Task 结算、Completion/Inbox/Outbox、Agent Barrier、runtime-contract Wake 仲裁与已读确认。统一 mailbox 的现行 transport、stable keys、导入与 child 取消顺序见 [mailbox v1](./mailbox-v1.md)，目标 transport build 为 mailbox-v1.0.6，须配套 rebuild/fresh process；本文中旧的直接 native send/append、timeout scan、SDK resume trigger 与递增 epoch 重投描述由该合同取代，不再作为运行路径。持久化 schema 和状态有效性由 [`PERSISTENCE_FORMAT.md`](./persistence.md) 负责；可信 caller/prepare/lease 与同进程端口由 [`HOST_API.md`](./architecture.md)负责。旧 Supervisor/Owner IPC 的有效 application/ACK 约束迁入§14，唯一 SDK 无 OS transport。

## 1. 权限边界与保证

四项权限边界彼此独立：

1. package metadata journal 证明 Task、Mailbox、Completion、Inbox、Outbox、Barrier、OwnerEvent、Wake receipt 和人工已读状态。
2. 收件人的 Pi conversation 证明哪些模型可见 custom message 已实际追加。
3. `pi-runtime-contracts` 只拥有 live lease 和 Wake offer/claim/settlement。Lease handle、offer ID 和易失 claim 不是 package 的持久化事实。
4. `pi-session-inject/mailbox-v1` 是 Main/child 后台投递的唯一 native transport owner。Subagents 用 durable put 和原 carrier proof 交接；没有 active owner 时保留 pending，不直接追加或转投另一个 session。首个 Task prompt 与 compact-state 恢复投影仍由各自 execution/context owner 处理。

保证如下：

- Task、Mailbox、Completion、Inbox 和 Outbox 状态会在其来源 public operation 报告成功前持久化。
- 未取消的 accepted Mailbox 与 Completion 使用不可变 ID/hash 进行安全追加和逻辑幂等；已取消输入不再交付，不能承诺每条输入至少被模型消费。
- 每个 Completion 恰有一个 Inbox，并且恰有一条投递载体（引用它的 Outbox）：普通 Completion 是自己的 `completion-wake` Outbox，Barrier 交付的是聚合 Outbox；已 armed Barrier 的中间 Completion 暂时没有载体；已 satisfied/cancelled Barrier 最多拥有一个聚合 Outbox。
- 只有每张被引用的 Inbox card 都由其冻结 projection 证明已追加后，才会尝试 Wake。
- 对同一个 Outbox epoch，claiming Goal 或 producer fallback 二者之一会继续 parent，绝不会同时继续。仅有易失 claim 不是终态持久化证据。
- 只有 Outbox 链接上匹配的 `WakeSettlementReceiptV1`、提交 `delivered/settled` 的那一笔 metadata transaction，Outbox 才终态化。receipt 由前一笔 pending transaction 落盘，它证明这一 epoch 的 continuation owner 已经定了，但在链接之前还不是终态。
- `delivered` 证明 continuation 消息已经落盘并请求过一次 wake，不证明模型已经消费它。
- 非 foreground 的 Main 绝不会被 focus 或 resume；其 Outbox 保持 `foreground-pending`，直到该精确 Main 成为 foreground。
- 跨进程死亡不承诺物理 exactly-once append/Wake。不可变 ID 和冻结 projection 让 Completion/card 处理在逻辑上幂等。一个 epoch 最多有一个 continuation owner；若 runtime scheduling 后、receipt 前的进程死亡丢失了证明，recovery 会明确选择不丢失 Wake，并可能为相同的 `outbox_id/completion_ids` 安排之后的 epoch。若先前处理可观察，consumer 可以识别/合并该重复项，但 V1 不宣称 exactly-once model turn。

常量：

```ts
const SUBAGENT_COMPLETION_CUSTOM_TYPE = "subagent-completion-v1";
const SUBAGENT_CONTINUATION_CUSTOM_TYPE = "subagent-continuation-v1";
const SUBAGENT_MAILBOX_CUSTOM_TYPE = "subagent-mailbox-v1";
const SUBAGENT_OWNER_ID = "pi-subagents";
```

## 2. Completion 引用与结果

所有 ID 使用 `PERSISTENCE_FORMAT.md`。公开引用不携带 path 或 authority token：

```ts
interface CompletionReferenceV1 {
  version: 1;
  completion_id: string;
  agent_id: string;
  task_id: string;
  task_path: string;
  outcome: "completed" | "partial" | "blocked" | "failed" | "interrupted";
  reason:
    | "normal-final" | "finish-task" | "timeout" | "host-lost"
    | "user-interrupt" | "parent-interrupt" | "provider-error" | "tool-error"
    | "user-input-required" | "approval-required" | "runtime-crash"
    | "protocol-error" | "capability-drift" | "credential-unavailable"
    | "storage-error" | "agent-closed-force" | "main-session-ended";
  summary: string;              // deterministic normalized line, <=512 UTF-8 bytes
  completed_at: string;
}

interface PresentedCompletionReferenceV1 extends CompletionReferenceV1 {
  unread: boolean;              // query-time projection only; durable authority is Inbox
}

interface CompletionEnvelopeV1 extends CompletionReferenceV1 {
  recipient: { kind: "main" | "agent"; agent_id?: string };
  final_text: string;           // 0..65,536 UTF-8 bytes
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    total_tokens: number;
  };
  task_admitted_at: string;
  task_started_at?: string;
}
```

`summary` 在 `CompletionRecordV1` 中冻结：取 final text 的第一条非空、规范化逻辑行，合并空白符、移除 terminal/bidi control，并以 UTF-8 截断到 512 bytes，后缀为 `…`。空文本使用稳定短语 `Task <outcome>`。

显式 interrupt 为 interrupted，deadline 为 failed/timeout，force-close/main ending 对未完成 Task 使用 agent-closed-force/main-session-ended；已 settled outcome 不改。SDK 没有旧 process signal escalation reason，任意 JS 未响应只能继续 closing/fence，不能编造 runtime 已结束。新增公开 reason 必须同步 schema/codec/spec。

## 3. 仅 child 可用的 `finish_task` 与结算优先级

`finish_task` 只存在于 SDK child tool factory：

```ts
interface FinishTaskInputV1 {
  outcome: "partial" | "blocked";
  text: string;                 // 1..65,536 UTF-8 bytes
  reason?: "user-input-required" | "approval-required" | "external-prerequisite";
}

interface FinishTaskDataV1 {
  version: 1;
  task_id: string;
  state: "finish-recorded";
  outcome: "partial" | "blocked";
}
```

在返回 `terminate:true` 前，Host 会持久化首个 exact-generation `FinishDeclarationV1`，其中包含文本 digest、可选 reason、tool-call/request ID 与 runtime generation。逐字节相同的 request replay 返回同一 declaration。相互矛盾的 declaration 返回 stale-task（已有 finish declaration），且不产生 mutation；blocked 必须 reason，partial 的 reason 忽略。

`finish_task` 不创建 Completion。匹配的 `agent_settled` 或 Host recovery 采用如下 first-commit-wins 优先级：

1. 已提交的 Task settlement；
2. 阻止证明 child final state 的 storage/protocol/runtime failure → failed；
3. 持久化的 same-generation `InteractionBlockV1` → 以其 public reason blocked；
4. 已提交的显式 interrupt → interrupted；
5. 已提交的 timeout → failed/timeout；
6. 持久化的 Finish declaration → declared outcome/finish-task；
7. 终态 assistant final → completed/normal-final；
8. provider/tool 终态 error → failed/provider-error|tool-error。

`external-prerequisite` 仍只是说明性的 Finish metadata。来自 stale runtime generation 的 Finish 或 interaction 不能影响替代后的 Task。

## 4. Mailbox 准入与注入

### 4.1 Task-scoped 输入准入

public send_input 默认 busy/starting/selected queued head 绑定当前 Task，idle 才新 Task；waiting 保留原 barrier/Process wait 并申请 active activation，满位等。interrupt=true 持久中断选中 Task/取消其 input 和 barrier、新 Task 优先，其余 FIFO 保留。UI Enter=immediate 同规则，Alt+Enter=after-current 单独 FIFO 新 Task；closed/closing 拒绝，成功 durable receipt 才清 draft。

MailboxRecord 有 message_id/task_id/source/sender/recipient/sequence/body/hash；分配 sequence 及 next 递增同事务。输入不跨 Task，steer 不变 owner/lease/deadline。原生 subagent-mailbox-v1 custom_message 保存 message_id/body_sha256/injected_into/source，owner 先校验 open/当前 Task/generation 和非 cancelled event，之后用 Pi safe steer 或 grant 后的 append，native entry 可证明后才 metadata injected/ACK，模型 context observation 另提交 consumed。

### 4.2 安全投递与取消

starting/running/tool/compaction 的 accepted input 在下一个安全边界注入同 Task，普通 Enter 不能 native followUp。waiting 先取得 active grant，再注入；原 barrier/process wait 不取消，输入轮后依赖未满足回 waiting，满足信号合并。selected queued head 尚未启动时可先持久绑定 input，等待其 grant。settle 与 input 准入在 Host queue 串行；pending input 先消费再 final，settle 先胜则之后输入形成新 Task。

close/timeout/interrupt/settlement 取消相关 pending Mailbox 与 pending/sent mailbox_delivery OwnerEvent，持久 cancelled/cancelled_at、保留 sequence，ACK/cursor 跳过 terminal cancelled；send/apply/native proof 前复核，resume 永不重放到下一 Task。成功 input receipt 是“已接纳”，不是已运行/已消费；UI 等待工具/位/compact 和 cancel 状态来自持久记录。failed admission 保 draft，不重复提交。

仅内部纯 control 的 idle-conversation append 不会创建工作；public 任意 root message/send_message 接口已删除，target-root 拒绝。取消 input 不代表 card/lease delivery 取消，已经 accepted Completion/control 仍需收口。安全模型序列不能被 tool_call/custom message/tool_result 交错破坏，不能依赖 provider 修复。

## 5. Task settlement 与 Barrier 基数

一次匹配的 Task settlement 是一个 metadata transaction：

1. 冻结 outcome/reason/final text/summary/usage/timestamp；
2. 以 `lease_disposition="release-pending"` 结算 Task，并从 Agent current state 移除它；
3. 创建一个不可变 Completion；
4. 确定性地冻结一个 `CompletionCardProjectionV1`，并创建一个 Inbox `pending-append`；
5. 适用时更新 covered Barrier completion subset；
6. 根据**transaction 前的 Barrier state**执行恰好一个互斥 Outbox branch：
   - Task 未被 armed Barrier 覆盖 → 创建一个普通 `completion-wake` Outbox；
   - Task 被覆盖且不是最后一个 covered Task → 不创建 Outbox；
   - Task 被覆盖且是最后一个 covered Task → satisfy Barrier，并创建恰好一个覆盖全部有序 Completion ID（包括此次最终 Completion）的 `barrier-wake` Outbox；
7. 暴露下一条 FIFO Task 为 admitted，但不在本 transaction 中启动它。

这也是 `PERSISTENCE_FORMAT.md` settlement bullet 的必要判定方式：“不是 armed Barrier 的 intermediate member”依据 transaction 前的 coverage 测试，在最后一个 Task 将 Barrier 改为 satisfied 之前完成。因此，仍被 armed Barrier 覆盖的每一个 Task——包括最后一个 Task——都不满足 ordinary-Outbox 条件。最后一个 Task 只走 aggregate branch。实现不得把“intermediate”重解释为“final”的数学否定，也不得在 mutation Barrier state 后判定 ordinary 条件。

Barrier arm 只 snapshot 当时还没 settle 的 Task。在 arm 之前就已经 settle 的 Task 已经拿到了自己的投递载体，并且按 D-008 独立唤醒过；Barrier 不把它的 Completion 收进 `completion_ids`，聚合 Outbox 也不再引用它，否则同一个 Completion 会有两条载体。`wait_agents` 的 tool result 仍然分别报告完整 snapshot、`settled_task_ids` 与 `remaining_task_ids`，模型据此知道哪些已经完成。

Completion 按创建时 Task.owner_conversation 交付：child-origin 归 child，Main/user 给孙 Agent 新 Task 归 Main；结构 parent 不决定新 Task 的 recipient。Task 的 lease logical key 是原始 canonical Task ID；`ownerId="pi-subagents"` 提供 namespace。

提交后：

- intermediate covered Task：释放 parent lease，不 Wake；
- 有可用 parent 的 ordinary/final Barrier Task：释放并取得 Wake offer；
- non-foreground Main：不 Wake 地释放，并让 Outbox 保持 `foreground-pending`；foreground restore 创建 detached offer；
- child Task owner：持久 release_task_lease OwnerEvent 在同进程 conversation map 执行同一协议。

已 settled Task 的 lease 永不 reacquire。Outbox/Inbox state 拥有 delivery recovery。

Barrier cancellation 是一个 transaction。未来的 unfinished settlement 变为 ordinary。已经 settled 的 covered Completion 保留其 Inbox；若存在任一此类 Completion，则按其 Task order 创建恰好一个 `barrier-catch-up` Outbox。若没有，则不创建 Outbox。Replay 以 Barrier 和 wake Outbox ID 保持幂等。

## 6. 冻结的 Completion card 与 continuation projection

### 6.1 Completion card

Card bytes 在追加前被冻结到 Inbox。Delivery 绝不会使用之后的 formatter version 重新渲染。

```ts
interface CompletionMessageDetailsV1 {
  version: 1;
  completion: CompletionReferenceV1; // immutable identity/outcome; no final_text/unread
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    total_tokens: number;
  };
  task_admitted_at: string;
  task_started_at?: string;
  result_truncated: boolean;
  original_result_bytes: number;
  rendered_result_bytes: number;
  barrier?: {
    barrier_id: string;
    index: number;
    total: number;
  };
}
```

有意省略 `outbox_id`：intermediate Barrier Completion 没有 Outbox，之后的 aggregation 不能改变其冻结 bytes。完整 `final_text` 只存在于私有 `CompletionRecordV1` 和 Agent conversation；Main 只接收有界的 custom-message content。Details 是 canonical JSON，绝不重复 result text。模型可见 content 是经 XML escaping 的 plain text：

```xml
<subagent_completion version="1" completion_id="cmp_..." task_path="/root/review" outcome="completed" reason="normal-final">
  <summary>Found one race in token rotation.</summary>
  <result>...bounded final text...</result>
</subagent_completion>
```

在 settlement commit 前，确定性选择 rendered result bytes，使用匹配的 truncation counter 构造 details，并校验 `CompletionCardProjectionV1`：

- 精确 content <=71,680 UTF-8 bytes；
- 因 details 不含 result body，对于每个合法 final text，精确 canonical details JSON <=71,680 bytes；
- content/details SHA-256；
- 显式 `result_truncated`、original-result bytes、rendered-result bytes；
- 覆盖全部前置 projection field 的 projection digest。

若 markup 超出该边界，只在 UTF-8 boundary 确定性截断 rendered result，加入 `result_truncated="true" original_result_bytes="N"`，将同一 counter 复制到 details，并保留完整私有 Completion。重复证明为 `(completion_id, projection_sha256)`。相同 ID、不同 projection fail closed。即使 Main 的 card 被显式截断，`/subagents` Live 仍读取完整私有 history/result。

### 6.2 Producer continuation

Producer fallback 冻结：

```ts
interface SubagentContinuationDetailsV1 {
  version: 1;
  outbox_id: string;
  wake_epoch: number;
  completion_ids: string[];
  barrier_id?: string;
}
```

Custom type 为 `subagent-continuation-v1`，`display:false`，content <=4096 bytes：

```text
Subagent results <completion IDs> are ready. Continue from the delivered completion cards.
```

逻辑身份为 `(outbox_id,wake_epoch)`。它的 native entry ID 加上 canonical content/details digest 构成 producer-fallback continuation proof。Main recipient 在安全追加边界使用同一条隐藏 continuation 并设置 `triggerTurn=true`，因此 native entry 同时承担 proof 与实际唤醒；Pi 先 append 该 entry 再异步运行 agent loop，Subagents 会有界等待 entry 可见后发布 proof、commit Wake 并写 durable receipt。不得退化为只写 `triggerTurn=false` 的隐藏消息。

## 7. 安全追加与 Wake settlement

### 7.1 安全追加边界

Conversation execution state 为 `idle | running | retrying | compacting | settling`。只允许在以下时机追加：

- 处于 idle 时立即追加；
- 在该 generation 的 awaited `turn_end` 中追加；或
- 没有后续 `turn_end` 处理时，在/于 `agent_settled` 后追加。

`message_end` 和 tool end 是证据，不是 append boundary。不得在 tool batch 中间直接插入 package message。

### 7.2 Offer 创建与 epoch

对 ordinary/aggregate Outbox：

1. settlement Inbox/Outbox 已持久化；
2. 使用 `releaseAndOfferWake` 释放 live Task lease，或在 lease 已释放后 foreground restore 时使用 `offerWake`；
3. 仅当存在新的 runtime offer object 后，才提交 Outbox `wake_epoch + 1` 和 `wake_state="open"`；若此 metadata mutation 失败，则 abort offer 并保持在原有 durable state；
4. process recovery 绝不恢复 offer ID，也不会仅因 reset state 而递增 epoch。

一个 armed intermediate Barrier Completion 没有 Outbox/offer。其 Inbox 在 safe boundary 追加，不触发 turn。

### 7.3 Card append

对于 Outbox，先提交 `delivering`，再以 `triggerTurn:false` 追加每个缺失 Inbox 的精确冻结 content/details，并通过 native event/active-branch `(completion_id, projection_sha256)` 证明每一项。提交每个 Inbox appended proof。当所有被引用 Inbox 都已证明时，提交 Outbox `cards-appended`。

对于没有 Outbox 的 intermediate Barrier Inbox，直接执行同样的冻结 append/proof。最终 Barrier Wake 会等到每一个被引用 Inbox 都已 appended。

### 7.4 选择一个 continuation owner 并结算 runtime offer

`wake.hasClaim()` 是瞬时观察，不是锁。最终 claim observation 和 `wake.commit(...)` 之间不得发生 journal write、Pi append、event request、Promise continuation、timer 或其他 `await`。

在 `cards-appended` 时：

- **已经存在 claim：**调用 `wake.hasClaim()`，若为 true，则在同一同步 JS turn 中立即调用 `wake.commit("delivered")`。不得追加 producer continuation。Goal listener 只能为该 `delivery="delivered"` settlement 安排任务。
- **尚无 claim：**追加并验证冻结的 producer continuation。在 offer 保持 open 时，该 append 有意为异步。在最终 claim observation 前，为精确的 `(session_id, offer_id, offer_generation, outbox_id, wake_epoch)` 发布一个 process-local、不可变的 `ProducerContinuationProofV1`。随后调用 `wake.hasClaim()`，无论是否出现 late claim，均在同一同步 JS turn 中立即调用 `wake.commit("delivered")`。

Consumer 无法在最终同步 observation 与 commit 之间 replace/claim。该 observation 前已 retired 的 claim 会消失。若 producer append 期间出现 Goal claim，其 settlement listener 必须同步查询 producer proof；若找到精确已验证 continuation，则记录 settlement 但不安排另一轮 turn。因此 runtime delivery 保持 `delivered`，producer continuation 仍拥有 Wake。`wake.commit("skipped")` 保留给 recovery：它已经证明相同 continuation 已经 started/settled，与 `PERSISTENCE_FORMAT.md` 一致。

runtime commit 成功后，必须按**实际 continuation proof**而不是按易失 offer 恰好是否有 claim 来分类 durable branch：

- 本 epoch 有 active、精确 `ProducerContinuationProofV1` → `wake-settlement-pending/fallback-appended`，`settlement_kind="producer-fallback"`，即便有 late Goal claim；
- 没有 producer proof 且恰有一个有效 `GoalWakeProofV1` → `wake-settlement-pending/claimed`，`settlement_kind="goal-claimed"`；
- recovery 已证明先前 producer continuation 且 runtime 为 `skipped` → `wake-settlement-pending/fallback-appended`，`settlement_kind="producer-fallback"`；
- 本 epoch 被 claim，但 claimant 没有交出有效 receipt（D-007：Goal 被 pause/clear/complete 都会这样）→ 由 producer 在同一 epoch 补 continuation，落到 `wake-settlement-pending/fallback-appended`，`settlement_kind="producer-fallback"`；绝不伪造 Goal receipt，也绝不等 consumer 恢复；
- 其余 proof 缺失、冲突或不匹配 → Outbox 保持 nonterminal 并进入 §7.6 reconciliation；绝不从 `hasClaim()` 猜测 owner。

此 metadata transition 发生在 runtime settlement 之后。Main 的异步 Mailbox acceptance/native 观察与成功吸收按 §7.10；只有尚未被接管、也无成功证明的工作才能进入 re-offer。

### 7.5 Runtime settlement proof、精确 receipt mapping 与终态 commit

`wake.commit(...)` 同步返回向后兼容的 `WakeSettlementV1`，并扩展可选的 `consumerReceipt`，它来自 `INTEGRATION.md`。被 claim 的 Goal 的单个 `onSettledWithReceipt` provider 会先查询下文的 producer-proof registry；仅在 `state="committed" && delivery="delivered"` 且没有精确 active producer proof 时安排任务，然后在同一调用中返回经过校验的 receipt。现有普通 settlement listener 随后运行。`skipped` 仍只用于 recovery。

Producer fallback proof 是经验证的 continuation native entry identity/digest。由于该 proof 阻止 late Goal claim 安排任务，它的 transport 与 lifecycle 属于规范，而非实现细节。

```ts
const PRODUCER_CONTINUATION_PROOF_REGISTRY_V1 =
  Symbol.for("pi.subagents.producer-continuation-proof.v1");

interface ProducerContinuationProofV1 {
  version: 1;
  session_id: string;
  offer_id: string;
  offer_generation: number;
  outbox_id: string;
  wake_epoch: number;
  continuation_entry_id: string;
  continuation_sha256: string;
}

interface ProducerProofKeyV1 {
  session_id: string;
  offer_id: string;
  offer_generation: number;
}

interface ProducerProofReservationV1 {
  version: 1;
  reservation_token: string;   // 128-bit process-local opaque token
  key: ProducerProofKeyV1;
  owner_generation: number;
  activate(proof: ProducerContinuationProofV1):
    | { ok: true; proof: ProducerContinuationProofV1 }
    | { ok: false; code: "stale-reservation" | "proof-conflict" | "invalid-proof" };
  clear(): void;               // exact-token idempotent; cannot clear replacement
}

interface ProducerContinuationProofRegistryV1 {
  version: 1;
  brand: "pi-subagents-producer-continuation-proof-v1";
  reserve(input: {
    key: ProducerProofKeyV1;
    owner_token: string;
    owner_generation: number;
  }):
    | { ok: true; handle: ProducerProofReservationV1 }
    | { ok: false; code: "capacity" | "proof-conflict" | "incompatible-owner" };
  get(key: ProducerProofKeyV1): ProducerContinuationProofV1 | undefined;
}
```

`pi-subagents` 会在注册 tool 前于 `globalThis` 安装唯一的 registry implementation。`pi-goal` 只复制 symbol/interface，绝不 import package。foreign value、错误 brand/version 或冲突 proof 都不兼容。兼容 registry 缺失时，Goal 不得 claim `pi-subagents` Wake offer；它仍可 claim Processes offer。该 fail-safe 让 producer fallback 成为唯一 continuation owner，避免 late 且不可观察的 claim。

Registry 在整个 process 内最多容纳 256 个 reserved-or-active proof。Producer continuation append 前，Subagent Host 为精确 offer key reserve。Reservation failure 发生在外部 append 前：应 abort live Wake offer，并遵循 delivery-failed/reconciliation 规则，而不是在没有 proof capacity 时继续。native continuation 被 append-proven 后，以精确不可变 proof activate reservation，再执行最终的 `hasClaim()` 和同步 `wake.commit("delivered")`。`get()` 只暴露 active proof，并返回递归冻结的副本。第二次逐字节相同的 activation 是幂等的；相同 key、不同 Outbox/epoch/entry/digest 属于 `proof-conflict`，Goal 若已 claim 则保守地安排任务，允许物理重复而不丢失 Wake。

Proof key 精确为 `(session_id, offer_id, offer_generation)`；`outbox_id` 与 `wake_epoch` 也必须匹配当前 durable Outbox，Subagent Host 才接受它做 receipt classification。一个 process 可以为并发的 session/offer 持有 proof。精确 owner token/generation 会 fence reload：stale handle 不能 clear replacement proof。保持 active proof，直到匹配的 Wake receipt + Outbox terminal transaction commit、epoch 被显式 abort/reconcile，或 Pi process teardown 清空 process-local registry。不得只因 `wake.commit()` 返回就清除它。Consumer replacement 会读取同一 active proof。

Goal claimant 的同步 `onSettledWithReceipt` provider 会在 scheduling 前执行一次 `registry.get(settlement.offer key)`。恰有一个有效 match 表明 producer 已拥有 continuation：Goal 抑制 scheduling 并返回 `undefined`。不存在则 Goal 按常规安排并返回 `GoalWakeProofV1`。冲突/不兼容 registry 会被诊断；若已存在 claim，Goal 会保守安排，确保不丢 Wake。Subagent Host 在自身有精确 active proof 时，仍将 epoch 分类为 producer fallback。

Claimed Goal proof 正是通用 runtime-contract receipt，经 registry validation 后收窄：

```ts
interface GoalWakeProofV1 extends WakeConsumerReceiptV1 {
  version: 1;
  // Stable durable-receipt token; not a package or directory path.
  consumerId: "pi-goal-local";
  consumerGeneration: number;
  continuationId: string;
  scheduling: "scheduled" | "coalesced";
}
```

Goal claim handle 最多允许一个 receipt provider。它只会在仍 active 的 Goal generation 为 completion-driven continuation 同步注册/合并后返回该值。`pi-goal-local` 是为兼容已持久化 receipt 保留的稳定 token，不是 package 名或目录路径；该 token 不约束包路径。runtime-contract registry 在将其包含于 producer 返回的 settlement 前，校验 claim consumer identity/generation 和 closed bound。缺失/无效 receipt 不是 proof；producer 应走 fallback/reconciliation，绝不发起 `pi.events` request。Proof 不包含 goal/prompt/result text；`continuationId` 是 Goal 自有 opaque marker。

Receipt field 精确如下：

- **Goal claimed：**`kind="goal-claimed"`；claimant field 来自 `GoalWakeProofV1.consumerId/consumerGeneration`；`runtime_delivery` 是 runtime settlement delivery；`continuation_identity=proof.continuationId`；`continuation_sha256=SHA-256(canonicalJSON(proof))`。
- **Producer fallback：**不含 claimant field；`kind="producer-fallback"`；正常运行时 `runtime_delivery="delivered"`，只有 recovery 已证明先前 continuation 时才为 `"skipped"`；`continuation_identity` 是经验证的 native continuation entry ID；`continuation_sha256=SHA-256(canonicalJSON({ custom_type:"subagent-continuation-v1", content, details }))` 针对精确冻结 bytes 计算。

在校验 branch-specific proof 和 runtime settlement 后，Host 执行两笔 metadata transaction。

**pending transaction**：

1. 分配一个 receipt ID，按上面的 field 规则创建精确 `WakeSettlementReceiptV1` 并落盘；
2. 把 Outbox 改成 `state="wake-settlement-pending"`、`wake_state="claimed"|"fallback-appended"`，写入匹配的 settlement kind；
3. 这一笔不写 `settlement_proof_id`：receipt 已经在 store 里，Outbox 还没链接它，`delivered` 还不成立。

**terminal transaction**：

1. 取这一 `(outbox_id, wake_epoch)` 已经落盘的那份 receipt，绝不写第二份；
2. 把 Outbox 改成 `state="delivered", wake_state="settled"`；
3. 写入 receipt ID、`settlement_proof_sha256=SHA-256(canonicalJSON(receipt excluding record_revision))` 与 delivered timestamp。

分两笔而不是只在终态那一笔写 receipt，是因为这一 epoch 的 owner 证据活不过进程：Goal receipt 只在 registry 的 `commit` 内部产生一次，producer proof 只活在 process-local registry 里。owner 一定下来就先把它落盘，终态事务失败、甚至进程直接死掉之后，下一个边界和重开 store 的 recovery 才有一份不必重新 offer 就能收尾的事实。每个 `(outbox_id, wake_epoch)` 至多一份 receipt，这条不变量由 `PERSISTENCE_FORMAT.md §7.7` 保证。老 store 里写在这条规则之前的 `wake-settlement-pending` 记录没有 receipt，终态事务照旧补写一份。

Goal-claimed terminalization 要求 runtime `delivery="delivered"`。Producer fallback 在正常运行时使用 `delivered`，包括同步 producer proof 抑制 Goal scheduling 的 late-claim 情形。它只在 recovery 证明同一 continuation 已 started/settled 时使用 `skipped`。其他任何路径不得使用 `skipped`。

只有 Outbox 链接上 receipt 的那一笔 transaction 才是 crash 后的 durable terminal evidence。落盘的 receipt 证明这一 epoch 的 continuation owner 已经定了，但在 Outbox 链接它之前还不是终态；process-local claim、fallback append 或 runtime-contract commit 单独存在更不是。

### 7.6 缺失 proof 与 receipt 前崩溃

若 process 在 runtime settlement 后、terminal transaction 前退出，recovery 先检查 §7.10 的 Main handled/accepted 事实；其余路径：

1. 校验所有冻结 Inbox card 和任何 producer continuation；
2. 这一 `(outbox_id, wake_epoch)` 已经有落盘 receipt 的 `wake-settlement-pending`，直接补最后那一笔链接，变成 `delivered`——owner 在 `wake.commit(...)` 时就定了，重投只会让 Goal 第二次被触发或者让 producer 追加第二条 continuation。这条 Outbox 的 card 由 receipt 证明，不因 transcript 证据缺失退回 `pending-append`；
3. 其余 nonterminal `open|claimed|fallback-appended`（含老 store 里没有 receipt 的 `wake-settlement-pending`）重置到最早可证明的 `cards-appended/not-offered` state；
4. 创建新的 runtime offer，然后递增到新 epoch；
5. 再次允许 Goal claim 或 producer fallback。

当 runtime settlement 已成功但 Goal proof 缺失/无效，或 receipt persistence 失败时，同一 process 不得等待 restart。它记录 degraded integration/storage health，并保持 epoch nonterminal。仅在 Goal-consumer replacement、Main binding replacement、显式 `/subagents` delivery retry，或 integration/storage recovery boundary 时尝试 reconciliation——绝不依赖 polling timer。

一次 reconciliation 边界逐条 Outbox 隔离：一条 Outbox 的证据冲突不许饿死同一轮里其它 Outbox 的投递。真正的冲突（同 epoch 两条 continuation、同 entry 异 bytes、receipt 与落盘证据矛盾）进 bounded diagnostics ring，不静默吞掉；「暂时没有前台 append authority」和「这一 epoch 还证不出 owner」是推迟而不是故障，只记进这一轮的结果，等下一个边界再来，既不写 `delivery-failed`，也不当作 degraded health。`delivery-failed` 目前只有 card append 耗尽 attempt 这一条写入路径（§9.1），规范所称的显式 retry 入口尚未落地，因此这个状态当下等于永久隔离。Reconciliation 扫描 card/continuation：已经有对得上原 entry 身份（`outbox_id` + **当前 durable** `wake_epoch`）的 continuation 就直接拿它终态化，否则若 Main 的原 fallback 已 accepted 就等待 native；仅未被接管的工作创建 detached offer，在 offer 创建后分配 epoch，并重新运行 §§7.4–7.5。Main 的原 accepted key 保留 epoch。取证必须精确到当前 epoch：重开归一重投之后，同一条 Outbox 在 branch 上留下多个 epoch 的 continuation 是本节允许的物理重复，旧 epoch 的 entry 既不能给新 epoch 出 receipt，也不该让新 epoch 被判成重复；同一 epoch 出现两条，或出现比 durable epoch 还新的 epoch，才是矛盾，fail closed。同 process 的重试不把 `open` 一律 reset 成 `not-offered` 再追加——那会丢掉「这一 epoch 已经开过」这件事；只有重开 store 的 recovery 才做这次归一。

被 claim 却缺 receipt 不走 reconciliation，而是**当场由 producer 接管这一 epoch**（D-007）。consumer receipt 只在 registry 的 `commit` 内部产生，所以这条路径的合法顺序是固定的：先在 commit 之前取一次 `hasClaim()`（commit 会把 offer 置成 committed 并移出 session 表，之后 `hasClaim()` 恒为 false），再 `commit("delivered")`，再看 `consumerReceipt`。没有有效 receipt 就按 §7.4 reserve producer proof、在安全追加边界追加 `triggerTurn` continuation、activate proof，然后照常 `markOutboxWakeSettled` + `terminalizeOutbox`。commit 已经终态化该 offer，之后没有任何 consumer 能再 claim 它，因此这条补充不会产生第二个 continuation owner。Card 已经证明追加，绝不重发。

未被 claim 的 fresh offer 仍按 §7.5 在 commit **之前** activate proof，这样 append 窗口里出现的 late claim 才能同步查到它而不再 schedule。两条路径的差别只在 proof activate 与 commit 的先后，而这个先后由「receipt 何时可观察」决定。

暂停 Goal 只停 Goal 自己的推进，不是新的通知屏蔽开关：「先 pause 再完成」与「claim 之后才 pause」两条路径结果一致，都是一条合法的 producer 通知 turn，Goal 保持 paused。清除 Goal 同理（D-009）：Goal 不是后台任务的生命周期 owner，Goal 不存在或已被清除都不改变投递，结果通知的仍是原会话，不等下一个 Goal 出现。

producer 的 append/prove/activate 任一步失败时，必须释放已经 reserve 的 proof 容量并 abort 这个 runtime offer，否则 proof 表被占住、offer 停在 claimed/open，durable Outbox 就再没有第二次机会。失败后 Outbox 停在 `cards-appended/open`，由**下一个正常 reconcile 边界**（Main binding 替换、`session_start`、`agent_settled`）重试一次，不必等重启：先按原 entry 身份（`outbox_id` + 当前 durable `wake_epoch`，也就是 native entry 的识别键）在 active branch 上找已经物理追加过的 continuation——prove 失败不代表没 append 过，找到就用那一条终态化（那条 entry 已经落盘并请求过一次 trigger，再追加就是第二条通知；append 只证明消息落盘与请求 wake，不证明模型已经消费），找不到时，Main 已 accepted 的原 key 返回 waiting-native，不重写 open；未接管的失败才用 §7.2 detached offer。同一条 Outbox 同时只有一个结算者：Task settlement 与 reconcile 是两个入口，正在结算的那一条 Outbox 不接受并发重试，否则会追加出第二条 continuation。一次边界只重试一次，没有 poller，也没有立即重试循环；Main mailbox import 恢复保留原 open/epoch；其余旧同步投递由 recovery 归一。

一个 epoch 一旦创建过 offer（`wake_epoch > 0`），该 Task lease 就已经在同一笔 `open` transaction 里提交成 `released`。之后的每一次 re-offer 都只能用 §7.2 的 detached `registry.offerWake(...)`，不得再尝试释放一个已经不存在的 lease。

`wake_epoch` 不是 lease 是否还在的唯一判据。`releaseAndOfferWake` 先释放易失 lease，紧接着的 `open` transaction 才递增 epoch；这一笔 transaction 失败时 offer 已经 abort，Outbox 退回 `cards-appended/not-offered` 且 `wake_epoch` 仍是 0，可是那个 lease handle 已经没了，进程内不会自己回来。此时重放 release 只会永久抛「Task lease Wake authority is unavailable」，把这条 durable 的 `release-pending` 卡死。所以选 offer 方式时按**本进程是否仍持有该 root Task lease**判断：仍持有就 `releaseAndOfferWake`，已经不持有（epoch 已递增，或 epoch 为 0 但 handle 已释放）就用 detached `offerWake` 在下一个正常边界补投一次，随后成功的 `open` transaction 会把 lease disposition 提交成 `released`。

终态事务失败留下的 `wake-settlement-pending` 同样在下一个正常边界收尾，而不是等重启：这一 epoch 的 continuation owner 在 `wake.commit(...)` 时就已经定了，pending 事务已经把它连同 receipt 落盘，恢复只补最后那一笔链接，不重投也不重新 append。两种 kind 都走这一条：取这一 `(outbox_id, wake_epoch)` 的 receipt 链接成 `delivered`，`fallback-appended` 在终态事务提交后才归还 proof reservation，`claimed` 绝不补 producer continuation、也绝不伪造 proof 去顶替原 claimant。

老 store 里没有 receipt 的 `wake-settlement-pending` 保持旧行为：`fallback-appended` 还能认原 `(outbox_id, wake_epoch)` 的 native continuation entry，重算冻结 projection 校验 digest 后终态化；`claimed` 的 receipt 只在 registry `commit` 内部产生一次，进程里已经不存在第二份，只能保持 nonterminal，交给重开 store 的 step 3 归一重投。

这可能在不可证明的 crash window 后物理安排重复 continuation；不可变 Completion/Outbox identity 让它在逻辑上幂等。这优于永久丢失 Wake。

### 7.7 Foreground 与 child parent

- foreground Main 执行 §§7.2–7.5；
- non-foreground Main 保持 `foreground-pending`，不 append/Wake，并在 scan/offer 前恢复 exact owner；
- busy Main 等待 safe boundary；绝不 abort current work；
- child Task owner 接收 durable OwnerEvent，在同进程本地执行 lease/append/claim/fallback/receipt；application/native/registry proof 先由 Host 验证并持久化、Outbox receipt 收口，之后 ACK。SDK child 当前无 Goal consumer，不宣传任意插件 claim 兼容。

### 7.8 State / owner / 证据 / 恢复边界对照表

一条 Outbox 在任一时刻只有一个 owner，只有一份跨重启的证据。下表是 §§7.2–7.6 的收敛结论，字段组合以 `PERSISTENCE_FORMAT.md §7.7` 为准。

| durable state | 这一步的 owner | 跨重启的证据 | 一次失败后的下一个合法边界 |
|---|---|---|---|
| `pending` / `delivering` | journal（Outbox 记录本身） | Outbox + Inbox 记录；已 append 的 card 由 `(completion_id, projection_sha256)` 证明 | 下一个 reconcile 边界继续 append/prove；重开时 `delivering` 归一回 `pending` |
| `cards-appended` / `not-offered` | journal；lease registry 可能还持有 live lease | card 已 appended；`wake_epoch` 记录已经开过几次 offer | 仍持有 lease 就 `releaseAndOfferWake`，否则 §7.2 的 detached offer；`open` 事务同时把 settled Task 的 lease disposition 提交成 `released` |
| `cards-appended` / `open` | 原 offer；Main 已接管 carrier 的投递归 A | 原 epoch、冻结 Mail acceptance、可选 continuation_native | 原 native 已到就链接 Wake receipt；已 accepted 无 native 就等待，不 re-offer；持久 Main 全体成功优先进入 handled |
| `wake-settlement-pending` / `claimed` \| `fallback-appended` | 已经定下来的 continuation owner（Goal claimant 或 producer） | **落盘的 `WakeSettlementReceiptV1`**（`kind`、claimant、`continuation_identity`、`continuation_sha256`）；producer proof 仍 active 但只在进程内 | 下一个边界或重开 recovery 把这份 receipt 链接成 `delivered`，不重投、不重新 append；老 store 没有 receipt 才回落到原 entry 取证或归一重投 |
| `delivered` / `settled` | 无（终态） | Outbox 链接的 receipt + `settlement_proof_sha256` | 绝不再 offer。它证明消息落盘并请求过一次 wake，不证明模型已经消费；模型是否处理过由 §7.9 的 `turn_settlement` 另记 |
| `handled` / `settled`（Main 专用） | Main 成功 run owner | handling_proof 的全体 card/marker/assistant 精确证明 | 原 card import、已 accepted continuation cancel；不新建 Wake，无 Wake receipt 或 turn_settlement |
| `delivery-failed` | 无 writer（当前只有 §9.1 的 card failure 路径） | `last_error_code` + `correlation_id`，`wake_state="aborted"` | 规范所称显式 retry 尚未实现，当下等于永久隔离 |

进程内那张结算表只放两件事：谁在结算这一条 Outbox（同时只允许一个），以及这一 epoch 还没被终态事务收走的 producer proof reservation。结算证据不在里面——`wake.commit(...)` 一定下 owner，pending 事务就把 receipt 落盘了。proof 的归还时机固定三个：终态事务提交、这一 epoch 被显式 reconcile/abort、Pi process teardown。Main binding 被替换和 Goal 被 pause/clear 都不归还（替换后的 consumer 还要看到同一份 active proof），也不设 TTL、不靠 poller。

### 7.9 Turn settlement：owner 级「模型是否处理过」

`delivered/settled` 只证明消息落盘并请求过一次 wake，不证明模型处理过这批 card。是否处理过由 Outbox 上的 `turn_settlement`
（`PERSISTENCE_FORMAT.md §7.7`）另记。它是 D-007R 要求的 owner 待处理状态，不是 provider exactly-once：

- **写 pending**：终态事务把 Outbox 链接成 `delivered` 时，同一笔事务写下 `turn_settlement = { wake_epoch, continuation_identity（这一 epoch receipt 的
  continuation）, state: "pending", pending_at }`；重开 store 的 recovery 用落盘 receipt 补链接成 `delivered` 时同样写 pending。
- **翻 settled**：Main 侧 owner 只记三件事：一轮 `context` 里出现过哪些 completion card（按 `details.inbox_id`，一轮多次请求取并集）、这一轮是否失败
  （`agent_end` 最后一条 assistant 是 aborted/error、没有 assistant，或 signal 已 abort）、以及成功轮次处理过的 card。pending Outbox 的**全部** card 都在
  成功轮次处理过，才提交 `settle-outbox-turn` 把它翻成 settled，身份精确匹配 `(wake_epoch, continuation_identity)`；abort、error、没带 card 的轮次、
  别的 epoch 或 continuation 都不结算。
- **边界**：结算只发生在既有边界（`agent_settled`、投递终态之后、reconcile 之后），按 Main 串行，没有 poller、timer，不发消息、不触发模型请求。
  处理过的 card 跨 run 保留：终态事务与它触发的模型 run 并发，run 先 settled 时 pending 还不存在，留到下一个边界结算。
- **重开**：pending 只被恢复、被观察（`binding.host.snapshot()` 里的 Outbox 记录），不自动重投、不重发 card/continuation、不重跑 Task；下一次普通 prompt
  带着 branch 上已有的 card 成功 settled 后结算，再重开就是 settled。
- **旧记录**：没有 `turn_settlement` 的 delivered Outbox 一律不猜，也永远不会被这里改写。

### 7.10 Main Mailbox：ACK、机会与成功

三个事实分别持久：A recorded notice + D native 接收事务说明「载体已记录」；A fulfilled receipt 说明「载体获得成功 assistant 请求机会」；
Main owner 的 `subagent-main-run-completed-v1` 说明「整轮成功处理了这些 cards」。toolUse 后 abort 只能保留机会，不能变成业务成功。
receipt/card 按精确 native ID、原 bytes、scope、assistant 与 branch 顺序连接，可以跨 card/Outbox key；无关合法 receipt 跳过，malformed 或身份冲突不授权。

recorded callback 只补本 mail 的 Inbox/native continuation 事实；terminal callback 只确认已接收的 native 或原 source 取消授权。
两者不运行全局 reconcile、不要求 delivered、不 await turn settlement、不依赖 sibling hold。guard 只读，fallback 规划回到独立 driver。
A ready/rebuild 是索引屏障；ACK replay 与投递独立，坏 key 不封锁整个 producer，用户 recovery-held 仍按 key 保留。
同 key/payload put 可重查 guard，但无变化 put/proof/cancel/import/schedule 不重放通知；无进展队列必须排空。source delivered 后用原 prefix recheck 重评 wake；有界 driver 运行期间到达的新事实合并为下一 pass，不得被 single-flight 吞掉。

Main 在 per-Outbox driver 中先检查持久成功证明，再开 offer。owner 在原 fsync/settle FIFO 内导出 `handling_proof`，Host writer 验证
原 Main、epoch 和全体 native-proven cards，提交 `cards-appended → handled/settled`。可以先补 epoch=0 的 card proof，不能为收口增加 epoch；
尚有 release-pending lease 时无 Wake 释放并同事务标 released。Barrier 可由多份成功 run 覆盖，不强制同一 assistant。
已有 Wake receipt 的 pending 必须先链接 delivered，再走 turn settlement；已有 delivered 保持原结构，不能丢弃 claimant/producer owner 证明。

handled 的 card guard 为 project=true/wake=false，通过原 importFulfilled 收口；只有已 accepted 的冗余 continuation 用原 key cancel，
没有 native 不等于取消失败，也不创建 successor 来满足旧 schema。epoch 0 的旧 native card 即使没有 A admission，也通过原 card key 的 importFulfilled 生成真实 receipt，不造 Outbox epoch 或 fallback。已提交 native/control 继续归 A 追踪。handled 已 commit 而 import/cancel 未完成时，
重开按同 key/epoch 续作；A 已写 receipt/tombstone 则重放同 terminalId。源持久事实相同的 ACK 是零 journal 写入。

原 fallback 已 accepted、尚无 native 时，DeliveryPending 是 waiting-native，释放当前有界 offer/reservation 后等待，不重新 offer、不重复写 open。
continuation native ACK 在 Outbox 暂存 `{wake_epoch,entry_id,sha256}`；原 Wake receipt 接管同一精确证据后移除此字段。
Goal claim、producer active proof、beforeRun 预留机会、防双 owner、cancelled/shared carrier 投影规则均保持不变。

Main Inbox 满足已读与业务退休后，checkpoint 还须批量确认 A 全部相关原 key 已 ACK/GC、有精确磁盘 receipt，再回收；成功、已读、onTerminal 返回或 terminal 尚在都不替代退休。此判定也用于删除、冷 importer 与热态跳过，覆盖 card/outbox epoch-prefix/continuation/shared carrier。
D 不再保存 completedMailPasses 或 complete 结果缓存。直接按 A 的 pending、terminal、带 receipt 见证的缺席、unknown 四类处理；热态只复用已验证的不可变 receipt 索引，checkpoint/删除始终 fresh 重读。已合法回收 Inbox 的 source 由原 receipt 识别，unknown 或未附着继续保留。

## 8. Runtime-contract 与 Goal 集成

使用当前 `pi-runtime-contracts/continuation-v1` 方法：

```ts
lease.releaseWithoutWake(...)
lease.releaseAndOfferWake(...)
registry.offerWake(...)
wake.hasClaim()
wake.commit("delivered" | "skipped" | "delivery-failed")
wake.abort(message)
```

Lease 结果：completed/partial/blocked → ready；failed → failed；interrupted/cancelled prepare → cancelled。

Goal 集成必须：

- 检查所有 current-session blocking owner，包括 Goal start 前已 admitted 的 lease；
- claim Subagent offer 前校验 producer-proof registry；若缺失/不兼容，则让这些 offer 保持 unclaimed，使 producer fallback 具有权威；
- matching Goal active 时 claim 支持的 Process/Subagent offer；
- 对 `delivery="delivered"` 的 committed settlement，独立于 `remainingBlocking` 安排 completion continuation；忽略 `delivery="skipped"` 的 scheduling；
- scheduling 前，按精确 settlement offer key 同步查询 registry；有效精确 proof 会抑制 Goal scheduling，缺失则走常规 scheduling，existing claim 后发生 conflict 时保守 scheduling，同时 diagnostics 保留 invariant breach；
- 只有 Goal 实际 schedule/coalesce 后，`onSettledWithReceipt` 才返回 `GoalWakeProofV1`，`commit()` 向 producer 返回该精确已验证 receipt；
- 在那一 turn 后，ordinary Goal continuation 前重新检查 surviving lease；
- 在一个 safe point 合并多个 completion offer，同时为每个 offer 保留一个 proof；
- replacement 时 retire 旧 consumer claim；
- 只在 Goal config 中拥有 `backgroundWaitCheckInMs`。

`delivery-failed` 绝不 Wake Goal。只有 recovery 证明相同 continuation identity 已 started/settled 时，才接受 `skipped` 做 producer fallback。普通 late claim 仍 commit `delivered`；同步 producer proof 阻止 Goal scheduling。Goal-claimed receipt 总是使用 `delivered`；其余所有情况保持 nonterminal。

## 9. 封闭状态转换、retry 与 crash table

### 9.1 Durable transition

```text
Inbox:
  pending-append → appended

Outbox:
  pending → delivering → cards-appended
                         ├→ wake-settlement-pending → delivered
                         └→ handled (Main persistent success; no new Wake)
       └───────────────→ delivery-failed → pending (explicit retry only)

  wake-settlement-pending 已经带着落盘的 WakeSettlementReceiptV1；
  delivered 那一笔只把 settlement_proof_id 链接上去，不写第二份 receipt。
  delivered 的 turn_settlement 只能同一身份从 pending 翻成 settled（§7.9）；
  delivered/handled 可接收首次精确 continuation_native 观察，已存在的观察与 handling_proof 不可改写。

Wake:
  not-offered | foreground-pending
      → open → claimed → settled
             ├→ fallback-appended → settled
             └→ aborted
```

`consumer-deferred` 只保留旧格式读取兼容。它没有写入路径；codec 仍能读出旧 store 里的这个值，recovery 在打开时把它归一成 `not-offered` 并丢掉 `wake_deferral`，下一个边界按正常流程重投一次。

有效 field combination 精确由 `PERSISTENCE_FORMAT.md §7.7` 定义。`wake_epoch` 只在创建新 offer object 后递增。`delivered` 要求同一 metadata transaction 中有匹配 Wake receipt。

Outbox creation 将 `delivery_attempts=0`。每个已提交的 `pending → delivering` transition 恰好递增一次。该 attempt 内对 card append/proof 的 retry、safe-boundary waiting、branch reconciliation 和从 `cards-appended` 重建 Wake offer 都不递增。`delivery-failed → pending` 不递增；下一次 `pending → delivering` 才递增。

立即进行的 idle append/proof 可在 250 ms、1 s、4 s 后 retry，且每次前扫描不可变 ID。active-generation queued append 在 `turn_end`、`agent_settled` 或 binding retirement 时 reconcile，而不是通过 timer polling。

若 card append/proof 在 live Wake transaction 存在时耗尽 attempt，必须先关闭 runtime authority，再记录 durable failure：

1. 调用 `wake.abort(sanitizedReason)`；
2. 对该精确 offer epoch 要求 `WakeSettlementV1(state="aborted")`；
3. 提交含 error 与 correlation 的 Outbox `delivery-failed/wake_state="aborted"`；
4. 若 abort 返回 stale-handle/already-settled/error，不得宣称 failure 已 closed——应在 closed recovery boundary reconcile 精确 epoch 和 native identity；
5. 在显式 retry 扫描不可变 ID 并提交 `delivery-failed → pending` 前，绝不创建 replacement offer。

任何 offer 存在前的 card failure 提交 `delivery-failed/not-offered`；non-foreground parent 可保持 `delivery-failed/foreground-pending`。runtime commit success 后缺少 Goal proof 或 receipt persistence failure **不是**普通 delivery failure：应保留 nonterminal settlement state 并使用 §7.6 reconciliation；被 claim 却没有 receipt 的那一种按 §7.6 当场转成 producer fallback。`wake.commit()` error/stale settlement 同样进入 exact-epoch reconciliation，而不是 mutation retry。

三次 immediate attempt 均失败后，应用上述规则并暴露 degraded health/correlation。只在 new binding、显式 `/subagents` retry 或 storage/runtime recovery 时 retry，且 reset 前必须 scan。

### 9.2 Crash/failure table

| 时点 | Durable evidence | Recovery |
|---|---|---|
| Task settlement commit 前 | 无 Completion | 不交付 |
| settlement 后、lease release 前 | Completion/Inbox/(可能有 Outbox)，release-pending | 绝不 reacquire settled Task；恢复 Inbox/Outbox delivery |
| Inbox update 前的 intermediate Barrier card append | 可能已有 native card，无 Outbox | scan frozen projection；mark appended 或 reappend |
| offer object 后、epoch/open commit 前 | 仅 volatile offer | 若仍 live 则 abort；restart 从 prior state 创建 fresh offer |
| open commit 后、card append 前 | Outbox open/pending 或 delivering | 旧 offer 在 crash 后消失；scan card 后创建新 epoch |
| card append 后、Inbox update 前 | 可能已有 native card | scan `(completion_id,projection_sha256)` |
| live offer 下 card append/proof 耗尽 retry | open/claimed runtime offer、incomplete card | abort exact offer，再 commit delivery-failed/aborted；不确定 abort 进入 epoch reconciliation |
| 所有 Inbox append 后、cards-appended commit 前 | card 已物理证明 | reconcile 后 commit cards-appended |
| claim observation 后、同步 runtime commit 前 | 该 interval 不允许 async operation | 同一 JS turn commit；任何抛出的 invariant 保持 nonterminal state |
| claimant 已 commit 但没有交出 receipt | card 已证明；无 continuation、无 receipt | 同一 epoch 转 producer fallback：append continuation 并 commit delivered；不伪造 receipt，不等 consumer 恢复 |
| producer append/prove/activate 抛错 | 可能无 continuation；proof 已 reserve | 释放 reservation、abort offer；Outbox 停在 cards-appended/open，下一个正常 reconcile 边界按原 entry 身份（当前 durable epoch）去重后重试一次（认到已追加的 continuation 就用它终态化），重开后仍按 §7.6 归一重投 |
| proof 已 activate 但 `wake.commit()` 失败 | native continuation 可能已落盘；这一 offer 已经死了 | 立刻归还这一 offer key 的 proof 容量（registry 只有 256 格，死 offer 不许占着），Outbox 停在 cards-appended/open 等下一个边界 |
| fallback append 期间出现 late Goal claim | native continuation 与 process-local producer proof 存在 | commit delivered；Goal 同步看到 proof，不安排任务 |
| fallback append 后、runtime commit 前 | 可能已有 native continuation | scan 精确 `(outbox_id,epoch)`；reoffer、republish proof 并 commit delivered；仅 recovery-proven prior continuation 使用 skipped |
| runtime commit 后、pending transaction 前 | runtime settlement 易失；fallback/Goal 可能已 schedule | 这一窗口没有任何 durable 证据：reoffer 新 epoch，允许逻辑重复（Goal 可能被第二次触发，producer 可能追加第二条 continuation） |
| lease 已 release、`open` transaction commit 失败 | Outbox cards-appended/not-offered、`wake_epoch` 0；Task 仍是 release-pending，易失 lease handle 已消失 | 下一个正常 reconcile 边界用 §7.2 的 detached offer 补投一次，不重放已经消失的 lease；成功的 `open` transaction 把 lease disposition 提交成 released |
| pending transaction 后、terminal transaction 前 | receipt 已落盘，Outbox 还没链接它 | 同进程的下一个边界与重开 store 的 recovery 都取这份 receipt 链接成 delivered：不重投、不重新 append、不再触发 Goal，终态提交后归还 proof reservation |
| 老 store 的 wake-settlement-pending（写在 pending 事务落 receipt 之前） | branch/proof 可能存在但没有 receipt | `fallback-appended` 用原 `(outbox_id,wake_epoch)` 的 native continuation entry 终态化；`claimed` 证不出 owner，保持 nonterminal，由重开 store 归一重投新 epoch |
| receipt+delivered commit 后 | 匹配 durable receipt 和 Outbox settled | 绝不 reoffer |
| 物理重复 card/continuation | 相同不可变 ID/digest | 逻辑合并；计入 diagnostic |
| 矛盾 ID/digest | 冲突 bytes | fail delivery closed |
| binding/session switch | stale binding 无 authority | Main ending 先 force-close 旧树，detached append 拒绝，accepted delivery 保留 foreground-pending |

Outbox/Wake receipt 会一直保留，直到 checkpoint retention 证明所有 Inbox 已 appended、Outbox 已 delivered/settled，且没有 Barrier/delete operation 引用它们。

### 9.3 模型可见 append safe point

Completion card 与 producer-fallback continuation message 都是普通模型可见 Pi custom message。当收件人的 active branch 含有未 resolved assistant tool call 时，**不得**追加它们。

对 Main recipient，当前 binding 等待 `agent_settled`，验证自己仍拥有 session，并验证 `ctx.isIdle()`。随后只检查 active branch 尾部当前 assistant batch：除 `error`/`aborted` 外，带 tool call 的 assistant 必须已有匹配的 tool result；`error`/`aborted` assistant 已终态，其流中残留但未执行的 tool-call block 不产生待配对 result，也不能永久阻塞后续 Completion。更早的未配对历史同样不属于当前 append boundary。若 binding 在等待时 detach，该 attempt 停止，durable Outbox 仍可由 replacement binding retry。若 native append 后、metadata proof 前发生 crash，则以 Inbox/Outbox identity 复用精确匹配的 native entry，绝不追加重复项。

对 Agent recipient，parent runtime 处于 running/starting/settling 时，settlement 只创建 durable Outbox。只有 parent runtime 到达 `waiting` 或 `idle` 后，AgentHost 才综合生成 `completion_delivery` 与 `release_task_lease` OwnerEvent。OwnerEvent sequencing 阻止后续 event 越过 deferred completion event。Mailbox delivery 仍独立地以 Pi safe-steered 方式进行。

不得依赖 provider adapter 或 Gateway 修复无效的 `tool_call → custom user message → tool_result` sequence。Provider-side duplicate-result suppression 仅是防御性措施，不是语义修复。

### 9.4 SDK owner application 与等待激活

唯一 SDK 直接应用 durable OwnerEvent，不复制 Inbox/Outbox/WakeReceipt 状态机。ChildEventProcessor 缓存 application result 直到 ACK；Host 按 event ID/sequence/generation/payload hash/caller 验证，提交后才 persisted。application 已提交但 response 丢失重放原 proof；ACK 失败只补 ACK，绝不再次 release lease/Wake。cancelled input 不参与 replay。

waiting 输入/依赖满足先 active activation grant，Task/generation/start/deadline/owner/lease 不变，原 barrier/process wait 保留。无位仍 waiting，输入轮结束未满足回 waiting；不是 FIFO 新 Task。未 release child lease/未 ACK owner control 保留控制清理权，SDK open 无 LRU/eviction，view 本身不阻塞后续 Task。

正常 settlement 仅公开 agent_settled；compaction start/end 只改 compaction 状态。shutdown 先持久 closing/取消 input，awaitabort/prompt/public idle/control drain 再 dispose，不以 runtime.dispose 或 assistant tail 作正常完成 proof。

## 10. Interaction/approval blocking

对于 child `select|confirm|input|editor` 或被识别的 approval request，Host 首先提交 same-generation `InteractionBlockV1`，包含 request ID、kind、public reason、title hash、饱和 count 与 timestamp。随后才回复 `cancelled:true` 并通过公开 SDK ctx.abort()/runtime interrupt 取消当前 run。匹配 settlement 使用 §3 的优先级。

并发 request 更新第一个 block 和 count；绝不存储额外 raw choice/default/secret。fire-and-forget notify/status/widget 不创建 block。normal final 或 Finish 不能覆盖已提交 Interaction block。用户 decision 经显式 resume 后 send_input 或 UI 新 Task 返回，旧 blocked Task 不重跑。

## 11. 已读确认与删除

Unread 是独立 appended Inbox ID 集合，和 model consumption/turn settlement 无关。Host markCompletionsRead({receipts,at})核验 Inbox ID、Completion ID、projection digest、对应 native entry，首次 ui_read_at/revision 不可改；空/错/混合 invalid 或写失败保 unread。

当前 D 协调规则：native init/theme/draft 成功后 onLoaded 清目标 Agent 自产 Completion 活动标记（无论 Inbox recipient）；不清它收到的 descendant 卡片。点击 Completion 只清精确 card，以现有 TextOpener=true 作为打开证明，CC panel mount async，不能称精确 viewport 呈现。close/resume/选行/loading/stale/error/render 测量/scroll 不标读。用户规则最终确认边界见 UI_SPEC，未加 CC private viewport 或 onPresented。

subtree delete 有显式确认/revision guard，可包括 unread；已完成但仍 open 的子树必须先 close/drain，未收口不 tombstone/delete，关闭后重新核验 revision 与下述投递条件。仍必须所有 Inbox appended、Outbox 有 receipt 且 delivered/settled，或 Main 有 handling_proof 且 handled/settled、无 pending/sent OwnerEvent、armed barrier、prepared operation 或 unfinished cleanup。cancelled OwnerEvent 为 terminal，不能仅因它保留 sequence 拒绝 deletion；其它未收口 delivery 不能丢。close 只释放 execution，不删 history/unread，不等同 delete。

删除入口还只读检查本次子树涉及的 Main Outbox：A 的公开 snapshot 无相关 pending/terminal 债，原 card 有同 session/branch/native/assistant 的磁盘 fulfilled receipt。delivered 与 handled 共用此准入，不影响无关 Outbox。原 Main 未附着、证据未知或 A 尚在收尾时明确返回「还有投递在收尾，稍后再删」，正常收尾后无需新的业务转换即可删除；不添加持久字段、回调或 timer。

## 12. 模型 context 与 compaction

Completion 与 Mailbox message 是原生模型可见 Pi history。package context adapter：

- 校验 V1 details 和冻结 projection/body digest；
- 通过不可变 ID 合并逐字节相同的物理重复项；
- 绝不丢弃不同 Completion/Mailbox ID；
- 将矛盾或 malformed package message 当作 inert sanitized text，并降级 health；
- 保留 Pi compaction 和 tool-call/result semantics；
- 绝不只因 Magic Context 或 Pi compaction 从当前 model context 移除了旧项目而重新交付。

Delivery proof 是 native active-branch/latest-compaction lineage 加 durable Inbox state。Mailbox body tombstone 还需要如 persistence 所定义的后续 package checkpoint。

## 13. 必需测试

### Finish、interaction 与 Mailbox

- 每个 precedence branch 和 same-revision race；
- 完整的 `FinishDeclarationV1` digest/reason/request/runtime generation、相同与矛盾 replay；
- cancel/abort 前 durable Interaction、并发 dialog、stale generation、normal-final race；
- busy/starting/queued/waiting/closed 输入、same-Task steer/FIFO/replacement、owner/lease/deadline 保持与零非预期 model run；
- per-conversation sequence/quota、task 与 idle `injected_into`、reconnect proof、consumed/tombstone lineage。

### Completion projection 与 Barrier

- 确定性的 `CompletionCardProjectionV1` bytes/digest、精确 71,680-byte edge、最坏 JSON/XML escaping 和 UTF-8 truncation；details 省略完整 result text，且不可变 Completion envelope 不含 query-time unread flag；
- formatter/version/config change 后 retry 仍使用冻结 bytes；
- 互斥 settlement branch 证明 ordinary Completion 有 Inbox+ordinary Outbox，intermediate Barrier 只有 Inbox，最终 Barrier 恰有一个有序 aggregate Outbox；cancel catch-up 最多有一个 aggregate Outbox；
- 相同 projection 的重复 card 会合并；矛盾 projection fail closed。

### Wake 与 Goal

- 每个有效 Outbox/Wake state pair 和每个无效 pair；
- 成功 offer 恰好递增一次 epoch；仅 recovery reset 不递增；耗尽的 card delivery 在 durable delivery-failed 前 abort 精确 live offer，且绝不与 replacement offer 重叠；
- claimed Goal 和 producer fallback 各自产生精确映射的 Wake receipt field 和一个 terminal Outbox transaction；
- claim observation 与 runtime commit 之间没有 await；fallback 在 append 前 reserve proof capacity，在 native append 后 activate 精确 proof，late-claim path commit delivered，同时同步 registry 阻止 Goal scheduling；skipped 仍仅用于 recovery；
- durable branch classification 遵循实际 Producer/Goal proof，绝不遵循 claim presence；proof registry capacity/conflict/reload fencing 和 cleanup 遵循 §7.5；
- Goal proof request/reply 拒绝无 response、重复 response、错误 offer/generation、stale Goal，或 schedule 前的 proof；缺失 proof 只能在 closed same-process boundary recovery；
- claiming consumer 在 open→commit 窗口里失去 active 状态（`/goal pause`、`/goal clear`、complete）时：card 保持恰好一张、恰好一条 producer 通知 turn、Outbox 终态化为 `producer-fallback`/`delivered` 且不带 claimant field，Task 不重跑、continuation 不重放；跨退出重开原 session 保持终态、不重复消费；replacement session 不得 claim 或收到旧 scope 的 Wake；会话里根本没有 consumer 时 producer 行为不变；
- `delivery_attempts` 只在已提交 pending→delivering 时递增，Wake retry 使用 epoch；
- 同时存在的 Process/Subagent offer 相互独立；无关 lease 不抑制 completion Wake；Process continuation 等待 active 位超过 30 秒仍保留合法等待，watchdog 不得误判 record-only，cancel/close/timeout 后不能迟到触发；
- non-current Main 绝不 steal focus；nested child proof/ACK 只在 local delivery 后 terminalize Host Outbox。

### 故障注入

在 §9.2 的每一行前后注入故障，包含 journal sync、Pi append proof、offer creation、epoch commit、claim/fallback selection、runtime commit、Goal proof reply、Wake receipt transaction、binding replacement 与 model start。断言没有丢失 Completion、没有无 receipt 的 terminal Outbox、不会 reacquire settled Task lease、不会 replay provider work，并且只有明确不可避免的 crash window 才存在逻辑重复 continuation。

## 14. 同进程 OwnerEvent application 与 ACK

### 14.1 Identity 与应用证明

ChildEventV1={eventSequence,payload:{eventId,eventKind,eventPayloadSha256,payload}}。envelope 只接受这四 key，payload.kind 与 eventKind 一致。result 共同 fence 为 eventId/eventSequence/eventPayloadSha256/runtimeGeneration，Host 还复核 caller/target/record state；payload hash 是持久 canonical payload_json 的 hash。same-ID 同 digest 重放幂等，矛盾 reuse 拒绝。事件通过同进程 ChildEventPort apply/ack，不声明旧 binary frame、nonce 或 fd ABI。

Host 验证 native/registry evidence 并 journal commit、返回 persisted:true 后，processor 才 ack({eventSequence,appliedEventIds})。#applications cache 在 result 已生成时保存，未 persisted 重试同 result，persisted 仅补 ACK；ACK 不能承担 application proof。release/Wake proof 直到持久 receipt 收口才释放 reservation，ACK 失败不重复 release、offer 或 receipt。重启 cache 丢失以 durableevent/receipt/native ID 对账，不自动重跑 provider。

| event kind | application 持久成功/ACK 前条件 |
|---|---|
| confirm_task_commit | Task/operation/public-result digest 与 exact logical key 已 commit，conversation 实际 lease map 匹配 |
| acquire_task_lease | operation/task/key/expiry/token hash 关联、正确 owner 会话的实际 handle proof，prepare phase=lease-proved 已 sync |
| release_task_lease settled-task | 冻结 Inbox card 全部 appended；no-Wake lease proof，或 Wake runtime settlement + durable receipt +Outbox 终态已提交；聚合 leaseReleases 末项才 Wake |
| release_task_lease abort-prepared | 原 operation/caller/digest/task/key/source generation 与 release result 完全匹配，aborted receipt 持久；不能从 token hash 猜 lease 或 commit |
| mailbox_delivery | 当前 open/Task/generation 且非 cancelled；body/hash/chunk/native message ID 一致，metadata injected/consumed proof 已 commit |
| completion_delivery | 精确 Inbox/Completion/projection/native entry，所有 chunk cards proof 和最终 cards-appended 提交 |
| barrier_cancelled | 本地等待移除；catch-up 所需 Inbox appends/Outbox receipt 终态已证明；未实现 handler 不能伪 ACK |
| prepare_shutdown | 旧 generation 准确，activeLeaseTaskIds/pendingOwnerRequestIds 的 flush/reconciliation；不得发 replacement |
| owner_health | 最新有界 code/health 应用，不包含 secret/path/prompt；旧 generation 值合并 |

### 14.2 连续 sequence、取消与 replacement

sequence 在 target conversation 单调，event 分配/next 递增同 transaction。pending 无 generation，sent 绑定当代；ACK 覆盖 cursor 之后连续 same-generation sent IDs 且 application proof 完成，不能越 pending/gap/另 generation。Task input 取消将 pending/sent mailbox_delivery 变 cancelled/cancelled_at，取消是 terminal 而非 application 成功；保留 sequence，连续 acked/cancelled 前缀推进 cursor，ACK 跳过 cancelled，不发送、不 apply、不在 resume 重放。

replacement 保留 event IDs/sequence/immutable payload；合法可重放 sent→pending 时清 target generation，下次实际发送绑定新 generation。input 先检查 current Task/lifecycle；cancelled/旧 Task 永不重投。confirm 只对已 commit Task、acquire 只对仍需 lease 的 prepare、release 持续到 receipt 终态；completion 按 Inbox ID/projection 恢复。prepare_shutdown 只属于旧 generation，health 合并。checkpoint 只有 terminal 且 sequence≤cursor、无 Task/lease/prepare/delivery 引用才能删；live TTL 不能抹掉已经获取但未补偿的 lease。

### 14.3 有界 chunk、预算和 event-driven 恢复

Completion 窗口身份是 ordered (inboxId,projectionSha256) tuples 的 canonical hash，chunkSha256 校验 items 完整 bytes；Mailbox items 含 messageId/body/bodySha256/injectedInto/source?，chunk hash 按实际 canonical items，native 证明精确 ID/hash。数据 items 为 1..256，但还须满足 payload≤1MiB 和 journal TransactionPut（payload_json 再次 escape）≤1MiB；没有 OS frame 预算。单 card 内容/details 有 71680-byte 上限，单 input body≤65536 bytes；超限在分配 event 前 fail closed。

每 target 未 terminal event 上限 1024/4MiB，预留 128 records/1MiB 给 commit、lease release/shutdown/故障控制；每 Main maxPendingDeliveryBytesPerMain 可能更低，以最低预算为准。数据不能耗尽 reserved 控制位；控制/lease/Completion 事实不能丢。预算满只标 unavailable 并拒绝新工作，已 accepted delivery 保留。

synthesizer 在 Host queue 依 settlement/recovery/owner-ready/ACK/budget-release 触发，不 polling：从 pending-append Inbox 选择最早 recipient，排除 appended 或已有 live window 引用；按确定性 Task/Completion 顺序只分配下一窗口，ACK 释放预算后继续。全部 card appends 证明后才生成 release/barrier 控制 event，dedupe key 是 recipient+ordered IDs/digests 或 task/outbox/delivery revision。settlement 可以先有 Inbox/lease-release intent 而尚无 OwnerEvent；恢复用这些 durable 事实补生成，不能搁置 Completion。Mailbox 同样按 pending sequence 滑动窗口，cancelled 不入窗口。

### 14.4 关闭顺序与双提交域

close intent 和取消先 metadata commit，再 abort/drain；取消旧 input 与保留 Completion/lease/control 不同。关闭按叶节点取消未启动 Task、abort/drain/dispose 当前 runtime，结算剩余 Task、释放所属 Task lease 并 drain 必需 owner control，再提交 closed；仍未投递的 durable Inbox/Outbox 可以保留待 Main/owner 后续 reconcile，close 不等同 delivered 或 delete。每次实际 Wake 交付仍必须按 card proof→runtime settlement→pending receipt→Outbox link→ACK 的顺序，不能为关闭伪造 receipt。js 未响应则 closing/cleanup_pending，不提前释放 active/open 或伪造 receipt。Main ending 取消新 prepare/grant，晚 callback 只对旧 generation 收口。

native JSONL 和 metadata journal 是两个提交域：append 成功但 proof 前 crash 要按 immutable ID/digest scan，逻辑幂等；runtime Wake 成功但 pending receipt 前死亡可有 later duplicate epoch，不能称物理 exactly-once。pending transaction 已写 receipt 而 Outbox 未链接，recovery 只补 link、不重新 offer。Wake 投递成功与下一 model turn 确实处理 cards、人工 ui_read 三事实独立，沿§7.9 turn_settlement 精确 identity 记录。

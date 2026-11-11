# pi-subagents · 持久化存储格式 V1

本文档是 `pi-subagents` V1 唯一的规范性持久格式契约。它取代 `architecture.md` 中的临时文件草图。产品行为、同进程 Host 端口与投递时序分别由 FEATURE/Host/Delivery 负责；本文档定义哪些内容会被持久记录、元数据变更在何时提交，以及恢复如何证明某个状态。

## 1. 权威来源与不变量

三类权威来源被有意分离：

1. 每个 Main 的 **metadata journal** 是 Agents、Tasks、Mailboxes、Barriers、Completions、Inbox/Outbox 投递状态、Owner events、operation/Wake receipts、cleanup 以及 read acknowledgements 唯一的提交顺序。
2. 每个 Agent 的原生 Pi `session.jsonl` 是唯一的会话权威来源。metadata store 会记录其身份与位置，但绝不会复制其 transcript。
3. `pi-runtime-contracts` 是进程内的运行时权威来源。store 只持久化一个 `LeaseIntentV1`；lease IDs、lease generations、handles 和 Wake-offer IDs 都不是持久事实。

checkpoint 是 journal 前缀的一个经过验证的缓存。独立的 JSON 文件绝不会被视为若干次 rename 共同构成了一个事务。一个事务只有在其有效的 `tx-commit` frame 被持久化后才是公开的。`hostRevision` 每提交一个事务就严格增加一，且它是一个 Main store 内所有实体的排序权威。

每次提交和恢复之后都必须满足以下不变量：

- 一个 Main session 只独占一个 store 和一棵 Agent 树；
- 每个 Agent 由一个不可变的 Agent ID 和 Task path 标识；同级 Task name 唯一；
- 每个未 settled 的 Task 都有一个持久的 lease intent；每个已 settled 的 Task 都有 `leaseDisposition = "release-pending" | "released"`；
- 一个 Agent 最多只有一个当前 Task 和若干 FIFO 排队 Task；
- 一个 coordinator conversation 最多只有一个已 armed 的 Barrier；
- 一个 Task 最多只有一个 Completion；
- 每个 Completion 都恰好有一个接收方 Inbox；
- 每个 Completion 恰好有一条投递载体，也就是恰好一个引用它的 Outbox：未被已 armed Barrier 覆盖时是自己的普通 `completion-wake` Outbox，或者是交付过它的 `barrier-wake`/`barrier-catch-up` 聚合 Outbox；被已 armed Barrier 覆盖的中间 Completion 暂时没有载体，等最后一个覆盖 Task 才拿到聚合 Outbox。载体按 Outbox 实际引用判定，不按当前那一条 Barrier 记录：一个 conversation 只保留最新 Barrier，旧 Barrier 被顶替之后它交付过的 Completion 仍然只有那一条聚合载体。一个已 satisfied 的 Barrier 恰好拥有一个 `barrier-wake` Outbox；一个已 cancelled 且其覆盖 Completion 已经 settled 的 Barrier 恰好拥有一个 `barrier-catch-up` Outbox；
- 每个未 terminal 的 owner-control event 在其准确 target conversation 分区恰有一条持久 OwnerEvent；
- 没有任何记录会引用缺失且未 tombstoned 的父级或实体；
- 原生会话文件只有一个 writer：prepare 时创建 seed，open 后由唯一 SDK SessionManager 持有，关闭 drain/dispose 后释放；历史 view 用 in-memory manager，只读原文件；
- 被复制出来的 Main transcript 引用、Task path 或 filesystem path 不授予任何权威。

## 2. 支持平台与信任边界

V1 store 支持 macOS 和 Linux 上的一个受信任本地 OS 用户。它不是 sandbox、多用户数据库，也不是防篡改审计日志。不存在网络监听器。文件在静态存储时不做应用层加密；控制手段是 current-UID 所有权和私有文件系统权限模式。

所有目录遍历都使用 `lstat`；symlinks、sockets、devices、FIFOs 以及意外条目一律 fail closed。目录必须由当前 UID 拥有，且权限位不能超出 `0700`；常规文件必须属于 current-UID，且权限位不能超出 `0600`。新文件在可用时使用 `O_CREAT | O_EXCL | O_NOFOLLOW` 和 `0600` 模式创建。在 `O_NOFOLLOW` 不可用的地方，代码必须先 `lstat`，再 open，再 `fstat`，并在使用前比较 device/inode。每个被替换的文件都必须在同一目录内写入、`fsync`、rename，然后对其所在目录执行 `fsync`。

原始 Main session IDs 和 Task names 永远不能成为路径组件。经过验证的不透明 Agent/transaction IDs 可以使用，因为它们的 grammar 在下文是封闭定义的。

## 3. IDs、时钟与规范值

### 3.1 IDs

生产环境 ID 使用 128 位 CSPRNG bit，采用无 padding 的 base64url（22 个字符），并带有以下前缀：

```ts
type AgentId = `agt_${string}`;
type TaskId = `tsk_${string}`;
type MessageId = `msg_${string}`;
type BarrierId = `bar_${string}`;
type CompletionId = `cmp_${string}`;
type InboxId = `inb_${string}`;
type OutboxId = `out_${string}`;
type OwnerEventId = `evt_${string}`;
type TransactionId = `txn_${string}`;
type ReceiptId = `rcp_${string}`;
type CleanupId = `cln_${string}`;
```

后缀必须匹配 `[A-Za-z0-9_-]{22}`。生成后，必须检查当前 journal 状态、prepared 目录、conversation 目录以及保留的 Agent tombstones。最多重试八次碰撞；第九次碰撞即为 `[subagent/id-generation-failed]`，且不得产生任何变更。Agent IDs 在机制上永不复用，因为 tombstones 会保留每一个退役的 Agent ID。其他 128-bit IDs 要对所有 live/prepared/retained 记录做检查，并在其记录被 compact 掉之后依赖 CSPRNG 的抗碰撞性；V1 不保留一个无界的历史集合，也不声称对这些 ID 提供可机械证明的永久不复用。IDs 不携带任何时间顺序或权威。

`mainKey` 定义为：

```text
main_ + first 32 base64url characters of
SHA-256("pi-subagents/main-key/v1\0" + exact UTF-8 Main session ID)
```

`owner.json` 会存储精确的私有 Main session ID 和完整的 SHA-256 digest，因此理论上的截断键碰撞会 fail closed，而不是把两个 stores 合并起来。

### 3.2 时间与排序

持久时间戳使用 UTC ISO-8601，且精确到毫秒（`YYYY-MM-DDTHH:mm:ss.sssZ`），并且必须能够通过 `Date.parse` 往返。deadline 和 duration 使用整数 Unix 毫秒。wall clock 不建立排序关系；`hostRevision`、`admissionOrder`、mailbox sequence 以及 journal frame sequence 才建立排序关系。

`admissionOrder` 是一个正的安全整数，在每个 Main store 内全局单调，并且只为每个 Task 分配一次。Mailbox `sequence` 在 tombstone compaction 之前对每个接收 conversation 都必须是正且连续的。record revision 是正的安全整数，并且等于提交该记录时的 `hostRevision`。

### 3.3 规范 JSON 与摘要

所有 package JSON 值都必须是普通对象、数组、布尔值、字符串、null 或安全整数。非整数、负零、`NaN`、无穷大、accessors、继承而来的键以及未知字段都是无效的。字符串必须是合法 UTF-8，并拒绝 NUL/C0/C1/bidi 展示控制字符，除非某个字段显式存储 model-visible text；model-visible text 可以包含普通换行，但绝不能包含无效 Unicode。

规范 JSON 会按 UTF-8 字节序升序递归排序对象键，不输出无意义空白，使用 JSON 字符串转义，并保持数组顺序。除非明确指定为某个字节文件的摘要，SHA-256 摘要都是对精确规范 UTF-8 字节计算得到的小写 64 位十六进制。每个 parser 在构造领域值之前，都必须执行精确键校验。

## 4. 封闭的文件系统布局

根路径由公开 agent-dir 定位为：

```text
<agent-dir>/pi-subagents/store-v2/
  owner.json
  mains/
    <mainKey>/
      owner.json
      CURRENT
      writer.lock/
        owner.json
      checkpoints/
        cp_<16-hex-generation>/
          manifest.json
          root.json
          agents/
            <agentId>.json
      journals/
        jr_<16-hex-generation>.bin
      prepared/
        <transactionId>/
          prepare.json
          abort.json                 # only during explicit abort cleanup
          artifacts/...
      conversations/
        <agentId>/
          session.jsonl
          system-prompt.txt
      trash/
        <cleanupId>/...
      recovery/
        <timestamp>-<transactionId>.tail
```

只有与上述精确 grammar 匹配的名称才是合法的。`owner.json`、`CURRENT`、checkpoint files、journal files 和 prepared records 都由 package 拥有。`session.jsonl` 是 Pi-native JSONL。`recovery/` 只包含被保留下来的损坏或截断尾部；它绝不会被解析为状态。diagnostics 位于该 store 之外，路径由 `maintenance.md` 定义。

`store-v2/owner.json`:

```ts
interface StoreRootMarkerV1 {
  format: "pi-subagents-store";
  version: 1;
  install_nonce: string;       // 256-bit base64url, 43 chars
  created_at: string;
}
```

每个 Main 的 `owner.json`：

```ts
interface MainOwnerV1 {
  version: 1;
  main_key: string;
  main_session_id: string;     // private, 1..512 UTF-8 bytes, no controls
  main_session_sha256: string;
  created_at: string;
}
```

新 namespace 为 store-v2，但 marker/codec/checkpoint entity version 仍 1（代码 STORE_VERSION=1），journal anchor 为 3（§14），不是 schemaVersion 2 的配置 version。没有 v1 reader/转换；旧存储不读、不转换、不删除。

这两个 marker 本身都不授予权威。活动中的 Pi binding 必须提供完全相同的 Main session ID，并且获取 writer lock。

## 5. 单 writer 锁

一个 Main store 在跨 Pi 进程时只允许一个 AgentHost writer。获取方式是原子创建 `writer.lock/` 目录，模式为 `0700`，然后创建 `writer.lock/owner.json`，模式为 `0600`：

```ts
interface WriterLockOwnerV1 {
  version: 1;
  pid: number;                 // positive safe integer
  process_nonce: string;       // 256-bit base64url
  host_nonce: string;          // 256-bit base64url
  acquired_at: string;
}
```

reload 先 force-close 旧 Main 树；process service 可以复用该 Main metadata Host/锁，但旧 execution 与新准入必须按 binding/ending fence 隔离。第二个进程会以 `[subagent/store-locked]` 失败，且不会读取 conversations 或变更状态。新进程只有在 lock 目录或 marker 通过全部 UID/mode/no-symlink 检查，并且 `kill(pid, 0)` 返回 `ESRCH` 时，才允许 reclaim。`EPERM`、仍存活或被复用的 PID、格式异常的证据，或任何意外条目，都要保守失败。reclaim 会把旧目录 rename 为一个经过验证且唯一的同级名称，创建新锁，然后移除旧的同级目录；它绝不会 unlink 一个未经检查的路径。

每个 metadata transaction、checkpoint 和 logical deletion 都必须在这个锁以及进程内 FIFO mutex 之下串行化。原生 `session.jsonl` 写入不使用这个 metadata lock；native 单 writer 由 AgentHost/SDK runtime generation 单独保证。

唯一 SDK 使用单 writer lock；live runtime 的 native writer 也保持唯一。store-v2 持久 profile.settings_snapshot/delegation_max_depth，codec version 仍 1，不读 store-v1。显式 resume 重用 native session/profile 并增长 generation，零请求；cold recovery 关闭 ownerless Agent，不从 assistant tail 猜测成功，不自动重放模型或工具。

## 6. Current pointer、checkpoints 与规范化状态

### 6.0 空 Main-store 初始化

在验证或创建 package root，并获取新的 Main writer lock 之后，按以下方式初始化 generation 1，且不能暴露一个部分完成的 store：

1. write/sync `owner.json`，并 sync Main 目录；
2. 创建 `checkpoints/cp_0000000000000001/`，其中包含一个空的 `RootCheckpointV1`，其 `host_revision=0`、`next_admission_order=1`、两个 next-sequence counter 都为 `1`、`last_owner_event_acked_sequence=0`、数组为空且没有 Barrier；写入其 manifest，并令 `last_journal_sequence=0`；然后 sync files/directories；
3. 创建 `journals/jr_0000000000000001.bin`，其中包含 sequence 1 的 `JournalAnchorV1(checkpoint_revision=0)`，并完成 sync；
4. write/sync `CURRENT.tmp`，rename 为 `CURRENT`，并 sync Main 目录；
5. 在允许 admission 之前，重新打开并验证完整的 pointer/checkpoint/journal。

在 `CURRENT` 存在之前，Main store 没有任何权威。crash 只会留下一个封闭布局下的不完整初始化：下一个 owner 会验证 marker/lock，仅移除那些未被有效 `CURRENT` 引用的 generation-1 artifacts，然后重新开始初始化。如果 `CURRENT` 已存在但验证失败，则适用普通损坏策略；初始化绝不会覆盖它。generation/revision 零只对这个空 checkpoint 合法；持久化的 entity record revision 仍然必须为正。

`CURRENT` 是规范 JSON，并在 checkpoint 切换时以原子方式替换：

```ts
interface CurrentPointerV1 {
  version: 1;
  checkpoint_generation: number;
  journal_generation: number;
}
```

generation 是正的安全整数，并映射到 16 字符小写十六进制文件名。被指向的 checkpoint 和 journal 必须都存在且通过验证。未被引用的较新 generation 属于不完整的维护 artifacts，可以在验证后移除；它们绝不能仅凭文件名顺序获胜。

### 6.1 Checkpoint manifest

```ts
interface FileDescriptorV1 {
  file: string;                // basename/closed relative path only
  bytes: number;
  sha256: string;
}

interface AgentCheckpointDescriptorV1 extends FileDescriptorV1 {
  agent_id: AgentId;
}

interface CheckpointManifestV1 {
  version: 1;
  main_key: string;
  generation: number;
  host_revision: number;
  last_journal_sequence: number;
  created_at: string;
  root: FileDescriptorV1;      // exactly "root.json"
  agents: AgentCheckpointDescriptorV1[]; // Agent ID ascending
  state_sha256: string;        // SHA-256 of canonical descriptor array
}
```

每个 descriptor 的 size 和 digest 都必须在解析前检查。`state_sha256` 必须精确等于 `SHA-256(canonicalJSON({ root, agents }))`：其中 `root` 是完整的 `FileDescriptorV1`，`agents` 是按 `agent_id` 排序后的完整 `AgentCheckpointDescriptorV1[]`，并且每个 `file` 都是相对于 checkpoint 目录的 POSIX 路径（`root.json` 或 `agents/<agentId>.json`）。manifest 的 generation、Host revision、journal sequence 和 timestamps 都不参与这个 digest。`JournalAnchorV1.checkpoint_state_sha256` 必须与之逐字节相等。

`last_journal_sequence` 是在 checkpoint materialization 之前已经提交的、最高的已验证 frame sequence。新的 journal anchor 必须精确使用 `last_journal_sequence + 1`，之后的 frame 连续递增，并且 frame sequence 在同一个 Main store 的不同 journal generation 之间绝不能重置。`manifest.json` 本身是规范 JSON，且最大为 1 MiB。一个 checkpoint generation 不能包含 symlink 或额外文件。

### 6.2 Root 与 Agent checkpoint 分区

```ts
interface RootCheckpointV1 {
  version: 1;
  main_key: string;
  host_revision: number;
  next_admission_order: number;
  next_mailbox_sequence: number;
  next_owner_event_sequence: number;
  last_owner_event_acked_sequence: number;
  agent_ids: AgentId[];
  mailbox: MailboxRecordV1[];         // recipient is Main
  inbox: InboxRecordV1[];             // completion recipient is Main
  outbox: OutboxRecordV1[];           // Main-owned ordinary/Barrier wakes
  owner_events: OwnerEventRecordV1[]; // target conversation is Main
  barrier?: BarrierRecordV1;          // owner is Main
  operation_receipts: OperationReceiptV1[];
  wake_receipts: WakeSettlementReceiptV1[];
  cleanup: CleanupRecordV1[];
  tombstones: SubtreeTombstoneV1[];
}

interface AgentCheckpointV1 {
  version: 1;
  host_revision: number;
  agent: AgentRecordV1;
  tasks: TaskRecordV1[];
  mailbox: MailboxRecordV1[];
  barrier?: BarrierRecordV1;          // owner is this Agent
  completions: CompletionRecordV1[];  // produced by this Agent
  inbox: InboxRecordV1[];             // recipient is this Agent
  outbox: OutboxRecordV1[];           // produced/owned by this Agent
  owner_events: OwnerEventRecordV1[]; // target conversation is this Agent
  operation_receipts: OperationReceiptV1[];
  wake_receipts: WakeSettlementReceiptV1[];
}
```

数组顺序必须是确定性的：Tasks 按 `admission_order`，mailbox 按 sequence，Owner events 按 event sequence，Completion/Inbox/Outbox 先按 creation revision 再按 ID，receipts 按 creation revision，Agent IDs 按词法顺序。Root 存储接收方、owner 或 source 为 Main conversation 的记录；Agent 分区存储接收方、owner 或 source 为该 Agent 的记录，但 Completion 始终留在其生产该 Completion 的 Agent 分区中。每个 `WakeSettlementReceiptV1` 都与其引用的 Outbox 共同放在同一个 Root 或 Agent checkpoint 分区中。分区规则必须是确定性的；任何实体都不能出现在两个文件中。checkpoint 文件可以达到配置的 metadata 上限，但每个被解析的值仍然必须遵守实体和计数边界。

checkpoint 的 `root.json` 是完整的 `RootCheckpointV1`。journal 里的 Root 记录只带 Root 头（`RootHeaderV1`，见 §8），Root 的各个集合只随各自实体的 put/delete 变化；这样 Root 的 Inbox、receipts 随长会话增长时，单个 journal frame 不会跟着变大。

## 7. 持久实体 schema

### 7.1 通用引用与 frozen profile

```ts
interface ConversationRefV1 {
  kind: "main" | "agent";
  session_id: string;
  agent_id?: AgentId; // required iff kind="agent"
}

interface LeaseIntentV1 {
  api_version: 1;
  session_id: string;
  owner_id: "pi-subagents";
  logical_key: TaskId;
  reason: string;               // safe single line, <=512 UTF-8 bytes
}

type ReasoningEffortV1 =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface RoleSnapshotV1 {
  name: string;
  source: "built-in" | "user" | "project";
  provenance: string;           // private canonical provenance, <=1024 bytes
  body: string;                 // <=60000 UTF-8 bytes
  sha256: string;
}

interface ExecutionFactoryProofV1 {
  version: 1;
  canonical_path: string;
  sha256: string;
  exports: string[];
}
interface BuiltinExtensionProofV1 { version: 1; pi_version: string }

interface CapabilityEntryV1 {
  builtin_proof?: BuiltinExtensionProofV1;
  execution_factory?: ExecutionFactoryProofV1; // legacy read only
  child_factory?: import("pi-runtime-contracts/child-capabilities-v1").ChildFactoryProofV1;
  factory_required?: boolean;
  sdk_provider?: import("pi-session-runtime/sdk-provider").SdkProviderProofV1;
  owner: string;
  main_entrypoint: string;
  child_entrypoint: string;
  tools: string[];
  providers: string[];
  hooks: string[];
  sha256: string;
}

interface CapabilitySnapshotV1 {
  version: 1;
  fingerprint: string;
  active_tools: string[];
  tool_definitions: Array<{ name:string; definition_sha256:string; owner_id?:string }>; // same sorted names/order
  entries: CapabilityEntryV1[]; // canonical child load order, <=64
}

interface FrozenProfileV1 {
  settings_snapshot: ReturnType<ExtensionAPI["getSettings"]>; // allowlisted public settings
  delegation_max_depth: 1 | 2;
  version: 1;
  role: RoleSnapshotV1;
  provider: string;
  model: string;
  model_scope: string[]; // frozen canonical provider/model IDs
  reasoning_effort: ReasoningEffortV1;
  service_tier?: string;
  task_timeout_ms: number;      // 60000..86400000
  cwd: string;                  // private absolute path
  project_trusted: boolean;
  system_prompt_options_sha256: string;
  prompt_assembler_version: 1;
  system_prompt_relative_path: string; // exactly "conversations/<agentId>/system-prompt.txt"
  system_prompt_bytes: number;         // 1..1048576
  system_prompt_sha256: string;
  capabilities: CapabilitySnapshotV1;
  created_at: string;
}
```

所有 proof 及 `factory_required` 都进入能力指纹。`builtin_proof` 核对 canonical Pi.VERSION，不读物理文件；`child_factory` 冻结普通 factory 声明和创建时 context，格式只定义在 [child 合同](../../pi-runtime-contracts/docs/child-capabilities-v1.md)；`execution_factory` 只保留旧记录读取，不作为新装配依据；`sdk_provider` 保存独立 grant 对应的完整批准证明（见 [SDK provider](sdk-providers.md)）。旧 profile 缺 proof 仍能读历史，但不能补授权执行。Capability/path 语义由 [架构合同](architecture.md) 定义；persistence 会验证其封闭的序列化形状和 digests，但不会重新发现 capabilities。

### 7.2 Agent

```ts
type AgentAvailabilityReasonV1 =
  | "capability-drift" | "credential-unavailable" | "model-unavailable"
  | "role-unavailable" | "runtime-unavailable" | "protocol-incompatible"
  | "storage-corrupt" | "storage-capacity" | "conversation-corrupt";

interface ConversationRecordV1 {
  session_id: string;
  relative_path: string;        // exactly "conversations/<agentId>/session.jsonl"
  initial_bytes: number;
  initial_sha256: string;
  last_validated_bytes: number;
  last_validated_mtime_ms: number;
  last_validated_leaf_id?: string;
}

interface AgentRecordV1 {
  lifecycle: "open" | "closing" | "closed";
  lifecycle_revision: number;
  runtime_generation: number; // non-negative; assembly/close/recovery fencing increases it
  closed_at?: string;
  close_reason?: string;
  version: 1;
  record_revision: number;
  agent_id: AgentId;
  parent_agent_id?: AgentId;    // absent for depth 1
  parent_conversation: ConversationRefV1;
  task_name: string;
  task_path: string;
  depth: 1 | 2;
  created_at: string;
  created_revision: number;
  profile: FrozenProfileV1;
  conversation: ConversationRecordV1;
  availability: "available" | "unavailable";
  unavailable_reason?: AgentAvailabilityReasonV1;
  unavailable_detail?: string;  // sanitized <=512 bytes
  current_task_id?: TaskId;
  queued_task_ids: TaskId[];    // FIFO, unique
  next_mailbox_sequence: number;
  next_owner_event_sequence: number;
  last_owner_event_acked_sequence: number;
}
```

如果 `availability="available"`，则 unavailable 字段必须不存在。runtime 对象不是持久事实；lifecycle/runtime_generation 是持久 fence，没有 PID。closed 必须有 closed_at/close_reason；closing 的 close_reason 是关闭 intent，closed_at 表示最终收口，closing 仍保留 cleanup 义务和 open 名额。`current_task_id` 引用一个未 settled 的 Task；queued IDs 引用 phase=admitted 的 Tasks，集合必须完全一致；普通 FIFO 按 admission_order，但 interrupt replacement 可优先插入，不能要求 queue 顺序永远等于原 admission_order。

### 7.3 Task

```ts
type TaskOriginV1 = "initial" | "follow-up" | "continuation";
type TaskPhaseV1 = "admitted" | "starting" | "running" | "waiting" | "settled";
type TaskOutcomeV1 = "completed" | "partial" | "blocked" | "failed" | "interrupted";
type TaskReasonV1 =
  | "normal-final" | "finish-task" | "timeout" | "host-lost"
  | "user-interrupt" | "parent-interrupt" | "provider-error" | "tool-error"
  | "user-input-required" | "approval-required" | "runtime-crash"
  | "protocol-error" | "capability-drift" | "credential-unavailable"
  | "storage-error" | "agent-closed-force" | "main-session-ended";

interface FinishDeclarationV1 {
  outcome: "partial" | "blocked";
  text: string;                 // 1..65536 UTF-8 bytes
  text_sha256: string;
  reason?: "user-input-required" | "approval-required" | "external-prerequisite";
  declared_at: string;
  tool_call_id: string;
  request_id: string;
  runtime_generation: number;
}

interface InteractionBlockV1 {
  runtime_generation: number;
  first_request_id: string;
  kind: "select" | "confirm" | "input" | "editor" | "approval";
  public_reason: "user-input-required" | "approval-required";
  title_sha256: string;
  count: number;                // saturating 1..32
  additional_requests_truncated: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

interface TaskUsageSnapshotV1 { input_tokens:number; output_tokens:number; cache_read_tokens:number; cache_write_tokens:number; total_tokens:number }

interface TaskRecordV1 {
  initiator: { kind: "user" | "main-model" | "agent-model"; conversation: ConversationRefV1 };
  owner_conversation: ConversationRefV1;
  version: 1;
  record_revision: number;
  task_id: TaskId;
  agent_id: AgentId;
  origin: TaskOriginV1;
  admission_order: number;
  message: string;              // 1..65536 UTF-8 bytes
  phase: TaskPhaseV1;
  admitted_at: string;
  started_at?: string;
  deadline_at_ms?: number;
  waiting_on?: { kind: "process" | "agent-barrier"; key: string };
  runtime_generation?: number;
  interrupt_requested_at?: string;
  interrupt_generation?: number;
  cancellation_reason?: TaskReasonV1;
  activation_order?: number;
  usage_baseline?: TaskUsageSnapshotV1; // original execution usage, unchanged by steer/wait
  finish_declaration?: FinishDeclarationV1;
  interaction_block?: InteractionBlockV1;
  settled_at?: string;
  outcome?: TaskOutcomeV1;
  reason?: TaskReasonV1;
  completion_id?: CompletionId;
  lease_intent: LeaseIntentV1;
  lease_disposition: "required" | "release-pending" | "released";
}
```

封闭的 phase 规则如下：

- `admitted`：没有 start/deadline/runtime/settlement 字段；lease disposition 为 `required`；
- `starting | running | waiting`：必须有 `started_at`、`deadline_at_ms`、正的 `runtime_generation`；不能有 settlement 字段；lease disposition 为 `required`；Finish/Interaction generation 在存在时必须等于该 runtime generation；
- `waiting`：必须有`waiting_on`，SDK session 继续存在但释放 active execution 位；依赖或用户输入通过 activation_order 重新排位，满位保持等待，同 generation/Task/owner/lease/start/deadline 不变。输入轮结束且依赖未满足回 waiting；
- `admitted|settled`不能有 waiting/activation 字段。`settled` 必须有 outcome/reason/settled/completion；lease disposition 必须是 release-pending 或 released；
- deadline 在 `starting` 提交时只分配一次。其值为 `Date.now() + frozen task_timeout_ms`，并贯穿 startup、provider retry、compaction 和 waiting；`starting` 之前的排队时间不计入其中。系统 sleep 不会暂停它。execution owner 按这份 deadline 设置定时器；回调若因计时精度或 wall clock 调整仍未到期，须按原 deadline 重新设定，异步检查期间的取消或替换不得恢复旧定时器。force-close/replacement 取消的未启动 Task 合法 settled，不要求 started_at/deadline，usage 为 0。

settlement race 由当前 Task revision 上第一个提交成功的 transaction 决定。之后发生的 timeout/interrupt/provider/runtime event 都是过时的，不能改变 outcome。

### 7.4 Mailbox

```ts
interface MailboxRecordV1 {
  task_id?: TaskId; // all new model/view input binds an exact Task
  source?: "user" | "main-model" | "agent-model";
  cancelled_at?: string;
  version: 1;
  record_revision: number;
  message_id: MessageId;
  sender: ConversationRefV1;
  recipient: ConversationRefV1;
  sequence: number;
  body?: string;                // required until tombstoned; <=65536 bytes
  body_bytes: number;
  body_sha256: string;
  state: "pending" | "injected" | "consumed" | "cancelled";
  created_at: string;
  injected_at?: string;
  injected_into?:
    | { kind: "task"; task_id: TaskId }
    | { kind: "idle-conversation" };
  session_entry_id?: string;
  consumed_at?: string;
}
```

`injected` 需要 `injected_at`、`injected_into` 和 `session_entry_id`；`injected_into.kind="task"` 只在投递加入了一个 running 或 admitted Task 时使用，内部纯 control append 可以用 idle-conversation；新的 public input 都绑定确切 Task。`consumed` 需要所有 injection 字段和 consumed 字段。一个 body 只有在原生 mailbox 条目仍位于已验证的 active branch 上，或已被证明包含于 Pi 最新的 compaction lineage 中，**并且** 后续 package metadata checkpoint 已提交了该证据后，才可以 tombstone。仅有 package checkpointing 并不足够。Pending/injected 的 body 永远不能丢弃。sequence 必须在同一个 transaction 中分配，该 transaction 同时递增接收方 Agent 的 `next_mailbox_sequence` 或 RootCheckpoint 的 `next_mailbox_sequence`。

### 7.5 Barrier

```ts
interface BarrierRecordV1 {
  version: 1;
  record_revision: number;
  barrier_id: BarrierId;
  owner: ConversationRefV1;
  target_agent_ids: AgentId[];  // direct children, sorted and unique
  task_ids: TaskId[];           // arm 时仍未 settle 的 Task，admission order，unique，1..256
  completion_ids: CompletionId[]; // task order subset
  state: "armed" | "satisfied" | "cancelled";
  created_at: string;
  settled_at?: string;
  cancelled_at?: string;
  snapshot_sha256: string;      // canonical target/task ID tuple digest
  wake_outbox_id?: OutboxId;
}
```

`task_ids` 只记录 arm 时还要等的 Task。arm 之前就已经 settle 的 Task 已经有了自己的投递载体（普通 Outbox，或上一个 Barrier 的聚合 Outbox），Barrier 不再把它的 Completion 收进聚合集合；tool result 仍然分别报告完整 snapshot、`settled_task_ids` 与 `remaining_task_ids`。Armed 状态既没有终态 timestamp，也没有 wake ID。Satisfied 要求所有 Tasks 都已 settled，Completion IDs 按 Task 顺序排列，并且有 `settled_at` 和一个 `barrier-wake` Outbox。Cancelled 要求有 `cancelled_at`；如果没有任何被覆盖的 Task 已经 settled，则不能有 Completion ID 或 Wake Outbox，否则必须有一个 `barrier-catch-up` Outbox，并且它精确覆盖其有序 Completion IDs。Cancel replay 以 `(barrier_id,wake_outbox_id)` 实现幂等。一个 owner conversation 只能拥有一个 armed Barrier。

### 7.6 Completion 与规范化 usage

```ts
interface CompletionUsageV1 {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
}

interface CompletionRecordV1 {
  version: 1;
  record_revision: number;
  completion_id: CompletionId;
  task_id: TaskId;
  agent_id: AgentId;
  recipient: ConversationRefV1;
  outcome: TaskOutcomeV1;
  reason: TaskReasonV1;
  final_text: string;           // 0..65536 UTF-8 bytes
  summary: string;              // deterministic normalized single line <=512 bytes
  usage: CompletionUsageV1;
  task_admitted_at: string;
  task_started_at?: string;
  completed_at: string;
}
```

所有 token 字段都必须是非负安全整数；total 等于 provider 对该 Task turn 的 normalized total，而不是从 cache 字段重新计算。SDK 的 native proof 在公开 agent_settled 边界读取当前 Task 的 native result，并累计 started_at 之后 assistant/compaction/branch_summary 的真实 usage；不再有 RPC V1 usage compatibility path，不重复减全 session baseline。Completion identity 与 Task 一一对应，并且在创建后不可变。

### 7.7 Inbox、物理卡片投影、Outbox 与 read acknowledgement

物理 Completion card 会在 append 之前被冻结，因此 recovery 永远不会重新渲染出不同的截断表示：

```ts
interface CompletionCardProjectionV1 {
  content: string;              // exact XML-like model-visible bytes, <=71680 UTF-8 bytes
  content_sha256: string;
  details_json: string;         // exact canonical CompletionMessageDetailsV1, <=71680 bytes
  details_sha256: string;
  result_truncated: boolean;
  original_result_bytes: number;
  rendered_result_bytes: number;
  projection_sha256: string;    // SHA-256 canonical JSON of every field above, excluding this digest
}

interface InboxRecordV1 {
  version: 1;
  record_revision: number;
  inbox_id: InboxId;
  completion_id: CompletionId;
  recipient: ConversationRefV1;
  projection: CompletionCardProjectionV1;
  state: "pending-append" | "appended";
  created_at: string;
  append_attempts: number;
  model_entry_id?: string;
  model_appended_at?: string;
  ui_read_at?: string;
  ui_read_revision?: number;    // Host revision of the ACK transaction itself
}

type OutboxKindV1 = "completion-wake" | "barrier-wake" | "barrier-catch-up";
type OutboxDeliveryStateV1 =
  | "pending" | "delivering" | "cards-appended"
  | "wake-settlement-pending" | "delivered" | "handled" | "delivery-failed";
type OutboxWakeStateV1 =
  | "not-offered" | "foreground-pending" | "open" | "claimed"
  | "consumer-deferred" | "fallback-appended" | "settled" | "aborted";
// `consumer-deferred`（连同 `wake_deferral`）只保留读取兼容，没有写入路径；见下方 recovery 规则。

interface WakeSettlementReceiptV1 {
  version: 1;
  record_revision: number;
  receipt_id: ReceiptId;
  outbox_id: OutboxId;
  wake_epoch: number;
  kind: "goal-claimed" | "producer-fallback";
  claimant_owner_id?: string;   // required iff goal-claimed; absent otherwise
  claimant_generation?: number;// required iff goal-claimed; absent otherwise
  runtime_delivery: "delivered" | "skipped";
  continuation_identity: string;
  continuation_sha256: string;
  committed_at: string;
}

interface OutboxRecordV1 {
  version: 1;
  record_revision: number;
  outbox_id: OutboxId;
  kind: OutboxKindV1;
  source: ConversationRefV1;    // producing Agent, or Barrier-owning Main/Agent
  recipient: ConversationRefV1;
  completion_ids: CompletionId[]; // task order, 1..256
  state: OutboxDeliveryStateV1;
  wake_state: OutboxWakeStateV1;
  delivery_attempts: number;
  wake_epoch: number;           // starts 0; increment only after a new offer object is created
  settlement_kind?: "goal-claimed" | "producer-fallback";
  settlement_proof_id?: string; // WakeSettlementReceiptV1 ID
  settlement_proof_sha256?: string;
  wake_deferral?: { version: 1; offer_id: string; offer_generation: number; wake_epoch: number;
                    reason: "claimed-without-proof"; deferred_at: string }; // legacy read only
  continuation_native?: { wake_epoch: number; entry_id: string; sha256: string }; // Main local ACK fact, same epoch
  handling_proof?: { version: 1; session_id: string; wake_epoch: number; cards: {
    inbox_id: InboxId; completion_id: CompletionId; entry_id: string; projection_sha256: string;
    run_entry_id: string; run_sha256: string; assistant_entry_id: string;
  }[] }; // Main handled only, ordered full card set
  turn_settlement?: { version: 1; wake_epoch: number; continuation_identity: string;
                      state: "pending" | "settled"; pending_at: string; settled_at?: string }; // delivered only; DELIVERY_PROTOCOL §7.9
  created_at: string;
  updated_at: string;
  delivered_at?: string;
  last_error_code?: string;
  correlation_id?: string;
}
```

字段矩阵：

- `pending|delivering`：Wake 为 `not-offered|foreground-pending|open|claimed`；Completion cards 可以不完整。
- `cards-appended`：每个被引用的 Inbox 都已 appended 或完成 projection 校验；Wake 可以是 not-offered/foreground/open/claimed。producer 的 append/prove 失败会把记录留在 `cards-appended/open`——runtime 的 offer 已经 abort，durable 记录还开着。同 process 的下一个正常 reconcile 边界按原 entry 身份（`outbox_id` + `wake_epoch`）去重后重试一次：认到已经物理追加的 continuation 就用它终态化，Main 原 fallback 已 accepted 且无 native 时等待，不 re-offer、不重写 open；未接管的失败才用 detached offer，不重启也不轮询（`delivery.md §7.6`）。
- `cards-appended/consumer-deferred`：**只可能来自旧 store。**D-007 之前的一个版本用它记录「被 claim 却没交出 proof」；现在这种 epoch 当场由 producer 接管并终态化，不再产生该状态。store 打开时 recovery 把它连同 `wake_deferral` 归一成 `cards-appended/not-offered`，下一次 reconciliation 正常重投一次。
- `wake-settlement-pending`：cards 已 appended，并且 Wake 必须精确为 `claimed|fallback-appended`。`settlement_kind` 标识该分支；Outbox 上的 `settlement_proof_id`、`settlement_proof_sha256` 与 `delivered_at` 都不存在。但这一 `(outbox_id, wake_epoch)` 的 `WakeSettlementReceiptV1` **已经在同一笔 pending transaction 里落盘**：owner 在 `wake.commit(...)` 时就定了，而 Goal receipt 与 producer proof 都活不过进程，所以先落盘再链接。「receipt 已存在、Outbox 还没链接它」是合法组合，`delivered` 只由链接那一笔成立。
  终态事务失败会把记录留在这里，缺的只是最后那一笔链接。同 process 的下一个正常 reconcile 边界和重开 store 的 recovery 都取这份 receipt 链接成 `delivered`，不重投也不重新 append，也不再触发 Goal；`fallback-appended` 在终态事务提交后才归还 proof reservation（`delivery.md §7.6`）。
  **老 store 兼容**：写在这条规则之前的 `wake-settlement-pending` 记录没有 receipt。`fallback-appended` 仍认原 `(outbox_id, wake_epoch)` 的 native continuation entry（重算冻结 projection 校验 digest 后终态化）；`claimed` 拿不出真实证据就保持 nonterminal，由重开 store 的 recovery 重置为 `cards-appended/not-offered`、清除 settlement kind、创建新的 offer epoch，再次允许 claim 或 fallback；不可变 IDs 让它在逻辑上保持幂等。
- `delivered`：Wake **必须** 为 `settled`，每个 Inbox 都已 appended，并且必须存在 `settlement_kind`、`settlement_proof_id`、`settlement_proof_sha256`、`delivered_at`。对于 `(outbox_id,wake_epoch)`，必须恰好存在一个 `WakeSettlementReceiptV1`；它匹配 Outbox/epoch/kind，由 pending transaction 创建（老 store 的无 receipt pending 记录则由终态事务补写），终态事务只链接它，绝不写第二份。`settlement_proof_sha256` 是对完整 receipt 做规范 JSON 后计算的 SHA-256，但仅排除 `record_revision`。只有在带版本的 Goal settlement callback 证明了 continuation scheduling identity 后，Subagent Host 才会写入 `goal-claimed`；`producer-fallback` 记录的是经过验证的原生 continuation 条目。只有当 recovery 证明同一个 continuation identity 已经 started 或 settled 时，才允许 `runtime_delivery="skipped"`。单独一个易失性 claim 永远不能产生 `delivered`。
- `handled`：Main 专用成功终态，Wake 必须为 `settled`，`handling_proof` 必须存在且只允许出现在该状态；禁止 Wake settlement_kind/proof/delivered_at 和 turn_settlement。proof 的 session/epoch 必须匹配 recipient/原 epoch，cards 与 completion_ids 顺序、基数一一对应且 Inbox/native IDs 唯一，逐项匹配已 appended Inbox 的原 entry/projection。每张 card 保存真实成功 marker 的 ID/摘要及其 assistant；不同 card 可来自不同成功 run。只有 Main owner 完成原 marker/branch/fsync 验证后才能授权此事务，不能从 A fulfilled 推导；epoch=0 合法。已有同 epoch Wake receipt 时禁止转 handled。重复同 proof 是 no-op；handled 状态、handling_proof 不可回退或改写；按 §11.1 合法回收的 Inbox 可以缺席，已有 Inbox 仍须逐项匹配 proof。冷 importer 必须用精确 A 退休 receipt 识别这种状态，不能把“缺席”本身当作退休或降回 pending。
- `delivery-failed`：Wake 为 `not-offered|foreground-pending|aborted`；必须存在 error/correlation；只有在 immutable-ID scan 之后，显式 retry 才能返回 `pending`。

封闭组合规则如下：`pending|delivering` 允许 `not-offered|foreground-pending|open|claimed`，并禁止所有 settlement/proof 字段；`cards-appended` 允许相同的 Wake 状态，另外为兼容旧 store 接受 `consumer-deferred`（`wake_deferral` 当且仅当此时存在，且 recovery 会立即归一掉它）；`wake-settlement-pending` 只允许 `claimed|fallback-appended`，要求存在 settlement kind，并禁止 Outbox 上的 proof 字段与 timestamp（这一 epoch 的 receipt 记录本身可以已经存在）；`delivered` 只允许 `settled`，并要求匹配的 receipt/proof/timestamp；`delivery-failed` 只允许 `not-offered|foreground-pending|aborted`，要求 error/correlation，并禁止所有 settlement/proof 字段；`handled` 只允许 Main/settled/handling_proof 的上述组合。任何其他组合都属于 schema-invalid。

`turn_settlement` 只允许出现在 `delivered` 上，`wake_epoch` 必须等于 Outbox 的 `wake_epoch`，`settled_at` 当且仅当 `state="settled"`。它由终态事务（或 recovery 的 receipt 补链接）以 `pending` 写下，是 `delivered` 之后允许推进的业务字段：只能同一 `(wake_epoch, continuation_identity, pending_at)` 从 `pending` 翻成 `settled`（`settle-outbox-turn` 事务），除下面的首次 native 观察外，其余改动仍按「delivered Outbox 不可变」拒绝。没有这个字段的旧记录不猜、不改写。语义见 `delivery.md §7.9`。

`continuation_native` 是 Main 对本 mail native ACK 的独立持久副本，只有 `{wake_epoch,entry_id,sha256}`，必须匹配原 continuation projection 和 epoch。
第一次接收写一次；已在 source observation 或同 epoch producer Wake receipt 里的相同事实零写入，冲突拒绝。
正常 Wake receipt 接管时验证同一 entry/hash 后删除此字段；Goal delivered 后才到达的 fallback、或 handled 之后的在飞 native 观察仍可首次记入，不能抹掉不可撤回事实。
它不是 Goal claim、不是 active producer proof，也不能使 Outbox 变 delivered/handled；不新增通知次数、队列、timer 或通用协调表。

Main mailbox import 的 recovery 保留原 accepted key/epoch/open。handled 保持终态，其 card proof 不因缺少新的 transcript recovery 观察而降级；
其后独立 importer 仍校验原 active branch 并续作 card import/continuation cancel，不自动解除 A 的 recovery-held。
以下旧同步 offer reset 规则不覆盖 Main 已 accepted 的 waiting-native 或 handled 义务。

runtime offer/lease IDs 保持易失性，不会被序列化。`wake_epoch` 会在成功创建新的 runtime offer object **之后** 的同一个 Host mutation 中递增；仅仅加载或重置 recovery 状态不会导致它递增。在进程 recovery 时，`delivering|cards-appended|wake-settlement-pending` 会根据冻结的 projection/continuation IDs 做协调，然后回到最早可证明的状态。`open|claimed` 没有可持续的 runtime authority，因此会重置为 `not-offered`；它不是终态证据。同 process 在正常 reconcile 边界上的重试不做这次重置：它从 `open` 直接递增到新 epoch，或者拿当前 epoch 已经追加过的 continuation 终态化。带落盘 receipt 的 `wake-settlement-pending` 两条路径都不重置——同进程的边界与重开 store 的 recovery 都只补那一笔链接，并且不因 transcript 证据缺失把它引用的 Inbox 退回 `pending-append`（receipt 本身就是 card append 的证明）；只有老 store 里没有 receipt 的那种才归一回 `cards-appended/not-offered`（`delivery.md §7.6`）。旧 store 里的 `consumer-deferred` 与 `open|claimed` 同样处理：重置为 `not-offered` 并丢掉 `wake_deferral`，`wake_epoch` 保留，下一次 reconciliation 用 detached offer 重投一次。只有当 active-branch/compaction 证据与 `completion_id` 和 `projection_sha256` 匹配时，`appended` 才可信；否则会回到 `pending-append`。

人工已读使用 ViewedInboxReceiptV1={inbox_id,completion_id,projection_sha256,entry_id}。Host 核验 appended Inbox 和对应 native entry 后，在同 transaction 写首次 ui_read_at/ui_read_revision，revision 是新 Host revision。当前 D 规则：成功 native onLoaded 清目标 Agent 自产活动标记，点击只清精确卡片；不清目标收到的 descendant 卡片。close/resume/选行/loading/stale/error/render/scroll/model 消费不标读；空/坏/混合 invalid receipt 或 persistence 失败保 unread。规则与用户最终确认边界见 UI_SPEC。

Wake settlement receipt 的所有权始终局限于 Subagent metadata journal 本地。Goal 永远不会打开这个 store：它的 runtime-contract consumer 会同步返回一个有界、带版本的 proof 给 producer settlement listener；Subagent Host 会验证它，先在 pending transaction 里提交 `WakeSettlementReceiptV1`，再由终态 transaction 把 Outbox 链接成 `delivered/settled`。在 pending transaction 之前 crash，durable 记录停在 `cards-appended`；Main 先按 §7.7 检查 handled/accepted/native 事实，只有未接管且仍欠机会时才重新 offer；在两笔之间 crash，留下带 receipt 的 `wake-settlement-pending`，recovery 只补那一笔链接，不重新 offer。

### 7.8 持久的 owner-control events

```ts
type OwnerEventKindV1 =
  | "confirm_task_commit" | "acquire_task_lease" | "release_task_lease"
  | "mailbox_delivery" | "completion_delivery" | "barrier_cancelled"
  | "prepare_shutdown" | "owner_health";

interface OwnerEventRecordV1 {
  version: 1;
  record_revision: number;
  event_id: OwnerEventId;
  target: ConversationRefV1;    // exact Task owner or delivery recipient
  target_runtime_generation?: number; // required only in sent/acked; absent in pending
  event_sequence: number;       // contiguous per target conversation across runtime replacements
  kind: OwnerEventKindV1;
  payload_json: string;         // canonical bounded protocol payload <=1 MiB
  payload_sha256: string;
  state: "pending" | "sent" | "acked" | "cancelled";
  cancelled_at?: string;
  attempts: number;
  created_at: string;
  sent_at?: string;
  acked_at?: string;
}
```

每个 target conversation 保存 next_owner_event_sequence/last_owner_event_acked_sequence，分配 event 和递增 next 同 transaction，跨 generation/deletion 不重置或复用。pending 无 target generation，sent 绑定实际当代；ACK 必须提供同 generation 的精确 event IDs、payload/result proof，不能跨 pending/gap。acked 与 cancelled 为 terminal；取消 Task 输入同时将相关 mailbox_delivery 从 pending/sent 变 cancelled、记录 cancelled_at，保留 sequence。cursor 只推进连续 acked/cancelled 前缀，ACK 跳过 cancelled，不发送/应用/恢复其正文；取消绝不当成成功 application。

replacement recovery 按 kind 封闭处理：

| 类型 | 断开连接或 replacement 行为 |
|---|---|
| `confirm_task_commit` | 将 sent 重置为 pending；只要 Task 仍处于 committed 状态就持续 replay，直到 ACK |
| `acquire_task_lease` | 协调 operation/Task；仅在仍需要 lease 时 replay |
| `release_task_lease` | 持续 replay，直到得到终态 release 结果或 ACK |
| `mailbox_delivery` | 仅当前 open/Task/generation 且非 cancelled input 可按 ID/hash 重放；cancelled 永不重发 |
| `completion_delivery` | 按不可变 Completion/Inbox IDs replay |
| `barrier_cancelled` | 仅当 replacement 报告匹配的 Barrier generation 时 replay |
| `prepare_shutdown` | 受 generation 约束；exit/disconnect 时终态 ACK 或丢弃；绝不发送给 replacement |
| `owner_health` | 合并为最新值；在发送给 replacement 前，对过时 generation 的记录执行 ACK 或丢弃 |

runtime replay caches 只加速，不代替 durable result/ACK。只有 sequence≤cursor、无 Task/lease/delivery/barrier/prepare 引用时才能移除 acked/cancelled terminal events；保留的小 sequence 必须 terminal，不参与 gap validation。在所有被保留且 sequence 大于 cursor 的事件中，第一个必须等于 `last_owner_event_acked_sequence + 1`，其后的每个 sequence 都必须连续；更大的 gap 就是损坏。受 generation 约束的终态 discard 也会通过一次已提交的迁移推进 ACK cursor。

### 7.9 Operation receipts

```ts
interface OperationReceiptV1 {
  version: 1;
  record_revision: number;
  receipt_id: ReceiptId;
  request_id: string;           // stable trusted caller operation identity
  operation_digest: string;     // canonical request payload digest; contradictory reuse fails
  caller: ConversationRefV1;
  runtime_generation: number;
  operation: string;
  state: "committed" | "aborted";
  transaction_id: TransactionId;
  result_sha256?: string;
  result_json?: string;         // canonical JSON <=65536 bytes
  created_at: string;
  settled_at?: string;
}
```

Receipts 使得已认证的 同进程 owner retry 具备幂等性。一个 request ID 在 `(caller session, runtime generation)` 范围内必须唯一；只有在 `operation_digest` 也匹配时 replay 才会成功，而相互矛盾的复用会以 `protocol-error` 失败。提交前的 `prepared` 权威只存在于 `PrepareRecordV1.prepared_operation` 中；任何 journal entity 都不能编码一个 prepared receipt。admission commit 会在与公共记录相同的 metadata transaction 中创建 `OperationReceiptV1(state="committed")`。当一个 abort 为了 replay 必须在 prepared-directory cleanup 之后继续保留时，会通过单独的 metadata transaction 创建 `state="aborted"`；否则 `abort.json` 仅作为 cleanup evidence。receipts 只在 checkpoint 时按 §11.1 回收：每个分区保留最近 1,024 条，以及仍和未结算 Task、未 ACK 的 OwnerEvent 相关的、prepared 目录还引用的；已提交的 domain entities 仍然保留。

### 7.10 逻辑删除与 cleanup

```ts
interface SubtreeTombstoneV1 {
  version: 1;
  record_revision: number;
  root_agent_id: AgentId;
  agent_ids: AgentId[];         // canonical tree order
  task_count: number;
  mailbox_count: number;
  completion_count: number;
  unread_completion_count: number;
  identity_sha256: string;
  deleted_at: string;
  cleanup_id: CleanupId;
}

interface CleanupRecordV1 {
  version: 1;
  record_revision: number;
  cleanup_id: CleanupId;
  kind: "subtree-delete" | "orphan-prepared";
  state: "pending" | "running" | "complete" | "failed";
  relative_paths: string[];     // validated store-relative paths only
  created_at: string;
  updated_at: string;
  last_error_code?: string;
}
```

已完成但仍 open 的子树必须先 close/drain，全部 closed 后重新校验 snapshot/revision；未完成工作不因 delete 隐式 force，closing/cleanup_pending 不得 tombstone。关闭与删除沿用既有持久合同，不新增字段。只有在以下条件全部满足时，Deletion 才会被 admitted：子树中的每个 Agent 都已 closed、每个 Task 都已 settled、没有任何属于该子树的 Barrier 处于 armed、每个相关 Inbox 都为 `appended`、每个相关 Outbox 都已 `delivered` 且有原 Wake receipt，或 Main 已 `handled` 且有全体成功 handling_proof；两种的 Wake 都为 `settled`、没有任何 OwnerEvent 处于 `pending|sent`、没有任何 prepared operation 或 cleanup 引用该子树，并且确认时的 revision 仍然匹配。`delivery-failed`、`foreground-pending`、`open`、`claimed`、`wake-settlement-pending`、未读 Inbox 以及未 ACK 的 owner events 都不能被静默丢弃；unread 只能在显式 warning confirmation 之后删除，但 delivery 本身必须已经是终态。该 transaction 会移除子树中的所有 Agents/Tasks/Mailboxes/Barriers/Completions/operation 和 Wake receipts，所有引用它们的已 acknowledged OwnerEvents，以及所有 sender、target、payload entity、recipient、source 或 Completion 属于该子树的 Root 或其他 Agent 的 Mailbox、Inbox、Outbox 或已 acknowledged OwnerEvent；并且会在同一次提交中创建 tombstone 和 Cleanup record。tombstone commit 就是逻辑删除点。reducer 会立即将该子树从 addressing/listing 中移除，并永久阻止 ID reuse。随后物理文件会通过已验证的同文件系统 rename 移入 `trash/<cleanupId>/`，然后在 no-follow 验证下递归删除。失败不能恢复权威；它只会留下一个可见的 cleanup failure，并且保留的字节继续计入 quota。checkpoint compaction 只有在保留 tombstone 之后，才能丢弃被删除实体的 body。

Main 的 deleteSettledSubtree 准入在现有 Host writer 内只读验证本次 plan 删除的 Outbox：相关 A pending/terminal 债必须为空，原 card 的公共磁盘 receipt 必须通过身份/native/assistant/branch 验证。handled 与旧 delivered 统一检查。未附着 Main 时保守拒绝；用中文提示稍后在原 Main 重试。检查不写新状态、不调用 source callback，无关子树不读取或等待这些债。

### 7.11 生命周期、输入与 Task owner 不变量

Agent lifecycle_revision 随 open/closing/closed 变更，runtime_generation 在新 SDK 装配、关闭收口或 cold recovery retire 旧 generation 时增加；不是 provider 请求计数。closed 没有 unfinished Task/runtime writer，history/profile/unread 保留；closing 冻结新工作并计 open cap，drain/lease/control 未完成不能伪造 closed。force-close intent 先持久，之后 Task current/queued、input 和 barrier 取消，再 Completion/lease/ACK/dispose、closed。resume 只开目标 idle，不创建 Task/lease/grant/Completion/compact；closed 祖先可保持 closed，closing 祖先拒绝 resume。

Task initiator.kind 为 user/main-model/agent-model，conversation 和 owner_conversation 在新准入冻结。busy/waiting steer 不改变它们；Main/user 向孙 Agent 新 Task 归 Main，child-origin 归 child。Completion.recipient、lease_intent.session_id、prepared.lease_owner 按 Task owner，structural_parent 保持树关系。activation_order 只为 waiting active 准入，waiting_on 不变；收尾以 grant 捕获的 expectedActivationOrder 作比较，仅相同 order 才能清理，后到的输入/依赖唤醒保持排队；usage_baseline 为原 execution 的五项 token 计数。

新输入 Mailbox.task_id/source 确定所属 Task，body/hash/native entry proof 不能应用到下一 Task；Task 取消/settle/timeout/force/interrupt 同时取消其 pending/sent OwnerEvent 和 pending Mailbox，cancelled_at 持久，continuation 不能恢复旧内容。open cap 计所有 lifecycle≠closed 与有效 prepared spawn reservation，closed 只受存储 quota；无 resident/LRU/idle retention。ViewedInboxReceiptV1 的 schema 与规则见§7.7，不以 Agent ID 批量“已读”。

## 8. Journal framing 与 transaction 格式

journal 采用 binary 只是为了让 frame 边界没有歧义；payloads 仍然是规范 JSON。每个 frame 为：

```text
PSAJ1 <sequence:16 lowercase hex> <length:8 lowercase hex> <crc32c:8 lowercase hex>\n
<payload bytes exactly length>\n
```

header 是 ASCII 且固定宽度。sequence 从 checkpoint manifest 的 `last_journal_sequence + 1` 开始，并且必须连续。length 范围为 `1..1048576`。CRC-32C 使用 Castagnoli polynomial，只对 payload bytes 计算，并编码为无符号 big-endian hex。结尾的 LF 是强制的，且不计入 length/CRC。一个 journal file 最多达到配置的 metadata cap；一个 transaction 最多为 64 MiB、8192 条 mutation records，以及 65,536 个 frames（包括 begin/commit）。任何 transaction interleaving 都不合法。

Payload 联合类型：

```ts
interface JournalAnchorV1 {
  version: 3;                   // journal 格式版本；1/2 在打开旧 store 时升级（§14）
  type: "journal-anchor";
  checkpoint_generation: number;
  checkpoint_revision: number;
  checkpoint_state_sha256: string;
  created_at: string;
}

interface TransactionBeginV1 {
  version: 1;
  type: "tx-begin";
  transaction_id: TransactionId;
  base_revision: number;
  revision: number;             // exactly base + 1
  operation: string;
  created_at: string;
}

type EntityTypeV1 =
  | "agent" | "task" | "mailbox" | "barrier" | "completion"
  | "inbox" | "outbox" | "owner-event" | "operation-receipt" | "wake-receipt"
  | "cleanup" | "tombstone" | "root";

interface TransactionPutV1 {
  version: 1;
  type: "put";
  transaction_id: TransactionId;
  entity_type: EntityTypeV1;
  entity_id: string;
  value: unknown;               // exact matching V1 entity schema；entity_type="root" 时是 RootHeaderV1
}

// Root 在 journal 里只有头字段；mailbox/inbox/outbox/owner_events/barrier/operation_receipts/
// wake_receipts/cleanup/tombstones 不出现在 Root put 里，出现即按未知字段拒绝。
type RootHeaderV1 = Pick<RootCheckpointV1,
  | "version" | "main_key" | "host_revision" | "next_admission_order" | "next_mailbox_sequence"
  | "next_owner_event_sequence" | "last_owner_event_acked_sequence" | "agent_ids">;

interface TransactionDeleteV1 {
  version: 1;
  type: "delete";
  transaction_id: TransactionId;
  entity_type: EntityTypeV1;
  entity_id: string;
  expected_record_revision: number;
}

interface TransactionDeleteSubtreeV1 {
  version: 1;
  type: "delete-subtree";
  transaction_id: TransactionId;
  tombstone: SubtreeTombstoneV1;
}

interface TransactionCommitV1 {
  version: 1;
  type: "tx-commit";
  transaction_id: TransactionId;
  revision: number;
  mutation_count: number;
  transaction_sha256: string;
  committed_at: string;
}
```

`transaction_sha256` 会按顺序哈希 begin 的精确 payload bytes 以及每个 put/delete/delete-subtree 的精确 payload bytes，并为每一段加上其无符号 8-byte big-endian length 前缀。它不包含 frame headers，也不包含 commit payload。Entity IDs 与嵌入的 record IDs 必须一致。除 Root 外，put 包含的是完整替换记录，而不是 merge patch。每个 transaction 恰好一条 Root put，其 value 是 `RootHeaderV1`：reducer 只替换 Root 的头字段（`host_revision` 必须等于本 transaction 的 revision，`main_key` 不能变），Root 的集合只由各自实体的 put/delete/delete-subtree 改变，与 Root put 在 transaction 里的位置无关。因此一个 frame 的大小只取决于单个实体，和 Root 规模无关。reducer 会在写入前以及 replay 期间，基于 `base_revision` 验证所有跨记录不变量。

writer 在编码前预检每条 mutation 的 payload：任何一条超过 1 MiB 时，整个 transaction 以 `[subagent/storage-capacity]` 拒绝，store 不变，storage health 标为 `degraded-capacity` 并给出中文诊断（哪个实体、多少字节）；下一笔 transaction 提交成功后 health 恢复。这个拒绝不能落成 `storage-unavailable`，也不能让后续更小的 transaction 失败。

Root put 不带集合以后，checkpoint 解码时的条数上限（Root：`agent_ids`、`inbox`、`outbox`、`owner_events`、`operation_receipts`、`wake_receipts`、`cleanup`、`tombstones` 各 4,096，`mailbox` 1,024；Agent 分区：`tasks`、`completions` 各 256，`mailbox` 1,024，其余集合各 4,096）必须在写路径上照样执行：reducer 算出候选状态后，任何集合超限，transaction 同样以 `[subagent/storage-capacity]` 拒绝，诊断写明哪个分区的哪个集合有多少条。写路径与解码用同一组常量。所有容量拒绝的中文诊断都放进抛出的错误信息，模型和用户在 Host 错误里直接看到，不必读 `health()`。

writer 会为一个 transaction 序列化全部 frames，在一个 append-only FD 上执行有界 `writev`/short-write completion，然后执行 `fdatasync`/`fsync`。commit 始终在最后。只有在 sync 返回之后，或一次立即的 reopen/rescan 证明了那个精确有效的 commit 之后，该 operation 才算提交。没有 commit 的部分 transaction 不产生任何效果。rescan 证明 commit 不存在时，writer 必须在下一次 append 之前把 journal 截回最后一个已提交 byte offset 并 sync；否则半截 frames 会被夹在后续 commit 之前，§12.5 只修复单一 final tail 的 recovery 永远救不回它。rescan 无法证明（corrupt）时不得截断，只能 fence 后续 mutation。

## 9. Prepared artifacts、commit 与 abort

每个 mutation 在发生 side effects 之前都会获得一个 `transactionId`。随后首先写入并 sync `prepared/<transactionId>/prepare.json`：

```ts
interface PreparedArtifactV1 {
  temporary_path: string;
  final_path: string;
  bytes: number;
  sha256: string;
  kind: "conversation" | "system-prompt" | "checkpoint-input" | "cleanup-input";
}

interface PreparedOwnerTaskOperationV1 {
  kind: "spawn" | "followup";
  request_id: string;           // UUID-v4; stable idempotency key
  caller: ConversationRefV1;
  caller_runtime_generation: number;
  operation_digest: string;
  prepared_token_sha256: string;// clear token never persists
  expires_at: string;           // created_at + 30 seconds
  reserved_agent_id?: AgentId;  // required iff spawn
  reserved_task_id: TaskId;
  reserved_task_path: string;
  structural_parent: ConversationRefV1;
  logical_lease_key: TaskId;
  lease_owner: ConversationRefV1;
  public_result_json: string;
  public_result_sha256: string;
  phase: "prepared" | "lease-proved" | "commit-requested";
}

interface PreparedLocalAdmissionV1 {
  lease_owner: ConversationRefV1; // independent of structural_parent
  kind: "local-admission";
  request_id: string;
  caller: ConversationRefV1;
  operation_digest: string;
  reserved_agent_id?: AgentId;
  reserved_task_id: TaskId;
  reserved_task_path: string;
  structural_parent: ConversationRefV1;
  logical_lease_key: TaskId;
  public_result_json: string;
  public_result_sha256: string;
  phase: "prepared" | "lease-proved" | "commit-requested";
}

interface PreparedMetadataMutationV1 {
  kind: "metadata-mutation";
  request_id: string;
  caller: ConversationRefV1;
  operation_digest: string;
  phase: "prepared" | "commit-requested";
}

type PreparedOperationV1 =
  | PreparedOwnerTaskOperationV1
  | PreparedLocalAdmissionV1
  | PreparedMetadataMutationV1;

interface PrepareRecordV1 {
  version: 1;
  transaction_id: TransactionId;
  operation: string;
  base_revision: number;
  proposed_revision: number;
  created_at: string;
  prepared_operation: PreparedOperationV1;
  lease_intents: LeaseIntentV1[];
  artifacts: PreparedArtifactV1[];
}

interface AbortRecordV1 {
  version: 1;
  transaction_id: TransactionId;
  aborted_at: string;
  reason_code: string;
}
```

仅 metadata 的 transactions 使用 `PreparedMetadataMutationV1` 且 artifacts 为空；本地 Main admission 使用 `PreparedLocalAdmissionV1`；只有 同进程 owner spawn/follow-up 才使用 token、TTL 和 runtime generation。同进程 Owner prepare 会在返回 clear token 之前持久化每一个 recovery fact。`operation_digest` 用于区分相同 replay 与相互矛盾的 request reuse；token hash/expiry/phase 用来 fence commit；预留的 IDs/path 以及 structural parent/lease owner 用于恢复远端获取；冻结的 public result 让一次 `already_committed` replay 返回完全相同的 bytes。`prepared_operation.phase` 会在 lease proof 之后、以及在发送或接受 commit request 之前，原子替换并 sync 到 `prepare.json` 中。clear token 永远不会出现在磁盘上。artifacts 会在 prepared 目录下创建并 sync，然后在 journal commit **之前** 原子 rename 到最终的封闭路径；在 commit 之前，没有任何 journal/checkpoint 会引用它们，因此它们只是不可达 orphan。对于一个 spawn，artifacts 是同一个私有 Agent 目录中的原生初始 `session.jsonl` 和不可变的组装后 `system-prompt.txt`。二者都必须在提升到最终位置前完成 sync/hash；二者都不能在 显式 resume 时重新生成。最终父目录必须在 commit 前完成 sync。prompt file 必须是 current-UID 的常规 `0600` 文件，必须是合法 UTF-8、LF-normalized，大小为 1..1,048,576 bytes，并且必须匹配每个 profile/capability prompt digest。

Admission commit 顺序：

1. 校验 arguments、当前 revision、capacity 以及所有关系不变量。
2. 分配 IDs/revision，并写入和 sync prepare record 及 artifacts。
3. 在 Task lease_owner 会话获取每个 LeaseIntentV1。Main-owned 直接 registry；child-owned 用 HOST_API 的同进程 conversation map/handle 验证 proof；intent.session_id 必须匹配 owner，logical key 等于原 Task ID。
4. 将 prepared artifacts rename 并 sync 到最终但不可达的路径。
5. 追加并 sync 一条包含完整 records 和 commit 的 journal transaction。
6. 发布内存中的 revision，移除 prepared directory，然后返回 success。

如果在第 5 步之前失败，则在可能时写入并 sync `abort.json`，使用 `releaseWithoutWake(cancelled)` 释放已获取的 leases，仅移除经过验证的 prepared/orphan 最终 artifacts，并且不暴露任何 identity。如果 journal sync 报告不确定性，writer 必须重新打开并扫描：一个有效且精确的 commit 表示 admission 已提交；不存在则表示 abort。在已经证明提交成功之后，它绝不能返回 rejection。

commit 之后的 crash 会留下最终 artifacts 和持久的 lease intents；recovery 会在暴露或调度拥有方 conversation 之前重新获取所需 leases。精确且有效的 journal commit 总是优先于 expiry、caller death、missing response 或 prepared-directory phase。若不存在精确 commit，recovery 会按以下判别规则处理：

| 变体 | `prepared` | `lease-proved` | `commit-requested` |
|---|---|---|---|
| owner task | expired 或 foreign runtime 时 abort；否则协调直到 TTL 到期 | journal 不存在 → abort（旧 process 的 lease 已消失）；commit 存在 → frozen result + `must-acquire` | 精确的 transaction/receipt commit 优先；不存在则 abort |
| local admission | journal 不存在 → abort；不适用 TTL/generation 规则 | journal 不存在 → 若存在 live local lease 则释放后 abort；commit 存在 → 重新获取 intent | 精确的 transaction commit 优先；不存在则 abort |
| metadata mutation | journal 不存在 → abort | 无效状态 | 精确的 transaction commit 优先；不存在则 abort |

不存在任何路径会仅仅因为曾经存在过一个 lease proof 就提升一个 prepared operation。aborted 路径只会移除经过验证的 artifacts，并且不会保留任何 public identity。

## 10. Settlement、delivery 与 lease disposition

Task settlement 是一个 metadata transaction，其中会：

- 将 Task 变更为 settled，并设定 `lease_disposition="release-pending"`；
- 创建一个带有必需 deterministic summary 的不可变 Completion；
- 冻结一个 `CompletionCardProjectionV1` 并创建一个接收方 Inbox，状态为 `pending-append`；
- 仅当该 Task 不是一个 armed Barrier 的中间成员时，创建一个普通 Outbox，状态为 `pending`；
- 对于一个被覆盖的中间 Task，不创建单独的 Outbox；
- 当最后一个被覆盖的 Task settled 时，将 Barrier 标记为 satisfied，并基于有序 Completion 集合创建它唯一的聚合 Barrier Outbox；
- 更新 Agent 的当前或排队状态，以及 Barrier 的 completion 子集。

只有在这次 commit 之后，runtime code 才会释放 lease。中间 Barrier Tasks 使用 `releaseWithoutWake`；普通或最终 Barrier settlement 在仍欠请求机会时使用 `releaseAndOfferWake`；已有持久 Main 全体成功时走 handled，无 Wake 释放并持久标 released。一个后续 metadata transaction 会将 lease disposition 标记为 released，并推动 Outbox 经过 `cards-appended → wake-settlement-pending → delivered/settled`。单独一个进程本地 claim 本身永远不是终态持久证据。如果进程在 metadata settlement 与 release 之间死亡，那么进程内 registry 会消失；recovery 绝不会重新获取一个已 settled 的 Task（`phase="settled"` 就跳过，不管 disposition 还是 `release-pending`——重新 acquire 会拿一个已完成的任务把 Main 标成 busy），而是从持久的 Outbox 状态重建所需的 delivery/Wake：detached offer 补投，成功的 `open` transaction 把 disposition 提交成 `released`。如果同进程内的 release 或 follow-up 写入失败，则 health 会降级，owner 会从持久化的 release-pending 状态重试；允许出现重复的物理 Wake/delivery，并通过 Completion/Outbox IDs 去重。这次重试不重放已经释放掉的 lease：`releaseAndOfferWake` 一旦返回，进程内的易失 handle 就没了，`wake_epoch` 是否已经递增都不改变这一点，所以本进程不再持有该 root Task lease 时只能用 detached `offerWake` 补投（`delivery.md §7.6`）。

精确的 append/offer/claim/commit/ack 顺序以及 transcript entry schema 由 `delivery.md` 定义；这个 store 保证它所消费的持久状态。

## 11. Checkpoint 与 journal compaction

checkpointing 会在 writer lock 下与 mutations 串行化：

1. 在 revision `R` materialize 并完整校验状态。
2. 写入一个新的 `cp_G` 目录、全部 Agent/root files 以及 manifest；sync 每个 file 和 directory。随后从磁盘读回这些文件，用打开 store 时的同一套解码（manifest、descriptor、`RootCheckpointV1`/`AgentCheckpointV1` 解码、跨记录不变量）校验；读不回就不建 journal、不切换 CURRENT，旧的一对保持权威，半个新代由第 6 步清掉。写得出、读不回的 checkpoint 永远不能成为 CURRENT。
3. 创建 `jr_J`，其中包含一个已 sync 的 anchor，引用 checkpoint generation、revision 和 state digest。
4. 写入并 sync `CURRENT.tmp`，将其 rename 覆盖 `CURRENT`，再 sync Main directory。这就是 checkpoint switch commit。
5. 重新打开并校验新的 pointer、checkpoint 和 anchor。
6. 在 switched pointer 被重新打开并校验后，未被 `CURRENT` 引用的 checkpoint/journal generations 都是非权威 maintenance artifacts。只能删除 closed-layout、current-UID、已通过 no-follow 校验的 generation pairs；失败时保留 bytes、降级 storage health 并计入 quota，但不影响权威。不得为 checkpoint generations 创建 metadata Cleanup record，以避免某个 transaction 自己的 checkpoint 递归产生更多 cleanup work。第 2 步到第 4 步之间 crash 留下的**未配对** generation 同样不被 `CURRENT` 引用、也永远不可能成为权威，按 §6.0 的同一条规则校验后移除即可，不需要配对；这类 maintenance 失败只降级 storage health，绝不能 fence 已经提交的权威或拒绝新的 mutation。

清理 obsolete generations 之前，writer 必须重新读取磁盘上的 `CURRENT`，并且只有它与内存中的指针一致时才删除；不一致或读不出时只降级 storage health，不删任何东西。store 已被 fence（权威无法证明）时，显式 checkpoint 直接以 `storage-unavailable` 失败，不做清理也不切换。

切换中途崩溃的残留不能卡住后续切换：
- `CURRENT` 能解析时，`CURRENT.tmp` 不论内容（包括 O_EXCL 建出来还没写的空文件）都直接删除；
- 编号大于 `CURRENT` 所指的代从来没当过权威（`CURRENT` 只会向前走），不做成对校验直接删除，例如刚建出来还没写的空 journal；
- 新一代的编号取内存指针和磁盘上已有代编号的最大值加一，删不掉的残留也不会让切换撞上 `EEXIST`。

### 11.1 Checkpoint 时的保留策略

journal 只记录实体 mutation，Root 和各分区的集合会随长会话一直增长。checkpoint 物化状态时，只删除信息已在别处落盘、幂等重放、恢复和未读都不再需要的记录；被删记录只是不再出现在新的 checkpoint 和之后的内存状态里，不产生 journal transaction。回收只在提交之后的 checkpoint 和显式 checkpoint 里做；提交前为回收 journal 做的 checkpoint 不回收，因为调用方的 mutation 是按回收前的状态算的。

| 集合（Root 与 Agent 分区相同） | 回收条件 | 信息在哪里 |
|---|---|---|
| operation_receipts | 不在本分区最近 1,024 条里；`result_json` 没提到任何未结算 Task 或未 ACK 的 OwnerEvent；`transaction_id` 没有对应的 prepared 目录 | 公共结果已体现在 domain entities 里；同一请求的重试只发生在最近的调用上 |
| owner_events | 已 `acked`/`cancelled`，且序号不超过本分区的 ACK 游标 | 目标 runtime 已经应用并确认 |
| child inbox | `appended`、已读，且投递载体 Outbox 已 `delivered`、wake `settled`、turn settlement 不存在或已 `settled` | 卡片在 child transcript 里；Completion 和 final text 仍在生产方分区 |
| Main inbox | appended、已读、delivered/handled 的业务已退休，且本次批量 fresh 读取确认所有相关 A key 已 ACK/GC、精确磁盘 receipt 可替代材料 | 包括 card key、Outbox 原 epoch/prefix、已存在 continuation 与 shared carrier；unknown/未附着/scope 冲突/pending/terminal 尚在一律保留 |
| wake_receipts | 所属 Outbox 已 `delivered`，且不是它的 settlement proof | 被后续 epoch 取代；proof receipt 保留 |
| mailbox | `consumed`/`cancelled`，不在本分区最近 256 条已结束消息里，也没被未结束的 OwnerEvent 引用 | 正文已注入接收方会话或已取消 |

不回收：尚不满足完整退休条件的 Main Inbox（升级 checkpoint 也必须验证 A）；Outbox、其 handling_proof/continuation_native、Completion、Task、Agent（靠删子树回收）；tombstone 和 cleanup（Agent ID 永不复用的证据）；Barrier（每个分区只有一条）。这些集合超过解码上限时按 §8 拒绝新事务，用户删除已结算子树释放。

提交成功后，如果某个可回收集合超过解码上限的一半并且这次能回收至少 512 条，或者已离上限不到 256 条并且能回收任何记录，就立刻做一次带回收的 checkpoint。按这条规则，只有确实无法回收的记录才会撞到写路径的条数上限。

一个 Completion 的 Inbox 被回收以后，跨记录不变量只接受它的投递载体已经彻底结束；对这种 Completion 的已读回执不再有事可做，按已读处理。

在第 1 步到第 4 步之间不得发生任何 mutation。CURRENT 切换之前的 crash 会让旧的一对保持权威；切换之后的 crash 则使用新的一对。checkpointing 只按 §11.1 回收记录。它绝不会截断原生 conversations，也不会丢弃 Completion final text。触发条件是 journal bytes 达到 16 MiB、或累计 4096 个已提交 transactions、或显式 maintenance；如果 compaction 不能回收足够 allowance，则必须在触及 metadata hard cap 之前拒绝新的 mutation。容量准入失败后，只有自上次 checkpoint 以来已有 transaction、或还有残留的旧 generation 时才先 checkpoint 再重试；否则直接拒绝，不重写一遍全部分区。

## 12. Recovery 与损坏策略

在 writer lock 下执行 recovery：

1. 校验 root/Main markers、UID/modes/layout 以及精确的 Main identity。
2. 读取 CURRENT；校验所指向的 manifest/descriptors/digests，并解析全部 checkpoint entities。
3. 从 anchor 开始扫描 journal，校验 header、sequence、length、CRC、canonical JSON、transaction hash、revision continuity 和 domain invariants。
4. 只应用完整且已 committed 的 transactions。忽略未 committed 的 begin/mutations。
5. 对于**仅有的** truncated/CRC-invalid final tail，将精确 bytes 保留至 `recovery/<timestamp>-<tx>.tail`，把 journal 截断到最后一个有效 committed byte offset，sync 后继续。任何带有后续 bytes、revision gaps、descriptor mismatch 或 invariant failure 的损坏，都会让 Main store 以 read-only unavailable 状态失败；绝不能猜测或覆盖 bytes。
6. 协调 prepared directories：存在精确的 committed transaction → 完成已验证 cleanup；没有 commit → abort/delete 已验证 artifacts；evidence malformed 或为 symlink → skip 并标记 storage degraded。
7. 校验每个 native conversation header/session ID/path 并解析 Pi JSONL；在任何 runtime start 前，校验共同拥有的 `system-prompt.txt` 的 identity/size/digest 是否匹配 frozen profile。仅当之前每行都能解析且 parent-chain evidence 有效时，才可以保留后移除 truncated final line。metadata 仍可证明时，mid-file/semantic corruption 只将该 Agent 标记为 unavailable。
8. cold owner loss 没有可继续的 SDK writer：正常 recovery 事务将未完成 current/queued 结算 interrupted/host-lost，关闭 ownerless Agent、取消 task-scoped Mailbox/OwnerEvent 和 barrier；每 Task 仅一 Completion。已有 settled outcome 与 receipt 保留，stateDiff 必须含 Agent/mailbox/event 取消变更。绝不从 native assistant tail 或进程 exit 证明成功。
9. closed 恢复不创建 runtime/Task/lease，不自动开工。未终态的 Completion/Inbox/Outbox 与 owner control 仍按原 Task owner/ID 恢复 accepted delivery；live binding 正常恢复时只能为仍需的未完成 Task 持有精确 lease，不能 reacquire 已 settled Task。Task owner 可以为 Main，不要求已 closed 结构 parent 重新运行。
10. 按 §7.7 协调 transient delivery：有 receipt 的 wake-settlement-pending 只补链接；Main mailbox import 保留原 key/epoch，accepted 无 native 等待，handled 不降级；其余旧同步状态才归一易失 offer。不能从消失的 claim 或 transport opportunity 推断业务成功。
11. 按 §7.8 的 kind-specific policy 协调每个未 acknowledged OwnerEvent：可 replay 的 logical-parent events 回到 `pending`（进程内 runtime 换代时同样按 `reset-owner-events` transaction 走这条回退，这是 `sent → pending` 除 recovery 之外唯一允许的回退）；已退出 generation 的 `prepare_shutdown` 会终态 ACK 或丢弃；`owner_health` 合并为最新当前值。保留 sequence/cursor authority，且绝不将 generation-bound event 投递给 replacement runtime。
12. 只协调已接纳的 pending delivery/control；ownerless closed 记录不自动 schedule，用户显式 resume 且新 input 后才有 execution。

由 recovery 产生的 mutations 会获得正常的 revisions 和 journal commits。如果 lease capacity 不可用，tasks 会保持为 non-settled，并且拥有方 Agent/host 会变为 unavailable；绝不能允许 Goal 像 lease 仍然存在那样继续运行。

打开时的 recovery transaction（`recover-agent-artifacts`、`recover-runtime-state`）若被 `[subagent/storage-capacity]` 拒绝，store 照常打开：状态保持未恢复，storage health 在本次打开期间一直是 `degraded-capacity`，诊断说明哪笔恢复没提交。用户仍能查看并删除已 settled 的子树腾出空间；下次打开会重新计算并提交 recovery。其他原因的 recovery 失败仍让打开失败。

## 13. Quotas、retention 与 ENOSPC

V1 中没有任何 limit 具有 unlimited 值。`usage.md` 负责 public overrides 和 ranges；下面这些是格式默认值以及硬性结构上限：

| 资源 | 默认值 | 结构上限 / 行为 |
|---|---:|---|
| 每个 Main open/closing Agents | 32 | 32，closed 不计 open；metadata/history 仍受 byte/Task quota 约束 |
| 每个 Agent 的 Tasks | 256 | 256 |
| 每个 Main 的 Tasks | 4096 | 4096 |
| 每个 conversation 的 Mailbox records（Root 或 Agent） | 1024 | consumed bodies 可 tombstone |
| armed Barrier 的 tasks | 256 | 超过上限则拒绝 barrier |
| 每个 Agent 的 native conversation + immutable system prompt | 64 MiB | prompt <=1 MiB；admission high-water；参见 active overshoot |
| 每个 Main 的全部 store bytes | 512 MiB | 包括 native conversations、metadata、trash/recovery |
| 每个 process install 的全部 store bytes | 2 GiB | 本 Main 现量 + 其他 mains 最多 60 s 的缓存扫描后准入；逼近上限时重扫 |
| 每个 Main 的 metadata checkpoint+journal | 64 MiB | 在新的 mutation 前 compact |
| 每个 conversation 的 live Mailbox body bytes（Root 或 Agent） | 4 MiB | pending+injected bodies |
| 每个 Main 的 pending Inbox/Outbox/OwnerEvent bytes | 16 MiB | delivery/control-required payloads |
| 每个 Main 的 maintenance allowance | 16 MiB | 仅用于 prepare/checkpoint/trash/recovery |
| 一条 model/task/mailbox text | 65,536 bytes | 在 mutation 前拒绝 |
| 一个 journal payload | 1 MiB | 一个 transaction 可以包含多个 frames；Root put 只带 Root 头；单条实体超限在 commit 前以 storage-capacity 拒绝 |
| 一个分区的集合条数 | 见 §8 | checkpoint 解码上限；写路径同样拒绝；可回收的集合按 §11.1 在 checkpoint 时回收 |

原生 Pi session 写入位于 metadata writer 之外，因此可能会因为一个或多个 in-flight 原生条目而超过配置的 high-water。AgentHost 会在每个 message/tool terminal event 时检查，并且在 child 活跃期间至少每秒检查一次。超过每个 Agent 或 Main 的 high-water 时，会中止新的 model work，在 persistence allowance 允许时将当前 Task settled 为 `failed(reason="storage-error")`，把 Agent 标记为 `unavailable(storage-capacity)`，并拒绝 spawn/follow-up/message。它绝不会通过截断有效的 conversation history 来强行满足限制。固定 maintenance allowance 预留给 settlement、tombstone、checkpoint 和 cleanup；任何新的用户工作都不能消耗它。

容量准入（每 Main store、metadata 用量、进程配额这些软上限）只拦接纳新工作的 transaction：`spawn-agent`、`followup-task`、`send-input`、`resume-agent`、`wait-agents`、`replace-unstarted-task`，以及 Agent 发起的 `owner-spawn`、`owner-followup`。结算、投递、OwnerEvent 发送与 ACK、已读、中断、超时、关闭、删除子树和 cleanup 都是把已接纳的工作做完，按 maintenance 提交，不经过容量准入：真实结果绝不能因为软上限丢掉，撞到上限时用户也仍能删子树释放空间。硬上限照样生效：规范化状态不超过 metadata hard cap、单帧不超过 1 MiB、集合条数不超过 §8 的解码上限、journal 不超过 metadata allowance。

如果 Task 的真实结果连硬上限都过不去、结算被 `storage-capacity` 拒绝，runtime 的收尾结算用 `failed(reason="storage-error")`，卡片如实写明结果因存储容量不足没能保存，并给出 `/subagents <agentId>` 和子 Agent 会话文件的路径；绝不能写成用户中断。收尾结算也存不进去时，Task 保持未结算，下次打开由 recovery 结成 `host-lost`。

当检测到 global/Main capacity 或 ENOSPC 时：

- 仍会等待既有 SDK prompt/tool 和 public idle/control drain；
- 在不需要写入或 allowance 允许时，read/list/Live/interrupt 和已验证的 delete 仍可使用；
- spawn、follow-up 和 mailbox admission 会在产生 public side effects 前以 `storage-unavailable`/`storage-capacity` 失败；
- pending completion delivery 保持持久化，并且只在 storage 恢复后重试；
- 不会自动删除任何 Agent/conversation；
- 显式的 settled-subtree deletion 是 retention mechanism；
- 准入新 work 前会清理 trash/prepared/obsolete generations。

V1 在某个 per-Main store 目录第一次完成 Agent admission 之后，绝不会自动删除它。当所有 Agents 都被删除后，它会进入 `dormant-empty`：不再保留任何 live Mailbox/Barrier/Completion/Inbox/Outbox/OwnerEvent、operation/Wake receipt、pending/running/failed Cleanup、prepared 目录、trash 条目或 recovery tail；Root/checkpoint/journal、已完成 cleanup 的证据，以及完整的 Agent tombstones 仍然保留，以维持格式权威和 Agent-ID 不复用。dormant-empty 所占字节仍计入 process quota。物理删除 Main-store 需要未来一个显式 maintenance 契约来有意保留或放宽这个不变量；V1 没有这样的契约。Main session 切换或 reload，以及 package uninstall，都绝不能静默抹掉它。

## 14. Namespace、格式版本与切换

当前生产 namespace 固定为 `<agent-dir>/pi-subagents/store-v2`；root/checkpoint/entity codec version 仍为 1，journal anchor 格式版本为 **3**，配置 schemaVersion 为 2，几者不能混同。格式 3 增加 Main `handled/handling_proof` 与 `continuation_native`，不改变原 Goal/producer 两类 Wake receipt。未知版本/字段、缺必填字段保守失败，不能将新终态解释为 pending、delivered 或 failure。

journal 格式 1 的 Root put 带完整 Root，格式 2/3 只带 RootHeader。打开旧 1/2 时按原规则完整回放；仅格式 1 的 Root put 抽取头字段，然后必须通过既有 checkpoint/CURRENT 原子切换到 anchor 3，成功后才允许新语义写入。升级失败即拒绝打开，不追加新语义到旧 anchor。旧 reader 只接受 anchor 1/2，遇 3 明确报不支持；若先解码已含新字段的 checkpoint，也会按未知字段/状态拒读，不能归一掉 handled。

升级必须重建 compiled consumers 并新开 process；A 的共享 transportBuildId 同步为 mailbox-v1.0.6，混合旧 bundle 明确拒绝。回滚不能通过改 pending.json、checkpoint、journal anchor 或删除债务来伪装兼容；不提供降级转换器。

旧 store-v1 不读、不转换、不删除；旧 namespace 不自动清理；切换与备份见 [维护](maintenance.md)。正常启动、close/resume 不删除 v2 历史，不在代码中加入 migration pointer、自动重建旧 ID 或重放旧 Task。

codec 保留的少量既有 Outbox 可选字段归一只作用于该 v2 namespace 的当前记录，不表示支持旧 store-v1。未来若需要新的存储格式必须另行设计与批准，本文不定义 speculative converter、copy-on-write pointer 或通用 downgrade 协议。

## 15. 必需测试

### Schemas 与不变量

- 对每个 entity 和 marker 执行 exact-key/type/range/UTF-8 校验；
- 覆盖每个 ID grammar/collision retry、Main-key collision check 和 canonical JSON/digest vector；
- 覆盖所有 Agent/Task queue、parent/depth/path、不可变 prompt artifact/profile/capability digest 一致性、Completion/Inbox/Outbox/Barrier 基数、Wake-receipt 共址/digest/唯一性，以及 OwnerEvent 交叉引用不变量；
- 覆盖 Task 的分 phase 字段、deadline 语义，以及 first-commit-wins race；
- 覆盖确定性的 checkpoint 分区、顺序、digest 以及 round-trip equality。

### Journal 与 transactions

- CRC-32C known vectors，以及 header/length/sequence/transaction digest 校验；
- short writes、fsync failure 和 uncertain commit rescan；
- 在每个 admission 步骤之后发生 crash：prepare、artifact sync、lease acquire、rename、每个 frame、commit sync，以及 prepare cleanup；
- commit 前不可见 identity/lease；已提交的 identity 必须总能恢复；
- 覆盖 owner-task/local-admission/metadata-mutation 在每个 phase 的 prepared 变体、精确的 commit-wins、仅 owner tasks 使用 TTL/generation、以及对 uncommitted/aborted cleanup 和 malformed evidence 的保守 skip；
- 覆盖 checkpoint 在每个步骤发生 crash、旧或新 CURRENT 的权威性，以及 obsolete cleanup；
- 覆盖 final-tail truncate/preserve 与 mid-file corruption fail-closed；
- 同一 Main 投递至少 100 个 65,536 B 的 completion：Root put frame 只有 Root 头、任何 frame 都与 Root 规模无关；随后带一个未 settled 的 Task 重开、删一个子树，全程不卡死；
- 单条实体超过 1 MiB 时以 storage-capacity 拒绝并降级 health，下一笔正常提交；
- metadata 硬上限下打开时 recovery 被拒仍能打开，删子树（maintenance）照常提交；
- fence 之后的显式 checkpoint 不删除 `CURRENT` 指向的 generation；
- v2 namespace 内格式 1/2 journal 打开时回放并 checkpoint 成格式 3；未知格式版本打开失败，不读取旧 store-v1；
- 升级 checkpoint 在建出空 journal、空 `CURRENT.tmp` 之后崩溃，重开仍能升级；删不掉的残留代不会让下一次切换撞 `EEXIST`；
- 读不回的 checkpoint（例如集合超过解码上限）不切换 CURRENT，旧代和 journal 字节不变；
- Main operation receipts 超过 4,096 次写入时按 §11.1 回收、store 一直能打开；和未结算 Task 相关、不能回收的 receipt 到 4,096 条后以 storage-capacity 干净拒绝；
- child 已读、投递结束的卡片仍可 checkpoint 回收；Main 的成功/已读/checkpoint（含升级 checkpoint）先于 A import/ACK 时材料不丢；A 完整退休后大量已读投影可回收，冷重开不再 unknown，重复点击与删除仍幂等；
- 软容量满时结算与投递照常提交、新工作被拒；结算被拒时卡片如实说明存储容量问题。

### Lease 与 recovery

- runtime-contract handles/lease IDs 绝不能被序列化；没有已提交 Wake receipt 的易失性 Goal claim 在 recovery 后必须总是重新 offer；
- live 未完成 Task 的持久 intents 必须在正确 owner 会话取得；cold owner loss 先结算/关闭，不 reacquire 已 settled lease 或自动启动；
- settlement 在 lease release 和 Wake creation 前后发生 crash 时，绝不能丢失 Completion，绝不能在同一 epoch 创建两个 owner，并且只允许文档中说明的那种位于 post-runtime/pre-receipt 不确定窗口内的后续 epoch duplicate continuation；
- 覆盖 starting/running/waiting 的 host-lost 转换、waiting 同 Task activation/active 位释放、queued 的 non-replay 行为，以及 lease-capacity failure；
- 覆盖 active 或 unloaded 的原生 JSONL 的 sole-writer/read-only enforcement 和 final-line 修复。

### Capacity、deletion 与 security

- 覆盖每个 count/byte 的 boundary-1/boundary/boundary+1；不存在 unlimited mode；
- 只有在 native-entry evidence/checkpoint 之后才允许 mailbox body tombstoning；
- 覆盖 active conversation high-water abort，并确保不截断 transcript；
- 覆盖 prepare/artifact/journal/checkpoint/tombstone/cleanup 上的 ENOSPC；
- 覆盖已完成 open 子树先 close/drain 再 delete，close 未收口或投递债未退休时保留全部历史，revision 变动重验且不隐式 force；
- 覆盖 subtree tombstone 的原子可见性、Agent-ID 的机械不复用、被 compact 的非 Agent IDs 的概率性 128-bit 唯一性、crash-safe trash cleanup，以及 unread warning counts；
- 覆盖 OwnerEvent ACK 不能跨越 pending/generation、能够推进持久的 acknowledged-prefix cursor、支持安全的 ACKed-event compaction、每种 kind 都遵循其 replacement replay 表，以及 `prepare_shutdown` 永远不会关闭 replacement runtime；
- 覆盖 dormant-empty 保留 Root/checkpoint/tombstones、不包含 live/pending artifacts、计入 quota 且永不自动删除；
- 覆盖恶意 symlink/UID/mode/unexpected layout、lock contention、stale PID/PID reuse 的保守行为；
- 路径中不得出现原始 session/Task names；model-visible results 中不得包含 store path；
- 对不支持的新版本和损坏 store，必须保留 bytes 并以 read-only failure 结束。

import type {
  AgentId, BarrierId, CleanupId, CompletionId, InboxId, MessageId, OutboxId,
  OwnerEventId, ReceiptId, TaskId, TransactionId,
} from "../domain/types.js";

export interface ConversationRefV1 { kind: "main" | "agent"; session_id: string; agent_id?: AgentId }
export interface LeaseIntentV1 { api_version: 1; session_id: string; owner_id: "pi-subagents"; logical_key: TaskId; reason: string }
export type ReasoningEffortV1 = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface RoleSnapshotV1 { name: string; source: "built-in" | "user" | "project"; provenance: string; body: string; sha256: string }
// Additive V1 data: old profiles remain readable, but wrapper-backed execution
// requires this proof. The capability fingerprint includes it as structured data.
export interface ExecutionFactoryProofV1 { version: 1; canonical_path: string; sha256: string; exports: string[] }
export interface BuiltinExtensionProofV1 { version: 1; pi_version: string }
export interface CapabilityEntryV1 { child_factory?: import("pi-runtime-contracts/child-capabilities-v1").ChildFactoryProofV1; factory_required?: boolean; builtin_proof?: BuiltinExtensionProofV1; execution_factory?: ExecutionFactoryProofV1; sdk_provider?: import("pi-session-runtime/sdk-provider").SdkProviderProofV1; owner: string; main_entrypoint: string; child_entrypoint: string; tools: string[]; providers: string[]; hooks: string[]; sha256: string }
export interface CapabilityToolDefinitionV1 { name: string; definition_sha256: string; owner_id?: string }
export interface CapabilitySnapshotV1 { version: 1; fingerprint: string; active_tools: string[]; tool_definitions: CapabilityToolDefinitionV1[]; entries: CapabilityEntryV1[] }
export interface FrozenProfileV1 {
  version: 1; role: RoleSnapshotV1; provider: string; model: string; model_scope: string[]; reasoning_effort: ReasoningEffortV1;
  settings_snapshot: ReturnType<import("@earendil-works/pi-coding-agent").ExtensionAPI["getSettings"]>; delegation_max_depth: 1 | 2;
  service_tier?: string; task_timeout_ms: number; cwd: string; project_trusted: boolean;
  system_prompt_options_sha256: string; prompt_assembler_version: 1; system_prompt_relative_path: string;
  system_prompt_bytes: number; system_prompt_sha256: string; capabilities: CapabilitySnapshotV1; created_at: string;
}
export type AgentAvailabilityReasonV1 = "capability-drift" | "credential-unavailable" | "model-unavailable" | "role-unavailable" | "runtime-unavailable" | "protocol-incompatible" | "storage-corrupt" | "storage-capacity" | "conversation-corrupt";
export interface ConversationRecordV1 { session_id: string; relative_path: string; initial_bytes: number; initial_sha256: string; last_validated_bytes: number; last_validated_mtime_ms: number; last_validated_leaf_id?: string }
export interface AgentRecordV1 {
  lifecycle: "open" | "closing" | "closed"; lifecycle_revision: number; runtime_generation: number; closed_at?: string; close_reason?: string;
  version: 1; record_revision: number; agent_id: AgentId; parent_agent_id?: AgentId; parent_conversation: ConversationRefV1;
  task_name: string; task_path: string; depth: 1 | 2; created_at: string; created_revision: number; profile: FrozenProfileV1;
  conversation: ConversationRecordV1; availability: "available" | "unavailable"; unavailable_reason?: AgentAvailabilityReasonV1;
  unavailable_detail?: string; current_task_id?: TaskId; queued_task_ids: TaskId[]; next_mailbox_sequence: number;
  next_owner_event_sequence: number; last_owner_event_acked_sequence: number;
}
export type TaskOriginV1 = "initial" | "follow-up" | "continuation";
export type TaskPhaseV1 = "admitted" | "starting" | "running" | "waiting" | "settled";
export type TaskOutcomeV1 = "completed" | "partial" | "blocked" | "failed" | "interrupted";
export type TaskReasonV1 = "normal-final" | "finish-task" | "timeout" | "host-lost" | "user-interrupt" | "parent-interrupt" | "provider-error" | "tool-error" | "user-input-required" | "approval-required" | "runtime-crash" | "protocol-error" | "capability-drift" | "credential-unavailable" | "storage-error" | "agent-closed-force" | "main-session-ended";
export interface FinishDeclarationV1 { outcome: "partial" | "blocked"; text: string; text_sha256: string; reason?: "user-input-required" | "approval-required" | "external-prerequisite"; declared_at: string; tool_call_id: string; request_id: string; runtime_generation: number }
export interface InteractionBlockV1 { runtime_generation: number; first_request_id: string; kind: "select" | "confirm" | "input" | "editor" | "approval"; public_reason: "user-input-required" | "approval-required"; title_sha256: string; count: number; additional_requests_truncated: boolean; first_seen_at: string; last_seen_at: string }
export interface TaskUsageSnapshotV1 { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; total_tokens: number }
export interface TaskRecordV1 {
  version: 1; record_revision: number; task_id: TaskId; agent_id: AgentId; origin: TaskOriginV1; admission_order: number;
  initiator: { kind: "user" | "main-model" | "agent-model"; conversation: ConversationRefV1 }; owner_conversation: ConversationRefV1;
  message: string; phase: TaskPhaseV1; admitted_at: string; started_at?: string; deadline_at_ms?: number; usage_baseline?: TaskUsageSnapshotV1;
  waiting_on?: { kind: "process" | "agent-barrier"; key: string }; runtime_generation?: number;
  interrupt_requested_at?: string; interrupt_generation?: number; cancellation_reason?: TaskReasonV1; activation_order?: number; finish_declaration?: FinishDeclarationV1;
  interaction_block?: InteractionBlockV1; settled_at?: string; outcome?: TaskOutcomeV1; reason?: TaskReasonV1;
  completion_id?: CompletionId; lease_intent: LeaseIntentV1; lease_disposition: "required" | "release-pending" | "released";
}
export interface MailboxRecordV1 { version: 1; record_revision: number; message_id: MessageId; sender: ConversationRefV1; recipient: ConversationRefV1; sequence: number; body?: string; body_bytes: number; body_sha256: string; task_id?: TaskId; source?: "user" | "main-model" | "agent-model"; cancelled_at?: string; state: "pending" | "injected" | "consumed" | "cancelled"; created_at: string; injected_at?: string; injected_into?: { kind: "task"; task_id: TaskId } | { kind: "idle-conversation" }; session_entry_id?: string; consumed_at?: string }
export interface BarrierRecordV1 { version: 1; record_revision: number; barrier_id: BarrierId; owner: ConversationRefV1; target_agent_ids: AgentId[]; task_ids: TaskId[]; completion_ids: CompletionId[]; state: "armed" | "satisfied" | "cancelled"; created_at: string; settled_at?: string; cancelled_at?: string; snapshot_sha256: string; wake_outbox_id?: OutboxId }
export interface CompletionUsageV1 { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; total_tokens: number }
export interface CompletionRecordV1 { version: 1; record_revision: number; completion_id: CompletionId; task_id: TaskId; agent_id: AgentId; recipient: ConversationRefV1; outcome: TaskOutcomeV1; reason: TaskReasonV1; final_text: string; summary: string; usage: CompletionUsageV1; task_admitted_at: string; task_started_at?: string; completed_at: string }
export interface CompletionCardProjectionV1 { content: string; content_sha256: string; details_json: string; details_sha256: string; result_truncated: boolean; original_result_bytes: number; rendered_result_bytes: number; projection_sha256: string }
export interface InboxRecordV1 { version: 1; record_revision: number; inbox_id: InboxId; completion_id: CompletionId; recipient: ConversationRefV1; projection: CompletionCardProjectionV1; state: "pending-append" | "appended"; created_at: string; append_attempts: number; model_entry_id?: string; model_appended_at?: string; ui_read_at?: string; ui_read_revision?: number }
export interface ViewedInboxReceiptV1 { inbox_id: string; completion_id: string; projection_sha256: string; entry_id: string }
export type OutboxKindV1 = "completion-wake" | "barrier-wake" | "barrier-catch-up";
export type OutboxDeliveryStateV1 = "pending" | "delivering" | "cards-appended" | "wake-settlement-pending" | "delivered" | "handled" | "delivery-failed";
// `consumer-deferred` 与 `wake_deferral` 只保留兼容读取：旧版本写过它们，当前没有任何写入
// 路径。recovery 在 store 打开时把这种记录映射回 not-offered 并剥掉 wake_deferral，新记录绝不写出。
export type OutboxWakeStateV1 = "not-offered" | "foreground-pending" | "open" | "claimed" | "consumer-deferred" | "fallback-appended" | "settled" | "aborted";
/** 被 claim 的 consumer 明确不给 continuation proof 时记录的 offer 身份、epoch 与原因；DELIVERY_PROTOCOL §7.6。 */
export interface OutboxWakeDeferralV1 { version: 1; offer_id: string; offer_generation: number; wake_epoch: number; reason: "claimed-without-proof"; deferred_at: string }
/**
 * Owner 级「这批 card 是否已被模型在一轮成功 turn 里处理」：`delivered` 只证明消息落盘并请求过一次 wake，
 * 不证明模型处理过。pending 随终态事务写下，只有 owner 观察到这批 card 全部进过一轮非 abort、非 error 的
 * Main run 且该轮 settled，才翻成 settled；身份精确到 (wake_epoch, continuation_identity)。DELIVERY_PROTOCOL §7.9。
 */
export interface OutboxTurnSettlementV1 { version: 1; wake_epoch: number; continuation_identity: string; state: "pending" | "settled"; pending_at: string; settled_at?: string }
export interface WakeSettlementReceiptV1 { version: 1; record_revision: number; receipt_id: ReceiptId; outbox_id: OutboxId; wake_epoch: number; kind: "goal-claimed" | "producer-fallback"; claimant_owner_id?: string; claimant_generation?: number; runtime_delivery: "delivered" | "skipped"; continuation_identity: string; continuation_sha256: string; committed_at: string }
/** A local copy of the native fact acknowledged to Mailbox, before a Wake receipt owns it. */
export interface OutboxContinuationNativeV1 { wake_epoch: number; entry_id: string; sha256: string }
export interface MainHandledCardV1 {
  inbox_id: InboxId; completion_id: CompletionId; entry_id: string; projection_sha256: string;
  run_entry_id: string; run_sha256: string; assistant_entry_id: string;
}
/** Only the Main run owner produces this proof; transport opportunity is insufficient. */
export interface OutboxHandlingProofV1 { version: 1; session_id: string; wake_epoch: number; cards: MainHandledCardV1[] }
export interface OutboxRecordV1 { version: 1; record_revision: number; outbox_id: OutboxId; kind: OutboxKindV1; source: ConversationRefV1; recipient: ConversationRefV1; completion_ids: CompletionId[]; state: OutboxDeliveryStateV1; wake_state: OutboxWakeStateV1; delivery_attempts: number; wake_epoch: number; settlement_kind?: "goal-claimed" | "producer-fallback"; settlement_proof_id?: ReceiptId; settlement_proof_sha256?: string; wake_deferral?: OutboxWakeDeferralV1; turn_settlement?: OutboxTurnSettlementV1; handling_proof?: OutboxHandlingProofV1; continuation_native?: OutboxContinuationNativeV1; created_at: string; updated_at: string; delivered_at?: string; last_error_code?: string; correlation_id?: string }
export type OwnerEventKindV1 = "confirm_task_commit" | "acquire_task_lease" | "release_task_lease" | "mailbox_delivery" | "completion_delivery" | "barrier_cancelled" | "prepare_shutdown" | "owner_health";
export interface OwnerEventRecordV1 { version: 1; record_revision: number; event_id: OwnerEventId; target: ConversationRefV1; target_runtime_generation?: number; event_sequence: number; kind: OwnerEventKindV1; payload_json: string; payload_sha256: string; state: "pending" | "sent" | "acked" | "cancelled"; cancelled_at?: string; attempts: number; created_at: string; sent_at?: string; acked_at?: string }
export interface OperationReceiptV1 { version: 1; record_revision: number; receipt_id: ReceiptId; request_id: string; operation_digest: string; caller: ConversationRefV1; runtime_generation: number; operation: string; state: "committed" | "aborted"; transaction_id: TransactionId; result_sha256?: string; result_json?: string; created_at: string; settled_at?: string }
export interface SubtreeTombstoneV1 { version: 1; record_revision: number; root_agent_id: AgentId; agent_ids: AgentId[]; task_count: number; mailbox_count: number; completion_count: number; unread_completion_count: number; identity_sha256: string; deleted_at: string; cleanup_id: CleanupId }
export interface CleanupRecordV1 { version: 1; record_revision: number; cleanup_id: CleanupId; kind: "subtree-delete" | "orphan-prepared"; state: "pending" | "running" | "complete" | "failed"; relative_paths: string[]; created_at: string; updated_at: string; last_error_code?: string }
export interface PreparedArtifactV1 { temporary_path: string; final_path: string; bytes: number; sha256: string; kind: "conversation" | "system-prompt" | "checkpoint-input" | "cleanup-input" }
export interface PreparedOwnerTaskOperationV1 { kind: "spawn" | "followup"; request_id: string; caller: ConversationRefV1; caller_runtime_generation: number; operation_digest: string; prepared_token_sha256: string; expires_at: string; reserved_agent_id?: AgentId; reserved_task_id: TaskId; reserved_task_path: string; structural_parent: ConversationRefV1; logical_lease_key: TaskId; lease_owner: ConversationRefV1; public_result_json: string; public_result_sha256: string; phase: "prepared" | "lease-proved" | "commit-requested" }
export interface PreparedLocalAdmissionV1 { lease_owner: ConversationRefV1; kind: "local-admission"; request_id: string; caller: ConversationRefV1; operation_digest: string; reserved_agent_id?: AgentId; reserved_task_id: TaskId; reserved_task_path: string; structural_parent: ConversationRefV1; logical_lease_key: TaskId; public_result_json: string; public_result_sha256: string; phase: "prepared" | "lease-proved" | "commit-requested" }
export interface PreparedMetadataMutationV1 { kind: "metadata-mutation"; request_id: string; caller: ConversationRefV1; operation_digest: string; phase: "prepared" | "commit-requested" }
export type PreparedOperationV1 = PreparedOwnerTaskOperationV1 | PreparedLocalAdmissionV1 | PreparedMetadataMutationV1;
export interface PrepareRecordV1 { version: 1; transaction_id: TransactionId; operation: string; base_revision: number; proposed_revision: number; created_at: string; prepared_operation: PreparedOperationV1; lease_intents: LeaseIntentV1[]; artifacts: PreparedArtifactV1[] }
export interface AbortRecordV1 { version: 1; transaction_id: TransactionId; aborted_at: string; reason_code: string }
export interface RootCheckpointV1 { version: 1; main_key: string; host_revision: number; next_admission_order: number; next_mailbox_sequence: number; next_owner_event_sequence: number; last_owner_event_acked_sequence: number; agent_ids: AgentId[]; mailbox: MailboxRecordV1[]; inbox: InboxRecordV1[]; outbox: OutboxRecordV1[]; owner_events: OwnerEventRecordV1[]; barrier?: BarrierRecordV1; operation_receipts: OperationReceiptV1[]; wake_receipts: WakeSettlementReceiptV1[]; cleanup: CleanupRecordV1[]; tombstones: SubtreeTombstoneV1[] }
/** journal 里 Root put 的值（journal 格式 2）：只有 Root 头。Root 的集合只随各自实体的 put/delete 变化，单帧大小因此和 Root 规模无关。 */
export type RootHeaderV1 = Pick<RootCheckpointV1, "version" | "main_key" | "host_revision" | "next_admission_order" | "next_mailbox_sequence" | "next_owner_event_sequence" | "last_owner_event_acked_sequence" | "agent_ids">;
export interface AgentCheckpointV1 { version: 1; host_revision: number; agent: AgentRecordV1; tasks: TaskRecordV1[]; mailbox: MailboxRecordV1[]; barrier?: BarrierRecordV1; completions: CompletionRecordV1[]; inbox: InboxRecordV1[]; outbox: OutboxRecordV1[]; owner_events: OwnerEventRecordV1[]; operation_receipts: OperationReceiptV1[]; wake_receipts: WakeSettlementReceiptV1[] }
export interface NormalizedStoreStateV1 { root: RootCheckpointV1; agents: AgentCheckpointV1[] }

export type DurableEntityV1 = AgentRecordV1 | TaskRecordV1 | MailboxRecordV1 | BarrierRecordV1 | CompletionRecordV1 | InboxRecordV1 | OutboxRecordV1 | OwnerEventRecordV1 | OperationReceiptV1 | WakeSettlementReceiptV1 | CleanupRecordV1 | SubtreeTombstoneV1;

export const ID_PREFIXES = [
  "agt",
  "tsk",
  "msg",
  "bar",
  "cmp",
  "inb",
  "out",
  "evt",
  "txn",
  "rcp",
  "cln",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];
export type AgentId = `agt_${string}`;
export type TaskId = `tsk_${string}`;
export type MessageId = `msg_${string}`;
export type BarrierId = `bar_${string}`;
export type CompletionId = `cmp_${string}`;
export type InboxId = `inb_${string}`;
export type OutboxId = `out_${string}`;
export type OwnerEventId = `evt_${string}`;
export type TransactionId = `txn_${string}`;
export type ReceiptId = `rcp_${string}`;
export type CleanupId = `cln_${string}`;
export type DomainId =
  | AgentId
  | TaskId
  | MessageId
  | BarrierId
  | CompletionId
  | InboxId
  | OutboxId
  | OwnerEventId
  | TransactionId
  | ReceiptId
  | CleanupId;

export type TaskPhase = "admitted" | "starting" | "running" | "waiting" | "settled";
export type TaskOutcome = "completed" | "partial" | "blocked" | "failed" | "interrupted";
export type TaskReason =
  | "normal-final"
  | "finish-task"
  | "timeout"
  | "host-lost"
  | "user-interrupt"
  | "parent-interrupt"
  | "provider-error"
  | "tool-error"
  | "user-input-required"
  | "approval-required"
  | "runtime-crash"
  | "protocol-error"
  | "capability-drift"
  | "credential-unavailable"
  | "storage-error";
export type AgentState = "queued" | "starting" | "running" | "waiting" | "idle" | "unavailable";
export type RuntimeResidency = "resident" | "unloaded";

export interface AgentTreeNode {
  readonly agentId: AgentId;
  readonly taskName: string;
  readonly taskPath: string;
  readonly depth: 1 | 2;
  readonly parentAgentId?: AgentId;
}

export type ConversationCaller =
  | { readonly kind: "main" }
  | { readonly kind: "agent"; readonly agentId: AgentId };

export type ResolvedTarget =
  | { readonly kind: "main"; readonly taskPath: "/root" }
  | { readonly kind: "agent"; readonly agent: AgentTreeNode };

export interface WaitingOn {
  readonly kind: "process" | "agent-barrier";
  readonly key: string;
}

export interface TaskState {
  readonly taskId: TaskId;
  readonly phase: TaskPhase;
  readonly admittedAt: string;
  readonly startedAt?: string;
  readonly deadlineAtMs?: number;
  readonly waitingOn?: WaitingOn;
  readonly runtimeGeneration?: number;
  readonly interruptRequestedAt?: string;
  readonly interruptGeneration?: number;
  readonly settledAt?: string;
  readonly outcome?: TaskOutcome;
  readonly reason?: TaskReason;
  readonly completionId?: CompletionId;
  readonly leaseDisposition: "required" | "release-pending" | "released";
}

export type TaskEvent =
  | {
      readonly type: "start";
      readonly startedAt: string;
      readonly deadlineAtMs: number;
      readonly runtimeGeneration: number;
    }
  | { readonly type: "begin-running"; readonly runtimeGeneration: number }
  | { readonly type: "begin-wait"; readonly runtimeGeneration: number; readonly waitingOn: WaitingOn }
  | { readonly type: "dependency-ready"; readonly runtimeGeneration: number }
  | {
      readonly type: "request-interrupt";
      readonly runtimeGeneration: number;
      readonly requestedAt: string;
    }
  | {
      readonly type: "settle";
      readonly runtimeGeneration: number;
      readonly settledAt: string;
      readonly outcome: TaskOutcome;
      readonly reason: TaskReason;
      readonly completionId: CompletionId;
    }
  | { readonly type: "mark-lease-released" };

export interface TaskTransitionResult {
  readonly state: TaskState;
  readonly changed: boolean;
  readonly stale: boolean;
}

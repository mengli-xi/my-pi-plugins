import type { Attention, ProcessKind } from "../domain/types.js";

export type NotificationKindV1 = "terminal" | "watch-match" | "watch-suppressed" | "matcher-error" | "operational";
export type NotificationLaneV1 = "context" | "turn";
export type NotificationTargetV1 = Readonly<{ strategy: "main" | "child"; scopeToken: string }>;

export interface NotificationFactV1 {
  readonly version: 1;
  readonly factId: string;
  readonly sessionScopeId: string;
  readonly source: Readonly<{
    hostIncarnationId: string;
    notificationSequence: number;
    supervisor?: Readonly<{ nonce: string; generation: number; eventSequence: number }>;
  }>;
  readonly observedAt: string;
  readonly process?: Readonly<{ id: string; name: string; kind: ProcessKind }>;
  readonly kind: NotificationKindV1;
  readonly stableCode?: string;
  readonly correlationId?: string;
  readonly attention: Attention;
  readonly watch?: Readonly<{
    key: string;
    generation: number;
    repeat: boolean;
    firstSequence: number;
    lastSequence: number;
    count: number;
  }>;
  readonly terminal?: Readonly<{
    outcome: "succeeded" | "failed" | "stopped" | "killed" | "crashed";
    cause: "completed" | "exit-code" | "signal" | "runtime-error" | "stopped" | "killed" | "timeout";
    durationMs: number;
    exitCode?: number;
    signal?: string;
    timeoutMs?: number;
  }>;
  readonly excerpt?: NotificationExcerptRefV1;
}

export interface NotificationExcerptRefV1 {
  readonly processId: string;
  readonly stream: "stdout" | "stderr";
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly truncated: boolean;
}

export interface ProcessTuiEntryEnvelopeV1 {
  readonly version: 1;
  readonly customType: "process-event-v2";
  readonly dataJson: string;
  readonly dataSha256: string;
}

export interface ProcessNotificationReceiptEnvelopeV1 {
  readonly version: 1;
  readonly customType: "process-notification-receipt-v1";
  readonly dataJson: string;
  readonly dataSha256: string;
}

export interface LeaseWakeArtifactSnapshotV1 {
  readonly deliveryId: string;
  readonly state: "pending" | "recorded";
  readonly entry: ProcessNotificationReceiptEnvelopeV1;
}

export interface ObserveNotificationInputV1 {
  readonly target: NotificationTargetV1;
  readonly fact: NotificationFactV1;
  readonly tuiEntry?: ProcessTuiEntryEnvelopeV1;
  readonly leaseWakeTransactionId?: string;
}

export interface ProcessNotificationBatchItemV1 {
  readonly kind: NotificationKindV1;
  readonly processId?: string;
  readonly processName?: string;
  readonly stableCode?: string;
  readonly watchKey?: string;
  readonly watchGeneration?: number;
  readonly count: number;
  readonly matchedCount?: number;
  readonly suppressedCount?: number;
  readonly firstFactId: string;
  readonly lastFactId: string;
  readonly hostIncarnationId: string;
  readonly firstNotificationSequence: number;
  readonly lastNotificationSequence: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly terminal?: NotificationFactV1["terminal"];
  readonly excerptRef?: NotificationExcerptRefV1;
  readonly latestExcerpt?: Readonly<{ stream: "stdout" | "stderr"; text: string; truncated: boolean }>;
}

export interface ProcessNotificationBatchV1 {
  readonly version: 1;
  readonly batchId: string;
  readonly sessionScopeId: string;
  readonly epochId: string;
  readonly reason: "user-boundary" | "main-admission" | "subagent-admission";
  readonly mode: "aggregate" | "minimal-continuation";
  readonly createdAt: string;
  readonly items: readonly ProcessNotificationBatchItemV1[];
  readonly overflow?: Readonly<{ omittedItems: number; byKind: Readonly<Record<string, number>> }>;
}

export interface ProcessNotificationSnapshotV1 {
  readonly version: 1;
  readonly revision: number;
  readonly watches: readonly Readonly<{
    processId: string;
    key: string;
    generation: number;
    matchedCount: number;
    suppressedCount: number;
    firstSequence: number;
    lastSequence: number;
    lastObservedAt: string;
  }>[];
}

export interface NotificationBrokerCountersV1 {
  readonly factsObserved: number;
  readonly repeatMatchesCoalesced: number;
  readonly batchesPrepared: number;
  readonly batchesCommitted: number;
  readonly batchesRolledBack: number;
  readonly itemsOverflowed: number;
  readonly targetsOverflowed: number;
  readonly tuiDeliveriesDropped: number;
}

export interface NotificationBrokerLimitsV1 {
  readonly generalSlots: number;
  readonly terminalSlots: number;
  readonly targetOverflowSlots: number;
  readonly totalSlots: number;
  readonly modelTargetPartitions: number;
  readonly serializedBytes: number;
  readonly controlPlaneBindings: number;
  readonly controlPlaneBytes: number;
  readonly tuiDeliveryRecords: number;
  readonly tuiDeliveryBytes: number;
  readonly retirementPlans: number;
  readonly batchItems: number;
  readonly batchBytes: number;
  readonly excerptBytes: number;
}

export const NOTIFICATION_BROKER_LIMITS_V1: NotificationBrokerLimitsV1 = Object.freeze({
  generalSlots: 224,
  terminalSlots: 256,
  targetOverflowSlots: 32,
  totalSlots: 512,
  modelTargetPartitions: 32,
  serializedBytes: 512 * 1024,
  controlPlaneBindings: 128,
  controlPlaneBytes: 128 * 1024,
  tuiDeliveryRecords: 512,
  tuiDeliveryBytes: 512 * 1024,
  retirementPlans: 32,
  batchItems: 50,
  batchBytes: 32 * 1024,
  excerptBytes: 2000,
});

export type NotificationBrokerErrorCodeV1 =
  | "invalid-fact"
  | "session-mismatch"
  | "sequence-replay"
  | "sequence-gap"
  | "terminal-conflict"
  | "batch-id-conflict"
  | "batch-not-found"
  | "batch-already-settled"
  | "prepare-in-progress"
  | "state-corrupt"
  | "capacity";

export class NotificationBrokerErrorV1 extends Error {
  readonly code: NotificationBrokerErrorCodeV1;
  constructor(code: NotificationBrokerErrorCodeV1, message: string) { super(message); this.name = "NotificationBrokerErrorV1"; this.code = code; }
}

export interface PrepareNotificationBatchInputV1 {
  readonly target: NotificationTargetV1;
  readonly lane: NotificationLaneV1;
  readonly batchId: string;
  readonly epochId: string;
  readonly reason: ProcessNotificationBatchV1["reason"];
  readonly createdAt: string;
  readonly mode?: ProcessNotificationBatchV1["mode"];
}

export interface PrepareMinimalContinuationInputV1 {
  readonly target: NotificationTargetV1;
  readonly batchId: string;
  readonly epochId: string;
  readonly reason: "main-admission" | "subagent-admission";
  readonly createdAt: string;
  readonly leaseWakeTransactionIds: readonly string[];
}

export interface PreparedNotificationBatchV1 {
  readonly batch: ProcessNotificationBatchV1;
  readonly leaseWakeTransactionIds: readonly string[];
}

export interface ObserveNotificationResultV1 {
  readonly factId: string;
  readonly notificationSequence: number;
  readonly revision: number;
  readonly modelDisposition: "aggregated" | "ignored" | "target-overflowed";
  readonly tuiDisposition: "append" | "aggregate-only" | "none";
  readonly tuiDeliveryId?: string;
}

export type TuiDeliveryIdentityV1 =
  | Readonly<{ kind: "unique"; eventKind: "terminal" | "watch-match"; hostIncarnationId: string; processId: string; factId: string }>
  | Readonly<{ kind: "watch"; hostIncarnationId: string; processId: string; watchKey: string; watchGeneration: number }>
  | Readonly<{ kind: "matcher"; hostIncarnationId: string; processId: string; watchKey: string; watchGeneration: number; stableCode: string }>
  | Readonly<{ kind: "operational"; hostIncarnationId: string; processId?: string; stableCode: string; correlationId?: string }>;

export interface TuiDeliveryRecordSnapshotV1 {
  readonly deliveryId: string;
  readonly identity: TuiDeliveryIdentityV1;
  readonly target: NotificationTargetV1;
  readonly processId?: string;
  readonly firstFactId: string;
  readonly lastFactId: string;
  readonly count: number;
  readonly state: "pending" | "recorded";
  readonly entry?: ProcessTuiEntryEnvelopeV1;
}

export interface StandaloneWakeBindingSnapshotV1 {
  readonly transactionId: string;
  readonly target: NotificationTargetV1;
  readonly lane: "turn";
  readonly phase: "unbound" | "batch-prepared" | "batch-committed";
  readonly batchId?: string;
  readonly claimed: boolean;
}

export interface SettledStandaloneWakeSnapshotV1 {
  readonly transactionId: string;
  readonly outcome: "delivered" | "skipped" | "aborted";
}

export interface RetirementPlanV1 {
  readonly retirementId: string;
  readonly kind: "target" | "scope";
  readonly target?: NotificationTargetV1;
  readonly processIds: readonly string[];
  readonly leaseWakeTransactionIds: readonly string[];
  readonly standaloneWakeTransactionIds: readonly string[];
  readonly state: "pending";
}

export interface NotificationBrokerHealthV1 {
  readonly revision: number;
  readonly degraded: boolean;
  readonly slots: Readonly<{ general: number; terminal: number; overflow: number; total: number }>;
  readonly serializedBytes: number;
  readonly controlPlaneBindings: number;
  readonly controlPlaneSerializedBytes: number;
  readonly tuiDeliveryRecords: number;
  readonly tuiDeliverySerializedBytes: number;
  readonly pendingRetirements: number;
  readonly modelTargetPartitions: number;
  readonly counters: NotificationBrokerCountersV1;
}

export interface NotificationBrokerStateV1 {
  readonly version: 1;
  readonly sessionScopeId: string;
  readonly revision: number;
  readonly degraded: boolean;
  readonly sourceFences: readonly Readonly<{ hostIncarnationId: string; highestObservedNotificationSequence: number; highestCommittedNotificationSequence: number }>[];
  readonly items: readonly BrokerItemSnapshotV1[];
  readonly prepared: readonly PreparedWindowSnapshotV1[];
  readonly openWindows: readonly Readonly<{ target: NotificationTargetV1; lane: NotificationLaneV1; windowId: string }>[];
  readonly overflows: readonly TargetOverflowSnapshotV1[];
  readonly processOwners: readonly Readonly<{ processId: string; target: NotificationTargetV1 }>[];
  readonly watches: readonly Readonly<{
    processId: string;
    key: string;
    generation: number;
    matchedCount: number;
    suppressedCount: number;
    firstSequence: number;
    lastSequence: number;
    lastObservedAt: string;
  }>[];
  readonly terminalProcesses: readonly Readonly<{ processId: string; factId: string }>[];
  readonly leaseWakeBindings: readonly LeaseWakeBindingSnapshotV1[];
  readonly standaloneWakeBindings: readonly StandaloneWakeBindingSnapshotV1[];
  readonly settledStandaloneWakes: readonly SettledStandaloneWakeSnapshotV1[];
  readonly tuiDeliveries: readonly TuiDeliveryRecordSnapshotV1[];
  readonly pendingRetirements: readonly RetirementPlanV1[];
  readonly settledBatches: readonly SettledBatchSnapshotV1[];
  readonly disposed: boolean;
  readonly counters: NotificationBrokerCountersV1;
}

export interface LeaseWakeBindingSnapshotV1 {
  readonly transactionId: string;
  readonly factId: string;
  readonly target: NotificationTargetV1;
  readonly lane: NotificationLaneV1 | "ignore";
  readonly hostIncarnationId: string;
  readonly notificationSequence: number;
  readonly artifact: LeaseWakeArtifactSnapshotV1;
  readonly minimalItem: ProcessNotificationBatchItemV1;
}

export interface SettledBatchSnapshotV1 {
  readonly batchId: string;
  readonly outcome: "committed" | "rolled-back";
}

export interface BrokerItemSnapshotV1 {
  readonly key: string;
  readonly windowId: string;
  readonly target: NotificationTargetV1;
  readonly lane: NotificationLaneV1;
  readonly firstFactId: string;
  readonly lastFactId: string;
  readonly hostIncarnationId: string;
  readonly firstNotificationSequence: number;
  readonly lastNotificationSequence: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly count: number;
  readonly matchedCount?: number;
  readonly suppressedCount?: number;
  readonly identity: Readonly<{
    kind: NotificationKindV1;
    attention: Attention;
    process?: NotificationFactV1["process"];
    stableCode?: string;
    correlationId?: string;
    watch?: Omit<NonNullable<NotificationFactV1["watch"]>, "count">;
    terminal?: NotificationFactV1["terminal"];
  }>;
  readonly latestExcerptRef?: NotificationExcerptRefV1;
  readonly leaseWakeTransactionIds: readonly string[];
}

export interface PreparedWindowSnapshotV1 {
  readonly batchId: string;
  readonly target: NotificationTargetV1;
  readonly lane: NotificationLaneV1;
  readonly windowId: string;
  readonly epochId: string;
  readonly reason: ProcessNotificationBatchV1["reason"];
  readonly mode: ProcessNotificationBatchV1["mode"];
  readonly createdAt: string;
  readonly itemKeys: readonly string[];
  readonly leaseWakeTransactionIds: readonly string[];
  readonly batch: ProcessNotificationBatchV1;
  readonly settled: false;
}

export interface OverflowSourceRangeV1 {
  readonly hostIncarnationId: string;
  readonly firstNotificationSequence: number;
  readonly lastNotificationSequence: number;
}

export interface OverflowSummaryV1 {
  readonly lane: NotificationLaneV1;
  readonly omittedItems: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly sourceRanges: readonly OverflowSourceRangeV1[];
  readonly leaseWakeTransactionIds: readonly string[];
}

export interface TargetOverflowSnapshotV1 {
  readonly target: NotificationTargetV1;
  readonly prepared: readonly OverflowSummaryV1[];
  readonly open: readonly OverflowSummaryV1[];
}

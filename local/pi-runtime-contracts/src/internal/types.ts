import type { Result } from "#internal/errors";

export type LeaseOutcome = "ready" | "failed" | "cancelled";
export type DeliveryOutcome = "delivered" | "skipped" | "delivery-failed";

export interface BlockingLeaseSnapshotV1 {
  readonly sessionId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly ownerId: string;
  readonly logicalKey: string;
  readonly reason?: string;
  readonly acquiredAt: number;
  readonly lastCheckInAt: number;
}

export interface RegistrySnapshotV1 {
  readonly apiVersion: 1;
  readonly sessionId: string;
  readonly registryVersion: number;
  readonly blocking: readonly BlockingLeaseSnapshotV1[];
  readonly openOffers: number;
  readonly consumerGeneration?: number;
}

export interface WakeOfferSnapshotV1 {
  readonly sessionId: string;
  readonly offerId: string;
  readonly offerGeneration: number;
  readonly createdAt: number;
  readonly ownerId: string;
  readonly logicalKey: string;
  readonly reason: string;
  readonly outcome: LeaseOutcome;
  readonly releasedLease?: BlockingLeaseSnapshotV1;
  readonly remainingBlocking: number;
  readonly state: "open" | "claimed" | "committed" | "aborted";
}

export interface WakeConsumerReceiptV1 {
  readonly version: 1;
  readonly consumerId: string;
  readonly consumerGeneration: number;
  readonly continuationId: string;
  readonly scheduling: "scheduled" | "coalesced";
}

export interface WakeSettlementV1 {
  readonly offer: WakeOfferSnapshotV1;
  readonly state: "committed" | "aborted";
  readonly delivery?: DeliveryOutcome;
  readonly message?: string;
  readonly consumerReceipt?: WakeConsumerReceiptV1;
}

export interface DisposableV1 {
  dispose(): void;
}

export interface BlockingLeaseHandleV1 {
  snapshot(): BlockingLeaseSnapshotV1;
  updateReason(reason?: string): Result<BlockingLeaseSnapshotV1>;
  checkIn(): Result<BlockingLeaseSnapshotV1>;
  releaseWithoutWake(input: {
    outcome: LeaseOutcome;
    reason?: string;
  }): Result<BlockingLeaseSnapshotV1>;
  releaseAndOfferWake(input: {
    outcome: LeaseOutcome;
    reason: string;
  }): Result<WakeProducerTransactionV1>;
}

export interface WakeProducerTransactionV1 {
  snapshot(): WakeOfferSnapshotV1;
  hasClaim(): boolean;
  commit(delivery: DeliveryOutcome): Result<WakeSettlementV1>;
  abort(message: string): Result<WakeSettlementV1>;
}

export interface WakeClaimHandleV1 {
  snapshot(): WakeOfferSnapshotV1;
  consumerIdentity(): Readonly<{
    consumerId: string;
    consumerGeneration: number;
  }>;
  onSettled(
    listener: (settlement: WakeSettlementV1) => void,
  ): Result<DisposableV1>;
  onSettledWithReceipt(
    listener: (
      settlement: WakeSettlementV1,
    ) => WakeConsumerReceiptV1 | undefined,
  ): Result<DisposableV1>;
}

export interface ContinuationRegistryV1 {
  readonly apiVersion: 1;

  acquireBlocking(input: {
    sessionId: string;
    ownerId: string;
    logicalKey: string;
    reason?: string;
  }): Result<BlockingLeaseHandleV1>;

  offerWake(input: {
    sessionId: string;
    ownerId: string;
    logicalKey: string;
    reason: string;
    outcome: LeaseOutcome;
  }): Result<WakeProducerTransactionV1>;

  snapshot(sessionId: string): RegistrySnapshotV1;

  subscribe(
    sessionId: string,
    listener: (snapshot: RegistrySnapshotV1) => void,
  ): Result<DisposableV1>;

  registerWakeConsumer(input: {
    sessionId: string;
    consumerId: string;
    onOffer: (
      offer: WakeOfferSnapshotV1,
      claim: () => Result<WakeClaimHandleV1>,
    ) => void;
  }): Result<DisposableV1>;
}

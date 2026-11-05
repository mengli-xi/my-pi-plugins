export const CONTINUATION_V1_API = 1 as const;
export const CONTINUATION_V1_SYMBOL = Symbol.for(
  "pi.runtime-contracts.continuation.v1",
);

export type { HandleError, Result } from "#internal/errors";
export type {
  BlockingLeaseHandleV1,
  BlockingLeaseSnapshotV1,
  ContinuationRegistryV1,
  DeliveryOutcome,
  DisposableV1,
  LeaseOutcome,
  RegistrySnapshotV1,
  WakeClaimHandleV1,
  WakeConsumerReceiptV1,
  WakeOfferSnapshotV1,
  WakeProducerTransactionV1,
  WakeSettlementV1,
} from "#internal/types";

import { invariant } from "#internal/errors";
import { createContinuationRegistryV1 } from "#internal/registry";
import type { ContinuationRegistryV1 } from "#internal/types";

interface RegistryHolderV1 {
  readonly apiVersion: 1;
  readonly registry: ContinuationRegistryV1;
}

function isCompatibleRegistry(value: unknown): value is ContinuationRegistryV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.apiVersion === 1 &&
    typeof candidate.acquireBlocking === "function" &&
    typeof candidate.offerWake === "function" &&
    typeof candidate.snapshot === "function" &&
    typeof candidate.subscribe === "function" &&
    typeof candidate.registerWakeConsumer === "function"
  );
}

function isCompatibleHolder(value: unknown): value is RegistryHolderV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.apiVersion === 1 && isCompatibleRegistry(candidate.registry);
}

export function getContinuationRegistryV1(): ContinuationRegistryV1 {
  const existing = Object.getOwnPropertyDescriptor(
    globalThis,
    CONTINUATION_V1_SYMBOL,
  );
  if (existing) {
    if (!isCompatibleHolder(existing.value)) {
      return invariant(
        "incompatible-registry",
        "global continuation-v1 holder has an incompatible shape",
      );
    }
    return existing.value.registry;
  }

  const holder: RegistryHolderV1 = Object.freeze({
    apiVersion: 1,
    registry: createContinuationRegistryV1(),
  });
  Object.defineProperty(globalThis, CONTINUATION_V1_SYMBOL, {
    value: holder,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return holder.registry;
}

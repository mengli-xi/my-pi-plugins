import { deepFreeze } from "#internal/immutable";
import { fail, invariant, ok, type Result } from "#internal/errors";
import type {
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
import {
  LIMITS,
  validateConsumerId,
  validateConsumerReceipt,
  validateLogicalKey,
  validateOwnerId,
  validateReason,
  validateSessionId,
  validateSettlementMessage,
} from "#internal/validation";

interface LeaseRecord {
  snapshot: BlockingLeaseSnapshotV1;
  settled: boolean;
}

interface ClaimRecord {
  consumerId: string;
  consumerGeneration: number;
  handle: WakeClaimHandle;
  listeners: Set<(settlement: WakeSettlementV1) => void>;
  receiptProvider?: (settlement: WakeSettlementV1) => WakeConsumerReceiptV1 | undefined;
}

interface OfferRecord {
  offerId: string;
  offerGeneration: number;
  ownerId: string;
  logicalKey: string;
  createdAt: number;
  reason: string;
  outcome: LeaseOutcome;
  releasedLease?: BlockingLeaseSnapshotV1;
  remainingBlocking: number;
  state: "open" | "claimed" | "committed" | "aborted";
  source: "blocking" | "detached";
  claim?: ClaimRecord;
  settlement?: WakeSettlementV1;
}

interface ConsumerRecord {
  id: string;
  generation: number;
  onOffer: (
    offer: WakeOfferSnapshotV1,
    claim: () => Result<WakeClaimHandleV1>,
  ) => void;
}

interface SessionState {
  leases: Map<string, LeaseRecord>;
  liveKeys: Map<string, string>;
  logicalGenerations: Map<string, number>;
  offers: Map<string, OfferRecord>;
  offerGeneration: number;
  detachedOffers: number;
  subscribers: Set<(snapshot: RegistrySnapshotV1) => void>;
  consumerGeneration: number;
  consumer?: ConsumerRecord;
  dispatching: boolean;
  dispatchPending: boolean;
}

export interface RegistryFactoryOptions {
  now?: () => number;
  id?: () => string;
  diagnostic?: (error: unknown) => void;
}

function newSessionState(): SessionState {
  return {
    leases: new Map(),
    liveKeys: new Map(),
    logicalGenerations: new Map(),
    offers: new Map(),
    offerGeneration: 0,
    detachedOffers: 0,
    subscribers: new Set(),
    consumerGeneration: 0,
    dispatching: false,
    dispatchPending: false,
  };
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const bits = (a << 16) | (b << 8) | c;
    output += alphabet[(bits >>> 18) & 63];
    output += alphabet[(bits >>> 12) & 63];
    if (index + 1 < bytes.length) output += alphabet[(bits >>> 6) & 63];
    if (index + 2 < bytes.length) output += alphabet[bits & 63];
  }
  return output;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function leaseKey(ownerId: string, logicalKey: string): string {
  return `${ownerId}\u0000${logicalKey}`;
}

function frozenLease(
  value: BlockingLeaseSnapshotV1,
): BlockingLeaseSnapshotV1 {
  return deepFreeze({ ...value });
}

function frozenOffer(
  sessionId: string,
  record: OfferRecord,
): WakeOfferSnapshotV1 {
  return deepFreeze({
    sessionId,
    offerId: record.offerId,
    offerGeneration: record.offerGeneration,
    createdAt: record.createdAt,
    ownerId: record.ownerId,
    logicalKey: record.logicalKey,
    reason: record.reason,
    outcome: record.outcome,
    ...(record.releasedLease
      ? { releasedLease: frozenLease(record.releasedLease) }
      : {}),
    remainingBlocking: record.remainingBlocking,
    state: record.state,
  });
}

function isLeaseOutcome(value: unknown): value is LeaseOutcome {
  return value === "ready" || value === "failed" || value === "cancelled";
}

function isDeliveryOutcome(value: unknown): value is DeliveryOutcome {
  return (
    value === "delivered" ||
    value === "skipped" ||
    value === "delivery-failed"
  );
}

class Registry implements ContinuationRegistryV1 {
  readonly apiVersion = 1 as const;
  private readonly sessions = new Map<string, SessionState>();
  private registryVersion = 0;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly diagnostic?: (error: unknown) => void;

  constructor(options: RegistryFactoryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomId;
    this.diagnostic = options.diagnostic;
  }

  acquireBlocking(input: {
    sessionId: string;
    ownerId: string;
    logicalKey: string;
    reason?: string;
  }): Result<BlockingLeaseHandleV1> {
    const validated = this.validateIdentity(input, false);
    if (!validated.ok) return validated;
    const state = this.session(validated.value.sessionId);
    if (state.leases.size >= LIMITS.blocking) {
      return fail("capacity", "blocking lease capacity reached");
    }

    const key = leaseKey(validated.value.ownerId, validated.value.logicalKey);
    if (state.liveKeys.has(key)) {
      return fail(
        "invalid-input",
        "a blocking lease already exists for ownerId and logicalKey",
      );
    }

    const generation = (state.logicalGenerations.get(key) ?? 0) + 1;
    state.logicalGenerations.set(key, generation);
    const acquiredAt = this.now();
    const record: LeaseRecord = {
      snapshot: frozenLease({
        sessionId: validated.value.sessionId,
        leaseId: this.uniqueId(state),
        generation,
        ownerId: validated.value.ownerId,
        logicalKey: validated.value.logicalKey,
        ...(validated.value.reason
          ? { reason: validated.value.reason }
          : {}),
        acquiredAt,
        lastCheckInAt: acquiredAt,
      }),
      settled: false,
    };
    state.leases.set(record.snapshot.leaseId, record);
    state.liveKeys.set(key, record.snapshot.leaseId);
    this.mutated(input.sessionId);
    return ok(new BlockingLeaseHandle(this, record));
  }

  offerWake(input: {
    sessionId: string;
    ownerId: string;
    logicalKey: string;
    reason: string;
    outcome: LeaseOutcome;
  }): Result<WakeProducerTransactionV1> {
    const validated = this.validateIdentity(input, true);
    if (!validated.ok) return validated;
    if (!isLeaseOutcome(input.outcome)) {
      return fail("invalid-input", "invalid wake outcome");
    }
    const state = this.session(validated.value.sessionId);
    if (state.detachedOffers >= LIMITS.detachedOffers) {
      return fail("capacity", "detached wake offer capacity reached");
    }
    state.detachedOffers++;
    const record = this.createOffer(
      state,
      validated.value.sessionId,
      validated.value.ownerId,
      validated.value.logicalKey,
      validated.value.reason ?? "",
      input.outcome,
      "detached",
    );
    this.mutated(validated.value.sessionId);
    this.deliverOffer(validated.value.sessionId, record);
    return ok(new WakeProducerTransaction(this, validated.value.sessionId, record));
  }

  snapshot(sessionId: string): RegistrySnapshotV1 {
    const validated = validateSessionId(sessionId);
    if (!validated.ok) {
      return deepFreeze({
        apiVersion: 1,
        sessionId,
        registryVersion: this.registryVersion,
        blocking: [],
        openOffers: 0,
      });
    }
    return this.snapshotFor(validated.value);
  }

  subscribe(
    sessionId: string,
    listener: (snapshot: RegistrySnapshotV1) => void,
  ): Result<DisposableV1> {
    const validSession = validateSessionId(sessionId);
    if (!validSession.ok) return validSession;
    if (typeof listener !== "function") {
      return fail("invalid-input", "listener must be a function");
    }
    const state = this.session(validSession.value);
    if (state.subscribers.size >= LIMITS.subscribers) {
      return fail("capacity", "subscriber capacity reached");
    }
    state.subscribers.add(listener);
    this.callSafely(() => listener(this.snapshotFor(validSession.value)));
    let disposed = false;
    return ok({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        state.subscribers.delete(listener);
      },
    });
  }

  registerWakeConsumer(input: {
    sessionId: string;
    consumerId: string;
    onOffer: (
      offer: WakeOfferSnapshotV1,
      claim: () => Result<WakeClaimHandleV1>,
    ) => void;
  }): Result<DisposableV1> {
    const validSession = validateSessionId(input.sessionId);
    if (!validSession.ok) return validSession;
    const validConsumer = validateConsumerId(input.consumerId);
    if (!validConsumer.ok) return validConsumer;
    if (typeof input.onOffer !== "function") {
      return fail("invalid-input", "onOffer must be a function");
    }

    const state = this.session(validSession.value);
    state.consumerGeneration++;
    const generation = state.consumerGeneration;
    this.retireClaims(state);
    state.consumer = {
      id: validConsumer.value,
      generation,
      onOffer: input.onOffer,
    };
    this.mutated(validSession.value);

    const replay = [...state.offers.values()]
      .filter((offer) => offer.state === "open")
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.offerGeneration - right.offerGeneration,
      );
    for (const offer of replay) {
      this.deliverOffer(validSession.value, offer);
    }

    let disposed = false;
    return ok({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (state.consumer?.generation !== generation) return;
        this.retireClaims(state);
        state.consumer = undefined;
        this.mutated(validSession.value);
      },
    });
  }

  getLease(record: LeaseRecord): Result<BlockingLeaseSnapshotV1> {
    if (record.settled) {
      return fail("already-settled", "blocking lease is already settled");
    }
    const state = this.sessions.get(record.snapshot.sessionId);
    if (state?.leases.get(record.snapshot.leaseId) !== record) {
      return fail("stale-handle", "blocking lease handle is stale");
    }
    return ok(record.snapshot);
  }

  updateLeaseReason(
    record: LeaseRecord,
    reason: string | undefined,
  ): Result<BlockingLeaseSnapshotV1> {
    const current = this.getLease(record);
    if (!current.ok) return current;
    const validReason = validateReason(reason, false);
    if (!validReason.ok) return validReason;
    record.snapshot = frozenLease({
      ...current.value,
      ...(validReason.value ? { reason: validReason.value } : { reason: undefined }),
    });
    this.mutated(record.snapshot.sessionId);
    return ok(record.snapshot);
  }

  checkInLease(record: LeaseRecord): Result<BlockingLeaseSnapshotV1> {
    const current = this.getLease(record);
    if (!current.ok) return current;
    record.snapshot = frozenLease({
      ...current.value,
      lastCheckInAt: this.now(),
    });
    this.mutated(record.snapshot.sessionId);
    return ok(record.snapshot);
  }

  releaseWithoutWake(
    record: LeaseRecord,
    input: { outcome: LeaseOutcome; reason?: string },
  ): Result<BlockingLeaseSnapshotV1> {
    const current = this.getLease(record);
    if (!current.ok) return current;
    if (!isLeaseOutcome(input.outcome)) {
      return fail("invalid-input", "invalid lease outcome");
    }
    const validReason = validateReason(input.reason, false);
    if (!validReason.ok) return validReason;
    const released = frozenLease({
      ...current.value,
      ...(validReason.value ? { reason: validReason.value } : {}),
    });
    this.removeLease(record);
    this.mutated(released.sessionId);
    return ok(released);
  }

  releaseAndOfferWake(
    record: LeaseRecord,
    input: { outcome: LeaseOutcome; reason: string },
  ): Result<WakeProducerTransactionV1> {
    const current = this.getLease(record);
    if (!current.ok) return current;
    if (!isLeaseOutcome(input.outcome)) {
      return fail("invalid-input", "invalid lease outcome");
    }
    const validReason = validateReason(input.reason, true);
    if (!validReason.ok) return validReason;
    const sessionId = current.value.sessionId;
    const state = this.session(sessionId);
    this.removeLease(record);
    const offer = this.createOffer(
      state,
      sessionId,
      current.value.ownerId,
      current.value.logicalKey,
      validReason.value ?? "",
      input.outcome,
      "blocking",
      current.value,
    );
    this.mutated(sessionId);
    this.deliverOffer(sessionId, offer);
    return ok(new WakeProducerTransaction(this, sessionId, offer));
  }

  offerSnapshot(sessionId: string, record: OfferRecord): WakeOfferSnapshotV1 {
    return frozenOffer(sessionId, record);
  }

  offerHasClaim(record: OfferRecord): boolean {
    return record.state === "claimed" && record.claim !== undefined;
  }

  settleOffer(
    sessionId: string,
    record: OfferRecord,
    operation:
      | { kind: "commit"; delivery: DeliveryOutcome }
      | { kind: "abort"; message: string },
  ): Result<WakeSettlementV1> {
    if (record.settlement) {
      return fail("already-settled", "wake offer is already settled");
    }
    const state = this.sessions.get(sessionId);
    if (state?.offers.get(record.offerId) !== record) {
      return fail("stale-handle", "wake transaction handle is stale");
    }
    if (operation.kind === "commit" && !isDeliveryOutcome(operation.delivery)) {
      return fail("invalid-input", "invalid delivery outcome");
    }
    let baseSettlement: WakeSettlementV1;
    if (operation.kind === "abort") {
      const message = validateSettlementMessage(operation.message);
      if (!message.ok) return message;
      record.state = "aborted";
      baseSettlement = deepFreeze({
        offer: frozenOffer(sessionId, record),
        state: "aborted" as const,
        message: message.value,
      });
    } else {
      record.state = "committed";
      baseSettlement = deepFreeze({
        offer: frozenOffer(sessionId, record),
        state: "committed" as const,
        delivery: operation.delivery,
      });
    }

    state.offers.delete(record.offerId);
    if (record.source === "detached") state.detachedOffers--;
    this.mutated(sessionId);

    let consumerReceipt: WakeConsumerReceiptV1 | undefined;
    const claim = record.claim;
    if (baseSettlement.state === "committed" && claim?.receiptProvider) {
      try {
        const candidate = claim.receiptProvider(baseSettlement);
        if (candidate !== undefined) {
          const validated = validateConsumerReceipt(
            candidate,
            claim.consumerId,
            claim.consumerGeneration,
          );
          if (validated.ok) consumerReceipt = validated.value;
          else this.reportDiagnostic(new Error(`[runtime-contracts/consumer-receipt] ${validated.message}`));
        }
      } catch (error) {
        this.reportDiagnostic(error);
      }
    }

    record.settlement = deepFreeze({
      ...baseSettlement,
      ...(consumerReceipt ? { consumerReceipt } : {}),
    });
    const listeners = claim ? [...claim.listeners] : [];
    for (const listener of listeners) {
      this.callSafely(() => listener(record.settlement as WakeSettlementV1));
    }
    claim?.listeners.clear();
    if (claim) claim.receiptProvider = undefined;
    return ok(record.settlement);
  }

  addSettlementListener(
    sessionId: string,
    record: OfferRecord,
    claimGeneration: number,
    listener: (settlement: WakeSettlementV1) => void,
  ): Result<DisposableV1> {
    const state = this.sessions.get(sessionId);
    if (
      !state?.consumer ||
      state.consumer.generation !== claimGeneration ||
      record.claim?.consumerGeneration !== claimGeneration
    ) {
      return fail("consumer-replaced", "wake consumer has been replaced");
    }
    if (record.settlement) {
      this.callSafely(() => listener(record.settlement as WakeSettlementV1));
      return ok({ dispose() {} });
    }
    if (typeof listener !== "function") {
      return fail("invalid-input", "settlement listener must be a function");
    }
    record.claim.listeners.add(listener);
    let disposed = false;
    return ok({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (record.claim?.consumerGeneration === claimGeneration) {
          record.claim.listeners.delete(listener);
        }
      },
    });
  }

  addSettlementReceiptProvider(
    sessionId: string,
    record: OfferRecord,
    claimGeneration: number,
    listener: (settlement: WakeSettlementV1) => WakeConsumerReceiptV1 | undefined,
  ): Result<DisposableV1> {
    const state = this.sessions.get(sessionId);
    if (
      !state?.consumer ||
      state.consumer.generation !== claimGeneration ||
      record.claim?.consumerGeneration !== claimGeneration
    ) {
      return fail("consumer-replaced", "wake consumer has been replaced");
    }
    if (record.settlement || state.offers.get(record.offerId) !== record) {
      return fail("already-settled", "wake offer is already settled");
    }
    if (typeof listener !== "function") {
      return fail("invalid-input", "settlement receipt provider must be a function");
    }
    if (record.claim.receiptProvider) {
      return fail("invalid-input", "a settlement receipt provider is already registered");
    }
    record.claim.receiptProvider = listener;
    let disposed = false;
    return ok({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (
          record.claim?.consumerGeneration === claimGeneration &&
          record.claim.receiptProvider === listener
        ) {
          record.claim.receiptProvider = undefined;
        }
      },
    });
  }

  claimOffer(
    sessionId: string,
    record: OfferRecord,
    consumerGeneration: number,
  ): Result<WakeClaimHandleV1> {
    const state = this.sessions.get(sessionId);
    if (state?.consumer?.generation !== consumerGeneration) {
      return fail("consumer-replaced", "wake consumer has been replaced");
    }
    if (record.settlement || state.offers.get(record.offerId) !== record) {
      return fail("already-settled", "wake offer is already settled");
    }
    if (record.claim) {
      if (record.claim.consumerGeneration === consumerGeneration) {
        return ok(record.claim.handle);
      }
      return fail("consumer-replaced", "wake offer belongs to another consumer");
    }
    if (record.state !== "open") {
      return fail("already-settled", "wake offer cannot be claimed");
    }
    const handle = new WakeClaimHandle(
      this,
      sessionId,
      record,
      state.consumer.id,
      consumerGeneration,
    );
    record.state = "claimed";
    record.claim = {
      consumerId: state.consumer.id,
      consumerGeneration,
      handle,
      listeners: new Set(),
    };
    this.mutated(sessionId);
    return ok(handle);
  }

  private validateIdentity(
    input: {
      sessionId: string;
      ownerId: string;
      logicalKey: string;
      reason?: string;
    },
    reasonRequired: boolean,
  ): Result<{
    sessionId: string;
    ownerId: string;
    logicalKey: string;
    reason?: string;
  }> {
    const sessionId = validateSessionId(input.sessionId);
    if (!sessionId.ok) return sessionId;
    const ownerId = validateOwnerId(input.ownerId);
    if (!ownerId.ok) return ownerId;
    const logicalKey = validateLogicalKey(input.logicalKey);
    if (!logicalKey.ok) return logicalKey;
    const reason = validateReason(input.reason, reasonRequired);
    if (!reason.ok) return reason;
    return ok({
      sessionId: sessionId.value,
      ownerId: ownerId.value,
      logicalKey: logicalKey.value,
      ...(reason.value ? { reason: reason.value } : {}),
    });
  }

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = newSessionState();
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private uniqueId(state: SessionState): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      const value = this.id();
      if (
        typeof value === "string" &&
        value.length > 0 &&
        !state.leases.has(value) &&
        !state.offers.has(value)
      ) {
        return value;
      }
    }
    return invariant("id-collision", "could not allocate a unique identifier");
  }

  private createOffer(
    state: SessionState,
    sessionId: string,
    ownerId: string,
    logicalKey: string,
    reason: string,
    outcome: LeaseOutcome,
    source: "blocking" | "detached",
    releasedLease?: BlockingLeaseSnapshotV1,
  ): OfferRecord {
    const record: OfferRecord = {
      offerId: this.uniqueId(state),
      offerGeneration: ++state.offerGeneration,
      ownerId,
      logicalKey,
      createdAt: this.now(),
      reason,
      outcome,
      ...(releasedLease ? { releasedLease } : {}),
      remainingBlocking: state.leases.size,
      state: "open",
      source,
    };
    state.offers.set(record.offerId, record);
    return record;
  }

  private removeLease(record: LeaseRecord): void {
    const state = this.sessions.get(record.snapshot.sessionId);
    if (state?.leases.get(record.snapshot.leaseId) !== record) {
      invariant("lease-state", "live lease is missing from its session");
    }
    state.leases.delete(record.snapshot.leaseId);
    state.liveKeys.delete(
      leaseKey(record.snapshot.ownerId, record.snapshot.logicalKey),
    );
    record.settled = true;
  }

  private deliverOffer(sessionId: string, record: OfferRecord): void {
    const state = this.sessions.get(sessionId);
    const consumer = state?.consumer;
    if (!consumer || record.state !== "open") return;
    const generation = consumer.generation;
    const claim = () => this.claimOffer(sessionId, record, generation);
    this.callSafely(() => consumer.onOffer(frozenOffer(sessionId, record), claim));
  }

  private retireClaims(state: SessionState): void {
    for (const offer of state.offers.values()) {
      if (!offer.claim) continue;
      offer.claim.listeners.clear();
      offer.claim = undefined;
      if (!offer.settlement) offer.state = "open";
    }
  }

  private snapshotFor(sessionId: string): RegistrySnapshotV1 {
    const state = this.sessions.get(sessionId);
    const blocking = state
      ? [...state.leases.values()]
          .map((record) => frozenLease(record.snapshot))
          .sort(
            (left, right) =>
              left.acquiredAt - right.acquiredAt ||
              left.leaseId.localeCompare(right.leaseId),
          )
      : [];
    return deepFreeze({
      apiVersion: 1 as const,
      sessionId,
      registryVersion: this.registryVersion,
      blocking,
      openOffers: state?.offers.size ?? 0,
      ...(state?.consumer
        ? { consumerGeneration: state.consumer.generation }
        : {}),
    });
  }

  private mutated(sessionId: string): void {
    this.registryVersion++;
    this.dispatch(sessionId);
  }

  private dispatch(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.subscribers.size === 0) return;
    if (state.dispatching) {
      state.dispatchPending = true;
      return;
    }
    state.dispatching = true;
    try {
      do {
        state.dispatchPending = false;
        const snapshot = this.snapshotFor(sessionId);
        const listeners = [...state.subscribers];
        for (const listener of listeners) {
          this.callSafely(() => listener(snapshot));
        }
      } while (state.dispatchPending);
    } finally {
      state.dispatching = false;
    }
  }

  private reportDiagnostic(error: unknown): void {
    try {
      this.diagnostic?.(error);
    } catch {
      // Diagnostics must not break registry semantics.
    }
  }

  private callSafely(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.reportDiagnostic(error);
    }
  }
}

class BlockingLeaseHandle implements BlockingLeaseHandleV1 {
  private readonly registry: Registry;
  private readonly record: LeaseRecord;

  constructor(registry: Registry, record: LeaseRecord) {
    this.registry = registry;
    this.record = record;
  }

  snapshot(): BlockingLeaseSnapshotV1 {
    return this.record.snapshot;
  }

  updateReason(reason?: string): Result<BlockingLeaseSnapshotV1> {
    return this.registry.updateLeaseReason(this.record, reason);
  }

  checkIn(): Result<BlockingLeaseSnapshotV1> {
    return this.registry.checkInLease(this.record);
  }

  releaseWithoutWake(input: {
    outcome: LeaseOutcome;
    reason?: string;
  }): Result<BlockingLeaseSnapshotV1> {
    return this.registry.releaseWithoutWake(this.record, input);
  }

  releaseAndOfferWake(input: {
    outcome: LeaseOutcome;
    reason: string;
  }): Result<WakeProducerTransactionV1> {
    return this.registry.releaseAndOfferWake(this.record, input);
  }
}

class WakeProducerTransaction implements WakeProducerTransactionV1 {
  private readonly registry: Registry;
  private readonly sessionId: string;
  private readonly record: OfferRecord;

  constructor(registry: Registry, sessionId: string, record: OfferRecord) {
    this.registry = registry;
    this.sessionId = sessionId;
    this.record = record;
  }

  snapshot(): WakeOfferSnapshotV1 {
    return this.registry.offerSnapshot(this.sessionId, this.record);
  }

  hasClaim(): boolean {
    return this.registry.offerHasClaim(this.record);
  }

  commit(delivery: DeliveryOutcome): Result<WakeSettlementV1> {
    return this.registry.settleOffer(this.sessionId, this.record, {
      kind: "commit",
      delivery,
    });
  }

  abort(message: string): Result<WakeSettlementV1> {
    return this.registry.settleOffer(this.sessionId, this.record, {
      kind: "abort",
      message,
    });
  }
}

class WakeClaimHandle implements WakeClaimHandleV1 {
  private readonly registry: Registry;
  private readonly sessionId: string;
  private readonly record: OfferRecord;
  private readonly consumerId: string;
  private readonly consumerGeneration: number;

  constructor(
    registry: Registry,
    sessionId: string,
    record: OfferRecord,
    consumerId: string,
    consumerGeneration: number,
  ) {
    this.registry = registry;
    this.sessionId = sessionId;
    this.record = record;
    this.consumerId = consumerId;
    this.consumerGeneration = consumerGeneration;
  }

  snapshot(): WakeOfferSnapshotV1 {
    return this.registry.offerSnapshot(this.sessionId, this.record);
  }

  consumerIdentity(): Readonly<{ consumerId: string; consumerGeneration: number }> {
    return Object.freeze({
      consumerId: this.consumerId,
      consumerGeneration: this.consumerGeneration,
    });
  }

  onSettled(
    listener: (settlement: WakeSettlementV1) => void,
  ): Result<DisposableV1> {
    return this.registry.addSettlementListener(
      this.sessionId,
      this.record,
      this.consumerGeneration,
      listener,
    );
  }

  onSettledWithReceipt(
    listener: (
      settlement: WakeSettlementV1,
    ) => WakeConsumerReceiptV1 | undefined,
  ): Result<DisposableV1> {
    return this.registry.addSettlementReceiptProvider(
      this.sessionId,
      this.record,
      this.consumerGeneration,
      listener,
    );
  }
}

export function createContinuationRegistryV1(
  options: RegistryFactoryOptions = {},
): ContinuationRegistryV1 {
  return new Registry(options);
}

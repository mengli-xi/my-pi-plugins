import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalNotificationStateJsonV1,
  createNotificationBrokerV1 as createRawNotificationBrokerV1,
  createProcessTuiEntryEnvelopeV1,
  measureNotificationBrokerStateV1,
  measureNotificationControlPlaneStateV1,
  restoreNotificationBrokerV1 as restoreRawNotificationBrokerV1,
  type NotificationBrokerV1,
  type NotificationBrokerOptionsV1,
} from "../../src/notifications/broker.ts";
import {
  NOTIFICATION_BROKER_LIMITS_V1,
  NotificationBrokerErrorV1,
  type NotificationFactV1,
  type NotificationTargetV1,
  type ProcessNotificationBatchItemV1,
} from "../../src/notifications/types.ts";

const sessionScopeId = "notification-test-session";
const target: NotificationTargetV1 = { strategy: "main", scopeToken: "main" };

function tuiEntryFor(fact: NotificationFactV1) {
  if (fact.kind === "watch-suppressed" || (fact.kind === "terminal" && fact.terminal?.cause === "stopped")) return undefined;
  return createProcessTuiEntryEnvelopeV1({
    version: 2,
    kind: fact.kind === "matcher-error" ? "matcher-error" : fact.kind,
    process: fact.process ?? { id: "host", name: "host", kind: "process" },
    text: `Notification ${fact.factId}`,
    eventSequence: fact.source.supervisor?.eventSequence ?? fact.source.notificationSequence,
  });
}

function withTuiAdapter(broker: NotificationBrokerV1): NotificationBrokerV1 {
  return new Proxy(broker, {
    get(targetBroker, property) {
      if (property === "observe") return (input: Parameters<NotificationBrokerV1["observe"]>[0]) => targetBroker.observe({ ...input, ...(tuiEntryFor(input.fact) ? { tuiEntry: tuiEntryFor(input.fact) } : {}) });
      const value = Reflect.get(targetBroker, property);
      return typeof value === "function" ? value.bind(targetBroker) : value;
    },
  });
}

function createNotificationBrokerV1(options: NotificationBrokerOptionsV1): NotificationBrokerV1 {
  return withTuiAdapter(createRawNotificationBrokerV1(options));
}

function restoreNotificationBrokerV1(state: Parameters<typeof restoreRawNotificationBrokerV1>[0], options: NotificationBrokerOptionsV1): NotificationBrokerV1 {
  return withTuiAdapter(restoreRawNotificationBrokerV1(state, options));
}

function watchFact(sequence: number, options: Partial<NotificationFactV1> = {}): NotificationFactV1 {
  return {
    version: 1,
    factId: `${sessionScopeId}:host-a:${sequence}`,
    sessionScopeId,
    source: { hostIncarnationId: "host-a", notificationSequence: sequence },
    observedAt: new Date(1_750_000_000_000 + sequence).toISOString(),
    process: { id: "proc_000000000001", name: "build", kind: "process" },
    kind: "watch-match",
    attention: "context",
    watch: { key: "progress", generation: 1, repeat: true, firstSequence: sequence, lastSequence: sequence, count: 1 },
    ...options,
  };
}

function terminalFact(sequence: number, processId = "proc_000000000001"): NotificationFactV1 {
  return {
    version: 1,
    factId: `${sessionScopeId}:host-a:${sequence}`,
    sessionScopeId,
    source: { hostIncarnationId: "host-a", notificationSequence: sequence },
    observedAt: new Date(1_750_000_000_000 + sequence).toISOString(),
    process: { id: processId, name: processId.slice(-4), kind: "process" },
    kind: "terminal",
    attention: "turn",
    terminal: { outcome: "succeeded", cause: "completed", durationMs: 1200 },
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof NotificationBrokerErrorV1 ? error.code : undefined;
}

function minimalItem(sequence: number): ProcessNotificationBatchItemV1 {
  return {
    kind: "watch-match", processId: "proc_000000000001", processName: "build", watchKey: "ready", watchGeneration: 1,
    count: 1, matchedCount: 1, suppressedCount: 0,
    firstFactId: `${sessionScopeId}:host-a:${sequence}`, lastFactId: `${sessionScopeId}:host-a:${sequence}`,
    hostIncarnationId: "host-a", firstNotificationSequence: sequence, lastNotificationSequence: sequence,
    firstObservedAt: new Date(1_750_000_000_000 + sequence).toISOString(), lastObservedAt: new Date(1_750_000_000_000 + sequence).toISOString(),
  };
}

class Rng {
  #state: number;
  constructor(seed: number) { this.#state = seed >>> 0; }
  next(): number { let x = this.#state; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.#state = x >>> 0; return this.#state; }
  int(max: number): number { return this.next() % max; }
}

test("repeat watch aggregates exact reported and suppressed counts by lane", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target, fact: watchFact(1) });
  broker.observe({ target, fact: watchFact(2, { kind: "watch-suppressed", watch: { key: "progress", generation: 1, repeat: true, firstSequence: 2, lastSequence: 81, count: 80 } }) });
  broker.observe({ target, fact: watchFact(3, { attention: "turn" }) });

  const context = broker.prepare({ target, lane: "context", batchId: "context-1", epochId: "epoch-1", reason: "user-boundary", createdAt: new Date().toISOString() });
  const turn = broker.prepare({ target, lane: "turn", batchId: "turn-1", epochId: "epoch-1", reason: "main-admission", createdAt: new Date().toISOString() });
  assert.equal(context?.batch.items.length, 1);
  assert.deepEqual(context?.batch.items[0] && { count: context.batch.items[0].count, matched: context.batch.items[0].matchedCount, suppressed: context.batch.items[0].suppressedCount }, { count: 81, matched: 1, suppressed: 80 });
  assert.equal(turn?.batch.items[0]?.count, 1);
  assert.equal(broker.notificationSnapshot().watches[0]?.matchedCount, 2);
  assert.equal(broker.notificationSnapshot().watches[0]?.suppressedCount, 80);
});

test("Phase C discard removes legacy-owned open turn facts but preserves TUI and lease control state", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  const observed = broker.observe({ target, fact: watchFact(1, { attention: "turn" }), leaseWakeTransactionId: "lease-discard" });
  broker.discardOpenTurnWindow(target);
  assert.equal(broker.prepare({ target, lane: "turn", batchId: "turn-empty", epochId: "epoch", reason: "main-admission", createdAt: new Date().toISOString() }), undefined);
  assert.equal(broker.pendingTuiDeliveries(target)[0]?.deliveryId, observed.tuiDeliveryId);
  assert.deepEqual(broker.exportState().leaseWakeBindings.map((binding) => binding.transactionId), ["lease-discard"]);
  assert.equal(broker.notificationSnapshot().watches[0]?.matchedCount, 1);
});

test("Phase C discard refuses prepared or standalone-owned turn state atomically", () => {
  const preparedBroker = createNotificationBrokerV1({ sessionScopeId });
  preparedBroker.observe({ target, fact: watchFact(1, { attention: "turn" }) });
  preparedBroker.prepare({ target, lane: "turn", batchId: "turn-prepared", epochId: "epoch", reason: "main-admission", createdAt: new Date().toISOString() });
  const beforePrepared = canonicalNotificationStateJsonV1(preparedBroker.exportState());
  assert.throws(() => preparedBroker.discardOpenTurnWindow(target), (error) => errorCode(error) === "prepare-in-progress");
  assert.equal(canonicalNotificationStateJsonV1(preparedBroker.exportState()), beforePrepared);

  const standaloneBroker = createNotificationBrokerV1({ sessionScopeId });
  standaloneBroker.observe({ target, fact: watchFact(1, { attention: "turn" }) });
  standaloneBroker.prepare({ target, lane: "turn", batchId: "standalone-batch", epochId: "epoch", reason: "main-admission", createdAt: new Date().toISOString() });
  standaloneBroker.bindStandaloneWake("standalone-batch", { transactionId: "standalone-discard", claimed: false });
  standaloneBroker.rollback("standalone-batch", "retry");
  const beforeStandalone = canonicalNotificationStateJsonV1(standaloneBroker.exportState());
  assert.throws(() => standaloneBroker.discardOpenTurnWindow(target), (error) => errorCode(error) === "prepare-in-progress");
  assert.equal(canonicalNotificationStateJsonV1(standaloneBroker.exportState()), beforeStandalone);
});

test("observe rejects replay and gap atomically", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target, fact: watchFact(1) });
  const before = canonicalNotificationStateJsonV1(broker.exportState());
  assert.throws(() => broker.observe({ target, fact: watchFact(1) }), (error) => errorCode(error) === "sequence-replay");
  assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), before);
  assert.throws(() => broker.observe({ target, fact: watchFact(3) }), (error) => errorCode(error) === "sequence-gap");
  const afterGap = broker.exportState();
  assert.equal(afterGap.degraded, true);
  assert.equal(afterGap.sourceFences[0]?.highestObservedNotificationSequence, 1);
});

test("minimal continuation bypasses model partition and survives restore", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId, limits: { modelTargetPartitions: 1 } });
  broker.observe({ target, fact: watchFact(1) });
  const overflowTarget: NotificationTargetV1 = { strategy: "child", scopeToken: "task-2" };
  broker.observe({ target: overflowTarget, fact: watchFact(2, { attention: "ignore", factId: `${sessionScopeId}:host-a:2`, process: { id: "proc_000000000002", name: "child", kind: "process" } }), leaseWakeTransactionId: "lease-2" });
  const prepared = broker.prepareMinimalContinuation({ target: overflowTarget, batchId: "minimal-1", epochId: "epoch-2", reason: "subagent-admission", createdAt: new Date().toISOString(), leaseWakeTransactionIds: ["lease-2"] });
  assert.equal(prepared.batch.mode, "minimal-continuation");
  assert.deepEqual(prepared.leaseWakeTransactionIds, ["lease-2"]);

  const restored = restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId, limits: { modelTargetPartitions: 1 } });
  assert.deepEqual(restored.getPrepared("minimal-1"), prepared);
  restored.commit("minimal-1");
  assert.throws(() => restored.commit("minimal-1"), (error) => errorCode(error) === "batch-already-settled");
  restored.ackLeaseWakeTransaction("lease-2");
});

test("failed prepare and ack restore the exact canonical state", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId, limits: { serializedBytes: 3000 } });
  broker.observe({ target, fact: watchFact(1) });
  const beforePrepare = canonicalNotificationStateJsonV1(broker.exportState());
  assert.throws(() => broker.prepare({ target, lane: "context", batchId: "x".repeat(4000), epochId: "e", reason: "user-boundary", createdAt: new Date().toISOString() }), (error) => errorCode(error) === "invalid-fact");
  assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), beforePrepare);
  const beforeAck = canonicalNotificationStateJsonV1(broker.exportState());
  assert.throws(() => broker.ackLeaseWakeTransaction("missing"), (error) => errorCode(error) === "invalid-fact");
  assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), beforeAck);
});

test("restore rejects unknown nested fields and invalid prepared references", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target, fact: watchFact(1) });
  broker.prepare({ target, lane: "context", batchId: "batch-1", epochId: "epoch-1", reason: "user-boundary", createdAt: new Date().toISOString() });
  const unknown = structuredClone(broker.exportState()) as any;
  unknown.prepared[0].batch.items[0].unknown = true;
  assert.throws(() => restoreNotificationBrokerV1(unknown, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");
  const missing = structuredClone(broker.exportState()) as any;
  missing.prepared[0].itemKeys = ["missing"];
  assert.throws(() => restoreNotificationBrokerV1(missing, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");
});

test("target overflow retries repeat-watch TUI delivery until acknowledgement", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId, limits: { modelTargetPartitions: 1 } });
  broker.observe({ target, fact: watchFact(1) });
  const overflowTarget: NotificationTargetV1 = { strategy: "child", scopeToken: "overflow" };
  const first = broker.observe({ target: overflowTarget, fact: watchFact(2, { factId: `${sessionScopeId}:host-a:2`, process: { id: "proc_000000000002", name: "overflow", kind: "monitor" } }) });
  const second = broker.observe({ target: overflowTarget, fact: watchFact(3, { factId: `${sessionScopeId}:host-a:3`, process: { id: "proc_000000000002", name: "overflow", kind: "monitor" } }) });
  assert.equal(first.modelDisposition, "target-overflowed");
  assert.equal(first.tuiDisposition, "append");
  assert.equal(second.modelDisposition, "target-overflowed");
  assert.equal(second.tuiDisposition, "append");
  assert.equal(first.tuiDeliveryId, second.tuiDeliveryId);
  broker.ackTuiDelivery(first.tuiDeliveryId!);
  const third = broker.observe({ target: overflowTarget, fact: watchFact(4, { factId: `${sessionScopeId}:host-a:4`, process: { id: "proc_000000000002", name: "overflow", kind: "monitor" } }) });
  assert.equal(third.tuiDisposition, "aggregate-only");
});

test("runtime input validation rejects unknown, accessor, and inconsistent branch fields atomically", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  const before = canonicalNotificationStateJsonV1(broker.exportState());
  assert.throws(
    () => broker.observe({ target, fact: { ...watchFact(1), unknown: true } as any }),
    (error) => errorCode(error) === "invalid-fact",
  );
  const accessor = watchFact(1) as any;
  Object.defineProperty(accessor, "attention", { enumerable: true, get: () => "context" });
  assert.throws(() => broker.observe({ target, fact: accessor }), (error) => errorCode(error) === "invalid-fact");
  assert.throws(
    () => broker.observe({ target, fact: { ...watchFact(1), kind: "terminal", terminal: undefined } as any }),
    (error) => errorCode(error) === "invalid-fact",
  );
  assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), before);
});

test("TUI delivery requires an immutable entry and rejects a valid envelope bound to another fact", () => {
  const raw = createRawNotificationBrokerV1({ sessionScopeId });
  const fact = watchFact(1);
  assert.throws(() => raw.observe({ target, fact }), (error) => errorCode(error) === "invalid-fact");
  assert.equal(raw.exportState().sourceFences.length, 0);

  const mismatched = createProcessTuiEntryEnvelopeV1({
    version: 2,
    kind: "watch-match",
    process: { id: "proc_000000000999", name: "other", kind: "process" },
    text: "wrong process",
    eventSequence: 1,
  });
  assert.throws(() => raw.observe({ target, fact, tuiEntry: mismatched }), (error) => errorCode(error) === "invalid-fact");
  assert.equal(raw.exportState().sourceFences.length, 0);
});

test("suppressed and intentional stopped facts reject TUI entries", () => {
  const suppressed = watchFact(1, { kind: "watch-suppressed" });
  const rawSuppressed = createRawNotificationBrokerV1({ sessionScopeId });
  assert.throws(
    () => rawSuppressed.observe({ target, fact: suppressed, tuiEntry: createProcessTuiEntryEnvelopeV1({ version: 2, kind: "watch-suppressed", process: suppressed.process!, text: "suppressed", eventSequence: 1 }) }),
    (error) => errorCode(error) === "invalid-fact",
  );

  const stopped: NotificationFactV1 = {
    ...terminalFact(1),
    terminal: { outcome: "stopped", cause: "stopped", durationMs: 1 },
  };
  const rawStopped = createRawNotificationBrokerV1({ sessionScopeId });
  assert.throws(
    () => rawStopped.observe({ target, fact: stopped, tuiEntry: createProcessTuiEntryEnvelopeV1({ version: 2, kind: "terminal", process: stopped.process!, text: "stopped", eventSequence: 1 }) }),
    (error) => errorCode(error) === "invalid-fact",
  );
  assert.equal(rawStopped.observe({ target, fact: stopped }).tuiDisposition, "aggregate-only");
});

test("TUI delivery acknowledgement survives restore and prevents duplicate append", () => {
  let broker = createNotificationBrokerV1({ sessionScopeId });
  const first = broker.observe({ target, fact: watchFact(1) });
  assert.equal(first.tuiDisposition, "append");
  assert.ok(first.tuiDeliveryId);
  assert.equal(broker.pendingTuiDeliveries().length, 1);
  broker = restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId });
  assert.equal(broker.pendingTuiDeliveries()[0]?.deliveryId, first.tuiDeliveryId);
  broker.ackTuiDelivery(first.tuiDeliveryId!);
  broker = restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId });
  assert.equal(broker.pendingTuiDeliveries().length, 0);
  const second = broker.observe({ target, fact: watchFact(2) });
  assert.equal(second.tuiDisposition, "aggregate-only");
  assert.equal(second.tuiDeliveryId, first.tuiDeliveryId);
  assert.throws(() => broker.ackTuiDelivery(first.tuiDeliveryId!), (error) => errorCode(error) === "invalid-fact");
});

test("standalone wake cannot settle before batch commit and settles exactly once after commit", () => {
  let broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target, fact: watchFact(1, { attention: "turn" }) });
  broker.prepare({ target, lane: "turn", batchId: "standalone-batch", epochId: "epoch", reason: "main-admission", createdAt: new Date().toISOString() });
  broker.bindStandaloneWake("standalone-batch", { transactionId: "standalone-1", claimed: true });
  const before = canonicalNotificationStateJsonV1(broker.exportState());
  assert.throws(() => broker.settleStandaloneWake("standalone-1", "delivered"), (error) => errorCode(error) === "invalid-fact");
  assert.throws(() => broker.abortStandaloneWake("standalone-1", "too early"), (error) => errorCode(error) === "invalid-fact");
  assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), before);
  broker.commit("standalone-batch");
  broker = restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId });
  assert.equal(broker.exportState().standaloneWakeBindings[0]?.phase, "batch-committed");
  broker.settleStandaloneWake("standalone-1", "delivered");
  assert.throws(() => broker.settleStandaloneWake("standalone-1", "delivered"), (error) => errorCode(error) === "invalid-fact");
  assert.equal(broker.exportState().settledStandaloneWakes[0]?.outcome, "delivered");
});

test("rollback preserves standalone wake ownership for successor rebinding", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target, fact: watchFact(1, { attention: "turn" }) });
  broker.prepare({ target, lane: "turn", batchId: "standalone-first", epochId: "epoch", reason: "main-admission", createdAt: new Date().toISOString() });
  broker.bindStandaloneWake("standalone-first", { transactionId: "standalone-rollback", claimed: false });
  broker.rollback("standalone-first", "retry");
  const binding = broker.exportState().standaloneWakeBindings[0];
  assert.equal(binding?.phase, "unbound");
  assert.equal(binding?.batchId, undefined);
  assert.throws(() => broker.abortStandaloneWake("standalone-rollback", "too early"), (error) => errorCode(error) === "invalid-fact");
  broker.prepare({ target, lane: "turn", batchId: "standalone-second", epochId: "epoch-2", reason: "main-admission", createdAt: new Date().toISOString() });
  assert.equal(broker.exportState().standaloneWakeBindings[0]?.phase, "batch-prepared");
  assert.equal(broker.exportState().standaloneWakeBindings[0]?.batchId, "standalone-second");
  broker.bindStandaloneWake("standalone-second", { transactionId: "standalone-rollback", claimed: false });
  broker.commit("standalone-second");
  broker.abortStandaloneWake("standalone-rollback", "owner ended");
  assert.equal(broker.exportState().settledStandaloneWakes[0]?.outcome, "aborted");
});

test("recorded TUI identities are never forgotten at the ledger limit", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  for (let sequence = 1; sequence <= 512; sequence++) {
    const processId = `proc_${String(sequence).padStart(12, "0")}`;
    const result = broker.observe({ target, fact: watchFact(sequence, { process: { id: processId, name: `p${sequence}`, kind: "process" }, watch: { key: `w${sequence}`, generation: 1, repeat: true, firstSequence: sequence, lastSequence: sequence, count: 1 } }) });
    assert.equal(result.tuiDisposition, "append");
    broker.ackTuiDelivery(result.tuiDeliveryId!);
  }
  const overflow = broker.observe({ target, fact: watchFact(513, { process: { id: "proc_000000000513", name: "p513", kind: "process" }, watch: { key: "w513", generation: 1, repeat: true, firstSequence: 513, lastSequence: 513, count: 1 } }) });
  assert.equal(overflow.tuiDisposition, "none");
  const repeated = broker.observe({ target, fact: watchFact(514, { process: { id: "proc_000000000001", name: "p1", kind: "process" }, watch: { key: "w1", generation: 1, repeat: true, firstSequence: 514, lastSequence: 514, count: 1 } }) });
  assert.equal(repeated.tuiDisposition, "aggregate-only");
  assert.equal(broker.healthSnapshot().tuiDeliveryRecords, 512);
  assert.equal(broker.healthSnapshot().counters.tuiDeliveriesDropped, 1);
  const restored = restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId });
  assert.equal(restored.pendingTuiDeliveries().length, 0);
});

test("TUI byte capacity rejects a new identity atomically without forgetting tombstones", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId, limits: { tuiDeliveryBytes: 700 } });
  const before = canonicalNotificationStateJsonV1(broker.exportState());
  const result = broker.observe({ target, fact: watchFact(1, { process: { id: "proc_000000000001", name: "x".repeat(256), kind: "process" } }) });
  assert.equal(result.tuiDisposition, "none");
  assert.equal(broker.pendingTuiDeliveries().length, 0);
  assert.notEqual(canonicalNotificationStateJsonV1(broker.exportState()), before);
  assert.ok(broker.healthSnapshot().tuiDeliverySerializedBytes <= 700);
});

test("restore rejects forged TUI identity and delivery digest", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target, fact: watchFact(1) });
  const forged = structuredClone(broker.exportState()) as any;
  forged.tuiDeliveries[0].identity.watchKey = "forged";
  assert.throws(() => restoreNotificationBrokerV1(forged, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");

  const forgedPair = structuredClone(broker.exportState()) as any;
  forgedPair.tuiDeliveries[0].identity.watchKey = "forged";
  forgedPair.tuiDeliveries[0].deliveryId = "tui:" + "0".repeat(64);
  assert.throws(() => restoreNotificationBrokerV1(forgedPair, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");

  const replacedEntry = structuredClone(broker.exportState()) as any;
  replacedEntry.tuiDeliveries[0].entry = createProcessTuiEntryEnvelopeV1({
    version: 2,
    kind: "watch-match",
    process: { id: "proc_000000000999", name: "forged", kind: "process" },
    text: "forged entry",
    eventSequence: 1,
  });
  assert.throws(() => restoreNotificationBrokerV1(replacedEntry, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");
});

test("maximum legal TUI identity produces a fixed delivery ID that can be acknowledged", () => {
  const maximumTarget: NotificationTargetV1 = { strategy: "child", scopeToken: "s".repeat(512) };
  const fact = watchFact(1, {
    factId: `${sessionScopeId}:${"h".repeat(256)}:1`,
    source: { hostIncarnationId: "h".repeat(256), notificationSequence: 1 },
    process: { id: "p".repeat(256), name: "n".repeat(256), kind: "process" },
    watch: { key: "w".repeat(128), generation: 1, repeat: true, firstSequence: 1, lastSequence: 1, count: 1 },
  });
  const broker = createNotificationBrokerV1({ sessionScopeId });
  const observed = broker.observe({ target: maximumTarget, fact });
  assert.match(observed.tuiDeliveryId!, /^tui:[0-9a-f]{64}$/u);
  assert.equal(Buffer.byteLength(observed.tuiDeliveryId!, "utf8"), 68);
  broker.ackTuiDelivery(observed.tuiDeliveryId!);
  assert.equal(broker.pendingTuiDeliveries().length, 0);
});

test("minimal continuation preserves every lease in canonical source order and survives restore", () => {
  const child: NotificationTargetV1 = { strategy: "child", scopeToken: "minimal-multi" };
  const broker = createNotificationBrokerV1({ sessionScopeId });
  const first = broker.observe({ target: child, fact: watchFact(1, { attention: "context", process: { id: "proc_000000000911", name: "first", kind: "monitor" } }), leaseWakeTransactionId: "lease-b" });
  const second = broker.observe({ target: child, fact: watchFact(2, { attention: "context", process: { id: "proc_000000000912", name: "second", kind: "monitor" } }), leaseWakeTransactionId: "lease-a" });
  broker.ackTuiDelivery(first.tuiDeliveryId!);
  broker.ackTuiDelivery(second.tuiDeliveryId!);
  const prepared = broker.prepareMinimalContinuation({
    target: child, batchId: "minimal-multi", epochId: "epoch", reason: "subagent-admission", createdAt: new Date().toISOString(),
    leaseWakeTransactionIds: ["lease-a", "lease-b"],
  });
  assert.deepEqual(prepared.leaseWakeTransactionIds, ["lease-b", "lease-a"]);
  assert.deepEqual(prepared.batch.items.map((item) => item.processName), ["first", "second"]);
  const restored = restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId });
  assert.deepEqual(restored.getPrepared("minimal-multi"), prepared);
});

test("lease bindings freeze independent durable receipts and allow one minimal batch to span source lanes", () => {
  const child: NotificationTargetV1 = { strategy: "child", scopeToken: "artifact-binding" };
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target: child, fact: watchFact(1, { attention: "context", process: { id: "proc_000000000921", name: "first", kind: "monitor" } }), leaseWakeTransactionId: "lease-artifact-a" });
  broker.observe({ target: child, fact: watchFact(2, { attention: "context", process: { id: "proc_000000000922", name: "second", kind: "monitor" } }), leaseWakeTransactionId: "lease-artifact-b" });
  const firstArtifact = broker.exportState().leaseWakeBindings[0]?.artifact;
  assert.match(firstArtifact?.deliveryId ?? "", /^receipt:[0-9a-f]{64}$/);
  assert.equal(firstArtifact?.state, "pending");
  assert.equal(firstArtifact?.entry?.customType, "process-notification-receipt-v1");

  const forged = structuredClone(broker.exportState()) as any;
  forged.leaseWakeBindings[0].artifact.deliveryId = `receipt:${"0".repeat(64)}`;
  assert.throws(() => restoreNotificationBrokerV1(forged, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");

  broker.prepareMinimalContinuation({ target: child, batchId: "minimal-artifact", epochId: "epoch", reason: "subagent-admission", createdAt: new Date().toISOString(), leaseWakeTransactionIds: ["lease-artifact-a", "lease-artifact-b"] });
  const mixed = structuredClone(broker.exportState()) as any;
  mixed.leaseWakeBindings[1].lane = "turn";
  assert.deepEqual(restoreNotificationBrokerV1(mixed, { sessionScopeId }).getPrepared("minimal-artifact")?.leaseWakeTransactionIds, ["lease-artifact-a", "lease-artifact-b"]);
});

test("repeat watch re-arm receives a fresh blocking receipt instead of reusing the TUI tombstone", () => {
  const child: NotificationTargetV1 = { strategy: "child", scopeToken: "repeat-rearm" };
  const broker = createNotificationBrokerV1({ sessionScopeId });
  const first = broker.observe({ target: child, fact: watchFact(1), leaseWakeTransactionId: "lease-repeat-first" });
  broker.ackTuiDelivery(first.tuiDeliveryId!);
  const firstArtifact = broker.pendingLeaseArtifacts()[0]!;
  broker.ackLeaseArtifact("lease-repeat-first");
  broker.ackLeaseWakeTransaction("lease-repeat-first");

  const second = broker.observe({ target: child, fact: watchFact(2), leaseWakeTransactionId: "lease-repeat-second" });
  assert.equal(second.tuiDisposition, "aggregate-only");
  const secondArtifact = broker.pendingLeaseArtifacts()[0]!;
  assert.notEqual(secondArtifact.artifact.deliveryId, firstArtifact.artifact.deliveryId);
  assert.equal(secondArtifact.artifact.state, "pending");
  assert.equal(JSON.parse(secondArtifact.artifact.entry!.dataJson).factId, `${sessionScopeId}:host-a:2`);
});

test("blocking receipts remain available when the TUI delivery ledger is full", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId, limits: { tuiDeliveryRecords: 1, tuiDeliveryBytes: 64 * 1024 } });
  broker.observe({ target, fact: watchFact(1) });
  const second = broker.observe({ target, fact: watchFact(2, { process: { id: "proc_000000000002", name: "second", kind: "process" } }), leaseWakeTransactionId: "lease-ledger-full" });
  assert.equal(second.tuiDisposition, "none");
  const artifact = broker.pendingLeaseArtifacts()[0]!;
  assert.equal(artifact.transactionId, "lease-ledger-full");
  broker.ackLeaseArtifact("lease-ledger-full");
  assert.equal(broker.exportState().leaseWakeBindings[0]?.artifact.state, "recorded");
});

test("minimal continuation identity is frozen by the lease binding", () => {
  const child: NotificationTargetV1 = { strategy: "child", scopeToken: "minimal-frozen" };
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target: child, fact: watchFact(1, { attention: "ignore", process: { id: "proc_000000000901", name: "authoritative", kind: "monitor" }, watch: { key: "ready", generation: 7, repeat: false, firstSequence: 1, lastSequence: 1, count: 1 } }), leaseWakeTransactionId: "lease-frozen" });
  const prepared = broker.prepareMinimalContinuation({ target: child, batchId: "minimal-frozen", epochId: "epoch", reason: "subagent-admission", createdAt: new Date().toISOString(), leaseWakeTransactionIds: ["lease-frozen"] });
  assert.deepEqual(prepared.batch.items[0] && { processId: prepared.batch.items[0].processId, processName: prepared.batch.items[0].processName, watchKey: prepared.batch.items[0].watchKey, watchGeneration: prepared.batch.items[0].watchGeneration }, { processId: "proc_000000000901", processName: "authoritative", watchKey: "ready", watchGeneration: 7 });
});

test("prepared lease acknowledgement is rejected atomically", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target, fact: watchFact(1), leaseWakeTransactionId: "lease-prepared" });
  broker.prepare({ target, lane: "context", batchId: "prepared-lease", epochId: "epoch", reason: "user-boundary", createdAt: new Date().toISOString() });
  const before = canonicalNotificationStateJsonV1(broker.exportState());
  assert.throws(() => broker.ackLeaseWakeTransaction("lease-prepared"), (error) => errorCode(error) === "invalid-fact");
  assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), before);
  assert.doesNotThrow(() => restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId }));
});

test("minimal continuation does not occupy a model target partition", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId, limits: { modelTargetPartitions: 1 } });
  const child: NotificationTargetV1 = { strategy: "child", scopeToken: "minimal" };
  broker.observe({ target: child, fact: watchFact(1, { attention: "ignore" }), leaseWakeTransactionId: "lease-minimal" });
  broker.prepareMinimalContinuation({ target: child, batchId: "minimal", epochId: "epoch", reason: "subagent-admission", createdAt: new Date().toISOString(), leaseWakeTransactionIds: ["lease-minimal"] });
  assert.equal(broker.healthSnapshot().modelTargetPartitions, 0);
  const observed = broker.observe({ target, fact: watchFact(2, { process: { id: "proc_000000000002", name: "main", kind: "process" } }) });
  assert.equal(observed.modelDisposition, "aggregated");
  assert.equal(broker.healthSnapshot().modelTargetPartitions, 1);
});

test("restore rejects source fence and immutable prepared batch corruption", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target, fact: watchFact(1) });
  broker.prepare({ target, lane: "context", batchId: "restore-integrity", epochId: "epoch", reason: "user-boundary", createdAt: new Date().toISOString() });

  const fence = structuredClone(broker.exportState()) as any;
  fence.sourceFences[0].highestObservedNotificationSequence = 0;
  fence.sourceFences[0].highestCommittedNotificationSequence = 0;
  assert.throws(() => restoreNotificationBrokerV1(fence, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");

  const batch = structuredClone(broker.exportState()) as any;
  batch.prepared[0].batch.items[0].count = 999;
  assert.throws(() => restoreNotificationBrokerV1(batch, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");
});

test("terminal-only slot pressure folds terminal facts into overflow", () => {
  const broker = createNotificationBrokerV1({
    sessionScopeId,
    limits: { generalSlots: 1, terminalSlots: 2, targetOverflowSlots: 1, totalSlots: 4 },
  });
  for (let sequence = 1; sequence <= 5; sequence++) {
    broker.observe({ target, fact: terminalFact(sequence, `proc_${String(sequence).padStart(12, "0")}`) });
  }
  const health = broker.healthSnapshot();
  assert.ok(health.slots.terminal <= 2);
  assert.equal(health.slots.overflow, 1);
  const prepared = broker.prepare({ target, lane: "turn", batchId: "terminal-pressure", epochId: "epoch", reason: "main-admission", createdAt: new Date().toISOString() });
  assert.ok(prepared?.batch.overflow);
  assert.equal(prepared?.batch.overflow?.omittedItems, prepared?.batch.overflow && Object.values(prepared.batch.overflow.byKind).reduce((sum, count) => sum + count, 0));
});

test("terminal-only byte pressure chooses a terminal candidate", () => {
  const broker = createNotificationBrokerV1({
    sessionScopeId,
    limits: { generalSlots: 1, terminalSlots: 20, targetOverflowSlots: 1, totalSlots: 22, serializedBytes: 2400 },
  });
  for (let sequence = 1; sequence <= 5; sequence++) {
    broker.observe({ target, fact: { ...terminalFact(sequence, `proc_${String(sequence).padStart(12, "0")}`), process: { id: `proc_${String(sequence).padStart(12, "0")}`, name: `terminal-${sequence}-${"x".repeat(160)}`, kind: "process" } } });
  }
  const health = broker.healthSnapshot();
  assert.equal(health.slots.overflow, 1);
  assert.ok(health.slots.terminal < 5);
  assert.ok(health.serializedBytes <= 2400);
});

function overflowFixture(): ReturnType<typeof createNotificationBrokerV1> {
  const broker = createNotificationBrokerV1({
    sessionScopeId,
    limits: { generalSlots: 1, terminalSlots: 1, targetOverflowSlots: 1, totalSlots: 3 },
  });
  broker.observe({ target, fact: watchFact(1, { watch: { key: "a", generation: 1, repeat: false, firstSequence: 1, lastSequence: 1, count: 1 } }) });
  broker.observe({ target, fact: watchFact(2, { watch: { key: "b", generation: 1, repeat: false, firstSequence: 2, lastSequence: 2, count: 2 } }) });
  broker.prepare({ target, lane: "context", batchId: "overflow-prepared", epochId: "epoch", reason: "user-boundary", createdAt: new Date().toISOString() });
  broker.observe({ target, fact: watchFact(3, { watch: { key: "c", generation: 1, repeat: false, firstSequence: 3, lastSequence: 3, count: 3 } }) });
  broker.observe({ target, fact: watchFact(4, { watch: { key: "d", generation: 1, repeat: false, firstSequence: 4, lastSequence: 4, count: 4 } }) });
  return broker;
}

test("prepared and successor overflow stay separate across commit and rollback", () => {
  const committed = overflowFixture();
  const beforeCommit = committed.exportState().overflows[0];
  assert.equal(beforeCommit?.prepared.length, 1);
  assert.equal(beforeCommit?.open.length, 1);
  const openCount = beforeCommit?.open[0]?.omittedItems;
  committed.commit("overflow-prepared");
  assert.equal(committed.exportState().overflows[0]?.prepared.length, 0);
  assert.equal(committed.exportState().overflows[0]?.open[0]?.omittedItems, openCount);

  const rolledBack = overflowFixture();
  const beforeRollback = rolledBack.exportState().overflows[0];
  const expected = (beforeRollback?.prepared[0]?.omittedItems ?? 0) + (beforeRollback?.open[0]?.omittedItems ?? 0);
  rolledBack.rollback("overflow-prepared", "test rollback");
  const overflow = rolledBack.exportState().overflows[0];
  assert.equal(overflow?.prepared.length, 0);
  assert.equal(overflow?.open.length, 1);
  assert.equal(overflow?.open[0]?.omittedItems, expected);
  assert.doesNotThrow(() => restoreNotificationBrokerV1(structuredClone(rolledBack.exportState()), { sessionScopeId, limits: { generalSlots: 1, terminalSlots: 1, targetOverflowSlots: 1, totalSlots: 3 } }));
});

test("overflow keeps exact lease membership across interleaved lanes", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId, limits: { generalSlots: 2, terminalSlots: 1, targetOverflowSlots: 1, totalSlots: 4 } });
  broker.observe({ target, fact: watchFact(1, { attention: "turn", watch: { key: "a", generation: 1, repeat: true, firstSequence: 1, lastSequence: 1, count: 1 } }) });
  broker.observe({ target, fact: watchFact(2, { attention: "context", process: { id: "proc_000000000002", name: "context", kind: "process" }, watch: { key: "b", generation: 1, repeat: true, firstSequence: 2, lastSequence: 2, count: 1 } }), leaseWakeTransactionId: "context-lease" });
  broker.observe({ target, fact: watchFact(3, { attention: "turn", watch: { key: "a", generation: 1, repeat: true, firstSequence: 3, lastSequence: 3, count: 1 } }) });
  broker.observe({ target, fact: watchFact(4, { attention: "turn", process: { id: "proc_000000000003", name: "turn-c", kind: "process" }, watch: { key: "c", generation: 1, repeat: false, firstSequence: 4, lastSequence: 4, count: 1 } }) });
  const prepared = broker.prepare({ target, lane: "turn", batchId: "turn-overflow", epochId: "epoch", reason: "main-admission", createdAt: new Date().toISOString() });
  assert.deepEqual(prepared?.leaseWakeTransactionIds, []);
  assert.deepEqual(broker.prepare({ target, lane: "context", batchId: "context-overflow", epochId: "epoch", reason: "user-boundary", createdAt: new Date().toISOString() })?.leaseWakeTransactionIds, ["context-lease"]);
});

test("settled batch ledger retains the newest 256 outcomes", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  for (let sequence = 1; sequence <= 257; sequence++) {
    broker.observe({ target, fact: watchFact(sequence, { watch: { key: `w${sequence}`, generation: 1, repeat: false, firstSequence: sequence, lastSequence: sequence, count: 1 } }) });
    broker.prepare({ target, lane: "context", batchId: `batch-${sequence}`, epochId: `epoch-${sequence}`, reason: "user-boundary", createdAt: new Date().toISOString() });
    broker.commit(`batch-${sequence}`);
  }
  const state = broker.exportState();
  assert.equal(state.settledBatches.length, 256);
  assert.equal(state.settledBatches[0]?.batchId, "batch-2");
  assert.equal(state.settledBatches.at(-1)?.batchId, "batch-257");
  assert.throws(() => broker.commit("batch-2"), (error) => errorCode(error) === "batch-already-settled");
  assert.throws(() => broker.commit("batch-1"), (error) => errorCode(error) === "batch-not-found");
});

test("the thirty-third owner can prepare a minimal continuation without a model partition", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  let sequence = 0;
  for (let index = 0; index < 32; index++) {
    sequence++;
    broker.observe({ target: { strategy: "child", scopeToken: `task-${index}` }, fact: watchFact(sequence, { process: { id: `proc_${String(index).padStart(12, "0")}`, name: `p${index}`, kind: "process" } }) });
  }
  assert.equal(broker.healthSnapshot().modelTargetPartitions, 32);
  const overflowTarget: NotificationTargetV1 = { strategy: "child", scopeToken: "task-32" };
  sequence++;
  broker.observe({ target: overflowTarget, fact: watchFact(sequence, { attention: "ignore", process: { id: "proc_000000000032", name: "p32", kind: "process" } }), leaseWakeTransactionId: "lease-33" });
  const prepared = broker.prepareMinimalContinuation({ target: overflowTarget, batchId: "minimal-33", epochId: "epoch-33", reason: "subagent-admission", createdAt: new Date().toISOString(), leaseWakeTransactionIds: ["lease-33"] });
  assert.equal(prepared.batch.mode, "minimal-continuation");
  assert.equal(broker.healthSnapshot().modelTargetPartitions, 32);
});

test("cross-incarnation ordering uses real time then incarnation identity", () => {
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target, fact: watchFact(1, { factId: `${sessionScopeId}:host-z:1`, source: { hostIncarnationId: "host-z", notificationSequence: 1 }, observedAt: "2026-09-04T01:00:00+01:00", process: { id: "proc_000000000009", name: "z", kind: "process" }, watch: { key: "z", generation: 1, repeat: false, firstSequence: 1, lastSequence: 1, count: 1 } }) });
  broker.observe({ target, fact: watchFact(1, { factId: `${sessionScopeId}:host-a:1`, source: { hostIncarnationId: "host-a", notificationSequence: 1 }, observedAt: "2026-09-04T00:00:00Z", process: { id: "proc_000000000008", name: "a", kind: "process" }, watch: { key: "a", generation: 1, repeat: false, firstSequence: 1, lastSequence: 1, count: 1 } }) });
  const prepared = broker.prepare({ target, lane: "context", batchId: "ordered", epochId: "epoch", reason: "user-boundary", createdAt: new Date().toISOString() });
  assert.deepEqual(prepared?.batch.items.map((entry) => entry.hostIncarnationId), ["host-a", "host-z"]);
});

test("control-plane capacity is independent and every successful mutation round-trips", () => {
  let broker = createNotificationBrokerV1({ sessionScopeId, limits: { serializedBytes: 1800, controlPlaneBindings: 3, controlPlaneBytes: 10_000 } });
  const assertRoundTrip = (): void => {
    const state = broker.exportState();
    assert.ok(measureNotificationBrokerStateV1(state) <= 1800);
    assert.ok(measureNotificationControlPlaneStateV1(state) > 0);
    for (const binding of state.leaseWakeBindings) {
      assert.equal(binding.lane, "ignore");
      assert.match(binding.artifact.deliveryId, /^receipt:[0-9a-f]{64}$/);
      assert.equal(binding.artifact.state, "pending");
    }
    broker = restoreNotificationBrokerV1(structuredClone(state), { sessionScopeId, limits: { serializedBytes: 1800, controlPlaneBindings: 3, controlPlaneBytes: 10_000 } });
    assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), canonicalNotificationStateJsonV1(state));
  };
  for (let sequence = 1; sequence <= 3; sequence++) {
    broker.observe({ target: { strategy: "child", scopeToken: `lease-${sequence}` }, fact: watchFact(sequence, { attention: "ignore", process: { id: `proc_${String(sequence).padStart(12, "0")}`, name: `p${sequence}`, kind: "process" } }), leaseWakeTransactionId: `lease-${sequence}` });
    assertRoundTrip();
  }
  const before = canonicalNotificationStateJsonV1(broker.exportState());
  assert.throws(() => broker.observe({ target: { strategy: "child", scopeToken: "lease-4" }, fact: watchFact(4, { attention: "ignore", process: { id: "proc_000000000004", name: "p4", kind: "process" } }), leaseWakeTransactionId: "lease-4" }), (error) => errorCode(error) === "capacity");
  assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), before);
  broker.ackLeaseWakeTransaction("lease-1");
  assertRoundTrip();
  broker.observe({ target: { strategy: "child", scopeToken: "lease-4" }, fact: watchFact(4, { attention: "ignore", process: { id: "proc_000000000004", name: "p4", kind: "process" } }), leaseWakeTransactionId: "lease-4" });
  assertRoundTrip();
});

test("target retirement fails closed while a batch is prepared", () => {
  const child: NotificationTargetV1 = { strategy: "child", scopeToken: "task-retire" };
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target: child, fact: watchFact(1, { process: { id: "proc_000000000777", name: "retire", kind: "service" } }), leaseWakeTransactionId: "lease-retire" });
  broker.prepare({ target: child, lane: "context", batchId: "retire-prepared", epochId: "epoch", reason: "user-boundary", createdAt: new Date().toISOString() });
  const before = canonicalNotificationStateJsonV1(broker.exportState());
  assert.throws(() => broker.beginRetireTarget("retirement-prepared", child), (error) => errorCode(error) === "prepare-in-progress");
  assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), before);
});

test("retirement returns unresolved transaction plans and disposal rejects future mutation", () => {
  const child: NotificationTargetV1 = { strategy: "child", scopeToken: "task-retire" };
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target: child, fact: watchFact(1, { attention: "ignore", process: { id: "proc_000000000777", name: "retire", kind: "service" } }), leaseWakeTransactionId: "lease-retire" });
  const turnFact = watchFact(2, { attention: "turn", process: { id: "proc_000000000777", name: "retire", kind: "service" } });
  broker.observe({ target: child, fact: turnFact });
  broker.prepare({ target: child, lane: "turn", batchId: "retire-turn", epochId: "epoch", reason: "subagent-admission", createdAt: new Date().toISOString() });
  broker.bindStandaloneWake("retire-turn", { transactionId: "standalone-retire", claimed: false });
  broker.rollback("retire-turn", "retire target");
  broker.clearProcess("proc_000000000777");
  assert.equal(broker.notificationSnapshot().watches.length, 0);
  assert.equal(broker.pendingTuiDeliveries(child).length, 0);
  const plan = broker.beginRetireTarget("retirement-target", child);
  assert.deepEqual(plan, { retirementId: "retirement-target", kind: "target", target: child, processIds: ["proc_000000000777"], leaseWakeTransactionIds: ["lease-retire"], standaloneWakeTransactionIds: ["standalone-retire"], state: "pending" });
  let restored = restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId });
  assert.deepEqual(restored.pendingRetirements(), [plan]);
  assert.throws(() => restored.observe({ target: child, fact: watchFact(3) }), (error) => errorCode(error) === "invalid-fact");
  restored.ackRetirement("retirement-target");
  const scopePlan = restored.beginDisposeScope("retirement-scope");
  assert.deepEqual(scopePlan, { retirementId: "retirement-scope", kind: "scope", processIds: [], leaseWakeTransactionIds: [], standaloneWakeTransactionIds: [], state: "pending" });
  restored = restoreNotificationBrokerV1(structuredClone(restored.exportState()), { sessionScopeId });
  assert.deepEqual(restored.pendingRetirements(), [scopePlan]);
  restored.ackRetirement("retirement-scope");
  assert.throws(() => restored.observe({ target, fact: watchFact(3) }), (error) => errorCode(error) === "invalid-fact");
});

test("pending retirement freezes ownership mutation atomically", () => {
  const child: NotificationTargetV1 = { strategy: "child", scopeToken: "frozen-retirement" };
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target: child, fact: watchFact(1, { attention: "ignore", process: { id: "proc_000000000888", name: "frozen", kind: "service" } }), leaseWakeTransactionId: "lease-frozen-retirement" });
  broker.observe({ target: child, fact: watchFact(2, { attention: "turn", process: { id: "proc_000000000888", name: "frozen", kind: "service" } }) });
  broker.prepare({ target: child, lane: "turn", batchId: "frozen-turn", epochId: "epoch", reason: "subagent-admission", createdAt: new Date().toISOString() });
  broker.bindStandaloneWake("frozen-turn", { transactionId: "standalone-frozen-retirement", claimed: false });
  broker.rollback("frozen-turn", "freeze owner");
  broker.beginRetireTarget("retirement-frozen", child);
  const before = canonicalNotificationStateJsonV1(broker.exportState());
  for (const operation of [
    () => broker.ackLeaseWakeTransaction("lease-frozen-retirement"),
    () => broker.settleStandaloneWake("standalone-frozen-retirement", "delivered"),
    () => broker.abortStandaloneWake("standalone-frozen-retirement", "late abort"),
    () => broker.clearProcess("proc_000000000888"),
  ]) {
    assert.throws(operation, (error) => errorCode(error) === "invalid-fact");
    assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), before);
  }
});

test("target retirement owns watch-suppressed and terminal-only process state", () => {
  const retiring: NotificationTargetV1 = { strategy: "child", scopeToken: "owner-retire" };
  const peer: NotificationTargetV1 = { strategy: "child", scopeToken: "owner-peer" };
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({
    target: retiring,
    fact: watchFact(1, {
      kind: "watch-suppressed",
      attention: "ignore",
      process: { id: "proc_000000000901", name: "suppressed", kind: "monitor" },
      watch: { key: "tick", generation: 1, repeat: true, firstSequence: 1, lastSequence: 10, count: 10 },
    }),
  });
  broker.observe({ target: retiring, fact: terminalFact(2, "proc_000000000902") });
  broker.observe({ target: peer, fact: watchFact(3, { process: { id: "proc_000000000903", name: "peer", kind: "process" } }) });

  const plan = broker.beginRetireTarget("retirement-owner", retiring);
  assert.deepEqual(plan.processIds, ["proc_000000000901", "proc_000000000902"]);
  const before = canonicalNotificationStateJsonV1(broker.exportState());
  assert.throws(() => broker.clearProcess("proc_000000000901"), (error) => errorCode(error) === "invalid-fact");
  assert.throws(() => broker.clearProcess("proc_000000000902"), (error) => errorCode(error) === "invalid-fact");
  assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), before);

  broker.ackRetirement("retirement-owner");
  const state = broker.exportState();
  assert.deepEqual(state.processOwners.map((entry) => entry.processId), ["proc_000000000903"]);
  assert.deepEqual(state.watches.map((entry) => entry.processId), ["proc_000000000903"]);
  assert.equal(state.terminalProcesses.some((entry) => entry.processId === "proc_000000000902"), false);
});

test("restore rejects missing or mismatched process ownership", () => {
  const child: NotificationTargetV1 = { strategy: "child", scopeToken: "owner-integrity" };
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target: child, fact: watchFact(1, { attention: "ignore", process: { id: "proc_000000000904", name: "owned", kind: "process" } }) });
  broker.beginRetireTarget("retirement-owner-integrity", child);

  const missingOwner = structuredClone(broker.exportState()) as any;
  missingOwner.processOwners = [];
  assert.throws(() => restoreNotificationBrokerV1(missingOwner, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");

  const missingPlanProcess = structuredClone(broker.exportState()) as any;
  missingPlanProcess.pendingRetirements[0].processIds = [];
  assert.throws(() => restoreNotificationBrokerV1(missingPlanProcess, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");

  const wrongOwner = structuredClone(broker.exportState()) as any;
  wrongOwner.processOwners[0].target = { strategy: "child", scopeToken: "other" };
  assert.throws(() => restoreNotificationBrokerV1(wrongOwner, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");
});

test("restore requires retirement plans to exactly cover live bindings", () => {
  const child: NotificationTargetV1 = { strategy: "child", scopeToken: "retirement-integrity" };
  const broker = createNotificationBrokerV1({ sessionScopeId });
  broker.observe({ target: child, fact: watchFact(1, { attention: "ignore" }), leaseWakeTransactionId: "lease-integrity" });
  broker.observe({ target: child, fact: watchFact(2, { attention: "turn" }) });
  broker.prepare({ target: child, lane: "turn", batchId: "integrity-turn", epochId: "epoch", reason: "subagent-admission", createdAt: new Date().toISOString() });
  broker.bindStandaloneWake("integrity-turn", { transactionId: "standalone-integrity", claimed: true });
  broker.rollback("integrity-turn", "retire integrity");
  broker.beginRetireTarget("retirement-integrity", child);

  const missing = structuredClone(broker.exportState()) as any;
  missing.pendingRetirements[0].leaseWakeTransactionIds = [];
  assert.throws(() => restoreNotificationBrokerV1(missing, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");

  const extra = structuredClone(broker.exportState()) as any;
  extra.pendingRetirements[0].standaloneWakeTransactionIds.push("missing-standalone");
  assert.throws(() => restoreNotificationBrokerV1(extra, { sessionScopeId }), (error) => errorCode(error) === "state-corrupt");
});

test("deterministic ownership traces preserve TUI, wake, minimal, and retirement invariants", () => {
  for (let seed = 101; seed <= 120; seed++) {
    const random = new Rng(seed);
    let broker = createNotificationBrokerV1({ sessionScopeId });
    let sequence = 0;
    for (let round = 0; round < 20; round++) {
      const child: NotificationTargetV1 = { strategy: "child", scopeToken: `task-${seed}-${round}` };
      const processId = `proc_${String(seed * 100 + round).padStart(12, "0")}`;
      sequence++;
      const observed = broker.observe({
        target: child,
        fact: watchFact(sequence, { attention: "ignore", process: { id: processId, name: `p${round}`, kind: "process" }, watch: { key: "ready", generation: 1, repeat: false, firstSequence: sequence, lastSequence: sequence, count: 1 } }),
        leaseWakeTransactionId: `lease-${seed}-${round}`,
      });
      if (observed.tuiDeliveryId && random.int(2) === 0) broker.ackTuiDelivery(observed.tuiDeliveryId);
      const minimalId = `minimal-${seed}-${round}`;
      broker.prepareMinimalContinuation({ target: child, batchId: minimalId, epochId: `epoch-${round}`, reason: "subagent-admission", createdAt: new Date(1_750_001_000_000 + sequence).toISOString(), leaseWakeTransactionIds: [`lease-${seed}-${round}`] });
      broker.commit(minimalId);
      broker.ackLeaseWakeTransaction(`lease-${seed}-${round}`);

      sequence++;
      broker.observe({ target: child, fact: watchFact(sequence, { attention: "turn", process: { id: processId, name: `p${round}`, kind: "process" }, watch: { key: "tick", generation: 1, repeat: true, firstSequence: sequence, lastSequence: sequence, count: 1 } }) });
      const turnId = `turn-${seed}-${round}`;
      broker.prepare({ target: child, lane: "turn", batchId: turnId, epochId: `turn-epoch-${round}`, reason: "subagent-admission", createdAt: new Date(1_750_001_000_000 + sequence).toISOString() });
      broker.bindStandaloneWake(turnId, { transactionId: `standalone-${seed}-${round}`, claimed: random.int(2) === 0 });
      if (random.int(2) === 0) {
        broker.commit(turnId);
        broker.settleStandaloneWake(`standalone-${seed}-${round}`, "delivered");
      } else {
        broker.rollback(turnId, "generated retry");
        const retryId = `${turnId}-retry`;
        broker.prepare({ target: child, lane: "turn", batchId: retryId, epochId: `retry-${round}`, reason: "subagent-admission", createdAt: new Date(1_750_001_100_000 + sequence).toISOString() });
        assert.equal(broker.exportState().standaloneWakeBindings.find((entry) => entry.transactionId === `standalone-${seed}-${round}`)?.batchId, retryId);
        broker.commit(retryId);
        broker.abortStandaloneWake(`standalone-${seed}-${round}`, "generated abort");
      }

      const retirement = broker.beginRetireTarget(`retire-${seed}-${round}`, child);
      broker = restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId });
      assert.deepEqual(broker.pendingRetirements(), [retirement]);
      broker.ackRetirement(retirement.retirementId);
      broker = restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId });
      assert.equal(broker.pendingRetirements().length, 0);
    }
  }
});

test("deterministic generated operation traces preserve invariants across restore", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const random = new Rng(seed);
    let broker = createNotificationBrokerV1({ sessionScopeId });
    let sequence = 0;
    let batch = 0;
    const prepared: string[] = [];
    for (let step = 0; step < 250; step++) {
      const operation = random.int(10);
      if (operation < 6) {
        const nextSequence = sequence + 1;
        const processIndex = random.int(8);
        const lane = random.int(2) === 0 ? "context" : "turn";
        const fact = random.int(7) === 0
          ? terminalFact(nextSequence, `proc_${String(processIndex).padStart(12, "0")}`)
          : watchFact(nextSequence, { attention: lane, process: { id: `proc_${String(processIndex).padStart(12, "0")}`, name: `p${processIndex}`, kind: "process" }, watch: { key: `w${random.int(4)}`, generation: 1 + random.int(3), repeat: true, firstSequence: nextSequence, lastSequence: nextSequence, count: 1 + random.int(5) } });
        try {
          broker.observe({ target, fact });
          sequence = nextSequence;
        } catch (error) {
          assert.equal(errorCode(error), "terminal-conflict");
        }
      } else if (operation < 8) {
        const lane = random.int(2) === 0 ? "context" : "turn";
        const id = `batch-${seed}-${++batch}`;
        const before = canonicalNotificationStateJsonV1(broker.exportState());
        try {
          const value = broker.prepare({ target, lane, batchId: id, epochId: `epoch-${step}`, reason: lane === "context" ? "user-boundary" : "main-admission", createdAt: new Date(1_750_000_100_000 + step).toISOString() });
          if (value) prepared.push(id);
        } catch (error) {
          assert.equal(errorCode(error), "prepare-in-progress");
          assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), before);
        }
      } else if (prepared.length > 0) {
        const index = random.int(prepared.length);
        const id = prepared.splice(index, 1)[0]!;
        if (operation === 8) broker.commit(id); else broker.rollback(id, "generated rollback");
      }
      if (step % 17 === 0) broker = restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId });
      const health = broker.healthSnapshot();
      assert.ok(health.slots.total <= NOTIFICATION_BROKER_LIMITS_V1.totalSlots);
      assert.ok(health.serializedBytes <= NOTIFICATION_BROKER_LIMITS_V1.serializedBytes);
      assert.equal(canonicalNotificationStateJsonV1(broker.exportState()), canonicalNotificationStateJsonV1(restoreNotificationBrokerV1(structuredClone(broker.exportState()), { sessionScopeId }).exportState()));
    }
  }
});

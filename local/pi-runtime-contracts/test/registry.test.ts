import assert from "node:assert/strict";
import test from "node:test";
import { createContinuationRegistryV1 } from "../src/internal/registry.ts";

function registryFixture() {
  let now = 100;
  let id = 0;
  return {
    registry: createContinuationRegistryV1({
      now: () => now,
      id: () => `id-${++id}`,
    }),
    tick(value = 1) {
      now += value;
    },
  };
}

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected success");
  return result.value;
}

test("blocking leases are immutable, ordered, unique and generation-safe", () => {
  const fixture = registryFixture();
  const first = value(
    fixture.registry.acquireBlocking({
      sessionId: "session-a",
      ownerId: "processes",
      logicalKey: "proc-1",
      reason: "wait for api",
    }),
  );
  fixture.tick();
  const second = value(
    fixture.registry.acquireBlocking({
      sessionId: "session-a",
      ownerId: "processes",
      logicalKey: "proc-2",
    }),
  );

  assert.equal(Object.isFrozen(first.snapshot()), true);
  assert.deepEqual(
    fixture.registry.snapshot("session-a").blocking.map((item) => item.leaseId),
    ["id-1", "id-2"],
  );
  const duplicate = fixture.registry.acquireBlocking({
    sessionId: "session-a",
    ownerId: "processes",
    logicalKey: "proc-1",
  });
  assert.deepEqual(duplicate.ok ? undefined : duplicate.error, "invalid-input");

  fixture.tick(10);
  assert.equal(value(first.checkIn()).lastCheckInAt, 111);
  assert.equal(value(first.updateReason("ready later")).reason, "ready later");
  assert.equal(
    value(first.releaseWithoutWake({ outcome: "cancelled" })).leaseId,
    "id-1",
  );
  const settledCheckIn = first.checkIn();
  assert.equal(settledCheckIn.ok, false);
  if (!settledCheckIn.ok) {
    assert.equal(settledCheckIn.error, "already-settled");
  }

  const replacement = value(
    fixture.registry.acquireBlocking({
      sessionId: "session-a",
      ownerId: "processes",
      logicalKey: "proc-1",
    }),
  );
  assert.equal(replacement.snapshot().generation, 2);
  value(second.releaseWithoutWake({ outcome: "ready" }));
  value(replacement.releaseWithoutWake({ outcome: "ready" }));
});

test("releaseAndOfferWake is atomic and remainingBlocking includes other leases", () => {
  const fixture = registryFixture();
  const first = value(
    fixture.registry.acquireBlocking({
      sessionId: "s",
      ownerId: "processes",
      logicalKey: "first",
    }),
  );
  const second = value(
    fixture.registry.acquireBlocking({
      sessionId: "s",
      ownerId: "processes",
      logicalKey: "second",
    }),
  );
  const versions: number[] = [];
  value(
    fixture.registry.subscribe("s", (snapshot) => {
      versions.push(snapshot.registryVersion);
    }),
  );

  const transaction = value(
    first.releaseAndOfferWake({ outcome: "ready", reason: "first ready" }),
  );
  assert.equal(transaction.snapshot().remainingBlocking, 1);
  const snapshot = fixture.registry.snapshot("s");
  assert.equal(snapshot.blocking.length, 1);
  assert.equal(snapshot.openOffers, 1);
  assert.equal(transaction.hasClaim(), false);
  assert.equal(value(transaction.commit("delivered")).state, "committed");
  assert.equal(fixture.registry.snapshot("s").openOffers, 0);
  assert.ok(versions.every((version, index) => index === 0 || version > versions[index - 1]));
  value(second.releaseWithoutWake({ outcome: "cancelled" }));
});

test("consumer claims, receives committed settlement, and suppresses stale generation", () => {
  const fixture = registryFixture();
  let settlementState: string | undefined;
  let staleClaim: (() => unknown) | undefined;
  const consumer = value(
    fixture.registry.registerWakeConsumer({
      sessionId: "s",
      consumerId: "goal",
      onOffer(offer, claim) {
        assert.equal(offer.state, "open");
        staleClaim = claim;
        const handle = value(claim());
        assert.equal(handle.snapshot().state, "claimed");
        value(
          handle.onSettled((settlement) => {
            settlementState = settlement.state;
          }),
        );
      },
    }),
  );

  const transaction = value(
    fixture.registry.offerWake({
      sessionId: "s",
      ownerId: "processes",
      logicalKey: "detached",
      reason: "done",
      outcome: "ready",
    }),
  );
  assert.equal(transaction.hasClaim(), true);
  value(transaction.commit("skipped"));
  assert.equal(settlementState, "committed");

  consumer.dispose();
  const result = staleClaim?.() as { ok: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.equal(result.error, "consumer-replaced");
});

test("replacement consumer replays open offers and stale disposer cannot retire it", () => {
  const fixture = registryFixture();
  const transaction = value(
    fixture.registry.offerWake({
      sessionId: "s",
      ownerId: "processes",
      logicalKey: "ready",
      reason: "ready",
      outcome: "ready",
    }),
  );
  const seen: number[] = [];
  const old = value(
    fixture.registry.registerWakeConsumer({
      sessionId: "s",
      consumerId: "goal-old",
      onOffer(_offer, claim) {
        seen.push(1);
        value(claim());
      },
    }),
  );
  const current = value(
    fixture.registry.registerWakeConsumer({
      sessionId: "s",
      consumerId: "goal-new",
      onOffer(_offer, claim) {
        seen.push(2);
        value(claim());
      },
    }),
  );
  assert.deepEqual(seen, [1, 2]);
  old.dispose();
  assert.equal(fixture.registry.snapshot("s").consumerGeneration, 2);
  assert.equal(transaction.hasClaim(), true);
  value(transaction.abort("delivery unavailable"));
  current.dispose();
});

test("claimed consumer can synchronously return one validated receipt", () => {
  const fixture = registryFixture();
  let observedReceipt: unknown;
  value(
    fixture.registry.registerWakeConsumer({
      sessionId: "s",
      consumerId: "pi-goal-local",
      onOffer(_offer, claim) {
        const handle = value(claim());
        value(
          handle.onSettledWithReceipt((settlement) => {
            assert.equal(settlement.state, "committed");
            assert.equal(settlement.consumerReceipt, undefined);
            return {
              version: 1,
              ...handle.consumerIdentity(),
              continuationId: "goal-continuation-1",
              scheduling: "scheduled",
            };
          }),
        );
        value(handle.onSettled((settlement) => {
          observedReceipt = settlement.consumerReceipt;
        }));
      },
    }),
  );
  const transaction = value(fixture.registry.offerWake({
    sessionId: "s",
    ownerId: "pi-subagents",
    logicalKey: "task-1",
    reason: "ready",
    outcome: "ready",
  }));
  const settlement = value(transaction.commit("delivered"));
  assert.deepEqual(settlement.consumerReceipt, {
    version: 1,
    consumerId: "pi-goal-local",
    consumerGeneration: 1,
    continuationId: "goal-continuation-1",
    scheduling: "scheduled",
  });
  assert.deepEqual(observedReceipt, settlement.consumerReceipt);
  assert.equal(Object.isFrozen(settlement.consumerReceipt), true);
});

test("claim accepts at most one receipt provider", () => {
  const fixture = registryFixture();
  value(fixture.registry.registerWakeConsumer({
    sessionId: "s",
    consumerId: "goal",
    onOffer(_offer, claim) {
      const handle = value(claim());
      value(handle.onSettledWithReceipt(() => undefined));
      const duplicate = handle.onSettledWithReceipt(() => undefined);
      assert.equal(duplicate.ok, false);
      if (!duplicate.ok) assert.equal(duplicate.error, "invalid-input");
    },
  }));
  value(fixture.registry.offerWake({
    sessionId: "s", ownerId: "producer", logicalKey: "one", reason: "ready", outcome: "ready",
  }));
});

test("invalid or throwing receipt provider degrades to no receipt", () => {
  for (const mode of ["invalid", "throw"] as const) {
    const errors: unknown[] = [];
    let id = 0;
    const registry = createContinuationRegistryV1({
      now: () => 100,
      id: () => `${mode}-${++id}`,
      diagnostic: (error) => errors.push(error),
    });
    value(registry.registerWakeConsumer({
      sessionId: "s",
      consumerId: "goal",
      onOffer(_offer, claim) {
        const handle = value(claim());
        value(handle.onSettledWithReceipt(() => {
          if (mode === "throw") throw new Error("receipt failed");
          return {
            version: 1,
            consumerId: "wrong",
            consumerGeneration: 1,
            continuationId: "continuation",
            scheduling: "scheduled",
          };
        }));
      },
    }));
    const transaction = value(registry.offerWake({
      sessionId: "s", ownerId: "producer", logicalKey: mode, reason: "ready", outcome: "ready",
    }));
    assert.equal(value(transaction.commit("delivered")).consumerReceipt, undefined);
    assert.equal(errors.length, 1);
  }
});

test("invalid strings fail without state changes", () => {
  const fixture = registryFixture();
  const before = fixture.registry.snapshot("s").registryVersion;
  const invalid = fixture.registry.acquireBlocking({
    sessionId: "s",
    ownerId: "Bad Owner",
    logicalKey: "x",
    reason: "ok",
  });
  assert.equal(invalid.ok, false);
  assert.equal(fixture.registry.snapshot("s").registryVersion, before);
  assert.equal(
    fixture.registry.offerWake({
      sessionId: "s",
      ownerId: "processes",
      logicalKey: "x\n",
      reason: "wake",
      outcome: "ready",
    }).ok,
    false,
  );
});

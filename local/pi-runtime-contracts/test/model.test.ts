import assert from "node:assert/strict";
import test from "node:test";
import { createContinuationRegistryV1 } from "../src/internal/registry.ts";
import type {
  BlockingLeaseHandleV1,
  WakeProducerTransactionV1,
} from "../src/internal/types.ts";

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected success");
  return result.value;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("randomized lease/offer operations preserve closed invariants", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const next = random(seed);
    let id = 0;
    let now = 0;
    const registry = createContinuationRegistryV1({
      now: () => ++now,
      id: () => `s${seed}-id${++id}`,
    });
    const leases = new Map<string, BlockingLeaseHandleV1>();
    const offers = new Set<WakeProducerTransactionV1>();
    let lastVersion = 0;

    for (let step = 0; step < 250; step++) {
      const operation = Math.floor(next() * 7);
      const key = `key-${Math.floor(next() * 12)}`;
      const lease = leases.get(key);
      if (operation === 0 && !lease) {
        const result = registry.acquireBlocking({
          sessionId: "session",
          ownerId: "model",
          logicalKey: key,
        });
        if (result.ok) leases.set(key, result.value);
      } else if (operation === 1 && lease) {
        lease.checkIn();
      } else if (operation === 2 && lease) {
        lease.updateReason(`reason-${step}`);
      } else if (operation === 3 && lease) {
        const result = lease.releaseWithoutWake({ outcome: "cancelled" });
        if (result.ok) leases.delete(key);
      } else if (operation === 4 && lease) {
        const result = lease.releaseAndOfferWake({
          outcome: "ready",
          reason: `ready-${step}`,
        });
        if (result.ok) {
          leases.delete(key);
          offers.add(result.value);
        }
      } else if (operation === 5) {
        const result = registry.offerWake({
          sessionId: "session",
          ownerId: "model",
          logicalKey: `detached-${step}`,
          reason: `wake-${step}`,
          outcome: "ready",
        });
        if (result.ok) offers.add(result.value);
      } else if (operation === 6 && offers.size > 0) {
        const candidate = [...offers][Math.floor(next() * offers.size)];
        const result = next() < 0.8
          ? candidate.commit("delivered")
          : candidate.abort("delivery failed");
        if (result.ok) offers.delete(candidate);
      }

      const snapshot = registry.snapshot("session");
      assert.ok(snapshot.registryVersion >= lastVersion);
      lastVersion = snapshot.registryVersion;
      const pairs = snapshot.blocking.map(
        (item) => `${item.ownerId}\u0000${item.logicalKey}`,
      );
      assert.equal(new Set(pairs).size, pairs.length);
      assert.equal(snapshot.blocking.length, leases.size);
      assert.equal(snapshot.openOffers, offers.size);
      assert.equal(Object.isFrozen(snapshot), true);
      assert.equal(Object.isFrozen(snapshot.blocking), true);
    }
  }
});

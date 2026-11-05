import assert from "node:assert/strict";
import test from "node:test";
import { createContinuationRegistryV1 } from "../src/internal/registry.ts";

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected success");
  return result.value;
}

test("subscriber mutation is queued after the current stable listener list", () => {
  let id = 0;
  const errors: unknown[] = [];
  const registry = createContinuationRegistryV1({
    now: () => 100,
    id: () => `id-${++id}`,
    diagnostic: (error) => errors.push(error),
  });
  const order: string[] = [];
  let mutated = false;

  value(
    registry.subscribe("s", (snapshot) => {
      if (snapshot.registryVersion === 0) return;
      order.push(`a:${snapshot.blocking.length}`);
      if (!mutated) {
        mutated = true;
        value(
          registry.acquireBlocking({
            sessionId: "s",
            ownerId: "test",
            logicalKey: "nested",
          }),
        );
      }
    }),
  );
  value(
    registry.subscribe("s", (snapshot) => {
      if (snapshot.registryVersion === 0) return;
      order.push(`b:${snapshot.blocking.length}`);
      if (snapshot.blocking.length === 1) throw new Error("listener failure");
    }),
  );

  value(
    registry.acquireBlocking({
      sessionId: "s",
      ownerId: "test",
      logicalKey: "outer",
    }),
  );
  assert.deepEqual(order, ["a:1", "b:1", "a:2", "b:2"]);
  assert.equal(errors.length, 1);
});

test("consumer callback failure leaves offer open for replacement replay", () => {
  const errors: unknown[] = [];
  let id = 0;
  const registry = createContinuationRegistryV1({
    now: () => 100,
    id: () => `id-${++id}`,
    diagnostic: (error) => errors.push(error),
  });
  value(
    registry.registerWakeConsumer({
      sessionId: "s",
      consumerId: "broken",
      onOffer() {
        throw new Error("broken consumer");
      },
    }),
  );
  const transaction = value(
    registry.offerWake({
      sessionId: "s",
      ownerId: "producer",
      logicalKey: "one",
      reason: "ready",
      outcome: "ready",
    }),
  );
  assert.equal(transaction.snapshot().state, "open");
  assert.equal(errors.length, 1);

  let claimed = false;
  value(
    registry.registerWakeConsumer({
      sessionId: "s",
      consumerId: "replacement",
      onOffer(_offer, claim) {
        value(claim());
        claimed = true;
      },
    }),
  );
  assert.equal(claimed, true);
  assert.equal(transaction.hasClaim(), true);
});

test("settlement listeners use a stable copy and isolate errors", () => {
  const errors: unknown[] = [];
  let id = 0;
  const registry = createContinuationRegistryV1({
    now: () => 100,
    id: () => `id-${++id}`,
    diagnostic: (error) => errors.push(error),
  });
  const order: string[] = [];
  value(
    registry.registerWakeConsumer({
      sessionId: "s",
      consumerId: "goal",
      onOffer(_offer, claim) {
        const handle = value(claim());
        let firstDisposable: { dispose(): void } | undefined;
        firstDisposable = value(
          handle.onSettled(() => {
            order.push("first");
            firstDisposable?.dispose();
            throw new Error("settlement listener failed");
          }),
        );
        value(
          handle.onSettled(() => {
            order.push("second");
          }),
        );
      },
    }),
  );
  const transaction = value(
    registry.offerWake({
      sessionId: "s",
      ownerId: "producer",
      logicalKey: "one",
      reason: "ready",
      outcome: "ready",
    }),
  );
  value(transaction.commit("delivered"));
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(errors.length, 1);
});

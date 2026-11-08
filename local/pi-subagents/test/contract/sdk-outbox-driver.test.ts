import assert from "node:assert/strict";
import test from "node:test";
import { createSdkFixture, until } from "../fixtures/sdk-runtime.js";
import { reconcileMainDeliveryV1 } from "../../src/host/delivery-engine.js";

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("Task settlement owns the Outbox between cards and Wake and throughout Wake settlement", { timeout: 60_000 }, async () => {
  const f = await createSdkFixture(), childRelease = gate(), beforeWake = gate(), wakeRelease = gate(), openingWake = gate(), openRelease = gate();
  f.control.responses.set("CHILD_WORK", childRelease.promise);
  try {
    await f.runtime.session.prompt("SPAWN_NONE");
    const service = f.cell.service!, binding = service.binding(f.runtime.session.sessionId)!;
    const item = () => binding.host.snapshot().agents[0]!;
    const settleWake = binding.delivery.settleWake.bind(binding.delivery), openWake = binding.host.openOutboxWake.bind(binding.host);
    let settles = 0;
    binding.delivery.settleWake = async outboxId => {
      if (++settles === 1) { beforeWake.resolve(); await wakeRelease.promise; }
      // Before the fix, let the contender enter ownSettlement only after the
      // Task owner has acquired it, reproducing the false failure without sleeps.
      else await openingWake.promise;
      return settleWake(outboxId);
    };
    binding.host.openOutboxWake = async input => { openingWake.resolve(); await openRelease.promise; return openWake(input); };
    childRelease.resolve();
    await beforeWake.promise;
    const outboxId = item().outbox[0]!.outbox_id;
    assert.equal(item().outbox[0]!.state, "cards-appended");
    assert.equal(item().outbox[0]!.wake_state, "not-offered");
    const reports: unknown[] = [];
    const reconcile = () => reconcileMainDeliveryV1({ host: binding.host, delivery: binding.delivery, mainSessionId: binding.mainSessionId, report: value => reports.push(value) });
    const expected = { delivered: [], deferred: [{ outboxId, reason: "delivering" }], failed: [] };
    const betweenCardsAndWake = reconcile();
    wakeRelease.resolve();
    await openingWake.promise;
    assert.deepEqual(await betweenCardsAndWake, expected, "card ownership must continue across the call into settleWake");
    assert.deepEqual(await reconcile(), expected, "an active ownSettlement must quietly defer the other driver");
    assert.deepEqual(reports, []);
    openRelease.resolve();
    await until(() => item().outbox[0]?.state === "delivered", "Task owner delivered the Outbox", () => ({ item: item(), diagnostics: service.diagnostics() }));
    assert.equal(settles, 1, "the contending reconcile must never enter settleWake");
    const branch = f.context.sessionManager.getBranch();
    assert.equal(branch.filter(entry => entry.type === "custom_message" && entry.customType === "subagent-completion-v1"
      && (entry.details as any)?.completion_id === item().completions[0]!.completion_id).length, 1);
    assert.equal(branch.filter(entry => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1"
      && (entry.details as any)?.outbox_id === outboxId).length, 1, "Wake is delivered exactly once");
    assert.deepEqual(service.diagnostics(), []);
  } finally { childRelease.resolve(); wakeRelease.resolve(); openRelease.resolve(); await f.close(); }
});

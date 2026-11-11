import assert from "node:assert/strict";
import test from "node:test";
import { mailboxHarness } from "./mailbox-harness.ts";
import { isolatedProcessesConfig as defaultProcessesConfig } from "../isolation-fixture.ts";

for (const idle of [false, true]) test(`Main ${idle ? "idle" : "active"} handoff waits for native proof and marker before source ACK`, async () => {
  const h = await mailboxHarness();
  try {
    h.setIdle(idle); await h.match(); await h.coordinator.turnEnded(h.ctx);
    assert.equal(h.puts.length, 1); assert.equal(h.puts[0]!.wake, true);
    assert.ok(h.host.preparedNotificationBatches().length); assert.equal(h.host.mainTurnNotificationReceipt()?.persisted, false);
    await h.record(); assert.equal(h.host.preparedNotificationBatches().length, 0); assert.equal(h.host.mainTurnNotificationReceipt()?.wakeSettled, true);
    await h.record(); assert.equal(h.puts.length, 1);
  } finally { await h.dispose(); }
});

test("marker write failure retains accepted mail and broker wake until same recorded callback succeeds", async () => {
  const h = await mailboxHarness(); try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); h.markerFault(true);
    await assert.rejects(h.record(), /FAULT marker/);
    assert.equal(h.host.mainTurnNotificationReceipt()?.wakeSettled, false);
    h.markerFault(false); await h.record(); assert.equal(h.host.mainTurnNotificationReceipt()?.wakeSettled, true); assert.equal(h.puts.length, 1);
  } finally { await h.dispose(); }
});

test("only accepted external input clears the abort fence and creates next-user context mail", async () => {
  const h = await mailboxHarness(); try {
    h.host.setNotificationRunAbortFence(); await h.match();
    for (const candidate of [{ source: "extension" }, { source: "interactive", streamingBehavior: "steer" }] as const) { h.coordinator.captureInput(candidate); await h.beforeRun(); assert.equal(h.host.notificationRunAbortFence(), true); }
    h.coordinator.captureInput({ source: "rpc" }); h.coordinator.captureInput({ source: "interactive" }); await h.beforeRun(); assert.equal(h.host.notificationRunAbortFence(), true);
    h.coordinator.captureInput({ source: "rpc" }); await h.beforeRun();
    assert.equal(h.host.notificationRunAbortFence(), false); assert.equal(h.puts.length, 1); assert.equal(h.puts[0]!.policy, "next-user"); assert.equal(h.puts[0]!.wake, false);
  } finally { await h.dispose(); }
});

test("aborted and failed runs do not write turn-settled", async () => {
  for (const outcome of ["aborted", "error"] as const) {
    const h = await mailboxHarness(); try {
      await h.match(); await h.coordinator.turnEnded(h.ctx); await h.record(); await h.end(undefined, outcome);
      assert.equal(h.branch.some(e => e.data?.state === "turn-settled"), false); assert.equal(h.coordinator.pendingBatchIds().length, 1);
    } finally { await h.dispose(); }
  }
});

test("lost put reply retries the exact source identity and never rolls back accepted transport", async () => {
  const h = await mailboxHarness(); try {
    const put = h.source.endpoint.put.bind(h.source.endpoint); let lost = true;
    h.source.endpoint.put = async (...args) => { const result = await put(...args); if (lost) { lost = false; throw new Error("FAULT lost put reply"); } return result; };
    await h.match(); await assert.rejects(h.coordinator.turnEnded(h.ctx), /lost put reply/);
    const original = structuredClone(h.puts[0]); await h.coordinator.turnEnded(h.ctx);
    assert.equal(h.puts.length, 1); assert.deepEqual(h.puts[0], original); assert.equal(h.host.preparedNotificationBatches().length, 1);
    await h.record(); assert.equal(h.host.preparedNotificationBatches().length, 0);
  } finally { await h.dispose(); }
});

for (const attention of ["ignore", "context"] as const) test(`managed terminal wake overrides ${attention} and detached continuation`, async () => {
  const config = defaultProcessesConfig();
  const h = await mailboxHarness({ ...config, managed: { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" } });
  try {
    await h.host.configure({ action: "configure", target: h.host.records()[0]!.id, continuation: { mode: "detached" }, notify: { onSuccess: attention, onFailure: attention } });
    await h.terminal(attention === "ignore" ? "natural" : "timeout");
    assert.equal(h.host.managedSnapshot().wakePending, true);
    await h.coordinator.turnEnded(h.ctx);
    assert.equal(h.puts.length, 1);
    assert.equal(h.puts[0]!.wake, true);
    assert.equal(h.puts[0]!.policy, "next-request");
    await h.record();
    assert.equal(h.host.managedSnapshot().wakePending, true, "mailbox acceptance and recorded ACK are not consumption");
    await h.end();
    assert.equal(h.host.managedSnapshot().wakePending, false);
  } finally { await h.dispose(); }
});

test("managed terminal stays pending across external-boundary demotion and a failed mailbox put", async () => {
  const config = defaultProcessesConfig();
  const h = await mailboxHarness({ ...config, managed: { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" } });
  try {
    await h.terminal();
    const put = h.source.endpoint.put.bind(h.source.endpoint);
    h.source.endpoint.put = async () => { throw new Error("FAULT put"); };
    h.coordinator.captureInput({ source: "rpc" });
    await assert.rejects(h.beforeRun(), /FAULT put/);
    assert.equal(h.host.managedSnapshot().wakePending, true);
    h.source.endpoint.put = put;
    h.coordinator.captureInput({ source: "rpc" }); await h.beforeRun();
    assert.equal(h.puts[0]!.policy, "next-user");
    await h.record();
    assert.equal(h.host.managedSnapshot().wakePending, true);
    await h.end();
    assert.equal(h.host.managedSnapshot().wakePending, false);
  } finally { await h.dispose(); }
});

for (const outcome of ["aborted", "error"] as const) test(`managed ${outcome} round retains pending wake until cancellation`, async () => {
  const config = defaultProcessesConfig();
  const h = await mailboxHarness({ ...config, managed: { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" } });
  try {
    await h.terminal(); await h.coordinator.turnEnded(h.ctx); await h.record(); await h.end(undefined, outcome);
    assert.equal(h.host.managedSnapshot().wakePending, true);
    h.coordinator.terminal(await h.source.endpoint.cancel(h.puts[0]!.key, "Run cancelled"));
    assert.equal(h.host.managedSnapshot().wakePending, false);
  } finally { await h.dispose(); }
});

for (const outcome of ["completed", "aborted", "error"] as const) test(`overflow-only managed terminal retains wake through ACK and ${outcome} consumption`, async () => {
  const config = defaultProcessesConfig();
  const h = await mailboxHarness({ ...config, managed: { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" } }, { terminalSlots: 0, totalSlots: 256 });
  try {
    await h.terminal();
    assert.equal(h.host.managedSnapshot().wakePending, true);
    h.coordinator.captureInput({ source: "rpc" }); await h.beforeRun();
    const batch = h.puts[0]!.messages[0]!.details as { items: unknown[]; overflow?: { byKind: Record<string, number> } };
    assert.deepEqual(batch.items, []);
    assert.equal(batch.overflow?.byKind.terminal, 1);
    await h.record();
    assert.equal(h.host.managedSnapshot().wakePending, true, "recorded overflow is still not consumption");
    await h.end(undefined, outcome);
    assert.equal(h.host.managedSnapshot().wakePending, outcome !== "completed");
    if (outcome !== "completed") h.coordinator.terminal(await h.source.endpoint.cancel(h.puts[0]!.key, "Run cancelled"));
    assert.equal(h.host.managedSnapshot().wakePending, false);
  } finally { await h.dispose(); }
});

test("managed terminal after a satisfied watch retains a successor wake in the sealed epoch", async () => {
  const config = defaultProcessesConfig();
  const h = await mailboxHarness({ ...config, managed: { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" } });
  try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); await h.record();
    assert.equal(h.host.records()[0]!.continuation.state, "satisfied");
    await h.terminal();
    assert.equal(h.puts.length, 1, "successor waits for the first run to settle");
    await h.end();
    assert.equal(h.puts.length, 2);
    assert.equal(h.puts[1]!.wake, true);
    await h.record(); await h.end([h.puts[1]!.key]);
    assert.equal(h.host.managedSnapshot().wakePending, false);
  } finally { await h.dispose(); }
});

test("durable cancellation releases the source window without claiming a successful run", async () => {
  const h = await mailboxHarness(); try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); const mail = h.puts[0]!;
    const evidence = await h.source.endpoint.cancel(mail.key, "scope ended"); h.coordinator.terminal(evidence);
    assert.equal(h.host.mainTurnNotificationReceipt(), undefined); assert.equal(h.host.preparedNotificationBatches().length, 0); assert.deepEqual(h.coordinator.pendingBatchIds(), []);
    assert.equal(h.branch.some(e => e.data?.state === "turn-settled"), false);
  } finally { await h.dispose(); }
});

test("contained execution still permits current-scope durable cancellation, but not stale owners", async () => {
  const h = await mailboxHarness();
  try {
    await h.match(); await h.coordinator.turnEnded(h.ctx);
    const mail = h.puts[0]!;
    await h.record();
    await h.terminal();
    const receipt = h.host.mainTurnNotificationReceipt()!;
    await h.host.dispose("scope-ended");
    assert.equal(h.host.disposed, true);
    assert.equal(h.coordinator.checkCurrent(mail).kind, "hold", "containment never grants delivery");
    await assert.rejects(h.coordinator.cancelPending({ ...h.ctx, sessionManager: { ...h.ctx.sessionManager } } as any, h.source), /stale/);
    // A captured projection can finish annotating after execution containment.
    // These writes are in-memory source state, not execution authority.
    h.host.setMainTurnNotificationPending({ afterBatchId: mail.key.slice(6) });
    h.host.setMainTurnNotificationReceipt(receipt);
    h.host.setNotificationTurnEpochSealed(true);
    const cancel = h.source.endpoint.cancel.bind(h.source.endpoint);
    h.source.endpoint.cancel = async (...args) => {
      const evidence = await cancel(...args);
      h.coordinator.terminal(evidence);
      return evidence;
    };
    await h.coordinator.cancelPending(h.ctx, h.source);
    assert.equal(h.branch.filter(entry => entry.customType === "process-notification-migration-v1" && entry.data.classification === "cancelled").length, 1);
    assert.deepEqual(h.host.mainTurnPendingBatches(), []);
    assert.equal(h.host.mainTurnNotificationPending(), undefined, "disposed Host must not rearm a successor");
    assert.equal(h.host.mainTurnNotificationReceipt(), undefined);
    assert.equal(h.host.notificationTurnEpochSealed(), false);
    const snapshot = h.host.managedSnapshot();
    assert.equal(snapshot.cleanup, "closed");
    assert.equal(snapshot.wakePending, false);
    assert.equal(snapshot.running_count + snapshot.starting_count + snapshot.stopping_count, 0);
    assert.deepEqual(h.host.preparedNotificationBatches(), []);
    assert.doesNotThrow(() => {
      h.host.clearMainTurnPendingBatch(mail.key.slice(6));
      h.host.setMainTurnNotificationPending(undefined);
      h.host.setMainTurnNotificationReceipt(undefined);
      h.host.setNotificationTurnEpochSealed(false);
    });
    assert.deepEqual(h.host.managedSnapshot(), snapshot, "idempotent clears never reopen cleanup or create a wake");
    assert.equal(h.puts.length, 1, "no new mailbox delivery");
    await assert.rejects(h.host.ensureStarted(), /disposed/);
    h.coordinator.dispose();
    await assert.rejects(h.coordinator.cancelPending(h.ctx, h.source), /stale/);
  } finally { await h.dispose(); }
});

test("disposed Host rejects non-cancellation terminal evidence without modifying source state", async () => {
  const h = await mailboxHarness();
  try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); await h.record();
    const evidence = await h.source.endpoint.cancel(h.puts[0]!.key, "scope ended");
    await h.host.dispose("scope-ended");
    const snapshot = h.host.managedSnapshot(), entries = structuredClone(h.branch);
    for (const outcome of ["fulfilled", "completed"]) {
      assert.throws(() => h.coordinator.terminal({ ...evidence, outcome,
        receiptEntryId: "receipt", assistantEntryId: "assistant", nativeEntryIds: [] } as any), /another binding/);
      assert.deepEqual(h.host.managedSnapshot(), snapshot);
      assert.deepEqual(h.branch, entries);
    }
  } finally { await h.dispose(); }
});

for (const mismatch of ["evidence session", "manager session", "replaced manager"] as const) test(`cancellation rejects ${mismatch} without modifying source state`, async () => {
  const h = await mailboxHarness();
  try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); await h.record();
    const evidence = await h.source.endpoint.cancel(h.puts[0]!.key, "scope ended");
    const snapshot = h.host.managedSnapshot(), entries = structuredClone(h.branch);
    if (mismatch === "evidence session") {
      assert.throws(() => h.coordinator.terminal({ ...evidence, scope: { ...evidence.scope, sessionId: "foreign" } }), /another binding/);
    } else {
      const replacement = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager } } as any;
      if (mismatch === "manager session") h.ctx.sessionManager.getSessionId = () => "foreign";
      else h.replaceContext(replacement);
      assert.throws(() => h.coordinator.terminal(evidence), /another binding/);
      await assert.rejects(h.coordinator.cancelPending(h.ctx, h.source), /stale/);
      // Activation must not turn an old coordinator into a new manager's owner.
      if (mismatch === "replaced manager") {
        h.coordinator.activate(replacement);
        assert.throws(() => h.coordinator.terminal(evidence), /another binding/);
        await assert.rejects(h.coordinator.cancelPending(replacement, h.source), /stale/);
      }
    }
    assert.deepEqual(h.host.managedSnapshot(), snapshot);
    assert.deepEqual(h.branch, entries);
  } finally { await h.dispose(); }
});

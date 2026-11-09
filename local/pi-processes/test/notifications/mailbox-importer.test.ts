import assert from "node:assert/strict";
import test from "node:test";
import { registerGoalContinuationObligationV1 } from "pi-runtime-contracts/goal-continuation-obligation-v1";
import { mailboxHarness } from "./mailbox-harness.ts";

async function seedLegacy() {
  const h = await mailboxHarness(); await h.match(); await h.coordinator.turnEnded(h.ctx);
  const original = h.puts[0]!, native = { id: "legacy-body", type: "custom_message", parentId: "origin", ...original.messages[0] };
  h.puts.splice(0); h.accepted.clear(); h.host.setMainTurnNotificationReceipt(undefined);
  h.replaceSessionEntries([h.root[0], native]);
  return { h, original, native, status(state: string) { h.pi.appendEntry("process-notification-status-v1", { version: 1, sessionScopeId: h.sessionId, batchId: original.key.slice(6), state }); } };
}

test("legacy orphan is durably classified visible-unknown and retained as next-user context", async () => {
  const { h } = await seedLegacy(); try {
    await h.coordinator.importLegacy(h.ctx, h.source);
    assert.equal(h.puts.length, 1); assert.equal(h.puts[0]!.policy, "next-user"); assert.equal(h.puts[0]!.wake, false);
    assert.equal(h.branch.some(e => e.customType === "process-notification-migration-v1" && e.data.classification === "visible-unknown"), true);
    await h.record(); assert.equal(h.branch.filter(e => e.type === "custom_message").length, 1);
  } finally { await h.dispose(); }
});

test("legacy pending marker transfers wake with original carrier proof", async () => {
  const { h, status, original } = await seedLegacy(); try {
    status("pending"); await h.coordinator.importLegacy(h.ctx, h.source); await h.record();
    assert.equal(h.puts[0]!.wake, true); assert.deepEqual(h.puts[0]!.messages, original.messages); assert.equal(h.branch.filter(e => e.type === "custom_message").length, 1);
  } finally { await h.dispose(); }
});

test("legacy settled batch uses importFulfilled and never creates runnable mail", async () => {
  const { h, status } = await seedLegacy(); try {
    status("pending"); h.branch.push({ id: "assistant-proof", type: "message", message: { role: "assistant", stopReason: "stop", content: [] } }); status("turn-settled");
    await h.coordinator.importLegacy(h.ctx, h.source);
    assert.equal(h.puts.length, 0); assert.equal(h.imports.length, 1); assert.equal(h.imports[0].proof.assistantEntryId, "assistant-proof"); assert.deepEqual(h.coordinator.pendingBatchIds(), []);
  } finally { await h.dispose(); }
});

test("settled marker without successful assistant proof stays visible-unknown", async () => {
  const { h, status } = await seedLegacy(); try {
    status("turn-settled"); await h.coordinator.importLegacy(h.ctx, h.source);
    assert.equal(h.puts.length, 0); assert.equal(h.imports.length, 0); assert.ok(h.reports.some(m => m.includes("visible-unknown")));
  } finally { await h.dispose(); }
});

test("Goal claim retains wake obligation while owed, holds unknown and admits fallback when none", async () => {
  const h = await mailboxHarness(); let obligation: "owed" | "none" | "unknown" = "owed";
  const reader = registerGoalContinuationObligationV1(query => query.sessionId === h.sessionId && query.continuationId === "continuation" ? obligation : "none");
  try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); await h.record(); const mail = h.puts[0]!;
    h.pi.appendEntry("process-notification-claim-v1", { version: 1, sessionScopeId: h.sessionId, batchId: mail.key.slice(6), receipt: { version: 1, consumerId: "pi-goal-local", consumerGeneration: 1, continuationId: "continuation", scheduling: "scheduled" } });
    assert.equal(mail.wake, true); assert.deepEqual(h.coordinator.checkCurrent(mail), { kind: "allow", project: true, wake: false });
    obligation = "unknown"; assert.equal(h.coordinator.checkCurrent(mail).kind, "hold");
    obligation = "none"; assert.deepEqual(h.coordinator.checkCurrent(mail), { kind: "allow", project: true, wake: true });
  } finally { reader.dispose(); await h.dispose(); }
});

test("scope cancellation durably cancels only this producer's matching Task intents", async () => {
  const h = await mailboxHarness(); try {
    await h.match(); await h.coordinator.turnEnded(h.ctx);
    const batch = h.puts[0]!.messages[0]!.details as any;
    for (const ownerToken of ["task-a", "task-b"]) {
      const { mail, target } = h.source.prepare({ ...batch, reason: "subagent-admission", batchId: ownerToken }, "next-request", true, undefined, { ownerToken, continuationSignal: true });
      await h.source.endpoint.put(mail, target);
    }
    const cancelled: string[] = [], cancel = h.source.endpoint.cancel.bind(h.source.endpoint);
    h.source.endpoint.cancel = async (...args) => { cancelled.push(args[0]); return cancel(...args); };
    await h.source.cancelOwned(h.ctx, "Task finalized", "task-a"); assert.deepEqual(cancelled, ["batch:task-a"]);
    cancelled.splice(0); await h.coordinator.cancelPending(h.ctx, h.source);
    assert.equal(cancelled.length, 3); assert.equal(h.coordinator.checkCurrent(h.puts[0]!).kind, "cancel");
  } finally { await h.dispose(); }
});

for (const replay of [false, true]) test(`cancelled terminal wins over restore/rebranch/rebind ${replay ? "with" : "without"} callback replay`, async () => {
  const h = await mailboxHarness(); try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); await h.record();
    const mail = h.puts[0]!, oldLeaf = [...h.branch];
    const evidence = await h.source.endpoint.cancel(mail.key, "cancelled by owner");
    h.coordinator.terminal(evidence);
    assert.deepEqual(h.coordinator.pendingBatchIds(), []);
    h.source.endpoint.put = async () => {
      if (replay) await h.registration.onTerminal!(evidence, {} as any);
      return { kind: "terminal", evidence };
    };
    // Navigate to the leaf before the cancellation ACK, then create a fresh
    // coordinator on that leaf. The public tree still owns the cancel record.
    h.setBranch(oldLeaf);
    h.coordinator.restoreFromBranch(oldLeaf);
    assert.deepEqual(h.coordinator.pendingBatchIds(), []);
    await h.coordinator.importLegacy(h.ctx, h.source);
    assert.deepEqual(h.coordinator.pendingBatchIds(), []);
    await h.reload();
    assert.deepEqual(h.coordinator.pendingBatchIds(), []);
    h.coordinator.rebranch(oldLeaf);
    h.coordinator.reconcile(h.ctx);
    assert.deepEqual(h.coordinator.pendingBatchIds(), []);
    assert.equal(h.ctx.sessionManager.getEntries().some(e => e.type === "custom" && (e.data as any)?.state === "turn-settled"), false);
  } finally { await h.dispose(); }
});

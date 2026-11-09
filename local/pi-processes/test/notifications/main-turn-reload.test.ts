import assert from "node:assert/strict";
import test from "node:test";
import { mailboxHarness } from "./mailbox-harness.ts";
import type { ProcessNotificationBatchV1 } from "../../src/notifications/types.ts";

for (const reload of [false, true]) test(`late rearmed wait survives final response ${reload ? "and reload" : "in same runtime"}`, async () => {
  const h = await mailboxHarness(); try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); await h.record(); const first = h.puts[0]!;
    await h.rearm(); await h.match(); await h.coordinator.turnEnded(h.ctx); assert.equal(h.puts.length, 1, "one batch per run");
    if (reload) await h.reload();
    await h.end([first.key]); assert.equal(h.puts.length, 2); await h.record(); await h.end([h.puts[1]!.key]);
    assert.deepEqual(h.coordinator.pendingBatchIds(), []); assert.notEqual(first.key, h.puts[1]!.key);
  } finally { await h.dispose(); }
});

test("reload keeps accepted unrecorded identity without creating a replacement batch", async () => {
  const h = await mailboxHarness(); try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); const mail = structuredClone(h.puts[0]!);
    await h.reload(); await h.coordinator.turnEnded(h.ctx); assert.equal(h.puts.length, 1); assert.deepEqual(h.puts[0], mail);
    await h.record(); assert.equal(h.host.mainTurnNotificationReceipt()?.wakeSettled, true);
  } finally { await h.dispose(); }
});

test("mixed branch settlement cannot clear or inject another branch's mail", async () => {
  const h = await mailboxHarness(); try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); await h.record(); const mail = h.puts[0]!;
    assert.equal(await h.coordinator.beforeTree(h.ctx), undefined); const original = h.branch;
    h.setBranch([{ id: "sibling", type: "message", message: { role: "user", content: "sibling" } }]);
    assert.deepEqual(h.coordinator.pendingBatchIds(), []); await h.end([]); assert.equal(h.branch.some(e => e.data?.batchId === mail.key.slice(6)), false);
    h.setBranch(original); await h.coordinator.importLegacy(h.ctx, h.source); assert.equal(h.coordinator.pendingBatchIds().length, 1);
    await h.end([mail.key]); assert.deepEqual(h.coordinator.pendingBatchIds(), []); assert.equal(h.puts.length, 1);
  } finally { await h.dispose(); }
});

test("a shared source intent cannot re-admit its first native carrier on a sibling", async () => {
  const h = await mailboxHarness(); try {
    await h.match(); await h.coordinator.turnEnded(h.ctx);
    const mail = h.puts[0]!, shared = [...h.branch];
    await h.record(); const original = h.branch;
    h.setBranch([...shared, { id: "sibling", type: "message", message: { role: "user", content: "sibling" } }]);
    assert.equal(h.source.ownsCurrentIntent(mail.key), false);
    assert.throws(() => h.source.prepare(mail.messages[0]!.details as ProcessNotificationBatchV1, "next-request", mail.wake), /carrier belongs to another branch/);
    await h.coordinator.importLegacy(h.ctx, h.source);
    assert.deepEqual(h.coordinator.pendingBatchIds(), []);
    assert.equal(h.branch.some(e => e.type === "custom_message"), false);
    h.setBranch(original);
    assert.equal(h.source.ownsCurrentIntent(mail.key), true);
    await h.coordinator.importLegacy(h.ctx, h.source);
    assert.equal(h.coordinator.pendingBatchIds().length, 1);
    assert.equal(h.puts.length, 1);
  } finally { await h.dispose(); }
});

test("parking keeps a successor on the outgoing branch and waits for canonical proof", async () => {
  const h = await mailboxHarness(); try {
    await h.match(); await h.coordinator.turnEnded(h.ctx); await h.record(); await h.rearm(); await h.match();
    assert.deepEqual(await h.coordinator.beforeTree(h.ctx, true), { cancel: true }); assert.equal(h.puts.length, 1);
    assert.deepEqual(await h.coordinator.beforeTree(h.ctx), { cancel: true }); assert.equal(h.puts.length, 2);
    await h.record(); assert.equal(h.coordinator.checkCurrent(h.puts[1]!).kind, "allow");
    assert.deepEqual(h.coordinator.checkCurrent(h.puts[1]!), { kind: "allow", project: true, wake: false });
    assert.equal(await h.coordinator.beforeTree(h.ctx), undefined);
  } finally { await h.dispose(); }
});

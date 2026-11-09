import assert from "node:assert/strict";
import test from "node:test";
import { mailboxHarness, tick } from "./mailbox-harness.ts";

async function fixture() {
  const h = await mailboxHarness(); await h.match(); await h.coordinator.turnEnded(h.ctx);
  const batch = { ...h.puts[0]!.messages[0]!.details as any, reason: "subagent-admission", batchId: "old-child" };
  const prepared = h.source.prepare(batch, "next-request", true, undefined, { ownerToken: "old-task-generation", continuationSignal: true });
  await h.source.endpoint.put(prepared.mail, prepared.target);
  const cancelled: string[] = [], diagnostics: string[] = [];
  const originalCancel = h.source.endpoint.cancel.bind(h.source.endpoint);
  h.source.endpoint.cancel = async (key, reason, target) => {
    assert.equal(target, prepared.target); cancelled.push(key); return originalCancel(key, reason, target);
  };
  return { h, prepared, cancelled, diagnostics, restore: (capture: () => string | undefined) => h.source.restoreChildIntents(h.ctx, capture, message => diagnostics.push(message)) };
}

test("cold recovery awaits cancellation of the original child's key when Task/generation changed", async () => {
  const f = await fixture(), cancel = f.h.source.endpoint.cancel.bind(f.h.source.endpoint);
  let release!: () => void, finished = false;
  f.h.source.endpoint.cancel = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return cancel(...args); };
  const puts: unknown[] = [], put = f.h.source.endpoint.put.bind(f.h.source.endpoint);
  f.h.source.endpoint.put = async (...args) => { puts.push(args); return put(...args); };
  try {
    const recovery = f.restore(() => "new-task-generation").then(() => { finished = true; });
    await tick(); assert.equal(finished, false); assert.equal(typeof release, "function");
    release(); await recovery;
    assert.deepEqual(f.cancelled, [f.prepared.mail.key]);
    const recovered = puts.find((args: any) => args[0].key === f.prepared.mail.key) as any;
    assert.deepEqual(recovered, [f.prepared.mail, f.prepared.target, { recovered: true }]);
    assert.deepEqual(f.h.accepted.get(f.prepared.mail.key), f.prepared.mail);
    assert.equal(f.h.puts.length, 2, "recovery must not invent a key or another business batch");
  } finally { await f.h.dispose(); }
});

test("surviving child owner is not cancelled on rebind/recovery", async () => {
  const f = await fixture();
  try { await f.restore(() => "old-task-generation"); assert.deepEqual(f.cancelled, []); assert.deepEqual(f.diagnostics, []); }
  finally { await f.h.dispose(); }
});

for (const capture of [() => undefined, () => { throw new Error("no active child Task"); }]) test("unknown owner remains held with a diagnostic instead of being treated as final", async () => {
  const f = await fixture();
  try {
    await f.restore(capture); assert.deepEqual(f.cancelled, []);
    assert.equal(f.diagnostics.length, 1); assert.match(f.diagnostics[0]!, /recovery held.*batch:old-child.*no current Task owner/);
  } finally { await f.h.dispose(); }
});

test("owner identity is captured after asynchronous recovered put, not before it", async () => {
  const f = await fixture(), put = f.h.source.endpoint.put.bind(f.h.source.endpoint);
  let owner = "old-task-generation";
  f.h.source.endpoint.put = async (...args) => { const result = await put(...args); if (args[0].key === f.prepared.mail.key) owner = "new-task-generation"; return result; };
  try { await f.restore(() => owner); assert.deepEqual(f.cancelled, [f.prepared.mail.key]); }
  finally { await f.h.dispose(); }
});

test("an already terminal frozen key is preserved without recapturing business authority", async () => {
  const f = await fixture(), put = f.h.source.endpoint.put.bind(f.h.source.endpoint);
  f.h.source.endpoint.put = async (...args) => args[0].key === f.prepared.mail.key
    ? { kind: "terminal", evidence: { producer: "pi-processes", key: f.prepared.mail.key, terminalId: "original-cancel", scope: { sessionId: f.h.sessionId, anchorEntryId: f.prepared.mail.anchorEntryId }, outcome: "cancelled", reason: "Task already final" } }
    : put(...args);
  try { await f.restore(() => assert.fail("terminal keys do not need an owner decision")); assert.deepEqual(f.cancelled, []); }
  finally { await f.h.dispose(); }
});

test("durable cancellation failure is awaited and surfaced instead of reporting recovery complete", async () => {
  const f = await fixture();
  f.h.source.endpoint.cancel = async () => { throw new Error("cancel writer unavailable"); };
  try { await assert.rejects(f.restore(() => "new-task-generation"), /cancel writer unavailable/); }
  finally { await f.h.dispose(); }
});

test("idle attach can defer authority until a later run and cancel without putting again", async () => {
  const f = await fixture(), cancel = f.h.source.endpoint.cancel.bind(f.h.source.endpoint);
  let release!: () => void, finished = false;
  try {
    await f.restore(() => undefined); assert.deepEqual(f.cancelled, []);
    f.h.source.endpoint.put = async () => assert.fail("beforeRun must not re-put recovered or live mail");
    f.h.source.endpoint.cancel = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return cancel(...args); };
    const recheck = f.h.source.reconcileRecoveredChildOwners(f.h.ctx, () => "new-task-generation", () => {}).then(() => { finished = true; });
    await tick(); assert.equal(finished, false); assert.equal(typeof release, "function");
    release(); await recheck; assert.deepEqual(f.cancelled, [f.prepared.mail.key]);
    await f.h.source.reconcileRecoveredChildOwners(f.h.ctx, () => assert.fail("terminal recovery was removed"), () => {});
  } finally { await f.h.dispose(); }
});

test("late same-token and unknown rechecks preserve the saved frozen intent", async () => {
  const f = await fixture();
  try {
    await f.restore(() => undefined);
    f.h.source.endpoint.put = async () => assert.fail("authority recheck must never admit mail again");
    await f.h.source.reconcileRecoveredChildOwners(f.h.ctx, () => "old-task-generation", () => {});
    await f.h.source.reconcileRecoveredChildOwners(f.h.ctx, () => { throw new Error("Task temporarily unavailable"); }, () => {});
    assert.deepEqual(f.cancelled, []);
    await f.h.source.reconcileRecoveredChildOwners(f.h.ctx, () => "new-task-generation", () => {});
    assert.deepEqual(f.cancelled, [f.prepared.mail.key]);
  } finally { await f.h.dispose(); }
});

test("terminal callback removes recovered authority only after the source ACK succeeds", async () => {
  const f = await fixture();
  try {
    await f.restore(() => undefined);
    await f.h.registration.onTerminal!({ producer: "pi-processes", key: f.prepared.mail.key, terminalId: "cancel-original", scope: { sessionId: f.h.sessionId, anchorEntryId: f.prepared.mail.anchorEntryId }, outcome: "cancelled", reason: "Task ended" }, {} as any);
    f.h.source.endpoint.put = async () => assert.fail("terminal key must not be re-put");
    await f.h.source.reconcileRecoveredChildOwners(f.h.ctx, () => assert.fail("terminal authority must be forgotten"), () => {});
    assert.deepEqual(f.cancelled, []);
  } finally { await f.h.dispose(); }
});

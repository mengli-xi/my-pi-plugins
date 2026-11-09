import assert from "node:assert/strict";
import test from "node:test";
import { ChildTurnNotificationCoordinatorV1 } from "../../src/notifications/child-turn.ts";
import { mailboxHarness, tick } from "../notifications/mailbox-harness.ts";
import { processNotificationBatchMessageV1 } from "../../src/notifications/main-context.ts";
import type { Mail } from "pi-session-inject/mailbox-v1";

async function childHarness(admission: "trigger" | "record-only" = "trigger") {
  const main = await mailboxHarness(); await main.match(); await main.coordinator.turnEnded(main.ctx);
  const batch = { ...(main.puts[0]!.messages[0]!.details as any), reason: "subagent-admission" };
  await main.dispose();
  const target = { strategy: "child" as const, scopeToken: "task-generation-1" };
  const branch: any[] = [], puts: Mail[] = [], calls: string[] = [], reports: string[] = [];
  let liveOwner = target.scopeToken, liveAdmission = admission, prepared: any = { batch, leaseWakeTransactionIds: ["lease:offer:1"] };
  let release: ((value: "trigger" | "record-only") => void) | undefined;
  let suspended = false, bridgeAvailable = true;
  const host = {
    prepareNotificationContinuation() { return prepared; }, preparedNotificationBatch() { return prepared; },
    preparedNotificationContinuations() { return prepared ? [{ target, lane: "turn" as const, prepared }] : []; }, openNotificationContinuations() { return []; },
    childTurnNotificationReceipts() { return []; }, setChildTurnNotificationReceipt() {}, clearChildTurnNotificationReceipt() {},
    commitNotificationBatch() { calls.push("commit"); prepared = undefined; }, settleNotificationBatchRecordOnly() { calls.push("record-only"); prepared = undefined; return true; },
    discardPreparedNotificationBatch() {}, discardNotificationWindow() {},
  };
  const captured = { session: { id: batch.sessionScopeId }, producerToken: Symbol(), bindingGeneration: 1 } as any;
  const mailbox = {
    endpoint: { target: () => captured, async put(mail: Mail, scope: any) { assert.equal(scope, captured); puts.push(mail); return { kind: "accepted", key: mail.key, revision: 1 } as const; } },
    prepare(value: any, policy: any, wake: boolean, _anchor: any, child: any) {
      const mail: Mail = { producer: "pi-processes", key: `batch:${value.batchId}`, anchorEntryId: "origin", policy, wake, messages: [processNotificationBatchMessageV1(value)] };
      branch.push({ type: "custom", customType: "process-notification-intent-v1", data: { version: 1, sessionScopeId: batch.sessionScopeId, mail, child } });
      return { mail, target: captured };
    },
  };
  const make = () => new ChildTurnNotificationCoordinatorV1({ sessionScopeId: batch.sessionScopeId, host, mailbox: mailbox as any, getContext: () => ctx,
    report: message => reports.push(message),
    getBridge: () => bridgeAvailable ? ({ captureOwnerToken: () => liveOwner, admitContinuation(input) { calls.push(`admit:${input.admissionId}:${input.continuationSignal}`); return suspended ? new Promise(next => { release = next; }) : Promise.resolve(liveAdmission); } }) : undefined,
  });
  const ctx = { sessionManager: { getBranch: () => branch } } as any;
  const coordinator = make();
  return { coordinator, puts, calls, reports, target, host, batch, make, ctx, setBridgeAvailable(value: boolean) { bridgeAvailable = value; }, async accept() { coordinator.accept({ target, processId: "process", lane: "turn" }); await tick(); }, setOwner(value: string) { liveOwner = value; }, revoke() { liveAdmission = "record-only"; }, suspend() { suspended = true; }, release() { release?.("trigger"); } };
}

test("child sends only admitted batches through the captured mailbox endpoint", async () => {
  const h = await childHarness(); await h.accept();
  assert.equal(h.puts.length, 1); assert.equal(h.puts[0]!.wake, true); assert.equal(h.calls.includes("commit"), false);
  h.coordinator.recorded({ key: h.puts[0]!.key } as any); assert.equal(h.calls.includes("commit"), true);
});
test("record-only admission never transfers transport ownership", async () => {
  const h = await childHarness("record-only"); await h.accept(); assert.equal(h.puts.length, 0); assert.equal(h.calls.includes("record-only"), true);
});
test("both guard checkpoints revalidate the same live execution grant", async () => {
  const h = await childHarness(); await h.accept(); const mail = h.puts[0]!;
  assert.deepEqual(await h.coordinator.checkCurrent(mail), { kind: "allow", project: true, wake: true });
  h.revoke(); assert.equal((await h.coordinator.checkCurrent(mail)).kind, "cancel");
});
test("old Task/generation cannot project into the resident child's later Task", async () => {
  const h = await childHarness(); await h.accept(); h.setOwner("task-generation-2"); assert.equal((await h.coordinator.checkCurrent(h.puts[0]!)).kind, "cancel");
});
test("stale asynchronous admission cannot submit after disposal", async () => {
  const h = await childHarness(); h.suspend(); h.coordinator.accept({ target: h.target, processId: "process", lane: "turn" }); h.coordinator.dispose(); h.release(); await tick(); assert.equal(h.puts.length, 0);
});
test("replacement retries the same mailbox identity without trusting native absence", async () => {
  const h = await childHarness(); await h.accept(); h.coordinator.dispose(); const replacement = h.make(); replacement.recoverPrepared(); await tick();
  assert.equal(h.puts.length, 2); assert.deepEqual(h.puts[0], h.puts[1]);
});

test("pre-final cancellation fences late admission before awaiting durable tombstones", async () => {
  const h = await childHarness(); h.suspend(); h.coordinator.accept({ target: h.target, processId: "process", lane: "turn" });
  const tokens: string[] = [];
  const cancelling = h.coordinator.cancelPending(h.ctx, { async cancelOwned(_ctx: unknown, _reason: string, token: string) { tokens.push(token); } } as any);
  h.release(); await cancelling; await tick();
  assert.deepEqual(tokens, [h.target.scopeToken]); assert.equal(h.puts.length, 0); assert.equal(h.calls.includes("record-only"), true);
});


test("missing child bridge holds the same prepared batch until an explicit recovery boundary", async () => {
  const h = await childHarness();
  h.setBridgeAvailable(false); await h.accept();
  assert.equal(h.puts.length, 0);
  assert.equal(h.calls.includes("record-only"), false);
  assert.ok(h.host.preparedNotificationBatch());
  assert.ok(h.reports.some(message => message.includes("admission held") && message.includes(h.batch.batchId)));
  h.coordinator.recoverPrepared(); await tick();
  assert.equal(h.calls.includes("record-only"), false);
  h.setBridgeAvailable(true); h.coordinator.recoverPrepared(); await tick();
  assert.equal(h.puts.length, 1);
  assert.equal(h.puts[0]!.key, `batch:${h.batch.batchId}`);
  assert.deepEqual(h.calls.filter(value => value.startsWith("admit:")), [`admit:${h.batch.batchId}:true`]);
  h.coordinator.recorded({ key: h.puts[0]!.key } as any);
  assert.equal(h.calls.includes("commit"), true);
});

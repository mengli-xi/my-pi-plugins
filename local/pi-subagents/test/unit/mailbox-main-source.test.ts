import assert from "node:assert/strict";
import test from "node:test";
import { registerGoalContinuationObligationV1 } from "pi-runtime-contracts/goal-continuation-obligation-v1";
import { checkMainMail, recordMainMail, terminalMainMail } from "../../src/mailbox/main-source.ts";
import { MAIN_RUN_COMPLETED_CUSTOM_TYPE, MainTurnSettlementV1 } from "../../src/host/main-turn-settlement.ts";
function fixture() {
  const inbox = { state: "appended", inbox_id: "inb", completion_id: "cmp", model_entry_id: "native-card", projection: { content: "result", projection_sha256: "a".repeat(64), details_json: "{}" } };
  const outbox: any = { outbox_id: "out", wake_epoch: 1, recipient: { kind: "main", session_id: "main" }, completion_ids: ["cmp"], state: "delivered", settlement_kind: "goal-claimed", turn_settlement: { state: "pending" } };
  const state = { root: { mailbox: [], inbox: [inbox], outbox: [outbox], wake_receipts: [{ outbox_id: "out", wake_epoch: 1, continuation_identity: "goal-marker" }] }, agents: [] };
  let accepted = false; const fallback: any[] = [];
  const branch: any[] = [], turn = new MainTurnSettlementV1();
  const binding: any = { mainSessionId: "main", turn, host: { snapshot: () => state }, append: { session: { getBranch: () => branch }, transport: { hasAccepted: () => accepted }, async acceptContinuation(value: any) { fallback.push(value); } } };
  const mail: any = { producer: "pi-subagents", key: "outbox:out:1", anchorEntryId: null, policy: "next-request", wake: true,
    messages: [{ customType: "subagent-completion-v1", content: "result", display: true, details: { version: 1, inbox_id: "inb", completion_id: "cmp", projection_sha256: inbox.projection.projection_sha256, details_json: "{}" } }] };
  const continuation = { ...mail, key: mail.key + ":continuation", messages: [{ customType: "subagent-continuation-v1", content: "Subagent results cmp are ready. Continue from the delivered completion cards.", display: false, details: { version: 1, outbox_id: "out", wake_epoch: 1, completion_ids: ["cmp"] } }] };
  binding.append.transport.frozen = (key: string) => key === mail.key ? mail : key === continuation.key ? continuation : undefined;
  return { binding, mail, continuation, outbox, fallback, branch, turn, accept: () => { accepted = true; } };
}
for (const obligation of ["owed", "unknown", "none"] as const) test(`Goal ${obligation} preserves one continuation owner`, async t => {
  const reader = registerGoalContinuationObligationV1(() => obligation); t.after(() => reader.dispose());
  const f = fixture(), result = checkMainMail(f.binding, f.mail);
  if (obligation === "owed") { assert.deepEqual(result, { kind: "allow", project: true, wake: false }); assert.equal(f.fallback.length, 0); }
  else if (obligation === "unknown") { assert.equal(result.kind, "hold"); assert.equal(f.fallback.length, 0); }
  else { assert.equal(result.kind, "hold"); assert.equal(f.fallback.length, 0); f.accept(); assert.deepEqual(checkMainMail(f.binding, f.mail), { kind: "allow", project: true, wake: true }); }
});
test("successful original Main turn preserves cards for import and cancels only the redundant continuation", async () => {
  const f = fixture(); f.outbox.turn_settlement.state = "settled";
  assert.deepEqual(checkMainMail(f.binding, f.mail), { kind: "allow", project: true, wake: false });
  assert.equal(checkMainMail(f.binding, f.continuation).kind, "cancel");
  await terminalMainMail(f.binding, { producer: "pi-subagents", key: f.continuation.key, terminalId: "terminal", scope: { sessionId: "main", anchorEntryId: null }, outcome: "cancelled", reason: "already handled" });
  assert.equal(f.fallback.length, 0); assert.equal(f.outbox.turn_settlement.state, "settled");
});
test("source journal projection rejects a tampered pending body before native send", () => {
  const f = fixture(); f.mail.messages[0].content = "tampered";
  assert.throws(() => checkMainMail(f.binding, f.mail), /source card projection conflict/);
});
test("successful Main observation suppresses fallback before its source turn transaction", () => {
  const f = fixture();
  f.turn.runStarted(); f.turn.observeContext([{ role: "custom", ...f.mail.messages[0] }]); f.turn.runEnded(false);
  assert.deepEqual(f.turn.handledInboxIds(), [], "live wake suppression grants no Host commit authority");
  assert.deepEqual(checkMainMail(f.binding, f.mail), { kind: "allow", project: true, wake: false });
  assert.equal(f.fallback.length, 0); assert.equal(f.outbox.turn_settlement.state, "pending");
});
test("failed Main observation still requires producer fallback", () => {
  const f = fixture();
  f.turn.runStarted(); f.turn.observeContext([{ role: "custom", ...f.mail.messages[0] }]); f.turn.runEnded(true);
  assert.equal(checkMainMail(f.binding, f.mail).kind, "hold"); assert.equal(f.fallback.length, 0);
});
test("Goal completing inside the original card request cannot create a successor", () => {
  const f = fixture();
  f.turn.runStarted(); f.turn.observeContext([{ role: "custom", ...f.mail.messages[0] }]);
  assert.deepEqual(checkMainMail(f.binding, f.mail), { kind: "allow", project: true, wake: false });
  assert.equal(f.fallback.length, 0);
  f.turn.runEnded(true);
  assert.equal(checkMainMail(f.binding, f.mail).kind, "hold"); assert.equal(f.fallback.length, 0, "the source driver, not a guard, plans fallback");
});
for (const key of ["card:inb", "outbox:out:1"]) test(`fulfilled ${key} receipt suppresses a successor after observer restart`, () => {
  const f = fixture();
  f.branch.push({ id: "native-card", type: "custom_message", ...f.mail.messages[0] },
    { id: "assistant", type: "message", message: { role: "assistant", stopReason: "toolUse" } },
    { id: "receipt", type: "custom", customType: "agent-mailbox-delivery-v1", data: { version: 1, sessionId: "main", terminals: [{
      mail: { ...f.mail, key }, branchEntryId: "native-card", evidence: { producer: "pi-subagents", key, terminalId: "terminal", outcome: "fulfilled", scope: { sessionId: "main", anchorEntryId: null }, assistantEntryId: "assistant", nativeEntryIds: ["native-card"] },
    }] } });
  assert.deepEqual(checkMainMail(f.binding, f.mail), { kind: "allow", project: true, wake: false });
  assert.equal(f.fallback.length, 0);
  f.branch.splice(1, 1); // A sibling assistant or an absent original request is not evidence.
  assert.equal(checkMainMail(f.binding, f.mail).kind, "hold"); assert.equal(f.fallback.length, 0);
});
for (const boundary of ["recorded", "terminal"] as const) test(`outbox ${boundary} replay only acknowledges native source facts`, async () => {
  const f = fixture(); let commits = 0;
  f.branch.push({ id: "native-card", type: "custom_message", ...f.mail.messages[0] },
    { id: "assistant", type: "message", message: { role: "assistant", stopReason: "stop" } },
    { id: "source-run", type: "custom", customType: MAIN_RUN_COMPLETED_CUSTOM_TYPE, data: { version: 1, sessionId: "main", assistantEntryId: "assistant",
      cards: [{ inboxId: "inb", completionId: "cmp", entryId: "native-card", projectionSha256: "a".repeat(64) }] } });
  Object.assign(f.outbox.turn_settlement, { wake_epoch: 1, continuation_identity: "goal-marker" });
  f.binding.host.settleOutboxTurn = async (input: any) => {
    assert.deepEqual({ outboxId: input.outboxId, wakeEpoch: input.wakeEpoch, continuationIdentity: input.continuationIdentity },
      { outboxId: "out", wakeEpoch: 1, continuationIdentity: "goal-marker" });
    await Promise.resolve(); commits++; f.outbox.turn_settlement.state = "settled";
    return { ok: true };
  };
  f.binding.delivery = { async reconcileOutbox() {} };
  assert.deepEqual(f.turn.handledInboxIds(), []);
  const replay = () => boundary === "recorded" ? recordMainMail(f.binding, { producer: "pi-subagents", key: f.mail.key, scope: { sessionId: "main", anchorEntryId: null }, recordedToken: "recorded", entries: [{ messageIndex: 0, entryId: "native-card" }] })
    : terminalMainMail(f.binding, { producer: "pi-subagents", key: f.mail.key, terminalId: "terminal", scope: { sessionId: "main", anchorEntryId: null }, outcome: "fulfilled", receiptEntryId: "receipt", assistantEntryId: "assistant", nativeEntryIds: ["native-card"] });
  await replay();
  assert.equal(commits, 0); assert.equal(f.outbox.turn_settlement.state, "pending");
  await replay(); assert.equal(commits, 0, "ACK replay cannot drive the business turn");
});

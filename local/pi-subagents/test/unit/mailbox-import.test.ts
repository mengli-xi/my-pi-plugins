import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MainTurnSettlementV1 } from "../../src/host/main-turn-settlement.ts";
import { harness, clearMailboxes } from "../../../pi-session-inject/test/mailbox-harness.ts";
import { SubagentMailboxTransport } from "../../src/mailbox/transport.ts";
import { importMainMailbox } from "../../src/mailbox/import-main.ts";
async function fixture(t: test.TestContext, settled: boolean | undefined, lateContinuation = false) {
  const dir = await mkdtemp(join(tmpdir(), "subagents-mailbox-import-"));
  let session = SessionManager.create(dir);
  session.appendMessage({ role: "user", content: "delegate a task", timestamp: Date.now() });
  const puts: any[] = [], imports: any[] = [], cancels: any[] = [];
  const outbox: any = { outbox_id: "out", wake_epoch: 4, completion_ids: ["cmp"], state: "delivered", settlement_kind: "producer-fallback",
    recipient: { kind: "main", session_id: session.getSessionId() }, ...(settled !== undefined ? { turn_settlement: { version: 1, wake_epoch: 4, continuation_identity: "native", state: settled ? "settled" : "pending", pending_at: "2026-01-01T00:00:00.000Z" } } : {}) };
  const details = { version: 1, outbox_id: "out", wake_epoch: 4, completion_ids: ["cmp"] };
  const card = { content: "done", projection_sha256: "a".repeat(64), details_json: "{}" };
  const cardNative = session.appendCustomMessageEntry("subagent-completion-v1", card.content, true,
    { version: 1, inbox_id: "inb", completion_id: "cmp", projection_sha256: card.projection_sha256, details_json: card.details_json });
  const appendAssistant = () => session.appendMessage({ role: "assistant", content: [{ type: "text", text: "handled" }], stopReason: "stop", timestamp: Date.now() } as any);
  let assistant = lateContinuation ? appendAssistant() : "";
  const native = session.appendCustomMessageEntry("subagent-continuation-v1", "Subagent results cmp are ready. Continue from the delivered completion cards.", false, details);
  if (!lateContinuation) assistant = appendAssistant();
  const state: any = { root: { host_revision: 10, mailbox: [], inbox: [{ inbox_id: "inb", completion_id: "cmp", state: "appended", model_entry_id: cardNative, projection: card }], outbox: [outbox] }, agents: [] };
  const binding: any = { mainSessionId: session.getSessionId(), turn: new MainTurnSettlementV1(), host: { snapshot: () => state } };
  const recoveredPrefixes: string[] = []; let h: Awaited<ReturnType<typeof harness>>, transport: SubagentMailboxTransport, pi: any;
  async function attach() {
    h = await harness({ directory: dir, manager: session }); pi = h.piFor("legacy-source");
    transport = new SubagentMailboxTransport(pi, h.agentDir, { checkCurrent: () => ({ kind: "hold", reason: "legacy proof only" }), onRecorded() {}, onTerminal() {} });
    await h.emit("session_start", { reason: "startup" });
    if (settled === true && !transport.hasAccepted("outbox:out:4:continuation")) await transport.put({ key: "outbox:out:4:continuation", wake: true,
      messages: [{ customType: "subagent-continuation-v1", content: "Subagent results cmp are ready. Continue from the delivered completion cards.", display: false, details }] });
    const put = transport.put.bind(transport), imported = transport.importFulfilled.bind(transport), cancel = transport.cancel.bind(transport), mark = transport.markRecoveredPrefix.bind(transport);
    transport.put = async input => { puts.push(input); return put(input); };
    transport.importFulfilled = async (value, proof) => { imports.push({ value, proof }); return imported(value, proof); };
    transport.cancel = async (key, reason) => { cancels.push({ key, reason }); return cancel(key, reason); };
    transport.markRecoveredPrefix = prefix => { recoveredPrefixes.push(prefix); mark(prefix); };
  }
  await attach();
  t.after(async () => { transport.close(); await h.cleanup(); await rm(dir, { recursive: true, force: true }); });
  return { get transport() { return transport; }, get session() { return session; }, async reopen() { transport.close(); await clearMailboxes(); session = SessionManager.open(session.getSessionFile()!); await attach(); },
    native, cardNative, assistant, puts, imports, cancels, outbox, recoveredPrefixes, run: () => importMainMailbox(pi, h.ctx, binding, transport) };
}
test("terminal Outbox with pending business turn imports the original epoch as an owed wake", async t => {
  const f = await fixture(t, false); const result = await f.run();
  assert.deepEqual(result, [{ key: "outbox:out:4", state: "accepted" }, { key: "outbox:out:4:continuation", state: "accepted" }]);
  assert.equal(f.puts[1].messages[0].details.wake_epoch, 4); assert.equal(f.puts[0].wake, true);
  assert.equal(f.puts.every(mail => mail.recovered === true), true);
  assert.equal(f.session.getBranch().filter(entry => entry.type === "custom_message").length, 2);
});
test("settled legacy import uses original carrier/successful assistant with no new native body", async t => {
  const f = await fixture(t, true); await f.run(); await f.run();
  assert.equal(f.puts.length, 0);
  assert.deepEqual(f.imports[0].proof, { sourceReceiptEntryId: f.cardNative, assistantEntryId: f.assistant });
  assert.equal(f.imports.length, 1, "completed import does not redo disk handoff");
  assert.equal(f.cancels.length, 1, "an already accepted redundant continuation is cancelled without needing another assistant");
  assert.equal(f.session.getBranch().filter(entry => entry.type === "custom" && entry.customType === "subagent-mailbox-import-v1").length, 1);
  assert.equal(f.session.getBranch().filter(entry => entry.type === "custom_message").length, 2);
});
test("legacy delivered without successful-run authority remains visible unknown and cannot wake", async t => {
  const f = await fixture(t, undefined); const result = await f.run();
  assert.equal(result[0]?.state, "visible-unknown"); assert.equal(f.puts.length, 0); assert.equal(f.imports.length, 0);
});
test("legacy pending Outbox reserves recovered card and future epoch ingress before reconciliation", async t => {
  const f = await fixture(t, undefined); f.outbox.wake_epoch = 0; f.outbox.state = "pending";
  await f.run(); assert.equal(f.puts.length, 0);
  assert.deepEqual(f.recoveredPrefixes, ["outbox:out:", "card:inb"]);
});

test("reopened settled cards cancel their late fallback without inventing a later assistant proof", async t => {
  const f = await fixture(t, true, true); await f.reopen();
  const result = await f.run(); await f.run();
  assert.deepEqual(result.map(item => [item.key, item.state]), [["outbox:out:4", "fulfilled"], ["outbox:out:4:continuation", "cancelled"]]);
  assert.equal(f.imports.length, 1);
  assert.equal(f.imports.every(item => item.value.key === "outbox:out:4" && item.proof.assistantEntryId === f.assistant && item.proof.sourceReceiptEntryId === f.cardNative), true);
  assert.equal(f.puts.every(mail => mail.key === "outbox:out:4:continuation" && mail.recovered === true), true);
  assert.equal(f.cancels.length, 1); assert.match(f.cancels[0].reason, /successful-run settlement/);
  assert.equal(f.session.getBranch().filter(entry => entry.type === "custom_message").length, 2);
  assert.equal(f.session.getBranch().filter(entry => entry.type === "custom" && entry.customType === "subagent-mailbox-import-v1").length, 1);
});
test("settled metadata without the card's successful assistant still holds both legacy carriers", async t => {
  const f = await fixture(t, true, true);
  f.session.branch(f.cardNative);
  f.session.appendCustomMessageEntry("subagent-continuation-v1", "Subagent results cmp are ready. Continue from the delivered completion cards.", false,
    { version: 1, outbox_id: "out", wake_epoch: 4, completion_ids: ["cmp"] });
  const result = await f.run(); await f.run();
  assert.deepEqual(result.map(item => item.state), ["visible-unknown", "visible-unknown"]);
  assert.equal(f.imports.length, 0); assert.equal(f.puts.length, 0); assert.equal(f.cancels.length, 2, "unknown scope is retried, never promoted to a completed handoff");
});


test("a failed sibling cancel retries only that handoff, preserving an already imported card", async t => {
  const f = await fixture(t, true); const cancel = f.transport.cancel.bind(f.transport); let failed = false;
  t.mock.method(f.transport, "cancel", async (key: string, reason: string) => {
    if (!failed) { failed = true; throw new Error("cancel persistence unavailable"); }
    return cancel(key, reason);
  });
  await assert.rejects(f.run(), /cancel persistence unavailable/);
  await f.run(); await f.run();
  assert.equal(f.imports.length, 1, "the completed card is not re-imported after sibling failure");
  assert.equal(f.cancels.length, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrameV1, scanJournalV1 } from "../../src/persistence/journal.ts";
import { journalFileName, checkpointDirectoryName } from "../../src/persistence/checkpoint.ts";
import { mainMailboxFixture } from "../fixtures/mailbox-ack.ts";
import { randomUUID } from "node:crypto";
import { runAgentActionV1 } from "../../src/ui/manager.ts";

async function closeSubtree(f: Awaited<ReturnType<typeof mainMailboxFixture>>) {
  const result = await f.host.closeAgent({ request_id: randomUUID(), caller: { kind: "user", main_session_id: f.binding.mainSessionId, binding_generation: f.binding.bindingGeneration, manager_generation: 1 },
    input: { target: f.host.snapshot().agents[0]!.agent.agent_id, force: false } });
  assert.equal(result.ok, true, JSON.stringify(result)); if (result.ok) assert.equal(result.value.lifecycle, "closed");
}

test("Done open idle deletion closes and drains through Host before deleting; direct open deletion is refused", { timeout: 30000 }, async t => {
  const f = await mainMailboxFixture();
  try {
    await f.success(); await f.handle(); await f.drain();
    const agentId = f.host.snapshot().agents[0]!.agent.agent_id, revision = f.host.host_revision;
    assert.equal(f.host.snapshot().agents[0]!.agent.lifecycle, "open");
    assert.ok(f.host.snapshot().agents[0]!.tasks.every(task => task.phase === "settled"));
    const direct = await f.host.deleteSettledSubtree({ agentId, expectedRevision: revision, allowUnread: true, at: new Date().toISOString() });
    assert.equal(direct.ok, false); if (!direct.ok) assert.match(direct.error.message, /every Agent to be closed/);
    assert.equal(f.host.host_revision, revision); assert.equal(f.host.snapshot().agents.length, 1);
    let resident = true, closeCalls = 0, confirmations = 0, deleted = false;
    f.host.options.runtime.residency = () => resident ? { runtimeGeneration: 0, state: "idle", executionReady: true } : undefined;
    f.host.options.runtime.closeAgent = async id => {
      closeCalls++; assert.equal(id, agentId); assert.equal(f.host.snapshot().agents[0]!.agent.lifecycle, "closing");
      // A close callback may re-enter the Host queue; deleting inside that queue before drain would deadlock.
      const read = await f.host.markCompletionsRead({ receipts: [], at: new Date().toISOString() });
      assert.equal(read.ok, true, JSON.stringify(read)); resident = false;
    };
    const remove = f.host.deleteSettledSubtree.bind(f.host), close = f.host.closeAgent.bind(f.host);
    t.mock.method(f.host, "closeAgent", async (input: Parameters<typeof close>[0]) => { assert.equal(input.input.force, false); return close(input); });
    t.mock.method(f.host, "deleteSettledSubtree", async (input: Parameters<typeof remove>[0]) => {
      assert.equal(closeCalls, 1); assert.equal(resident, false);
      assert.equal(f.host.snapshot().agents[0]!.agent.lifecycle, "closed"); assert.equal(f.inbox().ui_read_at, undefined);
      assert.equal(input.expectedRevision, f.host.host_revision); assert.ok(input.expectedRevision > revision);
      deleted = true; return remove(input);
    });
    const result = await runAgentActionV1({ ui: { confirm: async () => { confirmations++; return true; }, notify: (message: string) => assert.fail(message) } } as never, f.binding, agentId, "delete");
    assert.equal(result, "Deleted Subagent subtree."); assert.equal(confirmations, 1); assert.equal(deleted, true);
    assert.equal(f.host.snapshot().agents.length, 0); assert.equal(f.host.options.runtime.residency(agentId), undefined);
  } finally { await f.close(); }
});

test("accepted Main continuation waits at a real scheduler fixed point; one native fact settles the same epoch once", { timeout: 30000 }, async () => {
  const f = await mainMailboxFixture();
  try {
    await f.deliverCards(); f.h.setBusy(true);
    assert.deepEqual(await f.engine.settleWake(f.current().outbox_id), { state: "skipped", reason: "waiting-native" });
    await f.drain();
    const key = `outbox:${f.current().outbox_id}:${f.current().wake_epoch}:continuation`, mail = f.transport.frozen(key)!;
    assert.ok(f.transport.hasAccepted(key)); assert.equal(f.current().wake_epoch, 1);
    const before = { revision: f.host.host_revision, transactions: f.counts.transactions, offers: f.counts.offers,
      callbacks: f.counts.recorded.length, notifications: f.h.notices.length, sends: f.h.sends.length };
    for (let i = 0; i < 100; i++) {
      await f.transport.put(mail); await f.reconcile(); await f.slot().reconcileProofs();
    }
    await f.drain();
    assert.deepEqual({ revision: f.host.host_revision, transactions: f.counts.transactions, offers: f.counts.offers,
      callbacks: f.counts.recorded.length, notifications: f.h.notices.length, sends: f.h.sends.length }, before);
    const body = mail.messages[0]!;
    const entryId = f.h.manager.appendCustomMessageEntry(body.customType, body.content, body.display, body.details);
    await f.transport.put(mail); await f.drain();
    assert.deepEqual(f.current().continuation_native?.entry_id, entryId);
    assert.equal(f.counts.recorded.length, before.callbacks + 1);
    await f.reconcile(); await f.drain();
    assert.equal(f.current().state, "delivered"); assert.equal(f.current().wake_epoch, 1);
    assert.equal(f.current().turn_settlement?.continuation_identity, entryId);
    assert.equal(f.current().continuation_native, undefined, "the persisted Wake receipt takes over the acknowledged observation");
    assert.equal(f.counts.offers, before.offers, "acceptance/native recovery never re-offers");
    const settled = f.counts.transactions; await f.reconcile(); await f.drain(); assert.equal(f.counts.transactions, settled);
    assert.equal(f.h.sends.filter(send => send.options.triggerTurn).length, 0);
  } finally { await f.close(); }
});

test("durable Main success handles an accepted continuation without appending or requesting it", { timeout: 30000 }, async t => {
  const f = await mainMailboxFixture();
  try {
    await f.deliverCards(); f.h.setBusy(true);
    await f.engine.settleWake(f.current().outbox_id); await f.drain();
    await f.success(); await f.handle(); await f.drain();
    assert.equal(f.current().state, "handled"); assert.equal(f.current().wake_epoch, 1);
    assert.equal(f.current().turn_settlement, undefined); assert.equal(f.current().settlement_proof_id, undefined);
    assert.equal(f.slot().snapshot.pending.length, 0); assert.equal(f.slot().snapshot.terminal.length, 0);
    assert.equal(f.h.manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1").length, 0);
    assert.equal(f.h.sends.filter(send => send.options.triggerTurn).length, 0);
    let handoffs = 0;
    const importFulfilled = f.transport.importFulfilled.bind(f.transport), cancel = f.transport.cancel.bind(f.transport);
    t.mock.method(f.transport, "importFulfilled", async (...args: Parameters<typeof importFulfilled>) => { handoffs++; return importFulfilled(...args); });
    t.mock.method(f.transport, "cancel", async (...args: Parameters<typeof cancel>) => { handoffs++; return cancel(...args); });
    const stable = { transactions: f.counts.transactions, recorded: f.counts.recorded.length, terminal: f.counts.terminal.length, notices: f.h.notices.length };
    for (let i = 0; i < 100; i++) { await f.handle(); await f.reconcile(); }
    await f.drain();
    assert.deepEqual({ transactions: f.counts.transactions, recorded: f.counts.recorded.length, terminal: f.counts.terminal.length, notices: f.h.notices.length }, stable);
    assert.equal(handoffs, 0, "completed history no longer calls A import/cancel (and their disk scans)");
    await f.h.emit("session_tree"); // A's branch fence changes even in the same source binding.
    await f.handle(); await f.drain(); assert.equal(handoffs, 0, "a new scope revalidates A receipts without repeating the handoff");
    const recovered = handoffs; await f.handle(); await f.drain(); assert.equal(handoffs, recovered);
  } finally { await f.close(); }
});


test("handled deletion waits for related Mailbox cleanup, then succeeds without another business transition", async () => {
  const f = await mainMailboxFixture();
  try {
    await f.deliverCards(); f.h.setBusy(true); await f.engine.settleWake(f.current().outbox_id); await f.drain();
    await f.success();
    assert.equal(await f.turn.settleHandled({ host: f.host, mainSessionId: f.binding.mainSessionId, outboxId: f.current().outbox_id,
      branch: () => f.h.manager.getBranch(), at: new Date().toISOString() }), true);
    await closeSubtree(f);
    const agentId = f.host.snapshot().agents[0]!.agent.agent_id;
    const remove = () => f.host.deleteSettledSubtree({ agentId, expectedRevision: f.host.host_revision, allowUnread: true, at: new Date().toISOString() });
    const blocked = await remove(); assert.equal(blocked.ok, false); if (!blocked.ok) assert.match(blocked.error.message, /还有投递在收尾，稍后再删/);
    await f.handle(); await f.drain();
    const deleted = await remove(); assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(f.host.snapshot().agents.length, 0);
  } finally { await f.close(); }
});


test("legacy epoch-zero handled cards acquire an import receipt without native send, epoch or fallback", async () => {
  const f = await mainMailboxFixture();
  try {
    await f.success(); await f.handle(); await f.drain();
    assert.equal(f.current().state, "handled"); assert.equal(f.current().wake_epoch, 0);
    assert.equal(f.h.sends.length, 0); assert.equal(f.counts.offers, 0);
    assert.equal(f.slot().snapshot.pending.length, 0); assert.equal(f.slot().snapshot.terminal.length, 0);
    assert.ok(f.transport.frozen(`card:${f.inbox().inbox_id}`));
    assert.equal(f.transport.frozen(`outbox:${f.current().outbox_id}:0:continuation`), undefined);
    await closeSubtree(f);
    const deleted = await f.host.deleteSettledSubtree({ agentId: f.host.snapshot().agents[0]!.agent.agent_id,
      expectedRevision: f.host.host_revision, allowUnread: true, at: new Date().toISOString() });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
  } finally { await f.close(); }
});

for (const reopen of [false, true]) test(`delivered success/read/checkpoint retains source material until A finishes${reopen ? " across an old-format upgrade" : ""}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-retention-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let f = await mainMailboxFixture({ directory });
  try {
    await f.deliverCards(); f.h.setBusy(true); await f.engine.settleWake(f.current().outbox_id); await f.drain();
    const key = `outbox:${f.current().outbox_id}:${f.current().wake_epoch}:continuation`, mail = f.transport.frozen(key)!, body = mail.messages[0]!;
    f.h.manager.appendCustomMessageEntry(body.customType, body.content, body.display, body.details);
    await f.transport.put(mail); await f.drain(); await f.reconcile(); await f.drain();
    assert.equal(f.current().state, "delivered");
    await f.success(); await f.turn.settle({ host: f.host, mainSessionId: f.binding.mainSessionId, branch: f.h.manager.getBranch(), at: new Date().toISOString() });
    const inbox = f.inbox();
    const read = await f.host.markCompletionsRead({ receipts: [{ inbox_id: inbox.inbox_id, completion_id: inbox.completion_id,
      projection_sha256: inbox.projection.projection_sha256, entry_id: inbox.model_entry_id! }], at: new Date().toISOString() });
    assert.equal(read.ok, true); assert.equal(f.current().turn_settlement?.state, "settled");
    assert.equal(f.slot().snapshot.pending.length, 3, "A still owns card/outbox/continuation before import");
    await f.store.checkpoint(); assert.equal(f.host.snapshot().root.inbox.length, 1);
    if (reopen) {
      const paths = f.store.paths, pointer = JSON.parse(await readFile(paths.currentFile, "utf8"));
      const manifest = JSON.parse(await readFile(join(paths.checkpoints, checkpointDirectoryName(pointer.checkpoint_generation), "manifest.json"), "utf8"));
      const journal = join(paths.journals, journalFileName(pointer.journal_generation));
      const scan = scanJournalV1(await readFile(journal), manifest.last_journal_sequence, manifest.host_revision);
      assert.equal(scan.status, "valid"); if (scan.status !== "valid") throw new Error("invalid fixture journal");
      assert.equal(scan.frames.length, 1); // The checkpoint contains only old-schema delivered state.
      await f.close();
      await writeFile(journal, encodeFrameV1(scan.frames[0]!.sequence, { ...scan.anchor, version: 2 }));
      f = await mainMailboxFixture({ directory, recover: true, beforeReady: async binding => {
        assert.equal(binding.host.snapshot().root.inbox.length, 1, "the mandatory upgrade checkpoint runs before import and must retain its material");
        const next = JSON.parse(await readFile(paths.currentFile, "utf8"));
        assert.ok(next.checkpoint_generation > pointer.checkpoint_generation);
      } });
    } else await f.handle();
    await f.drain();
    assert.equal(f.slot().snapshot.pending.length, 0); assert.equal(f.slot().snapshot.terminal.length, 0);
    assert.equal(f.current().state, "delivered"); assert.equal(f.current().wake_epoch, 1);
    await closeSubtree(f);
    const deleted = await f.host.deleteSettledSubtree({ agentId: f.host.snapshot().agents[0]!.agent.agent_id,
      expectedRevision: f.host.host_revision, allowUnread: true, at: new Date().toISOString() });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
  } finally { await f.close(); }
});

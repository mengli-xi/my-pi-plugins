import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mainMailboxFixture } from "../fixtures/mailbox-ack.ts";
import { historyRow, historyEntries, commitHistory } from "../fixtures/retired-main-history.ts";
import { readMainMailboxRetirement } from "../../src/mailbox/retirement-main.ts";
import { validateNormalizedStoreStateV1 } from "../../src/persistence/invariants.ts";
import { SubagentProcessServiceV1 } from "../../src/host/process-service.ts";

async function markRead(f: Awaited<ReturnType<typeof mainMailboxFixture>>) {
  const result = await f.host.markCompletionsRead({ receipts: f.host.snapshot().root.inbox.map(inbox => ({ inbox_id: inbox.inbox_id,
    completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, entry_id: inbox.model_entry_id! })), at: new Date().toISOString() });
  assert.equal(result.ok, true, JSON.stringify(result));
}

test("many read Main cards retire after real A ACK/GC and cold reopen uses their exact receipts", { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-retired-history-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let f = await mainMailboxFixture({ directory });
  try {
    await f.success(); await f.handle(); await f.drain(); await markRead(f);
    const rows = Array.from({ length: 16 }, (_, index) => historyRow(f.host.snapshot(), index + 2, 8192));
    await commitHistory(f.store, rows);
    const file = f.h.manager.getSessionFile()!, parentId = f.h.manager.getLeafId();
    await f.close();
    await appendFile(file, historyEntries(rows, parentId, false).map(entry => JSON.stringify(entry)).join("\n") + "\n");
    // These cards have no A admission yet. The real cold importer performs
    // their normal epoch-zero import and original recorded/terminal callbacks.
    f = await mainMailboxFixture({ directory, recover: true }); await f.drain();
    assert.equal(f.h.sends.length, 0); assert.equal(f.host.snapshot().root.inbox.length, 17);
    const facts = await readMainMailboxRetirement(f.store.mainMailboxReadContext, true);
    assert.equal(facts.retiredOutboxes(f.host.snapshot()).size, 17);
    await f.store.checkpoint(); assert.equal(f.host.snapshot().root.inbox.length, 0);
    validateNormalizedStoreStateV1(f.host.snapshot());
    await f.close(); f = await mainMailboxFixture({ directory, recover: true }); await f.drain();
    assert.equal(f.host.snapshot().root.inbox.length, 0); assert.equal(f.h.sends.length, 0);
    const marker = [...f.h.manager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === "subagent-mailbox-import-v1");
    assert.ok(marker && marker.type === "custom");
    assert.equal((marker.data as { items: { state: string }[] }).items.some(item => item.state === "visible-unknown"), false);
  } finally { await f.close(); }
});

test("checkpoint retains read cards through terminal ACK and any shared-carrier obligation", { timeout: 30000 }, async () => {
  const f = await mainMailboxFixture(); let release!: () => void;
  try {
    await f.success();
    const callbacks = f.slot().registrations[0].callbacks, terminal = callbacks.onTerminal;
    const held = new Promise<void>(resolve => { release = resolve; });
    callbacks.onTerminal = async (...args: any[]) => { await held; return terminal(...args); };
    await f.handle(); await markRead(f);
    let facts = await readMainMailboxRetirement(f.store.mainMailboxReadContext, true);
    assert.equal(facts.outbox(f.host.snapshot(), f.current()).kind, "handed-off");
    await f.store.checkpoint(); assert.equal(f.host.snapshot().root.inbox.length, 1, "onTerminal starting/returning is not A ACK/GC");
    release(); await f.drain();
    const body = f.message();
    const shared = f.h.producer("pi-processes", { checkCurrent: () => ({ kind: "hold", reason: "shared source still owns work" }) });
    await f.h.emit("session_start", { reason: "startup" });
    await shared.endpoint.put(f.h.mail("pi-processes", "shared-card-retirement", { wake: false, messages: [body] }));
    facts = await readMainMailboxRetirement(f.store.mainMailboxReadContext, true);
    assert.equal(facts.outbox(f.host.snapshot(), f.current()).kind, "handoff-needed");
    await f.store.checkpoint(); assert.equal(f.host.snapshot().root.inbox.length, 1, "an unrelated key sharing this native carrier still keeps its material");
    await shared.endpoint.cancel("shared-card-retirement", "shared source ended"); await f.drain();
    await f.store.checkpoint(); assert.equal(f.host.snapshot().root.inbox.length, 0);
  } finally { release?.(); await f.close(); }
});

test("foreign shared-carrier terminal does not block an epoch-zero card's first handoff or repeat it", { timeout: 30000 }, async t => {
  const f = await mainMailboxFixture(); let release!: () => void;
  try {
    await f.success();
    await f.turn.settleHandled({ host: f.host, mainSessionId: f.binding.mainSessionId, outboxId: f.current().outbox_id,
      branch: () => f.h.manager.getBranch(), at: new Date().toISOString() });
    assert.equal(f.current().state, "handled"); assert.equal(f.current().wake_epoch, 0);
    const cardKey = `card:${f.inbox().inbox_id}`;
    assert.equal(f.transport.frozen(cardKey), undefined);
    const held = new Promise<void>(resolve => { release = resolve; });
    const foreign = f.h.producer("pi-processes", { onTerminal: async () => { await held; } });
    await f.h.emit("session_start", { reason: "startup" });
    const branch = f.h.manager.getBranch();
    const assistant = branch.find(entry => entry.type === "message" && entry.message.role === "assistant")!;
    const marker = branch.find(entry => entry.type === "custom" && entry.customType === "subagent-main-run-completed-v1")!;
    await foreign.endpoint.importFulfilled(f.h.mail("pi-processes", "foreign-only-card", { anchorEntryId: null, wake: false, messages: [f.message()] }),
      { sourceReceiptEntryId: marker.id, assistantEntryId: assistant.id });
    const facts = await readMainMailboxRetirement(f.store.mainMailboxReadContext, true);
    assert.equal(facts.outbox(f.host.snapshot(), f.current()).kind, "handed-off");
    let imports = 0;
    const imported = f.transport.importFulfilled.bind(f.transport);
    t.mock.method(f.transport, "importFulfilled", async (...args: Parameters<typeof imported>) => { imports++; return imported(...args); });
    const diagnostics: unknown[] = [];
    // Run the production driver and its guards; only collect its diagnostics.
    const reconcile = () => SubagentProcessServiceV1.prototype["reconcileMainMail"].call({ report: (...args: unknown[]) => diagnostics.push(args) } as never, f.binding);
    await reconcile();
    assert.equal(imports, 1, "another producer's terminal cannot skip D's first admission");
    assert.equal(f.transport.hasAccepted(cardKey), true);
    for (let pass = 0; pass < 5; pass++) await reconcile();
    await f.handle();
    assert.equal(imports, 1, "per-key handoff facts prevent repeats while the foreign ACK is held");
    release(); await f.drain(); await reconcile();
    assert.equal(imports, 1); assert.equal(f.h.sends.length, 0); assert.equal(f.counts.offers, 0);
    assert.deepEqual(diagnostics, []);
  } finally { release?.(); await f.close(); }
});

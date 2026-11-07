import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { appendFile, open, readFile, truncate, writeFile, type FileHandle } from "node:fs/promises";
import { MAILBOX_HOLDER_KEY, filterMailboxMessages } from "../src/mailbox-v1/light.js";
import { readDiskSession, releaseDiskSession, terminalIndex } from "../src/mailbox-v1/proof.js";
import { readVersionedText } from "../src/mailbox-v1/read-version.js";
import { snapshotPath } from "../src/mailbox-v1/paths.js";
import { harness, recoveredPending, tick, until } from "./mailbox-harness.js";

const slot = (h: Awaited<ReturnType<typeof harness>>) => [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()].find((s: any) => s.sessionManager === h.manager) as any;
// Hook the real FileHandle read, only for this session inode. Append after bytes
// were read but before the reader's post-read stat: no timing/sleep assumptions.
async function appending(t: TestContext, path: string, once = false) {
  const handle = await open(path, "r"), version = await handle.stat({ bigint: true });
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const original = prototype.readFile;
  let reads = 0;
  const mock = t.mock.method(prototype, "readFile", (async function(this: FileHandle, ...args: Parameters<FileHandle["readFile"]>) {
    const text = await original.apply(this, args), current = await this.stat({ bigint: true });
    if (current.dev === version.dev && current.ino === version.ino) {
      reads++;
      if (!once || reads === 1) await appendFile(path, "\n");
    }
    return text;
  }) as FileHandle["readFile"]);
  return { reads: () => reads, restore: () => mock.mock.restore() };
}

test("append during read discards that read, coalesces retry and caches only stable parsed bytes", async t => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const identity = { id: h.manager.getSessionId(), file: h.manager.getSessionFile()! };
    const race = await appending(t, identity.file, true);
    const [first, joined] = await Promise.all([readDiskSession(identity), readDiskSession(identity)]);
    assert.equal(first, joined); assert.ok(first);
    assert.equal(race.reads(), 2, "the append invalidated the first actual read");
    assert.equal(await readDiskSession(identity), first);
    assert.equal(race.reads(), 2, "unchanged version reuses parsed history");
    releaseDiskSession(identity);
  } finally { await h.cleanup(); }
});

test("initial ready contention holds callbacks and recovers at a real boundary without poisoning the writer", async t => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    await recoveredPending(h.agentDir, h.manager, [h.mail("pi-processes", "cold-race", { wake: false })]);
    const path = snapshotPath(h.agentDir, h.manager.getSessionId());
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    snapshot.pending[0].requiredCallbacks.recorded = true;
    await writeFile(path, JSON.stringify(snapshot));
    let callbacks = 0;
    h.producer("pi-processes", { onRecorded: () => { callbacks++; } });
    const race = await appending(t, h.manager.getSessionFile()!);
    await h.emit("session_start", { reason: "startup" });
    await until(() => race.reads() === 6 && h.notices.some(notice => notice.includes("file changed while reading")), "initial scheduled reconciliation exhausted its bound");
    assert.ok(slot(h).rebuildError); assert.equal(slot(h).snapshot.suspended, null);
    assert.equal(callbacks, 0); assert.equal(h.sends.length, 0);
    assert.equal(JSON.parse(await readFile(snapshotPath(h.agentDir, h.manager.getSessionId()), "utf8")).suspended, null);
    const reads = race.reads(); await tick(); await tick();
    assert.equal(race.reads(), reads, "no self-rescheduling read retry");
    race.restore();
    await h.startUser(); await h.context();
    await until(() => callbacks === 1);
    assert.equal(slot(h).rebuildError, null); assert.equal(slot(h).snapshot.suspended, null);
    assert.equal(h.sends.filter(send => !send.options.triggerTurn).length, 1);
  } finally { await h.cleanup(); }
});

test("scheduled live delivery under continuous append sends nothing, then compaction recovers one completion", async t => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    await h.emit("session_before_compact");
    const mail = h.mail("pi-processes", "live-race"); await p.endpoint.put(mail);
    releaseDiskSession(slot(h).session);
    const race = await appending(t, h.manager.getSessionFile()!);
    await h.emit("session_compact");
    await until(() => !!slot(h).rebuildError && h.notices.some(notice => notice.includes("file changed while reading")));
    assert.equal(race.reads(), 3); assert.equal(h.sends.length, 0);
    assert.equal(slot(h).snapshot.suspended, null);
    assert.equal(slot(h).snapshot.pending[0].nativeEntries.length, 0);
    const reads = race.reads(); await tick(); await tick();
    assert.equal(race.reads(), reads);
    race.restore();
    await h.emit("session_compact");
    await until(() => h.sends.some(send => send.options.triggerTurn));
    const control = h.sends.find(send => send.options.triggerTurn)!.message;
    h.setBusy(true);
    await h.emit("before_agent_start", { messageType: "custom", message: control, systemPrompt: "", systemPromptOptions: {} });
    assert.ok((await h.context()).some((message: any) => message.content === mail.messages[0]!.content));
    await h.finish();
    assert.equal((await p.endpoint.put(mail)).kind, "terminal");
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 1);
    assert.equal(h.sends.filter(send => !send.options.triggerTurn).length, 1);
    assert.equal(slot(h).snapshot.suspended, null);
  } finally { await h.cleanup(); }
});

test("projection contention aborts empty, never persists suspension, and later compaction boundary recovers", async t => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const controller = new AbortController(); let aborts = 0;
    (h.ctx as any).signal = controller.signal;
    h.ctx.abort = () => { aborts++; controller.abort(); };
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-processes", "projection-race", { wake: false });
    await p.endpoint.put(mail); await until(() => !!slot(h).snapshot.pending[0]?.recorded);
    await h.startUser();
    releaseDiskSession(slot(h).session);
    const sends = h.sends.length, race = await appending(t, h.manager.getSessionFile()!);
    const projected = await h.emit("context", { messages: h.messages() });
    assert.equal(aborts, 1); assert.deepEqual(projected.event.messages, []);
    assert.equal(race.reads(), 3); assert.equal(h.sends.length, sends);
    assert.equal(slot(h).snapshot.suspended, null);
    await assert.rejects(filterMailboxMessages(h.ctx, h.messages(), { agentDir: h.agentDir }), { code: "read-race" });
    await h.emit("agent_end", { messages: h.messages() });
    await h.emit("agent_settled", { aborted: true });
    assert.equal(slot(h).snapshot.suspended, null);
    const reads = race.reads(); await tick(); await tick();
    assert.equal(race.reads(), reads, "persistent contention reaches a fixed point");
    race.restore();
    await h.emit("session_compact");
    await until(() => slot(h).rebuildError === null);
    (h.ctx as any).signal = new AbortController().signal;
    await h.startUser();
    assert.ok((await h.context()).some((message: any) => message.content === mail.messages[0]!.content));
    assert.equal(slot(h).snapshot.suspended, null);
    assert.equal(h.sends.length, sends, "no duplicate native submission");
  } finally { await h.cleanup(); }
});

for (const contention of [false, true]) test(`user abort remains suspended${contention ? " when a read race is also observed" : ""}`, async t => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const controller = new AbortController();
    (h.ctx as any).signal = controller.signal;
    h.ctx.abort = () => controller.abort();
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    await p.endpoint.put(h.mail("pi-processes", "user-abort", { wake: false }));
    await until(() => !!slot(h).snapshot.pending[0]?.recorded);
    await h.startUser(); controller.abort();
    const race = contention ? await appending(t, h.manager.getSessionFile()!) : null;
    if (race) {
      releaseDiskSession(slot(h).session);
      assert.deepEqual((await h.emit("context", { messages: h.messages() })).event.messages, []);
      assert.equal(slot(h).run.projectionReadRace, false);
      race.restore();
    }
    await h.emit("agent_end", { messages: h.messages() });
    await h.emit("agent_settled", { aborted: true });
    assert.equal(slot(h).snapshot.suspended.reason, "aborted");
  } finally { await h.cleanup(); }
});

test("a producer proof read race holds its carrier without permanent suspension or unstable delivery", async t => {
  const h = await harness({ persist: true });
  try {
    await h.finish(); let racing = true;
    const identity = { id: h.manager.getSessionId(), file: h.manager.getSessionFile()! };
    const p = h.producer("pi-scheduler", { proveNative: async () => {
      if (racing) await readDiskSession(identity);
      return { kind: "observed", entries: [] };
    } });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("session_before_compact"); // hold native scheduling, not the proof operation under test
    const mail = h.mail("pi-scheduler", "callback-race", { wake: false });
    await p.endpoint.put(mail);
    const race = await appending(t, identity.file);
    await assert.rejects(slot(h).prove(slot(h).snapshot.pending[0], slot(h).registration(mail.producer)), { code: "read-race" });
    assert.equal(race.reads(), 3);
    assert.equal(h.sends.length, 0); assert.equal(slot(h).snapshot.suspended, null);
    assert.equal(slot(h).proofErrors.size, 1);
    race.restore(); racing = false;
    await h.emit("session_compact");
    await until(() => h.sends.filter(send => !send.options.triggerTurn).length === 1);
    releaseDiskSession(identity);
  } finally { await h.cleanup(); }
});

test("in-read truncation is not retried as an append race", async t => {
  const h = await harness({ persist: true });
  try {
    await h.finish(); const path = h.manager.getSessionFile()!;
    const handle = await open(path, "r"), prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close(); const original = prototype.readFile; let reads = 0;
    t.mock.method(prototype, "readFile", (async function(this: FileHandle, ...args: Parameters<FileHandle["readFile"]>) {
      const text = await original.apply(this, args); reads++; await truncate(path, 0); return text;
    }) as FileHandle["readFile"]);
    await assert.rejects(readVersionedText(path), { code: "unverifiable-proof" });
    assert.equal(reads, 1);
  } finally { await h.cleanup(); }
});

test("stable malformed JSON and genuine receipt proof damage stay rejected, not recoverable contention", async () => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-processes", "damaged-proof", { wake: false });
    await p.endpoint.put(mail); await until(() => !!slot(h).snapshot.pending[0]?.recorded);
    await h.startUser(); await h.context(); await h.finish();
    const path = h.manager.getSessionFile()!, original = await readFile(path, "utf8");
    const rows = original.trim().split("\n").map(line => JSON.parse(line));
    const receipt = rows.find(row => row.type === "custom" && row.customType === "agent-mailbox-delivery-v1");
    assert.ok(receipt);
    receipt.data.terminals[0].evidence.assistantEntryId = "not-the-authorized-assistant";
    await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    await assert.rejects(async () => terminalIndex(await readDiskSession(slot(h).session), h.manager.getSessionId()), { code: "unverifiable-proof" });
    await writeFile(path, "{bad json\n");
    await assert.rejects(readDiskSession(slot(h).session), SyntaxError);
    h.ctx.abort = () => {};
    assert.deepEqual((await h.emit("context", { messages: h.messages() })).event.messages, []);
    assert.equal(slot(h).snapshot.suspended.reason, "blocked");
    await writeFile(path, original);
  } finally { await h.cleanup(); }
});

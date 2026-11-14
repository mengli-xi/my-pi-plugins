import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MAILBOX_HOLDER_KEY } from "../src/mailbox-v1/light.js";
import { readDiskSession, releaseDiskSession, terminalIndex } from "../src/mailbox-v1/proof.js";
import { clearMailboxes, harness, until } from "./mailbox-harness.js";
import { sharedCarrierFixture } from "./fixtures/shared-carrier.js";

function slot(h: Awaited<ReturnType<typeof harness>>) {
  return [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()].find((value: any) => value.sessionManager === h.manager);
}

test("append reuse spans empty, pending, cancelled receipt GC, and new pending projection", async () => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    let allowed = true, checks = 0;
    const p = h.producer("pi-processes", { checkCurrent: () => {
      checks++;
      return allowed ? { kind: "allow", project: true, wake: false } : { kind: "hold", reason: "source changed" };
    } });
    await h.emit("session_start", { reason: "startup" });
    await h.context();
    const identity = slot(h).session, first = (await readDiskSession(identity))!;
    const cancelled = h.mail("pi-processes", "cancel-append", { wake: false });
    await p.endpoint.put(cancelled);
    await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    assert.ok((await h.context()).some((message: any) => message.content === cancelled.messages[0]!.content));
    await p.endpoint.cancel(cancelled.key, "retired");
    await until(() => slot(h).snapshot.terminal.length === 0);
    h.manager.appendCustomEntry("fixture", { text: "append after receipt GC" });
    assert.ok(!(await h.context()).some((message: any) => message.content === cancelled.messages[0]!.content));
    const next = h.mail("pi-processes", "next-append", { wake: false });
    await p.endpoint.put(next);
    await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    allowed = false;
    const before = checks;
    assert.ok(!(await h.context()).some((message: any) => message.content === next.messages[0]!.content));
    assert.ok(checks > before, "parsed history is not cached producer authority");
    allowed = true;
    assert.ok((await h.context()).some((message: any) => message.content === next.messages[0]!.content));
    const incremental = (await readDiskSession(identity))!;
    assert.equal(incremental.entries[0], first.entries[0]);
    const fresh = { ...identity };
    try {
      const full = await readDiskSession(fresh);
      assert.deepEqual(incremental, full);
      assert.deepEqual(terminalIndex(incremental, identity.id), terminalIndex(full, identity.id));
    } finally { releaseDiskSession(fresh); }
  } finally { await h.cleanup(); }
});

for (const gc of [false, true]) test(`cancelled native body is excluded ${gc ? "after receipt-backed GC" : "while terminal ACK is pending"}`, async () => {
  const h = await harness({ persist: true });
  let release!: () => void;
  const ack = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.finish();
    const p = h.producer("pi-subagents", { onTerminal: () => gc ? undefined : ack });
    await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-subagents", "cancel-before-wake", { wake: false });
    await p.endpoint.put(mail);
    await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 0);
    await p.endpoint.cancel(mail.key, "child generation ended");
    if (gc) await until(() => slot(h).snapshot.terminal.length === 0);
    else assert.equal(slot(h).snapshot.terminal[0].terminalAck, "pending");
    await h.startUser();
    const projected = await h.context();
    assert.ok(!projected.some((message: any) => message.content === mail.messages[0]!.content));
    assert.ok(h.messages().some(message => message.content === mail.messages[0]!.content), "native history remains intact");
    await h.finish();
    if (gc) assert.equal(terminalIndex(await readDiskSession(slot(h).session), slot(h).session.id).get(JSON.stringify([mail.producer, mail.key]))!.evidence.outcome, "cancelled");
  } finally { release(); await h.cleanup(); }
});

test("fulfilled native history remains visible after receipt-backed GC", async () => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-processes", "fulfilled-history", { wake: false });
    await p.endpoint.put(mail); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    await h.startUser(); await h.context(); await h.finish();
    await until(() => slot(h).snapshot.pending.length === 0 && slot(h).snapshot.terminal.length === 0);
    assert.equal((await p.endpoint.put(mail)).kind, "terminal");
    await h.startUser();
    assert.ok((await h.context()).some((message: any) => message.content === mail.messages[0]!.content));
    await h.finish();
  } finally { await h.cleanup(); }
});

test("a fork's copied parent cancellation receipt does not suppress the new scope's body", async () => {
  const h = await harness({ persist: true });
  let child: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await h.finish();
    const p = h.producer("pi-scheduler"); await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-scheduler", "parent-cancelled", { wake: false });
    await p.endpoint.put(mail); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    await p.endpoint.cancel(mail.key, "parent cancelled"); await until(() => slot(h).snapshot.terminal.length === 0);
    const manager = SessionManager.forkFrom(h.manager.getSessionFile()!, h.cwd, join(h.directory, "fork-sessions"));
    assert.notEqual(manager.getSessionId(), h.manager.getSessionId());
    child = await harness({ directory: h.directory, manager });
    child.producer("pi-scheduler"); await child.emit("session_start", { reason: "fork" });
    await child.startUser();
    assert.ok((await child.context()).some((message: any) => message.content === mail.messages[0]!.content));
    await child.finish();
    await h.startUser();
    assert.ok(!(await h.context()).some((message: any) => message.content === mail.messages[0]!.content));
    await h.finish();
  } finally { await child?.cleanup(); await h.cleanup(); }
});

test("cancel during an asynchronous projection guard removes a previously appended body", async () => {
  const h = await harness({ persist: true });
  let waiting = false, block = false, release!: () => void;
  const guard = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.finish();
    const p = h.producer("pi-processes", { checkCurrent: async mail => {
      if (block && mail.key === "guard-barrier") { waiting = true; await guard; }
      return { kind: "allow", project: true, wake: false };
    } });
    await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-processes", "cancel-in-projection", { wake: false });
    await p.endpoint.put(mail); await p.endpoint.put(h.mail("pi-processes", "guard-barrier", { wake: false }));
    await until(() => slot(h).snapshot.pending.every((record: any) => record.nativeEntries.length === 1));
    await h.startUser(); block = true;
    const projection = h.context(); await until(() => waiting);
    await p.endpoint.cancel(mail.key, "cancel while guard awaits");
    release();
    assert.ok(!(await projection).some((message: any) => message.content === mail.messages[0]!.content));
    await h.finish();
  } finally { release(); await h.cleanup(); }
});

for (const format of ["generic", "main", "child"] as const) for (const fulfilled of [0, 1])
  test(`${format} shared carrier: key ${fulfilled} fulfilled survives the other key cancelled and GC'd`, async () => {
    const h = await harness({ persist: true });
    try {
      await h.finish();
      const fixture = sharedCarrierFixture(format), p = h.producer(fixture.producer);
      await h.emit("session_start", { reason: "startup" });
      const kept = h.mail(fixture.producer, fixture.keys[fulfilled]!, { wake: false, messages: fixture.messages });
      await p.endpoint.put(kept); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
      await h.startUser(); await h.context(); await h.finish();
      await until(() => slot(h).snapshot.pending.length === 0 && slot(h).snapshot.terminal.length === 0);
      const discarded = h.mail(fixture.producer, fixture.keys[1 - fulfilled]!, { wake: false, messages: fixture.messages });
      await p.endpoint.put(discarded); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
      await p.endpoint.cancel(discarded.key, "other reference cancelled"); await until(() => slot(h).snapshot.terminal.length === 0);
      assert.equal(h.messages().filter(message => message.content === fixture.messages[0]!.content).length, 1);
      await h.startUser();
      assert.equal((await h.context()).filter((message: any) => message.content === fixture.messages[0]!.content).length, 1);
      await h.finish();
    } finally { await h.cleanup(); }
  });

test("a shared carrier remains visible with a pending key, and is hidden only after every key is cancelled", async () => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const fixture = sharedCarrierFixture("main"), p = h.producer(fixture.producer);
    await h.emit("session_start", { reason: "startup" });
    const mails = fixture.keys.map(key => h.mail(fixture.producer, key, { wake: false, messages: fixture.messages }));
    for (const mail of mails) { await p.endpoint.put(mail); await until(() => slot(h).snapshot.pending.find((record: any) => record.key === mail.key)?.nativeEntries.length === 1); }
    await p.endpoint.cancel(mails[0]!.key, "card cancelled"); await until(() => slot(h).snapshot.terminal.length === 0);
    // Project without a successful assistant, so the surviving key stays pending.
    assert.equal((await h.context()).filter((message: any) => message.content === fixture.messages[0]!.content).length, 1);
    await p.endpoint.cancel(mails[1]!.key, "outbox cancelled"); await until(() => slot(h).snapshot.terminal.length === 0);
    assert.equal((await h.context()).filter((message: any) => message.content === fixture.messages[0]!.content).length, 0);
    assert.equal(h.messages().filter(message => message.content === fixture.messages[0]!.content).length, 1);
  } finally { await h.cleanup(); }
});

for (const fulfilled of [false, true]) test(`a shared recovery-held key ${fulfilled ? "does not hide fulfilled history" : "stays held despite a cancelled reference"}`, async () => {
  const h = await harness({ persist: true });
  let reader: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await h.finish();
    const fixture = sharedCarrierFixture("child"), p = h.producer(fixture.producer);
    await h.emit("session_start", { reason: "startup" });
    const first = h.mail(fixture.producer, fixture.keys[0], { wake: false, messages: fixture.messages });
    await p.endpoint.put(first); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    if (fulfilled) {
      await h.startUser(); await h.context(); await h.finish();
      await until(() => slot(h).snapshot.pending.length === 0 && slot(h).snapshot.terminal.length === 0);
    } else {
      await p.endpoint.cancel(first.key, "first reference cancelled"); await until(() => slot(h).snapshot.terminal.length === 0);
    }
    // A new binding represents a cold reader, including the receipt after GC.
    await h.emit("session_shutdown", { reason: "quit" }); await clearMailboxes();
    reader = await harness({ directory: h.directory, manager: SessionManager.open(h.manager.getSessionFile()!) });
    const next = reader.producer(fixture.producer); await reader.emit("session_start", { reason: "startup" });
    const held = reader.mail(fixture.producer, fixture.keys[1], { wake: false, messages: fixture.messages });
    await next.endpoint.put(held, next.endpoint.target(reader.ctx), { recovered: true });
    assert.equal(slot(reader).recoveryHeld, true);
    assert.equal((await reader.context()).filter((message: any) => message.content === fixture.messages[0]!.content).length, fulfilled ? 1 : 0);
    if (!fulfilled) {
      await reader.commands.get("mailbox")!.definition.handler("resume", reader.ctx as any);
      assert.equal((await reader.context()).filter((message: any) => message.content === fixture.messages[0]!.content).length, 1);
    }
  } finally { await reader?.cleanup(); await h.cleanup(); }
});

test("a fulfilled reference protects a shared carrier before and after its final ACK/GC", async () => {
  const h = await harness({ persist: true });
  let release!: () => void;
  const ack = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.finish();
    const fixture = sharedCarrierFixture("main");
    const p = h.producer(fixture.producer, { onTerminal: evidence => evidence.key === fixture.keys[0] ? ack : undefined });
    await h.emit("session_start", { reason: "startup" });
    const kept = h.mail(fixture.producer, fixture.keys[0], { wake: false, messages: fixture.messages });
    await p.endpoint.put(kept); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    await h.startUser(); await h.context(); await h.finish();
    assert.equal(slot(h).snapshot.terminal[0].terminalAck, "pending");
    const cancelled = h.mail(fixture.producer, fixture.keys[1], { wake: false, messages: fixture.messages });
    await p.endpoint.put(cancelled); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    await p.endpoint.cancel(cancelled.key, "outbox no longer owed");
    await until(() => slot(h).snapshot.terminal.length === 1 && slot(h).snapshot.terminal[0].mail.key === kept.key);
    assert.equal((await h.context()).filter((message: any) => message.content === fixture.messages[0]!.content).length, 1);
    release(); await until(() => slot(h).snapshot.terminal.length === 0);
    assert.equal((await h.context()).filter((message: any) => message.content === fixture.messages[0]!.content).length, 1);
  } finally { release(); await h.cleanup(); }
});

test("a cancelled multi-message outbox retains only carriers still referenced by another key", async () => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const fixture = sharedCarrierFixture("main"), p = h.producer(fixture.producer);
    await h.emit("session_start", { reason: "startup" });
    const kept = h.mail(fixture.producer, fixture.keys[0], { wake: false, messages: fixture.messages });
    await p.endpoint.put(kept); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    await h.startUser(); await h.context(); await h.finish();
    await until(() => slot(h).snapshot.pending.length === 0 && slot(h).snapshot.terminal.length === 0);
    const privateCarrier = { customType: "subagent-completion-v1", content: "CANCELLED_PRIVATE_CARD", display: true, details: { completion_id: "private" } };
    const cancelled = h.mail(fixture.producer, fixture.keys[1], { wake: false, messages: [...fixture.messages, privateCarrier] });
    await p.endpoint.put(cancelled); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 2);
    await p.endpoint.cancel(cancelled.key, "outbox cancelled"); await until(() => slot(h).snapshot.terminal.length === 0);
    const projected = await h.context();
    assert.equal(projected.filter((message: any) => message.content === fixture.messages[0]!.content).length, 1);
    assert.ok(!projected.some((message: any) => message.content === privateCarrier.content));
  } finally { await h.cleanup(); }
});

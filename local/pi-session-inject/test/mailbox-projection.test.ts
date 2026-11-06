import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { filterMailboxMessages, MAILBOX_HOLDER_KEY } from "../src/mailbox-v1/light.js";
import { clearMailboxes, harness, until } from "./mailbox-harness.js";

const slot = (h: Awaited<ReturnType<typeof harness>>) => [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()].find((s: any) => s.sessionManager === h.manager) as any;

test("readonly projection matches owner context bytes after cancellation receipt GC without callbacks or mutations", async () => {
  const h = await harness({ persist: true });
  let guards = 0;
  try {
    await h.finish();
    const p = h.producer("pi-subagents", { checkCurrent: () => { guards++; return { kind: "allow", project: true, wake: false }; } });
    await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-subagents", "cancelled", { wake: false });
    await p.endpoint.put(mail); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    await p.endpoint.cancel(mail.key, "cancel"); await until(() => slot(h).snapshot.terminal.length === 0);
    const input = h.messages(), before = JSON.stringify(slot(h).snapshot), sends = h.sends.length, calls = guards;
    const filtered = await filterMailboxMessages(h.ctx, input, { agentDir: h.agentDir });
    assert.equal(guards, calls); assert.equal(h.sends.length, sends); assert.equal(JSON.stringify(slot(h).snapshot), before);
    assert.ok(filtered.every(message => input.includes(message)));
    assert.equal(filtered.some((m: any) => m.content === mail.messages[0]!.content), false);
    assert.equal(JSON.stringify(await h.context()), JSON.stringify(filtered), "owner context and readonly projection are byte-identical");
    await h.emit("session_shutdown", { reason: "quit" }); await clearMailboxes();
    assert.equal(JSON.stringify(await filterMailboxMessages(h.ctx, input, { agentDir: h.agentDir })), JSON.stringify(filtered), "receipt-only cold reader retains cancellation authority");
  } finally { await h.cleanup(); }
});

test("readonly recovery projection never releases hold, and fulfilled/live shared carriers remain visible", async () => {
  const h = await harness({ persist: true }); let reader: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await h.finish(); const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const fulfilled = h.mail("pi-processes", "fulfilled", { wake: false });
    await p.endpoint.put(fulfilled); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    await h.startUser(); await h.context(); await h.finish();
    await until(() => slot(h).snapshot.pending.length === 0 && slot(h).snapshot.terminal.length === 0);
    const held = h.mail("pi-processes", "held", { wake: false });
    await p.endpoint.put(held); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    const live = await filterMailboxMessages(h.ctx, h.messages(), { agentDir: h.agentDir });
    assert.ok(live.some((m: any) => m.content === held.messages[0]!.content));
    await h.emit("session_shutdown", { reason: "quit" }); await clearMailboxes();
    reader = await harness({ directory: h.directory, manager: SessionManager.open(h.manager.getSessionFile()!) });
    const next = reader.producer("pi-processes"); await reader.emit("session_start", { reason: "resume" });
    const shared = reader.mail("pi-processes", "held-shared-fulfilled", { wake: false, messages: fulfilled.messages });
    await next.endpoint.put(shared, next.endpoint.target(reader.ctx), { recovered: true });
    const before = JSON.stringify(slot(reader).snapshot), sends = reader.sends.length;
    const readonly = await filterMailboxMessages(reader.ctx, reader.messages(), { agentDir: reader.agentDir });
    assert.equal(JSON.stringify(slot(reader).snapshot), before); assert.equal(reader.sends.length, sends); assert.equal(slot(reader).recoveryHeld, true);
    assert.ok(!readonly.some((m: any) => m.content === held.messages[0]!.content));
    assert.ok(readonly.some((m: any) => m.content === fulfilled.messages[0]!.content));
    assert.equal(JSON.stringify(await reader.context()), JSON.stringify(readonly));
  } finally { await reader?.cleanup(); await h.cleanup(); }
});

test("readonly projection refuses an incompatible holder, another live binding or unreadable session proof", async () => {
  const h = await harness({ persist: true });
  const key = Symbol.for(MAILBOX_HOLDER_KEY);
  try {
    h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const messages = [{ role: "custom" as const, customType: "ordinary", content: "body", display: false, timestamp: 0 }];
    const holder = (globalThis as any)[key];
    (globalThis as any)[key] = { ...holder, transportBuildId: "unknown" };
    await assert.rejects(filterMailboxMessages(h.ctx, messages, { agentDir: h.agentDir }), /ABI\/build\/method mismatch/);
    (globalThis as any)[key] = holder;
    const other = SessionManager.open(h.manager.getSessionFile()!);
    await assert.rejects(filterMailboxMessages({ ...h.ctx, sessionManager: other }, messages, { agentDir: h.agentDir }), /session identity/);
    const path = h.manager.getSessionFile()!, original = await readFile(path);
    try {
      await writeFile(path, "not JSON");
      await assert.rejects(filterMailboxMessages(h.ctx, messages, { agentDir: h.agentDir }), SyntaxError);
      await unlink(path);
      await assert.rejects(filterMailboxMessages(h.ctx, messages, { agentDir: h.agentDir }), /cannot read the original session/);
    } finally { await writeFile(path, original); }
  } finally { await h.cleanup(); }
});

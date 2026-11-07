import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { filterMailboxMessages, MAILBOX_HOLDER_KEY, type CurrentDecision } from "../src/mailbox-v1/light.js";
import { harness, until } from "./mailbox-harness.js";

const slot = (h: Awaited<ReturnType<typeof harness>>) => [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()].find((s: any) => s.sessionManager === h.manager) as any;
const denied: [string, () => CurrentDecision][] = [
  ["hold", () => ({ kind: "hold", reason: "permission removed" })],
  ["cancel", () => ({ kind: "cancel", reason: "permission removed" })],
  ["project=false", () => ({ kind: "allow", project: false, wake: false })],
  ["guard error", () => { throw new Error("guard unavailable"); }],
];
for (const [name, reject] of denied) test(`recorded carrier is excluded after ${name}, without rewriting history`, async () => {
  const h = await harness({ persist: true }); let revoked = false, calls = 0;
  try {
    await h.finish();
    const p = h.producer("pi-processes", { checkCurrent: () => { calls++; return revoked ? reject() : { kind: "allow", project: true, wake: false }; } });
    await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-processes", "authority", { wake: false });
    await p.endpoint.put(mail); await until(() => !!slot(h).snapshot.pending[0]?.recorded);
    // A real request is busy. Finish the prior idle drain before measuring
    // readonly calls; its asynchronous guard rechecks are not readonly work.
    h.setBusy(true); await until(() => !slot(h).draining);
    revoked = true;
    const projected = (await h.emit("context", { messages: h.messages() })).event.messages;
    assert.ok(!projected.some((m: any) => m.content === mail.messages[0]!.content));
    assert.ok(h.messages().some(m => m.content === mail.messages[0]!.content));
    if (name === "cancel") {
      assert.ok(!slot(h).snapshot.pending.some((r: any) => r.key === mail.key));
      await until(() => slot(h).snapshot.terminal.length === 0, "cancel receipt and GC");
    }
    const before = calls;
    const readonly = await filterMailboxMessages(h.ctx, h.messages(), { agentDir: h.agentDir });
    assert.equal(calls, before, "readonly never invokes a guard");
    assert.ok(!readonly.some((m: any) => m.content === mail.messages[0]!.content));
    assert.ok(!h.sends.some(send => send.options.triggerTurn));
  } finally { await h.cleanup(); }
});

test("a refused reference does not hide another admitted key's identical carrier", async () => {
  const h = await harness({ persist: true }); let revoked = false;
  try {
    await h.finish();
    const p = h.producer("pi-processes", { checkCurrent: mail => revoked && mail.key === "blocked"
      ? { kind: "hold", reason: "blocked" } : { kind: "allow", project: true, wake: false } });
    await h.emit("session_start", { reason: "startup" });
    const blocked = h.mail("pi-processes", "blocked", { wake: false });
    await p.endpoint.put(blocked); await until(() => !!slot(h).snapshot.pending[0]?.recorded);
    await p.endpoint.put({ ...blocked, key: "healthy" }); await until(() => slot(h).snapshot.pending.every((r: any) => !!r.recorded));
    revoked = true;
    const projected = (await h.emit("context", { messages: h.messages() })).event.messages;
    assert.equal(projected.filter((m: any) => m.content === blocked.messages[0]!.content).length, 1);
    const readonly = await filterMailboxMessages(h.ctx, h.messages(), { agentDir: h.agentDir });
    assert.equal(readonly.filter((m: any) => m.content === blocked.messages[0]!.content).length, 1);
  } finally { await h.cleanup(); }
});

test("owner projection read failure aborts and cannot return the original context", async () => {
  const h = await harness({ persist: true }); let original: Buffer | undefined, aborts = 0;
  try {
    await h.finish(); h.ctx.abort = () => { aborts++; };
    const p = h.producer("pi-processes", { checkCurrent: () => ({ kind: "allow", project: true, wake: false }) });
    await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-processes", "read-failure", { wake: false });
    await p.endpoint.put(mail); await until(() => !!slot(h).snapshot.pending[0]?.recorded);
    const path = h.manager.getSessionFile()!; original = await readFile(path);
    await writeFile(path, "not JSON");
    const result = await h.emit("context", { messages: h.messages() });
    assert.equal(aborts, 1);
    assert.deepEqual(result.event.messages, []);
    assert.ok(result.results.some(result => result?.messages?.length === 0));
    assert.ok(h.notices.length > 0);
    assert.ok(h.messages().some(m => m.content === mail.messages[0]!.content));
  } finally {
    if (original) await writeFile(h.manager.getSessionFile()!, original);
    await h.cleanup();
  }
});

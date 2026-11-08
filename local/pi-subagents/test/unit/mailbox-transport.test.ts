import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ProducerRegistration, MailboxTarget, Mail } from "pi-session-inject/mailbox-v1";
import { SubagentMailboxTransport, proveSubagentMail } from "../../src/mailbox/transport.ts";
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "subagents-mailbox-contract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = SessionManager.create(dir), puts: any[] = [], sourceEntries: any[] = [];
  let registration!: ProducerRegistration;
  const token = Symbol("source"), cancels: string[] = [], accepted = new Set<string>();
  const control: { gate?: Promise<void>; fail?: boolean } = {};
  const pi: any = { on() {}, appendEntry(type: string, data: any) { sourceEntries.push(data); session.appendCustomEntry(type, data); } };
  const transport = new SubagentMailboxTransport(pi, dir, { checkCurrent: () => ({ kind: "allow", project: true, wake: true }) },
    () => ({ close() {}, registerProducer(value) { registration = value; return { id: "pi-subagents", token, close() {}, async activateNewExecution() {},
      target(ctx): MailboxTarget { return { slotKey: ctx.sessionManager.getSessionId(), session: { id: ctx.sessionManager.getSessionId(), file: null }, bindingGeneration: 1, producerToken: token }; },
      async put(mail: Mail, target?: MailboxTarget, options?: unknown) { puts.push({ mail, target, options }); if (control.fail) { control.fail = false; throw new Error("put response lost"); } await control.gate; accepted.add(mail.key); return { kind: "accepted" as const, key: mail.key, revision: 1 }; },
      async cancel(key) { if (!accepted.has(key)) throw Object.assign(new Error("unknown"), { code: "unknown-key" }); cancels.push(key); return { producer: "pi-subagents", key, terminalId: "terminal", scope: { sessionId: session.getSessionId(), anchorEntryId: null }, outcome: "cancelled", reason: "Task ended" }; }, async importFulfilled() { throw new Error("unexpected import"); },
    }; } }));
  transport.bindContext({ sessionManager: session } as any);
  const message = { customType: "subagent-mailbox-v1", content: "hello", display: true, details: { message_id: "msg", body_sha256: "a".repeat(64), injected_into: { kind: "idle-conversation" } } };
  return { dir, session, transport, puts, sourceEntries, cancels, control, registration: () => registration, message };
}
test("put captures the original scope, freezes identity and preserves running wake on idle retry", async t => {
  const f = await fixture(t);
  await f.transport.put({ key: "mail:msg", wake: true, messages: [f.message] });
  f.session.appendCustomEntry("later", {});
  await f.transport.put({ key: "mail:msg", wake: false, messages: [f.message] });
  assert.deepEqual(f.puts[0].mail, f.puts[1].mail);
  assert.equal(f.sourceEntries.length, 1);
  assert.equal(f.puts[0].mail.wake, true);
  assert.equal(f.puts[0].target.session.id, f.session.getSessionId());
  assert.equal(f.puts[0].options, undefined);
});
test("an asynchronous old-session preparation never appends a source intent into the new session", async t => {
  const f = await fixture(t);
  const sending = f.transport.put({ key: "mail:msg", wake: false, messages: [f.message] });
  f.transport.bindContext({ sessionManager: SessionManager.create(f.dir) } as any);
  await assert.rejects(sending, /scope changed/);
  assert.equal(f.puts.length, 0); assert.equal(f.sourceEntries.length, 0);
});
test("proof reuses original native carrier and rejects body/hash/detail conflicts and duplicates", async t => {
  const f = await fixture(t);
  const accepted = await f.transport.put({ key: "mail:msg", wake: false, messages: [f.message] });
  assert.deepEqual(accepted.entries, []);
  const id = f.session.appendCustomMessageEntry(f.message.customType, f.message.content, f.message.display, f.message.details);
  assert.deepEqual(proveSubagentMail(accepted.mail, f.session.getBranch()), [{ messageIndex: 0, entryId: id }]);
  assert.throws(() => proveSubagentMail({ ...accepted.mail, messages: [{ ...f.message, content: "changed" }] }, f.session.getBranch()), /conflicts/);
  f.session.appendCustomMessageEntry(f.message.customType, f.message.content, f.message.display, f.message.details);
  assert.throws(() => proveSubagentMail(accepted.mail, f.session.getBranch()), /duplicate/);
  assert.equal((await f.registration().proveNative(accepted.mail, f.session.getBranch(), {} as any)).kind, "conflict");
});
test("source intent restores frozen origin after replacement", async t => {
  const f = await fixture(t);
  await f.transport.put({ key: "mail:msg", wake: true, messages: [f.message] });
  const original = f.puts[0].mail;
  f.transport.bindContext({ sessionManager: f.session } as any);
  f.session.appendCustomEntry("later", {});
  await f.transport.put({ key: "mail:msg", wake: false, messages: [f.message] });
  assert.deepEqual(f.puts[1].mail, original);
});
test("a granted Task rechecks its frozen intents after source ACK without creating a successor", async t => {
  const f = await fixture(t), prefix = "agent:a:task:t1:gen:1:";
  await f.transport.put({ key: prefix + "msg", wake: true, messages: [f.message] });
  await f.transport.put({ key: "agent:a:task:t2:gen:1:msg", wake: true, messages: [f.message] });
  await f.transport.recheckPrefix(prefix);
  assert.equal(f.puts.length, 3); assert.deepEqual(f.puts[2].mail, f.puts[0].mail);
  assert.equal(f.sourceEntries.length, 2); assert.equal(f.puts[2].options, undefined);
});

test("Task cancellation waits for in-flight acceptance and touches only the original Task keys", async t => {
  const f = await fixture(t), first = "agent:a:task:t1:gen:1:", next = "agent:a:task:t2:gen:1:";
  let release!: () => void;
  f.control.gate = new Promise<void>(resolve => { release = resolve; });
  const sending = f.transport.put({ key: first + "msg", wake: true, messages: [f.message] });
  const cancelling = f.transport.cancelPrefix(first, "Task final");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.cancels, []);
  release(); await sending; await cancelling;
  await f.transport.put({ key: next + "msg", wake: true, messages: [f.message] });
  assert.deepEqual(f.cancels, [first + "msg"]);
});
test("cancel after a lost put response establishes the same durable key before its tombstone", async t => {
  const f = await fixture(t), prefix = "agent:a:task:t1:gen:1:";
  f.session.appendMessage({ role: "user", content: "Task input", timestamp: Date.now() });
  f.control.fail = true;
  await assert.rejects(f.transport.put({ key: prefix + "msg", wake: true, messages: [f.message] }), /put response lost/);
  await f.transport.cancelPrefix(prefix, "Task final");
  assert.deepEqual(f.cancels, [prefix + "msg"]);
  assert.deepEqual(f.puts[0].mail, f.puts[1].mail);
  assert.equal(f.sourceEntries.length, 1);
});

test("forked session history does not inherit parent pending intent or terminal scope", async t => {
  const f = await fixture(t);
  await f.transport.put({ key: "mail:msg", wake: true, messages: [f.message] });
  f.session.appendCustomEntry("agent-mailbox-delivery-v1", { version: 1, sessionId: f.session.getSessionId(), terminals: [] });
  const fork = { getSessionId: () => "fork-session", getEntries: () => f.session.getEntries(), getBranch: () => f.session.getBranch(), getLeafId: () => f.session.getLeafId() };
  f.transport.bindContext({ sessionManager: fork } as any);
  await f.transport.put({ key: "mail:msg", wake: false, messages: [{ ...f.message, content: "new fork intent" }] });
  assert.equal(f.puts[1].target.session.id, "fork-session");
  assert.equal(f.puts[1].mail.messages[0].content, "new fork intent");
  assert.equal(f.puts[1].mail.wake, false);
});

test("legacy unknown wake authority survives replacement before import revision is written", async t => {
  const f = await fixture(t);
  await f.transport.put({ key: "mail:msg", wake: false, legacyWakeUnknown: true, messages: [f.message] });
  assert.equal(f.sourceEntries[0].legacyWakeUnknown, true);
  assert.equal("legacyWakeUnknown" in f.puts[0].mail, false);
  const replacement = { getSessionId: () => f.session.getSessionId(), getEntries: () => f.session.getEntries(), getBranch: () => f.session.getBranch(), getLeafId: () => f.session.getLeafId() };
  f.transport.bindContext({ sessionManager: replacement } as any);
  await f.transport.put({ key: "mail:msg", wake: false, messages: [f.message] });
  assert.equal(f.transport.legacyWakeUnknown("mail:msg"), true);
  assert.deepEqual(f.puts[0].mail, f.puts[1].mail);
  assert.deepEqual(f.puts[1].options, { recovered: true });
  assert.equal("recovered" in f.puts[1].mail, false);
});

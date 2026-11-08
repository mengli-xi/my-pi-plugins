import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MAILBOX_CUSTOM_TYPES } from "pi-session-inject/mailbox-v1/light";
import { createSdkFixture, until } from "../fixtures/sdk-runtime.js";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { clearMailboxes, harness, recoveredPending } from "../../../pi-session-inject/test/mailbox-harness.ts";
import { SubagentMailboxTransport } from "../../src/mailbox/transport.ts";
const input = { key: "mail:tree-input", wake: false, messages: [{ customType: "subagent-mailbox-v1", content: "tree input", display: true,
  details: { message_id: "tree-input", body_sha256: "a".repeat(64), injected_into: { kind: "idle-conversation" } } }] };

test("cold cancellation retires only recovered D mail whose source guard cancels", async () => {
  const h = await harness({ persist: true });
  try {
    const mails = [h.mail("pi-subagents", "stale"), h.mail("pi-subagents", "valid"), h.mail("pi-subagents", "unknown"), h.mail("pi-processes", "other-producer")];
    await recoveredPending(h.agentDir, h.manager, mails);
    const source = new SubagentMailboxTransport(h.piFor("cold-child"), h.agentDir, { checkCurrent: () => ({ kind: "hold", reason: "cold source" }) });
    await h.emit("session_start", { reason: "startup" });
    const checked: string[] = [];
    await source.cancelRecovered(mail => { checked.push(mail.key); return mail.key === "stale" ? { kind: "cancel", reason: "original Task ended" }
      : mail.key === "valid" ? { kind: "allow", project: true, wake: true } : { kind: "hold", reason: "authority unknown" }; });
    assert.deepEqual(checked.sort(), ["stale", "unknown", "valid"]);
    const snapshot = JSON.parse(await readFile(join(h.agentDir, "mailbox/v1", h.manager.getSessionId(), "pending.json"), "utf8"));
    assert.deepEqual(snapshot.pending.map((m: any) => m.key).sort(), ["other-producer", "unknown", "valid"]);
    assert.equal(snapshot.terminal.length, 1); assert.equal(snapshot.terminal[0].mail.key, "stale"); assert.equal(snapshot.terminal[0].evidence.outcome, "cancelled");
    assert.equal(h.sends.length, 0, "valid and unknown recovery mail remain cold without body/control submission");
  } finally { await h.cleanup(); }
});

test("real A accepts D intent in an empty persistent session without changing its null origin", async () => {
  const h = await harness();
  try {
    const source = new SubagentMailboxTransport(h.piFor("subagents-source"), h.agentDir, { checkCurrent: () => ({ kind: "hold", reason: "test source held" }) });
    await h.emit("session_start", { reason: "new" });
    const accepted = await source.put(input);
    assert.equal(accepted.result.kind, "accepted"); assert.equal(accepted.mail.anchorEntryId, null);
    await source.cancel(input.key, "test cancel");
    assert.equal(h.sends.length, 0);
  } finally { await h.cleanup(); }
});

test("unaccepted pre-tree D put retains original intent and cannot retry onto a sibling", async () => {
  const h = await harness({ persist: true });
  try {
    const source = new SubagentMailboxTransport(h.piFor("subagents-source"), h.agentDir, { checkCurrent: () => ({ kind: "hold", reason: "test source held" }) });
    await h.emit("session_start", { reason: "new" }); await h.finish();
    const anchor = h.manager.getLeafId()!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const called = new Promise<void>(resolve => { entered = resolve; });
    const put = source.endpoint.put.bind(source.endpoint);
    source.endpoint.put = async (mail, target) => { entered(); await gate; return put(mail, target); };
    const pending = source.put(input);
    await called;
    const originalIntent = h.manager.getLeafId()!;
    h.manager.branch(anchor); h.manager.appendMessage({ role: "user", content: "sibling", timestamp: Date.now() });
    await h.emit("session_tree"); release();
    await assert.rejects(pending, { code: "stale-binding" });
    assert.equal(source.frozen(input.key)?.anchorEntryId, anchor);
    await assert.rejects(source.put(input), /origin|scope/u);
    assert.equal(h.sends.length, 0);
    h.manager.branch(originalIntent); await h.emit("session_tree");
    const resumed = await source.put(input);
    assert.equal(resumed.result.kind, "accepted"); assert.equal(resumed.mail.anchorEntryId, anchor);
    await source.cancel(input.key, "test cancel");
  } finally { await h.cleanup(); }
});

test("accepted original-file D put may finish after tree without projecting on its sibling", async () => {
  const h = await harness({ persist: true });
  try {
    const source = new SubagentMailboxTransport(h.piFor("subagents-source"), h.agentDir, { checkCurrent: () => ({ kind: "hold", reason: "test source held" }) });
    await h.emit("session_start", { reason: "new" }); await h.finish();
    const anchor = h.manager.getLeafId()!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const accepted = new Promise<void>(resolve => { entered = resolve; });
    const put = source.endpoint.put.bind(source.endpoint);
    source.endpoint.put = async (mail, target) => { const result = await put(mail, target); entered(); await gate; return result; };
    const pending = source.put(input); await accepted;
    await h.emit("session_before_tree");
    h.manager.branch(anchor); h.manager.appendMessage({ role: "user", content: "sibling", timestamp: Date.now() });
    await h.emit("session_tree"); release();
    const result = await pending;
    assert.equal(result.result.kind, "accepted"); assert.equal(result.mail.anchorEntryId, anchor);
    assert.equal(result.entries.length, 0); assert.equal(h.sends.length, 0);
  } finally { await h.cleanup(); }
});

test("unaccepted original intent survives reopening on a sibling and resumes only on its original branch", async () => {
  const h = await harness({ persist: true });
  try {
    const source = new SubagentMailboxTransport(h.piFor("source-before-tree"), h.agentDir, { checkCurrent: () => ({ kind: "allow", project: true, wake: true }) });
    await h.emit("session_start", { reason: "new" }); await h.finish();
    const anchor = h.manager.getLeafId()!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), called = new Promise<void>(resolve => { entered = resolve; });
    const put = source.endpoint.put.bind(source.endpoint);
    source.endpoint.put = async (mail, target, options) => { entered(); await gate; return put(mail, target, options); };
    const pending = source.put(input); await called;
    const originIntent = h.manager.getLeafId()!;
    h.manager.branch(anchor); h.manager.appendMessage({ role: "user", content: "sibling", timestamp: Date.now() });
    await h.finish(); // Persist the selected sibling leaf for SessionManager.open.
    await h.emit("session_tree"); release(); await assert.rejects(pending, { code: "stale-binding" });
    await assert.rejects(source.put(input), /origin|scope/u);
    source.close(); await clearMailboxes();
    const manager = SessionManager.open(h.manager.getSessionFile()!);
    assert.ok(!manager.getBranch().some(entry => entry.id === originIntent));
    const reopened = await harness({ directory: h.directory, manager });
    const restored = new SubagentMailboxTransport(reopened.piFor("source-after-reopen"), reopened.agentDir, { checkCurrent: () => ({ kind: "allow", project: true, wake: true }) });
    await reopened.emit("session_start", { reason: "startup" });
    assert.equal(restored.frozen(input.key)?.anchorEntryId, anchor);
    await assert.rejects(restored.put(input), /origin|scope/u);
    await assert.rejects(restored.cancel(input.key, "sibling cannot cancel original source"), /origin|scope/u);
    await reopened.startUser(); await reopened.context(); await reopened.finish();
    assert.equal(reopened.sends.length, 0, "trusted sibling input cannot receive original carrier/control");
    manager.branch(originIntent); await reopened.emit("session_tree");
    const accepted = await restored.put(input);
    assert.equal(accepted.mail.key, input.key); assert.equal(accepted.mail.anchorEntryId, anchor);
    assert.equal(accepted.result.kind, "accepted");
    await reopened.startUser();
    const context = await reopened.context();
    assert.equal(context.filter((message: { content?: unknown }) => message.content === input.messages[0].content).length, 1);
    await reopened.finish();
    await restored.cancel(input.key, "original scope owns cancellation");
  } finally { await h.cleanup(); }
});

test("fulfilled legacy cards stay complete across Main reload without a fabricated continuation", { timeout: 60_000 }, async () => {
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const f = await createSdkFixture(), first = gate(), cancelled = gate();
  f.control.responses.set("CHILD_WORK", first.promise);
  f.control.responses.set("HOLD_CANCEL", cancelled.promise);
  try {
    await f.runtime.session.prompt("SPAWN_NONE"); first.resolve();
    const service = f.cell.service!, binding = service.binding(f.runtime.session.sessionId)!;
    const state = () => binding.host.snapshot();
    const diagnostics = () => ({ state: state(), diagnostics: service.diagnostics() });
    await until(() => state().agents[0]?.outbox[0]?.turn_settlement?.state === "settled" && f.runtime.session.isIdle, "original successful Main run", diagnostics);
    const original = state().agents[0]!.outbox[0]!, sessionId = binding.mainSessionId, file = f.runtime.session.sessionFile!;
    const cardKey = `outbox:${original.outbox_id}:${original.wake_epoch}`, unknownKey = `${cardKey}:continuation`;
    // Prepare a legacy input fixture from real faux history while its session
    // is detached: retain original card/assistant/run IDs and the real store,
    // but omit the original continuation and all later transport metadata.
    assert.equal((await f.runtime.newSession()).cancelled, false); await clearMailboxes();
    const rows = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const transportTypes = new Set<string>([...Object.values(MAILBOX_CUSTOM_TYPES), "subagent-mailbox-intent-v1", "subagent-mailbox-import-v1"]);
    const legacy = rows.filter(entry => !(entry.type === "custom_message" && entry.customType === "subagent-continuation-v1")
      && !(entry.type === "custom" && transportTypes.has(entry.customType)));
    let parentId: string | null = null;
    for (const entry of legacy) if (entry.type !== "session" && entry.id) { entry.parentId = parentId; parentId = entry.id; }
    await writeFile(file, legacy.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const path = join(f.dir, "mailbox", "v1", sessionId, "pending.json");
    await rm(join(f.dir, "mailbox", "v1", sessionId), { recursive: true, force: true });
    const snapshot = (): any => { try { return JSON.parse(readFileSync(path, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: [], terminal: [] }; throw error; } };
    assert.equal((await f.runtime.switchSession(file)).cancelled, false);
    const imported = () => [...f.context.sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === "subagent-mailbox-import-v1");
    assert.ok(imported(), JSON.stringify({ sessionId: f.runtime.session.sessionId, diagnostics: diagnostics(), entries: f.context.sessionManager.getBranch() }));
    assert.deepEqual((imported() as any).data.items.map((item: any) => [item.key, item.state]), [[cardKey, "fulfilled"]]);
    assert.equal(binding.append!.transport.hasAccepted(unknownKey), false, "successful import does not create a missing continuation");
    await until(() => !snapshot().terminal.some((item: any) => item.mail.key === cardKey && (item.recorded?.ack === "pending" || item.terminalAck === "pending")), "legacy card ACK completes locally", diagnostics);
    const generation = binding.bindingGeneration;
    await f.runtime.session.reload();
    assert.ok(binding.bindingGeneration > generation, "reload must replace the Main binding");
    await until(() => !snapshot().terminal.some((item: any) => item.mail.key === cardKey), "reload finishes original card GC", diagnostics);
    assert.equal(binding.mailboxImportHolds!.size, 0);
    assert.equal(snapshot().terminal.some((item: any) => item.mail.key === unknownKey), false, "a missing continuation is never invented");
    const spawned = await service.executor(sessionId)({ tool: "spawn_agent", toolCallId: "after-ack-reload", context: f.context,
      params: { task_name: "after_reload", message: "HOLD_CANCEL", fork_turns: "none" } });
    assert.equal(spawned.details.outcome, "ok", JSON.stringify(spawned));
    const fresh = () => state().agents.find(item => item.agent.task_name === "after_reload")!;
    await until(() => fresh()?.tasks[0]?.phase === "running", "post-reload Task running", diagnostics);
    const waited = await binding.host.waitAgents({ request_id: randomUUID(), caller: { kind: "main-model", conversation: { kind: "main", session_id: sessionId }, binding_generation: binding.bindingGeneration }, input: { targets: [fresh().agent.agent_id] } });
    assert.equal(waited.ok, true); if (!waited.ok) throw new Error(JSON.stringify(waited)); assert.equal(waited.value.state, "armed");
    assert.equal((await binding.host.interruptAgent({ request_id: randomUUID(), caller: { kind: "user", main_session_id: sessionId, binding_generation: binding.bindingGeneration, manager_generation: 1 },
      input: { target: fresh().agent.agent_id, expected_task_id: fresh().tasks[0]!.task_id, expected_runtime_generation: fresh().tasks[0]!.runtime_generation! } })).ok, true);
    cancelled.resolve();
    const outbox = () => state().root.outbox.find(item => item.completion_ids.includes(fresh().completions[0]?.completion_id!));
    await until(() => outbox()?.turn_settlement?.state === "settled" && f.runtime.session.isIdle, "post-reload independent Wake delivered", diagnostics);
    assert.equal(outbox()!.state, "delivered"); assert.equal(outbox()!.delivery_attempts, 1);
    const wakes = () => f.context.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1" && (entry.details as any)?.outbox_id === outbox()!.outbox_id).length;
    assert.equal(wakes(), 1); service.signalMainIdle(sessionId); await f.runtime.session.prompt("AFTER_ACK_RELOAD"); assert.equal(wakes(), 1);
    assert.equal(binding.mailboxImportHolds!.size, 0);
    assert.deepEqual([state().root, ...state().agents].flatMap(partition => partition.outbox).find(item => item.outbox_id === original.outbox_id), original);
    assert.equal(f.context.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1" && (entry.details as any)?.outbox_id === original.outbox_id), false);
  } finally { first.resolve(); cancelled.resolve(); await f.close(); }
});

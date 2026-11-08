import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readMainMailboxRetirement } from "../../src/mailbox/retirement-main.js";
import { checkMainMail } from "../../src/mailbox/main-source.js";
import { createSdkFixture, until } from "../fixtures/sdk-runtime.js";

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("a genuinely unknown legacy Outbox stays held while fresh spawn, wait and cancellation wake Main once", { timeout: 60_000 }, async t => {
  const f = await createSdkFixture(), first = gate(), cancelled = gate();
  f.control.responses.set("CHILD_WORK", first.promise);
  f.control.responses.set("HOLD_CANCEL", cancelled.promise);
  try {
    await f.runtime.session.prompt("SPAWN_NONE"); first.resolve();
    const service = f.cell.service!, binding = service.binding(f.runtime.session.sessionId)!;
    const state = () => binding.host.snapshot();
    const diagnostics = () => ({ state: state(), diagnostics: service.diagnostics() });
    await until(() => state().agents[0]?.outbox[0]?.turn_settlement?.state === "settled" && f.runtime.session.isIdle, "original Outbox settled", diagnostics);
    const old = state().agents[0]!.outbox[0]!, transport = binding.append!.transport;
    const oldMail = transport.frozen(`outbox:${old.outbox_id}:${old.wake_epoch}`)!;
    const card = f.context.sessionManager.getBranch().find(entry => entry.type === "custom_message" && entry.customType === "subagent-completion-v1")!;
    // A fully witnessed old branch is retired even when it is not selected.
    // A contradictory source scope, however, must remain unknown and local.
    f.runtime.session.sessionManager.branch(card.parentId!);
    assert.equal(f.context.sessionManager.getBranch().some(entry => entry.id === card.id), false, "selected branch must lack original card");
    const facts = await readMainMailboxRetirement(binding.host.mainMailboxReadContext, true);
    assert.equal(facts.outbox(state(), old).kind, "retired");
    const known = transport.knownMails.bind(transport);
    t.mock.method(transport, "knownMails", () => known().map(mail => mail.key === oldMail.key ? { ...mail, anchorEntryId: card.id } : mail));
    await service.attach(transport.pi, f.context, binding.config, transport);
    const held = `outbox:${old.outbox_id}:${old.wake_epoch}`;
    assert.equal(binding.mailboxImportPending, false);
    assert.match(binding.mailboxImportHolds!.get(held)!, /scope/, JSON.stringify({ held, holds: [...binding.mailboxImportHolds!], old, branch: f.context.sessionManager.getBranch().map(entry => ({id: entry.id, type: entry.type})) }));
    assert.equal(checkMainMail(binding, oldMail).kind, "hold");
    const oldInbox = state().root.inbox.find(inbox => old.completion_ids.includes(inbox.completion_id))!;
    assert.equal(checkMainMail(binding, { ...oldMail, key: `card:${oldInbox.inbox_id}` }).kind, "hold", "the unknown Outbox also holds its single-card ingress");
    assert.ok(service.diagnostics().some(item => item.operation === "mailbox-import-hold" && item.message.includes(held) && item.message.includes("scope")));
    const spawn = await service.executor(binding.mainSessionId)({ tool: "spawn_agent", toolCallId: "fresh-after-unknown", context: f.context,
      params: { task_name: "fresh", message: "HOLD_CANCEL", fork_turns: "none" } });
    assert.equal(spawn.details.outcome, "ok", JSON.stringify(spawn));
    const fresh = () => state().agents.find(item => item.agent.task_name === "fresh")!;
    await until(() => fresh()?.tasks[0]?.phase === "running", "fresh Task running", diagnostics);
    const caller = { kind: "main-model" as const, conversation: { kind: "main" as const, session_id: binding.mainSessionId }, binding_generation: binding.bindingGeneration };
    const waited = await binding.host.waitAgents({ request_id: randomUUID(), caller, input: { targets: [fresh().agent.agent_id] } });
    assert.equal(waited.ok, true); if (!waited.ok) throw new Error(JSON.stringify(waited));
    assert.equal(waited.value.state, "armed");
    const interrupted = await binding.host.interruptAgent({ request_id: randomUUID(), caller: { kind: "user", main_session_id: binding.mainSessionId,
      binding_generation: binding.bindingGeneration, manager_generation: 1 }, input: { target: fresh().agent.agent_id,
      expected_task_id: fresh().tasks[0]!.task_id, expected_runtime_generation: fresh().tasks[0]!.runtime_generation! } });
    assert.equal(interrupted.ok, true); cancelled.resolve();
    const outbox = () => state().root.outbox.find(item => item.completion_ids.includes(fresh().completions[0]?.completion_id!));
    await until(() => outbox()?.state === "delivered" && outbox()?.turn_settlement?.state === "settled" && f.runtime.session.isIdle, "fresh barrier Wake handled", diagnostics);
    assert.equal(state().root.barrier?.state, "satisfied");
    assert.equal(outbox()!.kind, "barrier-wake"); assert.equal(outbox()!.delivery_attempts, 1); assert.equal(outbox()!.wake_state, "settled");
    const countWake = () => f.context.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1"
      && (entry.details as { outbox_id?: string })?.outbox_id === outbox()!.outbox_id).length;
    assert.equal(countWake(), 1);
    const calls = f.control.providerCalls.length;
    service.signalMainIdle(binding.mainSessionId);
    await f.runtime.session.prompt("AFTER_UNKNOWN_DELIVERY");
    assert.equal(countWake(), 1); assert.equal(outbox()!.delivery_attempts, 1);
    assert.ok(f.control.providerCalls.length <= calls + 1, "ordinary input must not cause a duplicate Wake request");
    assert.equal(checkMainMail(binding, oldMail).kind, "hold");
    assert.deepEqual([state().root, ...state().agents].flatMap(partition => partition.outbox).find(item => item.outbox_id === old.outbox_id), old, "unknown historical source is never rewritten");
    const snapshot = JSON.parse(await readFile(join(f.dir, "mailbox", "v1", binding.mainSessionId, "pending.json"), "utf8").catch(error => { if (error.code === "ENOENT") return '{"pending":[]}'; throw error; }));
    assert.equal(snapshot.pending.some((mail: { key: string }) => mail.key.startsWith(`outbox:${outbox()!.outbox_id}:`)), false);
    assert.equal(service.diagnostics().filter(item => item.operation !== "mailbox-import-hold").length, 0);
  } finally { first.resolve(); cancelled.resolve(); await f.close(); }
});

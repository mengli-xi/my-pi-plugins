import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { freshHost } from "../fixtures/fresh-host.ts";

for (const kind of ["input", "process"]) test(`stock active SDK reload before ${kind} provider is visibly refused without changing requests`, { timeout: 60_000 }, async t => {
  const previous = process.env.PI_SDK_RELOAD_TEST; process.env.PI_SDK_RELOAD_TEST = "1";
  t.after(() => { if (previous === undefined) delete process.env.PI_SDK_RELOAD_TEST; else process.env.PI_SDK_RELOAD_TEST = previous; });
  let h: Awaited<ReturnType<typeof freshHost>>;
  t.after(async () => {
    const evidence = process.env.PI_SDK_RELOAD_EVIDENCE; if (!evidence || !h) return;
    const directory = join(evidence, kind); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "provider.jsonl"), await readFile(join(h.root, "provider.jsonl")).catch(() => ""));
    if (h.main.exitCode === null) {
      const snapshot = await h.snapshot(); await writeFile(join(directory, "snapshot.json"), JSON.stringify(snapshot, null, 2));
      for (const agent of snapshot.snapshot.agents) {
        await writeFile(join(directory, `child-${agent.agent.agent_id}.jsonl`), await readFile(join(snapshot.mainRoot, agent.agent.conversation.relative_path)));
        await writeFile(join(directory, "mailbox.json"), await readFile(join(h.agentDir, "mailbox/v1", agent.agent.conversation.session_id, "pending.json")).catch(() => "null"));
      }
    }
  });
  // Release fixture gates before the existing host teardown on any assertion failure.
  let root: string | undefined;
  t.after(async () => { if (root) { await writeFile(join(root, "sdk-gate-release"), "release").catch(() => {}); await writeFile(join(root, "sdk-process-release"), "release").catch(() => {}); } });
  h = await freshHost(t, "SDK_RELOAD_SUBJECT"); root = h.root;
  await h.rpc("prompt", { message: "/subagents-test-spawn" });
  const waiting = await h.until(h.snapshot, s => s.snapshot?.agents[0]?.tasks[0]?.phase === "waiting", "Process parked");
  const subject = waiting.snapshot.agents[0], original = subject.tasks[0], childId = subject.agent.conversation.session_id;
  const file = join(waiting.mainRoot, subject.agent.conversation.relative_path);
  const entries = async (): Promise<any[]> => (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const calls = async (): Promise<any[]> => (await readFile(join(h.root, "provider.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const receipts = (rows: any[]) => rows.filter(e => e.customType === "agent-mailbox-delivery-v1").flatMap(e => e.data.terminals);
  await h.control("send_input", { target: subject.agent.agent_id, message: "FULFILLED_BEFORE_RELOAD" });
  await h.until(async () => ({ state: await h.snapshot(), entries: await entries() }), s => s.state.snapshot.agents[0].tasks[0].phase === "waiting"
    && s.state.residents[0]?.residency?.state === "waiting" && s.state.residents[0]?.idle === true
    && receipts(s.entries).some(t => t.mail.messages.some((m: any) => m.content === "FULFILLED_BEFORE_RELOAD")), "first input fulfilled");
  const earlier = receipts(await entries()).find(t => t.mail.messages.some((m: any) => m.content === "FULFILLED_BEFORE_RELOAD"));
  await writeFile(join(h.root, "sdk-gate-arm"), kind);
  if (kind === "input") await h.control("send_input", { target: subject.agent.agent_id, message: "RELOAD_GATE_INPUT" });
  else await writeFile(join(h.root, "sdk-process-release"), "release");
  const checkpoint: any = await h.until<any>(async () => { try { return JSON.parse(await readFile(join(h.root, "sdk-checkpoint.json"), "utf8")); } catch (e) { if ((e as any).code === "ENOENT") return undefined; throw e; } }, Boolean, "actual native before faux invocation");
  assert.equal(checkpoint.sessionId, childId); assert.ok((await entries()).some(e => e.id === checkpoint.nativeEntryId && e.type === "custom_message"));
  assert.equal((await calls()).filter(r => r.sessionId === childId).length, 3);
  const reload = await h.control("reload-child", undefined, subject.agent.agent_id); assert.deepEqual(reload.after, reload.before);
  assert.equal(reload.reloadRefused, true); assert.equal(reload.bindingUnchanged, true);
  assert.match(reload.error, /Child SDK reload refused:.*non-terminal Task/); assert.ok(reload.notices.some((text: string) => /Finish or close.*retry/.test(text)));
  assert.equal(reload.after.generation, original.runtime_generation); assert.equal((await calls()).filter(r => r.sessionId === childId).length, 3);
  await writeFile(join(h.root, "sdk-gate-release"), "release");
  if (kind === "input") {
    await h.until(async () => ({ snapshot: await h.snapshot(), calls: await calls() }), s => s.snapshot.snapshot.agents[0].tasks[0].phase === "waiting"
      && s.snapshot.residents[0]?.residency?.state === "waiting" && s.snapshot.residents[0]?.idle === true
      && s.calls.filter(r => r.sessionId === childId).length === 4, "original input handled after refused reload");
    await writeFile(join(h.root, "sdk-process-release"), "release");
  }
  const final = await h.until(h.snapshot, s => s.snapshot.agents[0].tasks[0].phase === "settled" && s.snapshot.agents[0].outbox[0]?.turn_settlement?.state === "settled", "Main successful source settlement");
  const agent = final.snapshot.agents[0]; assert.equal(agent.tasks[0].task_id, original.task_id); assert.equal(agent.tasks[0].runtime_generation, original.runtime_generation);
  assert.equal(agent.tasks[0].outcome, "completed"); assert.equal(agent.completions.length, 1); assert.equal(agent.outbox.length, 1); assert.deepEqual(final.diagnostics, []);
  const finalEntries = await entries(), finalCalls = await calls();
  assert.equal(finalCalls.filter(r => r.sessionId === childId).length, kind === "input" ? 5 : 4); assert.equal(finalCalls.filter(r => r.sessionId === h.sessionId).length, 1);
  assert.deepEqual(receipts(finalEntries).filter(t => t.mail.key === earlier.mail.key), [earlier]);
  assert.equal(finalEntries.filter(e => e.type === "custom_message" && e.customType === "subagent-mailbox-v1").length, kind === "input" ? 2 : 1);
  assert.equal(finalEntries.filter(e => e.type === "custom_message" && e.customType === "process-notification-batch-v1").length, 1);
  assert.equal(finalEntries.filter(e => e.type === "custom_message" && e.customType === "agent-mailbox-trigger-v1").length, kind === "input" ? 3 : 2);
  assert.equal((await readFile(join(h.root, "sdk-business.log"), "utf8")).split("\n").filter(s => s === "start").length, 1);
  t.diagnostic(JSON.stringify({ kind, reloadRefused: true, visibleNotice: reload.notices[0], main: 1, child: kind === "input" ? 5 : 4, nativeBeforeProvider: checkpoint.nativeEntryId, earlierReceipt: earlier.evidence.terminalId, task: "settled", sourceTurn: "settled" }));
  await h.stop(); assert.equal((await calls()).length, finalCalls.length, "shutdown adds no request");
});

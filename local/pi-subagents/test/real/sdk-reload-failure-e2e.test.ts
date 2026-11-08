import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { freshHost } from "../fixtures/fresh-host.js";

test("stock failed quiescent reload refuses new work until close/resume creates a fresh execution", { timeout: 60_000 }, async t => {
  const h = await freshHost(t, "Reply exactly SUBAGENT_OK");
  await h.rpc("prompt", { message: "/subagents-test-spawn" });
  const before = await h.until(h.snapshot, s => s.snapshot?.agents[0]?.tasks[0]?.phase === "settled"
    && s.snapshot.agents[0].outbox[0]?.turn_settlement?.state === "settled" && s.residents[0]?.residency?.state === "idle" && s.residents[0]?.idle === true, "seed fully settled");
  const original = before.snapshot.agents[0], id = original.agent.agent_id, generation = before.residents[0].generation;
  const calls = async (): Promise<any[]> => (await readFile(join(h.root, "provider.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const failed = await h.control("fail-child-reload", undefined, id);
  assert.equal(failed.nativeFailureRequested, true); assert.match(failed.error, /^controlled native beforeSessionStart failure$/);
  assert.ok(failed.notices.some((message: string) => /reload failed.*close_agent.*resume_agent/.test(message)));
  const count = (await calls()).length;
  for (const tool of ["send_input", "resume_agent"]) {
    const rejected = await h.control(tool, { target: id, ...(tool === "send_input" ? { message: "MUST_NOT_RUN" } : {}) });
    assert.equal(rejected.details.outcome, "rejected"); assert.equal(rejected.details.error.code, "agent-busy");
    assert.match(rejected.details.error.message, /reload failed.*close_agent.*resume_agent/);
  }
  const unavailable = await h.control("list_agents", {});
  assert.equal(unavailable.details.data.agents[0].state, "unavailable"); assert.equal(unavailable.details.data.agents[0].availability_reason, "runtime-unavailable");
  const fenced = (await h.snapshot()).snapshot.agents[0];
  assert.deepEqual(fenced.tasks, original.tasks); assert.deepEqual(fenced.completions, original.completions); assert.deepEqual(fenced.outbox, original.outbox);
  assert.equal((await calls()).length, count, "failed reload never admits a new model request");
  assert.equal((await h.control("close_agent", { target: id })).details.outcome, "ok");
  assert.equal((await h.control("resume_agent", { target: id })).details.outcome, "ok");
  const resumed = await h.snapshot(); assert.ok(resumed.residents[0].generation > generation); assert.equal((await calls()).length, count, "resume stays idle");
  assert.equal((await h.control("send_input", { target: id, message: "FOLLOWUP_SECOND" })).details.outcome, "ok");
  const final = await h.until(h.snapshot, s => s.snapshot.agents[0].tasks[1]?.phase === "settled"
    && s.snapshot.agents[0].outbox.every((outbox: any) => outbox.turn_settlement?.state === "settled"), "fresh execution completed");
  const subject = final.snapshot.agents[0]; assert.equal(subject.tasks.length, 2); assert.equal(subject.completions.length, 2);
  assert.equal(subject.tasks[1].outcome, "completed"); assert.match(subject.completions[1].final_text, /FOLLOWUP_OK/);
  assert.deepEqual(subject.tasks[0], original.tasks[0]); assert.deepEqual(subject.completions[0], original.completions[0]);
  assert.equal(final.diagnostics.some((d: any) => /session is unavailable/.test(d.message)), false);
  t.diagnostic(JSON.stringify({ failedReload: true, rejectedRequests: 0, originalTaskUnchanged: true, freshGeneration: resumed.residents[0].generation,
    childRequests: (await calls()).filter(c => c.sessionId === original.agent.conversation.session_id).length, tasks: 2, completions: 2 }));
  await h.stop();
});

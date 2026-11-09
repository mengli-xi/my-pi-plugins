import assert from "node:assert/strict";
import test from "node:test";
import { freshHost, delay } from "../fixtures/fresh-host.ts";
test("SDK follow-up reuses native session and generation without a child Pi", { timeout: 120_000 }, async t => {
  const f = await freshHost(t); await f.rpc("prompt", { message: "/subagents-test-spawn" });
  const before = await f.settled(), resident = before.residents[0];
  assert.equal(resident.compaction.enabled, true); assert.ok(resident.nativeSessionId); f.assertNoChildPi();
  await f.control("send_input", { target: before.snapshot.agents[0].agent.agent_id, message: "FOLLOWUP_SECOND" });
  const after = await f.settled(2); assert.equal(after.residents[0].nativeSessionId, resident.nativeSessionId); assert.equal(after.residents[0].generation, resident.generation);
  assert.match(after.snapshot.agents[0].completions[1].summary, /FOLLOWUP_OK/);
  f.assertNoChildPi(); await f.stop();
});

import assert from "node:assert/strict";
import test from "node:test";
import { freshHost, delay } from "../fixtures/fresh-host.js";
test("cloned migration profile with CC/Pinned/Processes completes a faux SDK task", { timeout: 120_000 }, async t => {
  const f = await freshHost(t, "Reply exactly SUBAGENT_OK", true); await f.assertAuthSymlink();
  await f.rpc("prompt", { message: "/subagents-test-spawn" });
  const state = await f.settled(); assert.match(state.snapshot.agents[0].completions[0].summary, /SUBAGENT_OK/);
  assert.equal(state.snapshot.agents[0].tasks[0].outcome, "completed"); assert.deepEqual(state.diagnostics, []); f.assertNoChildPi(); await f.stop();
});

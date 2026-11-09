import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { freshHost, delay } from "../fixtures/fresh-host.ts";
test("disposing one SDK session contains failure and Main can spawn a replacement", { timeout: 120_000 }, async t => {
  const f = await freshHost(t, "CRASH_PARENT"); await f.rpc("prompt", { message: "/subagents-test-spawn" });
  const active = await f.until(f.snapshot, value => value.snapshot?.agents[0]?.tasks[0]?.phase === "running", "child running");
  // Host admission precedes the actual SDK provider run. Dispose the busy
  // execution this case covers, after its abort-aware response has started.
  await f.until(async () => {
    try { return (await readFile(join(f.root, "provider.jsonl"), "utf8")).includes(active.snapshot.agents[0].agent.conversation.session_id); }
    catch { return false; }
  }, Boolean, "child request started");
  await f.control("dispose-child", undefined, "real_spawn");
  const failed = await f.settled(); assert.equal(failed.snapshot.agents[0].tasks[0].outcome, "failed"); assert.equal(failed.snapshot.agents[0].tasks[0].reason, "host-lost");
  const spawned = await f.control("spawn_agent", { task_name: "healthy", message: "Reply exactly SUBAGENT_OK", fork_turns: "none" }); assert.equal(spawned.details.outcome, "ok");
  const after = await f.settled(2); assert.equal(after.snapshot.agents.find((item: any) => item.agent.task_name === "healthy").tasks[0].outcome, "completed");
  f.assertNoChildPi(); await f.stop();
});

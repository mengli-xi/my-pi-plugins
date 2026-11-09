import assert from "node:assert/strict";
import test from "node:test";
import { openMainStoreV1 } from "../../../local/pi-subagents/src/persistence/store.js";
import { freshHost, delay } from "../fixtures/fresh-host.ts";
test("quit drains busy SDK execution and leaves no subagents child processes", { timeout: 120_000 }, async t => {
  const f = await freshHost(t, "CRASH_PARENT"); await f.rpc("prompt", { message: "/subagents-test-spawn" });
  await f.until(f.snapshot, value => value.snapshot?.agents[0]?.tasks[0]?.phase === "running", "child running");
  f.assertNoChildPi(); await f.stop(); assert.deepEqual(f.descendants(), []); assert.equal(f.stderr, ""); const store=await openMainStoreV1({agentDirectory:f.agentDir,mainSessionId:f.sessionId,liveRuntimeGenerations:new Map()});try{assert.ok(store.snapshot().agents.every(i=>i.agent.lifecycle==="closed"));assert.equal(store.snapshot().agents[0]!.tasks[0]!.outcome,"interrupted");}finally{await store.close();}
});

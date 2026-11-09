import assert from "node:assert/strict";
import test from "node:test";
import { freshHost } from "../fixtures/fresh-host.ts";
test("stock send_input interrupt replaces only the current Task and keeps the Agent open", {timeout:60000}, async t => {
 const f=await freshHost(t,"CRASH_PARENT");await f.rpc("prompt",{message:"/subagents-test-spawn"});const before=await f.until(f.snapshot,v=>!!v.residents[0]?.nativeSessionId,"ready"),id=before.snapshot.agents[0].agent.agent_id;
 const result=await f.control("send_input",{target:id,message:"FOLLOWUP_SECOND",interrupt:true});assert.equal(result.details.outcome,"ok");const after=await f.settled(2);assert.equal(after.snapshot.agents[0].tasks[0].outcome,"interrupted");assert.equal(after.snapshot.agents[0].tasks[1].outcome,"completed");assert.equal(after.snapshot.agents[0].agent.lifecycle,"open");await f.stop();
});

import assert from "node:assert/strict";
import test from "node:test";
import { freshHost } from "../fixtures/fresh-host.ts";
test("stock SDK reload force-closes the old Main tree; resume is idle",{timeout:120000},async t=>{
 const f=await freshHost(t,"CRASH_PARENT");await f.rpc("prompt",{message:"/subagents-test-spawn"});
 const before=await f.until(f.snapshot,v=>!!v.residents[0]?.nativeSessionId,"native ready"),id=before.snapshot.agents[0].agent.agent_id;
 await f.control("reload");const after=await f.until(f.snapshot,v=>v.bindingGeneration>before.bindingGeneration&&v.snapshot.agents.every((i:any)=>i.agent.lifecycle==="closed"),"reload closed");
 assert.equal(after.snapshot.agents[0].tasks[0].outcome,"interrupted");assert.equal(after.snapshot.agents[0].completions.length,1);assert.equal(after.residents[0].nativeSessionId,undefined);
 assert.equal((await f.control("send_input",{target:id,message:"closed"})).details.error.code,"agent-closed");
 assert.equal((await f.control("resume_agent",{target:id})).details.outcome,"ok");const resumed=await f.snapshot();assert.equal(resumed.snapshot.agents[0].tasks.length,1);assert.equal(resumed.residents[0].nativeSessionId,before.residents[0].nativeSessionId);assert.ok(resumed.residents[0].generation>before.residents[0].generation);
 f.assertNoChildPi();await f.stop();
});

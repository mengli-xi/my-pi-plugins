import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { freshHost } from "../fixtures/fresh-host.ts";
test("stock lifecycle close, idle resume, send and quit preserve one Task per completion",{timeout:120000},async t=>{
 const f=await freshHost(t);await f.rpc("prompt",{message:"/subagents-test-spawn"});const first=await f.settled(),id=first.snapshot.agents[0].agent.agent_id;
 assert.ok(!first.residents[0].activeTools.includes("spawn_agent"));assert.ok(!first.residents[0].activeTools.includes("close_agent"));assert.ok(!first.residents[0].activeTools.includes("resume_agent"));
 assert.equal((await f.control("close_agent",{target:id})).details.outcome,"ok");
 for(const interrupt of [false,true])assert.equal((await f.control("send_input",{target:id,message:"closed",interrupt})).details.error.code,"agent-closed");
 const childRequests=async()=>(await readFile(join(f.root,"provider.jsonl"),"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.sessionId===first.residents[0].nativeSessionId).length;
 const before=await childRequests();
 assert.equal((await f.control("resume_agent",{target:id})).details.outcome,"ok");const idle=await f.snapshot();assert.equal(idle.snapshot.agents[0].tasks.length,1);assert.equal(idle.snapshot.agents[0].agent.lifecycle,"open");
 assert.equal(await childRequests(),before);
 await f.control("send_input",{target:id,message:"FOLLOWUP_SECOND"});const after=await f.settled(2);assert.equal(after.snapshot.agents[0].completions.length,2);assert.match(after.snapshot.agents[0].completions[1].summary,/FOLLOWUP_OK/);await f.stop();
});

test("stock cold reopen closes an ownerless unfinished Task without trusting native assistant tail",{timeout:120000},async t=>{
 const f=await freshHost(t,"CRASH_PARENT");await f.rpc("prompt",{message:"/subagents-test-spawn"});
 const before=await f.until(f.snapshot,v=>!!v.residents[0]?.nativeSessionId,"native ready");
 f.main.kill("SIGKILL");await new Promise(r=>f.main.once("exit",r));
 const {openMainStoreV1}=await import("../../../local/pi-subagents/src/persistence/store.ts");const store=await openMainStoreV1({agentDirectory:f.agentDir,mainSessionId:f.sessionId,liveRuntimeGenerations:new Map()});
 try{const item=store.snapshot().agents[0]!;assert.equal(item.agent.lifecycle,"closed");assert.equal(item.tasks.length,1);assert.equal(item.tasks[0]!.outcome,"interrupted");assert.equal(item.tasks[0]!.reason,"host-lost");assert.equal(item.completions.length,1);assert.equal(item.agent.conversation.session_id,before.residents[0].nativeSessionId);}finally{await store.close();}
});

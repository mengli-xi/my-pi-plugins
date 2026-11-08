import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freshHost, delay } from "../fixtures/fresh-host.js";
for(const operation of ["new","switch"] as const)test(`stock SDK ${operation} closes the old Main tree and return never restarts it`,{timeout:120000},async t=>{
 const f=await freshHost(t,"CRASH_PARENT");await f.rpc("prompt",{message:"/subagents-test-spawn"});await f.until(f.snapshot,v=>!!v.residents[0]?.nativeSessionId,"native ready");
 if(operation==="new")await f.rpc("new_session");else{const next=join(f.root,"other.jsonl");await writeFile(next,JSON.stringify({type:"session",version:3,id:"other-main",timestamp:new Date().toISOString(),cwd:f.root})+"\n");await f.rpc("switch_session",{sessionPath:next});}
 assert.notEqual((await f.rpc("get_state")).sessionId,f.sessionId);await f.rpc("switch_session",{sessionPath:f.session});
 const after=await f.snapshot();assert.ok(after.snapshot.agents.every((i:any)=>i.agent.lifecycle==="closed"));assert.equal(after.snapshot.agents[0].tasks[0].reason,"main-session-ended");assert.equal(after.snapshot.agents[0].completions.length,1);assert.equal(after.residents[0].nativeSessionId,undefined);f.assertNoChildPi();await f.stop();
});
test("stock fork and return deliver one completion only to its original released scope", { timeout: 45_000 }, async t => {
 const f=await freshHost(t,"CRASH_PARENT");
 await f.rpc("prompt",{message:"FOREGROUND_CHECK"});
 await f.until(()=>f.rpc("get_state"),value=>!value.isStreaming&&f.records.some(row=>row.type==="agent_end"),"seed settled");
 const seed=((await f.rpc("get_entries")).entries as any[]).find(row=>row.message?.role==="user");assert.ok(seed);
 await f.rpc("prompt",{message:"/subagents-test-spawn"});await f.until(f.snapshot,v=>!!v.residents[0]?.nativeSessionId,"child ready");
 await f.rpc("fork",{entryId:seed.id});const forkId=(await f.rpc("get_state")).sessionId;assert.notEqual(forkId,f.sessionId);
 try { const fork=JSON.parse(await readFile(join(f.agentDir,"mailbox/v1",forkId,"pending.json"),"utf8"));
   assert.equal([...fork.pending,...fork.terminal.map((item:any)=>item.mail)].some((mail:any)=>mail.producer==="pi-subagents"),false,"original source must not retarget onto the fork");
 } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error; }
 await f.rpc("switch_session",{sessionPath:f.session});
 const after=await f.snapshot();assert.equal(after.snapshot.agents[0].tasks[0].reason,"main-session-ended");
 assert.equal(after.snapshot.agents[0].completions.length,1);assert.equal(after.residents[0].nativeSessionId,undefined);
 const entries=await f.until(async()=>(await f.rpc("get_entries")).entries as any[],rows=>rows.some(row=>row.customType==="subagent-completion-v1")&&rows.some(row=>row.customType==="agent-mailbox-delivery-v1"),"original completion handled");
 assert.equal(entries.filter(row=>row.type==="custom_message"&&row.customType==="subagent-completion-v1").length,1);
 assert.equal(entries.filter(row=>row.type==="custom_message"&&row.customType==="agent-mailbox-trigger-v1").length,1);
 await delay(150);
 const calls=(await readFile(join(f.root,"provider.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
 const parent=calls.filter(call=>call.sessionId===f.sessionId);assert.equal(parent.length,2,"seed plus the first notification of the original interrupted Task");
 assert.ok(JSON.stringify(parent[1].messages).includes("<subagent_completion"),"the one notification request must contain its original card");
 t.diagnostic(JSON.stringify({parentProviderRequests:2,completionRequests:1,duplicateRequests:0,originalTasks:1,originalCompletions:1}));await f.stop();
});

import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { createSdkFixture, until } from "../fixtures/sdk-runtime.js";
import { measureMainStoreUsageV1 } from "../../src/persistence/maintenance.js";

// 只验 SDK 层接线：真实 binding 的 checkpoint 只留一对代、health 保持 healthy。Root 增长和容量回归在
// persistence-root-growth.test.ts 里直接跑 store，不必在这里堆几十个 Agent。
test("one Main streaming then more opens and repeated checkpoints keeps generation footprint bounded",{timeout:120000},async()=>{
 const f=await createSdkFixture({contextWindow:1048576,streamSize:23000,responseSupply:400});
 try{
  await f.runtime.session.prompt("SPAWN_NONE");const service=f.cell.service!,binding=service.binding(f.runtime.session.sessionId)!;
  const snapshot=()=>binding.host.snapshot();
  const settled=()=>until(()=>snapshot().agents.every(a=>a.tasks.every(task=>task.phase==="settled"))&&snapshot().agents.every(a=>a.outbox.every(outbox=>["delivered","handled"].includes(outbox.state)))&&f.runtime.session.isIdle,"work and delivery",()=>({health:binding.store.health(),errors:service.diagnostics(),states:snapshot().agents.map(a=>({name:a.agent.task_name,tasks:a.tasks.map(t=>t.phase),outbox:a.outbox.map(o=>({state:o.state,wake:o.wake_state,epoch:o.wake_epoch}))})),calls:f.control.providerCalls.slice(-10)}),90000);
  const spawn=async(count:number)=>{for(let n=snapshot().agents.length;n<count;n++){const result=await service.executor(binding.mainSessionId)({tool:"spawn_agent",toolCallId:`store-${n}`,context:f.context,params:{task_name:`store_${n}`,message:"SHORT_STORE",fork_turns:"none"}});assert.equal(result.details.outcome,"ok",JSON.stringify(result));}await settled();};
  const stream=async()=>{await Promise.all(snapshot().agents.map(item=>binding.runtime.admitViewInput(item.agent.agent_id,{kind:"user",main_session_id:binding.mainSessionId,binding_generation:binding.bindingGeneration,manager_generation:1},"STORE_STREAM")));await settled();};
  await settled();await spawn(2);await stream();await spawn(4);
  const usage=await measureMainStoreUsageV1(binding.store.mainRoot);assert.ok(usage.metadataBytes<67108864);assert.equal(snapshot().agents.length,4);assert.equal(binding.store.health().storage,"healthy");
  for(let n=0;n<2;n++){await binding.store.checkpoint();assert.equal((await readdir(binding.store.paths.checkpoints)).length,1);assert.equal((await readdir(binding.store.paths.journals)).length,1);assert.equal(binding.store.health().storage,"healthy");}
  assert.equal(snapshot().agents.reduce((n,item)=>n+item.completions.length,0),6);
 }finally{await f.close();}
});

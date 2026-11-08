import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSdkFixture, until } from "../fixtures/sdk-runtime.js";
import { planRecoveryV1 } from "../../src/persistence/recovery.js";
import { applyJournalMutationsV1 } from "../../src/persistence/state-reducer.js";

async function ready() {
  const f = await createSdkFixture(); await f.runtime.session.prompt("SPAWN_NONE");
  const s=f.cell.service!, b=s.binding(f.runtime.session.sessionId)!;
  s.detach(b.pi!,b.mainSessionId);
  const item=()=>b.host.snapshot().agents[0]!;
  await until(()=>item().tasks[0]?.phase==="settled","initial",()=>s.diagnostics());
  const caller={kind:"user" as const,main_session_id:b.mainSessionId,binding_generation:b.bindingGeneration,manager_generation:1};
  return {f,s,b,item,caller};
}
for (const sent of [false,true]) test(`cancel ${sent?"sent":"pending"} delivery before resume fences the old Task input`, {timeout:60000}, async()=>{
  const {f,b,item,caller}=await ready(); const original=b.runtime.flushAgent.bind(b.runtime);
  try {
    const id=item().agent.agent_id; b.runtime.flushAgent=async()=>false;
    await b.runtime.admitViewInput(id,caller,"TIMEOUT_CHILD");
    await until(()=>item().tasks[1]?.phase==="running","running",item);
    await b.runtime.admitViewInput(id,caller,"CANCELLED_OLD_TASK_INPUT");
    await b.host.synthesizeMailboxDelivery({agentId:id,at:new Date().toISOString()});
    if(sent) assert.equal((await b.host.sendOwnerEvents({agentId:id,runtimeGeneration:item().agent.runtime_generation,at:new Date().toISOString()})).ok,true);
    await b.host.closeAgent({request_id:randomUUID(),caller,input:{target:id,force:true}});
    assert.equal(item().agent.lifecycle,"closed"); assert.equal(item().mailbox[0]!.state,"cancelled");
    const event=item().owner_events.find(event=>event.kind==="mailbox_delivery")!; assert.equal(event.state,"cancelled");
    assert.equal(item().agent.last_owner_event_acked_sequence,event.event_sequence);
    b.runtime.flushAgent=original;
    await b.host.resumeAgent({request_id:randomUUID(),caller,input:{target:id}});
    const calls=f.control.providerCalls.length;
    await b.runtime.admitViewInput(id,caller,"NEW_TASK");
    await until(()=>item().tasks[2]?.phase==="settled","new task",item);
    assert.equal(f.control.providerCalls.slice(calls).some(text=>text.includes("CANCELLED_OLD_TASK_INPUT")),false);
    assert.equal(item().completions.length,3);
  }finally{b.runtime.flushAgent=original;await f.close();}
});

test("recovery persists pending mailbox and event cancellation into journal and stays idempotent",{timeout:60000},async()=>{
  const {f,b,item,caller}=await ready(); const original=b.runtime.flushAgent.bind(b.runtime);
  try {
    const id=item().agent.agent_id;b.runtime.flushAgent=async()=>false;
    await b.runtime.admitViewInput(id,caller,"TIMEOUT_CHILD");await until(()=>item().tasks[1]?.phase==="running","running",item);
    await b.runtime.admitViewInput(id,caller,"CANCELLED_OLD_TASK_INPUT");await b.host.synthesizeMailboxDelivery({agentId:id,at:new Date().toISOString()});
    const before=b.host.snapshot(), clock={now:()=>new Date(),liveRuntimeGenerations:new Map()};
    const plan=planRecoveryV1(before,clock)!;assert.ok(plan.mutations.some(m=>m.type==="put"&&m.entity_type==="mailbox"));
    const after=applyJournalMutationsV1(before,before.root.host_revision+1,plan.mutations,"recover-runtime-state");
    assert.equal(after.agents[0]!.mailbox[0]!.state,"cancelled");assert.equal(after.agents[0]!.owner_events.find(event=>event.kind==="mailbox_delivery")!.state,"cancelled");
    assert.equal(after.agents[0]!.agent.lifecycle,"closed");assert.equal(after.agents[0]!.completions.length,2);
    const again=planRecoveryV1(after,clock); if(again)assert.equal(applyJournalMutationsV1(after,after.root.host_revision+1,again.mutations,"recover-runtime-state").agents[0]!.completions.length,2);
  }finally{b.runtime.flushAgent=original;await f.close();}
});

test("Main ending overtakes async spawn preparation and enumerates the final serialized tree",{timeout:60000},async()=>{
 const {f,s,b,item}=await ready();let release!:()=>void,entered=false;const prepare=b.preparation.prepare.bind(b.preparation);
 try {
  b.preparation.prepare=async input=>{entered=true;await new Promise<void>(resolve=>{release=resolve;});return prepare(input);};
  const pending=s.executor(b.mainSessionId)({tool:"spawn_agent",params:{task_name:"during_shutdown",message:"LATE_SHUTDOWN_WORK",fork_turns:"none"},toolCallId:"late",context:f.context});
  await until(()=>entered,"preparing",item);b.scheduler.pause();const ending=b.host.endMainSession();release();
  const result=await pending;await ending;assert.equal(result.details.outcome,"rejected");
  assert.ok(b.host.snapshot().agents.every(item=>item.agent.lifecycle==="closed"));assert.equal(b.host.snapshot().agents.length,1);
  const calls=f.control.providerCalls.length;b.host.reopenBinding();b.scheduler.resume();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.control.providerCalls.length,calls);
 }finally{release?.();await f.close();}
});

test("Main ending rejects an in-flight resume assembly and releases its resident",{timeout:60000},async()=>{
 const {f,b,item,caller}=await ready();let release!:()=>void;
 try {
  const id=item().agent.agent_id;await b.host.closeAgent({request_id:randomUUID(),caller,input:{target:id}});
  let entered=false; const resume=b.runtime.resumeAgent.bind(b.runtime);
  b.runtime.resumeAgent=async (agent,generation)=>{entered=true;await new Promise<void>(resolve=>{release=resolve;});await resume(agent,generation);};
  const pending=b.host.resumeAgent({request_id:randomUUID(),caller,input:{target:id}});
  await until(()=>entered,"resume assembling",item);b.scheduler.pause();const ending=b.host.endMainSession();release();
  const result=await pending;await ending;assert.equal(result.ok,false);assert.equal(item().agent.lifecycle,"closed");assert.equal(b.runtime.residency(id),undefined);
 }finally{release?.();await f.close();}
});

test("Main ending cancels prepared new Task after an async lease and releases the acquired handle",{timeout:60000},async()=>{
 const {f,b,item,caller}=await ready();let release!:()=>void,entered=false;const acquire=b.host.options.leases.acquire;
 try {
  (b.host.options.leases as any).acquire=async (input:any)=>{const handle=await acquire(input);entered=true;await new Promise<void>(resolve=>{release=resolve;});return handle;};
  const id=item().agent.agent_id, pending=b.runtime.admitViewInput(id,caller,"LEASE_AFTER_ENDING");
  const rejected=assert.rejects(pending,/Main session is ending/);
  await until(()=>entered,"lease acquisition",item);b.scheduler.pause();const ending=b.host.endMainSession();release();await rejected;await ending;
  assert.equal(item().tasks.length,1);assert.equal(item().agent.lifecycle,"closed");
  assert.equal(f.control.providerCalls.some(text=>text.includes("LEASE_AFTER_ENDING")),false);
 }finally{(b.host.options.leases as any).acquire=acquire;release?.();await f.close();}
});

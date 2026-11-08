import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSdkFixture, until } from "../fixtures/sdk-runtime.js";

async function ready() {
  const f = await createSdkFixture(); await f.runtime.session.prompt("SPAWN_NONE");
  const service=f.cell.service!,binding=service.binding(f.runtime.session.sessionId)!;
  service.detach(binding.pi!, binding.mainSessionId);
  const diagnostic=()=>({errors:service.diagnostics(),agents:binding.host.snapshot().agents});
  await until(()=>binding.host.snapshot().agents[0]?.tasks[0]?.phase==="settled","initial completion",diagnostic);
  const caller={kind:"main-model" as const,conversation:{kind:"main" as const,session_id:binding.mainSessionId},binding_generation:binding.bindingGeneration};
  const execute=(tool:"spawn_agent"|"send_input"|"close_agent"|"resume_agent",params:unknown)=>service.executor(binding.mainSessionId)({tool,params,toolCallId:tool,context:f.context});
  const send=(target:string,message:string,interrupt=false)=>execute("send_input",{target,message,interrupt});
  return {f,binding,diagnostic,execute,send,caller};
}

test("closed resume assembles one idle execution, preserves permissions and sends zero requests",{timeout:60000},async()=>{
  const {f,binding,diagnostic,execute,send}=await ready();try{
    const agent=binding.host.snapshot().agents[0]!.agent;
    const child=await binding.runtime.childForView(agent.agent_id);assert.ok(child);
    const generation=child.identity.generation,tools=child.session.getActiveToolNames().sort();
    const path=join(binding.store.mainRoot,agent.conversation.relative_path),before=await readFile(path,"utf8"),requests=f.control.providerCalls.length;
    assert.equal((await execute("close_agent",{target:agent.agent_id})).details.outcome,"ok");
    for(const interrupt of [false,true]){const rejected=await send(agent.agent_id,"REJECTED",interrupt);assert.equal(rejected.details.outcome,"rejected");if(rejected.details.outcome==="rejected")assert.equal(rejected.details.error.code,"agent-closed");}
    const [a,b]=await Promise.all([execute("resume_agent",{target:agent.agent_id}),execute("resume_agent",{target:agent.agent_id})]);
    assert.equal(a.details.outcome,"ok");assert.equal(b.details.outcome,"ok");
    const reopened=await binding.runtime.childForView(agent.agent_id);assert.ok(reopened);assert.ok(reopened.identity.generation>generation);
    assert.equal(reopened.session.sessionId,agent.conversation.session_id);assert.deepEqual(reopened.session.getActiveToolNames().sort(),tools);
    assert.equal(binding.host.snapshot().agents[0]!.tasks.length,1);assert.equal(binding.host.snapshot().agents[0]!.agent.lifecycle,"open");
    assert.equal(await readFile(path,"utf8"),before);assert.equal(f.control.providerCalls.length,requests);
    assert.equal((await send(agent.agent_id,"AFTER_RESUME")).details.outcome,"ok");
    await until(()=>binding.host.snapshot().agents[0]?.tasks[1]?.phase==="settled","resumed Task",diagnostic);
    assert.equal(binding.host.snapshot().agents[0]!.tasks[1]!.owner_conversation.kind,"main");
  }finally{await f.close();}
});

test("busy input steers one Task; interrupt starts a new Task before the retained FIFO",{timeout:60000},async()=>{
  const {f,binding,diagnostic,send,caller}=await ready();let release!:()=>void;f.control.responses.set("HOLD_A",new Promise<void>(r=>release=r));
  try{
    const id=binding.host.snapshot().agents[0]!.agent.agent_id;await send(id,"HOLD_A");
    await until(()=>binding.host.snapshot().agents[0]?.tasks[1]?.phase==="running","running A",diagnostic);
    const task=binding.host.snapshot().agents[0]!.tasks[1]!;
    const steer=await send(id,"STEER_A");assert.equal(steer.details.outcome,"ok");if(steer.details.outcome==="ok")assert.equal((steer.details.data as any).task_id,task.task_id);
    await binding.host.followupTask({request_id:randomUUID(),caller,input:{target:id,message:"FIFO_B"}});
    await binding.host.followupTask({request_id:randomUUID(),caller,input:{target:id,message:"FIFO_C"}});
    const result=await send(id,"REPLACEMENT",true);assert.equal(result.details.outcome,"ok");release();
    await until(()=>binding.host.snapshot().agents[0]!.tasks.every(t=>t.phase==="settled"),"all work",diagnostic);
    const tasks=binding.host.snapshot().agents[0]!.tasks;assert.equal(tasks.length,5);assert.equal(tasks[1]!.outcome,"interrupted");
    assert.equal(tasks[1]!.deadline_at_ms,task.deadline_at_ms);assert.equal(tasks[1]!.owner_conversation.session_id,task.owner_conversation.session_id);
    const started=tasks.filter(t=>t.started_at).sort((a,b)=>Date.parse(a.started_at!)-Date.parse(b.started_at!)).map(t=>t.message);
    assert.ok(started.indexOf("REPLACEMENT")<started.indexOf("FIFO_B"));assert.ok(started.indexOf("FIFO_B")<started.indexOf("FIFO_C"));
    assert.equal(binding.host.snapshot().agents[0]!.completions.length,5);
  }finally{release();await f.close();}
});

test("force closes current and queued Tasks exactly once and returns closed after native drain",{timeout:60000},async()=>{
  const {f,binding,diagnostic,execute,send,caller}=await ready();try{
    const id=binding.host.snapshot().agents[0]!.agent.agent_id;await send(id,"TIMEOUT_CHILD");
    await until(()=>binding.host.snapshot().agents[0]?.tasks[1]?.phase==="running","busy",diagnostic);
    await binding.host.followupTask({request_id:randomUUID(),caller,input:{target:id,message:"QUEUED"}});
    assert.equal((await execute("close_agent",{target:id})).details.outcome,"rejected");
    const result=await execute("close_agent",{target:id,force:true});assert.equal(result.details.outcome,"ok");
    await until(()=>binding.host.snapshot().agents[0]!.agent.lifecycle==="closed","closed",diagnostic);
    const item=binding.host.snapshot().agents[0]!;assert.deepEqual(item.tasks.slice(1).map(t=>t.outcome),["interrupted","interrupted"]);assert.equal(item.tasks[2]!.started_at,undefined);assert.equal(item.completions.length,3);assert.equal(binding.runtime.residency(id),undefined);
    assert.equal((await execute("close_agent",{target:id,force:true})).details.outcome,"ok");assert.equal(binding.host.snapshot().agents[0]!.completions.length,3);
  }finally{await f.close();}
});

test("Main and user new Tasks on a grandchild return to Main even with its structural parent closed",{timeout:60000},async()=>{
  const {f,binding,diagnostic,execute,send}=await ready();try{
    assert.equal((await execute("spawn_agent",{task_name:"parent",message:"NESTED_PARENT"})).details.outcome,"ok");
    await until(()=>binding.host.snapshot().agents.some(i=>i.agent.task_name==="parent"&&i.tasks[0]?.phase==="settled"),"nested completed",diagnostic);
    const grand=binding.host.snapshot().agents.find(i=>i.agent.task_name==="grandchild")!,parent=binding.host.snapshot().agents.find(i=>i.agent.task_name==="parent")!;
    assert.equal(grand.tasks[0]!.owner_conversation.agent_id,parent.agent.agent_id);
    assert.equal((await send(grand.agent.agent_id,"MAIN_NEW_TASK")).details.outcome,"ok");
    await until(()=>binding.host.snapshot().agents.find(i=>i.agent.agent_id===grand.agent.agent_id)?.tasks[1]?.phase==="settled","Main grandchild result",diagnostic);
    assert.equal((await execute("close_agent",{target:parent.agent.agent_id})).details.outcome,"ok");
    assert.equal((await execute("resume_agent",{target:grand.agent.agent_id})).details.outcome,"ok");
    await binding.runtime.admitViewInput(grand.agent.agent_id,{kind:"user",main_session_id:binding.mainSessionId,binding_generation:binding.bindingGeneration,manager_generation:1},"USER_NEW_TASK");
    await until(()=>binding.host.snapshot().agents.find(i=>i.agent.agent_id===grand.agent.agent_id)?.tasks[2]?.phase==="settled","user grandchild result",diagnostic);
    const item=binding.host.snapshot().agents.find(i=>i.agent.agent_id===grand.agent.agent_id)!;assert.equal(item.tasks[2]!.initiator.kind,"user");assert.equal(item.tasks[2]!.owner_conversation.kind,"main");assert.equal(item.completions[2]!.recipient.kind,"main");assert.equal(binding.host.snapshot().agents.find(i=>i.agent.agent_id===parent.agent.agent_id)!.agent.lifecycle,"closed");
    assert.equal((await execute("close_agent",{target:parent.agent.agent_id})).details.outcome,"ok");assert.equal(binding.host.snapshot().agents.find(i=>i.agent.agent_id===grand.agent.agent_id)!.agent.lifecycle,"closed");
  }finally{await f.close();}
});

test("activated wait retains its barrier and deadline while a full active pool queues input",{timeout:60000},async()=>{
 const {f,binding,diagnostic,execute,send}=await ready();let leafRelease!:()=>void,busyRelease!:()=>void;
 f.control.responses.set("HOLD_LEAF",new Promise<void>(r=>leafRelease=r));f.control.responses.set("HOLD_SLOT",new Promise<void>(r=>busyRelease=r));
 try{
  await execute("spawn_agent",{task_name:"waiter",message:"NESTED_PARENT"});
  await until(()=>binding.host.snapshot().agents.find(i=>i.agent.task_name==="waiter")?.tasks[0]?.phase==="waiting","waiter parked",diagnostic);
  const parent=binding.host.snapshot().agents.find(i=>i.agent.task_name==="waiter")!,before=structuredClone(parent.tasks[0]!);
  binding.scheduler.options.coordinator.updateHostLimits(binding.scheduler.token,{activeTasksPerMain:2});
  await execute("spawn_agent",{task_name:"busy",message:"HOLD_SLOT"});await until(()=>binding.runtime.residency(binding.host.snapshot().agents.find(i=>i.agent.task_name==="busy")!.agent.agent_id)?.state==="active","slots held",diagnostic);
  await send(parent.agent.agent_id,"WAIT_INPUT");
  await until(()=>binding.scheduler.options.coordinator.snapshot().queuedCount>0,"waiting activation queued",diagnostic);
  assert.equal(binding.runtime.residency(parent.agent.agent_id)?.state,"waiting");assert.ok(binding.scheduler.options.coordinator.snapshot().queuedCount>0);
  busyRelease();
  await until(()=>{const p=binding.host.snapshot().agents.find(i=>i.agent.agent_id===parent.agent.agent_id)!;return p.mailbox.some(m=>m.state==="injected")&&binding.runtime.residency(parent.agent.agent_id)?.state==="waiting";},"input ran then parked",diagnostic);
  const after=binding.host.snapshot().agents.find(i=>i.agent.agent_id===parent.agent.agent_id)!;
  assert.equal(after.tasks.length,1);assert.equal(after.tasks[0]!.phase,"waiting");assert.deepEqual(after.tasks[0]!.waiting_on,before.waiting_on);assert.equal(after.tasks[0]!.deadline_at_ms,before.deadline_at_ms);assert.equal(after.barrier!.state,"armed");assert.equal(after.completions.length,0);
  leafRelease();await until(()=>binding.host.snapshot().agents.find(i=>i.agent.agent_id===parent.agent.agent_id)?.tasks[0]?.phase==="settled","wait completed",diagnostic);
 }finally{leafRelease();busyRelease();await f.close();}
});

test("resume does not compact oversized history; only a granted Task may run preflight",{timeout:60000},async()=>{
 const {f,binding,execute,send,diagnostic}=await ready();try{
  const item=binding.host.snapshot().agents[0]!,id=item.agent.agent_id;await execute("close_agent",{target:id});
  const {SessionManager}=await import("@earendil-works/pi-coding-agent");const path=join(binding.store.mainRoot,item.agent.conversation.relative_path),manager=SessionManager.open(path);
  manager.appendMessage({role:"user",content:[{type:"text",text:"history ".repeat(15000)}],timestamp:Date.now()});
  const count=f.control.providerCalls.length,bytes=await readFile(path,"utf8");
  assert.equal((await execute("resume_agent",{target:id})).details.outcome,"ok");assert.equal(f.control.providerCalls.length,count);assert.equal(await readFile(path,"utf8"),bytes);assert.equal(binding.host.snapshot().agents[0]!.tasks.length,1);
  await send(id,"PREFLIGHT_AFTER_GRANT");await until(()=>binding.host.snapshot().agents[0]!.tasks[1]?.phase==="settled","oversized grant fails locally",diagnostic);assert.equal(f.control.providerCalls.length,count);
 }finally{await f.close();}
});

test("force close cancels a waiting subtree before any parent can request another provider turn",{timeout:60000},async()=>{
 const {f,binding,diagnostic,execute}=await ready();let release!:()=>void;f.control.responses.set("HOLD_LEAF",new Promise<void>(r=>release=r));
 try{
  await execute("spawn_agent",{task_name:"parent",message:"NESTED_PARENT"});await until(()=>binding.host.snapshot().agents.find(i=>i.agent.task_name==="parent")?.tasks[0]?.phase==="waiting","parent wait",diagnostic);
  const count=f.control.providerCalls.length,result=await execute("close_agent",{target:"/root/parent",force:true});assert.equal(result.details.outcome,"ok");release();
  await until(()=>binding.host.snapshot().agents.filter(i=>i.agent.task_path.startsWith("/root/parent")).every(i=>i.agent.lifecycle==="closed"),"subtree closed",diagnostic);
  const items=binding.host.snapshot().agents.filter(i=>i.agent.task_path.startsWith("/root/parent"));assert.equal(items.length,2);assert.ok(items.every(i=>i.tasks[0]!.outcome==="interrupted"&&i.completions.length===1));assert.equal(items.find(i=>i.agent.depth===1)!.barrier!.state,"cancelled");assert.equal(f.control.providerCalls.length,count);
 }finally{release();await f.close();}
});

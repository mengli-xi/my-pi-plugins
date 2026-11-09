import assert from "node:assert/strict";
import test from "node:test";
import { freshHost } from "../fixtures/fresh-host.ts";

test("stock faux 32-open admission and parallel resume share one capacity decision",{timeout:180000},async t=>{
 const f=await freshHost(t);await f.rpc("prompt",{message:"/subagents-test-spawn"});await f.settled();
 for(let n=1;n<32;n++)assert.equal((await f.control("spawn_agent",{task_name:`cap_${n}`,message:"Reply exactly SUBAGENT_OK"})).details.outcome,"ok");
 const state=await f.settled(32);assert.equal(state.snapshot.agents.filter((i:any)=>i.agent.lifecycle==="open").length,32);
 assert.equal((await f.control("spawn_agent",{task_name:"over",message:"Reply exactly SUBAGENT_OK"})).details.error.code,"open-agent-capacity");
 const targets=state.snapshot.agents.slice(0,2).map((i:any)=>i.agent.agent_id);for(const target of targets)assert.equal((await f.control("close_agent",{target})).details.outcome,"ok");
 assert.equal((await f.control("spawn_agent",{task_name:"vacancy",message:"Reply exactly SUBAGENT_OK"})).details.outcome,"ok");
 const results=await f.control("parallel-resume",{targets});assert.equal(results.filter((r:any)=>r.ok).length,1);assert.equal(results.filter((r:any)=>!r.ok&&r.error.code==="open-agent-capacity").length,1);
 assert.equal((await f.snapshot()).snapshot.agents.filter((i:any)=>i.agent.lifecycle!=="closed").length,32);f.assertNoChildPi();await f.stop();
});

test("stock depth-two Main/user input to a resumed grandchild owns results without resuming its parent",{timeout:90000},async t=>{
 const f=await freshHost(t,"NEST_PARENT",false,2);await f.rpc("prompt",{message:"/subagents-test-spawn"});const state=await f.settled(2);
 const parent=state.snapshot.agents.find((i:any)=>i.agent.depth===1),grand=state.snapshot.agents.find((i:any)=>i.agent.depth===2);assert.equal(grand.tasks[0].owner_conversation.agent_id,parent.agent.agent_id);
 assert.ok(!state.residents.find((r:any)=>r.agentId===grand.agent.agent_id).activeTools.includes("spawn_agent"));
 await f.control("send_input",{target:grand.agent.agent_id,message:"FOLLOWUP_SECOND"});const main=await f.settled(3);assert.equal(main.snapshot.agents.find((i:any)=>i.agent.agent_id===grand.agent.agent_id).completions[1].recipient.kind,"main");
 await f.control("close_agent",{target:parent.agent.agent_id});await f.control("resume_agent",{target:grand.agent.agent_id});
 await f.control("user-input",{message:"FOLLOWUP_SECOND"},grand.agent.agent_id);const after=await f.settled(4),item=after.snapshot.agents.find((i:any)=>i.agent.agent_id===grand.agent.agent_id);
 assert.equal(item.tasks[2].initiator.kind,"user");assert.equal(item.completions[2].recipient.kind,"main");assert.equal(after.snapshot.agents.find((i:any)=>i.agent.agent_id===parent.agent.agent_id).agent.lifecycle,"closed");await f.stop();
});

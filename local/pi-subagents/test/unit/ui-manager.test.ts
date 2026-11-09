import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SubagentManagerV1, runAgentActionV1 } from "../../src/ui/manager.js";
import { SubagentStripV1, subagentStripCountsV1, layoutSubagentStripV1 } from "../../src/ui/strip.js";
initTheme(undefined,false);
const theme = {fg:(_c:string,s:string)=>s,bg:(_c:string,s:string)=>s,bold:(s:string)=>s,italic:(s:string)=>s} as any;
const tui = {requestRender(){},terminal:{rows:24,columns:100}} as any;
function fixture() {
  const task:any={task_id:"tsk",phase:"running",runtime_generation:1,admission_order:1,admitted_at:new Date().toISOString()};
  const partition:any={agent:{agent_id:"agt",task_name:"worker",task_path:"/root/worker",depth:1,lifecycle:"open",lifecycle_revision:1,availability:"available",current_task_id:"tsk",queued_task_ids:[],created_revision:1,created_at:new Date().toISOString(),profile:{provider:"fixture",model:"faux",reasoning_effort:"off"}},tasks:[task],completions:[],inbox:[]};
  const calls:any[]=[], snapshot:any={root:{host_revision:1,inbox:[]},agents:[partition]};
  const binding:any={mainSessionId:"main",bindingGeneration:1,config:{capacity:{openAgentsPerMain:32}},runtime:{residency:()=>undefined},host:{snapshot:()=>snapshot,closeAgent:async (i:any)=>{calls.push(["close",i]);return{ok:true,value:{lifecycle:"closed"}};},resumeAgent:async(i:any)=>{calls.push(["resume",i]);return{ok:true,value:{}};},interruptAgent:async(i:any)=>{calls.push(["interrupt",i]);return{ok:true,value:{}};},deleteSettledSubtree:async(i:any)=>{calls.push(["delete",i]);return{ok:true,value:{deleted_agents:1}};}}};
  return {task,partition,calls,snapshot,binding};
}
test("list routes Enter/X/C/D, ignores M/F, and only closed rows expose R",()=>{
 const f=fixture();let result:any;const panel=new SubagentManagerV1(tui,theme,f.binding,r=>{result=r;});panel.focused=true;
 try {
  for(const [key,action] of [["\r","conversation"],["x","interrupt"],["c","close-agent"],["d","delete"]]){panel.handleInput(key!);assert.deepEqual(result,{action,agentId:"agt"});}
  result=undefined;for(const key of ["m","f","r"])panel.handleInput(key);assert.equal(result,undefined);
  panel.handleInput("\t");f.task.phase="settled";f.task.outcome="interrupted";f.partition.agent.current_task_id=undefined;f.partition.agent.lifecycle="closed";panel.render(100);panel.handleInput("r");assert.deepEqual(result,{action:"resume",agentId:"agt"});
 }finally{panel.dispose();}
});
test("list rows expose each frozen provider/model@effort in Running and Done, not only selected detail",()=>{
 const f=fixture(),second=structuredClone(f.partition);second.agent.agent_id="agt2";second.agent.task_name="second";second.agent.task_path="/root/second";second.agent.profile={provider:"alternate",model:"chosen",reasoning_effort:"high"};second.tasks[0].admission_order=2;f.snapshot.agents.push(second);
 const panel=new SubagentManagerV1(tui,theme,f.binding,()=>{});panel.focused=true;
 try{
  const check=()=>{const rows=panel.render(100);assert.match(rows.find(line=>/worker\s+\[/.test(line))??"",/fixture\/faux@off/);assert.match(rows.find(line=>/second\s+\[/.test(line))??"",/alternate\/chosen@high/);};
  check();assert.equal(panel.selectedId,"agt","the unselected row must also show its own model");
  for(const row of f.snapshot.agents){row.tasks[0].phase="settled";row.tasks[0].outcome="completed";row.agent.current_task_id=undefined;}
  panel.handleInput("\t");check();
 }finally{panel.dispose();}
});
test("C idle closes without confirm; busy uses explicit force confirmation and defaults cancel",async()=>{
 const f=fixture(),questions:any[]=[];const ctx:any={ui:{notify(){},select:async(...q:any[])=>{questions.push(q);return "Cancel";}}};
 assert.equal(await runAgentActionV1(ctx,f.binding,"agt","close-agent"),"Cancelled.");assert.equal(f.calls.length,0);assert.match(questions[0][0],/1 Task.*0 descendant/);
 ctx.ui.select=async()=>"Force close";await runAgentActionV1(ctx,f.binding,"agt","close-agent");assert.equal(f.calls[0][1].input.force,true);assert.equal(f.calls[0][1].input.expected_lifecycle_revision,1);
 f.task.phase="settled";f.partition.agent.current_task_id=undefined;questions.length=0;ctx.ui.select=async(...q:any[])=>{questions.push(q);return "Cancel";};await runAgentActionV1(ctx,f.binding,"agt","close-agent");assert.equal(questions.length,0);assert.equal(f.calls[1][1].input.force,false);
});
test("X queued-only does not cancel queue and R calls resume without a read receipt",async()=>{
 const f=fixture();f.partition.agent.current_task_id=undefined;f.task.phase="admitted";f.partition.agent.queued_task_ids=["tsk"];
 assert.match(await runAgentActionV1({ui:{notify(){}}} as any,f.binding,"agt","interrupt"),/No current Task/);assert.equal(f.calls.length,0);
 f.partition.agent.lifecycle="closed";await runAgentActionV1({ui:{notify(){}}} as any,f.binding,"agt","resume");assert.deepEqual(f.calls.map(c=>c[0]),["resume"]);
});
test("D never force-closes unfinished work and does not delete while close cleanup is pending",async()=>{
 const f=fixture(),notices:string[]=[];let confirmations=0;
 const ctx:any={ui:{confirm:async()=>{confirmations++;return true;},notify:(message:string)=>notices.push(message)}};
 f.binding.host.closeAgent=async(i:any)=>{f.calls.push(["close",i]);return{ok:false,error:{message:"agent-busy: unfinished Task"}};};
 assert.match(await runAgentActionV1(ctx,f.binding,"agt","delete"),/Failed: agent-busy/);
 assert.equal(f.calls[0][1].input.force,false);assert.equal(f.calls[0][1].expected_host_revision,1);
 assert.equal(f.task.phase,"running");assert.deepEqual(f.calls.map(c=>c[0]),["close"]);assert.equal(notices.length,1);
 f.task.phase="settled";f.partition.agent.current_task_id=undefined;
 f.binding.host.closeAgent=async(i:any)=>{f.calls.push(["close",i]);f.partition.agent.lifecycle="closing";return{ok:true,value:{lifecycle:"closing",cleanup_pending:true}};};
 assert.match(await runAgentActionV1(ctx,f.binding,"agt","delete"),/still closing/);
 assert.deepEqual(f.calls.map(c=>c[0]),["close","close"]);assert.equal(confirmations,2);
});
test("D cancellation leaves open idle execution alone and already closed deletion retains its confirmed revision",async()=>{
 const f=fixture();f.task.phase="settled";f.partition.agent.current_task_id=undefined;
 assert.equal(await runAgentActionV1({ui:{confirm:async()=>false}} as any,f.binding,"agt","delete"),"Cancelled.");
 assert.equal(f.calls.length,0);assert.equal(f.partition.agent.lifecycle,"open");
 f.partition.agent.lifecycle="closed";
 await runAgentActionV1({ui:{confirm:async()=>{f.binding.host.snapshot=()=>({...f.snapshot,root:{...f.snapshot.root,host_revision:2}});return true;}}} as any,f.binding,"agt","delete");
 assert.deepEqual(f.calls.map(c=>c[0]),["delete"]);assert.equal(f.calls[0][1].expectedRevision,1);
});
test("stable selection survives reorder; missing row uses nearest neighbor and tab remains selected",()=>{
 const f=fixture();const second=structuredClone(f.partition);second.agent.agent_id="agt2";second.agent.task_name="second";second.agent.task_path="/root/second";second.tasks[0].admission_order=2;f.snapshot.agents.push(second);
 const panel=new SubagentManagerV1(tui,theme,f.binding,()=>{});panel.focused=true;
 try{panel.handleInput("\x1b[B");assert.equal(panel.selectedId,"agt2");second.tasks[0].admission_order=0;panel.render(100);assert.equal(panel.selectedId,"agt2");f.snapshot.agents.pop();panel.render(100);assert.equal(panel.selectedId,"agt");f.task.phase="settled";f.partition.agent.current_task_id=undefined;panel.render(100);assert.equal(panel.selectedId,undefined);}finally{panel.dispose();}
});
test("strip retains idle/closed totals, collapses width and opens once on mouse press",()=>{
 const f=fixture();let opens=0;const strip=new SubagentStripV1(tui,theme,f.binding,()=>{opens++;});
 try{assert.equal(subagentStripCountsV1(f.binding).running,1);assert.match(layoutSubagentStripV1(subagentStripCountsV1(f.binding),80),/agents 1 · running 1/);f.task.phase="settled";f.partition.agent.current_task_id=undefined;assert.equal(layoutSubagentStripV1(subagentStripCountsV1(f.binding),80),"agents 1");strip.render(40);assert.equal(strip.handleClick(0,35),true);assert.equal(opens,1);assert.equal(strip.handleMouse({type:"click",button:"left",x:35,y:0} as any),undefined);f.snapshot.agents=[];assert.deepEqual(strip.render(40),[]);}finally{strip.dispose();}
});

test("strip timer requests a render only when the displayed text changes",t=>{
 t.mock.timers.enable({apis:["setInterval"]});
 const f=fixture(),agents=[...f.snapshot.agents];let renders=0,ready=false;
 const strip=new SubagentStripV1({requestRender(){renders++;}} as any,theme,()=>ready?f.binding:undefined,()=>{});
 try {
  assert.deepEqual(strip.render(40),[]);t.mock.timers.tick(1000);assert.equal(renders,0);
  ready=true;f.snapshot.agents=[];t.mock.timers.tick(1000);assert.equal(renders,0);
  f.snapshot.agents=agents;t.mock.timers.tick(250);assert.equal(renders,1);
  assert.match(strip.render(40).join(""),/running 1/);t.mock.timers.tick(1000);assert.equal(renders,1);
  f.task.phase="settled";f.partition.agent.current_task_id=undefined;
  t.mock.timers.tick(250);assert.equal(renders,2);strip.render(40);t.mock.timers.tick(1000);assert.equal(renders,2);
  // At a narrow width the running count is hidden, so changing it needs no repaint.
  strip.render(8);f.task.phase="running";f.partition.agent.current_task_id="tsk";
  t.mock.timers.tick(250);assert.equal(renders,2);
  f.snapshot.agents=[];t.mock.timers.tick(250);assert.equal(renders,3);strip.render(8);
  t.mock.timers.tick(1000);assert.equal(renders,3);
 }finally{strip.dispose();}
});

test("action round trip retains the user's tab and selection after all work completes",()=>{
 const f=fixture(),selection:any={};let panel=new SubagentManagerV1(tui,theme,f.binding,()=>{},undefined,selection);panel.focused=true;
 panel.handleInput("\t");panel.render(100);assert.equal(selection.tab,"done");panel.dispose();
 f.task.phase="settled";f.partition.agent.current_task_id=undefined;panel=new SubagentManagerV1(tui,theme,f.binding,()=>{},"Agent restored",selection);panel.focused=true;
 try{assert.equal(panel.selectedId,"agt");assert.match(panel.render(100).join("\n"),/Done/);}finally{panel.dispose();}
});

test("scrolled mouse rows keep stable Agent IDs despite overlapping or clipped names",()=>{
 const f=fixture();f.task.phase="settled";f.task.outcome="completed";f.partition.agent.current_task_id=undefined;
 const rows=Array.from({length:20},(_,index)=>{const row=structuredClone(f.partition);row.agent.agent_id=`agt${index}`;row.agent.task_name=index===19?"worker":`worker${index}`;row.agent.task_path=`/root/${row.agent.task_name}`;row.tasks[0].settled_at=new Date(Date.UTC(2026,9,17,0,0,index)).toISOString();return row;});
 for(const row of rows){row.agent.created_at="2026-10-16T00:00:00.000Z";row.tasks[0].admitted_at="2026-10-16T00:00:01.000Z";}
 f.snapshot.agents=rows;let opened:any;const panel=new SubagentManagerV1(tui,theme,f.binding,result=>{opened=result;});panel.focused=true;
 try {
  for(let index=0;index<12;index++)panel.handleInput("\x1b[B");
  const rendered=panel.render(100),first=rendered.findIndex(line=>/^\s*(?:→ )?worker18\s+\[/.test(line));assert.ok(first>=0);assert.equal(rendered.some(line=>/^\s*(?:→ )?worker\s+\[/.test(line)),false);
  const press=(row:number,x=4)=>panel.handleMouse({type:"press",button:"left",x,y:row} as any);
  press(first);assert.deepEqual(opened,{action:"conversation",agentId:"agt18"});
  opened=undefined;press(first,-1);press(first,100);assert.equal(opened,undefined);
  // All visible names disappear under width clipping, but identity still comes from layout.
  panel.render(5);press(first,2);assert.deepEqual(opened,{action:"conversation",agentId:"agt18"});
  opened=undefined;panel.handleInput("\x1b[B");press(first);assert.equal(opened,undefined,"input invalidates the old frame until render");
  panel.render(100);const current=panel.render(100),second=current.findIndex(line=>/^\s*(?:→ )?worker17\s+\[/.test(line));assert.ok(second>=0);press(second);assert.deepEqual(opened,{action:"conversation",agentId:"agt17"});
 } finally {panel.dispose();}
});

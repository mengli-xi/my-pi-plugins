import assert from "node:assert/strict";
import test from "node:test";
import { agentPresentation } from "../../src/ui/agent-presentation.js";
const at="2026-10-17T00:00:00Z";
function row(id:string,phase?:string,options:any={}) {return {agent:{agent_id:id,task_name:id,task_path:`/root/${id}`,depth:1,lifecycle:"open",availability:"available",queued_task_ids:[],created_at:at,created_revision:1,...options.agent},tasks:phase?[{task_id:id,phase,admission_order:1,admitted_at:at,...options.task}]:[],completions:[],inbox:[]} as any;}
function state(agents:any[]) {return {root:{host_revision:1,inbox:[]},agents} as any;}
for(const [phase,lifecycle,group,label] of [["starting","open","running","starting"],["running","open","running","running"],["waiting","open","waiting","waiting"],["admitted","open","queued","queued"],["settled","open",undefined,"completed"],[undefined,"open",undefined,"idle"],["settled","closed",undefined,"interrupted"],["settled","closing","closing","closing"]] as const) test(`presentation ${phase}/${lifecycle}`,()=>{
 const p=agentPresentation(state([row("a",phase,{agent:{lifecycle},task:{outcome:lifecycle==="closed"?"interrupted":"completed"}})]));
 assert.equal(p.rows[0]!.group,group);assert.equal(p.rows[0]!.labels[0]!.text,label);assert.equal(p.counts.active+p.counts.done,1);assert.equal(p.counts.open,lifecycle==="closed"?0:1);
});
test("waiting activation distinguishes active, parked and slot-queued; FIFO counts Agents not Tasks",()=>{
 const a=row("a","waiting",{task:{activation_order:2}}),b=row("b","admitted",{agent:{queued_task_ids:["b","c","d"]}});
 const p=agentPresentation(state([a,b]),new Map([["a",{state:"active"}]]));assert.equal(p.counts.running,1);assert.equal(p.counts.queued,1);assert.equal(p.rows[1]!.queued,3);
 const parked=agentPresentation(state([a,b]));assert.equal(parked.counts.waiting,1);assert.ok(parked.rows[0]!.labels.some(l=>l.text==="activation queued"));
});
test("tree ranks matching subtrees, retains muted ancestor, and ignores elapsed time for sorting",()=>{
 const parent=row("parent","settled",{task:{outcome:"completed"}}),child=row("child","running",{agent:{parent_agent_id:"parent",depth:2,task_path:"/root/parent/child"},task:{admission_order:1}}),other=row("other","waiting",{task:{admission_order:0}});
 const p=agentPresentation(state([other,child,parent]));assert.deepEqual(p.tabs.running.map(r=>[r.partition.agent.agent_id,r.muted]),[["parent",true],["child",false],["other",false]]);assert.equal(p.counts.active,2);
 child.tasks[0].started_at="1900-01-01T00:00:00Z";assert.deepEqual(agentPresentation(state([other,child,parent])).tabs.running.map(r=>r.partition.agent.agent_id),p.tabs.running.map(r=>r.partition.agent.agent_id));
});
test("Done unread first then latest close/settle, unavailable is additive, unique Inbox totals",()=>{
 const a=row("a","settled",{task:{outcome:"completed",settled_at:at}}),b=row("b",undefined,{agent:{lifecycle:"closed",closed_at:"2026-10-18T00:00:00Z",availability:"unavailable"}});
 a.completions=[{completion_id:"cmp"}];b.inbox=[{inbox_id:"inb",completion_id:"cmp",recipient:{agent_id:"b"},state:"appended"}];
 const p=agentPresentation(state([b,a]));assert.equal(p.counts.unread,1);assert.equal(p.rows.reduce((n,r)=>n+r.unread,0),2);assert.ok(p.rows[0]!.labels.some(l=>l.text==="unavailable"));assert.deepEqual(p.tabs.done.map(r=>r.partition.agent.agent_id),["b","a"]);
 b.inbox[0].ui_read_at=at;assert.equal(agentPresentation(state([b,a])).counts.unread,0);
});

test("Running sibling order is execution, waiting, queued, cleanup; Done outcomes keep theme tokens",()=>{
 const rows=[row("cleanup","settled",{agent:{lifecycle:"closing"}}),row("queued","admitted"),row("waiting","waiting"),row("starting","starting"),row("running","running",{task:{admission_order:0}})];
 assert.deepEqual(agentPresentation(state(rows)).tabs.running.map(row=>row.partition.agent.agent_id),["running","starting","waiting","queued","cleanup"]);
 for(const [outcome,tone] of [["completed","success"],["partial","warning"],["blocked","warning"],["interrupted","warning"],["failed","error"]])assert.equal(agentPresentation(state([row(outcome!,"settled",{task:{outcome}})])).rows[0]!.labels[0]!.tone,tone);
});

import {test}from"node:test";
import assert from"node:assert/strict";
import {createHash}from"node:crypto";
import {resolveCompactionSkills}from"../compact-recovery.ts";
test("compaction recovery uses real complete binding version and rejects forged path/hash",()=>{
 const contents="required skill rules";
 const ref={sourceEntryId:"s1",name:"work",path:"/SKILL.md",contentHash:createHash("sha256").update(contents).digest("hex")};
 const branch:any[]=[{type:"custom",id:"s1",customType:"pi-skills:binding-v1",data:{version:1,skills:[{name:ref.name,path:ref.path,contents}]}}];
 assert.equal(resolveCompactionSkills(branch,[ref])[0].contents,contents);
 assert.throws(()=>resolveCompactionSkills(branch,[{...ref,contentHash:"wrong"}]));
 assert.throws(()=>resolveCompactionSkills(branch,[{...ref,sourceEntryId:"missing"}]));
 assert.throws(()=>resolveCompactionSkills(branch,[{...ref,path:"/forged/SKILL.md"}]));
 branch[0].data.skills[0].truncated=true;assert.throws(()=>resolveCompactionSkills(branch,[ref]));
});

import { installCompactionSkillRecovery } from "../compact-recovery.ts";
function recoveryHarness(embedded = false) {
 const contents="EXACT_RULES", ref={sourceEntryId:"s1",name:"work",path:"/SKILL.md",contentHash:createHash("sha256").update(contents).digest("hex")};
 const branch:any[]=[{type:"custom",id:"s1",customType:"pi-skills:binding-v1",data:{version:1,skills:[{name:ref.name,path:ref.path,contents}]}},{type:"compaction",id:"c",details:{operationId:"op",...(embedded?{recovery:{version:1,items:[{owner:"pi-skills",customType:"pi-skills:compact-restored-v1",identity:{skills:[ref]}}]}}:{})}}];
 const hooks=new Map<string,any>(),bus=new Map<string,any>(),sent:any[]=[],notices:string[]=[],responses:any[]=[];
 let aborted=false;
 const ctx:any={sessionManager:{getSessionId:()=>"session",getBranch:()=>branch},ui:{notify:(text:string)=>notices.push(text)},abort:()=>{aborted=true;}};
 installCompactionSkillRecovery({on:(key:string,fn:any)=>hooks.set(key,fn),events:{on:(key:string,fn:any)=>{bus.set(key,fn);return()=>bus.delete(key);},emit:(key:string,value:any)=>responses.push({key,value})},sendMessage:(message:any,options:any)=>sent.push({message,options})}as any);
 hooks.get("session_start")({},ctx);
 return{hooks,bus,sent,ctx,branch,ref,notices,responses,get aborted(){return aborted;}};
}
test("legacy nextTurn restoration and pending-message verification remain unchanged",()=>{
 const h=recoveryHarness();
 h.bus.get("pi-skills:compact-restore-request-v1")({version:1,sessionId:"session",operationId:"op",skills:[h.ref],beforeAgentStart:true});
 assert.equal(h.sent.length,1);assert.match(h.sent[0].message.content,/EXACT_RULES/);
 assert.deepEqual(h.sent[0].options,{triggerTurn:false,deliverAs:"nextTurn"});
 h.hooks.get("context")({},h.ctx);assert.equal(h.aborted,true);
});
test("collection renders proven versions synchronously and embedded records need no standalone verification",()=>{
 const h=recoveryHarness(true),replies:any[]=[];
 h.bus.get("pi-session-compact:collect-recovery-v1")({version:1,sessionId:"session",operationId:"op",restoreSkills:[h.ref],reply:(item:any)=>replies.push(item)});
 assert.equal(replies.length,1);assert.match(replies[0].content,/<skill>[\s\S]*EXACT_RULES/);
 assert.deepEqual(replies[0].covers,["pi-skills:binding-v1","pi-skill-mentions:binding-v1","pi-skills:agent-read-v1"]);
 h.bus.get("pi-skills:compact-restore-request-v1")({version:1,sessionId:"session",operationId:"op",skills:[h.ref]});
 h.hooks.get("context")({},h.ctx);assert.equal(h.sent.length,0);assert.equal(h.aborted,false);
});

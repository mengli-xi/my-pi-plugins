import{test}from"node:test";import assert from"node:assert/strict";
import{mkdtemp,mkdir,writeFile,symlink,rm}from"node:fs/promises";import{tmpdir}from"node:os";import{join}from"node:path";
import{createEventBus}from"@earendil-works/pi-coding-agent";
import{collectMaterials}from"../src/materials.ts";
const ctx:any={sessionManager:{getSessionId:()=>"s"}};
// Fake owner: answers the copied pi-cc-memory request contract with a fixed response, or not at all.
const memoryOwner=(response?:Record<string,unknown>)=>{const events=createEventBus();if(response)events.on("cc-memory:request:project-v1",(raw:any)=>raw.reply({version:1,sessionId:raw.sessionId,...response}));return{events}as any;};
test("no memory owner reply reads no memory and records no uncertainty",async()=>{
 const result=await collectMaterials(memoryOwner(),ctx,join(tmpdir(),"no-agent"),[]);
 assert.deepEqual(result.memory,[]);assert.deepEqual(result.known,[]);
});
test("memoryDir:null reply reads no memory and records the owner's reason",async()=>{
 const result=await collectMaterials(memoryOwner({memoryDir:null,reason:"OWNER_REASON"}),ctx,join(tmpdir(),"no-agent"),[]);
 assert.deepEqual(result.memory,[]);assert.equal(result.known.length,1);assert.equal(result.known[0]!.kind,"memory-source");assert.match(result.known[0]!.statement,/OWNER_REASON/);
});
test("replied memory index and topics share realpath containment and report escaped symlinks",async()=>{
 const root=await mkdtemp(join(tmpdir(),"compact-materials-"));try{const agent=join(root,"agent"),dir=join(agent,"pi-cc-memory/projects","a".repeat(64),"memory");await mkdir(dir,{recursive:true});const outside=join(root,"outside.md");await writeFile(outside,"OUTSIDE_CURRENT_AGENT_DIR");await symlink(outside,join(dir,"MEMORY.md"));const pi=memoryOwner({memoryDir:dir,identity:"dir:/fixture"});let result=await collectMaterials(pi,ctx,agent,[]);assert.equal(result.memory.length,0);assert.equal(result.known[0]!.kind,"memory-source");assert.match(result.known[0]!.statement,/outside project/);await rm(join(dir,"MEMORY.md"));await writeFile(join(dir,"MEMORY.md"),"- [Topic](topic.md)");await symlink(outside,join(dir,"topic.md"));result=await collectMaterials(pi,ctx,agent,[]);assert.equal(result.memory.length,1);assert.ok(!JSON.stringify(result.memory).includes("OUTSIDE_CURRENT_AGENT_DIR"));assert.equal(result.known[0]!.kind,"memory-source");
 const escaped=join(root,"outside-tree");await mkdir(escaped);result=await collectMaterials(memoryOwner({memoryDir:escaped,identity:"dir:/fixture"}),ctx,agent,[]);assert.equal(result.memory.length,0);assert.match(result.known[0]!.statement,/outside owner's project tree/);}finally{await rm(root,{recursive:true,force:true});}
});

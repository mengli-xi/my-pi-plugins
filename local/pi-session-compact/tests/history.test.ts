import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,appendFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {join}from"node:path";
import {SessionHistory,searchHistory,expandHistory,pageText,literalMatches}from"../src/history.ts";
test("Unicode pages are exact; case/normalization matching reports original code-point offset",()=>{
 assert.deepEqual(pageText("a🙂汉e\u0301z",1,2),{text:"🙂汉",start:1,end:3,totalCodePoints:6,truncated:true,nextOffset:3});
 assert.equal(literalMatches("🙂 e\u0301 tail",["é"]).offsets[0],2);
});
test("visible derived entries can be searched and expanded without becoming real user quotations",async()=>{
 const h=new SessionHistory();const entries:any[]=[{type:"custom_message",id:"d",parentId:null,timestamp:"t",customType:"result",content:"CUSTOM_ONLY_DECISION",display:false},{type:"branch_summary",id:"b",parentId:"d",timestamp:"t",summary:"BRANCH_FAILED",fromId:"other"}];const snapshot=await h.refresh(undefined,entries);const ids=new Set(["d","b"]);
 assert.equal((await searchHistory(h,snapshot,{query:"CUSTOM_ONLY"},ids,ids)).hits[0].entryId,"d");assert.equal((await expandHistory(h,snapshot,{entry_id:"d"},ids)as any).text,"CUSTOM_ONLY_DECISION");assert.match((await expandHistory(h,snapshot,{entry_id:"b"},ids)as any).text,/BRANCH_FAILED/);
});
test("expand validates exact part before text, image or tool-call dispatch",async()=>{
 const h=new SessionHistory();const entry:any={type:"message",id:"mixed",parentId:null,timestamp:"t",message:{role:"assistant",content:[{type:"text",text:"text"},{type:"toolCall",id:"one",name:"read",arguments:{path:"one"}},{type:"toolCall",id:"two",name:"read",arguments:{path:"two"}},{type:"image",mimeType:"image/png",data:"PRIVATE_BASE64"}]}};
 const s=await h.refresh(undefined,[entry]),ids=new Set([entry.id]);assert.equal((await expandHistory(h,s,{entry_id:"mixed",part_index:9},ids)).status,"part_not_found");const call:any=await expandHistory(h,s,{entry_id:"mixed",part_index:1},ids);assert.equal(call.status,"tool_call");assert.equal(call.structured.id,"one");assert.ok(!JSON.stringify(call).includes('"two"'));const image=await expandHistory(h,s,{entry_id:"mixed",part_index:3},ids);assert.equal(image.status,"image");assert.ok(!JSON.stringify(image).includes("PRIVATE_BASE64"));assert.equal((await expandHistory(h,s,{entry_id:"mixed"},ids)).status,"select_part");
});
test("full-tail search, multipart, branch scope, echo exclusion, pagination, bad lines and replacement",async()=>{
 const root=await mkdtemp(join(tmpdir(),"compact-history-")),path=join(root,"session.jsonl"),history=new SessionHistory();
 const msg=(id:string,role:string,text:any,parentId:string|null=null,extra={})=>({type:"message",id,parentId,timestamp:id,message:{role,content:typeof text==="string"?[{type:"text",text}]:text,timestamp:1,...extra}});
 const entries:any[]=[msg("u1","user","needle early"),msg("t1","toolResult","x".repeat(200000)+"NEEDLE tail","u1",{toolName:"read",toolCallId:"a"}),msg("old","user","needle revoked on other branch"),msg("multi","user",[{type:"image",mimeType:"image/png",data:"secretbase64"},{type:"text",text:"🙂needle"},{type:"text",text:"other"}],"t1"),msg("echo","toolResult","needle retrieval echo","multi",{toolName:"session_expand"})];
 try{
  await writeFile(path,entries.map(e=>JSON.stringify(e)).join("\n")+"\nBAD\n{partial");
  let snapshot=await history.refresh(path,[]);const active=new Set(["u1","t1","multi","echo"]),visible=new Set(["multi"]);
  const found=await searchHistory(history,snapshot,{query:"needle tail"},active,visible);assert.equal(found.hits[0].entryId,"t1");assert.ok((found.hits[0].matchOffsets as number[])[0]>=200000);assert.ok(found.partial);
  const all=await searchHistory(history,snapshot,{query:"needle",branch:"all",limit:1},active,visible);assert.equal(all.hits[0].entryId,"multi");assert.ok(all.nextCursor);
  const next=await searchHistory(history,snapshot,{query:"needle",branch:"all",limit:1,cursor:all.nextCursor!},active,visible);assert.equal(next.hits[0].entryId,"old");
  const p=await expandHistory(history,snapshot,{entry_id:"multi"},active);assert.equal(p.status,"select_part");assert.ok(!JSON.stringify(p).includes("secretbase64"));
  const page=await expandHistory(history,snapshot,{entry_id:"multi",part_index:1,offset:1,limit:3},active);assert.equal((page as any).text,"nee");
  assert.equal((await expandHistory(history,snapshot,{entry_id:"missing"},active)).status,"not_found");
  // Completing the trailing fragment with a newline marks it bad but an appended retrieval
  // entry must not invalidate the original snapshot cursor.
  await appendFile(path,"}\n"+JSON.stringify(msg("appended","user","needle new","echo"))+"\n");
  snapshot=await history.refresh(path,[]);active.add("appended");
  const continued=await searchHistory(history,snapshot,{query:"needle",branch:"all",limit:1,cursor:all.nextCursor!},active,visible);assert.equal(continued.hits[0].entryId,"old");
  await writeFile(path,JSON.stringify(msg("replacement","user","fresh"))+"\n");snapshot=await history.refresh(path,[]);assert.equal(await history.get("t1"),undefined);await assert.rejects(searchHistory(history,snapshot,{query:"needle",branch:"all",cursor:all.nextCursor!},active,visible),/stale/);
 }finally{await rm(root,{recursive:true,force:true});}
});

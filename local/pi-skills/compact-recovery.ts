import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { LEGACY_SKILL_BINDING_ENTRY_TYPE, SKILL_BINDING_ENTRY_TYPE } from "./invocations.ts";
import { AGENT_SKILL_READ_ENTRY_TYPE, loadedSkills } from "./loaded-skill-entry.ts";
import { renderSkillInstructions, type LoadedSkill } from "./skills.ts";

export const COMPACT_SKILLS_REQUEST = "pi-skills:compact-restore-request-v1";
export const COMPACT_SKILLS_RESPONSE = "pi-skills:compact-restore-response-v1";
export const COMPACT_SKILLS_MESSAGE = "pi-skills:compact-restored-v1";
interface SkillRef { sourceEntryId: string; name: string; path: string; contentHash: string }
interface Request { version: 1; sessionId: string; operationId: string; skills: SkillRef[]; beforeAgentStart?:boolean }
const embedded = (details: unknown) => {
  const recovery = (details as { recovery?: { version?: number; items?: Array<{ owner: string; customType: string }> } } | undefined)?.recovery;
  return recovery?.version === 1 && Array.isArray(recovery.items) && recovery.items.some(item => item.owner === "pi-skills" && item.customType === COMPACT_SKILLS_MESSAGE);
};
const validRefs = (refs: unknown): refs is SkillRef[] => Array.isArray(refs) && refs.every(s => s && typeof s.sourceEntryId === "string" && typeof s.name === "string" && typeof s.path === "string" && typeof s.contentHash === "string");
const digest=(text:string)=>createHash("sha256").update(text).digest("hex");
const SKILL_ENTRY_TYPES = [SKILL_BINDING_ENTRY_TYPE, LEGACY_SKILL_BINDING_ENTRY_TYPE, AGENT_SKILL_READ_ENTRY_TYPE];
const ownsEntry = (entry: SessionEntry | undefined): entry is Extract<SessionEntry, { type: "custom" }> => entry?.type === "custom" && SKILL_ENTRY_TYPES.includes(entry.customType);

function skillMaterials(branch: SessionEntry[]): Array<SkillRef & { contents: string }> {
  const latest = new Map<string, SkillRef & { contents: string }>();
  for (const entry of branch) {
    if (!ownsEntry(entry)) continue;
    for (const skill of loadedSkills(entry.customType, entry.data)) {
      latest.set(skill.path, { sourceEntryId: entry.id, name: skill.name, path: skill.path, contentHash: digest(skill.contents), contents: skill.contents });
    }
  }
  return [...latest.values()];
}

function resolveSkillVersions(branch: SessionEntry[], refs: SkillRef[]): Array<{ ref: SkillRef; skill: LoadedSkill }> {
  const resolved = refs.map(ref=>{
    const entry=branch.find(e=>e.id===ref.sourceEntryId);
    if(!ownsEntry(entry))throw new Error(`Missing skill binding ${ref.sourceEntryId}`);
    const skill=loadedSkills(entry.customType,entry.data).find(s=>s.name===ref.name&&s.path===ref.path&&digest(s.contents)===ref.contentHash);
    if(!skill)throw new Error(`Skill version mismatch ${ref.path}`);
    return { ref, skill, index: branch.indexOf(entry) };
  });
  const latest = new Map<string, { ref: SkillRef; skill: LoadedSkill }>();
  for (const { ref, skill } of resolved.sort((a,b)=>a.index-b.index)) latest.set(skill.path,{ref,skill});
  return [...latest.values()];
}
export function resolveCompactionSkills(branch: SessionEntry[], refs: SkillRef[]): LoadedSkill[] {
  return resolveSkillVersions(branch,refs).map(({skill})=>skill);
}
/** The skill owner materializes only proven binding/read versions, never model-proposed file text. */
export function installCompactionSkillRecovery(pi: ExtensionAPI):void{
  let current: ExtensionContext | undefined;
  const received=new Map<string,Request>();
  const sent=new Set<string>();
  const flush=(ctx:ExtensionContext,verify=false,beforeAgentStart=false)=>{
    for(const [operationId,request]of received){
      if(request.sessionId!==ctx.sessionManager.getSessionId())continue;
      let status="failed",error:string|undefined;
      try{
        const branch=ctx.sessionManager.getBranch();
        const compact=branch.findLast(e=>e.type==="compaction"&&(e.details as {operationId?:string})?.operationId===operationId);
        if(!compact||compact.type!=="compaction")continue;
        if(embedded(compact.details)){received.delete(operationId);sent.delete(operationId);continue;}
        const existing=branch.find(e=>e.type==="custom_message"&&e.customType===COMPACT_SKILLS_MESSAGE&&(e.details as {operationId?:string})?.operationId===operationId);
        if(!existing&&!sent.has(operationId)){
          const skills=resolveCompactionSkills(branch,request.skills);
          pi.sendMessage({customType:COMPACT_SKILLS_MESSAGE,content:skills.map(renderSkillInstructions).join("\n\n"),display:false,details:{version:1,operationId,skills:request.skills}},{triggerTurn:false,...(beforeAgentStart?{deliverAs:"nextTurn"as const}:{})});
          sent.add(operationId);
        }
        status=ctx.sessionManager.getBranch().some(e=>e.type==="custom_message"&&e.customType===COMPACT_SKILLS_MESSAGE&&(e.details as {operationId?:string})?.operationId===operationId)?"persisted":"pending";
        if(status!=="persisted"&&verify)throw new Error("Skill recovery message was not persisted before provider request");
      }catch(cause){status="failed";error=String(cause);ctx.ui.notify(`pi-skills：压缩后规则恢复失败，停止相关动作：${error}`,"warning");ctx.abort();}
      pi.events.emit(COMPACT_SKILLS_RESPONSE,{version:1,sessionId:request.sessionId,operationId,status,error});
      if(status!=="pending"){received.delete(operationId);sent.delete(operationId);}
    }
  };
  pi.on("session_start",(_e,ctx)=>{current=ctx;received.clear();sent.clear();});
  // Compact's synchronous public DTOs are optional. Only our public entry tags
  // authorize reading private snapshots; absent/changed contracts contribute nothing.
  const unsubscribeMaterials=pi.events.on("pi-session-compact:collect-materials-v1",(raw:unknown)=>{
    const request=raw as {version?:number;sessionId?:string;reply?:(item:unknown)=>void};
    if(!current||request?.version!==1||request.sessionId!==current.sessionManager.getSessionId()||typeof request.reply!=="function")return;
    request.reply({owner:"pi-skills",skills:skillMaterials(current.sessionManager.getBranch())});
  });
  const unsubscribeCollect=pi.events.on("pi-session-compact:collect-recovery-v1",(raw:unknown)=>{
    const request=raw as {version?:number;sessionId?:string;operationId?:string;restoreSkills?:unknown;reply?:(item:unknown)=>void};
    if(!current||request?.version!==1||request.sessionId!==current.sessionManager.getSessionId()||typeof request.operationId!=="string"||typeof request.reply!=="function"||!Array.isArray(request.restoreSkills))return;
    try {
      const branch=current.sessionManager.getBranch();
      const ownRefs=request.restoreSkills.filter((ref):ref is SkillRef=>validRefs([ref])&&ownsEntry(branch.find(entry=>entry.id===(ref as SkillRef).sourceEntryId)));
      const refs=request.restoreSkills.length?ownRefs:skillMaterials(branch).map(({contents,...ref})=>ref);
      if(!refs.length)return;
      const versions=resolveSkillVersions(branch,refs);
      request.reply({owner:"pi-skills",customType:COMPACT_SKILLS_MESSAGE,order:10,covers:SKILL_ENTRY_TYPES,identity:{operationId:request.operationId,skills:versions.map(({ref})=>ref)},content:versions.map(({skill})=>renderSkillInstructions(skill)).join("\n\n")});
    } catch(error) { request.reply({owner:"pi-skills",error:String(error)}); }
  });
  const unsubscribe=pi.events.on(COMPACT_SKILLS_REQUEST,(raw:unknown)=>{
    const r=raw as Request;
    if(r?.version!==1||typeof r.operationId!=="string"||r.sessionId!==current?.sessionManager.getSessionId()||!validRefs(r.skills))return;
    received.set(r.operationId,r);if(current)flush(current,false,r.beforeAgentStart===true);
  });
  pi.on("before_agent_start",(_e,ctx)=>{current=ctx;flush(ctx,false,true);});
  pi.on("context",(_e,ctx)=>{current=ctx;flush(ctx,true);});
  pi.on("session_tree",(_e,ctx)=>{current=ctx;received.clear();sent.clear();});
  pi.on("session_shutdown",event=>{if(event.reason==="quit"||event.reason==="reload"){unsubscribe();unsubscribeCollect();unsubscribeMaterials();}received.clear();sent.clear();current=undefined;});
}

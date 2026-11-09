import { open, stat, type FileHandle } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { hash } from "./budget.ts";
import { contentParts } from "./sources.ts";

interface Location { offset: number; bytes: number; id: string; type: string; role?: string }
export interface HistorySnapshot { revision: string; cutoff: number; diagnostics: string[]; persistent: boolean }
/** Small in-memory ID/byte-offset index only. Original entry bodies remain in the session file. */
export class SessionHistory {
  private path?: string;
  private identity = "";
  private mtime = 0;
  private size = 0;
  private scanned = 0;
  private revision = 0;
  private locations = new Map<string, Location>();
  private memory = new Map<string, SessionEntry>();
  private diagnostics: string[] = [];
  async refresh(path: string | undefined, entries: SessionEntry[], signal?: AbortSignal): Promise<HistorySnapshot> {
    if (!path) {
      this.path=undefined;this.locations.clear();
      this.memory = new Map(entries.map((e) => [e.id, e]));
      this.identity = hash(entries.map((e) => [e.id, e.parentId]));
      return { revision: this.identity, cutoff: entries.length, diagnostics: ["No persistent session; restart history cannot be guaranteed."], persistent: false };
    }
    const info = await stat(path);
    const identity = `${info.dev}:${info.ino}`;
    if (path !== this.path || identity !== this.identity || info.size < this.size || (info.size === this.size && info.mtimeMs !== this.mtime)) {
      this.path = path; this.identity = identity; this.revision++; this.locations.clear(); this.scanned = 0; this.diagnostics = [];
    }
    const file = await open(path, "r");
    let pending:Buffer[]=[],pendingBytes=0,lineStart=this.scanned,position=this.scanned;
    try {
      while (position < info.size) {
        signal?.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(65536, info.size - position));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        let start=0,newline:number;
        while ((newline = buffer.indexOf(10,start)) >= 0) {
          const fragment=buffer.subarray(start,newline),line=pending.length?Buffer.concat([...pending,fragment],pendingBytes+fragment.length):fragment;
          const bytes=pendingBytes+fragment.length+1;
          try {
            if (line.length) {
              const entry = JSON.parse(line.toString("utf8"));
              if (typeof entry.id === "string" && typeof entry.type === "string" && entry.type !== "session") {
                if (this.locations.has(entry.id)) this.diagnostics.push(`Duplicate entry ID ${entry.id} at byte ${lineStart}; first occurrence retained.`);
                else this.locations.set(entry.id, { offset: lineStart, bytes, id: entry.id, type: entry.type, role: entry.type === "message" ? entry.message?.role : undefined });
              }
            }
          } catch { this.diagnostics.push(`Malformed session line at byte ${lineStart}; results are partial.`); }
          pending=[];pendingBytes=0;start=newline+1;lineStart+=bytes;this.scanned=lineStart;
        }
        if(start<bytesRead){const tail=buffer.subarray(start,bytesRead);pending.push(tail);pendingBytes+=tail.length;}
      }
    } finally { await file.close(); }
    this.size = info.size; this.mtime = info.mtimeMs;
    return { revision: `${this.identity}:${this.revision}`, cutoff: this.scanned, diagnostics: [...this.diagnostics, ...(pendingBytes ? [`Incomplete trailing line at byte ${lineStart}; skipped until append completes.`] : [])], persistent: true };
  }
  ids(cutoff = Infinity): string[] { return this.path ? [...this.locations.values()].filter((l) => l.offset < cutoff).map((l) => l.id) : [...this.memory.keys()].slice(0,cutoff); }
  async openReader():Promise<FileHandle|undefined>{return this.path?open(this.path,"r"):undefined;}
  async get(id: string,reader?:FileHandle): Promise<SessionEntry | undefined> {
    if (!this.path) return this.memory.get(id);
    const location = this.locations.get(id); if (!location) return undefined;
    const file = reader??await open(this.path, "r");
    try { const buffer = Buffer.alloc(location.bytes); const { bytesRead } = await file.read(buffer,0,buffer.length,location.offset); if(bytesRead!==buffer.length)throw new Error("Session changed during read; retry retrieval.");const e=JSON.parse(buffer.toString("utf8"));if(e.id!==id)throw new Error("Session replaced during read; retry retrieval.");return e; }
    finally { if(!reader)await file.close(); }
  }
}
const RETRIEVAL_TOOLS = new Set(["session_search", "session_expand"]);
export function searchableParts(entry: SessionEntry): Array<{ partIndex: number; text: string; kind: string }> {
  if (entry.type === "message" && entry.message.role === "toolResult" && RETRIEVAL_TOOLS.has(entry.message.toolName)) return [];
  return contentParts(entry).flatMap(p => p.text !== undefined && !RETRIEVAL_TOOLS.has(p.toolCall?.name ?? "") ? [{ partIndex: p.partIndex, text: p.text, kind: p.kind }] : []);
}
export function normalizeLiteral(text: string): string { return text.normalize("NFC").toLowerCase(); }
export function queryWords(query: string): string[] { if (typeof query !== "string" || Buffer.byteLength(query) > 512) throw new Error("query must be a nonempty literal string of at most 512 UTF-8 bytes");const words=normalizeLiteral(query.trim()).split(/\s+/u).filter(Boolean);if(!words.length)throw new Error("query is empty");return words; }
function sourceOffset(text: string, normalizedIndex: number, normalizedText: string): number {
  // Most logs are already NFC. Avoid grapheme segmentation of megabytes in that case.
  if (text.toLowerCase() === normalizedText) {
    let raw=0,position=0;for(const point of text){if(position>=normalizedIndex)break;position+=point.toLowerCase().length;raw++;}return raw;
  }
  let raw = 0, normalized = 0;
  for(const item of new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(text)){
    const length=normalizeLiteral(item.segment).length;
    if(normalized+length>normalizedIndex)return raw;
    normalized+=length; raw += [...item.segment].length;
  }
  return raw;
}
export function literalMatches(text: string, words: string[],normalized=normalizeLiteral(text)): { offsets: number[]; matches: boolean } {
  const indices=words.map(w=>normalized.indexOf(w));
  return {matches:indices.every(i=>i>=0),offsets:indices.filter(i=>i>=0).map(i=>sourceOffset(text,i,normalized))};
}
export function pageText(text: string, offset = 0, limit = 4000, bytes = 16384) {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1)throw new Error("offset/limit must be nonnegative/positive integers");
  const cap=Math.min(bytes,32768);let output="",end=offset,encodedBytes=0,total=0,full=false;
  for(const point of text){if(total>=offset&&!full){const size=Buffer.byteLength(JSON.stringify(point))-2;if(end-offset>=limit||encodedBytes+size>cap)full=true;else{output+=point;encodedBytes+=size;end++;}}total++;}
  if(offset>total)throw new Error("offset out of range");
  return {text:output,start:offset,end,totalCodePoints:total,truncated:end<total,nextOffset:end<total?end:null};
}
export interface SearchArgs { query: string; roles?: string[]; branch?: "active"|"all"; limit?: number; cursor?: string }
export async function searchHistory(history: SessionHistory, snapshot: HistorySnapshot, args: SearchArgs, activeIds: Set<string>, visibleIds: Set<string>, signal?: AbortSignal, editedIds: Set<string> = new Set()) {
  const words=queryWords(args.query), limit=args.limit??10;
  if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error("limit must be 1..50");
  if(args.roles?.some(r=>!["user","assistant","toolResult"].includes(r)))throw new Error("invalid search role");
  let position=0,cutoff=snapshot.cutoff;
  let prior:{revision:string;signature:string;cutoff:number;position:number}|undefined;
  if(args.cursor){try{prior=JSON.parse(Buffer.from(args.cursor,"base64url").toString("utf8"));}catch{throw new Error("invalid cursor");}if(!prior||!Number.isSafeInteger(prior.cutoff)||prior.cutoff<0||prior.cutoff>snapshot.cutoff||prior.revision!==snapshot.revision)throw new Error("stale cursor; restart search");position=prior.position;cutoff=prior.cutoff;if(!Number.isInteger(position)||position<0)throw new Error("invalid cursor position");}
  const signature=hash({query:words,roles:args.roles,branch:args.branch??"active",active:history.ids(cutoff).filter(id=>activeIds.has(id))});
  if(prior&&prior.signature!==signature)throw new Error("stale cursor; branch/query changed, restart search");
  const ids=history.ids(cutoff).reverse(); const hits: Array<Record<string,unknown>>=[];let bytes=0;
  const began=performance.now();let timedOut=false;
  const reader=await history.openReader();
  try{
  for(;position<ids.length;position++){
    signal?.throwIfAborted();
    if(performance.now()-began>10000){timedOut=true;break;}
    const id=ids[position]!;if(args.branch!=="all"&&!activeIds.has(id))continue;
    const entry=await history.get(id,reader);if(!entry)continue;
    const role=contentParts(entry)[0]?.role;if(!role||args.roles&&!args.roles.includes(role))continue;
    const parts=searchableParts(entry).map(p=>({...p,normalized:normalizeLiteral(p.text)}));if(!parts.length)continue;
    if(!words.every(w=>parts.some(p=>p.normalized.includes(w))))continue;
    const p=parts.find(p=>words.some(w=>p.normalized.includes(w)))!;
    const matches=literalMatches(p.text,words,p.normalized),offset=matches.offsets[0]??0;
    const snippet=pageText(p.text,Math.max(0,offset-80),240,1000).text;
    const hit={entryId:id,entryType:entry.type,parentId:entry.parentId,role,timestamp:entry.timestamp,...(editedIds.has(id)?{edited:true,contentView:"original",notice:"这条在当前上下文里已被编辑，以下是原始内容。"}:{}),...(entry.type==="message"&&entry.message.role==="toolResult"?{toolName:entry.message.toolName}:{}),partIndex:p.partIndex,kind:p.kind,snippet,matchOffsets:matches.offsets,branch:activeIds.has(id)?"active":"other",visibility:!activeIds.has(id)?"other_branch":visibleIds.has(id)?"visible":"compacted_or_edited"};
    const hitBytes=Buffer.byteLength(JSON.stringify(hit));if(bytes+hitBytes>6500)break;
    hits.push(hit);bytes+=hitBytes;if(hits.length>=limit){position++;break;}
  }
  }finally{await reader?.close();}
  const cursor=position<ids.length?Buffer.from(JSON.stringify({revision:snapshot.revision,signature,position,cutoff})).toString("base64url"):null;
  return {hits,nextCursor:cursor,partial:snapshot.diagnostics.length>0||timedOut,diagnostics:snapshot.diagnostics.slice(0,8),timedOut,persistent:snapshot.persistent,order:"newest matching entry first",scope:args.branch??"active"};
}
export async function expandHistory(history: SessionHistory, snapshot: HistorySnapshot, args: {entry_id:string;part_index?:number;offset?:number;limit?:number}, activeIds: Set<string>, editedIds: Set<string> = new Set()) {
  const entry=await history.get(args.entry_id);if(!entry)return{status:"not_found",entryId:args.entry_id};
  const parts=contentParts(entry);
  const metadata={entryId:entry.id,entryType:entry.type,parentId:entry.parentId,role:parts[0]?.role??"state",timestamp:entry.timestamp,...(editedIds.has(entry.id)?{edited:true,contentView:"original",notice:"这条在当前上下文里已被编辑，以下是原始内容。"}:{}),branch:activeIds.has(entry.id)?"active":"other",persistent:snapshot.persistent,diagnostics:snapshot.diagnostics.slice(0,8)};
  if(args.part_index!==undefined&&(!Number.isSafeInteger(args.part_index)||args.part_index<0))throw new Error("part_index must be a nonnegative integer");
  if(args.part_index===undefined&&parts.length>1)return{status:"select_part",...metadata,parts:parts.map(p=>({partIndex:p.partIndex,kind:p.kind,...(p.media?{media:p.media}:{}),...(p.text!==undefined?{codePoints:[...p.text].length}:{})}))};
  const selected=args.part_index??parts[0]?.partIndex;
  const part=parts.find(p=>p.partIndex===selected);
  if(!part)return{status:selected===undefined?"media_or_no_text":"part_not_found",...metadata,...(selected!==undefined?{partIndex:selected}:{})};
  if(part.kind==="image")return{status:"image",...metadata,partIndex:part.partIndex,media:part.media};
  const page=pageText(part.text!,args.offset??0,args.limit??4000,args.limit===undefined?14000:30000);
  if(part.kind==="toolCall")return{status:"tool_call",...metadata,partIndex:part.partIndex,structured:page.truncated?null:part.toolCall,...page};
  return{status:"ok",...metadata,partIndex:part.partIndex,...page};
}

import{mkdtemp,writeFile,rm}from'node:fs/promises';
import{tmpdir}from'node:os';import{join}from'node:path';
import{SessionHistory,searchHistory,expandHistory}from'../src/history.ts';
const root=await mkdtemp(join(tmpdir(),'compact-history-perf-'));
try{
 const text='plain material '.repeat(350000)+'PERF_TAIL_ONLY_REQUIREMENT';
 const entry={type:'message',id:'large',parentId:null,timestamp:'2026-10-17',message:{role:'toolResult',toolName:'read',toolCallId:'x',content:[{type:'text',text}],timestamp:1}};
 const path=join(root,'session.jsonl');await writeFile(path,JSON.stringify(entry)+'\n');
 const history=new SessionHistory(),ids=new Set(['large']),before=process.memoryUsage().rss;
 let at=performance.now();const snapshot=await history.refresh(path,[]);const refreshMs=performance.now()-at;
 at=performance.now();const found=await searchHistory(history,snapshot,{query:'PERF_TAIL_ONLY_REQUIREMENT'},ids,ids);const searchMs=performance.now()-at;
 at=performance.now();const page=await expandHistory(history,snapshot,{entry_id:'large',offset:0,limit:240},ids);const expandMs=performance.now()-at;
 if(found.hits.length!==1||page.text.length!==240)throw Error('performance fixture source lost');
 console.log(JSON.stringify({entryUtf8Bytes:Buffer.byteLength(JSON.stringify(entry)),refreshMs,searchMs,expandMs,rssDeltaBytes:process.memoryUsage().rss-before,searchOutputBytes:Buffer.byteLength(JSON.stringify(found)),expandOutputBytes:Buffer.byteLength(JSON.stringify(page)),realRequests:0},null,2));
}finally{await rm(root,{recursive:true,force:true});}

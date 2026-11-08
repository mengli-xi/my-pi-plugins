import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareFreshProfile, piBinary } from "../fixtures/fresh-profile.js";

for(const [name,config,backend,key] of [
  ["backend-sdk",{schemaVersion:2},"sdk","PI_SUBAGENTS_BACKEND"],
  ["backend-empty",{schemaVersion:2},"","PI_SUBAGENTS_BACKEND"],
  ["backend-process",{schemaVersion:2},"process","PI_SUBAGENTS_BACKEND"],
  ["removed",{schemaVersion:1,capacity:{idleResidentsPerMain:3}},undefined,"capacity.idleResidentsPerMain"],
  ["unknown",{schemaVersion:2,capacity:{unknownKey:1}},undefined,"capacity.unknownKey"],
  ["range",{schemaVersion:2,capacity:{activeTasksPerMain:33}},undefined,"capacity.activeTasksPerMain"],
  ["schema",{schemaVersion:1},undefined,"schemaVersion"],
] as const) test(`stock 1.5.0 ${name} keeps Main usable and rejects new Subagents work`,{timeout:45000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"pi-b-config-host-"));let child:ReturnType<typeof spawn>|undefined,exit:Promise<any>|undefined;
  try{
    const agentDir=await prepareFreshProfile(root),configPath=join(agentDir,"pi-subagents/config.json");await writeFile(configPath,JSON.stringify(config));
    const pkg=resolve(import.meta.dirname,"../..");let out="",err="";
    const env: NodeJS.ProcessEnv={...process.env,HOME:root,XDG_CONFIG_HOME:join(root,".config"),PI_CODING_AGENT_DIR:agentDir,PI_NEXT_AGENT_DIR:agentDir,PI_OFFLINE:"1"};delete env.PI_SUBAGENTS_BACKEND;delete env.PI_SUBAGENTS_TEST_HOOKS;
    if(backend!==undefined)env.PI_SUBAGENTS_BACKEND=backend;
    child=spawn(piBinary,["--offline","--mode","rpc","--session",join(root,"main.jsonl"),"--no-extensions","-e",join(pkg,"dist/index.js"),"-e",join(pkg,"test/fixtures/faux-subagent-provider.ts"),"--no-skills","--no-prompt-templates","--no-context-files","--provider","fixture","--model","faux-1","--thinking","off","--approve"],{cwd:root,env,stdio:["pipe","pipe","pipe"]});
    child.stdout!.on("data",d=>out+=d);child.stderr!.on("data",d=>err+=d);exit=new Promise(r=>child!.once("exit",(code,signal)=>r({code,signal})));
    const until=async(accept:()=>boolean)=>{const end=Date.now()+30000;while(!accept()){if(Date.now()>end||child!.exitCode!==null)throw new Error(`${name}: ${err} ${out.slice(-2000)}`);await new Promise(r=>setTimeout(r,20));}};
    child.stdin!.write(JSON.stringify({id:"state",type:"get_state"})+"\n");await until(()=>out.includes('"id":"state"'));
    assert.equal(JSON.parse(out.split("\n").find(s=>s.includes('"id":"state"'))!).success,true);
    child.stdin!.write(JSON.stringify({id:"ordinary",type:"prompt",message:"FOREGROUND_CHECK"})+"\n");await until(()=>out.includes("FOREGROUND_OK")&&out.includes('"type":"agent_end"'));
    assert.ok((out+err).includes(key));assert.ok((out+err).includes("请"));if(backend===undefined)assert.ok((out+err).includes(configPath));
    const before=out.length;child.stdin!.write(JSON.stringify({id:"spawn",type:"prompt",message:"WAKE_MAIN"})+"\n");await until(()=>out.slice(before).includes('"type":"agent_end"'));
    assert.ok(out.slice(before).includes("config-invalid"));assert.ok(out.slice(before).includes(key));
    child.stdin!.write(JSON.stringify({id:"last",type:"get_state"})+"\n");await until(()=>out.includes('"id":"last"'));
    child.stdin!.end();assert.deepEqual(await exit,{code:0,signal:null});assert.equal(err,"");
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await exit;}await rm(root,{recursive:true,force:true});}
});

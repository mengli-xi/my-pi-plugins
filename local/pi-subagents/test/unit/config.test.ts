import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSubagentsConfig, validateConfigPatch, validateSubagentsConfig, assertProjectPatchAuthority } from "../../src/config/schema.js";
import { loadSubagentsConfig, parseStrictJsonObject } from "../../src/config/load.js";

test("v2 validates active/open/depth relations and rejects nonintegers", () => {
  const defaults = defaultSubagentsConfig();
  for (const capacity of [{activeTasksPerMain:33}, {activeTasksPerProcess:65}, {openAgentsPerMain:33}, {activeTasksPerMain:11}, {openAgentsPerMain:9}, {activeTasksPerMain:1.5}]) assert.throws(() => validateSubagentsConfig({...defaults, capacity:{...defaults.capacity,...capacity}}));
  for (const maxDepth of [0,3,1.5]) assert.throws(() => validateSubagentsConfig({...defaults,execution:{...defaults.execution,maxDepth}}));
  assert.equal(validateSubagentsConfig({schemaVersion:2,capacity:{activeTasksPerMain:32,activeTasksPerProcess:64,openAgentsPerMain:32},execution:{maxDepth:2}}).execution.maxDepth,2);
});
test("all removed keys and schema v1 report source, complete key and remedy together", () => {
  const path = "/tmp/profile/pi-subagents/config.json";
  for (const [section, keys] of Object.entries({execution:["helperRuntime","runtimeStopGraceMs"],capacity:["residentChildrenPerMain","residentChildrenPerProcess","idleResidentsPerMain"],storage:["maxAgentsPerMain"],liveView:["maxAssistantBytes","maxToolBytes","maxAgentProjectionBytes","maxProcessProjectionBytes","maxRpcFrameBytes","maxFramesPerSecond","completedThinkingExpanded"]})) for(const key of keys) {
    assert.throws(()=>validateConfigPatch({schemaVersion:1,[section]:{[key]:1}},path),error=>error instanceof Error && error.message.includes(path) && error.message.includes(`${section}.${key}`) && error.message.includes("请") && error.message.includes("schemaVersion"));
  }
  assert.throws(()=>validateConfigPatch({schemaVersion:2,capacity:{typo:1}},path),/capacity.typo/);
  for(const input of ['{"a":1,"a":2}','{"a":1,}','// nope','[]']) assert.throws(()=>parseStrictJsonObject(input,path));
});
test("project only tightens local limits and cannot alter process authority",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"pi-b-config-")),cwd=join(dir,"project");t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,"pi-subagents"),{recursive:true});await mkdir(join(cwd,".pi"),{recursive:true});
  await writeFile(join(dir,"pi-subagents/config.json"),JSON.stringify({schemaVersion:2,capacity:{activeTasksPerMain:4,openAgentsPerMain:20},execution:{maxDepth:2}}));
  await writeFile(join(cwd,".pi/pi-subagents.json"),JSON.stringify({schemaVersion:2,capacity:{activeTasksPerMain:9,openAgentsPerMain:12},execution:{maxDepth:1}}));
  const loaded=await loadSubagentsConfig({agentDirectory:dir,cwd,projectTrusted:true});assert.equal(loaded.ok,true);if(loaded.ok){assert.equal(loaded.config.capacity.activeTasksPerMain,4);assert.equal(loaded.config.capacity.openAgentsPerMain,12);assert.equal(loaded.config.execution.maxDepth,1);}
  assert.throws(()=>assertProjectPatchAuthority({schemaVersion:2,capacity:{activeTasksPerProcess:2}}),/capacity.activeTasksPerProcess/);
  assert.throws(()=>assertProjectPatchAuthority({schemaVersion:2,storage:{maxStoreBytesPerProcess:1}}),/storage.maxStoreBytesPerProcess/);
  await writeFile(join(cwd,".pi/pi-subagents.json"),JSON.stringify({schemaVersion:2,execution:{maxDepth:3}}));
  const invalid=await loadSubagentsConfig({agentDirectory:dir,cwd,projectTrusted:true});assert.equal(invalid.ok,false);if(!invalid.ok){assert.match(invalid.diagnostic.message,/maxDepth/);assert.ok(invalid.diagnostic.message.includes(cwd));}
});

import { piBin, installedPiVersion } from "../../../scripts/pi-checks.mjs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-compact-v2-host-")));
const agent = join(root, "agent"), cwd = join(root, "cwd"), home = join(root, "home");
const session = join(root, "session.jsonl"), requests = join(root, "requests.jsonl");
const binary = piBin();
const artifacts = process.env.PI_COMPACT_HOST_ARTIFACTS;
const evidence = { binary, realRequests: 0, checks: [] };
const lines = path => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
const check = (label, ok) => { assert.ok(ok, label); evidence.checks.push(label); };
let runtime;
async function until(get, label, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    const value = await get(); if (value) return value;
    if (runtime?.child.exitCode != null) throw Error(`${label}: exited ${runtime.child.exitCode}: ${runtime.stderr()}`);
    if (Date.now() - start > timeout) throw Error(`${label}: timeout: ${runtime?.stderr()}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
function start() {
  const extensions = [join(pkg, "index.ts"), resolve(pkg, "../pi-skills/index.ts"), resolve(pkg, "../pi-todo/index.ts"), join(root, "faux/index.ts")];
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_NEXT_AGENT_DIR: agent, PI_OFFLINE: "1", XDG_CONFIG_HOME: join(root, "config") };
  const child = spawn(binary, ["--offline", "--no-extensions", ...extensions.flatMap(p => ["-e", p]), "--mode", "rpc", "--session", session, "--provider", "compact-faux", "--model", "main", "--thinking", "off", "--no-skills", "--no-prompt-templates", "--no-themes"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", stderr = "", seq = 0; const records = [];
  child.stderr.on("data", c => stderr += c);
  child.stdout.on("data", c => { buffer += c; for (let i; (i = buffer.indexOf("\n")) >= 0;) { const l = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { records.push(JSON.parse(l)); } catch { stderr += l + "\n"; } } });
  const rpc = async (type, params = {}, success = true) => { const id = `v2-${++seq}`; child.stdin.write(JSON.stringify({ id, type, ...params }) + "\n"); const r = await until(() => records.find(r => r.type === "response" && r.id === id), type); if (success) assert.equal(r.success, true, JSON.stringify(r)); return r; };
  const prompt = async message => { const from = records.length; await rpc("prompt", { message }); await until(() => records.slice(from).some(r => r.type === "agent_end"), "agent_end"); assert.equal(records.slice(from).filter(r => r.type === "extension_error").length, 0, JSON.stringify(records.slice(from))); };
  return { child, records, rpc, prompt, stderr: () => stderr };
}
async function stop() {
  const current = runtime; current.child.stdin.end();
  await until(() => current.child.exitCode !== null, "shutdown", 10000);
  runtime = undefined;
}
try {
  for (const dir of [home, cwd, agent, join(root, "faux"), join(agent, "pi-session-compact")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agent, "auth.json"), "{}", { mode: 0o600 });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"], cacheWarming: "off", retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false, reserveTokens: 20000, keepRecentTokens: 50 } }));
  const config = { mode: "small", smallModel: { provider: "compact-faux", id: "small", effort: "off" }, outputTokens: 4096, summaryTokens: 1 };
  const configPath = join(agent, "pi-session-compact/config.json"); writeFileSync(configPath, JSON.stringify(config));
  const moduleUrl = p => import.meta.resolve(p);
  writeFileSync(join(root, "faux/index.ts"), `import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
import { acquireEffectiveCapture, contextFingerprint } from ${JSON.stringify(moduleUrl("pi-session-runtime/effective-context"))};
import { describeNativeContext, describeAuxiliaryPreamble } from ${JSON.stringify(moduleUrl("pi-session-runtime/native-child-context"))};
import { PROVIDER_ACTIVITY_CHANNEL } from ${JSON.stringify(moduleUrl("pi-runtime-contracts/provider-activity-v1"))};
export default function(pi) {
 pi.on("before_agent_start",event=>{event.systemPromptOptions.sections.compact_host="HOST_SYSTEM_SECTION";});
 const faux = fauxProvider({provider:"compact-faux",api:"compact-faux",models:[{id:"main",contextWindow:200000,maxTokens:24000},{id:"small",contextWindow:200000,maxTokens:8192}],tokensPerSecond:10000000});
 const respond = (context) => {
  appendFileSync(${JSON.stringify(requests)},JSON.stringify(context)+"\\n");
  const last=context.messages.at(-1), text=typeof last?.content==="string"?last.content:JSON.stringify(last?.content);
  if(context.messages[0]?.role==="system"&&JSON.stringify(context.messages[0]).includes("You are a context summarization assistant"))return fauxAssistantMessage("HOST_NATIVE_HANDOFF Keep the public API.");
  if(text?.includes("Summarize the paused session for a colleague"))return fauxAssistantMessage("## 当前任务与要求\\n\\nHOST_HANDOFF 保持 API，等待确认后再发布。\\n\\n## 下一步\\n\\n继续核对结果。");
  if(last?.role==="user"&&text?.includes("SEED_OWNER"))return fauxAssistantMessage([{type:"toolCall",id:"todo-seed",name:"todo",arguments:{todos:[{content:"HOST_TODO_PENDING",status:"in_progress",activeForm:"Checking host"}]}}],{stopReason:"toolUse"});
  return fauxAssistantMessage("BUSINESS_OK "+"recent ".repeat(300));
 };
 let lease, overflow=false;
 pi.on("context",event=>overflow?{messages:[...event.messages,{role:"user",content:"LATE_OWNER_MATERIAL".repeat(50000),timestamp:Date.now()}]}:undefined);
 pi.registerCommand("late-owner-overflow",{description:"Fixture",handler:()=>{overflow=true;}});
 const originalStream=faux.provider.streamSimple;faux.provider.streamSimple=(model,context,options)=>{lease?.confirmRequest(options?.signal);return originalStream.call(faux.provider,model,context,options);};
 faux.setResponses(Array.from({length:100},()=>respond));pi.registerProvider(faux.provider);
 const queued=fauxProvider({provider:"queued-faux",api:"compact-faux-queued",models:[{id:"queued",contextWindow:200000,maxTokens:8192}],tokensPerSecond:10000000});
 queued.setResponses(Array.from({length:10},()=>async(context,options)=>{
  appendFileSync(${JSON.stringify(requests)},JSON.stringify(context)+"\\n");
  const emit=(type,queuedMs)=>pi.events.emit(PROVIDER_ACTIVITY_CHANNEL,{version:1,provider:"queued-faux",sessionId:options?.sessionId,kind:"lifecycle",event:{channel:"lifecycle",source:"upstream",type,queuedMs}});
  emit("queue.enter",0);await new Promise(r=>setTimeout(r,800));emit("queue.leave",800);
  return fauxAssistantMessage("HOST_HANDOFF after queued faux generation");
 }));pi.registerProvider(queued.provider);
 pi.on("context_with_system",(event,ctx)=>{
  if(!ctx.signal)return;
  lease??=acquireEffectiveCapture({owner:"compact-faux",sessionId:ctx.sessionManager.getSessionId(),binding:ctx.sessionManager});lease.refreshProviders(ctx.modelRegistry);
  const byName=new Map(pi.getAllTools().map(t=>[t.name,t]));const active=pi.getActiveTools().map(name=>{const t=byName.get(name);return t?{name,description:t.description,parameters:t.parameters,sourceInfo:t.sourceInfo}:{name,unavailable:true}});
  lease.observe({generation:lease.generation,selectedModel:{provider:ctx.model.provider,id:ctx.model.id},thinkingLevel:ctx.thinkingLevel??"off",toolLoadoutFingerprint:contextFingerprint(active),capabilityFingerprint:"v2-fixture",leafId:ctx.sessionManager.getLeafId(),signal:ctx.signal,auxiliaryMessages:event.messages,nativeOrigins:describeNativeContext(ctx.sessionManager.getBranch()),knownPreamble:describeAuxiliaryPreamble(event.messages)});
 });
 pi.on("before_provider_request",(_e,ctx)=>lease?.confirmRequest(ctx.signal));pi.on("session_shutdown",()=>lease?.retire());
 pi.registerCommand("seed-owner-rules",{description:"Fixture",handler:()=>{pi.appendEntry("pi-skills:binding-v1",{version:1,key:"fixture",text:"fixture",skills:[{name:"host-skill",path:${JSON.stringify(join(cwd, "SKILL.md"))},contents:"HOST_SKILL_RULES Do not publish."}]});pi.sendMessage({customType:"process-notification-batch-v1",content:"<process_event>HOST_PROCESS_NOTICE</process_event>",display:false},{triggerTurn:false});}});
}`);
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_NEXT_AGENT_DIR: agent };
  evidence.version = execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim();
  check("Pi CLI 与 SDK 版本一致", evidence.version === installedPiVersion());
  runtime = start(); await runtime.rpc("get_state");
  await runtime.prompt("SEED_OWNER 用户要求保持 API");
  await runtime.rpc("prompt", { message: "/seed-owner-rules" });
  const paste = "不要发布。\n\n```text\n" + "PASTE_FULL汉🙂\n".repeat(1500) + "```\n\n最终要求原样保留。";
  await runtime.prompt(paste);
  await runtime.prompt("当前尾部，尚未移出");
  const before = lines(requests).length;
  await runtime.rpc("compact");
  let compact = lines(session).findLast(e => e.type === "compaction");
  check("plain Markdown handoff is committed", compact?.details.generator === "pi-session-compact" && compact.summary.includes("HOST_HANDOFF"));
  check("full paste survives in quotations", compact.details.userQuotations.items.some(q => q.text === paste) && compact.summary.includes(paste));
  check("custom process notification excluded from quotations", !JSON.stringify(compact.details.userQuotations).includes("HOST_PROCESS_NOTICE"));
  check("single custom request without hidden repairs", lines(requests).length - before === 1);
  const small = lines(requests).at(-1);
  check("small request has no dedicated output tool or source table", !small.tools?.length && !JSON.stringify(small).includes("Operation source table"));
  const firstRun=JSON.parse(readFileSync(join(agent,compact.details.runLog),"utf8"));
  check("known todo recovery was budgeted before committing",firstRun.contextSizes.after.estimated.recoveryPackage>0);
  check("skill is collected from its real owner into the committed summary", compact.summary.includes("HOST_SKILL_RULES") && compact.details.recovery?.items.some(item => item.owner === "pi-skills" && item.customType === "pi-skills:compact-restored-v1"));
  check("embedded recovery has no standalone duplicate", !lines(session).some(e => e.type === "custom_message" && ["pi-skills:compact-restored-v1", "pi-session-compact:recovery-v1", "todo-state"].includes(e.customType)));
  await runtime.prompt("VERIFY_FINAL_PAYLOAD");
  const payload = lines(requests).at(-1); const serialized = JSON.stringify(payload);
  for (const [name, marker] of [["handoff", "HOST_HANDOFF"], ["full user text", "最终要求原样保留"], ["skill", "HOST_SKILL_RULES"], ["todo", "HOST_TODO_PENDING"], ["tail", "VERIFY_FINAL_PAYLOAD"]]) check(`final payload includes ${name}`, serialized.includes(marker));
  check("system and tools survive", payload.messages.some(m => m.role === "system" && m.toolsAdded?.length));
  check("Pi 1.5 compaction checkpoints effective system sections and tools", compact.systemMessage?.sections?.compact_host === "<compact_host>\nHOST_SYSTEM_SECTION\n</compact_host>" && compact.systemMessage.toolsAdded?.some(tool => tool.name === "session_search"));
  check("request retains the effective system section after compaction", serialized.includes("HOST_SYSTEM_SECTION"));
  config.mode = "main"; writeFileSync(configPath, JSON.stringify(config));
  await runtime.rpc("compact");
  compact = lines(session).findLast(e => e.type === "compaction");
  const run = JSON.parse(readFileSync(join(agent, compact.details.runLog), "utf8"));
  check("main uses effective system/tools/history prefix", run.outputs.main.effectiveMode === "main");
  check("available main prefix remains capture", run.outputs.main.prefix.source === "capture");
  check("second compaction retains cumulative paste exactly once", compact.details.userQuotations.items.filter(q => q.text === paste).length === 1);
  await runtime.prompt("VERIFY_MAIN_PAYLOAD");
  check("main recovery payload retains todo and skill", JSON.stringify(lines(requests).at(-1)).includes("HOST_TODO_PENDING") && JSON.stringify(lines(requests).at(-1)).includes("HOST_SKILL_RULES"));
  await stop();
  runtime = start(); await runtime.rpc("get_state");
  const resumeRequests = lines(requests).length;
  await runtime.rpc("prompt", { message: "/compaction now" });
  await until(() => lines(session).filter(e => e.type === "compaction").length === 3, "resume immediate compaction");
  await until(async () => !(await runtime.rpc("get_state")).data.isCompacting, "resume compaction settled");
  const resumedEntry = lines(session).findLast(e => e.type === "compaction");
  const resumedRun = JSON.parse(readFileSync(join(agent, resumedEntry.details.runLog), "utf8"));
  check("resume /compaction now without Main request uses main and rebuilt", resumedRun.adopted.slot === "main" && resumedRun.outputs.main.effectiveMode === "main" && resumedRun.outputs.main.prefix.source === "rebuilt");
  check("rebuilt main logs missing capture reason", resumedRun.outputs.main.prefixCapture.reason === "no-capture");
  check("resume immediate compaction sends exactly one main request", lines(requests).length - resumeRequests === 1 && resumedRun.outputs.main.attempts.length === 1 && resumedRun.outputs.main.attempts[0].model === "compact-faux/main");
  check("rebuilt main retains current system and tool declarations on Pi 1.5", lines(requests).at(-1).messages.some(m => m.role === "system" && m.toolsAdded?.some(tool => tool.name === "session_search")));
  await runtime.prompt("VERIFY_RESUME");
  check("fresh resume preserves full quotations and rules", JSON.stringify(lines(requests).at(-1)).includes("最终要求原样保留") && JSON.stringify(lines(requests).at(-1)).includes("HOST_SKILL_RULES"));
  check("resume never regenerates committed compaction beyond the explicit command", lines(session).filter(e => e.type === "compaction").length === 3);
  config.mode="small";delete config.smallModel;writeFileSync(configPath,JSON.stringify(config));
  await runtime.rpc("compact");
  const currentEntry=lines(session).findLast(e=>e.type==="compaction"),currentRun=JSON.parse(readFileSync(join(agent,currentEntry.details.runLog),"utf8"));
  check("unconfigured smallModel uses current model with an explicit diagnostic",currentRun.adopted.slot==="small"&&currentRun.outputs.small.effectiveModel==="compact-faux/main"&&currentRun.outputs.small.modeReason.includes("未配置 smallModel"));
  await runtime.prompt("VERIFY_CURRENT_MODEL");
  config.smallModel={provider:"missing-faux",id:"absent",effort:"off"};writeFileSync(configPath,JSON.stringify(config));
  await runtime.rpc("compact");
  const invalidEntry=lines(session).findLast(e=>e.type==="compaction"),invalidRun=JSON.parse(readFileSync(join(agent,invalidEntry.details.runLog),"utf8"));
  check("invalid explicit smallModel diagnoses its identity and falls back to native",invalidRun.adopted.slot==="native"&&invalidRun.outputs.small.error.includes("small-model-unavailable:missing-faux/absent")&&invalidRun.outputs.small.attempts.length===0);
  await runtime.prompt("VERIFY_INVALID_CONFIG");
  config.smallModel={provider:"queued-faux",id:"queued",effort:"off"};config.totalTimeoutMinutes=0.01;writeFileSync(configPath,JSON.stringify(config));
  await runtime.rpc("compact");
  const queuedEntry=lines(session).findLast(e=>e.type==="compaction"), queuedRun=JSON.parse(readFileSync(join(agent,queuedEntry.details.runLog),"utf8"));
  // Node's nominal 800ms timer can finish just early; the production clock correctly clamps
  // reported queue time to the real request window. Verify the unchanged active-time budget.
  check("generic provider activity pauses the custom total deadline in a fresh host",queuedRun.adopted.slot==="small"&&!queuedRun.totalDeadline.expired&&queuedRun.totalDeadline.limitMs===600&&queuedRun.totalDeadline.queuePausedMs>0&&queuedRun.totalDeadline.wallElapsedMs>queuedRun.totalDeadline.limitMs&&queuedRun.totalDeadline.activeElapsedMs<queuedRun.totalDeadline.limitMs);
  await runtime.rpc("prompt", { message: "/late-owner-overflow" });
  const overflowBefore=lines(requests).length, committedBefore=lines(session).filter(e=>e.type==="compaction").length;
  await runtime.prompt("BLOCK_LATE_OWNER_REQUEST");
  check("late owner overflow blocks the actual provider request",lines(requests).length===overflowBefore);
  check("late overflow keeps the committed summary and original entries",lines(session).filter(e=>e.type==="compaction").length===committedBefore&&lines(session).some(e=>e.type==="message"&&e.message.role==="user"&&JSON.stringify(e.message.content).includes("SEED_OWNER")));
  await stop();
  evidence.fauxRequests = lines(requests).length;
} finally {
  if (runtime?.child.exitCode === null) runtime.child.kill("SIGTERM");
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true });
    for (const [name, file] of [["requests.jsonl", requests], ["session.jsonl", session]]) if (existsSync(file)) writeFileSync(join(artifacts, name), readFileSync(file));
    const runRoot=join(agent,"pi-session-compact/runs");
    if(existsSync(runRoot))for(const sid of readdirSync(runRoot))for(const name of readdirSync(join(runRoot,sid)))writeFileSync(join(artifacts,`run-${name}`),readFileSync(join(runRoot,sid,name)));
    writeFileSync(join(artifacts, "checks.json"), JSON.stringify(evidence, null, 2));
    if (runtime) writeFileSync(join(artifacts, "stderr.log"), runtime.stderr());
  }
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(evidence, null, 2));

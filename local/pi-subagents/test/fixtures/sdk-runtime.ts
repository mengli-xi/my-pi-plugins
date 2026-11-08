import { sdkProviderApprovalV1 } from "pi-session-runtime/sdk-provider";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureEntrypointDescriptorV1, getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import subagents from "../../src/index.js";
import { getProcessServiceCellV1 } from "../../src/host/service-cell.js";
export async function until(predicate: () => boolean, label: string, diagnostics: () => unknown, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify(diagnostics())}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
export async function createSdkFixture(options: { contextWindow?: number; streamSize?: number; responseSupply?: number } = {}) {
  const key = `pi-subagents-sdk-test:${randomUUID()}`;
  const control: { assemblyGate?: Promise<void>; inputGate?: Promise<void>; inputEntered: string[]; providerCalls: string[]; childProviderCalls: string[]; responses: Map<string, Promise<void>>; started: string[]; disposed: string[] } = { inputEntered: [], providerCalls: [], childProviderCalls: [], responses: new Map(), started: [], disposed: [] };
  (globalThis as any)[Symbol.for(key)] = control;
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-sdk-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const cell = getProcessServiceCellV1();
  const pkg = join(dir, "faux-provider"), source = join(pkg, "src"); await mkdir(source, { recursive: true });
  await mkdir(join(dir, "pi-subagents"), { recursive: true, mode: 0o700 }); await writeFile(join(dir, "pi-subagents", "config.json"), JSON.stringify({ schemaVersion: 2, execution: { maxDepth: 2 } }));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture-sdk-provider", type: "module" }));
  await writeFile(join(source, "child.ts"), "// Frozen legacy target; SDK installs only child-factory.ts.\n");
  const factoryPath = join(source, "child-factory.ts");
  await writeFile(factoryPath, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
export function createFixtureChildFactory() { return pi => {
 const control = globalThis[Symbol.for(${JSON.stringify(key)})];
 let childSession = false;
 pi.on('session_start', async (_event, ctx) => { childSession = !!ctx.sessionManager.getSessionFile()?.includes('store-v2'); if(childSession) { control.started.push(ctx.sessionManager.getSessionId()); await control.assemblyGate; } });
 pi.on('input', async (_event, ctx) => { if (ctx.sessionManager.getSessionFile()?.includes('store-v2') && control.inputGate) { control.inputEntered.push(ctx.sessionManager.getSessionId()); await control.inputGate; } return {action:'continue'}; });
 pi.on('session_shutdown', (_event, ctx) => { if(ctx.sessionManager.getSessionFile()?.includes('store-v2')) control.disposed.push(ctx.sessionManager.getSessionId()); });
 const provider = fauxProvider({provider:'fixture',api:'b1-faux',models:[{id:'faux',name:'B1 faux',contextWindow:${options.contextWindow ?? 32768},maxTokens:256,reasoning:false}],tokensPerSecond:100000});
 provider.setResponses(Array.from({length:${options.responseSupply ?? 100}},()=>async (context,options)=> {
  const serialized = JSON.stringify(context.messages);
  control.providerCalls.push(serialized); if(childSession) control.childProviderCalls.push(serialized);
  const last = [...context.messages].reverse().find(m=>m.role==='user'); const text=JSON.stringify(last);
  for (const [marker, gate] of control.responses) if (text.includes(marker)) await (marker === 'HOLD_CANCEL' ? Promise.race([gate, new Promise(resolve => { if(options.signal.aborted) resolve(); else options.signal.addEventListener('abort',resolve,{once:true}); })]) : gate);
  if(text.includes('structured context checkpoint') || text.includes('earlier context from an ongoing conversation') || text.includes('NEW conversation messages')) return fauxAssistantMessage('COMPACT_SUMMARY');
  const result = context.messages.at(-1)?.role === 'toolResult';
  if(text.includes('STORE_STREAM')) return fauxAssistantMessage('store-stream '+ 'x'.repeat(${options.streamSize ?? 8192}));
  if(text.includes('SPAWN_NONE') && !result) return fauxAssistantMessage(fauxToolCall('spawn_agent',{task_name:'one',message:'CHILD_WORK',fork_turns:'none'}),{stopReason:'toolUse'});
  if(result && context.messages.at(-1).isError) return fauxAssistantMessage('TOOL_REJECT '+JSON.stringify(context.messages.at(-1)));
  if(text.includes('REOPEN_GRANDCHILD')) {
    if(result) return fauxAssistantMessage('FOLLOWUP_ADMITTED');
    return fauxAssistantMessage(fauxToolCall('send_input',{target:'grandchild',message:'DEPTH_TWO'}),{stopReason:'toolUse'});
  }
  if(serialized.includes('EARLY_PARENT')) {
    if(result || serialized.includes('<subagent_completion')) return fauxAssistantMessage('PARENT_DONE');
    return fauxAssistantMessage(fauxToolCall('spawn_agent',{task_name:'grandchild',message:'HOLD_LEAF',fork_turns:'none'}),{stopReason:'toolUse'});
  }
  if(serialized.includes('WAIT_INPUT')) return fauxAssistantMessage('WAKE_INPUT_DONE');
  if(serialized.includes('NESTED_PARENT')) {
    if(serialized.includes('<subagent_completion')) return fauxAssistantMessage('NESTED_DONE');
    if(serialized.includes('\"toolName\":\"spawn_agent\"')) return fauxAssistantMessage(fauxToolCall('wait_agents',{targets:['grandchild']}),{stopReason:'toolUse'});
    return fauxAssistantMessage(fauxToolCall('spawn_agent',{task_name:'grandchild',message:control.responses.has('HOLD_LEAF')?'HOLD_LEAF':'DEPTH_TWO',fork_turns:'none'}),{stopReason:'toolUse'});
  }
  if(text.includes('DEPTH_TWO')) return fauxAssistantMessage(pi.getActiveTools().includes('spawn_agent')?'DEPTH_ERROR':'DEPTH_OK');
  if(serialized.includes('PROCESS_CHILD')) {
    if(serialized.includes('[stdout] PROCESS_OK')) return fauxAssistantMessage('PROCESS_DONE');
    if(serialized.includes("Process 'short' succeeded") || serialized.includes('\"action\":\"logs\"')) return fauxAssistantMessage(fauxToolCall('process',{action:'logs',target:'short',stream:'both',tailLines:20}),{stopReason:'toolUse'});
    if(serialized.includes('\"toolName\":\"process\"')) return fauxAssistantMessage('WAITING');
    return fauxAssistantMessage(fauxToolCall('process',{action:'start',name:'short',kind:'process',command:'sleep 1.5; printf PROCESS_OK',watches:[],continuation:{mode:'wait',until:{kind:'exit'}}}),{stopReason:'toolUse'});
  }
  if(text.includes('TIMEOUT_CHILD')) await new Promise(resolve => { if(options.signal.aborted) resolve(); else options.signal.addEventListener('abort',resolve,{once:true}); });
  if(text.includes('ABORT_CHILD') && !result) return fauxAssistantMessage(fauxToolCall('bash',{command:${JSON.stringify(`sleep 120 & child=$!; printf '%s' "$child" > '${join(dir, "bash-child.pid")}'; wait`)} }),{stopReason:'toolUse'});
  if(text.includes('SLOW_CHILD')) await new Promise(resolve=>setTimeout(resolve,200));
  return fauxAssistantMessage('B1_OK '+text);
 })); pi.registerProvider(provider.provider);
}; }
`);
  const factory = (await import(pathToFileURL(factoryPath).href)).createFixtureChildFactory;
  const descriptor = captureEntrypointDescriptorV1(join(source, "child.ts"));
  const manifest = { version: 1 as const, owner_id: "b1-faux-provider", main_entrypoint: descriptor, targets: { "pi-subagents": {
    child_entrypoint: descriptor, activation: "required-only" as const, commands: [], tools: [], providers: [{ provider_id: "fixture", service_tiers: [], service_tier_application: "none" as const }], hooks: [], requires: [],
    sdk_provider_factory: { provider_id: "fixture", package_manifest: captureEntrypointDescriptorV1(join(pkg, "package.json")), module: captureEntrypointDescriptorV1(factoryPath), export: "createFixtureChildFactory", config: {}, artifacts: [] },
  } } };
  await writeFile(join(dir, "sdk-provider-grants.json"), JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(manifest, "pi-subagents")] }));
  let ctx!: ExtensionContext;
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [] });
  let generation = 0;
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, settingsManager: settings, resourceLoaderOptions: {
      noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true, disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
      additionalExtensionPaths: [resolve(import.meta.dirname, "../../../pi-processes/dist/index.js")],
      extensionFactories: [factory(), pi => {
        const registry = getOrCreateChildCapabilityRegistryV1();
        const registration = registry.register({ version: 1, manifest });
        let binding: { release(): void } | undefined;
        pi.on("session_start", (_event, context) => { ctx = context; binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: context.sessionManager.getSessionId(), runtime_generation: ++generation, mode: "rpc" }); });
        pi.on("session_shutdown", () => { binding?.release(); registration.release(); });
      }, subagents],
    } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("fixture", "faux"), thinkingLevel: "off", tools: ["read", "bash", "process", "spawn_agent", "send_input", "resume_agent", "close_agent", "wait_agents", "list_agents"] });
    await result.session.bindExtensions({ mode: "rpc", onError: error => { throw new Error(JSON.stringify(error)); } });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: dir, agentDir: dir, sessionManager: SessionManager.create(dir, join(dir, "sessions")) });
  let disposal: Promise<void> | undefined;
  const disposeMain = () => disposal ??= runtime.dispose();
  return { dir, cell, settings, runtime, control, disposeMain, get context() { return ctx; },
    async close() {
      try { await disposeMain(); await cell.service?.close(); }
      finally {
        cell.service = undefined; cell.promise = undefined; delete (globalThis as any)[Symbol.for(key)];
        if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorDir;
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

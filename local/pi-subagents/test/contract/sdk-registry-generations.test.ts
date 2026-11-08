import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const legacy = new URL("../../../pi-runtime-contracts/test/fixtures/child-registry-abi1/index.ts", import.meta.url).href;
const current = import.meta.resolve("pi-runtime-contracts/child-capabilities-v1");
const proofApi = import.meta.resolve("pi-session-runtime/sdk-provider");
const assembly = import.meta.resolve("pi-session-runtime/session-assembly");
const catalog = new URL("../../dist/runtime/factory-catalog.js", import.meta.url).href;
const closure = new URL("../../dist/capabilities/closure.js", import.meta.url).href;
const faux = import.meta.resolve("@earendil-works/pi-ai/providers/faux");
for (const order of ["old-first", "new-first"]) test(`old physical provider registry + new supplemental proof executes an actual faux SDK request: ${order}`, () => {
  const script = `
    import assert from "node:assert/strict";
    import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sdk-mixed-generations-")));
    let runtime, oldRegistration, oldBinding, registration, binding;
    try {
      let oldApi, api, oldRegistry, registry;
      if (${JSON.stringify(order)} === "old-first") {
        oldApi = await import(${JSON.stringify(legacy)}); oldRegistry = oldApi.getOrCreateChildCapabilityRegistryV1();
        api = await import(${JSON.stringify(current)}); registry = api.getOrCreateChildCapabilityRegistryV1();
      } else {
        api = await import(${JSON.stringify(current)}); registry = api.getOrCreateChildCapabilityRegistryV1();
        oldApi = await import(${JSON.stringify(legacy)}); oldRegistry = oldApi.getOrCreateChildCapabilityRegistryV1();
      }
      const { approveSdkProviderV1, sdkProviderApprovalV1 } = await import(${JSON.stringify(proofApi)});
      const { childExecutionFactories } = await import(${JSON.stringify(catalog)});
      const { resolveToolCapabilityClosureV1 } = await import(${JSON.stringify(closure)});
      const { assembleChildSession, getSessionAssemblyPublicModules } = await import(${JSON.stringify(assembly)});
      writeFileSync(join(root, "package.json"), '{"name":"unbranded-mixed-generation-provider","type":"module"}');
      writeFileSync(join(root, "main.ts"), "export {};"); writeFileSync(join(root, "child.ts"), "export {};");
      writeFileSync(join(root, "factory.ts"), ${JSON.stringify(`import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(faux)};
export function create({version,target,agentDir,providerId,modelIds,config}) {
  if(version!==1 || target!=="pi-subagents" || !agentDir || providerId!=="generation-faux" || modelIds.join(",")!=="allowed" || config.flag!==true) throw new Error("bad assembly");
  const faux=fauxProvider({provider:providerId,api:"generation-faux",models:[{id:"allowed",contextWindow:32000,maxTokens:256}],tokensPerSecond:100000});
  faux.setResponses([fauxAssistantMessage("MIXED_GENERATIONS_OK")]); return pi=>pi.registerProvider(faux.provider);
}`)});
      const descriptor=api.captureEntrypointDescriptorV1(join(root,"child.ts"));
      const target={child_entrypoint:descriptor,activation:"required-only",commands:[],tools:[],providers:[{provider_id:"generation-faux",service_tiers:[],service_tier_application:"none"}],hooks:[],requires:[]};
      const oldManifest={version:1,owner_id:"old-provider-owner",main_entrypoint:api.captureEntrypointDescriptorV1(join(root,"main.ts")),targets:{"pi-subagents":target}};
      oldRegistration=oldRegistry.register({version:1,manifest:oldManifest});
      oldBinding=oldRegistry.bind({version:1,registrationToken:oldRegistration.registrationToken,session_id:"main",runtime_generation:1,mode:"rpc"});
      const manifest=api.validateChildCapabilityManifestV1({...oldManifest,owner_id:"external-sdk-faux",targets:{"pi-subagents":{...target,sdk_provider_factory:{provider_id:"generation-faux",package_manifest:api.captureEntrypointDescriptorV1(join(root,"package.json")),module:api.captureEntrypointDescriptorV1(join(root,"factory.ts")),export:"create",config:{flag:true},artifacts:[]}}}});
      writeFileSync(join(root,"sdk-provider-grants.json"),JSON.stringify({version:1,grants:[sdkProviderApprovalV1(manifest,"pi-subagents")]}));
      registration=registry.register({version:1,manifest});
      binding=registry.bind({version:1,registrationToken:registration.registrationToken,session_id:"main",runtime_generation:1,mode:"rpc"});
      const snapshot=registry.snapshot("main"), model_scope=["generation-faux/allowed"];
      const resolved=resolveToolCapabilityClosureV1({activeToolNames:[],allTools:[],role:{version:1,source_kind:"builtin",source_identity:"role",frontmatter:{name:"default",description:"test",tools:[]},body:"",content_sha256:"a".repeat(64),resolved_at:"2026-01-01T00:00:00.000Z"},registry:snapshot,registeredProviderIds:["generation-faux"],providerId:"generation-faux",agentDir:root});
      assert.equal(resolved.providerOwnerId,"external-sdk-faux"); assert.deepEqual(resolved.owners.map(owner=>owner.owner_id),["external-sdk-faux"]);
      const proof=approveSdkProviderV1(root,manifest,"pi-subagents",model_scope);
      const entry={owner:manifest.owner_id,main_entrypoint:manifest.main_entrypoint.canonical_path,child_entrypoint:descriptor.canonical_path,tools:[],providers:["generation-faux"],hooks:[],sha256:descriptor.sha256,sdk_provider:proof};
      const extensions=await childExecutionFactories({profile:{model_scope,capabilities:{entries:[entry]}},registry:snapshot,agentDir:root,sessionId:"child",getBridge:()=>undefined});
      // Releasing the old producer cannot retire the independent approved proof.
      oldBinding.release(); oldRegistration.release();
      const {SessionManager}=getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"];
      runtime=await assembleChildSession({cwd:root,agentDir:root,parentSettings:{compaction:{enabled:false},retry:{enabled:false}},projectTrusted:false,sessionManager:SessionManager.create(root,join(root,"sessions")),provider:"generation-faux",model:"allowed",thinkingLevel:"off",modelScope:model_scope,tools:[],systemPrompt:"faux only",extensions,shutdown:()=>{}});
      await runtime.session.prompt("Verify mixed registry generations",{source:"extension"});
      assert(runtime.session.messages.some(message=>message.role==="assistant"&&message.content.some(block=>block.type==="text"&&block.text==="MIXED_GENERATIONS_OK")));
      assert.equal(registry.snapshot("main").registrations.length,1);
      console.log("MIXED_GENERATIONS_OK");
    } finally {
      await runtime?.dispose(); binding?.release(); registration?.release(); oldBinding?.release(); oldRegistration?.release(); rmSync(root,{recursive:true,force:true});
    }
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /MIXED_GENERATIONS_OK/);
});

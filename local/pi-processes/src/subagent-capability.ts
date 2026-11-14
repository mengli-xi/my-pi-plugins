import { dirname, join, relative } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  captureEntrypointDescriptorV1,
  captureChildFactoryV1,
  getOrCreateChildCapabilityRegistryV1,
  type ChildCapabilityBindingHandleV1,
} from "pi-runtime-contracts/child-capabilities-v1";

declare const PROCESSES_MAIN_ENTRYPOINT: string;

export function installProcessChildCapability(distDirectory: string) {
  // The stable Main proof follows the host's public tool source; child files
  // are pinned to this runtime's immutable build, relative to the real package.
  const main = join(distDirectory, typeof PROCESSES_MAIN_ENTRYPOINT === "undefined" ? "index.js" : PROCESSES_MAIN_ENTRYPOINT);
  const modulePath = (name: string) => relative(dirname(dirname(main)), join(distDirectory, name));
  const registry = getOrCreateChildCapabilityRegistryV1();
  const registration = registry.register({ version: 1, manifest: {
    version: 1,
    owner_id: "pi-processes",
    main_entrypoint: captureEntrypointDescriptorV1(main),
    targets: {
      "pi-subagents": {
        child_factory: captureChildFactoryV1(main, { module: modulePath("child-factory.js"), export: "createProcessesChildFactory" }),
        child_entrypoint: captureEntrypointDescriptorV1(join(distDirectory, "child.js")),
        activation: "required-only",
        commands: [], tools: ["process"], providers: [], hooks: ["execution/cancel-pending-v1", "execution/process-wait-v2"], requires: [],
      },
      "pi-side-chat": {
        child_factory: captureChildFactoryV1(main, { module: modulePath("index.js"), export: "createProcessesSideFactory", artifacts: [modulePath("child-factory.js")] }),
        child_entrypoint: captureEntrypointDescriptorV1(join(distDirectory, "child.js")),
        activation: "required-only", commands: [], tools: ["process"], providers: [], hooks: ["execution/cancel-pending-v1"], requires: [],
      },
    },
  } });
  const bindings = new Map<string, ChildCapabilityBindingHandleV1>(); let generation = 0;
  return {
    bind(ctx: ExtensionContext) { const sessionId=ctx.sessionManager.getSessionId(); bindings.get(sessionId)?.release(); const binding=registry.bind({version:1,registrationToken:registration.registrationToken,session_id:sessionId,runtime_generation:++generation,mode:ctx.mode==="json"?"print":ctx.mode}); bindings.set(sessionId,binding); },
    release(ctx?: ExtensionContext) { let sessionId: string|undefined; try { sessionId=ctx?.sessionManager.getSessionId(); } catch { /* invalidated */ } if(sessionId){bindings.get(sessionId)?.release();bindings.delete(sessionId);}else{for(const binding of bindings.values())binding.release();bindings.clear();} },
    dispose(){for(const binding of bindings.values())binding.release();bindings.clear();registration.release();},
  };
}

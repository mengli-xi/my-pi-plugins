import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  captureEntrypointDescriptorV1,
  getOrCreateChildCapabilityRegistryV1,
  type ChildCapabilityBindingHandleV1,
} from "pi-runtime-contracts/child-capabilities-v1";

export function installNativeSearchChildCapability(directory: string) {
  const registry = getOrCreateChildCapabilityRegistryV1();
  const registration = registry.register({
    version: 1,
    manifest: {
      version: 1,
      owner_id: "pi-native-search",
      main_entrypoint: captureEntrypointDescriptorV1(join(directory, "index.ts")),
      targets: {
        "pi-subagents": {
          child_entrypoint: captureEntrypointDescriptorV1(join(directory, "child.ts")),
          activation: "required-only",
          commands: [],
          tools: ["web_fetch", "web_search"],
          providers: [],
          hooks: [],
          requires: [],
        },
      },
    },
  });
  const bindings = new Map<string, ChildCapabilityBindingHandleV1>();
  let generation = 0;
  return {
    bind(ctx: ExtensionContext): void {
      const sessionId = ctx.sessionManager.getSessionId();
      bindings.get(sessionId)?.release();
      bindings.set(sessionId, registry.bind({
        version: 1,
        registrationToken: registration.registrationToken,
        session_id: sessionId,
        runtime_generation: ++generation,
        mode: ctx.mode === "json" ? "print" : ctx.mode,
      }));
    },
    release(ctx?: ExtensionContext): void {
      let sessionId: string | undefined;
      try { sessionId = ctx?.sessionManager.getSessionId(); } catch { /* replaced context */ }
      if (sessionId) { bindings.get(sessionId)?.release(); bindings.delete(sessionId); }
      else { for (const binding of bindings.values()) binding.release(); bindings.clear(); }
    },
    dispose(): void {
      for (const binding of bindings.values()) binding.release();
      bindings.clear();
      registration.release();
    },
  };
}

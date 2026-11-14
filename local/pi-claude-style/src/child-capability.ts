import { basename, dirname, join, relative } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  captureEntrypointDescriptorV1,
  captureChildFactoryV1,
  getOrCreateChildCapabilityRegistryV1,
  type ChildCapabilityBindingHandleV1,
} from "pi-runtime-contracts/child-capabilities-v1";

export function installClaudeStyleChildCapability(distDirectory: string) {
  // The stable Main proof follows the host's public tool source; child files
  // are pinned to this runtime's immutable build, relative to the real package.
  const main = join(distDirectory, ...(basename(dirname(distDirectory)).startsWith(".build-") ? ["../..", "index.ts"] : ["index.ts"]));
  const modulePath = (name: string) => relative(dirname(dirname(main)), join(distDirectory, name));
  const registry = getOrCreateChildCapabilityRegistryV1();
  const childEntrypoint = captureEntrypointDescriptorV1(join(distDirectory, "child.ts"));
  const target = {
    child_factory: captureChildFactoryV1(main, { kind: "presentation", module: modulePath("child.ts"), export: "createClaudeStyleChildExtension" }),
    child_entrypoint: childEntrypoint,
    activation: "mirror" as const,
    commands: [],
    // Presentation resolves renderers only. Pi and domain factories retain
    // tool definitions, schemas, execution, availability and active selection.
    tools: [],
    providers: [],
    hooks: ["presentation/claude-style-v1"],
    requires: [],
  };
  const registration = registry.register({ version: 1, manifest: {
    version: 1,
    owner_id: "pi-claude-style",
    main_entrypoint: captureEntrypointDescriptorV1(main),
    targets: {
      "pi-side-chat": target,
      "pi-subagents": target,
    },
  } });
  const bindings = new Map<string, ChildCapabilityBindingHandleV1>();
  let generation = 0;
  return {
    bind(ctx: ExtensionContext) {
      const sessionId = ctx.sessionManager.getSessionId();
      bindings.get(sessionId)?.release();
      const binding = registry.bind({
        version: 1,
        registrationToken: registration.registrationToken,
        session_id: sessionId,
        runtime_generation: ++generation,
        mode: ctx.mode === "json" ? "print" : ctx.mode,
      });
      bindings.set(sessionId, binding);
    },
    release(ctx?: ExtensionContext) {
      let sessionId: string | undefined;
      try { sessionId = ctx?.sessionManager.getSessionId(); } catch { /* replacement invalidated context */ }
      if (sessionId) { bindings.get(sessionId)?.release(); bindings.delete(sessionId); }
      else { for (const binding of bindings.values()) binding.release(); bindings.clear(); }
    },
    dispose() { for (const binding of bindings.values()) binding.release(); bindings.clear(); registration.release(); },
  };
}

import type { ContextWithSystemEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  acquireEffectiveCapture, contextFingerprint, getEffectiveContextGeneration, getEffectiveContextStore,
  requiresEffectiveCapture,
  type ContextIdentity, type EffectiveCaptureLease,
} from "pi-session-runtime/effective-context";
export { getEffectiveContextStore } from "pi-session-runtime/effective-context";
import { describeNativeContext, describeAuxiliaryPreamble } from "pi-session-runtime/native-child-context";
import { getOrCreateChildCapabilityRegistryV1 } from "../capabilities/registry.js";

export interface MainCaptureOwner { sessionId: string; retired: boolean; captureLease?: EffectiveCaptureLease }

export async function observeMainEffectiveRequest(pi: ExtensionAPI, event: ContextWithSystemEvent, ctx: ExtensionContext, owner: MainCaptureOwner): Promise<void> {
  if (owner.retired || ctx.sessionManager.getSessionId() !== owner.sessionId || !ctx.signal) return;
  const signal = ctx.signal;
  const branch = ctx.sessionManager.getBranch();
  const leafId = ctx.sessionManager.getLeafId();
  try {
    owner.captureLease ??= acquireEffectiveCapture({ owner: "pi-subagents", sessionId: owner.sessionId, binding: ctx.sessionManager });
    const identity = await describeMainEffectiveContext(pi, ctx);
    if (owner.retired || signal.aborted) return;
    owner.captureLease.refreshProviders(ctx.modelRegistry);
    owner.captureLease.observe({ ...identity, leafId, signal, auxiliaryMessages: event.messages, nativeOrigins: describeNativeContext(branch), knownPreamble: describeAuxiliaryPreamble(event.messages) });
  } catch {
    if (!owner.retired) { owner.captureLease?.endRequest(); getEffectiveContextStore().invalidate(owner.sessionId, "capture-observation-unavailable"); }
  }
}

/** Fingerprint the live Main loadout, independent of a particular child's restricted profile. */
export async function describeMainEffectiveContext(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ContextIdentity> {
  const sessionId = ctx.sessionManager.getSessionId();
  const allTools = pi.getAllTools();
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  const active = pi.getActiveTools().map((name) => {
    const tool = byName.get(name);
    return tool ? { name, description: tool.description, parameters: tool.parameters, sourceInfo: tool.sourceInfo } : { name, unavailable: true };
  });
  const model = ctx.model;
  const registry = getOrCreateChildCapabilityRegistryV1().snapshot(sessionId);
  return {
    sessionId, generation: getEffectiveContextGeneration(sessionId) ?? 0,
    selectedModel: { provider: model?.provider ?? "", id: model?.id ?? "" }, thinkingLevel: ctx.thinkingLevel ?? "off",
    toolLoadoutFingerprint: contextFingerprint(active),
    capabilityFingerprint: contextFingerprint({
      registry: { registrations: registry.registrations, conflicts: registry.conflicts },
      sources: [...allTools.map((tool) => tool.sourceInfo), ...pi.getCommands().map((command) => command.sourceInfo)],
      providers: ctx.modelRegistry.getRegisteredProviderIds(),
      model: model && { provider: model.provider, id: model.id, api: model.api, input: model.input, reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens },
    }),
  };
}

export function mainRequiresEffectiveCapture(identity: ContextIdentity): boolean {
  return requiresEffectiveCapture({
    requestTransforms: getEffectiveContextStore().requestTransforms(identity.sessionId, identity.generation, identity.capabilityFingerprint),
  });
}

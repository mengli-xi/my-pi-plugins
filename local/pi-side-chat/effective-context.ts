import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  acquireEffectiveCapture, contextFingerprint, getEffectiveContextGeneration, getEffectiveContextStore,
  requiresEffectiveCapture, type ContextIdentity, type EffectiveCaptureLease,
} from "pi-session-runtime/effective-context";
import {
  captureInvalidReason, describeNativeContext, describeAuxiliaryPreamble, selectEffectiveContext,
  type EffectiveContextSelection,
} from "pi-session-runtime/native-child-context";
import { getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";

export interface MainContextSnapshot {
  messages: AgentMessage[];
  baseSystemPrompt: string;
  systemPrompt: string;
  systemPromptOptions: BuildSystemPromptOptions;
  cacheLineageId: string;
  exactPrefix: boolean;
}

/** Same live Main identity as the other shared-capture consumer, not Side's restricted loadout. */
function identity(pi: ExtensionAPI, ctx: ExtensionContext): ContextIdentity {
  const sessionId = ctx.sessionManager.getSessionId();
  const allTools = pi.getAllTools();
  const byName = new Map(allTools.map(tool => [tool.name, tool]));
  const active = pi.getActiveTools().map(name => {
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
      sources: [...allTools.map(tool => tool.sourceInfo), ...pi.getCommands().map(command => command.sourceInfo)],
      providers: ctx.modelRegistry.getRegisteredProviderIds(),
      model: model && { provider: model.provider, id: model.id, api: model.api, input: model.input, reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens },
    }),
  };
}

/** Public provider capture only; no ExtensionRunner ownership or prototype interception. */
export class MainContextSource {
  private readonly pi: ExtensionAPI;
  private lease?: EffectiveCaptureLease;
  private sessionId?: string;
  private options?: BuildSystemPromptOptions;
  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    pi.on("session_start", (_event, ctx) => { this.bind(ctx); });
    pi.on("before_agent_start", event => { this.options = structuredClone(event.systemPromptOptions); });
    pi.on("context_with_system", (event, ctx) => {
      if (!ctx.signal) return;
      try {
        this.bind(ctx);
        this.lease!.refreshProviders(ctx.modelRegistry);
        this.lease!.observe({ ...identity(pi, ctx), leafId: ctx.sessionManager.getLeafId(), signal: ctx.signal,
          auxiliaryMessages: event.messages, nativeOrigins: describeNativeContext(ctx.sessionManager.getBranch()),
          knownPreamble: describeAuxiliaryPreamble(event.messages) });
      } catch {
        this.lease?.endRequest();
        getEffectiveContextStore().invalidate(ctx.sessionManager.getSessionId(), "capture-observation-unavailable");
      }
    });
    pi.on("before_provider_request", (_event, ctx) => { this.lease?.confirmRequest(ctx.signal); });
    pi.on("after_provider_response", (_event, ctx) => { this.lease?.confirmRequest(ctx.signal); });
    pi.on("agent_settled", () => { this.lease?.endRequest(); });
    pi.on("session_shutdown", () => { this.lease?.retire(); this.lease = undefined; this.sessionId = undefined; this.options = undefined; });
  }
  private bind(ctx: ExtensionContext): void {
    const id = ctx.sessionManager.getSessionId();
    if (this.sessionId === id && this.lease) return;
    this.lease?.release(); this.sessionId = id;
    this.lease = acquireEffectiveCapture({ owner: "pi-side-chat", sessionId: id, binding: ctx.sessionManager });
  }
  select(ctx: ExtensionContext, acceptNativeOnce = false): EffectiveContextSelection {
    this.bind(ctx);
    const current = identity(this.pi, ctx);
    const store = getEffectiveContextStore();
    let capture = store.get(current.sessionId, current.generation);
    const branch = ctx.sessionManager.getBranch();
    const input = { mode: "all" as const, identity: current, branch, capture, requiresCapture: true };
    if (capture && captureInvalidReason(capture, input)) {
      store.invalidate(current.sessionId, captureInvalidReason(capture, input)!); capture = undefined;
    }
    const requiresCapture = !acceptNativeOnce && requiresEffectiveCapture({
      requestTransforms: store.requestTransforms(current.sessionId, current.generation, current.capabilityFingerprint) });
    try { return selectEffectiveContext({ ...input, capture, requiresCapture, unavailableReason: store.reason(current.sessionId) }); }
    catch (error) {
      if ((error as { code?: string }).code === "effective-context-unavailable") throw new Error("Main effective context is unavailable. Complete one Main turn first, or explicitly accept native records for this Side only (they may contain incomplete summaries or unprocessed history).");
      throw error;
    }
  }
  snapshot(ctx: ExtensionContext, acceptNativeOnce = false): MainContextSnapshot {
    // BTW is also useful before the first Main turn. An empty conversation has
    // no discarded history to resurrect; keep its original tool-free behavior.
    const empty = describeNativeContext(ctx.sessionManager.getBranch()).every(origin => origin.message.role === "system");
    const selection = this.select(ctx, acceptNativeOnce || empty);
    const systemMessage = getCurrentSystemMessage(selection.messages);
    const system = systemMessage ? getSystemMessageText(systemMessage) : ctx.getSystemPrompt();
    return { messages: structuredClone(selection.messages.filter(message => message.role !== "system")),
      systemPrompt: system, baseSystemPrompt: system, systemPromptOptions: structuredClone(this.options ?? { cwd: ctx.cwd }),
      cacheLineageId: ctx.sessionManager.getSessionId(), exactPrefix: selection.exactRequestPrefix };
  }
}

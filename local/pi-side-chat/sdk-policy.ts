import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Model, Api } from "@earendil-works/pi-ai";
import { convertToLlm, estimateTokens, serializeConversation, type AgentSessionRuntime, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { childCompactionSettings } from "pi-session-runtime/session-assembly";
import { contextFingerprint } from "pi-session-runtime/effective-context";
import { rewritePromptCacheLineage } from "./cache-lineage.ts";

const ref = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
/** Conservative local estimate, not a provider tokenizer or wire-cache claim. */
function tokens(messages: readonly AgentMessage[]): number { return messages.reduce((sum, message) => sum + estimateTokens(message), 0); }

export function createSidePolicy(input: { prefix?: readonly Message[]; boundaryType: string; modelScope: readonly string[]; thinkingLevel: string; cacheLineageId?: string }) {
  let prefix = input.prefix ? structuredClone([...input.prefix]) : undefined;
  let prefixEligible = !!prefix;
  let runtime: AgentSessionRuntime | undefined;
  let disposed = false;
  let cancellation = 0;
  let initialLoadout: string | undefined;
  let preflight: Promise<void> | undefined;
  const scope = new Set(input.modelScope);
  const leavePrefix = () => { prefix = undefined; prefixEligible = false; };
  const assertModel = (model: Model<Api>) => { if (!scope.has(ref(model))) throw new Error(`Model is outside the Side scope: ${ref(model)}`); };
  const updateBudgets = (model: Model<Api>) => {
    if (!runtime) return;
    const budgets = childCompactionSettings(model);
    runtime.services.settingsManager.applyOverrides({ compaction: { ...budgets,
      modelOverrides: { [ref(model)]: { reserveTokens: budgets.reserveTokens, keepRecentTokens: budgets.keepRecentTokens } } } });
  };
  const loadout = () => runtime && contextFingerprint(runtime.session.getActiveToolNames().map(name => {
    const tool = runtime!.session.getToolDefinition(name);
    return { name, description: tool?.description, parameters: tool?.parameters };
  }));
  const extension: ExtensionFactory = pi => {
    pi.on("before_agent_start", (event, ctx) => {
      if (prefix && (ctx.thinkingLevel !== input.thinkingLevel || loadout() !== initialLoadout)) leavePrefix();
      // This is a mutable public normalized options object. Main's force override
      // must not collapse the captured multi-system transcript a second time.
      if (prefix) delete event.systemPromptOptions.forceSystemPrompt;
    });
    pi.on("context_with_system", event => {
      if (prefix && loadout() !== initialLoadout) leavePrefix();
      if (!prefix) return;
      const boundary = event.messages.findIndex(message => message.role === "custom" && message.customType === input.boundaryType);
      if (boundary < 0) { leavePrefix(); return; }
      return { messages: [...structuredClone(prefix), ...event.messages.slice(boundary)] };
    });
    pi.on("model_select", event => { leavePrefix(); updateBudgets(event.model); });
    pi.on("thinking_level_select", () => { leavePrefix(); });
    pi.on("session_before_compact", event => {
      leavePrefix();
      if (!runtime?.session.model) return { cancel: true };
      const preparation = event.preparation;
      // Native compaction serializes messages into summary text; estimate that
      // representation, including room for Pi's fixed instructions and output.
      const summaryInput = Math.max(
        serializeConversation(convertToLlm(preparation.messagesToSummarize)).length + (preparation.previousSummary?.length ?? 0),
        serializeConversation(convertToLlm(preparation.turnPrefixMessages)).length,
      );
      const model = runtime.session.model;
      if (Math.ceil(summaryInput / 4) + 1024 + Math.ceil(preparation.settings.reserveTokens * 0.8) >= model.contextWindow) return { cancel: true };
    });
    pi.on("session_compact", leavePrefix);
    pi.on("session_shutdown", () => { disposed = true; leavePrefix(); });
  };
  async function ensureCapacity(extra = ""): Promise<void> {
    if (!runtime || disposed) throw new Error("Side is destroyed");
    if (preflight) return preflight;
    const revision = cancellation;
    const session = runtime.session;
    const selected = session.model!;
    const thinking = session.thinkingLevel;
    assertModel(selected); updateBudgets(selected);
    const estimate = tokens(session.messages) + Math.ceil(Buffer.byteLength(extra) / 3) + 1024;
    if (estimate < selected.contextWindow - childCompactionSettings(selected).reserveTokens) return;
    leavePrefix();
    preflight = (async () => {
      // An authorized larger model can summarize a prefix that the selected model
      // cannot accept. Never send an oversized summary request to the small model.
      const required = Math.ceil(serializeConversation(convertToLlm(session.messages)).length / 4) + 1024;
      const candidates = runtime!.services.modelRuntime.getModels().filter(model => scope.has(ref(model)))
        .filter(model => required + childCompactionSettings(model).reserveTokens < model.contextWindow)
        .sort((a, b) => (ref(a) === ref(selected) ? -1 : ref(b) === ref(selected) ? 1 : a.contextWindow - b.contextWindow));
      const summaryModel = candidates[0];
      if (!summaryModel) throw new Error("Side context exceeds every allowed compaction input window. Choose a larger allowed model or destroy Side and start with a smaller Main context.");
      try {
        if (ref(summaryModel) !== ref(selected)) await session.setModel(summaryModel);
        if (disposed || revision !== cancellation) throw new Error("Side compaction interrupted");
        await session.compact();
      } finally {
        if (!disposed && ref(session.model!) !== ref(selected)) { await session.setModel(selected); session.setThinkingLevel(thinking); }
      }
      if (disposed || revision !== cancellation) throw new Error("Side compaction interrupted");
      const after = tokens(session.messages) + Math.ceil(Buffer.byteLength(extra) / 3) + 1024;
      if (after >= selected.contextWindow - childCompactionSettings(selected).reserveTokens) throw new Error("Native compaction did not reduce Side context enough for the selected model; select a larger model.");
    })().finally(() => { preflight = undefined; });
    return preflight;
  }
  return {
    extension, ensureCapacity,
    get exactPrefixPending() { return prefixEligible; },
    bind(value: AgentSessionRuntime) {
      runtime = value;
      initialLoadout = loadout();
      const session = value.session;
      const originalSet = session.setModel.bind(session);
      session.setModel = async (model, options) => { assertModel(model); await originalSet(model, options); updateBudgets(model); };
      // Guard the public runtime request boundary too, covering native UI, tools,
      // notification-triggered turns and summary calls, not only owner.prompt().
      const modelRuntime = value.services.modelRuntime;
      // Both native selector scopes (including its All tab) see only Side's frozen catalog.
      const available = modelRuntime.getAvailable.bind(modelRuntime);
      const snapshot = modelRuntime.getAvailableSnapshot.bind(modelRuntime);
      modelRuntime.getAvailable = async (...args) => (await available(...args)).filter(model => scope.has(ref(model)));
      modelRuntime.getAvailableSnapshot = () => snapshot().filter(model => scope.has(ref(model)));
      const stream = modelRuntime.streamSimple.bind(modelRuntime);
      modelRuntime.streamSimple = (model, context, options) => {
        if (disposed) throw new Error("Side is destroyed");
        assertModel(model);
        const messages = "messages" in context ? context.messages : [];
        if (tokens(messages) + 256 >= model.contextWindow) throw new Error("Side request exceeds the selected model window; compact or select a larger model first");
        if (prefix && options?.sessionId === session.sessionManager.getSessionId()) {
          const exact = contextFingerprint(messages.slice(0, prefix.length)) === contextFingerprint(prefix);
          if (!exact) throw new Error("Side initial provider prefix changed; refusing an inexact replay");
          prefix = undefined;
          // A normalized prefix alone never proves the provider wire/cache key.
          const onPayload = options.onPayload;
          const lineage = input.cacheLineageId;
          if (lineage) options = { ...options, onPayload: async (payload, requestModel) => {
            const result = await onPayload?.(payload, requestModel);
            return rewritePromptCacheLineage(model.api, result ?? payload, lineage);
          } };
          prefixEligible = false;
        }
        return stream(model, context, options);
      };
      updateBudgets(session.model!);
    },
    cancelPreflight() { cancellation++; },
    retire() { disposed = true; cancellation++; leavePrefix(); },
    async dispose() { disposed = true; leavePrefix(); await preflight?.catch(() => undefined); },
  };
}

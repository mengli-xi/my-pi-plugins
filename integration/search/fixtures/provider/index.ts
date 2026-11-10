import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export interface ProviderControl {
  requests: Array<{ child: boolean; tools: string[]; messages: unknown[] }>;
}

/** Only the actor is fake: the approved provider runs inside the actual SDK child. */
export function createSearchFixtureProvider(input: { config: { controlKey: string } }) {
  return (pi: ExtensionAPI) => {
    const control = (globalThis as any)[Symbol.for(input.config.controlKey)] as ProviderControl;
    let child = false;
    pi.on("session_start", (_event, ctx) => { child = !!ctx.sessionManager.getSessionFile()?.includes("store-v2"); });
    const faux = fauxProvider({ provider: "search-faux", api: "search-integration-faux", tokensPerSecond: 1000000,
      models: [{ id: "offline", contextWindow: 64000, maxTokens: 512 }] });
    faux.setResponses(Array.from({ length: 100 }, () => context => {
      control.requests.push({ child, tools: getCurrentTools(context.messages).map(tool => tool.name), messages: structuredClone(context.messages) });
      const lastUser = [...context.messages].reverse().find(message => message.role === "user");
      const text = JSON.stringify(lastUser);
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") {
        if (child && last.toolName === "web_search") return fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://page.fixture.invalid/forbidden" }), { stopReason: "toolUse" });
        return fauxAssistantMessage(child ? "SEARCH_CHILD_DONE" : "SEARCH_MAIN_DONE");
      }
      if (text.includes("SPAWN_SEARCH")) return fauxAssistantMessage(fauxToolCall("spawn_agent", {
        task_name: "searcher", agent_type: "search-only", message: "SEARCH_CHILD query", fork_turns: "none",
      }), { stopReason: "toolUse" });
      if (text.includes("FETCH_MAIN")) return fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://page.fixture.invalid/allowed" }), { stopReason: "toolUse" });
      if (text.includes("SEARCH_MAIN") || text.includes("SEARCH_CHILD")) return fauxAssistantMessage(fauxToolCall("web_search", { query: child ? "SEARCH_CHILD query" : "SEARCH_MAIN query" }), { stopReason: "toolUse" });
      return fauxAssistantMessage("SEARCH_IDLE");
    }));
    pi.registerProvider(faux.provider);
  };
}

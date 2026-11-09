import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function contextCompactFixture(pi) {
  const root = process.env.CC_CONTEXT_COMPACT_ROOT;
  const log = (value) => appendFileSync(`${root}/events.jsonl`, `${JSON.stringify(value)}\n`);
  const faux = fauxProvider({ provider: "context-fixture", api: "context-fixture",
    models: [{ id: "main", contextWindow: 1_000_000, maxTokens: 8192 },
      { id: "small", contextWindow: 1_000_000, maxTokens: 8192 }], tokensPerSecond: 10_000_000 });
  const respond = (context, _options, _state, model) => {
    const text = JSON.stringify(context.messages);
    const custom = text.includes("Summarize the paused session");
    const native = text.includes("<conversation>") || text.includes("# Conversation");
    log({ event: "request", kind: custom ? "custom" : native ? "native" : "business", model: model.id });
    if (custom) {
      const prompt = context.messages.map((m) => typeof m.content === "string" ? m.content
        : (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")).join("\n");
      const ids = (prompt.split("Required user/QA sources: ")[1]?.split("\n")[0] ?? "none")
        .replace(/\.$/, "").split(", ").filter((id) => id && id !== "none");
      const data = { version: 1, goal: { text: "Continue the fixture.", sourceEntryIds: [], phase: "active" },
        progress: [], inFlight: [], openQuestions: [], nextActions: [], references: [],
        userMessages: { mode: prompt.includes("User-message mode: key_points") ? "key_points" : "verbatim",
          items: ids.map((id) => ({ kind: id.startsWith("Q") ? "qa" : "user", sourceRefs: [id], text: "" })) },
        uncertainties: [], memoryCandidates: [], restoreSkills: [] };
      return model.id === "small"
        ? fauxAssistantMessage([{ type: "toolCall", id: "submit", name: "submit_compaction", arguments: data }], { stopReason: "toolUse" })
        : fauxAssistantMessage(JSON.stringify(data));
    }
    if (native) return fauxAssistantMessage("NATIVE_SUMMARY Continue the fixture.");
    return fauxAssistantMessage(text.includes("AFTER_COMPACT") ? "AFTER_REPLY" : "OLD_REPLY " + "history ".repeat(500));
  };
  faux.setResponses(Array.from({ length: 40 }, () => respond));
  const stream = faux.provider.streamSimple;
  faux.provider.streamSimple = (model, context, options) => {
    const source = stream.call(faux.provider, model, context, options);
    const target = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type === "done") {
          const after = JSON.stringify(context.messages).includes("AFTER_COMPACT");
          event.message.usage = { input: after ? 10_000 : 180_000, output: 100,
            cacheRead: 30_000, cacheWrite: 10_000, totalTokens: after ? 50_100 : 220_100,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        }
        target.push(event);
      }
    })();
    return target;
  };
  pi.registerProvider(faux.provider);
  pi.on("agent_end", (_event, ctx) => {
    writeFileSync(`${root}/before-id`, ctx.sessionManager.getLeafId());
    log({ event: "idle" });
  });
  pi.on("session_compact", (event) => {
    writeFileSync(`${root}/compact-id`, event.compactionEntry.id);
    log({ event: "compact", fromHook: event.compactionEntry.fromHook });
  });
  for (const [name, file] of [["before", "before-id"], ["after", "compact-id"]]) {
    pi.registerCommand(`fixture-${name}`, { description: `Navigate to ${name} compaction`, handler: async (_args, ctx) => {
      await ctx.navigateTree(readFileSync(`${root}/${file}`, "utf8"), { summarize: false });
      log({ event: "tree", name });
    } });
  }
  pi.registerCommand("fixture-diagnostics", { description: "Capture internals details", handler: async (_args, ctx) => {
    const entry = ctx.sessionManager.getBranch().findLast((e) => e.type === "custom_message" && e.customType === "internals");
    writeFileSync(`${root}/internals.txt`, entry?.details ?? "missing internals");
  } });
}

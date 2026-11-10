// Deterministic provider used only by the stock-binary PTY regression.
// @ts-nocheck
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
export function createSdkFixtureFactory() {
  return pi => {
    const root = process.env.PI_S2_VIEW_ROOT;
    const log = value => appendFileSync(join(root, "events.jsonl"), JSON.stringify({ at: Date.now(), ...value }) + "\n");
    let ctx;
    const role = () => ctx?.sessionManager.getSessionFile()?.includes("side-session.jsonl") ? "side" : "main";
    const provider = fauxProvider({ provider: "side-fixture", api: "s2-faux", models: [
      { id: "faux-view", name: "S2 deterministic", contextWindow: 32768, maxTokens: 2048, reasoning: true },
      { id: "faux-small", name: "S2 smaller", contextWindow: 16384, maxTokens: 1024, reasoning: true },
      { id: "faux-forbidden", name: "Outside Side scope", contextWindow: 32768, maxTokens: 2048 },
    ], tokensPerSecond: 300 });
    provider.setResponses(Array.from({ length: 200 }, () => async (context, options) => {
      const text = JSON.stringify([...context.messages].reverse().find(message => message.role === "user")?.content ?? "");
      log({ event: "request", role: role(), text, pid: process.pid, reasoning: options?.reasoning });
      if (text.includes("BTW_SDK_HANDOFF")) {
        log({ event: "btw-started" });
        await new Promise(resolve => { const tick = setInterval(() => { if (existsSync(join(root, "btw-release"))) { clearInterval(tick); resolve(); } }, 20); });
        log({ event: "btw-resolved" });
        return fauxAssistantMessage("BTW_SDK_ANSWER");
      }
      const compact = text.includes("ummar") || text.includes("<conversation>");
      if (!compact && text.includes("HOLD")) await new Promise(resolve => {
        const tick = setInterval(() => { if (options.signal.aborted || existsSync(join(root, "release"))) { clearInterval(tick); resolve(); } }, 20);
      });
      if (!compact && text.includes("BASH_TIMEOUT_") && context.messages.at(-1)?.role !== "toolResult") {
        const name = text.includes("MISSING") ? "missing" : text.includes("INVALID") ? "invalid" : "valid";
        const args = { command: `printf ${name === "valid" ? "SIDE_OK" : "BAD"} > '${join(root, `timeout-${name}`)}'`,
          ...(name === "missing" ? {} : { timeout: name === "invalid" ? 0 : 2 }) };
        return fauxAssistantMessage(fauxToolCall("bash", args), { stopReason: "toolUse" });
      }
      if (!compact && text.includes("TOOL") && context.messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage([fauxThinking("Inspect the shared native tool presentation."), fauxToolCall("read", { path: join(root, "fixture.txt") })], { stopReason: "toolUse" });
      return fauxAssistantMessage(compact ? "COMPACTION_PRIVATE_MAIN_SECRET" : `${role() === "side" ? "SIDE_REPLY" : "MAIN_REPLY"} ${text} complete`);
    }));
    pi.registerProvider(provider.provider);
    pi.on("session_start", async (_event, context) => {
      ctx = context;
      if (role() === "side" && context.mode !== "tui" && process.env.PI_S2_P3_FIXES && !existsSync(join(root, "open-release"))) {
        log({ event: "opening-paused" });
        await new Promise(resolve => { const tick = setInterval(() => { if (existsSync(join(root, "open-release"))) { clearInterval(tick); resolve(); } }, 20); });
      }
      const state = globalThis[Symbol.for("s2-view-fixture")] ??= { contexts: new Map() };
      state.contexts.set(role(), context);
      (state.apis ??= new Map()).set(role(), pi);
      log({ event: "bound", role: role(), mode: context.mode, session: context.sessionManager.getSessionId(), pid: process.pid, file: context.sessionManager.getSessionFile() });
    });
    pi.on("session_shutdown", async (_event, context) => {
      if (context.sessionManager.getSessionId() === "s2-main") return;
      log({ event: "side-cleanup-start" });
      if (process.env.PI_S2_SLOW_SHUTDOWN === "1") await new Promise(resolve => setTimeout(resolve, 1500));
      log({ event: "side-cleanup-end" });
    });
  };
}

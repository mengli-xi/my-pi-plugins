// @ts-nocheck
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
export function createFixtureChildFactory() {
  return pi => {
    const root = process.env.PI_SDK_VIEW_ROOT;
    const log = value => appendFileSync(join(root, "events.jsonl"), JSON.stringify({ at: Date.now(), ...value }) + "\n");
    let ctx, drift;
    const provider = fauxProvider({ provider: "fixture", api: "b3-faux", models: [{ id: "faux-view", name: "B3 deterministic", contextWindow: 32768, maxTokens: 2048, reasoning: true }], tokensPerSecond: process.env.PI_SDK_VIEW_CD === "mouse" ? 100000 : 150 });
    provider.setResponses(Array.from({ length: 200 }, () => async (context, options) => {
      const last = [...context.messages].reverse().find(message => message.role === "user");
      const text = JSON.stringify(last?.content ?? "");
      log({ event: "request", role: ctx?.sessionManager.getSessionFile()?.includes("store-v2") ? "child" : "main",
        session: ctx?.sessionManager.getSessionId(), lastRole: context.messages.at(-1)?.role, text, messages: context.messages });
      if(text.includes("D_NEST_UI") && context.messages.at(-1)?.role!=="toolResult") return fauxAssistantMessage(fauxToolCall("spawn_agent",{task_name:"unread_leaf",message:"LEAF_UI",fork_turns:"none"}),{stopReason:"toolUse"});
      if (text.includes("HOLD")) await new Promise(resolve => {
        const tick = setInterval(() => { if (options.signal.aborted || existsSync(join(root, "release"))) { clearInterval(tick); resolve(); } }, 20);
      });
      if (text.includes("TOOL") && context.messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage([fauxThinking("Inspect the shared native tool presentation."), fauxToolCall("read", { path: join(root, "fixture.txt") })], { stopReason: "toolUse" });
      return fauxAssistantMessage(`VIEW_REPLY ${text} ${text.includes("SLOW") ? "streaming ".repeat(200) : "complete"}`);
    }));
    if (!existsSync(join(root, "model-unavailable"))) pi.registerProvider(provider.provider);
    pi.on("session_start", async (_event, context) => {
      ctx = context;
      const role = context.sessionManager.getSessionFile()?.includes("store-v2") || !context.sessionManager.getSessionFile() ? "child" : "main";
      const state = globalThis[Symbol.for("b3-view-fixture")] ??= { contexts: new Map() };
      state.contexts.set(role, context);
      // Observe only the public footer slot in the focused host regression.
      if (process.env.PI_SDK_VIEW_STATUSLINE === "1" && context.hasUI) {
        state.footerUis ??= new WeakSet();
        if (!state.footerUis.has(context.ui)) {
          const ui = context.ui, original = ui.setFooter.bind(ui);
          state.footerUis.add(ui);
          const record = { role, session: context.sessionManager.getSessionId(), sets: 0, clears: 0, mounts: 0 };
          (state.footerHosts ??= []).push(record);
          ui.setFooter = factory => {
            record.sets++;
            if (!factory) { record.clears++; record.component = undefined; }
            return original(factory && ((...args) => {
              record.mounts++;
              return record.component = factory(...args);
            }));
          };
        }
        if (role === "main") {
          for (const [key, line] of [["compaction", "CP:2"], ["memory", "MEM:3"]]) {
            pi.events.emit("statusline:row", { key, line, placement: "inline", row: 2 });
          }
        }
      }
      log({ event: "bound", role, mode: context.mode, session: context.sessionManager.getSessionId() });
      const held = state.holdBinding;
      if (role === "child" && context.mode === "tui" && held && ++held.seen === held.nth) {
        state.holdBinding = undefined;
        log({ event: "binding-held", token: held.token });
        await new Promise(resolve => {
          const timer = setInterval(() => { if (existsSync(join(root, `release-binding-${held.token}`))) { clearInterval(timer); resolve(); } }, 20);
        });
        log({ event: "binding-returned", token: held.token });
      }
      if (role === "child" && context.mode === "tui" && process.env.PI_SDK_VIEW_DRIFT === "1" && !drift) {
        drift = () => {};
        process.on("SIGTERM", drift);
        state.drift = drift;
      }

    });
    pi.on("session_shutdown", async (_event, context) => {
      if (drift) process.off("SIGTERM", drift);
      if (context.sessionManager.getSessionId() === "b3-main") return;
      log({ event: "child-cleanup-start" });
      if (process.env.PI_SDK_SLOW_SHUTDOWN === "1") await new Promise(resolve => setTimeout(resolve, 1500));
      log({ event: "child-cleanup-end" });
    });
  };
}

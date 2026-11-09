// Test-only public UI observations and semantic contributions; no real requests.
import { appendFileSync, writeFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";

const SESSION_START_MARKER = "\x1b]777;cc-main-session-start\x07";
const SESSION_END_MARKER = "\x1b]777;cc-main-session-end\x07";

export default function mainStatuslineFixture(pi) {
  let terminal;
  const log = (event) => appendFileSync(`${process.env.CC_MAIN_STATUSLINE_ROOT}/events.jsonl`,
    `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  const provider = fauxProvider({ provider: "fallback-fixture", api: "fallback-fixture-api",
    models: [{ id: "fallback-model", name: "fallback-model", reasoning: true, contextWindow: 65536, maxTokens: 4096 }] });
  pi.registerProvider(provider.provider);
  const contribute = (count) => {
    pi.events.emit("statusline:row", { key: "compact", placement: "inline", row: 2, order: 10, line: `CP:${count}` });
    pi.events.emit("statusline:row", { key: "memory", placement: "inline", row: 2, order: 20, line: "MEM:3" });
  };
  // Loaded before CC: its first setter must run in this same session_start emit.
  pi.on("session_start", (_event, ctx) => {
    log({ event: "session-start" });
    ctx.ui.setWidget("main-statusline-observer", (tui) => {
      terminal = tui.terminal;
      tui.terminal.write(SESSION_START_MARKER);
      return { render: () => [], invalidate() {} };
    });
    const original = ctx.ui.setFooter;
    ctx.ui.setFooter = (factory) => {
      log({ event: "set-footer", defined: Boolean(factory) });
      return original(factory && ((...args) => {
        const component = factory(...args);
        log({ event: "footer", lines: component.render(120) });
        return component;
      }));
    };
    contribute(0);
  });
  pi.on("session_shutdown", () => terminal?.write(SESSION_END_MARKER));
  pi.registerCommand("fixture-end", { description: "Mark intentional terminal teardown",
    handler: async () => { terminal?.write(SESSION_END_MARKER); log({ event: "end" }); } });
  pi.registerCommand("fixture-contribute", { description: "Update fixture CP contribution",
    handler: async () => { contribute(1); log({ event: "contributed" }); } });
  pi.registerCommand("fixture-refresh", { description: "Refresh fixture command",
    handler: async () => { pi.events.emit("statusline:refresh", {}); log({ event: "refreshed" }); } });
  for (const state of ["active", "complete", "clear"]) {
    pi.registerCommand(`fixture-todo-${state}`, { description: `Publish ${state} Todo snapshot`,
      handler: async (_args, ctx) => {
        pi.events.emit("todo:snapshot-v1", { version: 1, sessionId: ctx.sessionManager.getSessionId(),
          todos: state === "clear" ? [] : [
            { id: 1, subject: "First fallback task", status: "completed" },
            { id: 2, subject: "Second fallback task", status: state === "complete" ? "completed" : "pending" },
          ] });
        log({ event: "todo", state });
      } });
  }
  pi.registerCommand("fixture-diagnostics", { description: "Capture the full internals entry",
    handler: async (_args, ctx) => {
      const entry = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "internals").at(-1);
      if (typeof entry?.details !== "string") throw new Error("missing complete internals entry");
      writeFileSync(`${process.env.CC_MAIN_STATUSLINE_ROOT}/internals-full.txt`, entry.details);
    } });
  pi.on("before_agent_start", () => { throw new Error("This fixture must not make any provider request"); });
}

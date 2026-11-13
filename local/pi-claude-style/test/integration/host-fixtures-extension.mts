// Faux-provider fixture loaded into the real Pi 1.3 binary by host-fixtures.mjs.
// It never reaches a real model: every assistant turn comes from the scripts
// below, chosen by the marker in the latest user message.
import { appendFileSync, readFileSync } from "node:fs";
import { showTextPanel } from "pi-li-uikit/text-panel";
import { AgentSession, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

const root = process.env.CC_HOST_FIXTURE_ROOT;
const log = (data) => {
  if (root) appendFileSync(`${root}/events.jsonl`, `${JSON.stringify({ at: Date.now(), ...data })}\n`);
};

const SCRIPTS = {
  FIXTURE_GROUPED: [
    () => [
      fauxThinking("Planning the survey.\n\n```js\nconst thinkingFence = 1;\n```\n\nRead the three inputs first."),
      fauxToolCall("read", { path: "a.txt" }, { id: "grouped-read-a" }),
      fauxToolCall("read", { path: "b.txt" }, { id: "grouped-read-b" }),
      fauxToolCall("bash", { command: "printf 'grouped-bash-output\\n'" }, { id: "grouped-bash" }),
    ],
    () => [
      fauxThinking("One more file is needed before answering.\n\n```sh\ncat c.txt\n```"),
      fauxToolCall("read", { path: "c.txt" }, { id: "grouped-read-c" }),
    ],
    () => [
      fauxText("Survey complete.\n\n```ts\nconst bodyFence = 42;\n```\n\n- alpha\n- beta"),
    ],
  ],
  FIXTURE_NESTED: [
    () => [fauxToolCall("fixture_codemode", { paths: ["a.txt", "b.txt"] }, { id: "nested-parent" })],
    () => [fauxText("Nested calls finished.")],
  ],
  FIXTURE_USER: [() => [fauxText("Acknowledged the long request.")]],
  FIXTURE_IMAGE_ROWS: [
    () => [
      fauxToolCall("read", { path: "fixture.png" }, { id: "image-rows-1" }),
      fauxToolCall("read", { path: "fixture-2.png" }, { id: "image-rows-2" }),
      fauxToolCall("read", { path: "fixture-3.png" }, { id: "image-rows-3" }),
      fauxToolCall("bash", { command: "printf 'image rows done\\n'" }, { id: "image-rows-bash" }),
    ],
    () => [fauxText("Three pictures inspected.")],
  ],
  FIXTURE_IMAGE: [
    () => [fauxToolCall("read", { path: "fixture.png" }, { id: "image-read" })],
    () => [
      fauxText("Picture read; now a screenshot."),
      fauxToolCall("mcp__fixture__screenshot", {}, { id: "image-shot" }),
    ],
    () => [fauxText("Image inspected.")],
  ],
  FIXTURE_SCROLL: [
    () => [fauxText(Array.from({ length: 80 }, (_, index) => `scroll line ${String(index + 1).padStart(2, "0")} alpha beta gamma`).join("\n\n"))],
  ],
  FIXTURE_TODO: [
    () => [fauxToolCall("fixture_wait", { ticks: 24, intervalMs: 250, todos: true }, { id: "todo-wait" })],
    () => [fauxText("Todo run finished.")],
  ],
  FIXTURE_LIVE: [
    () => [
      fauxThinking("Waiting on the slow fixture tool while Ctrl+T toggles thinking."),
      fauxToolCall("fixture_wait", { ticks: 16, intervalMs: 250 }, { id: "live-wait" }),
    ],
    () => [fauxText("Live run finished.")],
  ],
};

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block?.type === "text" ? block.text : "")).join("");
}

let retryResponses = 0;
let compactionResponses = 0;
function respond(context) {
  if (process.env.CC_HOST_FIXTURE_COMPACTION) {
    const turn = ++compactionResponses;
    return fauxAssistantMessage([fauxText(turn < 3 ? `Compaction fixture turn ${turn}.` :
      ["# COMPACTION_START", ...Array.from({ length: 60 }, (_, index) => `- Retained fact ${index + 1}`), "COMPACTION_END"].join("\n"))]);
  }
  const messages = context.messages ?? [];
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") { lastUser = index; break; }
  }
  const prompt = lastUser >= 0 ? textOf(messages[lastUser].content) : "";
  if (prompt.includes("FIXTURE_RETRY")) {
    const attempt = ++retryResponses;
    log({ event: "retry-response", attempt });
    if (attempt <= 2) return fauxAssistantMessage([], { stopReason: "error",
      errorMessage: attempt === 1 ? "fetch failed: ECONNRESET" : "503 upstream_unavailable overloaded" });
    if (attempt === 3) return fauxAssistantMessage([fauxToolCall("fixture_wait", { ticks: 8, intervalMs: 250 }, { id: "retry-recovered" })], { stopReason: "toolUse" });
    return fauxAssistantMessage([fauxText("RETRY_RECOVERED")], { stopReason: "stop" });
  }
  const step = messages.slice(lastUser + 1).filter((message) => message?.role === "assistant").length;
  const marker = Object.keys(SCRIPTS).find((key) => prompt.includes(key));
  const script = marker ? SCRIPTS[marker] : undefined;
  const build = script?.[step];
  const content = build ? build() : [fauxText(`OK: ${marker ?? "plain"} step ${step}.`)];
  return fauxAssistantMessage(content, {
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
  });
}

/** Stable identities for the components of one class mounted in the transcript. */
const identities = new WeakMap();
let nextIdentity = 1;
function mounted(node, className, output = [], seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return output;
  seen.add(node);
  if (node.constructor?.name === className) {
    if (!identities.has(node)) identities.set(node, nextIdentity++);
    output.push(identities.get(node));
  }
  for (const child of Array.isArray(node.children) ? node.children : []) mounted(child, className, output, seen);
  return output;
}
const toolComponents = (root) => mounted(root, "ToolExecutionComponent");

export default function hostFixture(pi) {
  let tui;
  if (process.env.CC_HOST_FIXTURE_RETRY_MISMATCH) {
    // Keep native behaviour intact while deliberately changing the probed
    // arity before CC installs; this must leave BOTH retry seams uninstalled.
    const mismatch = process.env.CC_HOST_FIXTURE_RETRY_MISMATCH;
    const prototype = mismatch === "session" ? AgentSession.prototype : InteractiveMode.prototype;
    const key = { events: "handleEvent", indicator: "showStatusIndicator", session: "bindExtensions", view: "init" }[mismatch];
    const original = prototype[key];
    prototype[key] = mismatch === "view" ? function (_unexpected) { return original.call(this); }
      : function (...args) { return original.apply(this, args); };
  }
  if (process.env.CC_HOST_FIXTURE_COPY_SELECTION) {
    // macOS uses the native helper; Linux takes the real wl-copy path,
    // intercepted by the harness's PATH stub (never the user's clipboard).
    if (process.platform === "darwin") {
      const clipboard = getNativeClipboard();
      if (!clipboard?.setText) throw new Error("selection copy fixture needs the native clipboard helper");
      const original = clipboard.setText;
      const capture = async (text) => { log({ event: "selection-copy", text }); };
      clipboard.setText = capture;
      if (getNativeClipboard()?.setText !== capture) throw new Error("clipboard capture was not installed");
      pi.on("session_shutdown", () => { clipboard.setText = original; });
    }
    pi.registerShortcut("alt+y", { description: "Capture native selection copy in the fixture", handler: async () => {
      if (!await tui.copyActiveSelectionToClipboard()) throw new Error("no active selection to copy");
    } });
  }
  // CC reports a run's average t/s only once the generation clock covers real
  // time (500 ms). The clock starts at the first streamed delta, so a fast pace
  // (or one chunk for the whole answer) leaves almost no measured generation
  // and the done row loses its t/s column. One token per chunk plus the pace
  // the harness passes keeps several deltas and their gaps inside the window;
  // long-answer scenarios keep the fast default.
  const tokensPerSecond = Number(process.env.CC_HOST_FIXTURE_TPS ?? 4000);
  const faux = (provider, ids) => fauxProvider({
    provider,
    api: `${provider}-api`,
    models: ids.map((id) => ({ id, name: id, reasoning: true, contextWindow: 65536, maxTokens: 4096 })),
    tokensPerSecond,
    tokenSize: { min: 1, max: 1 },
  });
  const primary = faux("fixture", ["fixture-model", "fixture-model-large"]);
  primary.setResponses(Array.from({ length: 64 }, () => respond));
  pi.registerProvider(primary.provider);
  const secondary = faux("fixture-b", ["fixture-b-model"]);
  pi.registerProvider(secondary.provider);

  pi.registerTool({
    name: "fixture_codemode",
    label: "fixture_codemode",
    description: "Run nested fixture tools",
    parameters: Type.Object({ paths: Type.Array(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const outputs = [];
      for (const path of params.paths) {
        const outcome = await ctx.executeTool("read", { path });
        outputs.push(`${path}: ${outcome.isError ? "error" : "ok"}`);
      }
      const shell = await ctx.executeTool("bash", { command: "printf 'nested-bash-output\\n'" });
      outputs.push(`bash: ${shell.isError ? "error" : "ok"}`);
      return { content: [{ type: "text", text: outputs.join("\n") }], details: {} };
    },
  });

  // Stands in for an MCP screenshot: a non-read tool whose result carries images.
  pi.registerTool({
    name: "mcp__fixture__screenshot",
    label: "mcp__fixture__screenshot",
    description: "Return two screenshots",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const data = readFileSync(`${ctx.cwd}/fixture.png`).toString("base64");
      return {
        content: [
          { type: "text", text: "two screenshots" },
          { type: "image", data, mimeType: "image/png" },
          { type: "image", data, mimeType: "image/png" },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "fixture_wait",
    label: "fixture_wait",
    description: "Emit progress updates for a while",
    parameters: Type.Object({ ticks: Type.Number(), intervalMs: Type.Number(), todos: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (params.todos) {
        if (process.env.CC_HOST_FIXTURE_CHILD_SPACING) {
          // Child presentation intentionally does not subscribe to Main Todo.
          // A real above-editor widget exercises the same native spacing seam.
          ctx.ui.setWidget("fixture-folded-todo", ["  └ ■ 1/3 · Write the fixture"], { placement: "aboveEditor" });
        } else pi.events.emit("todo:snapshot-v1", { version: 1, sessionId: ctx.sessionManager.getSessionId(), todos: [
          { id: 1, subject: "Read the inputs", status: "completed" },
          { id: 2, subject: "Write the fixture", status: "in_progress", activeForm: "Writing the fixture" },
          { id: 3, subject: "Check the layout", status: "pending" },
        ] });
      }
      for (let tick = 1; tick <= params.ticks; tick++) {
        if (signal?.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, params.intervalMs));
        onUpdate?.({ content: [{ type: "text", text: `tick ${tick}/${params.ticks}` }], details: {} });
        log({
          event: "wait-tick", tick,
          tools: tui ? toolComponents(tui) : [],
          assistants: tui ? mounted(tui, "AssistantMessageComponent") : [],
        });
      }
      return { content: [{ type: "text", text: `waited ${params.ticks} ticks` }], details: {} };
    },
  });

  // A custom message CC knows, one it does not, and a native notice.
  pi.registerCommand("fixture-messages", {
    description: "Send known and unknown displayed custom messages",
    handler: async (_args, ctx) => {
      pi.sendMessage({
        customType: "fork-update",
        content: "pi packages updated: FIXTURE_KNOWN",
        display: true,
        details: { markdown: "## Merged\n\n- FIXTURE_KNOWN_DETAILS" },
      });
      pi.sendMessage({
        customType: "fixture-unknown",
        content: "FIXTURE_UNKNOWN first line\nsecond line stays",
        display: true,
      });
      ctx.ui.notify("FIXTURE_NOTICE native warning", "warning");
    },
  });

  pi.registerCommand("fixture-oauth", {
    description: "Display the MCP OAuth status producer shape without authenticating",
    handler: () => pi.sendMessage({ customType: "mcp-oauth-status",
      content: [{ type: "text", text: "FIXTURE_OAUTH authenticated" }],
      display: "FIXTURE_OAUTH authenticated",
      details: { server: "fixture-oauth-server", status: "authenticated", nextAction: { connect: "fixture-oauth-server" } },
    }),
  });

  pi.registerShortcut("alt+g", { description: "Open geometry panel without changing the editor draft", handler: (ctx) => {
    void showTextPanel(ctx, { title: "GEOMETRY_PANEL", format: "plain",
      body: Array.from({ length: 80 }, (_, i) => `panel body ${String(i + 1).padStart(2, "0")} alpha beta gamma`).join("\n") })
      .then(() => log({ event: "geometry-closed", draft: ctx.ui.getEditorText() }));
  } });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      if (process.env.CC_HOST_FIXTURE_SQUEEZE) {
        ctx.ui.setWidget("fixture-dock-above", Array.from({ length: 12 }, (_, i) => `DOCK_ABOVE_${i}`), { placement: "aboveEditor" });
        ctx.ui.setWidget("fixture-dock-below", Array.from({ length: 14 }, (_, i) => `DOCK_BELOW_${i}`), { placement: "belowEditor" });
      }
      ctx.ui.setWidget("host-fixture-probe", (captured) => {
        tui = captured;
        return { render: () => [], invalidate() {} };
      });
    }
    log({ event: "ready", sessionFile: ctx.sessionManager.getSessionFile?.() });
  });
  pi.on("agent_settled", () => log({ event: "settled", tools: tui ? toolComponents(tui) : [] }));
  pi.on("tool_execution_start", (event) => log({
    event: "tool-start", id: event.toolCallId, name: event.toolName, parent: event.parentToolCallId,
  }));
}

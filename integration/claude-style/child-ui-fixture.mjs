import { currentBuild } from "../../scripts/retained-build.mjs";
// Public SDK two-session harness. Only this fixture owns terminal handoff.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../local/pi-claude-style");
import { AssistantMessageComponent, CustomMessageComponent, UserMessageComponent, ToolExecutionComponent, InteractiveMode, createAgentSessionServices, createAgentSessionFromServices,
  createAgentSessionRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, setKeybindings } from "@earendil-works/pi-tui";
import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import claudeMain from "../../local/pi-claude-style/dist/index.ts";
const { createClaudeStyleChildExtension } = await import(pathToFileURL(join(currentBuild(new URL("../../local/pi-claude-style/", import.meta.url)), "child.ts")).href);
const { auditInternals: auditCc } = await import(pathToFileURL(join(currentBuild(new URL("../../local/pi-claude-style/", import.meta.url)), "src/internals.ts")).href);
// This reader resolves the production bundles' global Symbol.for registry;
// it does not need their module instance (Main and child are separate bundles).
import { resolvePublishedEditorSlotGeometry } from "../../local/pi-claude-style/src/host/fullscreen/editor-slot.ts";
import { createCustomEntryDelegate as createCustomEntryPresentationDelegate } from "../../local/pi-processes/src/integrations/custom-entry-delegate.ts";
import { installProfileRenderers } from "./profile-renderers.mjs";
import { installNativeComponentCases } from "./native-components.mjs";
import { installComponentContract, findRendered } from "./component-contract.mjs";
const root = process.env.CC_CHILD_UI_ROOT;
const nativeUser = process.env.CC_CHILD_UI_SCENARIO === "native-user";
const presentationKey = Symbol.for("pi.claude-style.custom-entry-presentations.v1");
const LEFT_CLICK = { type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 1, shift: false, alt: false, ctrl: false };
const providers = () => globalThis[presentationKey]?.providers;
const log = (data) => appendFileSync(join(root, "events.jsonl"), JSON.stringify({ at: Date.now(), ...data }) + "\n");
const views = new Map();
const hooks = { attach: new Set(), detach: new Set(),
  onAttach(callback) { this.attach.add(callback); return () => this.attach.delete(callback); },
  onDetach(callback) { this.detach.add(callback); return () => this.detach.delete(callback); } };
let active = "main", switching = false, outputOwner = "main", mainPatches, mainBackground = false;
const processEvents = ["SIGTERM", "SIGHUP", "uncaughtException"];
function listeners() {
  return [...processEvents.map((event) => ({ emitter: process, event })),
    ...[process.stdin, process.stdout, process.stderr].map((emitter) => ({ emitter, event: "error" }))]
    .map((item) => ({ ...item, previous: item.emitter.listeners(item.event) }));
}
function removeViewListeners(before) {
  for (const { emitter, event, previous } of before) {
    const added = emitter.listeners(event).filter((listener) => !previous.includes(listener));
    if (added.length !== 1) throw new Error(`unexpected child handler count ${event}: ${added.length}`);
    for (const listener of added) emitter.removeListener(event, listener);
  }
}
function gate(terminal, role) {
  for (const key of ["setTitle", "setProgress", "clearProgress"]) {
    if (typeof terminal[key] !== "function") continue;
    const original = terminal[key].bind(terminal);
    terminal[key] = (...args) => { if (outputOwner === role) return original(...args); };
  }
}
function pngFixture() {
  const chunk = (kind, data) => {
    const payload = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0,255,0,0,255]))), chunk("IEND", Buffer.alloc(0))]);
}
function customComponents(root, output = []) {
  if (root instanceof CustomMessageComponent) output.push(root);
  for (const child of root.children ?? []) customComponents(child, output);
  return output;
}
async function attach(role) {
  const view = views.get(role);
  outputOwner = role;
  if (role === "main" && view.mode) {
    view.tui.start(); setKeybindings(view.keys); view.ctx.ui.setTheme("dark");
    view.tui.requestRender(true);
  } else {
    if (role === "child") for (const callback of hooks.attach) await callback();
    view.mode = new InteractiveMode(view.runtime, { tuiMode: "fullscreen", initialThemeSetting: "dark" });
    const before = listeners();
    await view.mode.init();
    if (role === "child") removeViewListeners(before);
    else void view.mode.run().catch((error) => log({ event: "run-error", error: String(error) }));
    await view.session.bindExtensions({ shutdownHandler: () => switchTo("main") });
    if (view.draft !== undefined) view.ctx.ui.setEditorText(view.draft);
    view.constructions++;
  }
  active = role;
  if (role === "main" && !mainPatches) mainPatches = [AssistantMessageComponent.prototype.updateContent, UserMessageComponent.prototype.render, InteractiveMode.prototype.showError];
  log({ event: "attached", role, draft: view.ctx.ui.getEditorText(), constructions: view.constructions });
  log({ event: "host-identities", role, owners: [...(globalThis[Symbol.for("pi.claude-style.presentation-owners.v1")]?.owners ?? [])].map((owner) => ({
    assistant: owner.locals.has(AssistantMessageComponent.prototype), user: owner.locals.has(UserMessageComponent.prototype),
    prototypes: [...owner.locals.keys()].map((prototype) => prototype.constructor?.name),
  })) });
}
async function switchTo(role) {
  if (switching || active === role) return;
  switching = true;
  try {
    const from = views.get(active);
    from.draft = from.ctx.ui.getEditorText();
    log({ event: "detaching", role: active, draft: from.draft });
    if (active === "main") from.tui.stop({ preserveScreen: true });
    else {
      const oldTui = from.tui;
      for (const callback of hooks.detach) await callback();
      log({ event: "view-detached", geometryReleased: resolvePublishedEditorSlotGeometry(oldTui) === undefined });
      from.mode.stop("none"); from.mode = undefined;
      from.runtime.setRebindSession(undefined);
      from.runtime.setBeforeSessionInvalidate(undefined);
      await from.session.bindExtensions({ mode: "rpc", uiContext: undefined, shutdownHandler: () => {} });
      from.tui = undefined;
    }
    await attach(role);
  } finally { switching = false; }
}
function controls(role) { return (pi) => {
  const view = views.get(role);
  installProfileRenderers(pi, view, log);
  installNativeComponentCases(pi, view, log);
  installComponentContract(pi, view, log);
  const frozenRecords = [];
  let frozenInvalidations = 0;
  const frozenComponent = (token) => {
    const render = () => [token];
    const invalidate = () => { frozenInvalidations++; };
    const component = Object.freeze({ render, invalidate });
    frozenRecords.push({ component, render, invalidate });
    return component;
  };
  pi.registerMessageRenderer("fixture-frozen", (message) => frozenComponent(message.content));
  pi.registerEntryRenderer("fixture-frozen-entry", (entry) => {
    view.frozenEntry = frozenComponent(entry.data.token); return view.frozenEntry;
  });
  pi.registerCommand("fixture-frozen", { description: "Render and invalidate a frozen third-party Component", handler: async () => {
    await view.session.waitForIdle();
    const before = new Set(customComponents(view.tui));
    const recordStart = frozenRecords.length;
    const invalidations = frozenInvalidations;
    const token = `IMMUTABLE_CUSTOM_${role.toUpperCase()}_${view.frozenSequence = (view.frozenSequence ?? 0) + 1}`;
    pi.sendMessage({ customType: "fixture-frozen", content: token, display: true });
    const component = customComponents(view.tui).find((candidate) => !before.has(candidate));
    if (!component) throw new Error("frozen custom message was not appended synchronously");
    const first = component.render(view.tui.terminal.columns);
    component.invalidate();
    const afterInvalidate = component.render(view.tui.terminal.columns);
    const entryToken = token + "_ENTRY";
    pi.appendEntry("fixture-frozen-entry", { token: entryToken });
    const entryHost = findRendered(view.tui, entryToken, view.tui.terminal.columns);
    if (!entryHost) throw new Error("native entry renderer was not added to the public tree");
    const entryRows = entryHost.render(view.tui.terminal.columns);
    const entryInvalidations = frozenInvalidations;
    entryHost.invalidate();
    const entryAfter = entryHost.render(view.tui.terminal.columns);
    const unowned = createCustomEntryPresentationDelegate("ctx-status", {
      version: 1, customType: "ctx-status", data: { level: "warning" },
      presentation: { title: "unowned", heading: "unowned", summary: "unowned", body: "unowned" },
      options: {}, theme: view.ctx.ui.theme,
    }, Object.freeze({ render: () => ["UNOWNED_NATIVE_FALLBACK"], invalidate() {} }));
    log({ event: "frozen-custom", role, token, first, afterInvalidate, entryToken, entryRows, entryAfter, entryInvalidated: frozenInvalidations > entryInvalidations,
      unownedRows: unowned.render(view.tui.terminal.columns), unownedClick: unowned.handleMouse(LEFT_CLICK)?.handled === true,
      invalidated: frozenInvalidations > invalidations,
      unchanged: frozenRecords.slice(recordStart).every(({ component, render, invalidate }) =>
        Object.isFrozen(component) && component.render === render && component.invalidate === invalidate),
    });
  } });
  let customStarts = 0;
  pi.on("message_start", (event) => { if (event.message.role === "custom") customStarts++; });
  pi.registerMessageRenderer("fixture-lazy", (message, options, theme) => {
    // Real consumer: its internal CC component lives in an opaque closure and
    // is first created by render/invalidate/click, not by this renderer call.
    const delegate = createCustomEntryPresentationDelegate("ctx-status", {
      version: 1, customType: "ctx-status", data: { level: "warning" },
      presentation: { title: `${role} lazy`, heading: "fixture details",
        summary: `LAZY_SUMMARY_${message.details.token}`, body: `LAZY_BODY_${message.details.token}` },
      options, theme,
    }, { render: () => ["LAZY_FALLBACK"], invalidate() {} });
    view.lazy = delegate;
    return delegate;
  });
  pi.registerCommand("fixture-lazy", { description: "Render a generic lazy delegate with legacy ctx-status presentation", handler: () => {
    view.providerType = "ctx-status";
    const token = `${role.toUpperCase()}_${view.lazySequence = (view.lazySequence ?? 0) + 1}`;
    pi.sendMessage({ customType: "fixture-lazy", content: role, display: true, details: { token } });
    log({ event: "lazy-request", role, token });
  } });
  pi.registerShortcut("alt+l", { description: "Click the real lazy delegate", handler: () => {
    log({ event: "lazy-click", role, clicked: view.lazy.handleMouse(LEFT_CLICK)?.handled === true });
  } });
  pi.registerShortcut("alt+r", { description: "Replace and restore a live presentation provider", handler: () => {
    if (view.originalProvider) {
      providers().set(view.providerType ?? "ctx-status", view.originalProvider); view.originalProvider = undefined;
    } else {
      const type = view.providerType ?? "ctx-status";
      const provider = providers().get(type); view.originalProvider = provider;
      providers().set(type, { ...provider, render: (request) => provider.render(request) });
    }
    log({ event: "provider-replaced", role });
  } });
  pi.registerCommand("fixture-process-tool", { description: "Use the real Process renderers through the public SDK component", handler: () => {
    const runner = view.session.extensionRunner;
    const original = runner.getToolDefinition("process");
    const definition = runner.resolveToolRenderers("process", () => original);
    view.ctx.ui.setWidget("fixture-process-tool", (tui) => {
      const tool = new ToolExecutionComponent("process", `${role}-render-only`, { action: "list" }, { outputPad: 0 }, definition, tui, view.cwd);
      tool.markExecutionStarted(); tool.setArgsComplete();
      tool.updateResult({ content: [{ type: "text", text: "render fixture" }], isError: false });
      const native = new ToolExecutionComponent("process", `${role}-native-render`, { action: "list" }, { outputPad: 0 }, original, tui, view.cwd);
      native.updateResult({ content: [{ type: "text", text: "render fixture" }], isError: false });
      const rows = tool.render(tui.terminal.columns);
      const nativeRows = native.render(tui.terminal.columns);
      tool.invalidate(); native.invalidate();
      log({ event: "process-tool-render", role, rows, nativeRows });
      const host = new Container(); host.addChild(native); host.addChild(tool); return host;
    });
  } });
  pi.registerCommand("fixture-transform", { description: "Native user Markdown with the production clipboard transformer", handler: () => {
    const transforms = view.session.extensionRunner.getMarkdownTransformers();
    view.ctx.ui.setWidget("fixture-transform", (tui) => {
      const component = new UserMessageComponent(`TRANSFORM_${role.toUpperCase()} ${join(view.cwd, "pi-clipboard-a0.png")}`, undefined, 0, transforms);
      log({ event: "transform-render", role, rows: component.render(tui.terminal.columns) });
      return component;
    });
  } });
  pi.registerCommand("fixture-clear-transform", { description: "Release the native user transformer widget", handler: () => view.ctx.ui.setWidget("fixture-transform", undefined) });
  pi.registerCommand("fixture-clear-tool", { description: "Release the render-only process widget", handler: () => view.ctx.ui.setWidget("fixture-process-tool", undefined) });
  pi.registerShortcut("alt+d", { description: "Open the real CC command-output details", handler: () => {
    const click = { type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: view.tui.terminal.columns, height: 1, shift: false, alt: false, ctrl: false };
    log({ event: "command-details-click", role, clicked: view.commandDetails?.handleMouse(click)?.handled === true });
  } });
  pi.registerCommand("fixture-notices", { description: "Exercise native info/warning/error notifications", handler: () => {
    for (const level of ["info", "warning", "error"]) view.ctx.ui.notify(`NOTICE_${level.toUpperCase()}_${role.toUpperCase()}`, level);
    log({ event: "notices", role });
  } });
  pi.registerShortcut("alt+s", { description: "Native session report", handler: () => {
    log({ event: "session-report-request", role, sessionId: view.ctx.sessionManager.getSessionId() });
    return view.nativeSubmit("/session");
  } });
  pi.registerShortcut("alt+m", { description: "Native Main model selector", handler: () => view.nativeSubmit("/model") });
  if (role === "main") pi.registerShortcut("alt+z", { description: "Reload Main and restore native entry history", handler: async () => {
    view.reloading = true;
    await view.nativeSubmit("/reload");
  } });
  pi.registerCommand("fixture-cold", { description: "Idle sendMessage with immediate first render", handler: async () => {
    await view.session.waitForIdle();
    const before = new Set(customComponents(view.tui));
    const starts = customStarts;
    // A type CC knows (pi-fork-update's report), so its compact renderer draws it.
    pi.sendMessage({ customType: "fork-update", content: `COLD_BODY_${role.toUpperCase()}`, display: true, details: { markdown: `COMMAND_DETAILS_${role.toUpperCase()}` } });
    const component = customComponents(view.tui).find((candidate) => !before.has(candidate));
    if (!component) throw new Error("idle custom message was not appended synchronously");
    // Before any resize/theme invalidation can disguise a native first frame.
    const first = component.render(view.tui.terminal.columns);
    view.commandDetails = component.children.find((child) => typeof child.handleMouse === "function");
    log({ event: "cold-first-render", role, nativeUser, first, extensionMessageStarts: customStarts - starts });
  } });
  pi.registerShortcut("alt+/", { description: "Switch test view", handler: () => switchTo(role === "main" ? "child" : "main") });
  pi.registerShortcut("alt+i", { description: "Inspect real CC editor and fullscreen frame", handler: () => {
    const lines = view.editor.render(view.tui.terminal.columns);
    log({ event: "inspection", role, text: view.ctx.ui.getEditorText(),
      floating: !!resolvePublishedEditorSlotGeometry(view.tui) && !lines.some((line) => line.includes("fixture-panel")),
      patchesPreserved: !mainPatches || mainPatches.every((method, index) => method === [AssistantMessageComponent.prototype.updateContent, UserMessageComponent.prototype.render, InteractiveMode.prototype.showError][index]),
      lines,
    });
  } });
  pi.on("message_update", (event) => { if (role === "main" && mainBackground && JSON.stringify(event.message).includes("MAIN thinking")) log({ event: "main-background-stream" }); });
  pi.registerCommand("fixture-panel", { description: "Exercise fullscreen outside click", handler: (_args, ctx) => {
    void ctx.ui.custom((_tui, _theme, _keys, done) => ({ wantsMouse: true,
      render: () => ["FIXTURE_PANEL"], invalidate() {}, handleInput() {},
      handleMouse(event) { if (event.type === "press" && event.button === "left") {
        log({ event: "panel-closed", role }); done(); return { handled: true };
      } },
    }), { overlay: true, overlayOptions: { width: 30, anchor: "center" } });
    log({ event: "panel-opened", role });
  } });
  pi.registerCommand("fixture-package-notice", { description: "Verify Main package updates survive child views", handler: () => {
    views.get("main").mode.showPackageUpdateNotification(["fixture-package-update"]);
  } });
  pi.registerCommand("fixture-background", { description: "Stream Main while child owns the terminal", handler: () => {
    mainBackground = true;
    void views.get("main").session.prompt("BACKGROUND_MAIN").then(() => log({ event: "background-complete" }));
  } });
  pi.registerCommand("fixture-release-main", { description: "Release Main while a child view remains live", handler: async () => {
    if (active !== "child") await switchTo("child");
    await views.get("main").runtime.dispose();
    views.get("main").released = true;
    log({ event: "main-released", childProviderAlive: providers().has("ctx-status") });
  } });
  pi.registerCommand("fixture-finish", { description: "Finish bounded integration test", handler: async () => {
    if (active === "child" && !views.get("main").released) await switchTo("main");
    for (const [name, audit] of [["cc", auditCc]]) {
      const rows = audit();
      writeFileSync(join(root, `${name}-internals.json`), JSON.stringify(rows, null, 2));
      const unhealthy = rows.filter((row) => row.state === "missing" || row.state === "broken");
      log({ event: "internals", name, unhealthy: unhealthy.map((row) => ({ id: row.id, state: row.state, detail: row.detail })) });
      if (unhealthy.length) throw new Error(`${name} live internals failed`);
    }
    if (active === "child") for (const callback of hooks.detach) await callback();
    for (const name of ["child", "main"]) {
      const current = views.get(name); current.mode?.stop("none");
      if (!current.released) await current.runtime.dispose();
    }
    log({ event: "finished", providersReleased: providers().size === 0, remainingProviders: [...providers().keys()] }); process.exit(0);
  } });
  pi.on("session_start", (_event, ctx) => {
    view.ctx = ctx;
    if (role === "main" && view.reloading) {
      view.reloading = false;
      mainPatches = [AssistantMessageComponent.prototype.updateContent, UserMessageComponent.prototype.render, InteractiveMode.prototype.showError];
      log({ event: "main-reloaded" });
    }
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("fixture-tui", (tui) => {
      view.tui = tui; gate(tui.terminal, role);
      return { render: () => [], invalidate() {} };
    });
    const factory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keys) => {
      view.keys = keys;
      view.editor = factory(tui, theme, keys);
      if (role === "main") queueMicrotask(() => { view.nativeSubmit = view.editor.onSubmit; });
      if (role === "child") Object.defineProperty(view.editor, "onSubmit", {
        configurable: true,
        get: () => async (text) => {
          if (text === "/session") return view.nativeSubmit(text);
          view.editor.addToHistory?.(text); ctx.ui.setEditorText("");
          await view.session.prompt(text);
        },
        set(callback) { view.nativeSubmit = callback; },
      });
      return view.editor;
    });
  });
}; }
export default async function runFixture() {
try {
  for (const role of ["main", "child"]) {
    const cwd = join(root, role); mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "fixture.txt"), `${role} fixture\n`);
    writeFileSync(join(cwd, "fixture.png"), pngFixture());
    writeFileSync(join(cwd, "pi-clipboard-a0.png"), pngFixture());
    const view = { constructions: 0, role, cwd }; views.set(role, view);
    const settingsManager = SettingsManager.inMemory({ quietStartup: true, theme: "dark", showTerminalProgress: false,
      compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [],
      hideThinkingBlock: false, doubleEscapeAction: "none", fullscreenExitOutput: "none",
      // As in the daily profile: Pi leaves tool images out and CC draws one row.
      terminal: { showImages: false } });
    const factories = role === "child" ? [
      createClaudeStyleChildExtension({ target: "subagent", taskName: "fixture-child", returnLabel: "Alt+/ Main", readOnlyStatusline: true, viewLifecycle: hooks }),
    ] : [claudeMain];
    view.runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
      const faux = fauxProvider({ provider: "fixture-faux", api: "fixture-faux", models: [{ id: role, name: role, contextWindow: 32768, maxTokens: 2048, reasoning: true }], tokensPerSecond: 120 });
      faux.setResponses(Array.from({ length: 80 }, () => (ctx) => {
        const prompt = JSON.stringify([...ctx.messages].reverse().find((message) => message.role === "user")?.content);
        if (ctx.messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage([
          fauxThinking(`${role.toUpperCase()} thinking\n\n\x60\x60\x60ts\nconst thinkingFence = 1;\n\x60\x60\x60\n` + "independent stream ".repeat(30)),
          fauxToolCall("read", { path: prompt.includes("IMAGE_") ? "fixture.png" : "fixture.txt" }, { id: `${role}-${Date.now()}` }),
        ], { stopReason: "toolUse" });
        return fauxAssistantMessage(`${role.toUpperCase()} CC_RESPONSE ${prompt} complete.`);
      }));
      const services = await createAgentSessionServices({ cwd, agentDir: join(root, "agent"), settingsManager,
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
          disabledBuiltinExtensions: ["mcp"], systemPrompt: "Deterministic integration fixture.",
          extensionFactories: [(pi) => pi.registerProvider(faux.provider), ...factories, controls(role)] } });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        model: services.modelRuntime.getModel("fixture-faux", role), tools: ["read"], thinkingLevel: "off" });
      const errors = services.resourceLoader.getExtensions().errors;
      if (errors.length) throw new Error(JSON.stringify(errors));
      result.session.subscribe((event) => {
        if (event.type === "agent_end") log({ event: "agent-end", role });
        if (event.type === "tool_execution_end") log({ event: "tool-result", role, types: event.result.content.map((item) => item.type), text: event.result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").slice(0, 256) });
      });
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd, agentDir: join(root, "agent"), sessionManager: SessionManager.inMemory(cwd) });
    view.session = view.runtime.session;
  }
  await attach("main"); log({ event: "ready" });
  // Keep the launcher in extension loading; only our two modes own stdin.
  await new Promise(() => {});
} catch (error) { log({ event: "fatal", error: String(error), stack: error.stack }); process.exit(1); }

}

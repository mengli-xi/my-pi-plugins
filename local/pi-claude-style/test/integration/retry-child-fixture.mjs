import { pathToFileURL } from "node:url";
import { currentBuild } from "../../../../scripts/retained-build.mjs";
// Stock-host SDK lifecycle regression. Memory terminals isolate Main and child;
// only faux responses run, and no shared production terminal owner is simulated.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import xterm from "@xterm/headless";
import claudeMain from "../../dist/index.ts";
const { createClaudeStyleChildExtension } = await import(pathToFileURL(join(currentBuild(new URL("../../", import.meta.url)), "child.ts")).href);

const root = process.env.CC_RETRY_CHILD_ROOT, target = process.env.CC_RETRY_CHILD_TARGET;
const firstEntry = process.env.CC_RETRY_CHILD_ENTRY === "first";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false;
  xterm = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  start(input) { this.input = input; } stop() { this.input = undefined; } drainInput() { return Promise.resolve(); }
  write(data) { this.xterm.write(data); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  screen() { const b = this.xterm.buffer.active; return Array.from({ length: 40 }, (_, r) => b.getLine(b.viewportY + r)?.translateToString(true) ?? "").join("\n"); }
  send(data) { this.input?.(data); }
}
const hooks = {
  attaches: new Set(), detaches: new Set(),
  onAttach(fn) { this.attaches.add(fn); return () => this.attaches.delete(fn); },
  onDetach(fn) { this.detaches.add(fn); return () => this.detaches.delete(fn); },
};
const observations = [], views = [];
function capture(view, label) {
  const screen = view.terminal.screen();
  writeFileSync(join(root, `${label}.txt`), screen);
  const seconds = Number(screen.match(/重试 1\/10 · (\d+)s 后/u)?.[1]);
  observations.push({ label, seconds, isRetrying: view.runtime.session.isRetrying, hasNative: screen.includes("Retrying (") });
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  return { screen, seconds };
}
async function wait(label, predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
    await pause(20);
  }
}
async function make(role) {
  const cwd = join(root, role); mkdirSync(cwd, { recursive: true });
  const view = { role }; views.push(view);
  view.runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const faux = fauxProvider({ provider: `retry-${role}`, api: `retry-${role}`, models: [{ id: "faux", name: "faux", contextWindow: 32768, maxTokens: 128, reasoning: false }], tokensPerSecond: 100000 });
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: role === "main" ? "429 rate_limit" : "503 overloaded" }), fauxAssistantMessage(`${role} success`)]);
    const settingsManager = SettingsManager.inMemory({ quietStartup: true, theme: "dark", showTerminalProgress: false,
      retry: { enabled: true, maxRetries: 10, baseDelayMs: 15000 }, compaction: { enabled: false }, packages: [], extensions: [], doubleEscapeAction: "none", fullscreenExitOutput: "none" });
    const factories = role === "main" ? [claudeMain] : [createClaudeStyleChildExtension({ target, taskName: "retry child", returnLabel: "Main", readOnlyStatusline: true, viewLifecycle: hooks })];
    const services = await createAgentSessionServices({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"], systemPrompt: "Offline retry fixture.",
        extensionFactories: [pi => pi.registerProvider(faux.provider), ...factories] } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel(`retry-${role}`, "faux"), tools: [] });
    result.session.subscribe(event => { if (event.type === "auto_retry_start") view.retry = event; });
    await result.session.bindExtensions({ mode: "print" });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: SessionManager.inMemory(cwd) });
  return view;
}
async function attach(view) {
  if (view.role === "child") for (const fn of hooks.attaches) fn();
  view.terminal = new Terminal();
  view.mode = new InteractiveMode(view.runtime, { terminal: view.terminal, tuiMode: "fullscreen", initialThemeSetting: "dark" });
  await view.mode.init();
  await view.runtime.session.bindExtensions({ shutdownHandler() {} });
  await pause(100);
}
async function detach(view) {
  for (const fn of hooks.detaches) await fn();
  view.mode.stop("none"); view.mode = undefined;
  view.runtime.setRebindSession(undefined); view.runtime.setBeforeSessionInvalidate(undefined);
  await view.runtime.session.bindExtensions({ mode: "print" });
  view.runtime.session.extensionRunner.setUIContext(undefined, "print");
}
export default async function () {
  let failure;
  try {
    const main = await make("main"), child = await make("child");
    await attach(main);
    main.run = main.runtime.session.prompt("main retry");
    await wait("Main retry", () => main.retry && main.terminal.screen().includes("限流 · 重试"));
    if (!firstEntry) await attach(child);
    child.run = child.runtime.session.prompt("child retry");
    await wait("child retry event", () => child.retry);
    let before;
    if (!firstEntry) {
      await wait("initial child retry row", () => child.terminal.screen().includes("上游不可用 · 重试"));
      before = capture(child, "child-wait").seconds;
      await detach(child);
      assert.match(capture(main, "main-after-child-detach").screen, /限流 · 重试 1\/10/u);
    }
    await pause(1250);
    await attach(child);
    await wait("restored child retry row", () => child.terminal.screen().includes("上游不可用 · 重试"));
    const restored = capture(child, firstEntry ? "child-first-entry-during-wait" : "child-reattach-during-wait");
    assert.equal(child.runtime.session.isRetrying, true);
    assert.ok(restored.seconds < (before ?? 15), "countdown keeps original start instead of resetting");
    assert.ok(!restored.screen.includes("Retrying (") && !restored.screen.includes("限流 · 重试"));
    assert.match(capture(main, "main-during-child").screen, /限流 · 重试 1\/10/u);
    child.terminal.send("\x1b");
    await child.run;
    await pause(100);
    assert.equal(child.runtime.session.isRetrying, false);
    assert.ok(!capture(child, "child-after-cancel").screen.includes("重试 1/10"));
    main.runtime.session.abortRetry(); await main.run;
    await pause(100);
    assert.ok(!capture(main, "main-after-cancel").screen.includes("重试 1/10"));
    // Entering once more after cancellation cannot resurrect the snapshot.
    await detach(child); await attach(child);
    assert.ok(!capture(child, "child-entry-after-cancel").screen.includes("重试 1/10"));
  } catch (error) { failure = error; }
  finally {
    for (const view of views) view.runtime?.session.abortRetry();
    await Promise.allSettled(views.map(view => view.run));
    if (views.find(view => view.role === "child")?.mode) for (const fn of hooks.detaches) await fn();
    for (const view of views.reverse()) { view.mode?.stop("none"); await view.runtime?.dispose(); }
  }
  writeFileSync(join(root, "result.json"), JSON.stringify({ passed: !failure, error: failure?.stack }, null, 2));
  process.exit(failure ? 1 : 0);
}

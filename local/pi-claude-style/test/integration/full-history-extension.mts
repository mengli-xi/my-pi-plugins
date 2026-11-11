// Synthetic-session host fixture: private reads here are test instrumentation.
import { appendFileSync } from "node:fs";
import { InteractiveMode, CompactionSummaryMessageComponent } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { auditInternals } from "../../dist/src/internals.ts";
// The predicate reads a Symbol.for marker, not the bundle's class/WeakMap identity.
import { isHistoryAnchor } from "../../src/history-batches.ts";

export default function fixture(pi) {
  const faux = fauxProvider({ provider: "history-test", api: "history-test-api", models: [{ id: "offline", name: "offline", contextWindow: 32000, maxTokens: 4096 }] });
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("SYNTHETIC_COMPACTION_SUMMARY")], { stopReason: "stop" })));
  pi.registerProvider(faux.provider);
  const key = Symbol.for("cc-history-test.mode");
  let mode = globalThis[key], tui, ctx;
  let live = true;
  const log = data => appendFileSync(process.env.CC_FULL_HISTORY_RESULT, `${JSON.stringify(data)}\n`);
  log({ label: "factory" });
  pi.on("session_shutdown", event => { live = false; log({ label: "shutdown", reason: event.reason }); });
  const prototype = InteractiveMode.prototype;
  const append = prototype.addMessageToChat;
  prototype.addMessageToChat = function (...args) { globalThis[key] = mode = this; return append.apply(this, args); };
  // CC's compact row is `---- [compaction] compacted from <tokensBefore> tokens ------`.
  // The synthetic session's first compaction keeps its own token count, which
  // the session generator passes in rather than this fixture recomputing it.
  const firstSummaryTokens = Number(process.env.CC_FULL_HISTORY_FIRST_TOKENS);
  const firstSummary = () => mode.chatContainer.children.find(component =>
    component instanceof CompactionSummaryMessageComponent
    && stripTerminalSequences(component.render(120).join("\n")).includes(`compacted from ${firstSummaryTokens} tokens`));
  function snapshot(label, extra = {}) {
    if (!live) return;
    const summary = firstSummary();
    const rows = stripTerminalSequences(mode.chatContainer.render(mode.renderer.terminal.columns).join("\n"));
    const ids = [...rows.matchAll(/HISTORY_USER_(\d+)/gu)].map(match => Number(match[1]));
    const header = rows.match(/加载更早的 (\d+) 条记录/u);
    const compact = [...rows.matchAll(/\[compaction\]/gu)];
    const boundary = rows.indexOf("已压缩进摘要");
    log({ label, branch: ctx.sessionManager.getBranch().length, hidden: Number(header?.[1] ?? 0),
      users: ids.length, unique: new Set(ids).size, first: ids[0], last: ids.at(-1),
      userIds: ids, inputHistory: [...mode.editor.history],
      anchors: mode.chatContainer.children.filter(isHistoryAnchor).length,
      firstSummaryResident: summary !== undefined,
      // CC replaces the summary body with its clickable compact row, so the
      // preserved expansion state is only observable on the component.
      firstSummaryExpanded: summary?.expanded === true, selection: mode.renderer.getActiveSelectionText(),
      chronological: ids.every((id, index) => index === 0 || id > ids[index - 1]), compactions: compact.length,
      boundary: boundary >= 0, boundaryBeforeKept: boundary >= 0 && boundary < rows.indexOf(process.env.CC_FULL_HISTORY_UNLOAD === "1" ? "HISTORY_USER_680" : "HISTORY_USER_340"),
      health: auditInternals().filter(row => row.id.startsWith("history.")).map(({ id, state, detail }) => ({ id, state, detail })), ...extra });
  }
  pi.on("session_start", (_event, context) => {
    log({ label: "start", reason: _event.reason });
    ctx = context;
    context.ui.setWidget("history-test", value => { tui = value; return { render: () => [], invalidate() {} }; });
    setTimeout(() => { log({ label: "ready-timer", live }); snapshot("ready"); }, 500);
  });
  pi.registerShortcut("alt+s", { description: "Inspect synthetic history", handler: () => snapshot("snapshot") });
  pi.registerShortcut("alt+t", { description: "Reach the top and load a batch", handler: () => {
    tui.scrollToTop(); setTimeout(() => snapshot("top"), 150);
  } });
  pi.registerShortcut("alt+p", { description: "Prepare a selected viewport above the tail", handler: () => {
    mode.renderer.currentLayout.primaryScrollView.scrollTo(40, { disableFollow: true });
    tui.requestRender();
    setTimeout(() => snapshot("prepared"), 100);
  } });
  pi.registerShortcut("alt+b", { description: "Return to the protected latest batch", handler: () => {
    tui.scrollToBottom(); setTimeout(() => snapshot("bottom"), 250);
  } });
  pi.registerShortcut("alt+e", { description: "Expand the first historical summary", handler: () => {
    const summary = firstSummary();
    if (!summary) throw new Error("the first compaction row is not resident; the fixture unloaded it");
    summary.setExpanded(true); tui.requestRender(); setTimeout(() => snapshot("expanded"), 100);
  } });
  pi.registerShortcut("alt+g", { description: "Visit the last unloaded gap", handler: () => {
    let row = 0, target;
    for (const component of mode.documentContainer.children) {
      if (component === mode.chatContainer) break;
      row += component.render(mode.renderer.terminal.columns).length;
    }
    for (const component of mode.chatContainer.children) {
      const height = component.render(mode.renderer.terminal.columns).length;
      if (isHistoryAnchor(component)) target = row + Math.min(5, height - 1);
      row += height;
    }
    if (target === undefined) throw new Error("no unloaded history gap");
    mode.renderer.currentLayout.primaryScrollView.scrollTo(target, { disableFollow: true });
    tui.requestRender(); setTimeout(() => snapshot("gap"), 250);
  } });
  pi.registerShortcut("alt+l", { description: "Load older records preserving the native selection", handler: () => {
    const renderer = mode.renderer, scroll = renderer.currentLayout.primaryScrollView;
    const before = renderer.getActiveSelectionText();
    const header = mode.chatContainer.children.find(component => component.render(120).join("\n").startsWith("↑ 加载更早的"));
    const old = [...mode.chatContainer.children].filter(component => component !== header);
    const box = findBox(renderer.currentLayout.root, scroll);
    const top = scroll.scrollTop;
    const lines = box.scrollContentLines.slice(top, top + 20).join("\n");
    header.handleMouse({ type: "click", button: "left", x: 2, y: 0 });
    setTimeout(() => {
      const afterBox = findBox(renderer.currentLayout.root, scroll);
      snapshot("prepend", { hadSelection: !!before, sameSelection: before === renderer.getActiveSelectionText(),
        sameViewport: lines === afterBox.scrollContentLines.slice(scroll.scrollTop, scroll.scrollTop + 20).join("\n"),
        identitiesKept: old.every(component => mode.chatContainer.children.includes(component)), shifted: scroll.scrollTop > top });
    }, 160);
  } });
  pi.registerShortcut("alt+f", { description: "Inject one live layout mismatch after successful history installation", handler: () => {
    const renderer = mode.renderer;
    let latest = renderer.currentLayout;
    const descriptor = Object.getOwnPropertyDescriptor(renderer, "currentLayout");
    const header = mode.chatContainer.children.find(component => component.render(120).join("\n").startsWith("↑ 加载更早的"));
    Object.defineProperty(renderer, "currentLayout", { configurable: true,
      get: () => ({ ...latest, root: { children: [] } }), set: value => { latest = value; } });
    header.handleMouse({ type: "click", button: "left", x: 0, y: 0 });
    setTimeout(() => { Object.defineProperty(renderer, "currentLayout", { ...descriptor, value: latest }); tui.requestRender(); }, 50);
    setTimeout(() => snapshot("runtime-fallback"), 160);
  } });
  pi.registerCommand("fixture-redraw", { description: "Exercise native settings rebuild", handler: () => { mode.rebuildChatFromMessages(); setTimeout(() => snapshot("redraw"), 100); } });
  pi.registerCommand("fixture-boundary", { description: "Exercise persisted boundary compaction", handler: async () => {
    const manager = mode.sessionManager;
    manager.appendCompaction("BOUNDARY_SUMMARY", manager.getBranch().find(entry => entry.type === "message").id, 10000);
    const entry = manager.getBranch().at(-1);
    await mode.handleEvent({ type: "entry_appended", entry });
    snapshot("boundary-event");
  } });
  pi.registerCommand("fixture-tree", { description: "Navigate the synthetic branch", handler: async (_args, command) => {
    await command.navigateTree("entry-501", { summarize: false });
    setTimeout(() => snapshot("tree"), 100);
  } });
  pi.registerCommand("fixture-fork", { description: "Fork the synthetic branch", handler: async (_args, command) => {
    await command.fork("entry-401", { position: "at" });
  } });
  pi.registerCommand("fixture-new", { description: "Create an empty fixture session", handler: async (_args, command) => {
    await command.newSession();
  } });
  pi.registerCommand("fixture-resume", { description: "Restore the original fixture session", handler: async (_args, command) => {
    await command.switchSession(process.env.CC_FULL_HISTORY_SESSION);
  } });
}
function findBox(box, scroll) {
  if (box.scrollView === scroll) return box;
  for (const child of box.children) { const found = findBox(child, scroll); if (found) return found; }
}

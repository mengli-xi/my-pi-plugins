import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { initTheme, AssistantMessageComponent, ToolExecutionComponent, ExtensionRunner, SessionManager, type EntryRenderer, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { disposePresentationOwner, installPresentationOwner, presentationPrototype, presentationRunnerBelongsTo } from "../src/presentation-owner.ts";

initTheme("dark");

function fixture(manager = SessionManager.inMemory()) {
  const entryRenderers = new Map<string, EntryRenderer>();
  const starts: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const pi = { on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
    if (event === "session_start") starts.push(handler);
  }, registerEntryRenderer(name: string, renderer: EntryRenderer) { entryRenderers.set(name, renderer); } } as unknown as ExtensionAPI;
  installPresentationOwner(pi);
  // Exercise Pi's actual lookup and context before session_start, without any
  // Markdown registration, TUI, provider or persisted ownership entry.
  const runner = new ExtensionRunner(
    [{ entryRenderers } as ConstructorParameters<typeof ExtensionRunner>[0][number]],
    {} as ConstructorParameters<typeof ExtensionRunner>[1], process.cwd(), manager,
    {} as ConstructorParameters<typeof ExtensionRunner>[4],
  );
  return { pi, runner, manager, entryRenderers, close: () => disposePresentationOwner(pi),
    bind(tree: object) {
      const ctx = { sessionManager: manager, mode: "tui", hasUI: true,
        ui: { setWidget(_key: string, create: (tui: object) => unknown) { create(tree); } } };
      for (const start of starts) start({ type: "session_start" }, ctx);
    },
  };
}

test("pre-bind owners use public renderer keys, isolate Main/child and survive reload", () => {
  const main = fixture(), child = fixture();
  let replacement: ReturnType<typeof fixture> | undefined;
  try {
    assert.equal(presentationRunnerBelongsTo(main.pi, child.runner), false);
    assert.equal(presentationRunnerBelongsTo(main.pi, main.runner), true);
    assert.equal(presentationRunnerBelongsTo(child.pi, child.runner), true);
    assert.equal(presentationRunnerBelongsTo(child.pi, main.runner), false);
    assert.deepEqual(main.manager.getEntries(), [], "ownership never writes history");
    main.close();
    assert.equal(presentationRunnerBelongsTo(main.pi, main.runner), false);
    assert.equal(presentationRunnerBelongsTo(child.pi, child.runner), true);
    replacement = fixture(main.manager);
    assert.equal(presentationRunnerBelongsTo(replacement.pi, replacement.runner), true);
    assert.equal(presentationRunnerBelongsTo(replacement.pi, child.runner), false);
    main.close();
    assert.equal(presentationRunnerBelongsTo(replacement.pi, replacement.runner), true, "late teardown leaves replacement live");
  } finally { main.close(); child.close(); replacement?.close(); }
});

test("owner lookup does not depend on renderer callback identity", () => {
  const owner = fixture();
  try {
    for (const [key, render] of owner.entryRenderers) {
      owner.entryRenderers.set(key, (...args) => render(...args));
    }
    assert.equal(presentationRunnerBelongsTo(owner.pi, owner.runner), true);
  } finally { owner.close(); }
});

test("retired transcript keeps its last painted rows without native reflow; resize and new owners stay live", () => {
  let nativeCalls = 0;
  class Row {
    render(width: number) { nativeCalls++; return [`native:${width}`]; }
  }
  const owner = fixture();
  let replacement: ReturnType<typeof fixture> | undefined;
  try {
    const local = presentationPrototype(owner.pi, Row.prototype, "component");
    const original = local.render;
    local.render = function(width) { return original.call(this, width).map(row => `CC:${row}`); };
    const row = new Row();
    const tree = { children: [row] };
    owner.bind(tree);
    assert.deepEqual(row.render(80), ["CC:native:80"]);
    assert.deepEqual(row.render(80), ["CC:native:80"]);
    assert.equal(nativeCalls, 2, "live frames never use the retirement cache");
    owner.close();
    const outgoing = row.render(80);
    assert.deepEqual(outgoing, ["CC:native:80"]);
    assert.equal(nativeCalls, 2, "teardown must not reflow a still-mounted old transcript");
    outgoing[0] = "caller changed its returned array";
    assert.deepEqual(row.render(80), ["CC:native:80"]);
    assert.deepEqual(row.render(60), ["native:60"]);
    assert.equal(nativeCalls, 3, "resize still measures real content");

    replacement = fixture(owner.manager);
    const next = presentationPrototype(replacement.pi, Row.prototype, "component");
    const base = next.render;
    next.render = function(width) { return base.call(this, width).map(row => `new:${row}`); };
    replacement.bind(tree);
    assert.deepEqual(row.render(60), ["new:native:60"], "reused component must bind the replacement, not freeze forever");
    owner.close();
    assert.deepEqual(row.render(60), ["new:native:60"]);
    assert.equal(nativeCalls, 5, "late old teardown cannot retire the new view");
  } finally { owner.close(); replacement?.close(); }
});

test("readonly component instances retain their public renderer without decoration writes", () => {
  class Row { render(width: number) { return [`native:${width}`]; } }
  const owner = fixture();
  try {
    const local = presentationPrototype(owner.pi, Row.prototype, "component");
    const render = local.render;
    local.render = function(width) { return render.call(this, width).map(row => `CC:${row}`); };
    const row = Object.freeze(new Row());
    owner.bind({ children: [row] });
    assert.deepEqual(row.render(80), ["CC:native:80"]);
    assert.equal(Object.hasOwn(row, "render"), false);
    owner.close();
    assert.deepEqual(row.render(80), ["native:80"]);
  } finally { owner.close(); }
});

for (const activeRenders of [1, 2]) test(`snapshot owns its array after ${activeRenders} live render(s)`, () => {
  class Row { render(_width: number) { return ["native"]; } }
  const owner = fixture();
  try {
    const local = presentationPrototype(owner.pi, Row.prototype, "component");
    const original = local.render;
    local.render = function(width) { return original.call(this, width).map(line => `CC:${line}`); };
    const row = new Row(); owner.bind({ children: [row] });
    let returned: string[] = [];
    for (let n = 0; n < activeRenders; n++) returned = row.render(80);
    returned[0] = "caller mutation";
    owner.close();
    assert.deepEqual(row.render(80), ["CC:native"]);
  } finally { owner.close(); }
});

const assistantMessage = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text }],
  api: "anthropic-messages", provider: "test", model: "test", timestamp: 1,
  stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

for (const [name, mutate] of [
  ["invalidate", (row: AssistantMessageComponent) => row.invalidate()],
  ["theme refresh", (row: AssistantMessageComponent) => { initTheme("light"); row.invalidate(); }],
  ["Ctrl+T", (row: AssistantMessageComponent) => row.setHideThinkingBlock(true)],
  ["content update", (row: AssistantMessageComponent) => row.updateContent(assistantMessage("replacement"))],
  ["thinking label", (row: AssistantMessageComponent) => row.setHiddenThinkingLabel("different label")],
  ["output padding", (row: AssistantMessageComponent) => row.setOutputPad(3)],
] as const) test(`retired assistant drops its snapshot on ${name}`, () => {
  const nativeRender = AssistantMessageComponent.prototype.render;
  let nativeCalls = 0;
  AssistantMessageComponent.prototype.render = function(width) { nativeCalls++; return nativeRender.call(this, width); };
  const owner = fixture();
  try {
    const local = presentationPrototype(owner.pi, AssistantMessageComponent.prototype, "assistant");
    const base = local.render;
    local.render = function(width) { return base.call(this, width).map(line => `CC:${line}`); };
    const row = new AssistantMessageComponent(assistantMessage("original"));
    owner.bind({ children: [row] });
    const painted = row.render(80);
    assert.ok(painted.some(line => line.includes("CC:")));
    owner.close();
    assert.deepEqual(row.render(80), painted, "same-width unchanged assistant uses its snapshot");
    assert.equal(nativeCalls, 1);
    mutate(row);
    const updated = row.render(80);
    assert.ok(updated.every(line => !line.startsWith("CC:")), "mutation restores native rendering");
    assert.equal(nativeCalls, 2);
    row.render(80);
    assert.equal(nativeCalls, 3, "an invalidated retired row never freezes a new native frame");
    if (name === "theme refresh") assert.notDeepEqual(updated, painted.map(line => line.slice(3)));
    if (name === "content update") assert.ok(updated.join("\n").includes("replacement"));
    if (name === "Ctrl+T") assert.ok(!updated.join("\n").includes("private reasoning"));
  } finally { owner.close(); AssistantMessageComponent.prototype.render = nativeRender; initTheme("dark"); }
});

test("retired ToolExecutionComponent setExpanded and later updates remain visible", () => {
  const owner = fixture();
  try {
    const local = presentationPrototype(owner.pi, ToolExecutionComponent.prototype, "component");
    const base = local.render;
    local.render = function(width) { return base.call(this, width).map(line => `CC:${line}`); };
    const row = new ToolExecutionComponent("unknown", "call", {}, undefined, undefined,
      { requestRender() {} } as TUI, process.cwd());
    row.updateResult({ isError: false, content: [{ type: "text", text: Array.from({ length: 15 }, (_, i) => `output-${i}`).join("\n") }] });
    owner.bind({ children: [row] });
    const painted = row.render(80);
    owner.close();
    assert.deepEqual(row.render(80), painted);
    row.setExpanded(true);
    const expanded = row.render(80).join("\n");
    assert.ok(expanded.includes("output-14"));
    assert.ok(!expanded.includes("CC:"));
    row.updateResult({ isError: false, content: [{ type: "text", text: "new result" }] });
    assert.ok(row.render(80).join("\n").includes("new result"));
  } finally { owner.close(); }
});

for (const changed of [false, true]) test(`label-only reset without Thinking preserves only semantically unchanged content (${changed})`, () => {
  const owner = fixture();
  try {
    const local = presentationPrototype(owner.pi, AssistantMessageComponent.prototype, "assistant");
    const base = local.render;
    local.render = function(width) { return base.call(this, width).map(line => `CC:${line}`); };
    const message = assistantMessage("original text");
    message.content = [{ type: "text", text: "original text" }];
    const row = new AssistantMessageComponent(message, true);
    owner.bind({ children: [row] });
    const painted = row.render(80);
    owner.close();
    if (changed) (message.content[0] as { text: string }).text = "changed in place";
    // Host reset still executes the real setter and its nested updateContent.
    row.setHiddenThinkingLabel("reset label");
    const reset = row.render(80);
    if (changed) {
      assert.ok(reset.join("\n").includes("changed in place"));
      assert.ok(!reset.join("\n").includes("CC:"));
    } else assert.deepEqual(reset, painted, "no Thinking means the label cannot change the painted content");
    row.updateContent({ ...message, content: [{ type: "thinking", thinking: "new reasoning" }] });
    const thinking = row.render(80).join("\n");
    assert.ok(thinking.includes("reset label"), "the real setter was not skipped and governs future Thinking");
    assert.ok(!thinking.includes("CC:"));
  } finally { owner.close(); }
});

test("a replacement assistant snapshot tracks native content updates made while retired", () => {
  const old = fixture(); let replacement: ReturnType<typeof fixture> | undefined;
  try {
    const rowMessage = assistantMessage("first"); rowMessage.content = [{ type: "text", text: "first" }];
    const row = new AssistantMessageComponent(rowMessage);
    const tree = { children: [row] }; old.bind(tree);
    row.render(80); old.close();
    const nextMessage = { ...rowMessage, content: [{ type: "text" as const, text: "second" }] };
    row.updateContent(nextMessage);
    replacement = fixture(old.manager); replacement.bind(tree);
    row.render(80); replacement.close();
    nextMessage.content[0]!.text = "first";
    row.setHiddenThinkingLabel("irrelevant label");
    const lines = row.render(80).join("\n");
    assert.ok(lines.includes("first"));
    assert.ok(!lines.includes("second"), "the old input fingerprint must not bless a stale replacement snapshot");
  } finally { old.close(); replacement?.close(); }
});

for (const timing of ["before-render", "after-render"]) for (const change of ["text", "stopReason", "errorMessage", "toolCall"]) {
  test(`input key is captured with updateContent, not its mutable DTO: ${change} ${timing}`, () => {
    const owner = fixture();
    try {
      const local = presentationPrototype(owner.pi, AssistantMessageComponent.prototype, "assistant");
      const base = local.render;
      local.render = function(width) { return base.call(this, width).map(line => `CC:${line}`); };
      const message = assistantMessage("old text"); message.content = [{ type: "text", text: "old text" }];
      if (change === "errorMessage") { message.stopReason = "error"; message.errorMessage = "old error"; }
      const row = new AssistantMessageComponent(message); owner.bind({ children: [row] });
      if (timing === "after-render") row.render(80);
      if (change === "text") (message.content[0] as { text: string }).text = "new text";
      if (change === "stopReason") message.stopReason = "aborted";
      if (change === "errorMessage") message.errorMessage = "new error";
      if (change === "toolCall") message.content.push({ type: "toolCall", id: "late", name: "read", arguments: {} });
      if (timing === "before-render") row.render(80);
      owner.close(); row.setHiddenThinkingLabel("reset");
      const updated = row.render(80).join("\n");
      assert.ok(!updated.includes("CC:"), "label reset must not bless stale painted content");
      if (change === "text") assert.ok(updated.includes("new text"));
      if (change === "stopReason") assert.ok(updated.includes("Operation aborted"));
      if (change === "errorMessage") assert.ok(updated.includes("new error"));
      if (change === "toolCall") assert.ok(!updated.includes("\x1b]133;"), "tool calls change the native OSC zone even with unchanged prose");
    } finally { owner.close(); }
  });
}

for (const [name, mutate] of [
  ["invalidate", (row: AssistantMessageComponent) => row.invalidate()],
  ["Ctrl+T", (row: AssistantMessageComponent) => row.setHideThinkingBlock(true)],
  ["padding", (row: AssistantMessageComponent) => row.setOutputPad(3)],
] as const) test(`label-only reset does not swallow the next ${name}`, () => {
  const owner = fixture();
  try {
    const local = presentationPrototype(owner.pi, AssistantMessageComponent.prototype, "assistant");
    const base = local.render;
    local.render = function(width) { return base.call(this, width).map(line => `CC:${line}`); };
    const message = assistantMessage("body"); message.content = [{ type: "text", text: "body" }];
    const row = new AssistantMessageComponent(message); owner.bind({ children: [row] });
    const painted = row.render(80); owner.close(); row.setHiddenThinkingLabel("reset");
    assert.deepEqual(row.render(80), painted);
    mutate(row);
    assert.ok(!row.render(80).join("\n").includes("CC:"));
  } finally { owner.close(); }
});

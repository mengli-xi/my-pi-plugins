import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { GroupStore } from "../src/grouping.ts";
import { installToolPresentationBoundary } from "../src/presentation-boundary.ts";
import { decorateToolRenderers, type DecorateToolOptions } from "../src/tool-renderer.ts";

function options(store = new GroupStore({ maxGroups: 10 })): DecorateToolOptions {
  return { store, getExpandMode: () => "overlay", resolvePresentation: () => ({ kind: "grouped" }), maxResultChars: 10_000 };
}
function harness(config = options()) {
  let resolve: ToolRendererResolver;
  const pi = { registerToolRenderer(resolver: ToolRendererResolver) { resolve = resolver; } } as ExtensionAPI;
  const dispose = installToolPresentationBoundary(pi, config);
  return { resolve: (name: string, next: () => ToolRenderers | undefined) => resolve(name, next), dispose, config };
}
const context = {
  toolCallId: "call-1", args: {}, cwd: "/tmp", expanded: false, isPartial: false,
  isError: false, executionStarted: true, argsComplete: true, showImages: false,
  durationMs: undefined, outputPad: 0, state: {}, lastComponent: undefined, invalidate() {},
  keyText: () => "", keyHint: (_key: string, description: string) => description,
};

test("public resolver decorates renderer-only views without modifying the tool owner", () => {
  const h = harness();
  const original: ToolRenderers = { renderCall: () => new Text("native", 0, 0) };
  let nextCalls = 0;
  const next = () => { nextCalls++; return original; };
  const first = h.resolve("third_party", next)!;
  assert.equal(nextCalls, 1);
  assert.equal(first, h.resolve("third_party", next), "stable renderers are cached");
  assert.notEqual(first, original);
  assert.equal(first.renderShell, "self");
  assert.equal(original.renderShell, undefined);
  first.renderCall?.({}, {} as Theme, context);
  assert.equal(h.config.store.getByToolCallId("call-1")?.activities[0]?.toolName, "third_party");
  assert.notEqual(h.resolve("another", next), first, "one renderer object can serve different tools");
  h.dispose();
  assert.equal(h.resolve("third_party", next), original, "retired runtime delegates to next");
});

test("missing renderers and policy failures preserve native output", () => {
  const h = harness();
  assert.equal(h.resolve("unknown", () => undefined), undefined);
  h.dispose();
  const failed = harness({ ...options(), resolvePresentation() { throw new Error("policy unavailable"); } });
  const original = { renderShell: "default" as const };
  assert.equal(failed.resolve("tool", () => original), original);
  failed.dispose();
});

test("native presentations delegate both renderers and retain their shell", () => {
  const h = harness({ ...options(), resolvePresentation: () => ({ kind: "native" }) });
  const call = new Text("native call", 0, 0);
  const result = new Text("native result", 0, 0);
  const view = h.resolve("process", () => ({ renderShell: "default", renderCall: () => call, renderResult: () => result }))!;
  assert.equal(view.renderShell, "default");
  assert.equal(view.renderCall?.({}, {} as Theme, context), call);
  assert.equal(view.renderResult?.({ content: [], details: undefined }, { expanded: false, isPartial: false }, {} as Theme, context), result);
  h.dispose();
});

test("a new runtime unwraps a stale decorated view before taking ownership", () => {
  const old = options();
  const root: ToolRenderers = { renderCall: () => new Text("root", 0, 0) };
  const stale = decorateToolRenderers("third_party", root, old);
  const h = harness();
  h.resolve("third_party", () => stale)?.renderCall?.({}, {} as Theme, context);
  assert.equal(old.store.getByToolCallId("call-1"), undefined);
  assert.ok(h.config.store.getByToolCallId("call-1"));
  h.dispose();
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { createCustomEntryDelegate } from "../../src/integrations/custom-entry-delegate.ts";

const KEY = Symbol.for("pi.claude-style.custom-entry-presentations.v1");

function globals(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

function component(text: string): Component {
  return { render: () => [text], invalidate() {} };
}

test.afterEach(() => {
  delete globals()[KEY];
});

test("historical process entries adopt and release a late presentation provider", () => {
  const fallback = component("fallback");
  const delegate = createCustomEntryDelegate("process-event-v2", { version: 1 }, fallback);
  assert.deepEqual(delegate.render(80), ["fallback"]);

  const provider = { version: 1, render: () => component("provider") };
  globals()[KEY] = { version: 1, providers: new Map([["process-event-v2", provider]]) };
  assert.deepEqual(delegate.render(80), ["provider"]);

  (globals()[KEY] as { providers: Map<string, unknown> }).providers.delete("process-event-v2");
  assert.deepEqual(delegate.render(80), ["fallback"]);
});

test("a broken provider fails open to fallback", () => {
  const fallback = component("fallback");
  globals()[KEY] = {
    version: 1,
    providers: new Map([["process-event-v2", { version: 1, render: () => { throw new Error("broken"); } }]]),
  };
  const delegate = createCustomEntryDelegate("process-event-v2", {}, fallback);
  assert.deepEqual(delegate.render(80), ["fallback"]);
});

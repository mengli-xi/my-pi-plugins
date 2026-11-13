import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme, type Theme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installClaudeAssistantMessages, LogicalBulletComponent } from "../src/assistant-message.ts";
import { disposePresentationOwner, installPresentationOwner, presentationPrototype } from "../src/presentation-owner.ts";
import { CodeFenceMarkerHidingComponent } from "../src/code-fence.ts";
import { DEFAULT_ASSISTANT_MESSAGES } from "../src/config.ts";

// Count real decoration work, while the child deliberately allocates equal arrays.
test("bullet caches only the latest native rows, width, marker and theme", () => {
  let paints = 0, renders = 0, tint = "";
  let theme = { fg: (_key: string, text: string) => { paints++; return tint + text; } } as Theme;
  const config = { ...DEFAULT_ASSISTANT_MESSAGES };
  const rows = ["\x1b[31m中文\x1b[0m", "", "tail"];
  const component = new LogicalBulletComponent({ render() { renders++; return rows.slice(); }, invalidate() {} }, config, () => theme);
  const first = component.render(60);
  assert.deepEqual(first, [config.marker + rows[0], " ".repeat(1), " tail"]);
  assert.equal(paints, 1);
  assert.deepEqual(component.render(60), first);
  assert.equal(paints, 1); assert.equal(renders, 2);
  first[0] = "caller mutation";
  assert.notEqual(component.render(60)[0], first[0]);
  rows[0] = "new body";
  assert.match(component.render(60)[0]!, /new body/);
  assert.equal(paints, 2);
  component.render(20); component.render(60);
  assert.equal(paints, 4, "only the most recent width survives");
  tint = "\x1b[32m";
  component.invalidate();
  assert.match(component.render(60)[0]!, /^\x1b\[32m/);
  assert.equal(paints, 5);
  theme = { fg: (_key: string, text: string) => { paints++; return "other" + text; } } as Theme;
  assert.match(component.render(60)[0]!, /^other/);
  config.marker = "中文";
  assert.match(component.render(60)[1]!, /^ {4}$/);
  config.markerColor = config.markerColor === "muted" ? "accent" : "muted";
  const cost = paints;
  component.render(60); assert.equal(paints, cost + 1);
  component.dispose(); component.render(60); assert.equal(paints, cost + 2);
  assert.deepEqual(component.render(1), rows);
});

test("fence filtering hits equal new arrays but misses changed rows, resize and invalidate", () => {
  let filters = 0, renders = 0;
  class Rows extends Array<string> {
    static get [Symbol.species]() { return Array; }
    override filter(predicate: (value: string, index: number, array: string[]) => unknown): string[] {
      filters++;
      return super.filter(predicate);
    }
  }
  let body = ["```ts", "\x1b[31m中文\x1b[0m", "```", "tail"];
  const component = new CodeFenceMarkerHidingComponent({ render() { renders++; return new Rows(...body); }, invalidate() {} });
  const first = component.render(60);
  assert.deepEqual(first, [body[1], "tail"]);
  assert.deepEqual(component.render(60), first);
  assert.equal(filters, 1); assert.equal(renders, 2);
  first[0] = "caller mutation";
  assert.notEqual(component.render(60)[0], first[0]);
  body[0] = "no longer fenced";
  assert.equal(component.render(60)[0], body[0]); assert.equal(filters, 2);
  component.render(20); component.render(60); assert.equal(filters, 4);
  component.invalidate(); component.render(60); assert.equal(filters, 5);
  component.dispose(); component.render(60); assert.equal(filters, 6);
  body = []; assert.deepEqual(component.render(60), []);
});

test("Main and child own separate frames and release them on retirement/reload", () => {
  initTheme("dark");
  const owner = (marker: string) => {
    let paints = 0;
    const handlers = new Map<string, Function[]>();
    const pi = { registerEntryRenderer() {}, on(name: string, fn: Function) {
      handlers.set(name, [...handlers.get(name) ?? [], fn]);
    } } as unknown as ExtensionAPI;
    installPresentationOwner(pi);
    const config = { ...DEFAULT_ASSISTANT_MESSAGES, marker,
      typewriter: { ...DEFAULT_ASSISTANT_MESSAGES.typewriter, enabled: false } };
    const dispose = installClaudeAssistantMessages(pi, config);
    const emit = (name: string) => { for (const fn of handlers.get(name) ?? []) fn({}, {
      mode: "tui", hasUI: true, sessionManager: { getSessionId: () => marker, getBranch: () => [] }, ui: { setWidget() {}, theme: {
        fg: (_key: string, text: string) => { if (text === marker) paints++; return text; },
      } },
    }); };
    emit("session_start");
    const proto = presentationPrototype(pi, AssistantMessageComponent.prototype, "assistant");
    const row = new AssistantMessageComponent();
    proto.updateContent.call(row, { role: "assistant", content: [{ type: "text", text: "body 中文\n\n```ts\nconst x = 1;\n```" }],
      api: "openai-responses", provider: "test", model: "test", stopReason: "stop", timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }, false);
    return { row, emit, paints: () => paints, dispose: () => { dispose(); disposePresentationOwner(pi); } };
  };
  const main = owner("M"), child = owner("C");
  try {
    const a = main.row.render(60), b = child.row.render(60);
    const am = main.paints(), bc = child.paints();
    assert.deepEqual(main.row.render(60), a); assert.deepEqual(child.row.render(60), b);
    assert.equal(main.paints(), am); assert.equal(child.paints(), bc);
    main.emit("session_shutdown");
    assert.deepEqual(main.row.render(60), a); assert.ok(main.paints() > am);
    assert.deepEqual(child.row.render(60), b); assert.equal(child.paints(), bc);
    child.emit("session_start"); child.row.render(60); assert.ok(child.paints() > bc);
  } finally { main.dispose(); child.dispose(); }
});

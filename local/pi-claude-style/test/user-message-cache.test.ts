import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@earendil-works/pi-tui";
import { InteractiveMode, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_USER_MESSAGES } from "../src/config.ts";
import { installCompactUserMessages } from "../src/user-message.ts";
import { disposePresentationOwner, installPresentationOwner, presentationPrototype } from "../src/presentation-owner.ts";
import { click } from "./native-mouse.ts";

initTheme("dark");
function harness(owned = false) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  let paints = 0;
  let tint = "";
  const theme = { fg: (_name: string, text: string) => { paints++; return tint + text; } };
  const pi = { registerEntryRenderer() {}, on(name: string, handler: (event: any, ctx: any) => void) {
    handlers.set(name, [...handlers.get(name) ?? [], handler]);
  } } as never;
  const ctx = { hasUI: true, ui: { theme }, sessionManager: { getBranch: () => [], getSessionId: () => "cache-test" } };
  const emit = (name: string) => { for (const handler of handlers.get(name) ?? []) handler({}, ctx); };
  if (owned) installPresentationOwner(pi);
  return { pi, ctx, emit, theme, paints: () => paints, tint: (value: string) => { tint = value; } };
}

// Count actual decoration work, not a cache counter or array identity.
test("native content equality reuses only the latest frame, invalidate and resize repaint", () => {
  const native = UserMessageComponent.prototype.render;
  let calls = 0;
  const rows = ["\x1b[31m中文 ANSI\x1b[0m", "tail"];
  UserMessageComponent.prototype.render = function() { calls++; return calls % 2 ? rows : rows.slice(); };
  const h = harness();
  const dispose = installCompactUserMessages(h.pi, DEFAULT_USER_MESSAGES);
  h.emit("session_start");
  try {
    const component = new UserMessageComponent("source");
    const first = component.render(60);
    const cost = h.paints();
    assert.ok(cost > 0);
    assert.deepEqual(component.render(60), first);
    assert.equal(calls, 2, "native render runs even when it returns an equal new array");
    assert.equal(h.paints(), cost, "stable frame does not repaint the box");
    first[0] = "caller mutation";
    assert.notEqual(component.render(60)[0], first[0]);
    rows[0] = "changed in the same native array";
    const changed = component.render(60);
    assert.match(changed.join("\n"), /changed in/);
    assert.ok(h.paints() > cost);
    const afterChange = h.paints();
    assert.deepEqual(component.render(60), changed);
    assert.equal(h.paints(), afterChange);
    component.render(8);
    const narrowCost = h.paints();
    component.render(60);
    assert.ok(h.paints() > narrowCost, "old widths are not retained");
    h.tint("\x1b[32m");
    const old = component.render(60);
    component.invalidate();
    const fresh = component.render(60);
    assert.notDeepEqual(fresh, old, "same theme identity changes through invalidate");
    const freshCost = h.paints();
    assert.deepEqual(component.render(60), fresh);
    assert.equal(h.paints(), freshCost);
    h.emit("session_shutdown");
    component.render(60);
    assert.ok(h.paints() > freshCost, "retirement drops frames");
  } finally { dispose(); UserMessageComponent.prototype.render = native; }
});

test("mutating/dynamic transforms run on every hit without poisoning the frame or folding clicks", () => {
  const key = Symbol.for("ui-pack.user-message-render-transforms.v1");
  const scope = globalThis as Record<PropertyKey, unknown>;
  const previous = scope[key];
  let transforms = 0;
  const inputs: string[][] = [];
  scope[key] = { version: 1, transforms: new Map([[Symbol(), (lines: string[]) => {
    inputs.push(lines.slice()); lines.push(`dynamic ${++transforms}`); return lines;
  }]]) };
  const h = harness();
  const opened: string[] = [];
  const dispose = installCompactUserMessages(h.pi, { ...DEFAULT_USER_MESSAGES, maxLines: 1 }, (_title, text) => { opened.push(text); return true; });
  h.emit("session_start");
  try {
    const source = "/tmp/pi-clipboard-123e4567-e89b-12d3-a456-426614174000.png\n二\n三\n四";
    const component = new UserMessageComponent(source);
    const first = component.render(60), cost = h.paints();
    const second = component.render(60);
    assert.equal(h.paints(), cost);
    assert.equal(click(component), true);
    assert.deepEqual(inputs[0], inputs[1]);
    assert.notDeepEqual(first, second);
    assert.deepEqual(opened, ["[Image #1]\n二\n三\n四"]);
    assert.equal(transforms, 2);
  } finally { dispose(); if (previous === undefined) delete scope[key]; else scope[key] = previous; }
});

test("fold state follows native content and maxLines even after a cache hit", () => {
  const native = UserMessageComponent.prototype.render;
  let rows = ["one", "two", "three", "four"];
  UserMessageComponent.prototype.render = () => rows;
  const h = harness();
  const config = { ...DEFAULT_USER_MESSAGES, maxLines: 1 };
  const dispose = installCompactUserMessages(h.pi, config, () => true);
  h.emit("session_start");
  try {
    const component = new UserMessageComponent("one\ntwo\nthree\nfour");
    component.render(60); component.render(60);
    config.maxLines = 0;
    assert.doesNotMatch(component.render(60).join("\n"), /click to view/);
    assert.equal(click(component), false);
    config.maxLines = 1;
    component.render(60);
    rows = ["short"];
    component.render(60); component.render(60);
    assert.equal(click(component), false);
  } finally { dispose(); UserMessageComponent.prototype.render = native; }
});

test("narrow and throwing native fallbacks preserve the last folded click but discard the frame", () => {
  const native = UserMessageComponent.prototype.render;
  let failInner = false;
  UserMessageComponent.prototype.render = function(width) {
    if (failInner && width !== 60) throw new Error("inner layout unavailable");
    return width === 60 || width < 8 ? ["native fallback"] : ["one", "two", "three", "four"];
  };
  const h = harness();
  const dispose = installCompactUserMessages(h.pi, { ...DEFAULT_USER_MESSAGES, maxLines: 1 }, () => true);
  h.emit("session_start");
  try {
    const component = new UserMessageComponent("one\ntwo\nthree\nfour");
    const first = component.render(60);
    assert.deepEqual(component.render(7), ["native fallback"]);
    assert.equal(click(component), true, "narrow fallback keeps the previous folded popup");
    component.render(60);
    failInner = true;
    assert.deepEqual(component.render(60), ["native fallback"]);
    assert.equal(click(component), true, "throwing fallback keeps the previous folded popup");
    const cost = h.paints();
    failInner = false;
    assert.deepEqual(component.render(60), first);
    assert.ok(h.paints() > cost);
  } finally { dispose(); UserMessageComponent.prototype.render = native; }
});

test("disposing a cached renderer restores native history rows and clicks", () => {
  const component = new UserMessageComponent("history\n二\n三\n四");
  const h = harness();
  const dispose = installCompactUserMessages(h.pi, { ...DEFAULT_USER_MESSAGES, maxLines: 1 }, () => true);
  h.emit("session_start");
  try {
    component.render(60); component.render(60);
  } finally { dispose(); }
  assert.doesNotMatch(component.render(60).join("\n"), /click to view/);
  assert.equal(click(component), false);
});

test("Main/child frames, invalidation and reload configuration are independent", () => {
  const main = harness(true), child = harness(true);
  const releaseMain = installCompactUserMessages(main.pi, { ...DEFAULT_USER_MESSAGES, title: "Main" });
  const releaseChild = installCompactUserMessages(child.pi, { ...DEFAULT_USER_MESSAGES, title: "Child" });
  main.emit("session_start"); child.emit("session_start");
  const mainProto = presentationPrototype(main.pi, UserMessageComponent.prototype, "component");
  const childProto = presentationPrototype(child.pi, UserMessageComponent.prototype, "component");
  const a = new UserMessageComponent("same"), b = new UserMessageComponent("same");
  try {
    const first = mainProto.render.call(a, 60), second = childProto.render.call(b, 60);
    assert.match(first.join("\n"), /Main/); assert.match(second.join("\n"), /Child/);
    const costMain = main.paints(), costChild = child.paints();
    assert.deepEqual(mainProto.render.call(a, 60), first);
    assert.deepEqual(childProto.render.call(b, 60), second);
    assert.equal(main.paints(), costMain); assert.equal(child.paints(), costChild);
    mainProto.invalidate.call(a);
    mainProto.render.call(a, 60); childProto.render.call(b, 60);
    assert.ok(main.paints() > costMain); assert.equal(child.paints(), costChild);
    main.emit("session_shutdown"); releaseMain(); disposePresentationOwner(main.pi);
    assert.deepEqual(childProto.render.call(b, 60), second);
    assert.equal(child.paints(), costChild);
    releaseChild(); disposePresentationOwner(child.pi);
    const reload = harness();
    const releaseReload = installCompactUserMessages(reload.pi, { ...DEFAULT_USER_MESSAGES, title: "Reload", maxLines: 0 });
    reload.emit("session_start");
    try { assert.match(a.render(60).join("\n"), /Reload/); }
    finally { releaseReload(); }
  } finally { releaseMain(); releaseChild(); disposePresentationOwner(main.pi); disposePresentationOwner(child.pi); }
});

test("a cached timestamp updates across midnight, year and branch navigation", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-12-31T23:59:00") });
  const prototype = InteractiveMode.prototype as unknown as { addMessageToChat(this: { chatContainer: Container }, message: { content: string }): void };
  const append = prototype.addMessageToChat;
  prototype.addMessageToChat = function(message) { this.chatContainer.addChild(new UserMessageComponent(message.content)); };
  const message = { role: "user", content: "dated", timestamp: 1 };
  let entries = [{ type: "message", timestamp: "2026-12-31T23:58:00", message }];
  const h = harness();
  h.ctx.sessionManager.getBranch = () => entries as never;
  const dispose = installCompactUserMessages(h.pi, DEFAULT_USER_MESSAGES);
  h.emit("session_start");
  try {
    const mode = { chatContainer: new Container() };
    prototype.addMessageToChat.call(mode, message);
    const component = mode.chatContainer.children[0]!;
    const first = component.render(80), cost = h.paints();
    assert.match(first[0]!, /user 23:58/);
    assert.deepEqual(component.render(80), first); assert.equal(h.paints(), cost);
    t.mock.timers.setTime(new Date("2027-01-01T00:01:00").getTime());
    assert.match(component.render(80)[0]!, /2026-12-31 23:58/);
    assert.ok(h.paints() > cost);
    entries = [{ ...entries[0]!, timestamp: "2027-01-01T00:00:00" }];
    h.emit("session_tree");
    assert.match(component.render(80)[0]!, /user 00:00/);
    entries = [];
    h.emit("session_tree");
    assert.doesNotMatch(component.render(80)[0]!, /00:00/);
  } finally { dispose(); prototype.addMessageToChat = append; }
});

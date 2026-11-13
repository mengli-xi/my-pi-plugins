import assert from "node:assert/strict";
import test from "node:test";
import { BranchSummaryMessageComponent, CompactionSummaryMessageComponent, InteractiveMode, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { installCompactCompactionSummaries } from "../src/compaction-summary.ts";
import type { TextOpener } from "../src/openers.ts";
import { disposePresentationOwner, installPresentationOwner, presentationPrototype } from "../src/presentation-owner.ts";
import type { TimestampOwner } from "../src/compat/user-message.ts";
import { click } from "./native-mouse.ts";

initTheme("dark");
const message = (summary = "# Kept context\n\n```ts\nconst kept = true;\n```", tokensBefore = 123456) => ({
  role: "compactionSummary" as const, summary, tokensBefore, timestamp: 1,
});
function host() {
  return { chatContainer: new Container(), getMarkdownTransformers: () => [], getMarkdownThemeWithSettings: () => undefined, outputPad: 0, toolOutputExpanded: false };
}
function append(target: ReturnType<typeof host>, value: ReturnType<typeof message>, owner?: ExtensionAPI): Component {
  const prototype = owner ? presentationPrototype(owner, InteractiveMode.prototype as unknown as TimestampOwner, "mode")
    : InteractiveMode.prototype as unknown as TimestampOwner;
  prototype.addMessageToChat!.call(target, value);
  return target.chatContainer.children.at(-1)!;
}

test("a native compaction becomes one row and opens exactly its own retained summary", () => {
  const opened: Parameters<TextOpener>[] = [];
  const restore = installCompactCompactionSummaries({} as ExtensionAPI, (...args) => { opened.push(args); return true; }, () => undefined);
  try {
    const target = host(), first = message(), second = message("second compaction", 42);
    const original = structuredClone(first);
    const one = append(target, first), two = append(target, second);
    assert.ok(one instanceof CompactionSummaryMessageComponent);
    assert.deepEqual(one.render(100), ["---- [compaction] compacted from 123456 tokens ------"]);
    one.setExpanded(true);
    one.invalidate();
    assert.equal(one.render(100).length, 1, "Ctrl+O/invalidate do not expand the transcript row");
    assert.equal(click(one), true);
    assert.equal(click(two), true);
    assert.deepEqual(opened, [
      ["Compaction summary", first.summary, { format: "markdown", hideCodeFenceMarkers: false }],
      ["Compaction summary", second.summary, { format: "markdown", hideCodeFenceMarkers: false }],
    ]);
    assert.deepEqual(first, original, "presentation does not rewrite the model's compaction");
    for (const width of [1, 12, 40]) assert.ok(one.render(width).every(line => visibleWidth(line) <= width));
  } finally { restore(); }
});

test("only a completed left click opens the panel; teardown restores native behavior", () => {
  let opened = 0;
  const restore = installCompactCompactionSummaries({} as ExtensionAPI, () => { opened++; return true; }, () => undefined);
  const target = host(), value = message(), row = append(target, value);
  try {
    row.handleMouse?.({ type: "press", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 100, height: 40, shift: false, alt: false, ctrl: false });
    click(row, 0, 0, "right");
    assert.equal(opened, 0);
    assert.equal(click(row), true);
    restore();
    assert.equal(click(row), false);
    assert.equal(opened, 1);
    const native = new CompactionSummaryMessageComponent(value, undefined, 0);
    assert.deepEqual(row.render(100), native.render(100));
  } finally { restore(); }
});

test("branch summaries keep their native rendering and a declined opener does not consume clicks", () => {
  const restore = installCompactCompactionSummaries({} as ExtensionAPI, () => false, () => undefined);
  try {
    const target = host();
    const branch = { role: "branchSummary" as const, summary: "branch only", fromId: null, timestamp: 1 };
    const prototype = InteractiveMode.prototype as unknown as TimestampOwner;
    prototype.addMessageToChat!.call(target, branch);
    assert.deepEqual(target.chatContainer.children.at(-1)!.render(100), new BranchSummaryMessageComponent(branch, undefined, 0).render(100));
    assert.equal(click(append(target, message())), false);
  } finally { restore(); }
});

test("an empty retained summary is explicitly identified in the panel", () => {
  let body = "";
  const restore = installCompactCompactionSummaries({} as ExtensionAPI, (_title, value) => { body = value; return true; }, () => undefined);
  try {
    assert.equal(click(append(host(), message("", 0))), true);
    assert.equal(body, "（本次压缩摘要为空）");
  } finally { restore(); }
});

test("Main and child rows retain their own opener after Main teardown", () => {
  const main = { on() {}, registerEntryRenderer() {} } as unknown as ExtensionAPI, child = { on() {}, registerEntryRenderer() {} } as unknown as ExtensionAPI;
  installPresentationOwner(main); installPresentationOwner(child);
  const opened: string[] = [];
  const releaseMain = installCompactCompactionSummaries(main, () => { opened.push("main"); return true; }, () => undefined);
  const releaseChild = installCompactCompactionSummaries(child, () => { opened.push("child"); return true; }, () => undefined);
  try {
    const mainRow = append(host(), message("Main"), main), childRow = append(host(), message("child"), child);
    assert.equal(click(mainRow), true);
    assert.equal(click(childRow), true);
    releaseMain(); disposePresentationOwner(main);
    assert.equal(click(mainRow), false);
    assert.equal(click(childRow), true);
    assert.deepEqual(opened, ["main", "child", "child"]);
  } finally { releaseChild(); releaseMain(); disposePresentationOwner(child); disposePresentationOwner(main); }
});

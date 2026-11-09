import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { historyBoundary, historyWindowStart } from "../src/history-window.ts";
import { historyRenderEntries, installFullHistory, shiftHistorySelection } from "../src/compat/full-history.ts";
import { auditInternals } from "../src/internals.ts";
import { TuiAltScreen } from "@earendil-works/pi-tui";

const timestamp = "2026-10-19T00:00:00.000Z";
function message(index: number, role = "user"): SessionEntry {
  return { type: "message", id: String(index), parentId: null, timestamp,
    message: { role, content: role === "user" ? `message ${index}` : [], timestamp: index } } as SessionEntry;
}
function compact(id: string, firstKeptEntryId: string): SessionEntry {
  return { type: "compaction", id, parentId: null, timestamp, summary: `summary ${id}`, firstKeptEntryId, tokensBefore: 10000 };
}

test("initial tail and successive batches cover the branch once in chronological order", () => {
  const entries = Array.from({ length: 925 }, (_, i) => message(i));
  let end = entries.length;
  const chunks: SessionEntry[][] = [];
  while (end > 0) {
    const start = historyWindowStart(entries, end);
    chunks.unshift(entries.slice(start, end));
    end = start;
  }
  assert.equal(historyWindowStart(entries), 725);
  assert.deepEqual(chunks.map(chunk => chunk.length), [125, 200, 200, 200, 200]);
  assert.deepEqual(chunks.flat(), entries);
  assert.equal(historyWindowStart([]), 0);
  assert.equal(historyWindowStart(entries.slice(0, 20)), 0);
});

test("batch boundary keeps a complete user/tool turn and stops at a summary boundary", () => {
  const entries = [message(0), message(1, "assistant"), message(2, "toolResult"), message(3, "assistant"), message(4)];
  assert.equal(historyWindowStart(entries, entries.length, 3), 0);
  assert.equal(historyWindowStart(entries, entries.length, 1), 4);
  entries[1] = compact("c1", "0");
  assert.equal(historyWindowStart(entries, entries.length, 3), 1);
});

test("a summary boundary cannot separate a tool call from its later result", () => {
  const entries = [message(0), { ...message(1, "assistant"), message: { role: "assistant", content: [{ type: "toolCall", id: "paired", name: "read", arguments: {} }] } },
    compact("c", "0"), { ...message(3, "toolResult"), message: { role: "toolResult", toolCallId: "paired", toolName: "read", content: [] } }, message(4)] as SessionEntry[];
  assert.equal(historyWindowStart(entries, 5, 3), 0);
});

test("latest firstKept boundary precedes the retained tail, summaries stay chronological and tail is unique", () => {
  const entries = [message(0), message(1), message(2), compact("c1", "1"), message(4), compact("c2", "2"), message(6)];
  assert.deepEqual(historyBoundary(entries), { index: 2, count: 2 });
  const rendered = historyRenderEntries(entries, 0);
  assert.deepEqual(rendered.filter(entry => entry.type !== "custom_message"), entries);
  assert.equal(rendered[2]!.type, "custom_message");
  assert.match((rendered[2] as { content: string }).content, /以上 2 条消息已压缩/u);
  assert.deepEqual(rendered.filter(entry => entry.type === "compaction").map(entry => entry.id), ["c1", "c2"]);
  assert.equal(rendered.filter(entry => entry.id === "2").length, 1);
  assert.deepEqual(historyRenderEntries(entries, 4), entries.slice(4));
  assert.equal(historyRenderEntries(entries, 0, 2).filter(entry => entry.type === "custom_message").length, 0);
  assert.equal(historyRenderEntries(entries, 2, 4).filter(entry => entry.type === "custom_message").length, 1);
  assert.equal(historyBoundary([message(0), compact("c", "missing")]), undefined);
});

test("prepending shifts aliased word-selection anchors once and leaves other views/screen coordinates intact", () => {
  const scroll = {} as Parameters<typeof shiftHistorySelection>[1];
  const point = { row: 8, col: 4, scrollView: scroll };
  const other = { row: 7, col: 1, scrollView: {} };
  const host = { selectionAnchor: point, selectionFocus: other, selectionInitialRange: { start: point, end: { row: 9, col: 10, scrollView: scroll } }, lastClick: { row: 8, scrollView: scroll } };
  shiftHistorySelection(host, scroll, 13);
  assert.equal(point.row, 21);
  assert.equal(host.selectionInitialRange.end.row, 22);
  assert.equal(host.lastClick.row, 21);
  assert.equal(other.row, 7);
  assert.throws(() => shiftHistorySelection({}, scroll, 1), /unavailable/u);
  assert.doesNotThrow(() => shiftHistorySelection({ selectionAnchor: undefined, selectionFocus: undefined, selectionInitialRange: undefined, lastClick: undefined }, undefined as unknown as typeof scroll, 0));
  const startup = { row: 2, col: 1, scrollView: scroll };
  shiftHistorySelection({ selectionAnchor: startup, selectionFocus: startup, selectionInitialRange: undefined, lastClick: undefined }, scroll, 4, 11);
  assert.equal(startup.row, 2);
});

test("history probe mismatch leaves the original renderer and event handler installed", () => {
  const prototype = InteractiveMode.prototype as unknown as { renderSessionEntries: Function; handleEvent: Function };
  const original = prototype.renderSessionEntries;
  const handle = prototype.handleEvent;
  let calls = 0;
  const changed = function (..._args: unknown[]) { calls++; };
  prototype.renderSessionEntries = changed;
  const pi = { on() { return () => {}; }, registerMessageRenderer() {} } as unknown as ExtensionAPI;
  const history = installFullHistory(pi);
  try {
    assert.equal(prototype.renderSessionEntries, changed);
    assert.equal(prototype.handleEvent, handle);
    prototype.renderSessionEntries([]);
    assert.equal(calls, 1);
    assert.equal(auditInternals().find(row => row.id === "history.renderEntries")?.state, "missing");
  } finally { history.dispose(); prototype.renderSessionEntries = original; }
});

test("regular mode passes precisely the native context entries through", () => {
  const prototype = InteractiveMode.prototype as unknown as { renderSessionEntries: Function };
  const entries = [message(1), message(2)];
  const pi = { on() { return () => {}; }, registerMessageRenderer() {} } as unknown as ExtensionAPI;
  const history = installFullHistory(pi);
  let items: unknown[] = [];
  try {
    prototype.renderSessionEntries.call({ renderer: { mode: "regular" }, renderSessionItems(value: unknown[]) { items = value; } }, entries);
    assert.deepEqual(items, entries.map(entry => (entry as { message: unknown }).message));
  } finally { history.dispose(); }
});

test("selection probe mismatch also leaves both native history methods unchanged", () => {
  const prototype = InteractiveMode.prototype as unknown as { renderSessionEntries: Function; handleEvent: Function };
  const render = prototype.renderSessionEntries, handle = prototype.handleEvent;
  const reset = TuiAltScreen.prototype.resetTextSelection;
  TuiAltScreen.prototype.resetTextSelection = function () {};
  const pi = { on() { return () => {}; }, registerMessageRenderer() {} } as unknown as ExtensionAPI;
  const history = installFullHistory(pi);
  try {
    assert.equal(prototype.renderSessionEntries, render);
    assert.equal(prototype.handleEvent, handle);
    assert.equal(auditInternals().find(row => row.id === "history.selectionAnchors")?.state, "missing");
  } finally { history.dispose(); TuiAltScreen.prototype.resetTextSelection = reset; }
});

import { requirePatchedHost } from "./patched-host.ts";
requirePatchedHost();

import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { gateTerminal, TerminalOwner } from "../src/terminal-owner.ts";

function memoryTerminal() {
  const output: unknown[][] = [];
  const terminal = {
    write(data: string) { assert.equal(this, terminal); output.push(["write", data]); },
    setTitle(value: string) { assert.equal(this, terminal); output.push(["title", value]); },
    setProgress(value: boolean) { assert.equal(this, terminal); output.push(["progress", value]); },
    setProgramStatus(value: Parameters<Terminal["setProgramStatus"]>[0]) { assert.equal(this, terminal); output.push(["status", value]); },
  } as Terminal;
  const original = { write: terminal.write, setTitle: terminal.setTitle, setProgress: terminal.setProgress, setProgramStatus: terminal.setProgramStatus };
  return { terminal, original, output };
}
function emit(terminal: Terminal, text: string) {
  terminal.write(text); terminal.setTitle(text); terminal.setProgress(false); terminal.setProgramStatus({ state: "working" });
}
const emitted = (text: string) => [["write", text], ["title", text], ["progress", false], ["status", { state: "working" }]];

for (const order of [[0, 1], [1, 0]]) test(`gates release in order ${order.join(",")} without bypass or resurrection`, () => {
  const { terminal, original, output } = memoryTerminal();
  const active = [false, false];
  const gates = active.map((_, index) => gateTerminal(terminal, () => active[index]!));
  emit(terminal, "hidden");
  gates[order[0]!]!.restore();
  emit(terminal, "still hidden");
  assert.deepEqual(output, []);
  active[order[1]!] = true;
  emit(terminal, "visible");
  assert.deepEqual(output, emitted("visible"));
  gates[order[1]!]!.restore();
  for (const name of Object.keys(original) as (keyof typeof original)[]) assert.equal(terminal[name], original[name], name);
  gates.forEach(gate => { gate.restore(); gate.resume(); });
  assert.deepEqual(output, emitted("visible"), "retired resume never replays state");
});

test("retired callbacks pass through without consulting foreground or recording old state", () => {
  const { terminal, original, output } = memoryTerminal();
  let foreground = false;
  const old = gateTerminal(terminal, () => { assert.equal(retired, false); return foreground; });
  let retired = false;
  const saved = { ...terminal };
  emit(terminal, "old state");
  old.restore(); retired = true;
  const current = gateTerminal(terminal, () => foreground);
  old.resume();
  assert.deepEqual(output, []);
  foreground = true;
  emit(terminal, "new state");
  output.length = 0;
  current.resume();
  assert.deepEqual(output, [["title", "new state"], ["status", { state: "working" }], ["progress", false]]);
  output.length = 0;
  saved.setTitle("retired callback");
  old.resume();
  assert.deepEqual(output, [["title", "retired callback"]]);
  current.restore();
  assert.equal(terminal.setTitle, original.setTitle);
});

test("a covered live gate cannot resume past its newer owner", () => {
  const { terminal, output } = memoryTerminal();
  const older = gateTerminal(terminal, () => true);
  terminal.setTitle("older"); output.length = 0;
  const newer = gateTerminal(terminal, () => false);
  older.resume();
  assert.deepEqual(output, []);
  newer.restore(); older.resume();
  assert.deepEqual(output, [["title", "older"]]);
  older.restore();
});

test("three gates compact retired predecessors across a fresh module instance", async () => {
  const { terminal, original, output } = memoryTerminal();
  const first = gateTerminal(terminal, () => false);
  const url = new URL("../src/terminal-owner.ts", import.meta.url); url.search = "independent-gate-copy";
  const other = await import(url.href) as typeof import("../src/terminal-owner.ts");
  const second = other.gateTerminal(terminal, () => false);
  const third = gateTerminal(terminal, () => true);
  first.restore(); second.restore();
  emit(terminal, "third");
  assert.deepEqual(output, emitted("third"));
  third.restore(); first.restore(); second.restore();
  for (const name of Object.keys(original) as (keyof typeof original)[]) assert.equal(terminal[name], original[name], name);
});

test("third-party wrappers before, between and after gates keep their reference and receiver", () => {
  for (const position of ["before", "between", "after"]) {
    const { terminal, original, output } = memoryTerminal();
    let calls = 0;
    let third!: Terminal["write"];
    const wrap = () => {
      const previous = terminal.write;
      terminal.write = third = function(this: Terminal, data: string) { assert.equal(this, terminal); calls++; previous.call(this, data); };
    };
    if (position === "before") wrap();
    const first = gateTerminal(terminal, () => false);
    if (position === "between") wrap();
    const second = gateTerminal(terminal, () => false);
    if (position === "after") wrap();
    first.restore(); second.restore();
    assert.equal(terminal.write, third, position);
    terminal.write("through retired chain");
    first.resume(); second.resume();
    assert.equal(calls, 1, position);
    assert.deepEqual(output, [["write", "through retired chain"]]);
    for (const name of ["setTitle", "setProgress", "setProgramStatus"] as const) assert.equal(terminal[name], original[name]);
    const fresh = gateTerminal(terminal, () => false);
    terminal.write("blocked");
    assert.equal(calls, 1);
    fresh.restore();
    assert.equal(terminal.write, third);
  }
});

test("disposing an older Main binding preserves the single newer child lease and gate", async () => {
  const { terminal, original, output } = memoryTerminal();
  terminal.drainInput = async () => {};
  const ui = {
    themeWatchCapability: "pi.theme-watch.file-version.v1",
    theme: { name: "named" }, getTheme: () => ({}), onTerminalInput: () => () => {},
    setTheme: () => ({ success: true }), getAllThemes: () => [],
  };
  const tui = { terminal, stop() {}, start() {}, requestRender() {} };
  const first = new TerminalOwner(tui as never, ui as never, () => "named");
  const second = new TerminalOwner(tui as never, ui as never, () => "named");
  try {
    await first.acquire();
    await assert.rejects(second.acquire(), /Another child view already owns the terminal/);
    first.restore();
    await second.acquire();
    first.dispose();
    emit(terminal, "new child owns output");
    assert.deepEqual(output, []);
    assert.equal(second.isMainForeground, false);
    second.restore();
    assert.equal(second.isMainForeground, true);
    assert.deepEqual(output, [["title", "new child owns output"], ["status", { state: "working" }], ["progress", false]]);
  } finally { first.dispose(); second.dispose(); }
  for (const name of Object.keys(original) as (keyof typeof original)[]) assert.equal(terminal[name], original[name]);
});

for (const release of ["abort", "return", "dispose"] as const) test(`a ${release} during the lazy SDK import cannot acquire or clear a newer owner`, async () => {
  const { terminal } = memoryTerminal();
  let drains = 0, stops = 0;
  terminal.drainInput = async () => { drains++; };
  const ui = { themeWatchCapability: "pi.theme-watch.file-version.v1", theme: { name: "named" }, getTheme: () => ({}), onTerminalInput: () => () => {},
    setTheme: () => ({ success: true }), getAllThemes: () => [] };
  const tui = { terminal, stop: () => { stops++; }, start() {}, requestRender() {} };
  const first = new TerminalOwner(tui as never, ui as never, () => "named");
  const second = new TerminalOwner(tui as never, ui as never, () => "named");
  const third = new TerminalOwner(tui as never, ui as never, () => "named");
  try {
    const abort = new AbortController();
    const old = assert.rejects(first.acquire(abort.signal), /aborted|abandoned/);
    if (release === "abort") { abort.abort(); first.restore(); }
    else if (release === "dispose") first.dispose();
    else first.restore();
    const current = second.acquire();
    await Promise.all([old, current]);
    assert.equal(drains, 1, "the retired attempt never drains input");
    assert.equal(stops, 1, "only the newer owner may stop Main");
    assert.equal(second.isMainForeground, false);
    await assert.rejects(third.acquire(), /Another child view already owns the terminal/);
    if (release === "dispose") await assert.rejects(first.acquire(), /Terminal owner is disposed/);
    second.restore();
    assert.equal(second.isMainForeground, true);
  } finally { first.dispose(); second.dispose(); third.dispose(); }
});

test("unknown or malformed gate metadata stays opaque", () => {
  for (const metadata of [{ version: 2 }, { version: 1 }, { version: 1, previous: "not a method", retired: () => true }]) {
    const { terminal, output } = memoryTerminal();
    const original = terminal.write;
    Object.defineProperty(original, Symbol.for("pi.session-runtime.terminal-gate.v1"), { value: metadata });
    const gate = gateTerminal(terminal, () => true);
    terminal.write("opaque");
    gate.restore();
    assert.equal(terminal.write, original);
    assert.deepEqual(output, [["write", "opaque"]]);
  }
});

test("restoring an opaque owner's captured retired method cannot reactivate its gate", () => {
  const { terminal, original, output } = memoryTerminal();
  const gate = gateTerminal(terminal, () => false);
  const captured = terminal.setTitle;
  terminal.setTitle = value => captured.call(terminal, value);
  gate.restore();
  terminal.setTitle = captured;
  terminal.setTitle("unwrapped by third party");
  gate.resume();
  assert.deepEqual(output, [["title", "unwrapped by third party"]]);
  gate.restore();
  assert.equal(terminal.setTitle, original.setTitle);
});

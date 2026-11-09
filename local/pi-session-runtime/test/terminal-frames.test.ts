import { requirePatchedHost } from "./patched-host.ts";
requirePatchedHost();

import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { deferTerminalFrames, TerminalOwner } from "../src/terminal-owner.ts";

const begin = "\x1b[?2026h", end = "\x1b[?2026l";

test("initialization forwards terminal negotiation but no synchronized frames", () => {
  const output: string[] = [];
  const terminal = { write(data: string) { output.push(data); } } as Terminal;
  const original = terminal.write;
  const gate = deferTerminalFrames(terminal);
  terminal.write("\x1b[?1049h\x1b[c");
  terminal.write(begin + "native footer" + end);
  terminal.write(begin + "CC frame not ready yet" + end);
  assert.equal(output.join(""), "\x1b[?1049h\x1b[c");
  gate.release();
  assert.equal(terminal.write, original);
  terminal.write(begin + "ready CC frame" + end);
  assert.equal(output.join(""), "\x1b[?1049h\x1b[c" + begin + "ready CC frame" + end);
});

test("fragmented delimiters and a release during an old frame never leak it", () => {
  const output: string[] = [];
  const terminal = { write(data: string) { output.push(data); } } as Terminal;
  const original = terminal.write;
  const gate = deferTerminalFrames(terminal);
  for (const char of "query" + begin + "native footer") terminal.write(char);
  gate.release();
  for (const char of end) terminal.write(char);
  assert.equal(output.join(""), "query");
  assert.equal(terminal.write, original);
  terminal.write(begin + "ready" + end);
  gate.dispose();
  assert.equal(output.join(""), "query" + begin + "ready" + end);
});

test("failed initialization drops pending bytes and restores the original writer", () => {
  const output: string[] = [];
  const terminal = { write(data: string) { output.push(data); } } as Terminal;
  const original = terminal.write;
  const gate = deferTerminalFrames(terminal);
  terminal.write(begin + "incomplete native frame");
  gate.dispose();
  assert.equal(terminal.write, original);
  terminal.write("cleanup");
  assert.equal(output.join(""), "cleanup");
});

test("a deadline can reveal initialization frames before any extension exposes its TUI", () => {
  const output: string[] = [];
  const terminal = { write(data: string) { output.push(data); } } as Terminal;
  const gate = deferTerminalFrames(terminal, true);
  const frames = begin + "native first frame" + end + begin + "latest diff" + end;
  for (const char of frames) terminal.write(char);
  assert.equal(output.length, 0);
  gate.release(true);
  assert.equal(output.join(""), frames);
  gate.release(true);
  assert.equal(output.join(""), frames, "never replay twice");
});

test("a cancelled terminal drain cannot stop Main or clear a newer lease when it completes late", async () => {
  let finishDrain!: () => void, startDrain!: () => void, drains = 0, stops = 0;
  const draining = new Promise<void>(resolve => { startDrain = resolve; });
  const terminal = {
    write() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    drainInput: () => ++drains === 1 ? new Promise<void>(resolve => { finishDrain = resolve; startDrain(); }) : Promise.resolve(),
  };
  const ui = {
    themeWatchCapability: "pi.theme-watch.file-version.v1",
    theme: { name: "named" }, getTheme: () => ({}), onTerminalInput: () => () => {},
    setTheme: () => ({ success: true }), getAllThemes: () => [],
  };
  const owner = new TerminalOwner({ terminal, stop: () => { stops++; }, start() {}, requestRender() {} } as never, ui as never, () => "named");
  try {
    const abort = new AbortController();
    const old = owner.acquire(abort.signal);
    await draining;
    abort.abort(); owner.restore();
    await owner.acquire();
    assert.equal(stops, 1);
    finishDrain();
    await assert.rejects(old);
    assert.equal(stops, 1);
    assert.equal(owner.isMainForeground, false, "late old drain cannot release the new child lease");
    owner.restore();
    assert.equal(owner.isMainForeground, true);
  } finally { owner.dispose(); }
});

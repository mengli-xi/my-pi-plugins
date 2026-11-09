import assert from "node:assert/strict";
import test from "node:test";
import { layoutProcessStrip, ProcessStrip } from "../../src/ui/strip.ts";
import type { ProcessSummary } from "../../src/domain/types.ts";

function process(id: string, name: string, state: ProcessSummary["state"], startedAt: string): ProcessSummary {
  return {
    id,
    name,
    kind: "process",
    state,
    commandPreview: "sleep 10",
    commandTruncated: false,
    cwd: "/tmp",
    startedAt,
    runtimeMs: 0,
    stdinOpen: true,
    continuation: { mode: "detached" },
    watches: { count: 0, keys: [], failedKeys: [] },
    logs: { revision: 0, earliestSequence: 0, nextSequence: 0, droppedBytes: 0, droppedLines: 0 },
  };
}

test("renders muted process names right-aligned without roles or status glyphs", () => {
  const records = [
    process("proc_b", "worker", "running", "2026-01-01T00:00:02.000Z"),
    process("proc_a", "api", "starting", "2026-01-01T00:00:01.000Z"),
    process("proc_c", "done", "succeeded", "2026-01-01T00:00:00.000Z"),
  ];
  const layout = layoutProcessStrip(records, false, 40);
  assert.equal(layout.line, "                ps · done · api · worker");
  assert.equal(layout.line.includes("process"), false);
  assert.equal(layout.line.includes("●"), false);
  assert.deepEqual(layout.hits.map((hit) => [hit.kind, hit.id]), [
    ["toggle", undefined],
    ["process", "proc_c"],
    ["process", "proc_a"],
    ["process", "proc_b"],
  ]);
});

test("right-aligned hit spans follow dim semantic process names", () => {
  const opened: Array<string | undefined> = [];
  let toggles = 0;
  const records = [process("proc_a", "api", "running", "2026-01-01T00:00:01.000Z")];
  const themeCalls: Array<[string, string]> = [];
  const host = {
    stripRecords: () => records,
    stripCollapsed: false,
    toggleStripCollapsed: () => { toggles += 1; },
  };
  const theme = {
    fg: (tone: string, text: string) => { themeCalls.push([tone, text]); return `<${tone}>${text}</${tone}>`; },
  };
  const strip = new ProcessStrip(host as never, (id) => opened.push(id), theme as never);

  const rendered = strip.render(20)[0]!;
  assert.ok(rendered.includes("<muted>            ps</muted><muted> · </muted>"));
  assert.ok(rendered.includes("\x1b[2m<customMessageLabel>api</customMessageLabel>\x1b[22m"));
  assert.equal(strip.handleClick(0, 12), true);
  assert.equal(toggles, 1);
  assert.equal(strip.handleClick(0, 17), true);
  assert.deepEqual(opened, ["proc_a"]);
});

test("uses equally dim blue, green, red and muted names for process states", () => {
  const records = [
    process("proc_run", "run", "running", "2026-01-01T00:00:01.000Z"),
    process("proc_ok", "ok", "succeeded", "2026-01-01T00:00:02.000Z"),
    process("proc_fail", "fail", "failed", "2026-01-01T00:00:03.000Z"),
    process("proc_stop", "stop", "stopped", "2026-01-01T00:00:04.000Z"),
  ];
  const calls: Array<[string, string]> = [];
  const host = { stripRecords: () => records, stripCollapsed: false, toggleStripCollapsed: () => {} };
  const theme = { fg: (tone: string, text: string) => { calls.push([tone, text]); return text; } };
  const strip = new ProcessStrip(host as never, () => {}, theme as never);
  const rendered = strip.render(80)[0]!;
  assert.match(rendered, /\x1b\[2mrun\x1b\[22m/);
  assert.match(rendered, /\x1b\[2mok\x1b\[22m/);
  assert.match(rendered, /\x1b\[2mfail\x1b\[22m/);
  assert.match(rendered, /\x1b\[2mstop\x1b\[22m/);
  assert.ok(calls.some(([tone, text]) => tone === "customMessageLabel" && text === "run"));
  assert.ok(calls.some(([tone, text]) => tone === "success" && text === "ok"));
  assert.ok(calls.some(([tone, text]) => tone === "error" && text === "fail"));
  assert.ok(calls.some(([tone, text]) => tone === "muted" && text === "stop"));
});

test("collapsed mode uses a right-aligned summary", () => {
  const layout = layoutProcessStrip([
    process("proc_a", "api", "running", "2026-01-01T00:00:01.000Z"),
    process("proc_b", "worker", "stopping", "2026-01-01T00:00:02.000Z"),
  ], true, 20);
  assert.equal(layout.line, "              ps · 2");
  assert.equal(layout.hits.length, 1);
  assert.equal(layout.hits[0]?.kind, "toggle");
  assert.deepEqual([layout.hits[0]?.start, layout.hits[0]?.end], [14, 16]);
});

test("uses overflow token instead of wrapping", () => {
  const layout = layoutProcessStrip([
    process("proc_a", "api", "running", "2026-01-01T00:00:01.000Z"),
    process("proc_b", "worker", "running", "2026-01-01T00:00:02.000Z"),
    process("proc_c", "watch", "running", "2026-01-01T00:00:03.000Z"),
  ], false, 14);
  assert.equal(layout.line.includes("\n"), false);
  assert.equal(layout.line, " ps · api · +2");
  assert.equal(layout.hits.at(-1)?.kind, "overflow");
});


test("fullscreen left presses reuse regular navigation without a second synthesized click", () => {
  const opened: Array<string | undefined> = [];
  let toggles = 0;
  const strip = new ProcessStrip({
    stripRecords: () => [process("proc_a", "api", "running", "2026-01-01T00:00:01.000Z")],
    stripCollapsed: false,
    toggleStripCollapsed: () => { toggles++; },
  } as never, (id) => opened.push(id));
  strip.render(20);
  const event = { type: "press" as const, button: "left" as const, x: 12, y: 0,
    screenX: 92, screenY: 30, width: 20, height: 1, shift: false, alt: false, ctrl: false };
  assert.deepEqual(strip.handleMouse(event), { handled: true, render: true });
  assert.equal(toggles, 1);
  assert.equal(strip.handleMouse({ ...event, type: "release" }), undefined);
  assert.equal(strip.handleMouse({ ...event, type: "click" }), undefined);
  assert.equal(toggles, 1);
  assert.deepEqual(strip.handleMouse({ ...event, x: 17 }), { handled: true, render: true });
  assert.deepEqual(opened, ["proc_a"]);
  for (const change of [{ button: "right" as const }, { type: "wheel" as const }, { x: 0 }, { y: 1 }]) {
    assert.equal(strip.handleMouse({ ...event, ...change }), undefined);
  }
  assert.deepEqual(opened, ["proc_a"]);
});

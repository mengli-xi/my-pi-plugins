import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { ProcessSummary } from "../../src/domain/types.ts";
import { ProcessManagerEditor } from "../../src/ui/manager.ts";

function record(id: string, name: string, state: ProcessSummary["state"] = "running"): ProcessSummary {
  const terminal = state === "succeeded" || state === "failed" || state === "stopped" || state === "killed" || state === "crashed";
  return {
    id,
    name,
    kind: "process",
    commandPreview: `node ${name}.js`,
    commandTruncated: false,
    cwd: "/tmp",
    state,
    pid: 100,
    pgid: 100,
    startedAt: "2026-08-12T00:00:00.000Z",
    endedAt: state === "running" ? undefined : "2026-08-12T00:00:05.000Z",
    runtimeMs: 5_000,
    stdinOpen: state === "running",
    logs: { revision: 1, earliestSequence: 1, nextSequence: 2, droppedBytes: 0, droppedLines: 0 },
    watches: { count: 0, keys: [], failedKeys: [] },
    continuation: { mode: "detached" },
    ...(terminal ? { terminal: { outcome: state, exitCode: state === "succeeded" ? 0 : null, signal: null } } : {}),
  };
}

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};
const editorTheme = { borderColor: () => "", selectList: {}, editor: {} };

function createEditor(options: {
  directLogs?: boolean;
  initialProcessId?: string;
  logs?: () => Promise<unknown>;
  watches?: readonly { processId: string; key: string; generation: number; matchedCount: number; suppressedCount: number; firstSequence: number; lastSequence: number; lastObservedAt: string }[];
} = {}) {
  let renders = 0;
  let closed = 0;
  const stopped: string[] = [];
  let cleared = 0;
  const records = [record("proc_1", "api"), record("proc_2", "done", "succeeded")];
  const host = {
    records: () => records,
    summary: (id: string) => records.find((entry) => entry.id === id),
    command: (id: string) => `node ${records.find((entry) => entry.id === id)?.name}.js --full`,
    notificationSnapshot: () => ({ version: 1, revision: 0, watches: options.watches ?? [] }),
    logs: options.logs ?? (async () => ({ process: records[0]!, lines: [{ sequence: 1, stream: "stdout", text: "ready" }], revision: 1, nextCursor: undefined, truncated: false, droppedBytes: 0, droppedLines: 0 })),
    stop: async ({ target }: { target: string }) => { stopped.push(target); return { process: records[0]!, changed: true }; },
    clear: async () => { cleared += 1; return { removed: [records[1]!], failures: [] }; },
  };
  const terminalWrites: string[] = [];
  const tui = {
    terminal: { rows: 24, columns: 80, write: (data: string) => terminalWrites.push(data) },
    requestRender: () => { renders += 1; },
    mode: "tui",
  };
  const keybindings = { matches: () => false, getKeybindings: () => [] };
  const editor = new ProcessManagerEditor(tui as never, editorTheme as never, keybindings as never, {
    host: host as never,
    theme: theme as never,
    ...(options.initialProcessId ? { initialProcessId: options.initialProcessId } : {}),
    ...(options.directLogs ? { directLogs: true } : {}),
    onClose: () => { closed += 1; },
  });
  editor.focused = true;
  return { editor, stopped, terminalWrites, get cleared() { return cleared; }, get renders() { return renders; }, get closed() { return closed; } };
}

test("manager navigates list and returns from logs before closing", async () => {
  const state = createEditor();
  assert.equal(state.editor.selectedId, "proc_1");
  state.editor.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.editor.view, "logs");
  const detail = state.editor.render(80).join("\n");
  assert.match(detail, /Scripts: node api\.js --full/);
  assert.match(detail, /ready/);
  state.editor.handleInput("\x1b");
  assert.equal(state.editor.view, "list");
  assert.equal(state.closed, 0);
  state.editor.handleInput("\x1b");
  assert.equal(state.closed, 1);
});

test("manager renders broker watch aggregates as metadata without changing log counts", async () => {
  const state = createEditor({ watches: [{ processId: "proc_1", key: "progress", generation: 2, matchedCount: 42, suppressedCount: 3, firstSequence: 1, lastSequence: 45, lastObservedAt: "2026-08-12T00:00:05.000Z" }] });
  state.editor.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  const detail = state.editor.render(80).join("\n");
  assert.match(detail, /Watch progress · 42 matched · 3 suppressed/);
  assert.match(detail, /1 lines/);
  state.editor.dispose();
});

test("readable logs keep detail metadata to watch aggregates", async () => {
  const state = createEditor({ watches: [{ processId: "proc_1", key: "progress", generation: 2, matchedCount: 42, suppressedCount: 3, firstSequence: 1, lastSequence: 45, lastObservedAt: "2026-08-12T00:00:05.000Z" }] });
  state.editor.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  const detail = state.editor.render(80).join("\n");
  assert.match(detail, /Watch progress · 42 matched · 3 suppressed/, "the watch aggregate is the metadata a readable detail keeps");
  assert.match(detail, /ready/);
  assert.match(detail, /1 lines/);
  for (const diagnostic of [/Cause:/, /Exit:/, /Started /, /PID /, /Logs unavailable/]) {
    assert.doesNotMatch(detail, diagnostic, `${diagnostic} belongs to the unreadable-logs path only`);
  }
  state.editor.dispose();
});

test("a terminal record with readable logs carries no metadata at all", async () => {
  // proc_2 succeeded with exit code 0, so the failure path would print Exit.
  const state = createEditor({ initialProcessId: "proc_2", directLogs: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.editor.view, "logs");
  const detail = state.editor.render(80).join("\n");
  assert.match(detail, /Scripts: node done\.js --full/);
  assert.match(detail, /ready/);
  for (const diagnostic of [/Cause:/, /Exit:/, /Started /, /PID /, /Watch /, /Logs unavailable/]) {
    assert.doesNotMatch(detail, diagnostic, `${diagnostic} belongs to the unreadable-logs path only`);
  }
  state.editor.dispose();
});

test("strip-direct logs closes the manager on the first escape", async () => {
  const state = createEditor({ initialProcessId: "proc_1", directLogs: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.editor.view, "logs");
  state.editor.handleInput("\x1b");
  assert.equal(state.closed, 1);
});

test("strip-direct logs closes while loading and does not revive after completion", async () => {
  let resolveLogs!: (value: unknown) => void;
  const logs = () => new Promise<unknown>((resolve) => { resolveLogs = resolve; });
  const state = createEditor({ initialProcessId: "proc_1", directLogs: true, logs });
  assert.equal(state.editor.view, "logs");
  const rendersBeforeClose = state.renders;

  state.editor.handleInput("\x1b");
  assert.equal(state.closed, 1);
  resolveLogs({ process: record("proc_1", "api"), lines: [], logRevision: 1, truncation: { truncated: false, droppedBytes: 0, droppedLines: 0 } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.closed, 1);
  assert.equal(state.renders, rendersBeforeClose);
});

test("manager uses the shared open-panel title rule without vertical borders", () => {
  const state = createEditor();
  for (const width of [20, 40, 80]) {
    const lines = state.editor.render(width);
    assert.match(lines[0] ?? "", /^── Processes ─+/);
    assert.equal(lines.some((line) => line.includes("╭") || line.includes("╰")), false);
    assert.equal(lines[0]?.includes("…"), false, `top border at ${width} columns`);
  }
	assert.match(state.editor.render(80).join("\n"), /done · success · 5s/);
  state.editor.dispose();
});

/** A disposed Host that still answers every local read, as the real one does. */
function disposedHost(options: {
  records: ProcessSummary[];
  cleanupError?: Error;
  runtimeContainmentComplete?: boolean;
  command?: string;
}) {
  const state = {
    disposed: true,
    cleanupError: options.cleanupError,
    runtimeContainmentComplete: options.runtimeContainmentComplete === true,
  };
  return {
    ...state,
    // The same rule ProcessHost.containment applies, so the manager is exercised
    // against the states the Host can actually publish.
    get containment(): string {
      if (!this.disposed) return "active";
      if (this.cleanupError) return "failed";
      return this.runtimeContainmentComplete ? "contained" : "pending";
    },
    records: () => options.records,
    summary: (id: string) => options.records.find((entry) => entry.id === id),
    command: () => options.command ?? "sleep 40",
    notificationSnapshot: () => ({ version: 1, revision: 0, watches: [] }),
    logs: async () => { throw new Error("[process/supervisor-unavailable] process host is disposed"); },
    stop: async () => { throw new Error("contained runtimes cannot stop processes"); },
  };
}

function editorFor(host: unknown) {
  const tui = { terminal: { rows: 24, columns: 80, write: () => {} }, requestRender: () => {}, mode: "tui" };
  const editor = new ProcessManagerEditor(tui as never, editorTheme as never, { matches: () => false, getKeybindings: () => [] } as never, {
    host: host as never,
    theme: theme as never,
    onClose: () => {},
  });
  editor.focused = true;
  return editor;
}

const containedRecord: ProcessSummary = {
  ...record("proc_c", "fault-recovery", "crashed"),
  terminal: { outcome: "crashed", exitCode: null, signal: null, errorCode: "runtime-contained", messagePreview: "supervisor channel lost; runtime containment stopped this process group" },
};

// One short-named record leaves the status column enough width at 80 columns,
// so the list spells the cause instead of falling back to the short status.
test("manager marks a contained runtime and shows the terminal cause of its records", () => {
  const editor = editorFor(disposedHost({ records: [containedRecord], runtimeContainmentComplete: true }));
  const rendered = editor.render(80).join("\n");
  assert.match(rendered, /^── Processes · runtime contained ─+/);
  assert.match(rendered, /fault-recovery · crashed · runtime-contained/);
  assert.doesNotMatch(rendered, /\brunning\b/);
  assert.match(rendered, /Runtime contained; the next process call starts a new runtime\./);
  editor.dispose();
});

test("manager reports an incomplete cleanup instead of claiming the runtime is contained", () => {
  const editor = editorFor(disposedHost({
    records: [record("proc_stuck", "still-alive")],
    cleanupError: new Error("[process/cleanup-incomplete] 1 process groups remain after cleanup"),
  }));
  const rendered = editor.render(80).join("\n");
  assert.match(rendered, /^── Processes · runtime cleanup incomplete ─+/);
  assert.match(rendered, /still-alive · running/, "an unresolved group is still live and must say so");
  assert.match(rendered, /1 process group unresolved; process calls rejected until cleanup resolves\./);
  assert.doesNotMatch(rendered, /runtime contained/);
  assert.doesNotMatch(rendered, /the next process call starts a new runtime/);
  editor.dispose();
});

test("manager reports containment that has not settled yet as in progress", () => {
  const editor = editorFor(disposedHost({ records: [record("proc_pending", "settling")] }));
  const rendered = editor.render(80).join("\n");
  assert.match(rendered, /^── Processes · containment in progress ─+/);
  assert.match(rendered, /Runtime containment in progress; these records are not final yet\./);
  assert.doesNotMatch(rendered, /runtime contained/);
  editor.dispose();
});

test("an open manager follows the runtime from pending containment to its outcome", () => {
  const host = disposedHost({ records: [record("proc_pending", "settling")] });
  const editor = editorFor(host);
  assert.match(editor.render(80)[0] ?? "", /Processes · containment in progress/);

  host.runtimeContainmentComplete = true;
  editor.refresh();
  const contained = editor.render(80).join("\n");
  assert.match(contained, /^── Processes · runtime contained ─+/);
  assert.match(contained, /Runtime contained; the next process call starts a new runtime\./);

  host.cleanupError = new Error("[process/cleanup-incomplete] 1 process groups remain after cleanup");
  editor.refresh();
  const failed = editor.render(80).join("\n");
  assert.match(failed, /^── Processes · runtime cleanup incomplete ─+/);
  assert.doesNotMatch(failed, /the next process call starts a new runtime/);
  editor.dispose();
});

test("detail of a contained process shows known metadata and why logs are unavailable", async () => {
  const editor = editorFor(disposedHost({
    records: [containedRecord],
    runtimeContainmentComplete: true,
    command: "printf 'PQ008\\n' >> /tmp/marker; sleep 120",
  }));
  editor.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(editor.view, "logs");
  const detail = editor.render(80).join("\n");
  assert.match(detail, /fault-recovery · process/, "the detail title still identifies the process");
  assert.match(detail, /Status: crashed · runtime-contained/);
  assert.match(detail, /Scripts: printf 'PQ008\\n' >> \/tmp\/marker; sleep 120/);
  assert.match(detail, /Cause: runtime-contained · supervisor channel lost/);
  assert.match(detail, /Started 2026-08-12T00:00:00\.000Z · ended 2026-08-12T00:00:05\.000Z/);
  assert.match(detail, /PID 100 · PGID 100/);
  assert.match(detail, /Logs unavailable: runtime contained; the supervisor is gone\./);
  assert.doesNotMatch(detail, /supervisor-unavailable/, "a failed log request must not be the whole detail");
  editor.dispose();
});

test("manager forwards its mouse boundary through the domain adapter", () => {
  const state = createEditor();
  state.editor.render(80);
  state.editor.setScreenOrigin(8, 0);
  assert.equal(state.editor.wantsMouse, true);
  assert.deepEqual(state.editor.handleMouse({ type: "press", button: "left", x: 1, y: -7,
    screenX: 1, screenY: 1, width: 80, height: 10, shift: false, alt: false, ctrl: false }), { handled: true, render: true });
  assert.equal(state.closed, 1);
  assert.deepEqual(state.terminalWrites, [], "Pi owns terminal mouse tracking");
});

test("manager confirms stop from the process detail", async () => {
  const state = createEditor();
  state.editor.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  state.editor.handleInput("x");
  assert.equal(state.editor.confirmation, "stop");
  state.editor.handleInput("y");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.stopped, ["proc_1"]);
  state.editor.dispose();
});

/**
 * One list holding everything that competes for the same three columns: a long
 * ASCII name, a CJK name, several records and an hours-long runtime. The status
 * column is shared, so the widest cause in the set decides whether any row can
 * spell its cause — a single-record fixture never exercises that.
 */
const crowdedRecords: ProcessSummary[] = [
  {
    ...record("proc_cjk", "故障恢复服务", "crashed"),
    terminal: { outcome: "crashed", exitCode: null, signal: null, errorCode: "runtime-contained", messagePreview: "supervisor channel lost; runtime containment stopped this process group" },
  },
  {
    ...record("proc_long", "a-very-long-companion-process-name", "crashed"),
    runtimeMs: 3_661_000,
    terminal: { outcome: "crashed", exitCode: null, signal: null, errorCode: "supervisor-unavailable", messagePreview: "the supervisor exited before this process settled" },
  },
  {
    ...record("proc_worker", "worker", "crashed"),
    runtimeMs: 59_000,
    terminal: { outcome: "crashed", exitCode: null, signal: null, errorCode: "runtime-contained", messagePreview: "supervisor channel lost; runtime containment stopped this process group" },
  },
];

const CROWDED_WIDTHS = [39, 54, 55, 56, 60, 63, 80, 130];

function crowdedEditor(): ReturnType<typeof editorFor> {
  return editorFor(disposedHost({ records: crowdedRecords, runtimeContainmentComplete: true }));
}

/** The selector item rows, located from the `(x/y)` position line below them. */
function listRows(lines: readonly string[]): string[] {
  const position = lines.findIndex((line) => /^\s+\(\d+\/\d+\)$/.test(line));
  assert.ok(position > 0, `no selector position row in ${JSON.stringify(lines)}`);
  const total = Number(/\/(\d+)\)/.exec(lines[position]!)![1]);
  const rows: string[] = [];
  for (let index = position - 1; index >= 0 && rows.length < total; index--) {
    const line = lines[index]!;
    if (line.trim() !== "") rows.push(line);
  }
  return rows.reverse();
}

/**
 * The status cell of a list row. The row is `name · status · runtime    command`
 * and only the status may itself contain ` · `, so the cell is what sits between
 * the first and the last separator.
 */
function statusCell(row: string): string {
  const first = row.indexOf(" · ");
  const last = row.lastIndexOf(" · ");
  assert.ok(first >= 0 && last > first, `row has no status column: ${JSON.stringify(row)}`);
  return row.slice(first + 3, last).trimEnd();
}

const FULL_STATUSES = ["crashed · runtime-contained", "crashed · supervisor-unavailable"];

/** True when the shared column spelled the cause; asserts it was never clipped. */
function spellsCause(lines: readonly string[], width: number): boolean {
  const rows = listRows(lines);
  assert.equal(rows.length, crowdedRecords.length, `every record needs a row at ${width} columns`);
  const spelled = rows.map((row) => {
    const status = statusCell(row);
    assert.ok(
      status === "crashed" || FULL_STATUSES.includes(status),
      `status clipped at ${width} columns: ${JSON.stringify(status)} in ${JSON.stringify(row)}`,
    );
    return status !== "crashed";
  });
  assert.ok(
    spelled.every((value) => value === spelled[0]),
    `one shared column cannot spell the cause for some rows only at ${width}: ${JSON.stringify(rows)}`,
  );
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `line wider than the panel at ${width}: ${JSON.stringify(line)}`);
  }
  return spelled[0]!;
}

test("the list never clips a status, whatever the record set does to the columns", () => {
  const editor = crowdedEditor();
  for (const width of CROWDED_WIDTHS) {
    const lines = editor.render(width);
    spellsCause(lines, width);
    const rows = listRows(lines);
    // Name and command survive the allocation the status column takes part in.
    for (const [index, prefix] of [[0, "故障"], [1, "a-ver"], [2, "worker"]] as const) {
      assert.match(rows[index]!, new RegExp(prefix), `name ${prefix} missing at ${width} columns`);
      assert.match(rows[index]!, /node/, `command missing at ${width} columns`);
    }
  }
  editor.dispose();
});

test("the cause appears only from the width that actually fits it", () => {
  const editor = crowdedEditor();
  let transition: number | undefined;
  for (let width = 30; width <= 130; width++) {
    const spelled = spellsCause(editor.render(width), width);
    if (spelled && transition === undefined) transition = width;
    if (transition !== undefined) {
      assert.ok(spelled, `the cause disappeared again at ${width} columns after ${transition}`);
    }
  }
  assert.ok(transition !== undefined, "a wide enough panel must spell the cause");
  assert.ok(transition > 39, `39 columns cannot hold a cause, but the list spelled one at ${transition}`);
  const narrow = listRows(editor.render(transition - 1));
  assert.ok(narrow.every((row) => statusCell(row) === "crashed"), "one column short of fitting, every row keeps the intact short status");
  const wide = listRows(editor.render(transition));
  assert.ok(wide.every((row) => FULL_STATUSES.includes(statusCell(row))), "the first fitting width spells every cause");
  editor.dispose();
});

test("39 columns keep the short status intact next to a name and a command", () => {
  const editor = crowdedEditor();
  const lines = editor.render(39);
  const joined = lines.join("\n");
  assert.doesNotMatch(joined, /crash\S*…/, "the outcome must never be the thing that gets clipped");
  assert.doesNotMatch(joined, /runtime-contained|supervisor-unavailable/, "39 columns cannot spell a cause");
  for (const row of listRows(lines)) assert.equal(statusCell(row), "crashed");
  editor.dispose();
});

test("an open list follows a resize in both directions", () => {
  const editor = crowdedEditor();
  assert.equal(spellsCause(editor.render(130), 130), true);
  assert.equal(spellsCause(editor.render(39), 39), false);
  assert.equal(spellsCause(editor.render(130), 130), true, "a widened panel spells the cause again");
  editor.dispose();
});

test("the detail carries the whole terminal cause at every width", async () => {
  const editor = crowdedEditor();
  editor.render(80);
  editor.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(editor.view, "logs");
  for (const width of CROWDED_WIDTHS) {
    const detail = editor.render(width);
    const joined = detail.join("\n");
    assert.match(joined, /Status: crashed · runtime-contained/, `the detail traded the cause for width at ${width}`);
    assert.match(joined, /Cause: runtime-contained/, `no cause line at ${width}`);
    for (const line of detail) {
      assert.ok(visibleWidth(line) <= width, `detail line wider than the panel at ${width}: ${JSON.stringify(line)}`);
    }
  }
  editor.dispose();
});

test("statuses without a terminal cause read the same at every width", () => {
  const host = disposedHost({
    records: [
      { ...record("proc_f", "build", "failed"), terminal: { outcome: "failed", exitCode: 7, signal: null } },
      record("proc_s", "done", "succeeded"),
      record("proc_r", "api"),
    ],
  });
  host.disposed = false;
  const editor = editorFor(host);
  for (const width of CROWDED_WIDTHS) {
    const rows = listRows(editor.render(width));
    for (const [index, status] of [[0, "exit 7"], [1, "running"], [2, "success"]] as const) {
      assert.equal(statusCell(rows[index]!), status, `${status} at ${width} columns`);
    }
  }
  editor.dispose();
});

test("a name, ID or command query finds the same record at every width", () => {
  for (const [query, expected] of [
    ["companion", "proc_long"],
    ["proc_cjk", "proc_cjk"],
    ["故障", "proc_cjk"],
    ["worker.js", "proc_worker"],
  ] as const) {
    const found: Array<string | undefined> = [];
    for (const width of [39, 130]) {
      const editor = crowdedEditor();
      editor.render(width);
      for (const character of query) editor.handleInput(character);
      const lines = editor.render(width);
      assert.match(lines.join("\n"), /\(1\/1\)/, `'${query}' matched ${listRows(lines).length} records at ${width} columns`);
      found.push(editor.selectedId);
      editor.dispose();
    }
    assert.deepEqual(found, [expected, expected], `'${query}' must find the same record at 39 and 130 columns`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { sendInput } from "./native-mouse.ts";
import { ActivityTimelineStore } from "../src/activity-timeline.ts";
import { itemTitle } from "../src/overlay.ts";
import { formatCurrentActivity } from "../src/semantics.ts";
import type { ToolGroupSnapshot } from "../src/types.ts";

function item(
  presentation: ToolGroupSnapshot["presentation"],
  toolName: string,
  args: unknown,
): ToolGroupSnapshot {
  return {
    id: "group-1",
    anchorToolCallId: "call-1",
    presentation,
    status: "completed",
    createdAt: 1_000,
    updatedAt: 2_000,
    failureCount: 0,
    runningCount: 0,
    activities: [{
      id: "call-1",
      groupId: "group-1",
      toolName,
      args,
      status: "completed",
      startedAt: 1_000,
      endedAt: 2_000,
    }],
  };
}

test("formats presentation-aware overlay titles", () => {
  assert.equal(
    itemTitle(item("web-search", "web_search", { query: "weather" })),
    'Web Search("weather")',
  );
  assert.equal(
    itemTitle(item("web-fetch", "web_fetch", { url: "https://example.com" })),
    'Web Fetch("https://example.com")',
  );
  assert.equal(
    itemTitle(item("single-file-edit", "edit", { path: "src/a.ts" })),
    "Edit(src/a.ts)",
  );
  assert.equal(
    itemTitle(item("single-file-edit", "edit", { path: "/tmp/project/src/a.ts" }), "/tmp/project"),
    "Edit(src/a.ts)",
  );
  assert.equal(
    itemTitle(item("single-file-edit", "edit", { path: "/etc/hosts" }), "/tmp/project"),
    "Edit(/etc/hosts)",
  );
  assert.equal(
    itemTitle(item("question", "ask_user_question", {})),
    "Questionnaire",
  );
  assert.equal(
    itemTitle(item("grouped", "bash", {})),
    "Ran 1 shell command",
  );
});

import { createToolGroupOverlayClass } from "../src/overlay.ts";
import { DEFAULT_DIFF, DEFAULT_OVERLAY } from "../src/config.ts";
import {
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { SelectableCollapsiblePanel } from "pi-li-uikit/selectable-collapsible-panel";

const ToolGroupOverlay = createToolGroupOverlayClass(SelectableCollapsiblePanel);
initTheme("dark");

/** Renders without ANSI so line content is directly assertable. */
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

function activity(id: string, toolName: string, resultLines: number) {
  return {
    id,
    groupId: "group-1",
    toolName,
    args: { path: `src/${toolName}.ts` },
    status: "completed" as const,
    startedAt: 0,
    endedAt: 120,
    result: {
      text: Array.from({ length: resultLines }, (_, i) => `line ${i}`).join("\n"),
      truncated: false,
      isError: false,
    },
  };
}

function multiCallGroup(): ToolGroupSnapshot {
  return {
    id: "group-1",
    anchorToolCallId: "call-1",
    presentation: "grouped",
    status: "completed",
    createdAt: 0,
    updatedAt: 900,
    failureCount: 0,
    runningCount: 0,
    activities: [
      activity("call-1", "read", 12),
      activity("call-2", "bash", 12),
      activity("call-3", "grep", 12),
    ],
  };
}

function overlay(
  rows = 24,
  group: ToolGroupSnapshot = multiCallGroup(),
) {
  const tui = {
    terminal: { rows, columns: 70, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  return new ToolGroupOverlay({
    tui,
    theme: plainTheme,
    group,
    maxResultChars: 5_000,
    diffColors: DEFAULT_DIFF,
    formatActivity: formatCurrentActivity,
    overlay: DEFAULT_OVERLAY,
    placement: { anchor: "top", marginX: 0 },
    onClose: () => {},
  });
}

function activityOverlay(rows = 80) {
  let now = 0;
  const timeline = new ActivityTimelineStore({
    clock: {
      now: () => now,
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    },
    isManagedTool: () => true,
  });
  timeline.observeAssistant({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "**inspect** the current state" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/read.ts" } },
      { type: "thinking", thinking: "Now compare the output" },
      { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "git diff" } },
    ],
  } as never, true, now);
  now = 1_000;
  const phase = timeline.list()[0]!;
  const group = multiCallGroup();
  const activities = new Map(group.activities.map((activity) => [activity.id, activity]));
  activities.set("call-2", {
    ...group.activities[1]!,
    args: { command: "git diff" },
  });
  const tui = {
    terminal: { rows, columns: 80, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  return new ToolGroupOverlay({
    tui,
    theme: plainTheme,
    phase,
    resolveActivity: (id: string) => activities.get(id),
    maxResultChars: 5_000,
    diffColors: DEFAULT_DIFF,
    formatActivity: formatCurrentActivity,
    overlay: DEFAULT_OVERLAY,
    placement: { anchor: "top", marginX: 0 },
    onClose: () => {},
  });
}

/**
 * A full click for a screen row: press then release, as a terminal sends it.
 * Folding resolves on the release, so that a drag starting on a marker row
 * selects text instead of folding.
 */
const click = (row: number, col = 3) =>
  `\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`;

/** Screen row of a rendered line, given the overlay starts at screen row 0. */
function rowOf(rendered: string[], match: string): number {
  const index = rendered.findIndex((line) => line.includes(match));
  assert.ok(index >= 0, `no line matching ${match} in:\n${rendered.join("\n")}`);
  return index;
}

const strip = (line: string) =>
  line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("Activity transcript interleaves folded thinking and tool calls", () => {
  const view = activityOverlay();
  const folded = view.render(80).map(strip);
  assert.match(folded[0] ?? "", /Activity transcript/u);
  const summaries = folded.filter((line) => /▸ (Thinking|Read|Ran)/u.test(line));
  assert.deepEqual(
    summaries.map((line) => line.trim().replace(/^→\s*/u, "")),
    [
      "▸ Thinking",
      "▸ Read src/read.ts 1/2",
      "▸ Thinking",
      "▸ Ran git diff 2/2",
    ],
  );
  assert.ok(!folded.some((line) => line.includes("inspect the current state")));
  const dividers = folded.filter((line) => /^\s+─+\s+$/u.test(line));
  assert.equal(dividers.length, 3, "four Activity items have exactly three dividers");
  const lastSummary = rowOf(folded, "▸ Ran git diff");
  assert.ok(!/^\s+─+\s+$/u.test(folded[lastSummary + 1] ?? ""), "the final item has no trailing divider");

  sendInput(view, "\r");
  const expandedThinking = view.render(80).map(strip);
  assert.ok(expandedThinking.some((line) => line.includes("inspect the current state")));
  assert.ok(!expandedThinking.some((line) => line.includes("Arguments")));

  sendInput(view, "\x1b[B");
  sendInput(view, "\r");
  const expandedTool = view.render(80).map(strip);
  assert.ok(expandedTool.some((line) => line.includes("Arguments")));
  assert.ok(expandedTool.some((line) => line.includes("src/read.ts")));
  assert.match(expandedTool.at(-1) ?? "", /↑↓ select.*Enter.*Esc close/u);
});

test("diff continuations hang beneath the complete maximum gutter", () => {
  const editGroup: ToolGroupSnapshot = {
    id: "edit-group",
    anchorToolCallId: "edit-1",
    presentation: "single-file-edit",
    status: "completed",
    createdAt: 0,
    updatedAt: 1,
    failureCount: 0,
    runningCount: 0,
    activities: [{
      id: "edit-1",
      groupId: "edit-group",
      toolName: "edit",
      args: { path: "src/long.ts" },
      status: "completed",
      startedAt: 0,
      endedAt: 1,
      result: {
        text: "edited",
        truncated: false,
        isError: false,
        details: {
          diff: "+250 abcdefghijklmnopqrstuvwxyz",
        },
      },
    }],
  };

  const view = overlay(24, editGroup);
  view.render(30);
  sendInput(view, "\r");
  const rendered = view.render(30).map(strip);
  const first = rendered.find((line) => line.includes("+250"));
  assert.ok(first, `no numbered diff row in:\n${rendered.join("\n")}`);
  const firstIndex = rendered.indexOf(first!);
  const continuation = rendered[firstIndex + 1] ?? "";
  const numberedColumn = first!.indexOf("+250");
  const continuationColumn = continuation.indexOf("rstuvwxyz");
  assert.equal(continuationColumn - numberedColumn, 5);
  assert.ok(visibleWidth(continuation) <= 30);
});

test("running Activity tools use the injected epoch clock for elapsed time", () => {
  const timeline = new ActivityTimelineStore({ isManagedTool: () => true });
  timeline.observeAssistant({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "running-call",
      name: "bash",
      arguments: { command: "sleep 5" },
    }],
    timestamp: 1_000,
  } as never, true, 1);
  const phase = timeline.list()[0]!;
  const running = {
    id: "running-call",
    groupId: "running-group",
    toolName: "bash",
    args: { command: "sleep 5" },
    status: "running" as const,
    startedAt: 10_000,
  };
  const tui = {
    terminal: { rows: 24, columns: 80, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  const view = new ToolGroupOverlay({
    tui,
    theme: plainTheme,
    phase,
    resolveActivity: () => running,
    maxResultChars: 5_000,
    diffColors: DEFAULT_DIFF,
    formatActivity: formatCurrentActivity,
    now: () => 12_500,
    overlay: DEFAULT_OVERLAY,
    placement: { anchor: "top", marginX: 0 },
    onClose: () => {},
  });

  assert.match(view.render(80).map(strip).join("\n"), /✳ 2\.5s/u);
});

test("running and truncated overlay diffs keep the native wrapping path", async (t) => {
  for (const scenario of ["running", "truncated"] as const) {
    await t.test(scenario, () => {
      const base: ToolGroupSnapshot = {
        id: `edit-${scenario}`,
        anchorToolCallId: `edit-${scenario}`,
        presentation: "single-file-edit",
        status: scenario === "running" ? "collecting" : "completed",
        createdAt: 0,
        updatedAt: 1,
        failureCount: 0,
        runningCount: scenario === "running" ? 1 : 0,
        activities: [{
          id: `edit-${scenario}`,
          groupId: `edit-${scenario}`,
          toolName: "edit",
          args: { path: "src/long.ts" },
          status: scenario === "running" ? "running" : "completed",
          startedAt: 0,
          endedAt: scenario === "running" ? undefined : 1,
          result: {
            text: "edited",
            truncated: scenario === "truncated",
            isError: false,
            details: { diff: "+250 abcdefghijklmnopqrstuvwxyz" },
          },
        }],
      };
      const view = overlay(24, base);
      view.render(30);
      sendInput(view, "\r");
      const rendered = view.render(30).map(strip);
      const firstIndex = rendered.findIndex((line) => line.includes("+250"));
      assert.ok(firstIndex >= 0, `no diff in:\n${rendered.join("\n")}`);
      const first = rendered[firstIndex] ?? "";
      const continuation = rendered[firstIndex + 1] ?? "";
      const contentColumn = first.indexOf("+250");
      assert.equal(
        continuation.indexOf("abcdefghijklmnopqrstuv") - contentColumn,
        0,
        `unexpected hanging indent in:\n${rendered.join("\n")}`,
      );
      if (scenario === "truncated") {
        assert.ok(rendered.some((line) => line.includes("Diff was truncated")));
      }
    });
  }
});

test("opens with every call folded using UIKit's bounded two-column rows", () => {
  const rendered = overlay().render(70).map(strip);
  assert.ok(rendered.some((line) => line.includes("▸ Read src/read.ts 1/3")));
  assert.ok(rendered.some((line) => line.includes("▸ Run bash 2/3")));
  assert.ok(rendered.some((line) => line.includes("✓ 120ms")));
  assert.ok(!rendered.some((line) => line.includes("Arguments")));
  assert.ok(!rendered.some((line) => line.includes("▌")), "the panel body does not draw a second frame");
  const first = rowOf(rendered, "▸ Read src/read.ts");
  const second = rowOf(rendered, "▸ Run bash");
  assert.equal(second - first, 5, "four-row cards are separated by one divider row");
  assert.match(rendered[second - 1] ?? "", /^\s+─+\s+(?:█)?$/u);
});

test("a failed bash card matches the compact command, output, status form", () => {
  const group: ToolGroupSnapshot = {
    id: "bash-failed",
    anchorToolCallId: "bash-1",
    presentation: "grouped",
    status: "failed",
    createdAt: 1_000,
    updatedAt: 1_000,
    failureCount: 1,
    runningCount: 0,
    activities: [{
      id: "bash-1",
      groupId: "bash-failed",
      toolName: "bash",
      args: { command: "ps -p 46406 -o pid,etime,stat,command" },
      status: "failed",
      startedAt: 1_000,
      endedAt: 1_000,
      result: {
        text: "zsh:1: operation not permitted: ps\nCommand exited with code 127",
        truncated: false,
        isError: true,
      },
    }],
  };
  const rendered = overlay(24, group).render(80).map(strip);
  const card = rendered.filter((line) =>
    line.includes("Ran ps ") || line.includes("operation not permitted") || line.includes("✗")
  );
  assert.equal(card.length, 3);
  assert.ok(card[0]!.includes("▸ Ran ps -p 46406 -o pid,etime,stat,command"));
  assert.ok(card[1]!.includes("  zsh:1: operation not permitted: ps"));
  assert.ok(card[2]!.includes("  ✗ (127) 0ms"));
});

test("up and down select tool call items", () => {
  const view = overlay();
  const selected = () => view.render(70).map(strip).find((line) => line.includes("→"));
  assert.match(selected()!, /→ ▸ Read src\/read\.ts/u);

  sendInput(view, "\x1b[B"); // down
  assert.match(selected()!, /→ ▸ Run bash/u);
  sendInput(view, "\x1b[B");
  assert.match(selected()!, /→ ▸ Searched/u);

  sendInput(view, "\x1b[B");
  assert.match(selected()!, /→ ▸ Searched/u);

  sendInput(view, "\x1b[A"); // up
  assert.match(selected()!, /→ ▸ Run bash/u);
  sendInput(view, "\x1b[A");
  assert.match(selected()!, /→ ▸ Read src\/read\.ts/u);
  sendInput(view, "\x1b[A");
  assert.match(selected()!, /→ ▸ Read src\/read\.ts/u);
});

test("selection moves even when adjacent item headings clamp to one viewport", () => {
  const view = overlay(40);
  const selected = () => view.render(70).map(strip).find((line) => line.includes("→"));
  sendInput(view, "\x1b[B");
  sendInput(view, "\x1b[B");
  assert.match(selected()!, /→ ▸ Searched/u);

  sendInput(view, "\x1b[A");
  assert.match(selected()!, /→ ▸ Run bash/u);
  sendInput(view, "\x1b[A");
  assert.match(selected()!, /→ ▸ Read src\/read\.ts/u);
});

test("clicking a folded UIKit block expands that call and folds it back", () => {
  const view = overlay();
  const folded = view.render(70).map(strip);
  assert.ok(!folded.some((line) => line.includes("Arguments")));

  sendInput(view, click(rowOf(folded, "▸ Read src/read.ts")));
  const expanded = view.render(70).map(strip);
  assert.ok(expanded.some((line) => line.includes("▾ Read src/read.ts")));
  assert.ok(expanded.some((line) => line.includes("  Arguments")));
  assert.ok(expanded.some((line) => line.includes("src/read.ts")));
  assert.ok(
    expanded.some((line) => line.includes("→ ▾ Read src/read.ts")),
    "the clicked call becomes selected and expanded",
  );

  sendInput(view, click(rowOf(expanded, "▾ Read src/read.ts")));
  const foldedAgain = view.render(70).map(strip);
  assert.ok(!foldedAgain.some((line) => line.includes("Arguments")));
});

test("a click off the marker rows changes nothing", () => {
  const view = overlay();
  const rendered = view.render(70).map(strip);
  sendInput(view, click(rowOf(rendered, "line 10")));
  sendInput(view, click(0)); // the title border
  assert.deepEqual(view.render(70).map(strip), rendered);
});

test("a press with no release yet has not folded anything", () => {
  const view = overlay();
  const rendered = view.render(70).map(strip);
  const row = rowOf(rendered, "▸ Read src/read.ts");
  sendInput(view, `\x1b[<0;4;${row + 1}M`); // press only: a drag may follow
  assert.ok(view.render(70).map(strip).some((line) => line.includes("▸ Read src/read.ts")));

  sendInput(view, `\x1b[<0;4;${row + 1}m`); // release: now it is a click
  assert.ok(view.render(70).map(strip).some((line) => line.includes("▾ Read src/read.ts")));
});

test("enter expands the selected folded call", () => {
  const view = overlay();
  view.render(70);
  sendInput(view, "\x1b[B"); // down, into call 2
  sendInput(view, "\r");
  const expanded = view.render(70).map(strip);
  assert.ok(expanded.some((line) => line.includes("▾ Run bash")));
  assert.ok(expanded.some((line) => line.includes("src/bash.ts")));
  assert.ok(expanded.some((line) => line.includes("expand/fold")));
});

test("expanded bash details keep all arguments and use syntax highlighting", () => {
  const group: ToolGroupSnapshot = {
    id: "bash-highlight",
    anchorToolCallId: "bash-highlight-1",
    presentation: "grouped",
    status: "completed",
    createdAt: 0,
    updatedAt: 25,
    failureCount: 0,
    runningCount: 0,
    activities: [{
      id: "bash-highlight-1",
      groupId: "bash-highlight",
      toolName: "bash",
      args: {
        command: "if true; then echo ok; fi",
        cwd: "/tmp/project",
        timeout: 30,
      },
      status: "completed",
      startedAt: 0,
      endedAt: 25,
      result: { text: "ok", truncated: false, isError: false },
    }],
  };
  const view = overlay(24, group);
  view.render(80);
  sendInput(view, "\r");
  const rendered = view.render(80);
  const plain = rendered.map(strip).join("\n");

  assert.ok(rendered.some((line) => line.includes("\x1b[")), "syntax renderer emits ANSI");
  assert.match(plain, /if true; then echo ok; fi/u);
  assert.match(plain, /"cwd": "\/tmp\/project"/u);
  assert.match(plain, /"timeout": 30/u);
});

test("expanded read source and edit diffs use their language-aware painters", () => {
  const readGroup: ToolGroupSnapshot = {
    id: "read-highlight",
    anchorToolCallId: "read-highlight-1",
    presentation: "grouped",
    status: "completed",
    createdAt: 0,
    updatedAt: 10,
    failureCount: 0,
    runningCount: 0,
    activities: [{
      id: "read-highlight-1",
      groupId: "read-highlight",
      toolName: "read",
      args: { path: "src/example.ts" },
      status: "completed",
      startedAt: 0,
      endedAt: 10,
      result: {
        text: "const answer: number = 42;",
        truncated: false,
        isError: false,
      },
    }],
  };
  const readView = overlay(24, readGroup);
  readView.render(80);
  readView.handleInput("\r");
  const readRows = readView.render(80);
  assert.ok(readRows.some((line) => line.includes("\x1b[")));
  assert.match(readRows.map(strip).join("\n"), /const answer: number = 42;/u);

  const editGroup: ToolGroupSnapshot = {
    id: "edit-highlight",
    anchorToolCallId: "edit-highlight-1",
    presentation: "single-file-edit",
    status: "completed",
    createdAt: 0,
    updatedAt: 10,
    failureCount: 0,
    runningCount: 0,
    activities: [{
      id: "edit-highlight-1",
      groupId: "edit-highlight",
      toolName: "edit",
      args: { path: "src/example.ts" },
      status: "completed",
      startedAt: 0,
      endedAt: 10,
      result: {
        text: "edited",
        truncated: false,
        isError: false,
        details: { diff: "-1 const answer = 1;\n+1 const answer = 42;" },
      },
    }],
  };
  const editView = overlay(24, editGroup);
  editView.render(80);
  editView.handleInput("\r");
  const editRows = editView.render(80);
  assert.ok(editRows.some((line) => line.includes("\x1b[")));
  assert.match(editRows.map(strip).join("\n"), /const answer = 42;/u);
});

test("expanding tracks the scroll position of the calls above it", () => {
  const view = overlay();
  view.render(70);
  sendInput(view, "\x1b[B"); // down, into call 2
  const scrolled = view.render(70).map(strip);
  // Call 2's header is at the top of the body, so clicking there folds it
  // rather than whatever occupied that row before the jump.
  sendInput(view, click(rowOf(scrolled, "▸ Run bash")));
  assert.ok(view.render(70).map(strip).some((line) => line.includes("▾ Run bash")));
});

test("manual scrolling does not change the selected tool call", () => {
  const view = overlay();
  view.render(70);
  sendInput(view, "\x1b[B"); // select call 2
  sendInput(view, "j");
  const selected = view.render(70).map(strip).find((line) => line.includes("→"));
  assert.match(selected!, /→ ▸ Run bash/u);
});

test("tool cards show recorded duration in collapsed and expanded views", () => {
  const group = multiCallGroup();
  group.activities = group.activities.map((activity, index) => ({ ...activity, durationMs: index === 0 ? 25 : undefined }));
  const view = overlay(24, group);
  assert.ok(view.render(70).map(strip).some((line) => line.includes("✓ 25ms")));
  view.handleInput("\r");
  assert.ok(view.render(70).map(strip).some((line) => line.includes("completed · 25ms")));
});

test("Activity frame keeps the full path, right footer and 70 percent/slot height limits", () => {
  const view = activityOverlay(20);
  const rendered = view.render(120).map(strip);
  assert.match(rendered[0]!, /Tool transcript > Activity transcript/);
  assert.match(rendered.at(-1)!, /^─+ .*Esc close ──$/);
  assert.ok(rendered.length <= Math.floor(20 * 0.7));
  view.setAvailableHeight(9);
  assert.ok(view.render(120).length <= 9);
  view.setAvailableHeight(2);
  assert.equal(view.render(20).length, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import { click } from "./native-mouse.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ToolActivity } from "../src/types.ts";
import {
  renderWorkingToolDetail,
  renderWorkingToolRows,
  WorkingToolsWidget,
  workingToolPrefix,
} from "../src/working-tools.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function activity(
  id: string,
  toolName: string,
  args: unknown,
  startedAt = 1_000,
): ToolActivity {
  return {
    id,
    groupId: "working",
    toolName,
    args,
    status: "running",
    startedAt,
  };
}

test("expanded tools use one connector and one detailed row per active call", () => {
  const rows = renderWorkingToolRows([
    activity("bash-1", "bash", { command: "npm test\n-- --runInBand" }),
    activity("read-1", "read", { path: "src/a.ts" }, 1_500),
  ], {
    collapsed: false,
    now: 2_200,
    width: 80,
    theme,
  });

  assert.deepEqual(rows, [
    "   └ $ npm test -- --runInBand · 1.2s",
    "   └ Read src/a.ts · 0.7s",
  ]);
  assert.ok(rows.every((row) => !row.includes("\n")));
});

test("active tool rows stay static neutral beneath the spinner", () => {
  const used: string[] = [];
  const spyTheme = {
    fg: (color: string, text: string) => {
      used.push(color);
      return text;
    },
  } as unknown as Theme;
  const rows = renderWorkingToolRows([
    activity("bash-1", "bash", { command: "npm test" }),
  ], {
    collapsed: false,
    now: 1_000,
    width: 80,
    theme: spyTheme,
  });

  assert.deepEqual(rows, ["   └ $ npm test · 0.0s"]);
  assert.deepEqual([...new Set(used)].sort(), ["dim", "muted"]);
});

test("a detailed command stays on one row, truncates, and keeps elapsed", () => {
  const rows = renderWorkingToolRows([
    activity("bash-1", "bash", {
      command: "node --test a-very-long-path/that-cannot-fit-on-this-row.test.ts",
    }),
  ], {
    collapsed: false,
    now: 2_200,
    width: 36,
    theme,
  });

  const plain = rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.equal(rows.length, 1);
  assert.ok(rows.every((row) => visibleWidth(row) <= 36));
  assert.match(plain[0] ?? "", /^   └ \$ node.*… · 1\.2s$/);
});

test("a bash row reserves its elapsed suffix before fitting the command", () => {
  for (let width = 4; width <= 32; width++) {
    const rows = renderWorkingToolRows([
      activity("bash-1", "bash", { command: "a-command-that-does-not-fit" }),
    ], {
      collapsed: false,
      now: 1_000,
      width,
      theme,
    });
    assert.equal(rows.length, 1, `width ${width}`);
    assert.ok(visibleWidth(rows[0]!) <= width, `width ${width}`);
    assert.match(rows[0]!, /0\.0s$/, `width ${width}`);
    if (width >= 13) assert.match(rows[0]!, /… · 0\.0s$/, `width ${width}`);
  }
});

test("a first-row-sized detail still leaves room for elapsed", () => {
  const width = 108;
  const rows = renderWorkingToolRows([
    activity("search-1", "grep", {}),
  ], {
    collapsed: false,
    now: 1_000,
    width,
    theme,
    // Connector width is 5, so this fills the whole unreserved body exactly.
    formatActivity: () => "x".repeat(width - 5),
  });

  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => visibleWidth(row) <= width));
  assert.match(rows.at(-1) ?? "", / · 0\.0s$/);
});

test("active tool rows never exceed even a tiny component width", () => {
  for (let width = 1; width <= 16; width++) {
    const rows = renderWorkingToolRows([
      activity("search-1", "grep", {}),
    ], {
      collapsed: false,
      now: 1_000,
      width,
      theme,
      formatActivity: () => "long-running-search-detail",
    });
    assert.ok(
      rows.every((row) => visibleWidth(row) <= width),
      `row exceeded width ${width}`,
    );
  }
});

test("folding counts parallel tools and uses a brief prefix for one", () => {
  const shell = activity("bash-1", "bash", { command: "npm test" });
  const read = activity("read-1", "read", { path: "src/a.ts" });
  assert.deepEqual(renderWorkingToolRows([shell, read], {
    collapsed: true,
    now: 2_200,
    width: 80,
    theme,
  }), ["   └ 2 tools running"]);
  assert.deepEqual(renderWorkingToolRows([shell], {
    collapsed: true,
    now: 2_200,
    width: 80,
    theme,
  }), ["   └ Shell · 1.2s"]);

  const spawn = activity("agent-1", "spawn_agent", { task_name: "review" });
  assert.deepEqual(renderWorkingToolRows([spawn], {
    collapsed: true,
    now: 2_200,
    width: 80,
    theme,
    formatActivity: () => "Spawning agent 'review'",
  }), ["   └ Spawning agent 'review' · 1.2s"]);
  const wait = activity("agent-2", "wait_agents", { targets: ["/root/review"] });
  assert.deepEqual(renderWorkingToolRows([spawn, wait], {
    collapsed: true,
    now: 2_200,
    width: 80,
    theme,
    formatActivity: (item) => item.toolName === "spawn_agent"
      ? "Spawning agent 'review'"
      : "Waiting for agent '/root/review'",
  }), ["   └ Spawning agent 'review', Waiting for agent '/root/review'"]);
  assert.equal(
    workingToolPrefix("ctx_memory", { action: "archive", ids: [12] }),
    "Archive memory",
  );
  assert.equal(
    workingToolPrefix("ctx_note", {
      action: "write",
      surface_condition: "When released",
    }),
    "Save smart note",
  );
  assert.equal(workingToolPrefix("ctx_reduce", { drop: "12-18" }), "Queue drop");
  assert.equal(workingToolPrefix("custom_tool"), "custom_tool");
});

test("the active-tool component opens a snapshot without changing its row", () => {
  const activities = [activity("bash-1", "bash", { command: "npm test" })];
  const opened: ToolActivity[] = [];
  let connected = true;
  const widget = new WorkingToolsWidget(
    () => activities,
    () => false,
    (snapshot) => {
      opened.push(snapshot);
      return true;
    },
    () => connected,
    theme,
    () => 2_200,
  );

  const before = widget.render(80);
  assert.equal(before[0], "   └ $ npm test · 1.2s");
  assert.equal(click(widget, 0, 5), true);
  assert.deepEqual(opened, activities);
  assert.deepEqual(widget.render(80), before);
  assert.match(renderWorkingToolDetail(activities[0]!), /"command": "npm test"/);
  assert.match(renderWorkingToolDetail(activities[0]!), /执行中，暂无输出/);

  connected = false;
  assert.deepEqual(widget.render(80), []);
  assert.equal(click(widget, 0, 5), false);
});


test("painted line ranges select only one parallel call, including its wrapped continuation", () => {
  const first = activity("first", "grep", {});
  const second = activity("second", "bash", { command: "npm test" });
  const items = [first, second];
  const opened: ToolActivity[] = [];
  const formatter = (item: ToolActivity) => item.id === "first" ? "x".repeat(45) : "npm test";
  const widget = new WorkingToolsWidget(() => items, () => false,
    (item) => { opened.push(item); return true; }, () => true, theme, () => 2_200, formatter);
  assert.equal(click(widget, 0, 0), false, "no painted frame yet");
  const lines = widget.render(36);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines, renderWorkingToolRows(items, {
    collapsed: false, now: 2_200, width: 36, theme, formatActivity: formatter,
  }), "hit-test bookkeeping must not change layout");
  assert.equal(click(widget, 1, 8), true, "wrapped continuation belongs to first call");
  assert.equal(click(widget, 2, 8), true, "next call starts after both first-call rows");
  assert.deepEqual(opened, [first, second]);
  for (const [row, col] of [[-1, 0], [3, 0], [0, -1], [0, 36], [0.5, 0]]) {
    assert.equal(click(widget, row!, col!), false);
  }
});

test("stale painted rows cannot select replacement calls and retained IDs use latest data", () => {
  const first = activity("first", "bash", { command: "first" });
  const second = activity("second", "bash", { command: "second" });
  let items = [first, second];
  const opened: ToolActivity[] = [];
  const widget = new WorkingToolsWidget(() => items, () => false,
    (item) => { opened.push(item); return true; }, () => true, theme);
  widget.render(80);
  const updated = { ...second, args: { command: "second updated" } };
  items = [updated, activity("replacement", "bash", { command: "replacement" })];
  assert.equal(click(widget, 0, 5), false, "finished first ID is gone, despite row reuse");
  assert.equal(click(widget, 1, 5), true, "painted second ID survives reordering");
  assert.deepEqual(opened, [updated]);
  items = [{ ...updated, status: "completed" }];
  assert.equal(click(widget, 1, 5), false, "settled item is not active");
  items = [];
  assert.deepEqual(widget.render(80), []);
  assert.equal(click(widget, 1, 5), false);
});

test("collapsed parallel summary is inert while a single collapsed call is selectable", () => {
  let items = [activity("a", "bash", {}), activity("b", "read", {})];
  const opened: string[] = [];
  const widget = new WorkingToolsWidget(() => items, () => true,
    (item) => { opened.push(item.id); return true; }, () => true, theme, () => 2_200);
  assert.deepEqual(widget.render(80), ["   └ 2 tools running"]);
  assert.equal(click(widget, 0, 6), false);
  items = [items[0]!];
  assert.equal(click(widget, 0, 6), false, "summary stays inert until single-call frame is drawn");
  assert.deepEqual(widget.render(80), ["   └ Shell · 1.2s"]);
  assert.equal(click(widget, 0, 6), true);
  assert.deepEqual(opened, ["a"]);
  widget.render(0);
  assert.equal(click(widget, 0, 0), false);
});

test("fullscreen mouse dispatch uses local coordinates and only left click opens details", () => {
  const items = [activity("a", "bash", {}), activity("b", "bash", {})];
  const opened: string[] = [];
  const widget = new WorkingToolsWidget(() => items, () => false,
    (item) => { opened.push(item.id); return true; }, () => true, theme);
  widget.render(80);
  const event: TuiMouseEvent = {
    type: "click", button: "left", x: 6, y: 1, screenX: 26, screenY: 21,
    width: 80, height: 2, shift: false, alt: false, ctrl: false,
  };
  for (const type of ["press", "release", "move", "drag", "wheel"] as const) {
    assert.equal(widget.handleMouse({ ...event, type }), undefined);
  }
  assert.equal(widget.handleMouse({ ...event, button: "right" }), undefined);
  assert.equal(widget.handleMouse({ ...event, button: "middle" }), undefined);
  assert.deepEqual(widget.handleMouse(event), { handled: true });
  assert.deepEqual(opened, ["b"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { click } from "./native-mouse.ts";
import type {
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { TextOpenOptions } from "../src/openers.ts";
import { DEFAULT_WORKING } from "../src/config.ts";
import { ProviderStatusTracker } from "../src/provider-status.ts";
import { RunMetrics } from "../src/metrics.ts";
import {
  WorkingController,
  WORKING_TOOLS_WIDGET_KEY,
} from "../src/working.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

function fixture() {
  let now = 1_000;
  const messages: string[] = [];
  const opened: Array<{ heading: string; body: string; options?: TextOpenOptions }> = [];
  let toolsWidget: Component | undefined;
  const metrics = new RunMetrics({ now: () => now });
  const ui = {
    theme: plainTheme,
    setWidget(key: string, content?: unknown) {
      if (key !== WORKING_TOOLS_WIDGET_KEY) return;
      toolsWidget = typeof content === "function"
        ? (content as (tui: unknown, theme: Theme) => Component)(
          { requestRender() {} },
          plainTheme,
        )
        : undefined;
    },
    setWorkingIndicator() {},
    setWorkingVisible() {},
    setWorkingMessage(message?: string) {
      if (message !== undefined) messages.push(message.replace(/\x1b\[[0-9;]*m/g, ""));
    },
  } as unknown as ExtensionUIContext;
  const ctx = { hasUI: true, ui } as ExtensionContext;
  const working = new WorkingController(
    metrics,
    {
      ...DEFAULT_WORKING,
      style: "plain",
      refreshMs: 1_000,
      spinnerIntervalMs: 1_000,
      verbRotateMs: 60_000,
      showCancelHintAfterMs: 600_000,
      messageWidth: 300,
    },
    new ProviderStatusTracker(),
    undefined,
    () => now,
    undefined,
    undefined,
    (heading, body, options) => {
      opened.push({ heading, body, options });
      return true;
    },
  );
  metrics.start();
  working.start(ctx);
  working.setActivity("Checking layout");
  return {
    messages,
    working,
    toolRows() {
      return (toolsWidget?.render(120) ?? []).map((row) =>
        row.replace(/\x1b\[[0-9;]*m/g, "")
      );
    },
    clickTools(row = 0) {
      return click(toolsWidget as Component | undefined, row, 0);
    },
    opened,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    stop() {
      working.clear(ui);
    },
  };
}

test("single-call details follow partial output and final errors without including parallel calls", (t) => {
  const { working, toolRows, clickTools, opened, stop } = fixture();
  t.after(stop);
  working.startTool("one", "bash", { command: "printf 'complete command\\n'" });
  working.startTool("two", "bash", { command: "OTHER_COMMAND" });
  toolRows();
  assert.equal(clickTools(0), true);
  const live = opened[0]!.options!.live!;
  const updates: string[] = [];
  const unsubscribe = live.subscribe((body) => updates.push(body));
  working.updateTool("one", { command: "printf 'complete command\\n'" }, {
    text: "PARTIAL\\nline two\u001b[31m\u202e", truncated: false, isError: false,
  });
  assert.match(live.snapshot(), /PARTIAL/);
  assert.doesNotMatch(live.snapshot(), /OTHER_COMMAND|\u001b|\u202e/);
  working.finishTool("one", { text: "FINAL_ERROR", truncated: true, isError: true });
  assert.match(live.snapshot(), /Status: failed/);
  assert.match(live.snapshot(), /FINAL_ERROR/);
  assert.match(live.snapshot(), /Output truncated/);
  assert.equal(updates.length, 2);
  unsubscribe();
  stop();
  assert.match(live.snapshot(), /Status: failed/);
});

test("open details retain final output before subscription and cancel on runtime cleanup", (t) => {
  const { working, toolRows, clickTools, opened, stop } = fixture();
  t.after(stop);
  working.startTool("one", "read", { path: "first" });
  toolRows(); clickTools();
  working.finishTool("one", { text: "FINAL", truncated: false, isError: false });
  assert.match(opened[0]!.options!.live!.snapshot(), /FINAL/);
  working.startTool("two", "read", { path: "second" });
  toolRows(); clickTools();
  const live = opened[1]!.options!.live!;
  stop();
  assert.match(live.snapshot(), /Status: cancelled/);
});

test("declined lazy mount releases its pre-subscription observer", (t) => {
  const { working, toolRows, clickTools, opened, stop } = fixture();
  t.after(stop);
  working.startTool("one", "read", { path: "first" });
  toolRows(); clickTools();
  const options = opened[0]!.options!;
  const before = options.live!.snapshot();
  options.onClose!();
  options.onClose!();
  working.updateTool("one", { path: "changed" });
  assert.equal(options.live!.snapshot(), before);
});

test("reports whether the spinner is visible for an attached todo widget", () => {
  const { working, stop } = fixture();
  assert.equal(working.isWorkingVisible(), true);
  working.pauseForModal();
  assert.equal(working.isWorkingVisible(), false);
  working.resumeAfterModal();
  assert.equal(working.isWorkingVisible(), true);
  stop();
  assert.equal(working.isWorkingVisible(), false);
});

test("keeps the spinner on two fixed rows and puts tools below them", (t) => {
  const { messages, working, toolRows, advance, stop } = fixture();
  t.after(stop);

  working.startTool("bash-1", "bash", { command: "go test ./..." }, 1_000);
  assert.equal(messages.at(-1), "Checking layout...\n  0.0s");
  assert.deepEqual(toolRows(), ["   └ $ go test ./... · 0.0s"]);

  advance(65_000);
  working.updateTool("bash-1", { command: "go test ./... -count=1" });
  assert.equal(messages.at(-1), "Checking layout...\n  1m05s");
  assert.deepEqual(toolRows(), ["   └ $ go test ./... -count=1 · 1m05s"]);
  assert.doesNotMatch(messages.at(-1) ?? "", /go test|Running 1 shell command|⎿/);
});

test("lists only calls still running in the clickable tool component", (t) => {
  const { messages, working, toolRows, clickTools, opened, stop } = fixture();
  t.after(stop);

  working.startTool("read-1", "read", { path: "src/a.ts" }, 1_000);
  working.startTool("grep-1", "grep", { pattern: "needle", path: "src" }, 1_000);
  assert.equal(messages.at(-1), "Checking layout...\n  0.0s");
  const rowsBeforeClick = toolRows();
  assert.deepEqual(rowsBeforeClick, [
    "   └ Read src/a.ts · 0.0s",
    '   └ Search "needle" in src · 0.0s',
  ]);
  assert.equal(clickTools(), true);
  assert.equal(opened[0]?.heading, "read");
  assert.match(opened[0]!.body, /"path": "src\/a.ts"/);
  assert.doesNotMatch(opened[0]!.body, /needle/);
  assert.match(opened[0]!.body, /执行中，暂无输出/);
  assert.equal(opened[0]?.options?.format, "plain");
  assert.deepEqual(toolRows(), rowsBeforeClick, "clicking does not resize the persistent rows");

  working.finishTool("grep-1");
  assert.deepEqual(toolRows(), ["   └ Read src/a.ts · 0.0s"]);

  working.finishTool("read-1");
  assert.deepEqual(toolRows(), []);
});

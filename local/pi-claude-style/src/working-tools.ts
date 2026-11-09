import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  colorWithMutedEllipses,
  fitTextRows,
  truncateWithMutedEllipsis,
} from "./ellipsis.ts";
import { onLeftClick } from "./clickable.ts";
import { formatDuration } from "./format.ts";
import {
  classifyTool,
  ccMemoryActivityPrefix,
  formatCurrentActivity,
  magicContextActivityPrefix,
} from "./semantics.ts";
import type { ToolActivity } from "./types.ts";
import { PINNED_WORKING_CHILD_INDENT } from "./working-layout.ts";

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compactToolName(toolName: string, maxChars = 32): string {
  const name = inline(toolName) || "Tool";
  return name.length <= maxChars ? name : `${name.slice(0, maxChars - 1)}…`;
}

/** The folded one-tool row names its operation without repeating full detail. */
export function workingToolPrefix(toolName: string, args?: unknown): string {
  const memoryPrefix = ccMemoryActivityPrefix(toolName, args);
  if (memoryPrefix) return memoryPrefix;
  const magicContextPrefix = magicContextActivityPrefix(toolName, args);
  if (magicContextPrefix) return magicContextPrefix;
  switch (classifyTool(toolName)) {
    case "bash":
      return "Shell";
    case "read":
      return "Read";
    case "search":
      return "Search";
    case "list":
      return "List";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
    case "subagent":
      return "Agent";
    case "process":
      return "Process";
    case "memory":
      return "Memory";
    case "note":
      return "Note";
    case "context":
      return "Context";
    case "todo":
      return "Todo";
    case "mcp":
      return "MCP";
    case "unknown":
      return compactToolName(toolName);
  }
}

function toolRows(
  detail: string,
  elapsed: string | undefined,
  width: number,
  theme: Theme,
  maxRows = 2,
): string[] {
  const connector = `${PINNED_WORKING_CHILD_INDENT}${theme.fg("dim", "└")} `;
  const continuation = " ".repeat(visibleWidth(connector));
  const bodyWidth = Math.max(
    0,
    Math.floor(width) - visibleWidth(connector),
  );
  const safeWidth = Math.max(0, Math.floor(width));
  const suffix = elapsed ? ` · ${elapsed}` : "";
  const rows = fitTextRows(
    inline(detail),
    bodyWidth,
    maxRows,
    visibleWidth(suffix),
  );
  if (rows.length === 0 && elapsed && maxRows === 1 && safeWidth > 0) {
    // On an exceptionally narrow terminal, sacrifice the connector and then
    // the command before the timer. A full duration remains visible whenever
    // the component is at least as wide as the duration itself.
    const compact = `…${suffix}`;
    const fallback = safeWidth >= visibleWidth(compact)
      ? compact
      : safeWidth >= visibleWidth(elapsed)
      ? elapsed
      : fitTextRows(elapsed, safeWidth, 1)[0] ?? "";
    return fallback
      ? [colorWithMutedEllipses(theme, "muted", fallback)]
      : [];
  }
  if (rows.length > 0) rows[rows.length - 1] += suffix;
  return rows.map((row, index) => {
    const rendered = `${index === 0 ? connector : continuation}${colorWithMutedEllipses(
      theme,
      "muted",
      row,
    )}`;
    // A custom component must never hand Pi an over-wide row. This also guards
    // tiny terminals where the connector or elapsed suffix cannot fit at all.
    return visibleWidth(rendered) <= safeWidth
      ? rendered
      : truncateWithMutedEllipsis(rendered, safeWidth, theme);
  });
}

export interface WorkingToolRowsOptions {
  collapsed: boolean;
  now: number;
  width: number;
  theme: Theme;
  formatActivity?: (activity: ToolActivity) => string;
}

export function renderWorkingToolDetail(activity: ToolActivity): string {
  const clean = (text: string) => stripTerminalSequences(text).replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
  const args = JSON.stringify(activity.args, null, 2) ?? "{}";
  const output = activity.result?.text || (activity.status === "running"
    ? "执行中，暂无输出。" : "无文本输出。");
  return clean([
    `Tool: ${activity.toolName}`,
    `Call: ${activity.id}`,
    `Status: ${activity.status}`,
    "", "Arguments", args,
    "", activity.status === "running" ? "Partial output" : "Result", output,
    ...(activity.result?.truncated ? ["[Output truncated]"] : []),
  ].join("\n"));
}

/** Render active calls; shell commands stay on one row while other details may use two. */
export function renderWorkingToolRows(
  activities: readonly ToolActivity[],
  options: WorkingToolRowsOptions,
): string[] {
  if (activities.length === 0 || options.width <= 0) return [];
  const elapsed = (activity: ToolActivity) =>
    formatDuration(Math.max(0, options.now - activity.startedAt));

  const formatActivity = options.formatActivity ?? formatCurrentActivity;
  if (options.collapsed) {
    if (activities.length === 1) {
      const activity = activities[0]!;
      const semantic = classifyTool(activity.toolName) === "subagent";
      return toolRows(
        semantic ? formatActivity(activity) : workingToolPrefix(activity.toolName, activity.args),
        elapsed(activity),
        options.width,
        options.theme,
      );
    }
    if (activities.every((activity) => classifyTool(activity.toolName) === "subagent")) {
      return toolRows(
        activities.map(formatActivity).join(", "),
        undefined,
        options.width,
        options.theme,
      );
    }
    return toolRows(
      `${activities.length} tools running`,
      undefined,
      options.width,
      options.theme,
    );
  }

  return activities.flatMap((activity) =>
    toolRows(
      formatActivity(activity),
      elapsed(activity),
      options.width,
      options.theme,
      classifyTool(activity.toolName) === "bash" ? 1 : 2,
    )
  );
}

/** Clickable active-tool block mounted below Pi's working row. */
export class WorkingToolsWidget implements Component {
  private readonly activities: () => readonly ToolActivity[];
  private readonly collapsed: () => boolean;
  private readonly openDetails: (activity: ToolActivity) => boolean;
  private renderedWidth = 0;
  private hitRanges: Array<{ id: string; start: number; end: number }> = [];
  private readonly connected: () => boolean;
  private readonly theme: Theme;
  private readonly clock: () => number;
  private readonly formatActivity: (activity: ToolActivity) => string;

  constructor(
    activities: () => readonly ToolActivity[],
    collapsed: () => boolean,
    openDetails: (activity: ToolActivity) => boolean,
    connected: () => boolean,
    theme: Theme,
    clock: () => number = Date.now,
    formatActivity: (activity: ToolActivity) => string = formatCurrentActivity,
  ) {
    this.activities = activities;
    this.collapsed = collapsed;
    this.openDetails = openDetails;
    this.connected = connected;
    this.theme = theme;
    this.clock = clock;
    this.formatActivity = formatActivity;
  }

  render(width: number): string[] {
    this.hitRanges = [];
    this.renderedWidth = Math.max(0, Math.floor(width));
    if (!this.connected()) return [];
    const activities = this.activities();
    const options = {
      collapsed: this.collapsed(),
      now: this.clock(),
      width,
      theme: this.theme,
      formatActivity: this.formatActivity,
    };
    // A multi-tool collapsed summary has no single invocation to open.
    if (options.collapsed && activities.length > 1) {
      return renderWorkingToolRows(activities, options);
    }
    const lines: string[] = [];
    for (const activity of activities) {
      const rows = renderWorkingToolRows([activity], options);
      if (rows.length === 0) continue;
      this.hitRanges.push({ id: activity.id, start: lines.length, end: lines.length + rows.length });
      lines.push(...rows);
    }
    return lines;
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return onLeftClick(event, (row, col) => this.open(row, col));
  }

  private open(row: number, col: number): boolean {
    if (!this.connected() || !Number.isInteger(row) || !Number.isInteger(col) ||
      row < 0 || col < 0 || col >= this.renderedWidth) return false;
    const hit = this.hitRanges.find((range) => row >= range.start && row < range.end);
    if (!hit) return false;
    // Keep the identity from the painted frame; a finished call must not turn
    // into a click on the next active item before the next frame is rendered.
    const activity = this.activities().find((candidate) => candidate.id === hit.id);
    return activity?.status === "running" && this.openDetails(activity);
  }
}

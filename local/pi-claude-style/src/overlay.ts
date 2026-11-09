import {
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  getLanguageFromPath,
  highlightCode,
  renderDiff,
} from "@earendil-works/pi-coding-agent";
import {
  diffLineKind,
  formatWrappedDiffLines,
  paintDiffLine,
  type DiffColors,
} from "./diff-colors.ts";
import { displayEditPath } from "./edit-path.ts";
import { getCapturedEditDiff } from "./edit-details.ts";
import { formatDuration, stringifyUnknown } from "./format.ts";
import { withoutCodeFenceMarkers } from "./code-fence.ts";
import { panelRightRule, panelFooterRule } from "pi-li-uikit/panel-footer";
import { renderCollapsibleRows } from "pi-li-uikit/collapsible-block";
import {
  renderPanelMarkdown,
  type BodyLayout,
  type ScrollOverlayOptions,
} from "pi-li-uikit/text-panel";
import type { SelectableCollapsiblePanel } from "pi-li-uikit/selectable-collapsible-panel";
import type {
  ActivityPhaseSnapshot,
  ActivityThinkingSnapshot,
} from "./activity-timeline.ts";
import { ccMemoryActivityPrefix, classifyTool, summarizeGroup } from "./semantics.ts";
import type { ToolActivity, ToolGroupSnapshot } from "./types.ts";
import { formatWebHeader } from "./web-format.ts";

interface OverlayOptions extends ScrollOverlayOptions {
  group?: ToolGroupSnapshot;
  phase?: ActivityPhaseSnapshot;
  resolveNestedActivities?: (toolCallId: string) => readonly ToolGroupSnapshot["activities"][number][];
  resolveActivity?: (toolCallId: string) => ToolActivity | undefined;
  maxResultChars: number;
  diffColors: DiffColors;
  formatActivity: (activity: ToolGroupSnapshot["activities"][number]) => string;
  now?: () => number;
  cwd?: string;
  /** Drop ``` marker rows from expanded thinking, as the transcript does. */
  hideCodeFenceMarkers?: boolean;
}

type OverlayItem =
  | { kind: "thinking"; id: string; thinking: ActivityThinkingSnapshot }
  | { kind: "tool"; id: string; activity: ToolActivity };

export function itemTitle(group: ToolGroupSnapshot, cwd?: string): string {
  const activity = group.activities[0];
  if (group.presentation === "web-search" ||
    group.presentation === "web-fetch") {
    return formatWebHeader(group.presentation, activity?.args);
  }
  if (group.presentation === "single-file-edit") {
    const args =
      typeof activity?.args === "object" && activity.args !== null
        ? activity.args as Record<string, unknown>
        : {};
    const rawPath = typeof args.path === "string" ? args.path : undefined;
    const path = rawPath ? displayEditPath(rawPath, cwd) || "file" : "file";
    return `Edit(${path})`;
  }
  if (group.presentation === "question") return "Questionnaire";
  return summarizeGroup(group);
}

type SelectablePanelConstructor = typeof SelectableCollapsiblePanel;

/** Inject UIKit's first-use-loaded base without pulling the overlay UI into startup. */
export function createToolGroupOverlayClass(SelectablePanelBase: SelectablePanelConstructor) {
return class ToolGroupOverlay extends SelectablePanelBase {
  private group: ToolGroupSnapshot | undefined;
  private phase: ActivityPhaseSnapshot | undefined;
  private readonly resolveNestedActivities: OverlayOptions["resolveNestedActivities"];
  private readonly resolveActivity: ((toolCallId: string) => ToolActivity | undefined) | undefined;
  private readonly maxResultChars: number;
  private readonly diffColors: DiffColors;
  private readonly formatActivity: OverlayOptions["formatActivity"];
  private readonly now: () => number;
  private readonly cwd: string | undefined;
  private readonly hideCodeFenceMarkers: boolean;
  constructor(options: OverlayOptions) {
    super(options);
    if (!options.group && !options.phase) {
      throw new Error("ToolGroupOverlay requires a group or activity phase");
    }
    this.group = options.group;
    this.phase = options.phase;
    this.resolveActivity = options.resolveActivity;
    this.resolveNestedActivities = options.resolveNestedActivities;
    this.maxResultChars = options.maxResultChars;
    this.diffColors = options.diffColors;
    this.formatActivity = options.formatActivity;
    this.now = options.now ?? Date.now;
    this.cwd = options.cwd;
    this.hideCodeFenceMarkers = options.hideCodeFenceMarkers === true;
    this.syncItemIds();
  }

  updateGroup(group: ToolGroupSnapshot): void {
    if (this.phase || group.id !== this.group?.id || group === this.group) return;
    this.group = group;
    this.syncItemIds();
    this.tui.requestRender();
  }

  updatePhase(phase: ActivityPhaseSnapshot): void {
    if (this.group || phase.id !== this.phase?.id) return;
    this.phase = phase;
    this.syncItemIds();
    this.tui.requestRender();
  }

  dismiss(): void {
    this.close();
  }

  protected title(): string {
    return this.phase
      ? "Tool transcript > Activity transcript"
      : `Tool transcript > ${itemTitle(this.group!, this.cwd)}`;
  }

  protected panelTitleCandidates(): readonly string[] {
    const current = this.phase ? "Activity transcript" : itemTitle(this.group!, this.cwd);
    return [this.title(), `… > ${current}`, current];
  }

  protected panelFooterCandidates(): readonly string[] {
    return [
      "↑↓ select · Enter/Space/click expand/fold · jk/PgUp/PgDn scroll · y copy · Esc close",
      "↑↓ select · Enter expand/fold · jk/PgUp/PgDn scroll · Esc close",
      "↑↓ select · Enter expand/fold · Esc close",
      "↑↓ · Enter · Esc",
    ];
  }

  /** Keep the interactive UIKit panel within the shared information-panel budget. */
  protected override frameLayout(totalLines: number): { bodyRows: number; topRows: number } {
    const ceiling = Math.max(1, Math.min(
      Math.floor(this.tui.terminal.rows * 0.7),
      this.availableHeight ?? this.tui.terminal.rows,
    ));
    const height = Math.min(ceiling, Math.max(6, totalLines + 3));
    return { bodyRows: Math.max(0, height - 3), topRows: Math.min(2, Math.max(0, height - 1)) };
  }

  protected override chrome(visible: readonly string[], totalLines: number, innerWidth: number, width: number): string[] {
    const lines = super.chrome(visible, totalLines, innerWidth, width);
    lines[0] = panelRightRule(this.theme, width, this.panelTitleCandidates(), "accent");
    lines[lines.length - 1] = panelFooterRule(this.theme, width,
      this.copyStatus ? [this.copyStatus] : this.panelFooterCandidates());
    const ceiling = Math.max(1, Math.min(Math.floor(this.tui.terminal.rows * 0.7), this.availableHeight ?? this.tui.terminal.rows));
    if (lines.length <= ceiling) return lines;
    if (ceiling === 1) return [lines[0]!];
    return [...lines.slice(0, ceiling - 1), lines[lines.length - 1]!];
  }

  /**
   * The captured arguments and results as text. The rendered body carries the
   * frame's colours and wrapping, so it is rebuilt without them — what lands
   * on the clipboard should paste into an editor, not into a terminal.
   */
  protected copyText(): string {
    return this.items().map((item) => {
      if (item.kind === "thinking") {
        return `# Thinking\n${item.thinking.body}`;
      }
      const activity = item.activity;
      const parts = [`# ${activity.toolName} (${activity.status})`];
      parts.push(stringifyUnknown(activity.args, this.maxResultChars));
      if (activity.result) {
        parts.push(activity.result.isError ? "## Error" : "## Result");
        parts.push(activity.result.text);
      }
      return parts.join("\n");
    }).join("\n\n");
  }

  protected buildBody(width: number): BodyLayout {
    const lines: string[] = [];
    const headings: number[] = [];
    const items = this.items();
    const totalTools = items.filter((item) => item.kind === "tool").length;
    let toolIndex = 0;
    items.forEach((item, index) => {
      headings.push(lines.length);
      if (item.kind === "thinking") {
        lines.push(...this.renderThinking(item.thinking, index, width));
      } else {
        const activity = item.activity;
        const currentTool = toolIndex++;
        const expanded = this.isItemExpanded(index);
        if (!expanded) {
          lines.push(...this.collapsedCard(activity, index, currentTool, totalTools, width));
        } else {
          lines.push(...this.renderSelectableRows(index, {
            summary: this.expandedSummary(activity, currentTool, totalTools),
            expanded: true,
            renderMarker: (marker) => this.theme.fg("dim", marker),
          }, width));
          lines.push(this.theme.fg("dim", "  Arguments"));
          lines.push(...this.renderArguments(activity, Math.max(1, width - 4)));
          const editDiff = getCapturedEditDiff(activity);
          if (editDiff) {
            lines.push(this.theme.fg("dim", "  Diff"));
            const rowWidth = Math.max(1, width - 4);
            const logicalLines = renderDiff(editDiff.diff, {
              filePath: editDiff.filePath,
            }).split("\n");
            const hanging = activity.status === "completed" &&
                !activity.result?.truncated
              ? formatWrappedDiffLines(logicalLines, rowWidth, this.diffColors)
              : undefined;
            const diffLines = hanging ?? logicalLines.flatMap((line) => {
              const kind = diffLineKind(line);
              return wrapTextWithAnsi(line, rowWidth).map((wrapped) =>
                paintDiffLine(wrapped, this.diffColors, rowWidth, kind)
              );
            });
            lines.push(...diffLines.map((line) => `    ${line}`));
            if (activity.result?.truncated) {
              lines.push(
                this.theme.fg(
                  "warning",
                  "    Diff was truncated in the overlay cache.",
                ),
              );
            }
          } else if (activity.result) {
            lines.push(
              this.theme.fg(
                activity.result.isError ? "error" : "dim",
                activity.result.isError ? "  Error" : "  Result",
              ),
            );
            lines.push(...this.renderResult(activity, Math.max(1, width - 4)));
            if (activity.result.truncated) {
              lines.push(
                this.theme.fg(
                  "warning",
                  "    Result was truncated in the overlay cache.",
                ),
              );
            }
          }
          if (activity.result?.details !== undefined && !editDiff) {
            lines.push(this.theme.fg("dim", "  Details"));
            lines.push(
              ...wrapTextWithAnsi(
                stringifyUnknown(
                  activity.result.details,
                  this.maxResultChars,
                ),
                Math.max(1, width - 4),
              ).map((line) => `    ${line}`),
            );
          }
        }
      }
      if (index < items.length - 1) lines.push(this.renderItemDivider(width));
    });
    return lines.length
      ? { lines, headings }
      : { lines: ["No tool details captured."], headings: [] };
  }

  /**
   * Each call is an embedded UIKit collapsible block: one marker row followed
   * by two-column preview or detail rows. The host TextPanel remains the only
   * frame; heading ranges come from these marker rows for navigation/clicks.
   */
  private syncItemIds(): void {
    this.setItemIds(this.items().map((item) => item.id));
  }

  private items(): OverlayItem[] {
    if (this.group) {
      return this.group.activities.filter((activity) => !activity.parentToolCallId)
        .flatMap((parent) => [parent, ...this.group!.activities.filter((child) => child.parentToolCallId === parent.id)]).map((activity) => ({
        kind: "tool" as const,
        id: activity.id,
        activity,
      }));
    }
    return this.phase?.items.flatMap((item): OverlayItem[] => {
      if (item.kind === "thinking") {
        return [{ kind: "thinking", id: item.id, thinking: item }];
      }
      return item.toolCallIds.flatMap((toolCallId) => {
        const activity = this.resolveActivity?.(toolCallId);
        return activity
          ? [activity, ...(this.resolveNestedActivities?.(toolCallId) ?? [])].map((child) => ({ kind: "tool" as const, id: child.id, activity: child }))
          : [];
      });
    }) ?? [];
  }

  private renderThinking(
    thinking: ActivityThinkingSnapshot,
    index: number,
    width: number,
  ): string[] {
    const note = thinking.document.panelSnapshot().note;
    const elapsed = note ? ` · ${note}` : "";
    const summary = this.theme.italic(
      this.theme.fg("thinkingText", `Thinking${elapsed}`),
    );
    if (!this.isItemExpanded(index)) {
      return this.renderSelectableRows(index, {
        summary,
        expanded: false,
        renderMarker: (marker) => this.theme.fg("dim", marker),
      }, width);
    }
    const rows = this.renderSelectableRows(index, {
      summary,
      expanded: true,
      renderMarker: (marker) => this.theme.fg("dim", marker),
    }, width);
    const markdown = renderPanelMarkdown(
      thinking.body,
      Math.max(1, width - 4),
      this.theme,
      "thinkingText",
    );
    const rendered = markdown && this.hideCodeFenceMarkers
      ? withoutCodeFenceMarkers(markdown)
      : markdown ?? wrapTextWithAnsi(thinking.body, Math.max(1, width - 4));
    rows.push(...rendered.map((line) => `    ${line}`));
    return rows;
  }

  private activityLabel(activity: ToolGroupSnapshot["activities"][number]): string {
    const label = this.activityLabelBody(activity);
    return activity.parentToolCallId ? `↳ ${label}` : label;
  }

  private activityLabelBody(activity: ToolGroupSnapshot["activities"][number]): string {
    const formatted = this.formatActivity(activity);
    if (ccMemoryActivityPrefix(activity.toolName, activity.args)) return formatted;
    const terminal = activity.status !== "running";
    switch (classifyTool(activity.toolName)) {
      case "bash":
        return formatted.startsWith("$ ")
          ? `${terminal ? "Ran" : "Run"} ${formatted.slice(2)}`
          : formatted;
      case "edit": {
        const args = typeof activity.args === "object" && activity.args !== null
          ? activity.args as Record<string, unknown>
          : {};
        const rawPath = typeof args.path === "string"
          ? args.path
          : typeof args.file_path === "string"
            ? args.file_path
            : undefined;
        const path = rawPath ? displayEditPath(rawPath, this.cwd) || rawPath : undefined;
        const label = path ? `Edit ${path}` : formatted;
        return terminal ? label.replace(/^Edit\b/u, "Edited") : label;
      }
      case "write":
        return terminal ? formatted.replace(/^Write\b/u, "Wrote") : formatted;
      case "search":
        return terminal ? formatted.replace(/^Search\b/u, "Searched") : formatted;
      case "list":
        return terminal ? formatted.replace(/^List\b/u, "Listed") : formatted;
      default:
        return formatted;
    }
  }

  private collapsedCard(
    activity: ToolGroupSnapshot["activities"][number],
    index: number,
    toolIndex: number,
    total: number,
    width: number,
  ): string[] {
    const statusColor = activity.status === "failed"
      ? "error"
      : activity.status === "cancelled"
        ? "warning"
        : activity.status === "running"
          ? "accent"
          : "success";
    const counter = total > 1 ? ` ${toolIndex + 1}/${total}` : "";
    const result = activity.result?.text ?? "";
    const statusSuffix = /(?:^|\n)Command exited with code (\d+)\s*$/u.exec(result);
    const output = result
      .replace(/(?:^|\n)Command exited with code \d+\s*$/u, "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(-2);
    const elapsedMs = Math.max(
      0,
      activity.durationMs ?? (activity.endedAt ?? this.activityUpdatedAt(activity.startedAt)) - activity.startedAt,
    );
    const elapsed = elapsedMs < 1_000 ? `${Math.floor(elapsedMs)}ms` : formatDuration(elapsedMs);
    const glyph = activity.status === "running"
      ? "✳"
      : activity.status === "completed"
        ? "✓"
        : activity.status === "failed"
          ? "✗"
          : "■";
    const exit = statusSuffix?.[1] ? ` (${statusSuffix[1]})` : "";
    const preview = [
      ...output.map((line) => this.theme.fg("muted", line)),
      this.theme.fg(statusColor, `${glyph}${exit} ${elapsed}`),
    ];
    return this.renderSelectableRows(index, {
      summary: `${this.theme.bold(this.theme.fg("toolTitle", this.activityLabel(activity)))}${
        this.theme.fg("dim", counter)
      }`,
      preview,
      previewLimit: 3,
      showPreview: true,
      renderMarker: (marker) => this.theme.fg("dim", marker),
    }, width).slice(0, 4);
  }

  private expandedSummary(
    activity: ToolGroupSnapshot["activities"][number],
    index: number,
    total: number,
  ): string {
    const counter = total > 1 ? ` ${index + 1}/${total}` : "";
    const elapsedMs = Math.max(
      0,
      activity.durationMs ?? (activity.endedAt ?? this.activityUpdatedAt(activity.startedAt)) - activity.startedAt,
    );
    const elapsed = elapsedMs < 1_000 ? `${Math.floor(elapsedMs)}ms` : formatDuration(elapsedMs);
    return `${this.theme.bold(this.theme.fg("toolTitle", this.activityLabel(activity)))}${
      this.theme.fg("dim", `${counter} · ${activity.status} · ${elapsed}`)
    }`;
  }

  private activityUpdatedAt(fallback: number): number {
    if (this.phase) return this.now();
    return this.group?.updatedAt ?? fallback;
  }

  private renderArguments(
    activity: ToolGroupSnapshot["activities"][number],
    width: number,
  ): string[] {
    const kind = classifyTool(activity.toolName);
    const args = typeof activity.args === "object" && activity.args !== null
      ? activity.args as Record<string, unknown>
      : undefined;
    if (!args) {
      return this.renderCode(
        stringifyUnknown(activity.args, this.maxResultChars),
        "json",
        width,
      );
    }

    const structuredContent = kind === "bash"
      ? this.argumentContent(args, ["command", "cmd", "script"], "bash")
      : kind === "write"
        ? this.argumentContent(
          args,
          ["content", "text", "fileContent", "file_content"],
          getLanguageFromPath(typeof args.path === "string" ? args.path : "") ?? "text",
        )
        : undefined;
    if (!structuredContent) {
      return this.renderCode(
        stringifyUnknown(activity.args, this.maxResultChars),
        "json",
        width,
      );
    }

    const { key, value, language } = structuredContent;
    const metadata = Object.fromEntries(
      Object.entries(args).filter(([candidate]) => candidate !== key),
    );
    const rows = this.renderCode(value, language, width);
    if (Object.keys(metadata).length > 0) {
      rows.push(this.theme.fg("dim", "    Options"));
      rows.push(...this.renderCode(
        stringifyUnknown(metadata, this.maxResultChars),
        "json",
        width,
      ));
    }
    return rows;
  }

  private argumentContent(
    args: Record<string, unknown>,
    keys: readonly string[],
    language: string,
  ): { key: string; value: string; language: string } | undefined {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string") return { key, value, language };
    }
    return undefined;
  }

  private renderResult(
    activity: ToolGroupSnapshot["activities"][number],
    width: number,
  ): string[] {
    const path = typeof activity.args === "object" && activity.args !== null
      ? (activity.args as Record<string, unknown>).path
      : undefined;
    const language = classifyTool(activity.toolName) === "read" && typeof path === "string"
      ? getLanguageFromPath(path)
      : undefined;
    if (language) return this.renderCode(activity.result?.text ?? "", language, width);
    return wrapTextWithAnsi(activity.result?.text ?? "", width)
      .map((line) => `    ${line}`);
  }

  private renderCode(text: string, language: string, width: number): string[] {
    try {
      return highlightCode(text, language).flatMap((line) =>
        wrapTextWithAnsi(line, width).map((wrapped) => `    ${wrapped}`)
      );
    } catch {
      return wrapTextWithAnsi(text, width).map((line) => `    ${line}`);
    }
  }

};
}

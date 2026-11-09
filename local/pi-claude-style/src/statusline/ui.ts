import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { onLeftClick } from "../clickable.ts";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { mutedEllipsis } from "../ellipsis.ts";
import type { StatusLineCommandConfig, StatusLinePlacement } from "./types.ts";

const UI_KEY = "pi-statusline";

function padLines(lines: string[], padding: number): string[] {
  const pad = " ".repeat(Math.max(0, padding));
  return lines.length === 0 ? [""] : lines.map((line) => `${pad}${line}`);
}

/**
 * A tab separates a flexible left column from a right-aligned column.
 * Alignment belongs here—not in the shell command—because only the TUI renderer
 * knows the actual width after resize.
 */
interface RenderedLine {
  line: string;
  rightStart?: number;
}

function renderLine(line: string, maxWidth: number, ellipsis = "…"): RenderedLine {
  const tabIndex = line.indexOf("\t");
  if (tabIndex < 0) {
    return { line: truncateToWidth(line, Math.max(0, maxWidth), ellipsis) };
  }

  const left = line.slice(0, tabIndex).trimEnd();
  const right = line.slice(tabIndex + 1).trimStart();
  const rightWidth = visibleWidth(right);

  if (rightWidth >= maxWidth) {
    return {
      line: truncateToWidth(right, Math.max(0, maxWidth), ellipsis),
      rightStart: 0,
    };
  }

  const maxLeftWidth = Math.max(0, maxWidth - rightWidth - 1);
  const renderedLeft = truncateToWidth(left, maxLeftWidth, ellipsis);
  const gap = Math.max(1, maxWidth - visibleWidth(renderedLeft) - rightWidth);
  const rightStart = visibleWidth(renderedLeft) + gap;
  return {
    line: `${renderedLeft}${" ".repeat(gap)}${right}`,
    rightStart,
  };
}

export function clearStatusLineUi(ctx: any, placement: StatusLinePlacement): void {
  if (placement === "widget") {
    ctx.ui.setWidget(UI_KEY, undefined);
    return;
  }
  ctx.ui.setFooter(undefined);
}

/**
 * Route a click to whichever contributed row was under it.
 *
 * `onClickRow` is given the index *within the contributed rows*, so the
 * command's own rows — which nobody has claimed an action for — simply fall
 * outside the range and leave the click unused.
 */
function clickHandler(
  commandRowCount: number,
  padding: number,
  onClickRow?: (index: number) => boolean,
  onClickInline?: (
    row: number,
    column: number,
    layout?: { rightStart?: number },
  ) => boolean,
  renderedLines?: RenderedLine[],
): ((row: number, col: number) => boolean) | undefined {
  if (!onClickRow && !onClickInline) return undefined;
  return (row: number, col: number) => {
    // The command's own rows carry interactive slot/inline segments.
    // `padLines` shifts every row right, so the column has to come back.
    if (row < commandRowCount) {
      const rendered = renderedLines?.[row];
      return onClickInline?.(
        row,
        col - padding,
        rendered?.rightStart === undefined
          ? rendered
          : { rightStart: rendered.rightStart - padding },
      ) === true;
    }
    const index = row - commandRowCount;
    return index >= 0 && onClickRow?.(index) === true;
  };
}

export function applyStatusLineUi(
  ctx: any,
  config: StatusLineCommandConfig,
  lines: string[],
  options?: {
    commandRowCount?: number;
    onClickRow?: (index: number) => boolean;
    onClickInline?: (
      row: number,
      column: number,
      layout?: { rightStart?: number },
    ) => boolean;
    onMount?: (tui: TUI) => void;
  },
): void {
  const padding = config.padding ?? 0;
  const padded = padLines(lines, padding);
  const ellipsis = ctx.ui?.theme ? mutedEllipsis(ctx.ui.theme) : "…";
  const renderedLines: RenderedLine[] = [];
  const click = clickHandler(
    options?.commandRowCount ?? padded.length,
    padding,
    options?.onClickRow,
    options?.onClickInline,
    renderedLines,
  );
  const renderLines = (width: number): string[] => padded.map((line, index) => {
    const rendered = renderLine(line, width, ellipsis);
    renderedLines[index] = rendered;
    return rendered.line;
  });

  if (config.placement === "widget") {
    ctx.ui.setWidget(
      UI_KEY,
      (tui: TUI) => {
        options?.onMount?.(tui);
        return {
          render(width: number) {
            return renderLines(width);
          },
          invalidate() {
            // static until next refresh
          },
          ...(click ? { handleMouse: (event: TuiMouseEvent) => onLeftClick(event, click) } : {}),
        };
      },
      { placement: config.widgetPlacement ?? "belowEditor" },
    );
    return;
  }

  ctx.ui.setWidget(UI_KEY, undefined);
  ctx.ui.setFooter((tui: TUI) => {
    options?.onMount?.(tui);
    return {
      render(width: number) {
        return renderLines(width);
      },
      ...(click ? { handleMouse: (event: TuiMouseEvent) => onLeftClick(event, click) } : {}),
      invalidate() {
        // static until next refresh
      },
    };
  });
}

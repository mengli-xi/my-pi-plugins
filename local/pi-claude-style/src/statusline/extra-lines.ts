import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
export { STATUS_LINE_ROW_CHANNEL } from "../integration-contracts.ts";

/**
 * Rows other extensions contribute to the statusline.
 *
 * The command owns the statusline, and it is a shell script: anything it would
 * have to compute from the session — a goal's elapsed time and the tokens it
 * has billed, say — it would have to re-derive by parsing the session file,
 * which is exactly the work the extension that already tracks it has done.
 *
 * So an extension can hand a finished row over instead. The rows are appended
 * under the command's own, ordered by optional priority then first arrival, and they go
 * through the same renderer — including the tab that right-aligns everything
 * after it, so a contributor asks for that by prefixing its line with one.
 *
 * The emit is answered synchronously (`reply`), which is how a contributor
 * finds out whether this extension is loaded at all rather than emitting into
 * the void and silently losing its row.
 */

export interface StatusLineRowPayload {
  /** Identifies the contributor, so it can replace or withdraw its row. */
  key: string;
  /** The row, or undefined to withdraw it. A leading tab right-aligns it. */
  line?: string;
  /**
   * `row` (the default) appends the line under the command's own rows.
   *
   * `inline` splices it into one of the command's own rows instead — so a
   * short thing like a count joins a row already on screen rather than
   * spending a row of its own.
   *
   * `slot` fills a `[[pi:slot:<key>]]` marker the command printed wherever it
   * wants the segment — the only placement that can sit *between* the
   * command's own fields. The command decides where; the contributor decides
   * what. A marker with no contributor (and one leading space, if present) is
   * stripped, so an absent contributor costs nothing. Slots on either side of
   * the tab can carry `onClick`; right-column coordinates are resolved after
   * render knows the terminal width.
   */
  placement?: "row" | "inline" | "slot";
  /**
   * Which command row an inline segment joins, 1-based. Defaults to 1 and is
   * clamped to the rows the command actually printed, so a contributor
   * targeting row 3 of a two-row command lands on row 2 instead of nowhere.
   */
  row?: number;
  /**
   * Which side of an inline row: `left` (the default) splices before the tab
   * that right-aligns the rest; `right` appends after the row's right-aligned
   * content. Right-aligned click spans remain relative to that column until
   * render resolves its actual screen position.
   */
  align?: "left" | "right";
  /** Finite priorities sort ascending before unnumbered peers in the same row/align group; slots ignore this. */
  order?: number;
  /**
   * Called when the row is clicked. Return true to consume the click.
   *
   * The contributor is the only side that knows what its row means, so it is
   * the side that decides what clicking one does. A row without this is inert,
   * which is what every row was before.
   */
  onClick?: () => boolean;
  /** Called synchronously when this extension took the row. */
  reply?: (accepted: true) => void;
}

function isPayload(value: unknown): value is StatusLineRowPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { key?: unknown }).key === "string" &&
    (value as { key: string }).key.length > 0
  );
}

interface ContributedRow {
  line: string;
  placement: "row" | "inline" | "slot";
  row: number;
  align: "left" | "right";
  order?: number;
  onClick?: () => boolean;
}

/** Where an interactive command-row segment landed, so a click can find it. */
export interface InlineSpan {
  from: number;
  to: number;
  align?: "left" | "right";
  onClick?: () => boolean;
}

/** Matches the separator the statusline command uses between its own fields. */
export const INLINE_SEPARATOR = " │ ";

/**
 * A command can cap a slot without taking ownership of its text or click
 * action: `[[pi:slot:path-short@18]]`. The suffix is deliberately part of the
 * internal marker protocol rather than the contributed-row payload because
 * the command is the side that knows the complete row budget.
 */
function parseSlotReference(reference: string): { key: string; maxWidth?: number } {
	const match = reference.match(/^(.*)@([1-9][0-9]*)$/);
	if (!match) return { key: reference };
	return {
		key: match[1]!,
		maxWidth: Math.min(10_000, Number(match[2])),
	};
}

export class ContributedRows {
  private readonly rows = new Map<string, ContributedRow>();

  /**
   * Take a row. Returns true when the set changed, so the caller only
   * re-renders when there is something new to draw.
   */
  handle(payload: unknown): boolean {
    if (!isPayload(payload)) return false;

    const { key, line, onClick } = payload;
    if (line === undefined) {
      const removed = this.rows.delete(key);
      payload.reply?.(true);
      return removed;
    }

    const placement =
      payload.placement === "inline" || payload.placement === "slot"
        ? payload.placement
        : "row";
    const row = Math.max(1, Math.floor(payload.row ?? 1));
    const align = payload.align === "right" ? "right" : "left";
    const order = typeof payload.order === "number" && Number.isFinite(payload.order) ? payload.order : undefined;
    const previous = this.rows.get(key);
    // A handler that changed with an unchanged line still has to be stored —
    // it closes over whatever the contributor knew when it sent — but it is
    // not a reason to redraw, since nothing on screen moved.
    const changed =
      previous?.line !== line ||
      previous?.placement !== placement ||
      previous?.row !== row ||
      previous?.align !== align ||
      (placement !== "slot" && previous?.order !== order);
    this.rows.set(key, { line, placement, row, align, order, onClick });

    payload.reply?.(true);
    return changed;
  }

  private ordered(placement: "row" | "inline" | "slot"): ContributedRow[] {
    const rows = [...this.rows.values()].filter((row) => row.placement === placement);
    if (placement === "slot") return rows;
    // Stable sort preserves first-key arrival for equal orders and unnumbered peers.
    // Inline layout subsequently selects each actual (clamped row, align) group.
    return rows.sort((a, b) => a.order === undefined ? (b.order === undefined ? 0 : 1)
      : b.order === undefined ? -1 : a.order - b.order);
  }

  /**
   * Fill `[[pi:slot:<key>]]` markers in the command's rows with the matching
   * slot contributions. An unfilled marker is stripped along with one space
   * directly before it, so a command can write `foo [[pi:slot:x]]` and an
   * absent contributor leaves exactly `foo`.
   */
  substituteSlots(commandRows: string[]): string[] {
    return this.composeSlots(commandRows).lines;
  }

  /** Fill slots and retain the screen columns occupied by left-column slots. */
  composeSlots(commandRows: string[]): { lines: string[]; spans: InlineSpan[][] } {
    const slots = new Map(
      [...this.rows.entries()].filter(([, row]) => row.placement === "slot"),
    );
    const spans: InlineSpan[][] = commandRows.map(() => []);
    const lines = commandRows.map((source, rowIndex) => {
      let rendered = "";
      let cursor = 0;
      for (const match of source.matchAll(/ ?\[\[pi:slot:([^\]]+)\]\]/g)) {
        const index = match.index;
        rendered += source.slice(cursor, index);
        const { key, maxWidth } = parseSlotReference(match[1]!);
        const slot = slots.get(key);
        if (slot?.line) {
          const slotLine = maxWidth === undefined
            ? slot.line
            : truncateToWidth(slot.line, maxWidth, "…");
          if (match[0].startsWith(" ")) rendered += " ";
          const tab = rendered.indexOf("\t");
          const from = tab < 0
            ? visibleWidth(rendered)
            : visibleWidth(rendered.slice(tab + 1).trimStart());
          const to = from + visibleWidth(slotLine);
          // Resolve the current handler by key. Contributors may refresh a
          // closure without changing text, which intentionally avoids a
          // redraw but must still update what a click invokes.
          spans[rowIndex]!.push({
            from,
            to,
            ...(tab < 0 ? {} : { align: "right" as const }),
            onClick: () => this.rows.get(key)?.onClick?.() === true,
          });
          rendered += slotLine;
        }
        cursor = index + match[0].length;
      }
      return rendered + source.slice(cursor);
    });
    return { lines, spans };
  }

  /** Appended rows ordered by priority, then original arrival. */
  lines(): string[] {
    return this.ordered("row").map((row) => row.line);
  }

  /**
   * The handler for the nth appended row, if it has one.
   *
   * Index rather than key: a click arrives as a screen row, and the caller
   * knows how many rows the command drew above these.
   */
  clickHandlerAt(index: number): (() => boolean) | undefined {
    return this.ordered("row")[index]?.onClick;
  }

  /**
   * Splice the inline contributions into the command's rows.
   *
   * Left-aligned segments go at the end of a row's left column — before the
   * tab, where the command puts everything it right-aligns — so they read as
   * one more field on a row of fields rather than as something bolted on.
   * Right-aligned segments append after the row's right-aligned content.
   *
   * A contributor's target row is clamped to the rows the command printed.
   * Returns each segment's visible-width span. Left spans are absolute within
   * the row; right spans remain relative to the right column until render
   * resolves that column's terminal position.
   */
  spliceInline(
    commandRows: string[],
    separator: string = INLINE_SEPARATOR,
  ): { lines: string[]; spans: InlineSpan[][] } {
    const inline = this.ordered("inline");
    const lines = [...commandRows];
    if (lines.length === 0) lines.push("");
    const spans: InlineSpan[][] = lines.map(() => []);
    if (inline.length === 0) return { lines, spans };

    for (let index = 0; index < lines.length; index++) {
      const targets = inline.filter(
        (row) => Math.min(row.row, lines.length) === index + 1,
      );
      if (targets.length === 0) continue;

      const source = lines[index];
      const tab = source.indexOf("\t");
      let left = tab < 0 ? source : source.slice(0, tab);
      let rest = tab < 0 ? "" : source.slice(tab);

      for (const row of targets.filter((r) => r.align === "left")) {
        // An empty left column (e.g. an unfilled slot stripped away) takes
        // the first segment bare rather than behind a dangling separator.
        const prefix = visibleWidth(left) > 0 ? separator : "";
        const at = visibleWidth(left) + visibleWidth(prefix);
        left += `${prefix}${row.line}`;
        spans[index].push({ from: at, to: visibleWidth(left), onClick: row.onClick });
      }
      for (const row of targets.filter((r) => r.align === "right")) {
        // The renderer right-aligns everything after the tab; retain offsets
        // inside that column so the final screen span can be resolved after
        // render has chosen its actual starting column.
        if (!rest) rest = "\t";
        const prefix = rest === "\t" ? "" : separator;
        const at = visibleWidth(rest.slice(1).trimStart()) + visibleWidth(prefix);
        rest += `${prefix}${row.line}`;
        spans[index].push({
          from: at,
          to: at + visibleWidth(row.line),
          align: "right",
          onClick: row.onClick,
        });
      }
      lines[index] = `${left}${rest}`;
    }
    return { lines, spans };
  }

  clear(): void {
    this.rows.clear();
  }
}

import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ProcessState, ProcessSummary } from "../domain/types.js";
import type { ProcessHost } from "../host/process-host.js";

interface HitSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: "toggle" | "process" | "overflow";
  readonly id?: string;
}

function stripRecords(records: readonly ProcessSummary[]): ProcessSummary[] {
  return [...records].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id));
}

export interface StripLayout {
  readonly line: string;
  readonly hits: readonly HitSpan[];
}

function append(layout: { line: string; hits: HitSpan[] }, text: string, hit?: Omit<HitSpan, "start" | "end">): void {
  const start = visibleWidth(layout.line);
  layout.line += text;
  if (hit) layout.hits.push({ start, end: visibleWidth(layout.line), ...hit });
}

function alignRight(layout: { line: string; hits: HitSpan[] }, width: number): StripLayout {
  const padding = Math.max(0, width - visibleWidth(layout.line));
  return {
    line: `${" ".repeat(padding)}${layout.line}`,
    hits: layout.hits.map((hit) => ({ ...hit, start: hit.start + padding, end: hit.end + padding })),
  };
}

export function layoutProcessStrip(
  records: readonly ProcessSummary[],
  collapsed: boolean,
  width: number,
): StripLayout {
  const visible = stripRecords(records);
  if (visible.length === 0 || width < 2) return { line: "", hits: [] };
  const layout = { line: "", hits: [] as HitSpan[] };
  append(layout, "ps", { kind: "toggle" });

  if (collapsed) {
    const count = ` · ${visible.length}`;
    if (visibleWidth(layout.line) + visibleWidth(count) <= width) append(layout, count);
    return alignRight(layout, width);
  }

  let shown = 0;
  for (let index = 0; index < visible.length; index += 1) {
    const record = visible[index]!;
    const token = ` · ${record.name}`;
    const remaining = visible.length - (index + 1);
    const overflow = remaining > 0 ? ` · +${remaining}` : "";
    if (visibleWidth(layout.line) + visibleWidth(token) + visibleWidth(overflow) > width) break;
    append(layout, token, { kind: "process", id: record.id });
    shown += 1;
  }
  const hidden = visible.length - shown;
  if (hidden > 0) {
    const overflow = ` · +${hidden}`;
    if (visibleWidth(layout.line) + visibleWidth(overflow) <= width) {
      append(layout, overflow, { kind: "overflow" });
    }
  }
  return alignRight(layout, width);
}

type UiTheme = ExtensionContext["ui"]["theme"];

const ANSI_DIM = "\x1b[2m";
const ANSI_NORMAL_INTENSITY = "\x1b[22m";

function stateTone(state: ProcessState): ThemeColor {
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "killed" || state === "crashed") return "error";
  if (state === "stopped") return "muted";
  return "customMessageLabel";
}

function paintStrip(layout: StripLayout, records: readonly ProcessSummary[], theme: UiTheme): string {
  const byId = new Map(records.map((record) => [record.id, record]));
  const processHits = layout.hits
    .filter((hit): hit is HitSpan & { id: string } => hit.kind === "process" && typeof hit.id === "string")
    .sort((left, right) => left.start - right.start);
  let painted = "";
  let cursor = 0;
  for (const hit of processHits) {
    painted += theme.fg("muted", layout.line.slice(cursor, hit.start));
    const token = layout.line.slice(hit.start, hit.end);
    const separator = token.startsWith(" · ") ? " · " : "";
    const label = token.slice(separator.length);
    const record = byId.get(hit.id);
    painted += theme.fg("muted", separator);
    painted += record
      ? `${ANSI_DIM}${theme.fg(stateTone(record.state), label)}${ANSI_NORMAL_INTENSITY}`
      : theme.fg("muted", label);
    cursor = hit.end;
  }
  painted += theme.fg("muted", layout.line.slice(cursor));
  return painted;
}

export class ProcessStrip implements Component {
  readonly #host: ProcessHost;
  readonly #openProcess: (id?: string) => void;
  readonly #theme?: UiTheme;
  #last?: StripLayout;

  constructor(host: ProcessHost, openProcess: (id?: string) => void, theme?: UiTheme) {
    this.#host = host;
    this.#openProcess = openProcess;
    this.#theme = theme;
  }

  render(width: number): string[] {
    const records = this.#host.stripRecords();
    this.#last = layoutProcessStrip(records, this.#host.stripCollapsed, width);
    if (!this.#last.line) return [];
    return [this.#theme ? paintStrip(this.#last, records, this.#theme) : this.#last.line];
  }

  /** Standalone navigation belongs after spinner continuation rows. */

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Pi dispatches a press followed by release/click; navigate only once.
    if (event.type !== "press" || event.button !== "left") return undefined;
    return this.handleClick(event.y, event.x) ? { handled: true, render: true } : undefined;
  }

  handleClick(row: number, col: number): boolean {
    if (row !== 0 || !this.#last) return false;
    const hit = this.#last.hits.find((item) => col >= item.start && col < item.end);
    if (!hit) return false;
    if (hit.kind === "toggle") this.#host.toggleStripCollapsed();
    else this.#openProcess(hit.id);
    return true;
  }

  invalidate(): void {
    this.#last = undefined;
  }
}

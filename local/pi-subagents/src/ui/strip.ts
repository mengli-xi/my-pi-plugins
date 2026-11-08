import { visibleWidth, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ProcessMainBindingV1 } from "../host/process-service.js";
import { agentPresentation, type AgentCounts } from "./agent-presentation.js";
export type StripCountsV1 = AgentCounts;
export function subagentStripCountsV1(binding: ProcessMainBindingV1): StripCountsV1 {
  const snapshot = binding.host.snapshot();
  const execution = new Map(snapshot.agents.flatMap(item => {
    const resident = binding.runtime.residency?.(item.agent.agent_id);
    return resident ? [[item.agent.agent_id, resident] as const] : [];
  }));
  return agentPresentation(snapshot, execution).counts;
}
export function layoutSubagentStripV1(counts: StripCountsV1, width: number): string {
  if (!counts.agents) return "";
  const base = [`agents ${counts.agents}`, ...(counts.unread ? [`unread ${counts.unread}`] : [])];
  const extras = [counts.running ? `running ${counts.running}` : "", counts.waiting ? `waiting ${counts.waiting}` : "", counts.queued ? `queued ${counts.queued}` : "", counts.closing ? `closing ${counts.closing}` : ""].filter(Boolean);
  const full = [`agents ${counts.agents}`, ...extras, ...(counts.unread ? [`unread ${counts.unread}`] : [])].join(" · ");
  if (full.length <= width) return full;
  while (extras.length && [...base.slice(0,1), ...extras, ...base.slice(1)].join(" · ").length > width) extras.pop();
  const text = [...base.slice(0,1), ...extras, ...base.slice(1)].join(" · ");
  return text.length <= width ? text : text.slice(0, Math.max(0,width-1)) + "…";
}
export class SubagentStripV1 implements Component {
  readonly #binding: ProcessMainBindingV1 | (() => ProcessMainBindingV1 | undefined);
  readonly #open: () => void;
  readonly #theme: Theme;
  #last = "";
  #width = 0;
  #timer: NodeJS.Timeout;

  constructor(tui: TUI, theme: Theme, binding: ProcessMainBindingV1 | (() => ProcessMainBindingV1 | undefined), open: () => void) {
    this.#theme = theme;
    this.#binding = binding;
    this.#open = open;
    this.#timer = setInterval(() => {
      if (this.#text(this.#width) !== this.#last) tui.requestRender();
    }, 250);
    this.#timer.unref?.();
  }

  #text(width: number): string {
    const binding = typeof this.#binding === "function" ? this.#binding() : this.#binding;
    return binding ? layoutSubagentStripV1(subagentStripCountsV1(binding), width) : "";
  }

  render(width: number): string[] {
    const text = this.#text(width);
    this.#last = text;
    this.#width = width;
    if (!text) return [];
    const pad = " ".repeat(Math.max(0, width - visibleWidth(text)));
    return [this.#theme.fg("muted", `${pad}${text}`)];
  }

  handleClick(row: number, col: number): boolean {
    if (row !== 0 || !this.#last || col >= this.#width) return false;
    const start = this.#width - visibleWidth(this.#last);
    if (col < start) return false;
    this.#open();
    return true;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Pi synthesizes click after release; activate once on the left press, as regular does.
    if (event.type !== "press" || event.button !== "left") return undefined;
    return this.handleClick(event.y, event.x) ? { handled: true } : undefined;
  }

  invalidate(): void { this.#last = ""; }
  dispose(): void { clearInterval(this.#timer); }
}

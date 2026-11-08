import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProcessMainBindingV1 } from "../host/process-service.js";

import { subagentStripCountsV1, layoutSubagentStripV1 } from "./strip.js";

const STATUS_LINE_ROW_CHANNEL = "statusline:row";
const STATUS_LINE_KEY = "subagents";

interface StatusLineRowPayloadV1 {
  readonly key: string;
  readonly line?: string;
  readonly placement?: "row" | "inline" | "slot";
  readonly row?: number;
  readonly align?: "left" | "right";
  readonly onClick?: () => boolean;
  readonly reply?: (accepted: true) => void;
}

export class SubagentStatuslinePublisherV1 {
  readonly #pi: ExtensionAPI;
  readonly #ctx: ExtensionContext;
  readonly #binding: ProcessMainBindingV1 | (() => ProcessMainBindingV1 | undefined);
  readonly #open: () => void;
  readonly #timer: ReturnType<typeof setInterval>;
  #lastTuple: string | undefined;
  #accepted = false;
  #disposed = false;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext, binding: ProcessMainBindingV1 | (() => ProcessMainBindingV1 | undefined), open: () => void) {
    this.#pi = pi;
    this.#ctx = ctx;
    this.#binding = binding;
    this.#open = open;
    this.#timer = setInterval(() => this.publish(), 500);
    this.#timer.unref?.();
    this.publish();
  }

  publish(): void {
    if (this.#disposed) return;
    try { this.#publish(); }
    catch {
      // A replacement invalidates the old public Pi API. A late UI tick must
      // retire its timer rather than throw out of the process event loop.
      this.#disposed = true;
      clearInterval(this.#timer);
    }
  }

  #publish(): void {
    const binding = typeof this.#binding === "function" ? this.#binding() : this.#binding;
    const counts = binding ? subagentStripCountsV1(binding) : undefined;
    const count = counts?.agents ?? 0;
    const tuple = JSON.stringify([binding?.host.host_revision, counts, process.stdout.columns]);
    if (tuple === this.#lastTuple && this.#accepted) return;
    this.#lastTuple = tuple;
    this.#accepted = false;
    const payload: StatusLineRowPayloadV1 = {
      key: STATUS_LINE_KEY,
      placement: "inline",
      row: 3,
      align: "left",
      ...(count > 0 ? {
        line: this.#ctx.ui.theme.fg("muted", layoutSubagentStripV1(counts!, process.stdout.columns ?? 120)),
        onClick: () => { this.#open(); return true; },
      } : {}),
      reply: () => { this.#accepted = true; },
    };
    this.#pi.events.emit(STATUS_LINE_ROW_CHANNEL, payload);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#timer);
    // Withdrawal is best-effort after replacement; the new runtime owns its row.
    try { this.#pi.events.emit(STATUS_LINE_ROW_CHANNEL, { key: STATUS_LINE_KEY } satisfies StatusLineRowPayloadV1); }
    catch { /* The outgoing public API may already be invalidated. */ }
  }
}

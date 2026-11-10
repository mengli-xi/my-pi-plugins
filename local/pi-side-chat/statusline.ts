import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CacheObservation } from "./cache-observation.ts";

/** Copied contract owned by pi-claude-style; see docs/pi/events.md. */
const STATUS_LINE_ROW_CHANNEL = "statusline:row";
const STATUS_LINE_ROW_KEY = "side-chat";
const FALLBACK_WIDGET_KEY = "side-chat-status";
/** A second key, because one statusline key may have only one producer. */
const BTW_ROW_KEY = "side-chat-btw";
const BTW_FALLBACK_STATUS_KEY = "pi-side-chat:btw";

/** The pending line also tells the user how to stop the request. */
export const BTW_PENDING_LINE = "BTW\u2026 \u00b7 /btw cancel";

export type SideCacheState = CacheObservation | { status: "pending" } | { status: "persisted" };

interface StatusLineRowPayload {
  key: string;
  line?: string;
  placement: "inline";
  row: 3;
  align: "left";
  reply?: (accepted: true) => void;
}

function tokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatSideStatus(cache: SideCacheState): string {
  if (cache.status === "pending") return "Side · ephemeral · cache pending";
  if (cache.status === "persisted") return "Side · ephemeral · cache unknown (persisted context)";
  if (cache.status === "unknown") return "Side · ephemeral · cache unknown";
  if (cache.status === "hit") {
    return `Side · ephemeral · cache hit ${tokens(cache.cacheRead)}/${tokens(cache.promptTokens)}`;
  }
  return `Side · ephemeral · cache miss 0/${tokens(cache.promptTokens)}`;
}

export function publishSideStatus(
  pi: Pick<ExtensionAPI, "events">,
  ctx: Pick<ExtensionContext, "ui">,
  cache: SideCacheState,
): boolean {
  const plain = formatSideStatus(cache);
  let accepted = false;
  const payload: StatusLineRowPayload = {
    key: STATUS_LINE_ROW_KEY,
    line: ctx.ui.theme.fg("muted", plain),
    placement: "inline",
    row: 3,
    align: "left",
    reply: () => { accepted = true; },
  };
  pi.events.emit(STATUS_LINE_ROW_CHANNEL, payload);
  ctx.ui.setWidget(FALLBACK_WIDGET_KEY, accepted ? undefined : [plain], { placement: "belowEditor" });
  return accepted;
}

export function withdrawSideStatus(
  pi: Pick<ExtensionAPI, "events">,
  ctx: Pick<ExtensionContext, "ui"> | undefined,
): void {
  const payload: StatusLineRowPayload = {
    key: STATUS_LINE_ROW_KEY,
    line: undefined,
    placement: "inline",
    row: 3,
    align: "left",
  };
  pi.events.emit(STATUS_LINE_ROW_CHANNEL, payload);
  ctx?.ui.setWidget(FALLBACK_WIDGET_KEY, undefined);
}

/** Shows and hides one BTW request's pending state. */
export interface BtwStatusSurface {
  show(ctx: BtwStatusContext): void;
  clear(ctx: BtwStatusContext): void;
}

type BtwStatusContext = { ui: Pick<ExtensionContext["ui"], "setStatus" | "theme"> };

function btwRowPayload(line: string | undefined): StatusLineRowPayload {
  return { key: BTW_ROW_KEY, line, placement: "inline", row: 3, align: "left" };
}

/**
 * BTW pending state for the statusline.
 *
 * Pi's own footer draws `setStatus`, but the Claude Style footer draws only the
 * rows it was given, so under that profile a native status is invisible. So the
 * request contributes a row of its own and keeps `setStatus` for the profiles
 * where no row host answers. Withdrawing clears both, whichever one was drawn.
 */
export function createBtwStatus(pi?: Pick<ExtensionAPI, "events">): BtwStatusSurface {
  return {
    show(ctx) {
      let accepted = false;
      if (pi) {
        pi.events.emit(STATUS_LINE_ROW_CHANNEL, {
          ...btwRowPayload(ctx.ui.theme.fg("muted", BTW_PENDING_LINE)),
          reply: () => { accepted = true; },
        } satisfies StatusLineRowPayload);
      }
      ctx.ui.setStatus(BTW_FALLBACK_STATUS_KEY, accepted ? undefined : BTW_PENDING_LINE);
    },
    clear(ctx) {
      pi?.events.emit(STATUS_LINE_ROW_CHANNEL, btwRowPayload(undefined));
      ctx.ui.setStatus(BTW_FALLBACK_STATUS_KEY, undefined);
    },
  };
}

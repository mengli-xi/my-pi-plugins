/**
 * pi-fast — `/fast`, a Claude Code-style fast-output toggle for the OpenAI
 * Codex (ChatGPT OAuth) provider.
 *
 * While on, every request the agent sends through the `openai-codex`
 * provider carries `service_tier: "priority"`. Login itself is pi's own
 * `/login` — this package adds nothing to auth; it rides the session the
 * built-in provider already holds.
 *
 * Two scopes: `/fast` (and `/fast on|off`) is a branch-aware **session
 * override** persisted as a custom session entry; `/fast all` (and `/fast all
 * on|off`) sets the **global default** in `getAgentDir()/pi-fast.json`, which
 * every session without an override follows — the file is re-read per
 * request, so a running session picks up another session's `/fast all` on its
 * next request.
 *
 * See state.ts for the injection and persistence rules.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  applyFastTier,
  CODEX_PROVIDER,
  defaultStatePath,
  FAST_TIER,
  loadEnabled,
  restoreSessionOverride,
  saveEnabled,
  SESSION_STATE_ENTRY_TYPE,
  type FastSessionStateEntry,
} from "./state.js";

const MODES = ["on", "off", "all", "status"] as const;
type Mode = (typeof MODES)[number];

/**
 * pi-claude-style's statusline contribution channel. This package fills the
 * `[[pi:slot:fast]]` marker the statusline command prints in its model group:
 * yellow ⚡ when this session is fast and dim ⚡ when supported but off. The
 * slot is withdrawn when the current model cannot use fast mode. A slot update
 * redraws immediately without re-running the command — and because it is
 * per-emitter, it carries *this session's* effective state, which a shared file
 * could not.
 * Contract: ../pi-claude-style/docs/statusline-provenance.md. With pi-claude-style
 * absent the emit is a silent no-op and the marker is never rendered.
 */
const STATUS_LINE_ROW_CHANNEL = "statusline:row";
const SLOT_KEY = "fast";
const ICON_ON = "\u001b[33m⚡\u001b[0m";
const ICON_OFF = "\u001b[90m⚡\u001b[0m";

export default function piFast(pi: ExtensionAPI): void {
  const statePath = defaultStatePath();
  /** This session's override; undefined means "follow the global default". */
  let sessionOverride: boolean | undefined;

  const globalEnabled = (): boolean => loadEnabled(statePath);
  const effective = (): boolean => sessionOverride ?? globalEnabled();

  pi.on("before_provider_request", (event, ctx) =>
    applyFastTier(event.payload, ctx.model?.provider, effective()),
  );

  const publishSlot = (providerId: string | undefined): void => {
    pi.events.emit(STATUS_LINE_ROW_CHANNEL, {
      key: SLOT_KEY,
      placement: "slot",
      line:
        providerId === CODEX_PROVIDER
          ? effective()
            ? ICON_ON
            : ICON_OFF
          : undefined,
    });
  };

  const restoreFromBranch = (ctx: ExtensionContext): void => {
    sessionOverride = restoreSessionOverride(ctx.sessionManager.getBranch());
    publishSlot(ctx.model?.provider);
  };

  pi.on("session_start", (_event, ctx) => restoreFromBranch(ctx));
  pi.on("session_tree", (_event, ctx) => restoreFromBranch(ctx));
  pi.on("model_select", (event) => publishSlot(event.model.provider));
  // Another session's `/fast all` rewrites the global file. Injection reads
  // the file per request and needs nothing here; this keeps the *icon* in
  // step without a dedicated cross-session channel.
  pi.on("agent_start", (_event, ctx) => publishSlot(ctx.model?.provider));

  const describe = (ctx: ExtensionCommandContext): string => {
    const on = effective();
    const scope =
      sessionOverride === undefined
        ? `following the all-sessions default (${globalEnabled() ? "on" : "off"})`
        : `this session only; all-sessions default is ${globalEnabled() ? "on" : "off"}`;
    const state = on ? `on — requests go out with service_tier: ${FAST_TIER}` : "off";
    if (on && ctx.model && ctx.model.provider !== CODEX_PROVIDER) {
      return `Fast mode is ${state} (${scope}), but the current model (${ctx.model.id}) is not on ${CODEX_PROVIDER}, so it has no effect until you switch back.`;
    }
    return `Fast mode is ${state} (${scope}).`;
  };

  const finish = (ctx: ExtensionCommandContext): void => {
    publishSlot(ctx.model?.provider);
    ctx.ui.notify(describe(ctx), "info");
  };

  const setSession = (next: boolean, ctx: ExtensionCommandContext): void => {
    sessionOverride = next;
    pi.appendEntry<FastSessionStateEntry>(SESSION_STATE_ENTRY_TYPE, { enabled: next });
    finish(ctx);
  };

  const setAll = (next: boolean, ctx: ExtensionCommandContext): void => {
    try {
      saveEnabled(statePath, next);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to save fast default to ${statePath}: ${reason}. Session override unchanged.`, "error");
      return;
    }
    // `all` speaks for every session, this one included: drop the override
    // rather than leaving this session pinned to a stale choice. Persist the
    // clear marker so an older override does not return after runtime reload.
    sessionOverride = undefined;
    pi.appendEntry<FastSessionStateEntry>(SESSION_STATE_ENTRY_TYPE, { enabled: null });
    finish(ctx);
  };

  pi.registerCommand("fast", {
    description:
      "Toggle fast mode (priority tier on OpenAI Codex) — this session; `all` for every session",

    getArgumentCompletions: (prefix: string) => {
      const query = prefix.trim().toLowerCase();
      const items = (
        query.startsWith("all") && query !== "all"
          ? ["all on", "all off"]
          : [...MODES, "all on", "all off"]
      )
        .filter((mode) => mode.startsWith(query))
        .map((mode) => ({ value: mode, label: mode }));
      return items.length > 0 ? items : null;
    },

    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const query = args.trim().toLowerCase().replace(/\s+/g, " ");

      if (query === "") {
        setSession(!effective(), ctx);
        return;
      }
      if (query === "status") {
        ctx.ui.notify(describe(ctx), "info");
        return;
      }
      if (query === "on" || query === "off") {
        setSession(query === "on", ctx);
        return;
      }
      if (query === "all") {
        setAll(!globalEnabled(), ctx);
        return;
      }
      if (query === "all on" || query === "all off") {
        setAll(query === "all on", ctx);
        return;
      }
      ctx.ui.notify(
        `Unknown argument "${args.trim()}" — use on, off, all, all on, all off, status.`,
        "warning",
      );
    },
  });
}

export type { Mode };

import { captureChildFactoryV1, captureEntrypointDescriptorV1, getOrCreateChildCapabilityRegistryV1, type ChildCapabilityBindingHandleV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { join } from "node:path";
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
} from "./state.ts";

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

  const registry = getOrCreateChildCapabilityRegistryV1();
  const target = { child_entrypoint: captureEntrypointDescriptorV1(join(import.meta.dirname, "child.ts")),
    child_factory: captureChildFactoryV1(join(import.meta.dirname, "index.ts"), { module: "child.ts", export: "createFastChildFactory", artifacts: ["state.ts"] }),
    activation: "mirror" as const, commands: [], tools: [], providers: [], hooks: [], requires: [] };
  const registration = registry.register({ version: 1, manifest: { version: 1, owner_id: "pi-fast", main_entrypoint: captureEntrypointDescriptorV1(join(import.meta.dirname, "index.ts")), targets: { "pi-subagents": target, "pi-side-chat": target } } });
  const bindings = new Map<string, ChildCapabilityBindingHandleV1>();
  let generation = 0;
  const bindSession = (ctx: ExtensionContext): void => {
    const sessionId = ctx.sessionManager.getSessionId();
    const bind = (): ChildCapabilityBindingHandleV1 => registry.bind({ version: 1,
      registrationToken: registration.registrationToken, session_id: sessionId, runtime_generation: ++generation,
      mode: ctx.mode === "json" ? "print" : ctx.mode, capture_context: () => ({ enabled: effective() }) });
    try {
      // Bind first: another registration instance may already own the session, so
      // only release our own handle after proving the replacement was accepted.
      const binding = bind();
      bindings.get(sessionId)?.release();
      bindings.set(sessionId, binding);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("runtime generation must replace the current binding")) {
        ctx.ui.notify(`Fast child capability unavailable: ${message}`, "warning");
        return;
      }
      const previous = bindings.get(sessionId);
      if (!previous) { ctx.ui.notify(`Fast child capability unavailable: ${message}`, "warning"); return; }
      // Cross-instance stale generation: release the previous handle and retry once.
      previous.release();
      bindings.delete(sessionId);
      try { bindings.set(sessionId, bind()); }
      catch (retry) { ctx.ui.notify(`Fast child capability unavailable: ${retry instanceof Error ? retry.message : String(retry)}`, "warning"); }
    }
  };
  pi.on("session_start", (_event, ctx) => bindSession(ctx));
  pi.on("session_shutdown", () => {
    for (const binding of bindings.values()) binding.release();
    bindings.clear();
    registration.release();
  });

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
    // The default is already saved at this point, so a failed marker write does
    // not roll back this run: the session follows the new default now, and the
    // warning says that reload may bring the older override back.
    sessionOverride = undefined;
    try {
      pi.appendEntry<FastSessionStateEntry>(SESSION_STATE_ENTRY_TYPE, { enabled: null });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      publishSlot(ctx.model?.provider);
      ctx.ui.notify(
        `Global default saved, but this session's override could not be cleared: ${reason}. This session follows the new default until reload; an older override may come back after reload.`,
        "warning",
      );
      return;
    }
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

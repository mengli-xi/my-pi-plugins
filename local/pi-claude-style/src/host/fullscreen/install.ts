import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { FeatureHealth } from "../../lifecycle.ts";
import { installFullscreenBridge, type FullscreenBridge, type FullscreenLayoutConfig } from "./bridge.ts";
import { warmNativeClipboardOnIdle } from "./clipboard-warmup.ts";
import { installFullHistory } from "../../compat/full-history.ts";

/**
 * A zero-height widget above the editor. Widget factories are the public way
 * to reach the view's TUI, and rendering it each frame lets the bridge follow
 * a TUI Pi swapped without rebuilding widgets.
 */
const ANCHOR_WIDGET_KEY = "pi-claude-style:fullscreen";

/** Pinned Layout owned these adaptations before; both loaded would draw every header twice. */
export function pinnedLayoutStillLoaded(pi: ExtensionAPI): boolean {
  try {
    return (pi.getSettings().packages ?? []).some((entry) => {
      const source = typeof entry === "string" ? entry : (entry as { source?: unknown } | undefined)?.source;
      return typeof source === "string" && /(?:^|[/:])pi-pinned-layout\/?$/u.test(source);
    });
  } catch {
    return false;
  }
}

export interface FullscreenHost {
  health(): FeatureHealth;
  dispose(): void;
}

export interface FullscreenHostOptions {
  /** Main's interactive view preloads the host clipboard module; child views never do. */
  warmClipboard?: boolean;
}

/**
 * Install the fullscreen bridge for one Pi view (Main, Side or a Subagent).
 * `config` is read when the anchor mounts; `layout.*` changes apply on reload.
 */
export function installFullscreenHost(
  pi: ExtensionAPI,
  config: () => FullscreenLayoutConfig,
  options: FullscreenHostOptions = {},
): FullscreenHost {
  if (pinnedLayoutStillLoaded(pi)) {
    return {
      health: () => ({
        status: "degraded",
        detail: "pi-pinned-layout is still in settings.packages; it is retired and CC Style owns the fullscreen adaptations now. Remove it and restart.",
      }),
      dispose() {},
    };
  }
  let bridge: FullscreenBridge | undefined = installFullscreenBridge();
  const history = installFullHistory(pi);
  let marker: Component | undefined;
  let markerTui: TUI | undefined;
  let stopClipboardWarmup: (() => void) | undefined;

  const mounted = (): boolean => !!markerTui && !!marker && markerTui.children.some((child) => {
    const kids = (child as { children?: readonly Component[] }).children;
    return Array.isArray(kids) && kids.includes(marker!);
  });

  // `/reload` and session switches drop extension widgets without replaying
  // every event, so remount from whichever event arrives while it is gone.
  const mount = (ctx: ExtensionContext): void => {
    if (!bridge || ctx.mode !== "tui" || !ctx.hasUI || mounted()) return;
    const current = config();
    const ui = ctx.ui;
    ui.setWidget(ANCHOR_WIDGET_KEY, (tui: TUI) => {
      const component: Component = {
        render: () => {
          bridge?.prepare(tui, current, () => ui.theme);
          return [];
        },
        invalidate() {},
      };
      marker = component;
      markerTui = tui;
      history.attach(tui);
      bridge?.prepare(tui, current, () => ui.theme);
      // Main only: the first alt-screen copy should not wait for the host to
      // require its native clipboard module.
      if (options.warmClipboard) {
        stopClipboardWarmup ??= warmNativeClipboardOnIdle(tui, () => ctx.isIdle());
      }
      return component;
    }, { placement: "aboveEditor" });
  };

  pi.on("session_start", (_event, ctx) => mount(ctx));
  pi.on("resources_discover", (_event, ctx) => { mount(ctx); return {}; });
  pi.on("session_info_changed", (_event, ctx) => mount(ctx));
  pi.on("turn_start", (_event, ctx) => mount(ctx));

  return {
    health: () => ({ status: config().enabled ? "ok" : "inactive" }),
    dispose() {
      history.dispose();
      stopClipboardWarmup?.();
      stopClipboardWarmup = undefined;
      bridge?.release();
      bridge = undefined;
      marker = undefined;
      markerTui = undefined;
    },
  };
}

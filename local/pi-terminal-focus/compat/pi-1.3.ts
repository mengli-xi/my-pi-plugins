import type { TUI } from "@earendil-works/pi-tui";

type ViewportInput = (data: string) => { consume?: boolean } | undefined;
type FocusViewport = TUI & { handleViewportInput?: ViewportInput };

/**
 * Probe: fullscreen.focus-input — TuiAltScreen.handleViewportInput.
 * Pi 1.3's viewport listener consumes FocusIn/Out before public extension input
 * listeners run. Observe the same instance before forwarding to Pi, preserving
 * its selection/gesture cleanup. No public pre-consumption listener API exists.
 * Shape drift warns at the caller; check:host exercises the final binary.
 */
export function observeFullscreenFocus(tui: TUI, observe: (data: string) => void): (() => void) | undefined {
  const viewport = tui as FocusViewport;
  const original = viewport.handleViewportInput;
  if (typeof original !== "function") return undefined;
  const wrapped: ViewportInput = function (data) {
    observe(data);
    return original.call(viewport, data);
  };
  viewport.handleViewportInput = wrapped;
  return () => {
    if (viewport.handleViewportInput === wrapped) viewport.handleViewportInput = original;
  };
}

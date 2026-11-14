import type { TUI } from "@earendil-works/pi-tui";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { isFullscreen } from "./bridge.ts";

/** Long enough for the first frame and history projection to be over. */
export const CLIPBOARD_WARM_DELAY_MS = 3_000;

/**
 * The first copy in a fullscreen session otherwise synchronously requires the
 * host's native clipboard module (darwin/win32, ~0.7s locally). Load it once
 * after the main thread goes idle, and never read or write the clipboard. A
 * reloaded extension only hits the host's path cache. Linux copies through
 * command-line tools, and its module would touch X11.
 */
export function warmNativeClipboardOnIdle(
  tui: TUI,
  isIdle: () => boolean,
  load: () => unknown = getNativeClipboard,
): () => void {
  if (process.platform !== "darwin" && process.platform !== "win32") return () => {};
  if (!isFullscreen(tui)) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      let idle: boolean;
      try { idle = isIdle(); } catch { return; } // a retired context cannot warm anything
      if (!idle) { schedule(); return; }
      try { load(); } catch { /* warming only; the first copy loads or fails as it did before */ }
    }, CLIPBOARD_WARM_DELAY_MS);
    timer.unref?.();
  };
  schedule();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}

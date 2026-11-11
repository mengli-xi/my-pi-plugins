import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createEditorOverlayMount } from "pi-li-uikit/editor-overlay";
import { UIKitGallery } from "./src/gallery.ts";

export default function registerUIKitGallery(pi: ExtensionAPI): void {
  pi.registerCommand("uikit", {
    description: "Open the interactive pi-li-uikit component gallery",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("/uikit requires Pi's interactive TUI.", "warning");
        return;
      }

      const overlay = createEditorOverlayMount();
      await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
        overlay.mount(tui, new UIKitGallery({ tui, theme, keybindings, onClose: done })),
        overlay.customOptions,
      );
    },
  });
}

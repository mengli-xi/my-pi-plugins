import { createEditorOverlayMount } from "pi-li-uikit/editor-overlay";
import { ProcessManagerEditor } from "./manager.js";
import type { ProcessUiRuntime } from "./install.js";

/** The management panel graph is imported only when the user opens it. */
export async function showProcessManager(
  active: ProcessUiRuntime,
  processId: string | undefined,
  isCurrent: () => boolean,
  onMount: (manager: ProcessManagerEditor, close: () => void) => void,
): Promise<void> {
  const overlay = createEditorOverlayMount();
  await active.context.ui.custom<void>((tui, theme, keybindings, done) => {
    if (!isCurrent()) {
      done();
      return { render: () => [], invalidate() {} };
    }
    const manager = new ProcessManagerEditor(tui, theme, keybindings, {
      host: active.host,
      theme: active.context.ui.theme,
      ...(processId ? { initialProcessId: processId, directLogs: true } : {}),
      onClose: done,
      onChanged: () => tui.requestRender(),
    });
    onMount(manager, done);
    return overlay.mount(tui, manager);
  }, overlay.customOptions);
}

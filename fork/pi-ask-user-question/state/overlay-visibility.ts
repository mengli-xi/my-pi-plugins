import type { Component, TUI, TuiMainScreen } from "@earendil-works/pi-tui";

// Stock Pi exposes this method on both renderers through TuiBase, though its
// general TUI interface omits it. Use the declared public surface only.
function hasFocusReader(tui: TUI): tui is TUI & Pick<TuiMainScreen, "getFocusedComponent"> {
	return "getFocusedComponent" in tui && typeof tui.getFocusedComponent === "function";
}

/**
 * Overlay mounts yield visually to native dialogs, whose focus owners do not
 * join Pi's overlay stack. Inline mounts already yield their editor slot through
 * ui.custom and do not use this predicate. Keep the same overlay/session alive:
 * setHidden would discard the host's focus-restoration state and user drafts.
 */
export function questionnaireVisibility(tui: TUI, component: Component): () => boolean {
	if (!hasFocusReader(tui)) throw new Error("Questionnaire requires Pi's public TUI.getFocusedComponent() method");
	const previousFocus = tui.getFocusedComponent();
	return () => {
		const focused = tui.getFocusedComponent();
		return focused === component || focused === previousFocus;
	};
}

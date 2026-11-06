import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

export const REWIND_EDITOR_FACTORY = Symbol.for("pi-rewind.editorFactory.v2");
export const REWIND_EDITOR_INSTANCE = Symbol.for("pi-rewind.editorInstance.v2");

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type MarkedFactory = EditorFactory & { [REWIND_EDITOR_FACTORY]?: true };
type EditorSubmit = NonNullable<EditorComponent["onSubmit"]>;
// Unwrap a copied protected callback so it belongs to the receiving editor.
const submitTargets = new WeakMap<EditorSubmit, EditorSubmit>();
type RewindableEditor = EditorComponent & {
	onSubmit?: ((text: string) => void) | undefined;
	getText(): string;
	[REWIND_EDITOR_INSTANCE]?: RewindEditorState;
};

/** Hold the native submission result, independent of the key that produced it. */
export class RewindSubmissionGuard {
	private active = false;
	private edited = false;
	private pending: { editor: RewindableEditor; text: string; editorText: string; submit: EditorSubmit } | undefined;

	begin(): void {
		this.active = true;
		this.edited = false;
		this.pending = undefined;
	}

	defer(editor: RewindableEditor, text: string, submit: EditorSubmit): boolean {
		if (!this.active) return false;
		// Native submitValue / idle follow-up may already have cleared input.
		editor.setText(text);
		this.pending = { editor, text, editorText: editor.getText(), submit };
		return true;
	}

	checkForEdits(editor: RewindableEditor, previousText: string): void {
		if (!this.active) return;
		if (previousText !== editor.getText()) this.edited = true;
		if (this.pending?.editor === editor && this.pending.editorText !== editor.getText()) this.pending = undefined;
	}

	hasEdits(): boolean {
		return this.edited;
	}

	finish(succeeded: boolean): void {
		this.active = false;
		const pending = this.pending;
		this.pending = undefined;
		if (succeeded && pending && pending.editor.getText() === pending.editorText) {
			pending.editor.setText("");
			pending.submit(pending.text);
		}
	}
}

export interface RewindEditorOptions {
	isIdle(): boolean;
	/** Reserve a one-Escape rewind while the first provider request has not begun. */
	requestPendingConnectionRewind?(): boolean;
	/** Swallow repeated Escape gestures until the rewind command has settled. */
	isRewindInProgress?(): boolean;
	submissionGuard?: RewindSubmissionGuard;
	now?(): number;
	windowMs?: number;
}

interface RewindEditorState {
	readonly originalHandleInput: (data: string) => void;
	keybindings: { matches(data: string, action: string): boolean };
	options: RewindEditorOptions;
	lastEscapeAt: number;
	onSubmit?: EditorSubmit;
}

/**
 * Intercept only the idle, empty double-Escape gesture while preserving the
 * exact editor object. pi-pinned-layout discovers Pi's autocomplete fields on
 * that object; an opaque proxy would force the slash menu back below the input.
 */
export function decorateRewindEditor(
	editor: RewindableEditor,
	keybindings: { matches(data: string, action: string): boolean },
	options: RewindEditorOptions,
): RewindableEditor {
	const existing = editor[REWIND_EDITOR_INSTANCE];
	if (existing) {
		existing.keybindings = keybindings;
		existing.options = options;
		return editor;
	}

	const state: RewindEditorState = {
		originalHandleInput: editor.handleInput.bind(editor),
		keybindings,
		options,
		lastEscapeAt: 0,
	};
	Object.defineProperty(editor, REWIND_EDITOR_INSTANCE, { value: state });
	const originalSubmit = editor.onSubmit;
	const submitDescriptor = Object.getOwnPropertyDescriptor(editor, "onSubmit");
	Object.defineProperty(editor, "onSubmit", {
		configurable: true,
		enumerable: submitDescriptor?.enumerable ?? true,
		get: () => state.onSubmit,
		set: (handler: EditorSubmit | undefined) => {
			if (handler === state.onSubmit) return;
			if (!handler) {
				submitDescriptor?.set?.call(editor, undefined);
				state.onSubmit = undefined;
				return;
			}
			const target = submitTargets.get(handler) ?? handler;
			// Capture this assignment's target, so other decorators may safely
			// wrap the previous getter value without creating a forwarding loop.
			const protectedSubmit: EditorSubmit = (text) => {
				if (state.options.submissionGuard?.defer(editor, text, (value) => target.call(editor, value))) return;
				return target.call(editor, text);
			};
			submitTargets.set(protectedSubmit, target);
			// Preserve an existing public accessor (for example, an editor owner's
			// image-marker expansion) before capturing the actual submitted text.
			submitDescriptor?.set?.call(editor, protectedSubmit);
			state.onSubmit = submitDescriptor?.set && submitDescriptor.get
				? submitDescriptor.get.call(editor) : protectedSubmit;
			if (state.onSubmit) submitTargets.set(state.onSubmit, target);
		},
	});
	editor.onSubmit = originalSubmit;
	editor.handleInput = (data: string): void => {
		const escape = state.keybindings.matches(data, "app.interrupt");
		if (escape && state.options.isRewindInProgress?.()) {
			state.lastEscapeAt = 0;
			return;
		}
		const emptyEscape = escape && editor.getText().trim().length === 0;
		if (
			emptyEscape
			&& !state.options.isIdle()
			&& editor.onSubmit
			&& state.options.requestPendingConnectionRewind?.()
		) {
			state.lastEscapeAt = 0;
			editor.onSubmit("/rewind --pending-connection");
			return;
		}

		const idleEmptyEscape = emptyEscape && state.options.isIdle();
		if (!idleEmptyEscape) {
			state.lastEscapeAt = 0;
			const previousText = editor.getText();
			state.originalHandleInput(data);
			state.options.submissionGuard?.checkForEdits(editor, previousText);
			return;
		}

		const now = state.options.now?.() ?? Date.now();
		const windowMs = state.options.windowMs ?? 500;
		if (state.lastEscapeAt > 0 && now - state.lastEscapeAt < windowMs && editor.onSubmit) {
			state.lastEscapeAt = 0;
			editor.onSubmit("/rewind");
			return;
		}
		state.lastEscapeAt = now;
	};
	return editor;
}

export function wrapEditorFactory(
	factory: EditorFactory | undefined,
	options: RewindEditorOptions,
): EditorFactory {
	if ((factory as MarkedFactory | undefined)?.[REWIND_EDITOR_FACTORY]) return factory!;
	const wrapped: MarkedFactory = (tui, theme, keybindings) => {
		const editor = (factory?.(tui, theme, keybindings)
			?? new CustomEditor(tui, theme, keybindings)) as RewindableEditor;
		return decorateRewindEditor(editor, keybindings, options);
	};
	Object.defineProperty(wrapped, REWIND_EDITOR_FACTORY, { value: true });
	return wrapped;
}

export function installRewindEditor(
	ctx: ExtensionContext,
	options: Pick<RewindEditorOptions, "requestPendingConnectionRewind" | "isRewindInProgress" | "submissionGuard"> = {},
): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	const current = ctx.ui.getEditorComponent();
	if ((current as MarkedFactory | undefined)?.[REWIND_EDITOR_FACTORY]) return;
	ctx.ui.setEditorComponent(wrapEditorFactory(current, {
		isIdle: () => ctx.isIdle(),
		...options,
	}));
}

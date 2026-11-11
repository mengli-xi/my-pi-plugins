import {
  CustomEditor,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { observeFullscreenFocus } from "./compat/pi-1.3.ts";
import {
  CURSOR_MARKER,
  renderFakeCursor,
  type EditorComponent,
  type TUI,
  type Terminal,
} from "@earendil-works/pi-tui";

export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";

// Public renderFakeCursor produces the APC wrapper; avoid copying private constants.
const FAKE_CURSOR_CELL = "\u0000";
const [FAKE_CURSOR_START, FAKE_CURSOR_END] = renderFakeCursor(FAKE_CURSOR_CELL).split(FAKE_CURSOR_CELL) as [string, string];
const EDITOR_FACTORY_MARK = Symbol.for("pi-terminal-focus.editor-factory.v1");
const EDITOR_INSTANCE_MARK = Symbol.for("pi-terminal-focus.editor-instance.v1");
const TERMINAL_MARK = Symbol.for("pi-terminal-focus.terminal.v1");
const STATE_KEY = Symbol.for("pi-terminal-focus.state.v1");

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type MarkedFactory = EditorFactory & { [EDITOR_FACTORY_MARK]?: true };
type FocusEditor = EditorComponent & { [EDITOR_INSTANCE_MARK]?: true };
type FocusTerminal = Terminal & { [TERMINAL_MARK]?: TerminalPatch };
type Notify = (message: string, type?: "info" | "warning" | "error") => void;

interface TerminalPatch {
  originalStart: Terminal["start"];
  originalStop: Terminal["stop"];
  requestRender?: () => void;
  enabled: boolean;
}

interface FocusState {
  owner?: object;
  focused: boolean;
  terminal?: FocusTerminal;
  terminals: Set<FocusTerminal>;
  fullscreenObserver?: { tui: TUI; restore: () => void };
  unsubscribe?: () => void;
  notify?: Notify;
  driftWarned: boolean;
  bindingFailure?: Error;
  exitSafetyInstalled: boolean;
}

export interface FocusInputResult {
  readonly sawFocusEvent: boolean;
  readonly focused: boolean | undefined;
  readonly data: string;
}

export interface ConcealResult {
  readonly lines: string[];
  readonly markerSeen: boolean;
  readonly cursorConcealed: boolean;
}

export function focusState(): FocusState {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const existing = scope[STATE_KEY];
  if (typeof existing === "object" && existing !== null) {
    const state = existing as FocusState;
    state.terminals ??= new Set<FocusTerminal>();
    return state;
  }
  const created: FocusState = {
    focused: true,
    terminals: new Set<FocusTerminal>(),
    driftWarned: false,
    exitSafetyInstalled: false,
  };
  scope[STATE_KEY] = created;
  return created;
}

/** Accept only the standalone control sequence emitted by terminal focus reporting. */
export function parseFocusInput(data: string): FocusInputResult {
  if (data === FOCUS_IN) return { sawFocusEvent: true, focused: true, data: "" };
  if (data === FOCUS_OUT) return { sawFocusEvent: true, focused: false, data: "" };
  return { sawFocusEvent: false, focused: undefined, data };
}

/**
 * Pi 1.2 exposes fake-cursor wrapping through renderFakeCursor(). Its adjacency
 * to CURSOR_MARKER remains a render-shape seam (checked by check:internals). Strip only that
 * cursor's APC wrapper, keeping its cell text and every surrounding style.
 */
export function concealEditorCursor(lines: readonly string[]): ConcealResult {
  let markerSeen = false;
  let cursorConcealed = false;
  const output = lines.map((line) => {
    const marker = line.indexOf(CURSOR_MARKER);
    if (marker < 0) return line;
    markerSeen = true;
    const start = marker + CURSOR_MARKER.length;
    if (!line.startsWith(FAKE_CURSOR_START, start)) return line;
    const cellStart = start + FAKE_CURSOR_START.length;
    const end = line.indexOf(FAKE_CURSOR_END, cellStart);
    // Pi's width clipping can drop the closing marker at end of line.
    const cellEnd = end < 0 ? line.length : end;
    if (cellStart === cellEnd) return line;
    cursorConcealed = true;
    return line.slice(0, marker) + line.slice(cellStart, cellEnd)
      + (end < 0 ? "" : line.slice(end + FAKE_CURSOR_END.length));
  });
  return { lines: output, markerSeen, cursorConcealed };
}

function warnRenderDrift(): void {
  const state = focusState();
  if (state.driftWarned) return;
  state.driftWarned = true;
  const notify = state.notify;
  if (!notify) return;
  queueMicrotask(() => notify(
    "pi-terminal-focus: Pi editor cursor render shape changed; cursor hiding failed open. Run npm run check:internals.",
    "warning",
  ));
}

function writeTerminal(terminal: Terminal | undefined, sequence: string): boolean {
  if (!terminal) return false;
  try {
    terminal.write(sequence);
    return true;
  } catch {
    // The terminal may already be released; retain the old state for a retry.
    return false;
  }
}

function setFocusReporting(terminal: FocusTerminal, enabled: boolean): void {
  const patch = terminal[TERMINAL_MARK];
  if (!patch || patch.enabled === enabled) return;
  if (writeTerminal(terminal, enabled ? ENABLE_FOCUS_REPORTING : DISABLE_FOCUS_REPORTING)) {
    patch.enabled = enabled;
  }
}

function patchTerminal(terminal: FocusTerminal): void {
  if (terminal[TERMINAL_MARK]) return;
  const patch: TerminalPatch = {
    originalStart: terminal.start,
    originalStop: terminal.stop,
    enabled: false,
  };
  Object.defineProperty(terminal, TERMINAL_MARK, { value: patch, configurable: true });
  terminal.start = (onInput, onResize): void => {
    patch.requestRender = onResize;
    patch.originalStart.call(terminal, onInput, onResize);
    focusState().focused = true;
    setFocusReporting(terminal, true);
  };
  terminal.stop = (): void => {
    setFocusReporting(terminal, false);
    patch.requestRender = undefined;
    patch.originalStop.call(terminal);
  };
}

function restoreTerminal(terminal: FocusTerminal): void {
  const patch = terminal[TERMINAL_MARK];
  if (!patch) return;
  setFocusReporting(terminal, false);
  terminal.start = patch.originalStart;
  terminal.stop = patch.originalStop;
  delete terminal[TERMINAL_MARK];
}

export function disableFocusReporting(state = focusState()): void {
  for (const terminal of state.terminals) restoreTerminal(terminal);
  state.terminals.clear();
  state.fullscreenObserver?.restore();
  state.fullscreenObserver = undefined;
}

function bindTerminal(tui: TUI): void {
  const state = focusState();
  const terminal = tui.terminal as FocusTerminal;
  state.terminal = terminal;
  patchTerminal(terminal);
  terminal[TERMINAL_MARK]!.requestRender = () => tui.requestRender(true);
  state.terminals.add(terminal);
  setFocusReporting(terminal, true);
  if (state.fullscreenObserver && state.fullscreenObserver.tui !== tui) {
    state.fullscreenObserver.restore();
    state.fullscreenObserver = undefined;
  }
  if (tui.mode === "fullscreen" && !state.fullscreenObserver) {
    const restore = observeFullscreenFocus(tui, (data) => {
      const parsed = parseFocusInput(data);
      if (!parsed.sawFocusEvent) return;
      state.focused = parsed.focused ?? state.focused;
      tui.requestRender(true);
    });
    if (restore) state.fullscreenObserver = { tui, restore };
    else queueMicrotask(() => state.notify?.(
      "pi-terminal-focus: fullscreen focus observer missing; run npm run check:internals.", "warning",
    ));
  }
}

export function decorateEditor(editor: FocusEditor, tui: TUI): FocusEditor {
  bindTerminal(tui);
  if (editor[EDITOR_INSTANCE_MARK]) return editor;
  const originalRender = editor.render.bind(editor);
  editor.render = (width: number): string[] => {
    const lines = originalRender(width);
    if (focusState().focused) return lines;
    const result = concealEditorCursor(lines);
    if (result.markerSeen && !result.cursorConcealed) warnRenderDrift();
    return result.lines;
  };
  Object.defineProperty(editor, EDITOR_INSTANCE_MARK, { value: true });
  return editor;
}

export function wrapEditorFactory(factory: EditorFactory | undefined): EditorFactory {
  if ((factory as MarkedFactory | undefined)?.[EDITOR_FACTORY_MARK]) return factory!;
  const wrapped: MarkedFactory = (tui, theme, keybindings) => decorateEditor(
    (factory?.(tui, theme, keybindings)
      ?? new CustomEditor(tui, theme, keybindings)) as FocusEditor,
    tui,
  );
  Object.defineProperty(wrapped, EDITOR_FACTORY_MARK, { value: true });
  return wrapped;
}

function installExitSafetyNet(): void {
  const state = focusState();
  if (state.exitSafetyInstalled) return;
  state.exitSafetyInstalled = true;
  process.on("exit", () => disableFocusReporting(focusState()));
}

export function bindTerminalFocus(owner: object, ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  const state = focusState();
  if (state.owner !== owner) {
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    state.owner = owner;
    state.driftWarned = false;
    state.bindingFailure = undefined;
  }
  state.notify = (message, type) => ctx.ui.notify(message, type);

  try {
    const current = ctx.ui.getEditorComponent();
    if (!(current as MarkedFactory | undefined)?.[EDITOR_FACTORY_MARK]) {
      ctx.ui.setEditorComponent(wrapEditorFactory(current));
    }
  } catch (cause) {
    if (!state.bindingFailure) {
      state.bindingFailure = new Error("pi-terminal-focus: main editor binding failed; cursor hiding is degraded.", { cause });
      try {
        state.notify?.(state.bindingFailure.message, "warning");
      } catch {
        // A stale UI sink must not break input; the original cause stays in memory.
      }
    }
    return;
  }

  state.unsubscribe?.();
  state.unsubscribe = ctx.ui.onTerminalInput((data) => {
    const parsed = parseFocusInput(data);
    if (!parsed.sawFocusEvent) return undefined;
    state.focused = parsed.focused ?? state.focused;
    state.terminal?.[TERMINAL_MARK]?.requestRender?.();
    return { consume: true };
  });
  installExitSafetyNet();
}

export function releaseTerminalFocus(owner: object): void {
  const state = focusState();
  if (state.owner !== owner) return;
  state.unsubscribe?.();
  state.unsubscribe = undefined;
  disableFocusReporting(state);
  state.owner = undefined;
  state.bindingFailure = undefined;
  state.focused = true;
  state.terminal = undefined;
  state.notify = undefined;
}

export function resetTerminalFocusForTest(): void {
  const state = focusState();
  state.unsubscribe?.();
  disableFocusReporting(state);
  delete (globalThis as Record<PropertyKey, unknown>)[STATE_KEY];
}

import { Editor, CURSOR_MARKER, renderFakeCursor, TuiAltScreen } from "@earendil-works/pi-tui";
import { concealEditorCursor, decorateEditor, disableFocusReporting, focusState } from "../cursor.ts";

/** Source graph and final binary run the same behavior checks. */
export function checkInternals(): boolean {
  let input: ((data: string) => void) | undefined;
  const terminal = {
    columns: 80, rows: 24, kittyProtocolActive: false,
    start(onInput: (data: string) => void) { input = onInput; }, stop() {},
    drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  tui.requestRender = () => {};
  const plain = (text: string) => text;
  const editor = new Editor(tui, { borderColor: plain, selectList: {
    selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain,
  } });
  editor.focused = true;
  editor.setText("probe");
  const output = editor.render(40);
  const concealed = concealEditorCursor(output);
  const renderOk = output.join("\n").includes(`${CURSOR_MARKER}${renderFakeCursor(" ")}`)
    && concealed.markerSeen && concealed.cursorConcealed
    && !concealed.lines.join("\n").includes(CURSOR_MARKER);
  const originalStart = terminal.start;
  const originalStop = terminal.stop;
  decorateEditor(editor, tui);
  tui.start();
  input?.("\x1b[O");
  const outOk = !focusState().focused && !editor.render(40).join("\n").includes(CURSOR_MARKER);
  input?.("\x1b[I");
  const fullscreenOk = outOk && focusState().focused && editor.render(40).join("\n").includes(CURSOR_MARKER);
  tui.stop();
  disableFocusReporting();
  const terminalLifecycleOk = terminal.start === originalStart && terminal.stop === originalStop;
  for (const [id, ok] of [
    ["editor.cursor-render-shape", renderOk],
    ["terminal.start-stop-lifecycle", terminalLifecycleOk],
    ["fullscreen.focus-input", fullscreenOk],
  ] as const) console.error(`${ok ? "OK" : "MISSING"} ${id}`);
  return renderOk && terminalLifecycleOk && fullscreenOk;
}

export default function probe(pi: { on: (event: string, handler: () => void) => void }): void {
  pi.on("session_start", () => process.exit(checkInternals() ? 0 : 1));
}

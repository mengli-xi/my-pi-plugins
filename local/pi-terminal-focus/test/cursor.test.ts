import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  renderFakeCursor,
  TuiAltScreen,
  type EditorComponent,
  type TUI,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  bindTerminalFocus,
  concealEditorCursor,
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  FOCUS_IN,
  FOCUS_OUT,
  focusState,
  parseFocusInput,
  releaseTerminalFocus,
  resetTerminalFocusForTest,
  wrapEditorFactory,
} from "../cursor.ts";

const [FAKE_CURSOR_START, FAKE_CURSOR_END] = renderFakeCursor("\0").split("\0") as [string, string];

interface FakeTerminal extends Terminal {
  readonly writes: string[];
  readonly lifecycle: string[];
}

function makeTerminal(): FakeTerminal {
  const writes: string[] = [];
  const lifecycle: string[] = [];
  return {
    writes,
    lifecycle,
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start() { lifecycle.push("start"); },
    stop() { lifecycle.push("stop"); },
    async drainInput() {},
    write(data) { writes.push(data); lifecycle.push(data); },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  };
}

function makeEditor(): EditorComponent {
  return {
    render: () => [`${CURSOR_MARKER}${FAKE_CURSOR_START}X${FAKE_CURSOR_END}\x1b[0m`],
    handleInput() {},
    invalidate() {},
    focused: true,
  } as unknown as EditorComponent;
}

function makeTui(mode: "regular" | "fullscreen", terminal: Terminal, requestRender = () => {}): TUI {
  if (mode === "fullscreen") {
    const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
    tui.requestRender = requestRender;
    return tui;
  }
  return { mode, terminal, requestRender } as unknown as TUI;
}

afterEach(() => resetTerminalFocusForTest());

test("conceals only the marker-associated APC cursor and preserves styles", () => {
  const line = `left\x1b[7munrelated\x1b[0m${FAKE_CURSOR_START}unfocused${FAKE_CURSOR_END}${CURSOR_MARKER}${FAKE_CURSOR_START}\x1b[38;5;7m界\x1b[0m${FAKE_CURSOR_END}right`;
  const result = concealEditorCursor([line]);
  assert.equal(result.markerSeen, true);
  assert.equal(result.cursorConcealed, true);
  assert.equal(result.lines[0], `left\x1b[7munrelated\x1b[0m${FAKE_CURSOR_START}unfocused${FAKE_CURSOR_END}\x1b[38;5;7m界\x1b[0mright`);
});

test("conceals a width-clipped cursor whose closing marker was dropped", () => {
  const result = concealEditorCursor([`prefix${CURSOR_MARKER}${FAKE_CURSOR_START} `]);
  assert.equal(result.cursorConcealed, true);
  assert.deepEqual(result.lines, ["prefix "]);
});

test("fails open when Pi's marker/cursor adjacency changes", () => {
  const lines = [`text${CURSOR_MARKER}\x1b[1mX\x1b[0m`];
  const result = concealEditorCursor(lines);
  assert.equal(result.markerSeen, true);
  assert.equal(result.cursorConcealed, false);
  assert.deepEqual(result.lines, lines);
});

test("accepts only standalone focus events and preserves paste bytes", () => {
  assert.deepEqual(parseFocusInput(FOCUS_OUT), {
    sawFocusEvent: true,
    focused: false,
    data: "",
  });
  const paste = `\x1b[200~a${FOCUS_OUT}b${FOCUS_IN}c\x1b[201~`;
  assert.deepEqual(parseFocusInput(paste), {
    sawFocusEvent: false,
    focused: undefined,
    data: paste,
  });
});

test("composes the current editor factory and preserves exact editor identity", () => {
  const terminal = makeTerminal();
  const tui = makeTui("regular", terminal);
  const editor = makeEditor();
  const factory = wrapEditorFactory(() => editor);
  assert.equal(factory(tui, {} as never, {} as never), editor);
  assert.deepEqual(terminal.writes, [ENABLE_FOCUS_REPORTING]);
  focusState().focused = false;
  assert.deepEqual(editor.render(80), ["X\x1b[0m"]);
});

test("terminal stop disables reporting before handoff and start restores it", () => {
  const terminal = makeTerminal();
  const originalStart = terminal.start;
  const originalStop = terminal.stop;
  wrapEditorFactory(() => makeEditor())(makeTui("regular", terminal), {} as never, {} as never);

  terminal.stop();
  assert.deepEqual(terminal.lifecycle.slice(-2), [DISABLE_FOCUS_REPORTING, "stop"]);
  terminal.start(() => {}, () => {});
  assert.deepEqual(terminal.lifecycle.slice(-2), ["start", ENABLE_FOCUS_REPORTING]);

  resetTerminalFocusForTest();
  assert.equal(terminal.start, originalStart);
  assert.equal(terminal.stop, originalStop);
  assert.equal(terminal.writes.at(-1), DISABLE_FOCUS_REPORTING);
});

test("failed reporting writes stay retryable without interrupting terminal lifecycle", () => {
  const terminal = makeTerminal();
  const write = terminal.write.bind(terminal);
  let failEnable = true;
  let failDisable = true;
  terminal.write = (data) => {
    if (data === ENABLE_FOCUS_REPORTING && failEnable) {
      failEnable = false;
      throw new Error("fixture enable failed");
    }
    if (data === DISABLE_FOCUS_REPORTING && failDisable) {
      failDisable = false;
      throw new Error("fixture disable failed");
    }
    write(data);
  };
  const editor = makeEditor();
  const tui = makeTui("regular", terminal);
  const factory = wrapEditorFactory(() => editor);
  assert.doesNotThrow(() => factory(tui, {} as never, {} as never));
  assert.deepEqual(terminal.writes, []);
  factory(tui, {} as never, {} as never);
  assert.deepEqual(terminal.writes, [ENABLE_FOCUS_REPORTING]);
  assert.doesNotThrow(() => terminal.stop());
  assert.deepEqual(terminal.writes, [ENABLE_FOCUS_REPORTING]);
  terminal.stop();
  assert.deepEqual(terminal.writes, [ENABLE_FOCUS_REPORTING, DISABLE_FOCUS_REPORTING]);
  assert.equal(terminal.lifecycle.filter((value) => value === "stop").length, 2);
});

test("binding failures warn once safely and retain the cause without exposing it", () => {
  const failure = new Error("SECRET fixture editor failure");
  const notices: string[] = [];
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      getEditorComponent: () => { throw failure; },
      setEditorComponent: () => assert.fail("failed editor lookup must not replace it"),
      onTerminalInput: () => assert.fail("failed binding must not claim input"),
      notify: (message: string) => { notices.push(message); throw new Error("stale notification sink"); },
    },
  } as unknown as ExtensionContext;
  const owner = {};
  for (let index = 0; index < 3; index++) assert.doesNotThrow(() => bindTerminalFocus(owner, ctx));
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /pi-terminal-focus:.*binding failed/);
  assert.ok(!notices[0]!.includes("SECRET"));
  assert.equal(focusState().bindingFailure?.cause, failure);
  releaseTerminalFocus(owner);
  assert.equal(focusState().bindingFailure, undefined);
  assert.doesNotThrow(() => bindTerminalFocus({}, ctx));
  assert.equal(notices.length, 2);
});

test("fullscreen startup conceals and restores the cursor across terminal lifecycle", () => {
  const terminal = makeTerminal();
  const editor = makeEditor();
  let activeRenders = 0;
  let listener: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  let factory: ((...args: never[]) => EditorComponent) | undefined = (() => editor) as never;
  const fullscreen = makeTui("fullscreen", terminal);
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      getEditorComponent: () => factory,
      setEditorComponent: (next: typeof factory) => {
        factory = next;
        factory?.(fullscreen as never, {} as never, {} as never);
      },
      onTerminalInput: (next: typeof listener) => {
        listener = next;
        return () => {};
      },
    },
  } as unknown as ExtensionContext;

  bindTerminalFocus({}, ctx);
  assert.equal(editor.render(80)[0]?.includes(FAKE_CURSOR_START), true);
  terminal.stop();
  terminal.start(() => {}, () => { activeRenders++; });
  assert.deepEqual(listener?.(FOCUS_OUT), { consume: true });
  assert.equal(activeRenders, 1);
  assert.deepEqual(editor.render(80), ["X\x1b[0m"]);
  assert.deepEqual(listener?.(FOCUS_IN), { consume: true });
  assert.equal(editor.render(80)[0]?.includes(FAKE_CURSOR_START), true);
});

test("binds one listener and restores terminal ownership on release", () => {
  const owner = {};
  const terminal = makeTerminal();
  const editor = makeEditor();
  const originalStart = terminal.start;
  const originalStop = terminal.stop;
  let listener: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  let unsubscribed = 0;
  let renders = 0;
  let factory: ((...args: never[]) => EditorComponent) | undefined = (() => editor) as never;
  const tui = makeTui("regular", terminal, () => { renders++; });
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      getEditorComponent: () => factory,
      setEditorComponent: (next: typeof factory) => {
        factory = next;
        factory?.(tui as never, {} as never, {} as never);
      },
      onTerminalInput: (next: typeof listener) => {
        listener = next;
        return () => { unsubscribed++; };
      },
    },
  } as unknown as ExtensionContext;

  bindTerminalFocus(owner, ctx);
  assert.deepEqual(listener?.(FOCUS_OUT), { consume: true });
  assert.equal(focusState().focused, false);
  assert.equal(renders, 1);
  assert.equal(listener?.(`${FOCUS_IN}q`), undefined);
  assert.equal(focusState().focused, false);
  assert.deepEqual(listener?.(FOCUS_IN), { consume: true });
  assert.equal(focusState().focused, true);

  releaseTerminalFocus(owner);
  assert.equal(unsubscribed, 1);
  assert.equal(terminal.start, originalStart);
  assert.equal(terminal.stop, originalStop);
  assert.deepEqual(terminal.writes, [ENABLE_FOCUS_REPORTING, DISABLE_FOCUS_REPORTING]);
});

test("releases every terminal instance seen before replacement", () => {
  const owner = {};
  const terminalA = makeTerminal();
  const terminalB = makeTerminal();
  const editor = makeEditor();
  let factory: ((...args: never[]) => EditorComponent) | undefined = (() => editor) as never;
  const makeContext = (tui: TUI) => ({
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      getEditorComponent: () => factory,
      setEditorComponent: (next: typeof factory) => {
        factory = next;
        factory?.(tui as never, {} as never, {} as never);
      },
      onTerminalInput: () => () => {},
    },
  }) as unknown as ExtensionContext;

  bindTerminalFocus(owner, makeContext(makeTui("regular", terminalA)));
  (factory as NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>)(
    makeTui("regular", terminalB),
    {} as never,
    {} as never,
  );
  releaseTerminalFocus(owner);

  assert.deepEqual(terminalA.writes, [ENABLE_FOCUS_REPORTING, DISABLE_FOCUS_REPORTING]);
  assert.deepEqual(terminalB.writes, [ENABLE_FOCUS_REPORTING, DISABLE_FOCUS_REPORTING]);
});

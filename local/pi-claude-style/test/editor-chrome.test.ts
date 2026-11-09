import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import {
  decorateEditorChrome,
  installEditorChrome,
  paintEditorChrome,
  paintBottomLabel,
  paintGitBorder,
  paintTopBorder,
  wrapEditorChromeFactory,
} from "../src/editor-chrome.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const plain = (value: string): string => value.replace(ANSI_RE, "");
const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
} as unknown as Theme;

function fakeEditor() {
  let padding = 0;
  let text = "one\ntwo";
  return {
    history: ["newest", "older", "oldest"],
    historyIndex: -1,
    tui: { requestRender() {} },
    render(width: number): string[] {
      const border = "─".repeat(width);
      return [
        border,
        ...text.split("\n").map((line) => `${" ".repeat(padding)}${line}`.padEnd(width)),
        border,
      ];
    },
    onSubmit: undefined as ((text: string) => void) | undefined,
    invalidate() {},
    handleInput() {},
    getText: () => text,
    getExpandedText: () => text,
    setText(value: string) { text = value; },
    insertTextAtCursor(value: string) { text += value; },
    setPaddingX(value: number) { padding = value; },
  };
}

test("top border composes History on the left and session name on the right", () => {
  const painted = plain(paintTopBorder(
    "────────────────────────────────────────",
    "Editor ownership",
    { current: 2, total: 5 },
    theme,
  ));
  assert.equal(visibleWidth(painted), 40);
  assert.match(painted, /^── History 2\/5 ─+/);
  assert.match(painted, / Editor ownership ──$/);
});

test("history keeps priority over the session name on a narrow border", () => {
  const painted = plain(paintTopBorder(
    "────────────────────",
    "a very long session name",
    { current: 12, total: 20 },
    theme,
  ));
  assert.equal(visibleWidth(painted), 20);
  assert.match(painted, /^── History 12\/20 /);
  assert.doesNotMatch(painted, /session/);
});

test("bottom border right-aligns Git branch and status", () => {
  const painted = paintGitBorder(
    "────────────────────────────────────────",
    { branch: "main", additions: 12, deletions: 3, ahead: 2, behind: 1 },
    theme,
  );
  const text = plain(painted);
  assert.equal(text, "─────────────────── main +12 -3 ⇡2 ⇣1 ──");
  assert.equal(visibleWidth(text), 40);
  assert.match(painted, /\x1b\[38;5;65m\+12\x1b\[0m/);
  assert.match(painted, /\x1b\[38;5;95m-3\x1b\[0m/);
});

test("bottom label replaces Git identity for the Subagent return shortcut", () => {
  const text = plain(paintBottomLabel("────────────────────────────────────────", "Alt+/ Main", theme));
  assert.equal(visibleWidth(text), 40);
  assert.match(text, / Alt\+\/ Main ──$/);
});

test("editor chrome owns prefix, borders and native history position in one render", () => {
  const editor = fakeEditor();
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getSessionName: () => "Session name",
  };
  let currentFactory: ReturnType<typeof wrapEditorChromeFactory> | undefined = () => editor as never;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/workspace",
    ui: {
      theme,
      getEditorComponent: () => currentFactory,
      setEditorComponent(factory: typeof currentFactory) { currentFactory = factory; },
    },
  };
  const installed = installEditorChrome(pi as never, {
    readGitStatus: async () => ({
      branch: "feature/chrome",
      additions: 2,
      deletions: 1,
      ahead: 0,
      behind: 0,
    }),
  });
  handlers.get("session_start")?.[0]?.({}, ctx);
  const built = currentFactory?.({} as never, {} as never, {} as never) as ReturnType<typeof fakeEditor>;

  let rendered = built.render(40).map(plain);
  assert.match(rendered[0]!, / Session name ──$/);
  assert.equal(rendered[1]!.startsWith("❯ one"), true);
  assert.doesNotMatch(rendered[0]!, /History/);

  built.historyIndex = 0;
  rendered = built.render(40).map(plain);
  assert.match(rendered[0]!, /^── History 3\/3 /, "the first ArrowUp reaches the newest entry");

  built.historyIndex = 1;
  rendered = built.render(40).map(plain);
  assert.match(rendered[0]!, /^── History 2\/3 /, "the second ArrowUp reaches the previous entry");

  built.historyIndex = 2;
  rendered = built.render(40).map(plain);
  assert.match(rendered[0]!, /^── History 1\/3 /);

  built.historyIndex = 9;
  rendered = built.render(40).map(plain);
  assert.doesNotMatch(rendered[0]!, /History/);
  assert.equal(built.getText(), "one\ntwo");
  installed.dispose();
});

function nativeEditor(requestRender: () => void = () => {}) {
  return new Editor(
    { requestRender, terminal: { columns: 80, rows: 24 } } as never,
    { borderColor: (text: string) => text, selectList: {} } as never,
  );
}

const IMAGE_PATH = "/var/folders/test/pi-clipboard-123e4567-e89b-12d3-a456-426614174000.png";

function installedNativeEditor() {
  const editor = nativeEditor();
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getSessionName: () => undefined,
  };
  let currentFactory: ReturnType<typeof wrapEditorChromeFactory> | undefined = () => editor as never;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/workspace",
    ui: {
      theme,
      getEditorComponent: () => currentFactory,
      setEditorComponent(factory: typeof currentFactory) { currentFactory = factory; },
    },
  };
  const installed = installEditorChrome(pi as never, { readGitStatus: async () => undefined });
  handlers.get("session_start")?.[0]?.({}, ctx);
  const built = currentFactory?.({} as never, {} as never, {} as never) as unknown as Editor;
  return { editor: built, dispose: () => installed.dispose() };
}

test("image clipboard paths render as Image markers and submit as original paths", () => {
  const fixture = installedNativeEditor();
  try {
    const editor = fixture.editor;
    editor.setText("before ");
    editor.insertTextAtCursor(IMAGE_PATH);
    assert.equal(editor.getText(), "before [Image #1]");
    assert.match(editor.render(40).map(plain).join("\n"), /\[Image #1\]/u);
    assert.equal(editor.getExpandedText(), `before ${IMAGE_PATH}`);
    let submitted = "";
    editor.onSubmit = (text) => { submitted = text; };
    editor.onSubmit?.(editor.getText());
    assert.equal(submitted, `before ${IMAGE_PATH}`);
    assert.equal(editor.getExpandedText(), "before [Image #1]", "submit retires the image mapping");
  } finally {
    fixture.dispose();
  }
});

test("programmatic setText reattaches an existing clipboard image as an atomic marker", () => {
  const directory = mkdtempSync(join(tmpdir(), "cc-style-image-restore-"));
  const fixture = installedNativeEditor();
  try {
    const imagePath = join(directory, "pi-clipboard-123e4567-e89b-12d3-a456-426614174000.png");
    writeFileSync(imagePath, "image");
    const editor = fixture.editor;
    editor.setText(`inspect ${imagePath}`);
    assert.equal(editor.getText(), "inspect [Image #1]");
    assert.equal(editor.getExpandedText(), `inspect ${imagePath}`);
    const registry = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("pi.claude-style.editor-image-source.v2")
    ] as {
      sourceText(text: string): string;
      restoredSource(text: string): { handled: boolean; editorText: string };
    } | undefined;
    assert.equal(registry?.sourceText(editor.getText()), `inspect ${imagePath}`);
    assert.deepEqual(registry?.restoredSource(`inspect ${imagePath}`), {
      handled: true,
      editorText: "inspect [Image #1]",
    });
    editor.handleInput("\x7f");
    assert.equal(editor.getText(), "inspect ");
  } finally {
    fixture.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("programmatic setText leaves a missing clipboard path for the caller to degrade", () => {
  const editor = decorateEditorChrome(nativeEditor() as never) as unknown as Editor;
  editor.setText(`inspect ${IMAGE_PATH}`);
  assert.equal(editor.getText(), `inspect ${IMAGE_PATH}`);
});

test("the image source receipt rejects a partial multi-image restore", () => {
  const directory = mkdtempSync(join(tmpdir(), "cc-style-image-partial-"));
  const fixture = installedNativeEditor();
  try {
    const existing = join(directory, "pi-clipboard-123e4567-e89b-12d3-a456-426614174000.png");
    const missing = join(directory, "pi-clipboard-123e4567-e89b-12d3-a456-426614174001.png");
    writeFileSync(existing, "image");
    const source = `${existing}\n${missing}`;
    fixture.editor.setText(source);
    const registry = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("pi.claude-style.editor-image-source.v2")
    ] as { restoredSource(text: string): { handled: boolean; editorText: string } } | undefined;
    assert.deepEqual(registry?.restoredSource(source), {
      handled: false,
      editorText: `[Image #1]\n${missing}`,
    });
  } finally {
    fixture.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Backspace and Delete remove an Image marker as one atomic segment", () => {
  const backspace = decorateEditorChrome(nativeEditor() as never) as unknown as Editor;
  backspace.setText("before ");
  backspace.insertTextAtCursor(IMAGE_PATH);
  assert.equal(backspace.getCursor().col, "before [Image #1]".length);
  backspace.handleInput("\x7f");
  assert.equal(backspace.getText(), "before ");
  assert.equal(backspace.getExpandedText(), "before ");
  backspace.handleInput("\x1f");
  assert.equal(backspace.getText(), "before [Image #1]", "undo restores the whole marker");
  assert.equal(backspace.getExpandedText(), `before ${IMAGE_PATH}`, "undo also restores its path mapping");

  const forward = decorateEditorChrome(nativeEditor() as never) as unknown as Editor;
  forward.setText("before ");
  forward.insertTextAtCursor(IMAGE_PATH);
  forward.handleInput("\x1b[D");
  assert.equal(forward.getCursor().col, "before ".length, "left arrow skips the whole marker");
  forward.handleInput("\x1b[3~");
  assert.equal(forward.getText(), "before ");
  assert.equal(forward.getExpandedText(), "before ");
});

test("an unbound Image-looking string remains ordinary editable text", () => {
  const editor = decorateEditorChrome(nativeEditor() as never) as unknown as Editor;
  editor.setText("[Image #1]");
  editor.handleInput("\x7f");
  assert.equal(editor.getText(), "[Image #1", "only mapped image markers are atomic");
});

test("ordinary inserted text is not rewritten as an image marker", () => {
  const editor = decorateEditorChrome(nativeEditor() as never) as unknown as Editor;
  editor.insertTextAtCursor("/tmp/not-a-pi-clipboard-file.png");
  assert.equal(editor.getText(), "/tmp/not-a-pi-clipboard-file.png");
  assert.equal(editor.getExpandedText(), "/tmp/not-a-pi-clipboard-file.png");
});

test("an editor without the atomic segment seam keeps clipboard image paths visible", () => {
  const editor = fakeEditor();
  decorateEditorChrome(editor as never);
  editor.insertTextAtCursor(IMAGE_PATH);
  assert.equal(editor.getText(), `one\ntwo${IMAGE_PATH}`);
});

test("Subagent top-right label overrides session name without changing session identity", () => {
  const editor = fakeEditor();
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => void) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getSessionName: () => "Native session name",
  };
  let currentFactory: ReturnType<typeof wrapEditorChromeFactory> | undefined = () => editor as never;
  const ctx = { mode: "tui", hasUI: true, cwd: "/workspace", ui: { theme, getEditorComponent: () => currentFactory, setEditorComponent(factory: typeof currentFactory) { currentFactory = factory; } } };
  const installed = installEditorChrome(pi as never, { topRightLabel: "review-agent", readGitStatus: async () => undefined });
  handlers.get("session_start")?.[0]?.({}, ctx);
  const built = currentFactory?.({} as never, {} as never, {} as never) as ReturnType<typeof fakeEditor>;
  assert.match(built.render(40).map(plain)[0]!, / review-agent ──$/);
  handlers.get("session_info_changed")?.[0]?.({ name: "Renamed native session" }, ctx);
  assert.match(built.render(40).map(plain)[0]!, / review-agent ──$/);
  installed.dispose();
});

test("chrome decoration preserves identity, is idempotent, and fails open without native padding", () => {
  const editor = fakeEditor();
  assert.strictEqual(decorateEditorChrome(editor as never), editor);
  assert.strictEqual(decorateEditorChrome(editor as never), editor);

  const panel = {
    render: () => ["panel"],
    invalidate() {},
    handleInput() {},
    getText: () => "",
    setText() {},
  };
  assert.strictEqual(decorateEditorChrome(panel as never), panel);
});

test("replacement runtime adopts the reused editor redraw closure and image source", () => {
  let renders = 0;
  const editor = nativeEditor();
  let currentFactory: ReturnType<typeof wrapEditorChromeFactory> | undefined = () => editor as never;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/workspace",
    ui: {
      theme,
      getEditorComponent: () => currentFactory,
      setEditorComponent(factory: typeof currentFactory) { currentFactory = factory; },
    },
  };
  const install = () => {
    const handlers = new Map<string, Array<(event: any, context: any) => void>>();
    const pi = {
      on(name: string, handler: (event: any, context: any) => void) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      getSessionName: () => "Session name",
    };
    const installed = installEditorChrome(pi as never, { readGitStatus: async () => undefined });
    return { handlers, installed };
  };

  const first = install();
  first.handlers.get("session_start")?.[0]?.({}, ctx);
  // The redraw handle is the TUI Pi passes to the editor factory.
  const tui = { requestRender: () => { renders++; } };
  const reused = currentFactory?.(tui as never, {} as never, {} as never) as unknown as Editor;
  renders = 0;
  const markerState = (reused as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("pi-claude-style.editor-chrome.image-placeholders.v1")
  ] as { images: Map<number, string> } | undefined;
  markerState?.images.set(1, IMAGE_PATH);
  first.installed.dispose();
  assert.equal(
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi.claude-style.editor-image-source.v2")],
    undefined,
    "the retired owner releases its reader lease",
  );

  const replacement = install();
  replacement.handlers.get("session_start")?.[0]?.({}, ctx);
  assert.equal(renders, 0, "adopting the marked factory does not rebuild the editor");
  const registry = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("pi.claude-style.editor-image-source.v2")
  ] as { sourceText(text: string): string } | undefined;
  assert.equal(registry?.sourceText("draft [Image #1]"), `draft ${IMAGE_PATH}`);
  assert.equal(renders, 0, "reading source does not redraw the editor");
  replacement.handlers.get("session_info_changed")?.[0]?.({ name: "Renamed" }, ctx);
  assert.equal(renders, 1, "the replacement owner can redraw the reused editor");
  replacement.installed.dispose();
});

test("editor border layout uses the second rule before autocomplete rows", () => {
  const painted = paintEditorChrome(
    [
      "────────────────────────",
      "body",
      "────────────────────────",
      "────────────────────────",
    ],
    {
      name: "session",
      history: { current: 1, total: 2 },
      git: { branch: "main", additions: 0, deletions: 0, ahead: 0, behind: 0 },
    },
    theme,
  ).map(plain);
  assert.match(painted[0]!, /History 1\/2/);
  assert.match(painted[2]!, / main ──$/);
  assert.equal(painted[3], "────────────────────────");
});

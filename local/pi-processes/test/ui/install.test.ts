import assert from "node:assert/strict";
import test from "node:test";

import { installProcessUi } from "../../src/ui/install.ts";

test("process manager floats at the unchanged core editor position", async () => {
  const coreEditor = {
    history: ["first", "second"],
    text: "draft",
    getText: () => "draft",
    setText() {},
    handleInput() {},
    render: () => ["editor-top", "draft", "editor-bottom"],
    invalidate() {},
  };
  let editor = coreEditor;
  let customCalls = 0;
  let component: { handleInput(data: string): void } | undefined;
  let finishCustom: (() => void) | undefined;
  let customOptions: unknown;

  const theme = {
    fg: (_tone: string, text: string) => text,
    bg: (_tone: string, text: string) => text,
    bold: (text: string) => text,
  };
  const below = { render: () => ["statusline"], invalidate() {} };
  const footer = { render: () => ["footer"], invalidate() {} };
  const editorRoot = {
    children: [coreEditor],
    render: () => coreEditor.render(),
    invalidate() {},
  };
  const tui = {
    terminal: { rows: 24, columns: 80 },
    children: [{ render: () => ["transcript"], invalidate() {} }, editorRoot, below, footer],
    requestRender() {},
  };
  const keybindings = { matches: () => false, getKeybindings: () => [] };
  const context = {
    mode: "tui",
    ui: {
      theme,
      setWidget() {},
      custom(factory: (...args: any[]) => { handleInput(data: string): void }, options?: unknown) {
        customCalls += 1;
        customOptions = options;
        return new Promise<void>((resolve) => {
          const done = (): void => {
            editor = coreEditor;
            resolve();
          };
          component = factory(tui, {}, keybindings, done);
          finishCustom = done;
        });
      },
    },
  };
  const host = {
    records: () => [],
  };
  const commands = new Map<string, unknown>();
  const pi = {
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
  };
  const runtime = { host, context };
  const installed = installProcessUi(pi as never, () => runtime as never);

  installed.mount(runtime as never);
  installed.open();
  assert.equal(customCalls, 0, "management modules are loaded on first use");
  for (let i = 0; i < 100 && customCalls === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(customCalls, 1);
  assert.equal((customOptions as { overlay?: unknown }).overlay, true);
  const overlayOptions = (customOptions as { overlayOptions(): unknown }).overlayOptions();
  assert.deepEqual(overlayOptions, {
    anchor: "bottom-left",
    width: "100%",
    margin: { bottom: 2 },
  });
  assert.strictEqual(editor, coreEditor);

  component?.handleInput("\x1b");
  await Promise.resolve();
  assert.strictEqual(editor, coreEditor);
  assert.deepEqual(coreEditor.history, ["first", "second"]);
  assert.equal(coreEditor.text, "draft");

  finishCustom?.();
});


test("unmount fences a management import that is still pending", async () => {
  let customCalls = 0;
  const context = { mode: "tui", ui: { setWidget() {}, custom() { customCalls++; return Promise.resolve(); }, notify() {} } };
  const runtime = { context, host: {} };
  const installed = installProcessUi({ registerCommand() {} } as never, () => runtime as never);
  installed.mount(runtime as never);
  installed.open();
  installed.unmount(context as never);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(customCalls, 0, "a late module load must not reopen UI for a retired session");
});

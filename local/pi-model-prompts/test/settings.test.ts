import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openSettings } from "../settings.ts";

interface TestComponent {
  focused?: boolean;
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
  dispose?(): void;
}

function editorFocusHarness(inputs: readonly string[], onCustom?: (call: number) => void) {
  let editorText = "";
  let editorFocused = true;
  let customCalls = 0;
  const editor: TestComponent & {
    focused: boolean;
    getText(): string;
    setText(text: string): void;
    handleInput(data: string): void;
  } = {
    get focused() { return editorFocused; },
    set focused(value: boolean) { editorFocused = value; },
    getText: () => editorText,
    setText: (text) => { editorText = text; },
    handleInput: (data) => { if (editorFocused) editorText += data; },
    render: () => ["editor"],
    invalidate() {},
  };
  let focused: TestComponent | null = editor;
  const setFocus = (component: TestComponent | null): void => {
    if (focused && "focused" in focused) (focused as TestComponent & { focused: boolean }).focused = false;
    focused = component;
    if (component && "focused" in component) (component as TestComponent & { focused: boolean }).focused = true;
  };
  const tui = {
    children: [editor],
    mode: "tui",
    terminal: { rows: 30, columns: 100, write() {}, hideCursor() {} },
    requestRender() {},
    setFocus,
  };
  const keybindings = {
    matches(data: string, key: string) {
      return (key === "tui.select.confirm" && data === "\r")
        || (key === "tui.select.cancel" && data === "\x1b");
    },
    getKeys() { return []; },
  };
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    modelRegistry: { getAll: () => [{ id: "model-a", provider: "provider-a", name: "Model A" }] },
    ui: {
      theme: {},
      notify(message: string) { notifications.push(message); },
      custom: async (factory: (...args: unknown[]) => TestComponent, options: { overlay?: boolean }) => {
        assert.equal(options.overlay, true);
        const input = inputs[customCalls++];
        assert.ok(input, `missing input for custom call ${customCalls}`);
        let component!: TestComponent;
        let preFocus!: TestComponent | null;
        return new Promise<void>((resolve) => {
          const done = (): void => {
            if (focused === component) setFocus(preFocus);
            component.dispose?.();
            resolve();
          };
          component = factory(
            tui,
            {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            },
            keybindings,
            done,
          ) as typeof component;
          // Mirrors Pi TUI.showOverlay(): capture preFocus only after the
          // extension factory returns, then focus the mounted overlay.
          preFocus = focused;
          setFocus(component);
          onCustom?.(customCalls);
          component.handleInput?.(input);
        });
      },
    },
  };
  return {
    ctx,
    editor,
    notifications,
    get customCalls() { return customCalls; },
    get focused() { return focused; },
    get editorText() { return editorText; },
  };
}

test("closing the two-stage settings flow restores input focus to the editor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-prompt-settings-"));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts", "alpha.md"), "alpha");
  writeFileSync(join(dir, "prompts", "beta.md"), "beta");
  const view = editorFocusHarness(["\r", "\x1b"]);

  await openSettings(view.ctx as never, dir, "model-a");
  view.focused?.handleInput?.("x");

  assert.equal(view.customCalls, 2);
  assert.strictEqual(view.focused, view.editor);
  assert.equal(view.editorText, "x");
  assert.deepEqual(view.notifications, []);
});

test("saving refuses a concurrent edit made while the model panel is open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-concurrent-"));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts/brief.md"), "brief");
  const path = join(dir, "bindings.json");
  writeFileSync(path, JSON.stringify({ brief: ["model-a"] }));
  const external = JSON.stringify({ brief: ["model-b"], another: ["model-a"] });
  const view = editorFocusHarness(["\r"], () => writeFileSync(path, external));
  await openSettings(view.ctx as never, dir, "model-a");
  assert.equal(readFileSync(path, "utf8"), external);
  assert.match(view.notifications.join("\n"), /changed.*reopen|changed.*reload/i);
});

test("corrupt bindings make settings read-only without opening a picker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-readonly-"));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts/brief.md"), "brief");
  const path = join(dir, "bindings.json");
  writeFileSync(path, "{ invalid");
  const view = editorFocusHarness([]);
  await openSettings(view.ctx as never, dir, "model-a");
  assert.equal(view.customCalls, 0);
  assert.equal(readFileSync(path, "utf8"), "{ invalid");
  assert.match(view.notifications.join("\n"), /bindings\.json/);
});

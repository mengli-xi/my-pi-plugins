import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { stripAnsi } from "pi-li-uikit/text-panel";
import { UIKitGallery } from "../src/gallery.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  getFgAnsi: (color: string) => color,
  getColorMode: () => "ansi256",
} as unknown as Theme;

function gallery() {
  let closed = 0;
  const tui = {
    terminal: { rows: 30, columns: 80, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  const view = new UIKitGallery({
    tui,
    theme,
    keybindings: getKeybindings(),
    onClose: () => closed++,
  });
  return { view, closed: () => closed };
}

test("the /uikit directory lists every canonical component", () => {
  const { view } = gallery();
  const rendered = view.render(100).map(stripAnsi).join("\n");
  for (const name of [
    "TextPanel",
    "EditorPanel",
    "SearchSelect",
    "TabStrip",
    "LevelSlider",
    "MultiSelectTable",
    "ProcessPanel",
    "CollapsibleBlock",
    "SelectableCollapsiblePanel",
  ]) {
    assert.match(rendered, new RegExp(name));
  }
});

test("every directory row opens its real demo and Escape returns to the directory", () => {
  const demos = [
    /One component now handles both Markdown and plain information views/,
    /This demo has its own navigation stack/,
    /Selected: gpt-5\.6-sol/,
    /Active category: codex/,
    /Faster/,
    /4 rows · 0 selected/,
    /api-server · running/,
    /Captured tool output · 20 lines/,
    /Ran npm run check/,
  ];

  demos.forEach((expected, index) => {
    const { view, closed } = gallery();
    for (let row = 0; row < index; row++) view.handleInput("\x1b[B");
    view.handleInput("\r");
    assert.match(view.render(100).map(stripAnsi).join("\n"), expected);
    if (index === 0) assert.equal(view.wantsMouse, true);

    view.handleInput("\x1b");
    assert.match(view.render(100).map(stripAnsi).join("\n"), /UIKit gallery/);
    assert.equal(view.wantsMouse, true, "the root EditorPanel keeps the shared mouse boundary");
    assert.equal(closed(), 0);
    view.dispose();
  });
});

test("Escape from the directory closes the invocation", () => {
  const { view, closed } = gallery();
  view.handleInput("\x1b");
  assert.equal(closed(), 1);
  view.handleInput("\x1b");
  assert.equal(closed(), 1);
  assert.doesNotThrow(() => view.dispose());
});

test("Enter opens a table row under a title derived from the table and row", () => {
  const { view } = gallery();
  for (let row = 0; row < 5; row++) view.handleInput("\x1b[B");
  view.handleInput("\r");
  view.handleInput("\r");
  const rendered = view.render(100).map(stripAnsi).join("\n");
  assert.match(rendered, /MultiSelectTable > alpha/);
});

test("embedded demos inherit the common editor-slot frame", () => {
  const tabGallery = gallery();
  for (let row = 0; row < 3; row++) tabGallery.view.handleInput("\x1b[B");
  tabGallery.view.handleInput("\r");
  const tabs = tabGallery.view.render(60).map(stripAnsi);
  assert.match(tabs[0] ?? "", /^── TabStrip ─+$/);
  assert.equal(tabs[0]?.length, 60);
  assert.equal(tabs[1], "");
  assert.match(tabs[2] ?? "", /^  \[Codex \(3\)\]/);
  assert.match(tabs.at(-1) ?? "", /^─+ Tab\/Shift\+Tab switch · Escape back$/);
  assert.equal(tabs.at(-1)?.length, 60);
  tabGallery.view.dispose();

  const collapsibleGallery = gallery();
  for (let row = 0; row < 7; row++) collapsibleGallery.view.handleInput("\x1b[B");
  collapsibleGallery.view.handleInput("\r");
  const collapsible = collapsibleGallery.view.render(60).map(stripAnsi);
  assert.match(collapsible[0] ?? "", /^── CollapsibleBlock ─+$/);
  assert.equal(collapsible[0]?.length, 60);
  assert.equal(collapsible[1], "");
  assert.match(collapsible[2] ?? "", /^  ▸ Captured tool output · 20 lines$/);
  assert.match(collapsible.at(-1) ?? "", /^─+ Enter\/Space fold · o open overlay · Escape back$/);
  assert.equal(collapsible.at(-1)?.length, 60);
  collapsibleGallery.view.dispose();

  const selectableGallery = gallery();
  for (let row = 0; row < 8; row++) selectableGallery.view.handleInput("\x1b[B");
  selectableGallery.view.handleInput("\r");
  let selectable = selectableGallery.view.render(60).map(stripAnsi);
  assert.match(selectable[0] ?? "", /^─+ SelectableCollapsiblePanel ──$/);
  assert.equal(selectable[0]?.length, 60);
  assert.match(selectable.join("\n"), /^  → ▸ Ran npm run check/m);
  assert.match(selectable.at(-1) ?? "", /^─+ ↑↓ select · Enter expand\/fold · Esc close ──$/);
  assert.equal(selectable.at(-1)?.length, 60);

  selectableGallery.view.handleInput("\x1b[B");
  selectable = selectableGallery.view.render(60).map(stripAnsi);
  assert.match(selectable.join("\n"), /^  → ▸ Read src\/selectable-collapsible-panel\.ts/m);
  selectableGallery.view.handleInput("\r");
  selectable = selectableGallery.view.render(60).map(stripAnsi);
  assert.match(selectable.join("\n"), /^  → ▾ Read src\/selectable-collapsible-panel\.ts/m);
  assert.match(selectable.join("\n"), /^      Arguments\s*$/m);
  selectableGallery.view.dispose();
});


test("native outside press closes one demo through the gallery mount and wheel routes once", () => {
  const { view } = gallery();
  view.handleInput("\r");
  view.setAvailableHeight(18);
  view.render(60);
  view.setScreenOrigin(5, 0);
  const event = { type: "wheel" as const, button: "none" as const, x: 3, y: 4, screenX: 3, screenY: 9,
    width: 60, height: 18, shift: false, alt: false, ctrl: false, wheelDelta: 3 };
  assert.equal(view.handleMouse(event)?.handled, true);
  assert.match(view.render(60).map(stripAnsi).join("\n"), /4-/);
  assert.equal(view.handleMouse({ ...event, type: "press", button: "left", y: -5, screenY: 0 })?.handled, true);
  assert.match(view.render(60).map(stripAnsi).join("\n"), /UIKit gallery/);
  view.dispose();
});

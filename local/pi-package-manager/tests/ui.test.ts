import assert from "node:assert/strict";
import { test } from "node:test";

import { BorderedLoader, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { MissingSnapshotError, type PackageCatalog } from "../src/catalog.ts";
import { showPackageManager } from "../src/manager.ts";
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";

import { createEditorOverlayMount } from "pi-li-uikit/editor-overlay";

import type { ManagedPackage, ManagerAction } from "../src/types.ts";
import { filterPackages, PackageManagerView } from "../src/ui.ts";

function pkg(id: string, enabled: boolean): ManagedPackage {
  return {
    id,
    source: `npm:${id}`,
    displayName: id,
    kind: "npm",
    enabled,
    missing: false,
    protected: false,
    entries: [{
      scope: "global",
      index: 0,
      source: `npm:${id}`,
      raw: `npm:${id}`,
      enabled,
      filtered: false,
    }],
    manifest: { description: `${id} package`, resourceCounts: {} },
  };
}

const packages = [pkg("alpha", true), pkg("beta", false)];

function view(
  items: readonly ManagedPackage[],
  updates: ReadonlySet<string> = new Set(),
  onAction: (action: ManagerAction) => void = () => undefined,
): PackageManagerView {
  const tui = {
    terminal: { rows: 30, columns: 42 },
    requestRender: () => undefined,
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  return new PackageManagerView(
    tui,
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    items,
    updates,
    true,
    false,
    undefined,
    onAction,
  );
}

test("package filtering combines state and search", () => {
  assert.deepEqual(
    filterPackages(packages, { filter: "enabled", query: "alp" }, new Set()).map((item) => item.id),
    ["alpha"],
  );
  assert.deepEqual(
    filterPackages(packages, { filter: "disabled", query: "package" }, new Set()).map((item) => item.id),
    ["beta"],
  );
});

test("updates filter only shows checked identities", () => {
  assert.deepEqual(
    filterPackages(packages, { filter: "updates", query: "" }, new Set(["beta"])).map((item) => item.id),
    ["beta"],
  );
});

test("manager render never exceeds the available width", () => {
  const long = pkg("a-very-long-package-name-that-needs-truncation", true);
  long.source = `npm:${long.id}@latest`;
  long.installedPath = `/an/intentionally/long/path/${long.id}/node_modules/${long.id}`;
  long.manifest.description = "A deliberately long description that must wrap without overflowing the terminal width.";

  const tui = {
    terminal: { rows: 30, columns: 42 },
    requestRender: () => undefined,
  } as unknown as TUI;
  const plain = (text: string): string => text;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: plain,
  } as unknown as Theme;
  const view = new PackageManagerView(
    tui,
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    [long],
    new Set(),
    false,
    false,
    undefined,
    () => undefined,
  );

  for (const line of view.render(42)) assert.ok(visibleWidth(line) <= 42, line);
});

test("panel height stays fixed across selection, filters, and empty search", () => {
  const detailed = pkg("detailed", true);
  detailed.installedPath = "/a/long/path/that/wraps/across/multiple/detail/rows";
  detailed.manifest.description = "A deliberately long description that occupies more rows than other packages.";
  detailed.manifest.repository = "https://example.com/an/intentionally/long/repository/path";
  const items = [pkg("alpha", true), detailed, pkg("disabled", false)];
  const manager = view(items);
  const initialHeight = manager.render(42).length;

  manager.handleInput("\x1b[B"); // select the taller detail body
  assert.equal(manager.render(42).length, initialHeight);

  manager.handleInput("\t"); // enabled filter
  assert.equal(manager.render(42).length, initialHeight);
  manager.handleInput("\t"); // disabled filter
  assert.equal(manager.render(42).length, initialHeight);
  manager.handleInput("\t"); // updates filter: empty
  assert.equal(manager.render(42).length, initialHeight);

  manager.handleInput("/");
  manager.handleInput("no-package-matches-this");
  assert.equal(manager.render(42).length, initialHeight);
});

test("pagination owns a permanent row while narrower filters do not jump", () => {
  const items = Array.from({ length: 16 }, (_, index) => pkg(`package-${index}`, index % 2 === 0));
  const manager = view(items, new Set(["package-0"]));
  const initialHeight = manager.render(42).length;
  assert.ok(manager.render(42).some((line) => /of 16/.test(line)));

  manager.handleInput("\t");
  manager.handleInput("\t");
  manager.handleInput("\t"); // updates: one item, fewer than the bounded viewport
  const filtered = manager.render(42);
  assert.equal(filtered.length, initialHeight);
  assert.ok(!filtered.some((line) => /of 1/.test(line)));
});

function mouse(type: TuiMouseEvent["type"], x: number, y: number, wheelDelta = 0): TuiMouseEvent {
  return { type, button: "left", x, y, screenX: x, screenY: y, width: 80, height: 30,
    wheelDelta, shift: false, alt: false, ctrl: false };
}

test("manager uses the shared title/footer frame and respects both height limits", () => {
  const manager = view(packages);
  const full = manager.render(110);
  assert.match(full[0]!, /^── Plugins /);
  assert.match(full.at(-1)!, /^─+ .*Esc close ──$/);
  assert.equal(visibleWidth(full.at(-1)!), 110);
  assert.ok(full.length <= Math.floor(30 * 0.7));
  manager.setAvailableHeight(12);
  const bounded = manager.render(60);
  assert.equal(bounded.length, 12);
  assert.match(bounded[0]!, /Plugins/);
  assert.match(bounded.at(-1)!, /Esc close/);
  for (const line of bounded) assert.ok(visibleWidth(line) <= 60);
  manager.dispose();
});

test("the mounted manager consumes outside clicks and does not trigger package actions", () => {
  const actions: ManagerAction[] = [];
  const manager = view(packages, new Set(), (action) => actions.push(action));
  const mount = createEditorOverlayMount();
  const tui = { mode: "fullscreen", terminal: { rows: 30, columns: 80, write() {} },
    children: [], requestRender() {} } as unknown as TUI;
  const panel = mount.mount(tui, manager);
  (panel as unknown as { focused: boolean }).focused = true;
  panel.render(80);
  assert.equal((panel as unknown as { wantsMouse: boolean }).wantsMouse, true);
  assert.equal(panel.handleMouse?.(mouse("press", 0, 0))?.handled, true);
  assert.deepEqual(actions, [{ type: "close" }]);
  panel.handleMouse?.(mouse("release", 0, 0));
  panel.handleMouse?.(mouse("click", 0, 0));
  assert.equal(actions.length, 1);
  (panel as unknown as { dispose(): void }).dispose();
});

test("wheel navigation stays in the manager and search rejects control reports", () => {
  const manager = view(Array.from({ length: 20 }, (_, index) => pkg(`package-${index}`, true)));
  manager.focused = true;
  manager.setScreenOrigin(0, 0);
  manager.render(80);
  assert.equal(manager.handleMouse(mouse("wheel", 0, 7, 1))?.handled, true);
  assert.equal(manager.getViewState().selectedId, "package-3");
  manager.handleInput("/");
  manager.handleInput("\x1b[99~");
  manager.handleInput("\x1b[<0;10;12M");
  assert.equal(manager.getViewState().query, "");
  manager.handleInput("package-3");
  assert.equal(manager.getViewState().selectedId, "package-3");
  manager.dispose();
});

test("a height-limited detail viewport keeps later package metadata accessible", () => {
  const detailed = pkg("detail", true);
  detailed.installedPath = "/complete/package/path";
  detailed.manifest.description = "A long description that consumes the first detail rows in a short panel.";
  detailed.manifest.repository = "https://example.com/repository";
  const manager = view([detailed]);
  manager.focused = true;
  manager.setAvailableHeight(13);
  manager.setScreenOrigin(0, 0);
  const initial = manager.render(60);
  const detailRow = initial.findIndex((line) => line.includes("Package info"));
  assert.ok(detailRow > 0);
  manager.handleMouse(mouse("wheel", 0, detailRow + 1, 1));
  const scrolled = manager.render(60);
  assert.equal(manager.getViewState().selectedId, "detail");
  assert.equal(scrolled.length, initial.length);
  assert.ok(scrolled.some((line) => line.includes("/complete/package/path")));
  manager.dispose();
});

async function driveManager(catalog: PackageCatalog, keys: string[], confirmations: boolean[]) {
  const notices: string[] = [];
  const questions: string[] = [];
  const tui = { mode: "fullscreen", terminal: { rows: 30, columns: 80, write() {} },
    children: [], requestRender() {} } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  const ctx = {
    ui: {
      custom: (factory: (tui: TUI, theme: Theme, bindings: KeybindingsManager, done: (value: unknown) => void) => {
        handleInput?: (key: string) => void; dispose?: () => void;
      }) => new Promise((resolve) => {
        const component = factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), (value) => {
          component.dispose?.(); resolve(value);
        });
        if (!(component instanceof BorderedLoader)) {
          const key = keys.shift(); assert.notEqual(key, undefined, "unexpected extra panel");
          component.handleInput?.(key!);
        }
      }),
      notify: (message: string) => { notices.push(message); },
      confirm: async (_title: string, message: string) => {
        questions.push(message); assert.ok(confirmations.length, "unexpected confirmation");
        return confirmations.shift()!;
      },
    },
    reload: async () => assert.fail("reload was not approved"),
  } as unknown as ExtensionCommandContext;
  await showPackageManager(ctx, catalog);
  assert.deepEqual(keys, []); assert.deepEqual(confirmations, []);
  return { notices, questions };
}

test("missing-filter consent only retries with explicit approval", async () => {
  for (const approved of [false, true]) {
    const attempts: unknown[] = [];
    const item = pkg("disabled", false);
    const catalog = {
      list: async () => [item],
      setEnabled: async (_id: string, _enabled: boolean, options?: { allowWithoutSnapshot?: boolean }) => {
        attempts.push(options);
        if (!options?.allowWithoutSnapshot) throw new MissingSnapshotError();
        item.enabled = true;
      },
    } as unknown as PackageCatalog;
    const result = await driveManager(catalog, [" ", "q"], approved ? [true, false] : [false]);
    assert.deepEqual(attempts, approved ? [undefined, { allowWithoutSnapshot: true }] : [undefined]);
    assert.equal(item.enabled, approved);
    assert.match(result.questions[0]!, /all resources/);
  }
});

test("an empty update result is not reported as proof of current versions", async () => {
  const catalog = { list: async () => packages, checkForUpdates: async () => new Set() } as unknown as PackageCatalog;
  const result = await driveManager(catalog, ["U", "q"], []);
  assert.ok(result.notices.some((message) => message.startsWith("No updates detected.")));
  assert.ok(!result.notices.some((message) => message.startsWith("All updateable packages are current")));
});

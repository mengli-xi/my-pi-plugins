import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner, SessionManager, type EntryRenderer, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { disposePresentationOwner, installPresentationOwner, presentationRunnerBelongsTo } from "../src/presentation-owner.ts";

function fixture(manager = SessionManager.inMemory()) {
  const entryRenderers = new Map<string, EntryRenderer>();
  const pi = { on() {}, registerEntryRenderer(name: string, renderer: EntryRenderer) { entryRenderers.set(name, renderer); } } as unknown as ExtensionAPI;
  installPresentationOwner(pi);
  // Exercise Pi's actual lookup and context before session_start, without any
  // Markdown registration, TUI, provider or persisted ownership entry.
  const runner = new ExtensionRunner(
    [{ entryRenderers } as ConstructorParameters<typeof ExtensionRunner>[0][number]],
    {} as ConstructorParameters<typeof ExtensionRunner>[1], process.cwd(), manager,
    {} as ConstructorParameters<typeof ExtensionRunner>[4],
  );
  return { pi, runner, manager, entryRenderers, close: () => disposePresentationOwner(pi) };
}

test("pre-bind owners use public renderer keys, isolate Main/child and survive reload", () => {
  const main = fixture(), child = fixture();
  let replacement: ReturnType<typeof fixture> | undefined;
  try {
    assert.equal(presentationRunnerBelongsTo(main.pi, child.runner), false);
    assert.equal(presentationRunnerBelongsTo(main.pi, main.runner), true);
    assert.equal(presentationRunnerBelongsTo(child.pi, child.runner), true);
    assert.equal(presentationRunnerBelongsTo(child.pi, main.runner), false);
    assert.deepEqual(main.manager.getEntries(), [], "ownership never writes history");
    main.close();
    assert.equal(presentationRunnerBelongsTo(main.pi, main.runner), false);
    assert.equal(presentationRunnerBelongsTo(child.pi, child.runner), true);
    replacement = fixture(main.manager);
    assert.equal(presentationRunnerBelongsTo(replacement.pi, replacement.runner), true);
    assert.equal(presentationRunnerBelongsTo(replacement.pi, child.runner), false);
    main.close();
    assert.equal(presentationRunnerBelongsTo(replacement.pi, replacement.runner), true, "late teardown leaves replacement live");
  } finally { main.close(); child.close(); replacement?.close(); }
});

test("owner lookup does not depend on renderer callback identity", () => {
  const owner = fixture();
  try {
    for (const [key, render] of owner.entryRenderers) {
      owner.entryRenderers.set(key, (...args) => render(...args));
    }
    assert.equal(presentationRunnerBelongsTo(owner.pi, owner.runner), true);
  } finally { owner.close(); }
});

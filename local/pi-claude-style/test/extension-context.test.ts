import assert from "node:assert/strict";
import test from "node:test";
import { snapshotExtensionContext } from "../src/extension-context.ts";

test("an invalidated Pi context fails closed during reload dispatch", () => {
  const stale = {
    get hasUI() {
      throw new Error("Extension runner is no longer active");
    },
  };
  assert.equal(snapshotExtensionContext(stale as never), undefined);
});

test("an active context is read once into a stable UI snapshot", () => {
  let reads = 0;
  const ui = { theme: { name: "test" } };
  const active = {
    get hasUI() { reads++; return true; },
    get mode() { reads++; return "tui"; },
    get ui() { reads++; return ui; },
  };
  assert.deepEqual(snapshotExtensionContext(active as never), {
    hasUI: true,
    mode: "tui",
    ui,
  });
  assert.equal(reads, 3);
});

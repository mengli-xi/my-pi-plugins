import assert from "node:assert/strict";
import test from "node:test";

import {
  PI_1_5_SURFACES,
  PI_COMPAT_BASELINE,
  privatePiSurfaces,
  publicPiSurfaces,
} from "../src/compat/pi-1.3.ts";
import { ALL_PROBES } from "../src/probes.ts";

test("Pi 1.5 compat catalog has unique surface ids", () => {
  assert.equal(PI_COMPAT_BASELINE, "1.5");
  assert.equal(
    new Set(PI_1_5_SURFACES.map((surface) => surface.id)).size,
    PI_1_5_SURFACES.length,
  );
  for (const surface of PI_1_5_SURFACES) {
    assert.ok(surface.owner.length > 0);
    assert.ok(surface.members.length > 0);
  }
});

test("every private compat surface has exactly one probe", () => {
  assert.deepEqual(
    privatePiSurfaces().map((surface) => surface.id).sort(),
    ALL_PROBES.map((probe) => probe.id).sort(),
  );
});

test("public exported members are verified by TypeScript, not private probes", () => {
  const probed = new Set(ALL_PROBES.map((probe) => probe.id));
  assert.deepEqual(
    publicPiSurfaces().map((surface) => surface.id).sort(),
    [
      "assistant-message.updateContent",
      "editor-chrome.editor",
      "fullscreen.focus",
      "model-selector-tabs.rowPresentation",
      "presentation-owner.renderer-boundaries",
      "repeated-errors.notify",
      "repeated-errors.showError",
      "user-message.render",
    ],
  );
  assert.ok(publicPiSurfaces().every((surface) => surface.verification === "typescript"));
  assert.ok(publicPiSurfaces().every((surface) => !probed.has(surface.id)));
});

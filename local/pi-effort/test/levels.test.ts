import assert from "node:assert/strict";
import { test } from "node:test";

import { EFFORT_LEVELS, matchLevel, supportedLevels, topPiLevel } from "../levels.ts";

test("a model without reasoning offers nothing but off", () => {
  assert.deepEqual(supportedLevels({ reasoning: false }), ["off"]);
});

test("without a model the whole ladder is offered, since pi clamps on apply", () => {
  assert.deepEqual(supportedLevels(undefined), [...EFFORT_LEVELS]);
});

test("the top two rungs exist only when the model maps them", () => {
  const plain = supportedLevels({ reasoning: true });
  assert.deepEqual(plain, ["off", "minimal", "low", "medium", "high", "ultra"]);

  const mapped = supportedLevels({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
  assert.deepEqual(mapped, ["off", "minimal", "low", "medium", "high", "xhigh", "ultra"]);
});

test("a null mapping removes a level", () => {
  const levels = supportedLevels({ reasoning: true, thinkingLevelMap: { minimal: null } });
  assert.deepEqual(levels, ["off", "low", "medium", "high", "ultra"]);
});

const AVAILABLE = supportedLevels({
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
});

test("a level name resolves to itself", () => {
  assert.deepEqual(matchLevel("high", AVAILABLE), { ok: true, level: "high" });
  assert.deepEqual(matchLevel("  XHIGH ", AVAILABLE), { ok: true, level: "xhigh" });
});

test("an unambiguous prefix resolves, an ambiguous one reports the candidates", () => {
  assert.deepEqual(matchLevel("hi", AVAILABLE), { ok: true, level: "high" });
  assert.deepEqual(matchLevel("x", AVAILABLE), { ok: true, level: "xhigh" });

  const ambiguous = matchLevel("m", AVAILABLE);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.ok ? "" : ambiguous.message, /ambiguous: minimal, medium, max/);
});

test("a number picks by position in the list the picker shows", () => {
  assert.deepEqual(matchLevel("1", AVAILABLE), { ok: true, level: "off" });
  assert.deepEqual(matchLevel("5", AVAILABLE), { ok: true, level: "high" });
  assert.equal(matchLevel("99", AVAILABLE).ok, false);
});

test("aliases cover the words that are not prefixes of a level", () => {
  assert.deepEqual(matchLevel("none", AVAILABLE), { ok: true, level: "off" });
  assert.deepEqual(matchLevel("maximum", AVAILABLE), { ok: true, level: "max" });
  assert.deepEqual(matchLevel("mid", AVAILABLE), { ok: true, level: "medium" });
});

test("a real level the model lacks is named as such, not reported as unknown", () => {
  const limited = supportedLevels({ reasoning: true });
  const result = matchLevel("max", limited);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /does not offer "max"/);
});

test("nonsense is rejected with the list of what would work", () => {
  const result = matchLevel("turbo", AVAILABLE);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /Unknown reasoning effort "turbo".*off, minimal/);
});

test("an alias for a level the model lacks is not silently accepted", () => {
  const result = matchLevel("maximum", supportedLevels({ reasoning: true }));
  assert.equal(result.ok, false);
});

test("ultra is offered by any reasoning model and pins its top real rung", () => {
  // No max needed — ultra sits on whatever the model's best level is.
  const modest = supportedLevels({ reasoning: true });
  assert.ok(modest.includes("ultra"));
  assert.equal(topPiLevel(modest), "high");

  const full = supportedLevels({
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  });
  assert.equal(topPiLevel(full), "max");

  // A model with no reasoning has nothing for ultra to sit on.
  const none = supportedLevels({ reasoning: false });
  assert.deepEqual(none, ["off"]);
  assert.equal(topPiLevel(none), undefined);
});

test("ultra resolves as an argument like any other rung", () => {
  assert.deepEqual(matchLevel("ultra", AVAILABLE), { ok: true, level: "ultra" });
  assert.deepEqual(matchLevel("u", AVAILABLE), { ok: true, level: "ultra" });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateOutput } from "../src/output.ts";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/eval-real/cells.json", import.meta.url), "utf8"));
for (const cell of fixture.cells) for (const slot of ["main", "small"]) test(`saved neutralized ${cell.name} ${slot} reads without source/schema gates`, () => {
  const result = validateOutput(cell.outputs[slot]);
  assert.ok(result.summary.trim());
  assert.doesNotMatch(result.summary, /unverified:|chars \[|Memory candidates are review-only/);
});

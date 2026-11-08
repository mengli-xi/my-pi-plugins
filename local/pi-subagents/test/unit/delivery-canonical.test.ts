import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalDeliveryJsonV1, canonicalJsonV1 } from "../../src/persistence/canonical.js";

test("delivery canonical encoding preserves the fixed completion digest", () => {
  const text = canonicalDeliveryJsonV1({ content: "done", details: { version: 1, ids: ["cmp_one"] } });
  assert.equal(createHash("sha256").update(text).digest("hex"), "5d35727d8432b9d59fdc63876602794fe9a73771fe116b1d59f962fd41075f47");
});
test("delivery costs allow finite decimals while metadata stays integer-only", () => {
  assert.equal(canonicalDeliveryJsonV1({ cost: 0.125 }), '{"cost":0.125}');
  assert.throws(() => canonicalJsonV1({ cost: 0.125 }), /safe integer/);
});
test("delivery preserves NFD text while metadata continues to reject it", () => {
  assert.equal(canonicalDeliveryJsonV1({ text: "e\u0301" }), '{"text":"e\u0301"}');
  assert.throws(() => canonicalJsonV1({ text: "e\u0301" }), /NFC/);
});

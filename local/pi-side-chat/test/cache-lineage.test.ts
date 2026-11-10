import assert from "node:assert/strict";
import test from "node:test";
import { rewritePromptCacheLineage, supportsPromptCacheLineage } from "../cache-lineage.ts";

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`${api} replaces only prompt_cache_key`, () => {
    const payload = { model: "test", prompt_cache_key: "child", input: [{ role: "user" }] };
    assert.deepEqual(rewritePromptCacheLineage(api, payload, "parent"), {
      model: "test",
      prompt_cache_key: "parent",
      input: [{ role: "user" }],
    });
    assert.equal(supportsPromptCacheLineage(api), true);
  });
}

test("unsupported providers and unexpected payloads remain unchanged", () => {
  const payload = { value: 1 };
  assert.equal(rewritePromptCacheLineage("anthropic-messages", payload, "parent"), payload);
  assert.equal(rewritePromptCacheLineage("openai-responses", payload, "parent"), payload);
  assert.equal(supportsPromptCacheLineage("anthropic-messages"), false);
});

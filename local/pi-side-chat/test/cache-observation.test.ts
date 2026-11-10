import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { observeCache } from "../cache-observation.ts";

function usage(input: number, cacheRead: number, cacheWrite = 0): Usage {
  return {
    input,
    output: 1,
    cacheRead,
    cacheWrite,
    totalTokens: input + cacheRead + cacheWrite + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("cache observation reports hit from provider usage", () => {
  const result = observeCache(usage(100, 9_000));
  assert.deepEqual(result, { status: "hit", cacheRead: 9_000, cacheWrite: 0, promptTokens: 9_100 });
});

test("cache observation reports miss when provider reports prompt usage without reads", () => {
  const result = observeCache(usage(10_000, 0));
  assert.deepEqual(result, { status: "miss", cacheRead: 0, cacheWrite: 0, promptTokens: 10_000 });
});

test("cache observation stays unknown when provider reports no prompt usage", () => {
  const result = observeCache(usage(0, 0));
  assert.equal(result.status, "unknown");
});

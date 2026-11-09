import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionContext, estimateTokens } from "@earendil-works/pi-coding-agent";
import { buildStatusLinePayload } from "../../src/statusline/payload.ts";
import { StatuslineTranscriptCache } from "../../src/statusline/transcript.ts";

const user = { type: "message", id: "u", parentId: null, timestamp: "2026-10-23T00:00:00Z",
  message: { role: "user", content: "old prompt", timestamp: 1 } };
const assistant = (id: string, parentId: string, input = 180_000) => ({
  type: "message", id, parentId, timestamp: "2026-10-23T00:00:01Z",
  message: { role: "assistant", content: [{ type: "text", text: "reply" }],
    timestamp: 2, stopReason: "stop", provider: "test", model: "test", api: "test",
    usage: { input, output: 100, cacheRead: 30_000, cacheWrite: 10_000,
      totalTokens: input + 40_100, cost: { total: 1 } } },
});
const before = assistant("a", "u");

for (const fromHook of [false, true]) {
  test(`post-compaction occupancy retires old request and restores branch usage (fromHook=${fromHook})`, async () => {
    const cache = new StatuslineTranscriptCache();
    let branch: any[] = [user, before];
    const ctx = { cwd: "/tmp", model: { contextWindow: 1_000_000 },
      // A stale fallback percent must not leak into the compacted state.
      getContextUsage: () => ({ tokens: null, percent: 22, contextWindow: 1_000_000 }),
      sessionManager: { getSessionId: () => `payload-compact-${fromHook}`,
        getSessionFile: () => null, getBranch: () => branch } };
    const build = () => buildStatusLinePayload(ctx, cache);
    const initial = await build();
    assert.equal(initial.context_window.current_usage?.input_tokens, 180_000);
    assert.equal(initial.context_window.used_percentage, 22);
    assert.equal(initial.context_window.usage_source, "usage");
    assert.ok(initial.context_window.cache);

    const compact = { type: "compaction", id: "c", parentId: "a",
      // Deliberately earlier clock: ancestry, not wall time, defines the boundary.
      timestamp: "2026-10-22T00:00:00Z", summary: "short summary",
      firstKeptEntryId: "a", tokensBefore: 220_100, fromHook };
    branch = [...branch, compact];
    const estimated = await build();
    const tokens = buildSessionContext(branch).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    assert.equal(estimated.context_window.estimated_tokens, tokens);
    assert.deepEqual(estimated.context_window.current_usage, {
      input_tokens: tokens, output_tokens: null,
      cache_creation_input_tokens: null, cache_read_input_tokens: null,
    });
    assert.equal(estimated.context_window.used_percentage, Math.round(tokens / 1_000_000 * 100));
    assert.equal(estimated.context_window.usage_source, "estimate");
    assert.equal(estimated.context_window.cache, null);
    assert.equal(estimated.cost.latest_request_duration_ms, null);
    assert.equal(estimated.exceeds_200k_tokens, false);
    assert.equal(estimated.context_window.total_input_tokens, 180_000);
    // A fresh cache is the /reload path, with retained pre-compaction assistant usage.
    const reloaded = await buildStatusLinePayload(ctx, new StatuslineTranscriptCache());
    assert.deepEqual(reloaded.context_window, estimated.context_window);

    branch = [...branch, { type: "message", id: "failed", parentId: "c", timestamp: 3,
      message: { ...before.message, stopReason: "error" } }];
    assert.equal((await build()).context_window.usage_source, "estimate");
    branch = [...branch, { type: "message", id: "zero", parentId: "failed", timestamp: 4,
      message: { ...before.message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } }];
    assert.equal((await build()).context_window.usage_source, "estimate");
    branch = [...branch, assistant("b", "zero", 10_000)];
    const real = await build();
    assert.equal(real.context_window.usage_source, "usage");
    assert.equal(real.context_window.estimated_tokens, null);
    assert.equal(real.context_window.current_usage?.input_tokens, 10_000);
    assert.equal(real.context_window.used_percentage, 5);
    assert.ok(real.context_window.cache);
    assert.equal(real.context_window.cache.reuse_percent, null);

    // Switch back across the compact boundary, then onto a sibling of equal length.
    branch = [user, before];
    assert.deepEqual((await build()).context_window, initial.context_window);
    branch = [user, assistant("sibling", "u", 20_000)];
    assert.equal((await build()).context_window.current_usage?.input_tokens, 20_000);
    branch = [user, before, compact];
    assert.deepEqual((await build()).context_window, estimated.context_window);
  });
}

test("an unavailable post-compaction estimate exposes pending without stale fallback metrics", async () => {
  const ctx = { cwd: "/tmp", model: { contextWindow: 1_000_000 },
    getContextUsage: () => ({ tokens: 220_000, percent: 22 }),
    sessionManager: { getSessionId: () => "payload-pending", getBranch: () => [user, before,
      { type: "compaction", id: "c", parentId: "a", firstKeptEntryId: "a",
        // A malformed historical summary cannot be estimated by Pi.
        timestamp: "2026-10-23T00:00:02Z", summary: null, tokensBefore: 220_000 }] } };
  const payload = await buildStatusLinePayload(ctx, new StatuslineTranscriptCache());
  assert.equal(payload.context_window.usage_source, "pending");
  assert.equal(payload.context_window.current_usage, null);
  assert.equal(payload.context_window.used_percentage, null);
  assert.equal(payload.context_window.cache, null);
});

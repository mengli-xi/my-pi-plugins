import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG, readConfig } from "../src/config.ts";
import { generateSmall } from "../src/small.ts";
import type { Attempt } from "../src/generate.ts";
import type { CompactionDeadline } from "../src/deadline.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "current-fake", id: "main", api: "fake", name: "main", contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ["text"], cost: usage.cost, baseUrl: "" };
function harness() {
  const manager = SessionManager.inMemory("/fixture");
  manager.appendMessage({ role: "user", content: "Keep the public API.", timestamp: 0 });
  const calls: { provider: string; id: string; reasoning: unknown }[] = [], lookups: string[] = [];
  const ctx: any = {
    model, thinkingLevel: "low", sessionManager: manager, ui: { notify() {} },
    modelRegistry: {
      find(provider: string, id: string) { lookups.push(`${provider}/${id}`); return provider === "chosen-fake" && id === "small" ? { ...model, provider, id } : undefined; },
      streamSimple(selected: typeof model, _context: unknown, options: any) {
        calls.push({ provider: selected.provider, id: selected.id, reasoning: options.reasoning });
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "## Handoff\nKeep the public API." }], provider: selected.provider, model: selected.id, api: "fake", usage, stopReason: "stop", timestamp: 0 } });
        return stream;
      },
    },
  };
  const run = (config = DEFAULT_CONFIG, deadline?: CompactionDeadline) => {
    const attempts: Attempt[] = [], output: any = {};
    return generateSmall(ctx, { ...config, outputTokens: 1024 }, manager.getBranch(), { mergedText: "", estimatedTokens: 0 } as any,
      { goal: null, memory: [], skills: [], known: [] }, new AbortController().signal, attempts, [], "small", output, async () => true, { enabled: false }, deadline).then(result => ({ result, attempts, output }));
  };
  return { ctx, calls, lookups, run };
}

test("smallModel is optional, has no provider default and explicit malformed configurations diagnose", async () => {
  const root = mkdtempSync(join(tmpdir(), "compact-model-config-")), path = join(root, "pi-session-compact/config.json");
  mkdirSync(join(root, "pi-session-compact"));
  try {
    assert.equal(DEFAULT_CONFIG.mode, "main");
    assert.equal(DEFAULT_CONFIG.smallModel, undefined);
    assert.equal((await readConfig(root)).smallModel, undefined);
    for (const smallModel of [null, "fake/small", [], {}, { provider: "fake" }, { provider: " ", id: "small" }, { provider: "fake", id: "small", effort: "unknown" }]) {
      writeFileSync(path, JSON.stringify({ smallModel }));
      await assert.rejects(readConfig(root), /Invalid smallModel/);
    }
    writeFileSync(path, JSON.stringify({ smallModel: { provider: "chosen-fake", id: "small" } }));
    assert.deepEqual((await readConfig(root)).smallModel, { provider: "chosen-fake", id: "small", effort: "off" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("small, auto and shadow source paths without smallModel use the current model and effort", async () => {
  for (const config of [{ ...DEFAULT_CONFIG, mode: "small" as const }, { ...DEFAULT_CONFIG, mode: "auto" as const }, { ...DEFAULT_CONFIG, shadow: { enabled: true, adopt: "main" as const } }]) {
    const h = harness(), { result, attempts } = await h.run(config);
    assert.equal(result.model, "current-fake/main");
    assert.deepEqual(h.calls, [{ provider: "current-fake", id: "main", reasoning: "low" }]);
    assert.deepEqual(h.lookups, []);
    assert.equal(attempts[0]!.requestedEffort, "low");
  }
});

test("explicit smallModel is exact, including when the current model has a faster measured plan", async () => {
  const h = harness();
  const config = { ...DEFAULT_CONFIG, smallModel: { provider: "chosen-fake", id: "small", effort: "off" as const }, throughput: {
    "current-fake/main/off": { version: "fixture", measuredAt: new Date().toISOString(), inputTokensPerSecond: 1e12, outputTokensPerSecond: 1e12, safetyFactor: 1, cache: "cold" as const, concurrency: "single" as const },
  } };
  const deadline = { remainingMs: () => 1, throwIfExpired() {}, attempt() {} } as unknown as CompactionDeadline;
  const { result, output } = await h.run(config, deadline);
  assert.equal(output.requestPlan.fitsDeadline, false, "a faster current profile does not authorize substitution");
  assert.equal(result.model, "chosen-fake/small");
  assert.deepEqual(h.calls, [{ provider: "chosen-fake", id: "small", reasoning: undefined }]);
  assert.deepEqual(h.lookups, ["chosen-fake/small"]);
});

test("explicit unavailable model or unsupported effort rejects without substituting another provider", async () => {
  for (const smallModel of [{ provider: "missing-fake", id: "absent", effort: "off" as const }, { provider: "chosen-fake", id: "small", effort: "high" as const }]) {
    const h = harness();
    if (smallModel.effort === "high") {
      const find = h.ctx.modelRegistry.find;
      h.ctx.modelRegistry.find = (...args: any[]) => ({ ...find(...args), reasoning: false });
    }
    await assert.rejects(h.run({ ...DEFAULT_CONFIG, smallModel }), smallModel.effort === "high" ? /small-effort-unsupported:high/ : /small-model-unavailable:missing-fake\/absent/);
    assert.equal(h.calls.length, 0);
  }
});

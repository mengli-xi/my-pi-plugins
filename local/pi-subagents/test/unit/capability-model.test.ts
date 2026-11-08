import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { listSubagentModelIdsV1, listSubagentModelsV1, resolveFrozenExecutionSelectionV1 } from "../../src/capabilities/model.js";
import type { ResolvedAgentRoleV1 } from "../../src/roles/types.js";

function model(provider: string, id: string, reasoning = true, thinkingLevelMap?: Record<string, unknown>): Model<any> { return { provider, id, name: id, api: "openai-responses", baseUrl: "https://example.test", reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) } as Model<any>; }
function role(values: Partial<ResolvedAgentRoleV1["frontmatter"]> = {}): ResolvedAgentRoleV1 { return { version: 1, source_kind: "builtin", source_identity: "role", frontmatter: { name: "test", description: "test", tools: "*", ...values }, body: "body", content_sha256: "a".repeat(64), resolved_at: "2026-08-18T00:00:00.000Z" }; }

const a = model("one", "shared"); const b = model("two", "shared"); const plain = model("one", "plain", false); const limited = model("one", "limited", true, { xhigh: null, max: null, medium: null });

test("model query returns only matching canonical IDs from the caller scope", () => {
  assert.deepEqual(listSubagentModelIdsV1({ availableModels: [a, b, plain], scopedModels: [], query: "SHARED" }), ["one/shared", "two/shared"]);
  assert.deepEqual(listSubagentModelIdsV1({ availableModels: [a, b, plain], scopedModels: [{ model: b }], query: "shared" }), ["two/shared"]);
  assert.deepEqual(listSubagentModelIdsV1({ availableModels: [a, b, plain], scopedModels: [], query: "missing" }), []);
});

test("model resolver honors explicit, role, parent precedence and canonicalizes identity", () => {
  assert.deepEqual(resolveFrozenExecutionSelectionV1({ availableModels: [a], scopedModels: [], parentModel: a, parentThinkingLevel: "high", role: role() }), { provider: "one", modelId: "shared", canonicalModel: "one/shared", reasoningEffort: "high" });
  assert.equal(resolveFrozenExecutionSelectionV1({ availableModels: [a, b], scopedModels: [], parentModel: a, role: role({ model: "two/shared" }), explicitModel: "one/shared" }).provider, "one");
  assert.equal(resolveFrozenExecutionSelectionV1({ availableModels: [a, b], scopedModels: [], role: role({ model: "two/shared" }) }).provider, "two");
});

test("role model outranks the parent model and switching models resets effort to clamped medium", () => {
  const switched = resolveFrozenExecutionSelectionV1({ availableModels: [a, b], scopedModels: [], parentModel: a, parentThinkingLevel: "high", role: role({ model: "two/shared" }) });
  assert.equal(switched.canonicalModel, "two/shared");
  assert.equal(switched.reasoningEffort, "medium");
  assert.equal(resolveFrozenExecutionSelectionV1({ availableModels: [a, limited], scopedModels: [], parentModel: a, parentThinkingLevel: "high", role: role({ model: "one/limited" }) }).reasoningEffort, "high");
});

test("bare duplicate model IDs and models outside non-empty scope reject", () => {
  assert.throws(() => resolveFrozenExecutionSelectionV1({ availableModels: [a, b], scopedModels: [], role: role(), explicitModel: "shared" }), /unavailable/);
  assert.throws(() => resolveFrozenExecutionSelectionV1({ availableModels: [a, b], scopedModels: [{ model: a }], role: role(), explicitModel: "two/shared" }), /unavailable/);
});

test("explicit and role efforts report the selected model's supported levels while default medium clamps deterministically", () => {
  const unsupported = /reasoning effort is unsupported: high; supported: off/;
  assert.throws(() => resolveFrozenExecutionSelectionV1({ availableModels: [plain], scopedModels: [], role: role(), explicitModel: "one/plain", explicitReasoningEffort: "high" }), unsupported);
  assert.throws(() => resolveFrozenExecutionSelectionV1({ availableModels: [plain], scopedModels: [], role: role({ reasoning_effort: "high" }), explicitModel: "one/plain" }), unsupported);
  assert.throws(() => resolveFrozenExecutionSelectionV1({ availableModels: [plain], scopedModels: [], parentModel: plain, parentThinkingLevel: "high", role: role() }), unsupported);
  assert.equal(resolveFrozenExecutionSelectionV1({ availableModels: [plain], scopedModels: [], role: role(), explicitModel: "one/plain" }).reasoningEffort, "off");
  assert.equal(resolveFrozenExecutionSelectionV1({ availableModels: [limited], scopedModels: [], role: role(), explicitModel: "one/limited" }).reasoningEffort, "high");
});

test("service tier uses explicit then role precedence without implicit inheritance", () => {
  assert.equal(resolveFrozenExecutionSelectionV1({ availableModels: [a], scopedModels: [], parentModel: a, parentThinkingLevel: "medium", role: role({ service_tier: "role" }), explicitServiceTier: "explicit" }).serviceTier, "explicit");
  assert.equal(resolveFrozenExecutionSelectionV1({ availableModels: [a], scopedModels: [], parentModel: a, parentThinkingLevel: "medium", role: role({ service_tier: "role" }) }).serviceTier, "role");
  assert.equal(Object.hasOwn(resolveFrozenExecutionSelectionV1({ availableModels: [a], scopedModels: [], parentModel: a, parentThinkingLevel: "medium", role: role() }), "serviceTier"), false);
});

test("model query drops providers that spawn_agent would reject", () => {
  assert.deepEqual(listSubagentModelIdsV1({ availableModels: [a, b, plain], scopedModels: [], query: "shared", excludeProviderIds: new Set(["one"]) }), ["two/shared"]);
  assert.deepEqual(listSubagentModelIdsV1({ availableModels: [a, b, plain], scopedModels: [{ model: a }], query: "shared", excludeProviderIds: new Set(["one"]) }), []);
});

test("model search matches all words across provider/model in any order", () => {
  const sol = model("alternate", "gpt-6.1-sol");
  for (const query of ["alternate/gpt-6.1-sol", "gpt-6.1-sol", "alternate", "alternate sol", "SOL AlTeRnAtE", " alternate:gpt-6.1-sol/ ", "sol\n\talternate"]) {
    assert.deepEqual(listSubagentModelsV1({ availableModels: [sol, a, sol], scopedModels: [], query }), { models: ["alternate/gpt-6.1-sol"], unavailable: [] }, query);
  }
  assert.deepEqual(listSubagentModelsV1({ availableModels: [sol, a], scopedModels: [], query: "alternate missing" }), { models: [], unavailable: [] });
});

test("model search separates excluded providers and models outside scope with reasons", () => {
  const sol = model("alternate", "gpt-6.1-sol");
  const result = listSubagentModelsV1({ availableModels: [b, sol, a, sol], scopedModels: [{ model: b }], query: "", excludeProviderIds: new Set(["alternate"]) });
  assert.deepEqual(result.models, ["two/shared"]);
  assert.deepEqual(result.unavailable, [
    { id: "alternate/gpt-6.1-sol", reason: "provider has no subagent support" },
    { id: "one/shared", reason: "outside --models scope" },
  ]);
  const excluded = listSubagentModelsV1({ availableModels: [sol, b], scopedModels: [], query: "sol alternate", excludeProviderIds: new Set(["alternate"]) });
  assert.deepEqual(excluded.models, []);
  assert.equal(excluded.unavailable[0]!.id, "alternate/gpt-6.1-sol");
  assert.doesNotMatch(excluded.unavailable[0]!.reason, /--models/);
  assert.deepEqual(listSubagentModelsV1({ availableModels: [sol, b], scopedModels: [], query: "missing", excludeProviderIds: new Set(["alternate"]) }), { models: [], unavailable: [] });
});

test("exact canonical model match returns only itself even when unavailable", () => {
  const sol = model("alternate", "gpt-6.1-sol"), extended = model("alternate", "gpt-6.1-sol-extra");
  const input = { availableModels: [extended, sol], scopedModels: [], query: "  ALTERNATE/GPT-6.1-SOL  " };
  assert.deepEqual(listSubagentModelsV1(input), { models: ["alternate/gpt-6.1-sol"], unavailable: [] });
  assert.deepEqual(listSubagentModelsV1({ ...input, excludeProviderIds: new Set(["alternate"]) }), { models: [], unavailable: [{ id: "alternate/gpt-6.1-sol", reason: "provider has no subagent support" }] });
  assert.deepEqual(listSubagentModelsV1({ ...input, scopedModels: [{ model: extended }] }), { models: [], unavailable: [{ id: "alternate/gpt-6.1-sol", reason: "outside --models scope" }] });
  assert.deepEqual(listSubagentModelsV1({ ...input, query: "sol alternate" }), { models: ["alternate/gpt-6.1-sol", "alternate/gpt-6.1-sol-extra"], unavailable: [] });
});

test("word matches share a twenty-result cap with a numeric omitted count", () => {
  const models = Array.from({ length: 25 }, (_, index) => model(index % 2 ? "b" : "a", `match-${String(index).padStart(2, "0")}`));
  const result = listSubagentModelsV1({ availableModels: [...models].reverse(), scopedModels: [], query: "match", excludeProviderIds: new Set(["a"]) });
  assert.equal(result.models.length + result.unavailable.length, 20);
  assert.equal(result.more, 5);
  assert.deepEqual([...result.models, ...result.unavailable.map((entry) => entry.id)].sort(), models.map((entry) => `${entry.provider}/${entry.id}`).sort().slice(0, 20));
  assert.deepEqual(listSubagentModelsV1({ availableModels: models, scopedModels: [], query: "b/match-23" }), { models: ["b/match-23"], unavailable: [] });
});

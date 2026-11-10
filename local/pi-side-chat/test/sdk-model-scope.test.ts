import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { sideExecutionPlan } from "../sdk-factories.ts";

function fixture(provider: string, registered: boolean) {
  const model = fauxProvider({ provider, api: "scope-fixture", models: [{ id: "fixture" }] }).getModel();
  const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
  const sessionId = randomUUID();
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    model, scopedModels: [],
    modelRegistry: { getAvailable: () => [model], getRegisteredProviderIds: () => registered ? [provider] : [] },
  } as unknown as ExtensionContext;
  return { pi, ctx };
}

for (const provider of ["external-fixture", "public-fixture"]) test(`Native model scope has no provider-name exclusion: ${provider}`, async () => {
  const { pi, ctx } = fixture(provider, false);
  const plan = await sideExecutionPlan(pi, ctx, "unused-agent");
  assert.deepEqual(plan.modelScope, [`${provider}/fixture`]);
  assert.deepEqual(await plan.factories("side"), []);
});

test("A registered extension provider still requires an approved Side factory", async () => {
  const { pi, ctx } = fixture("extension-fixture", true);
  await assert.rejects(sideExecutionPlan(pi, ctx, "unused-agent"), /The current provider has no approved Side factory/);
});

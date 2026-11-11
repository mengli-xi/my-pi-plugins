import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFastChildFactory } from "../child.ts";

for (const enabled of [true, false]) test(`direct child factory injects only when enabled=${enabled}`, () => {
  let request!: (event: { payload: unknown }, ctx: { model: { provider: string } }) => unknown;
  createFastChildFactory({ context: { enabled } })({ on(event: string, handler: typeof request) {
    assert.equal(event, "before_provider_request"); request = handler;
  } } as unknown as ExtensionAPI);
  const payload = { model: "fixture", input: [] };
  const result = request({ payload }, { model: { provider: "openai-codex" } });
  assert.deepEqual(result, enabled ? { ...payload, service_tier: "priority" } : undefined);
  assert.equal("service_tier" in payload, false, "the child never mutates the original payload");
  assert.equal(request({ payload }, { model: { provider: "other-provider" } }), undefined);
});

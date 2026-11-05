import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_ACTIVITY_CHANNEL, readProviderActivityV1 } from "../src/provider-activity-v1.ts";

const queue = (provider = "example") => ({ version: 1, provider, sessionId: "session", kind: "lifecycle", event: {
  channel: "lifecycle", type: "queue.update", source: "upstream", queuedMs: 100, attempt: 1,
} });

test("provider activity is provider-neutral and uses a distinct versioned channel", () => {
  assert.equal(PROVIDER_ACTIVITY_CHANNEL, "provider:activity-v1");
  for (const provider of ["example", "another-provider"]) assert.equal(readProviderActivityV1(queue(provider))?.provider, provider);
  assert.equal(readProviderActivityV1({ version: 1, provider: "example", sessionId: "session", kind: "turn.end" })?.kind, "turn.end");
});

test("unknown versions, malformed scopes, queues and load do not become observations", () => {
  const valid = queue();
  for (const value of [null, [], { ...valid, version: 2 }, { ...valid, provider: "" }, { ...valid, sessionId: "" },
    { ...valid, kind: "unknown" }, { ...valid, event: { ...valid.event, type: "unknown" } },
    { ...valid, event: { ...valid.event, source: undefined } }, { ...valid, event: { ...valid.event, source: "unknown" } },
    { ...valid, event: { ...valid.event, queuedMs: -1 } }, { ...valid, event: { ...valid.event, attempt: Infinity } },
    { ...valid, event: { ...valid.event, load: { active: 1, queued: 2, backgroundActive: -1 } } },
    { ...valid, event: { ...valid.event, load: { active: 1, queued: 2, backgroundActive: 0, maxActive: 0 } } },
  ]) assert.equal(readProviderActivityV1(value), undefined);
  const value = { ...valid, event: { ...valid.event, load: { active: 1, queued: 2, backgroundActive: 0, maxActive: 4 } } };
  assert.deepEqual(readProviderActivityV1(value)?.event?.load, value.event.load);
});

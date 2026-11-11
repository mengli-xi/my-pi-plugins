import assert from "node:assert/strict";
import test from "node:test";
import piFast from "../index.ts";
import { fastFixture } from "./fixture.ts";

test("real SDK injects main payloads, but not native compaction or direct registry streams", { timeout: 15000 }, async () => {
  const f = fastFixture();
  const runtime = await f.start([piFast]);
  try {
    await runtime.session.prompt("Fast starts off.");
    assert.equal(f.requests.length, 1);
    assert.equal("service_tier" in f.requests[0], false);
    await runtime.session.prompt("/fast on");
    assert.equal(f.requests.length, 1, "commands never issue a provider request");
    await runtime.session.prompt("Provide enough history for manual compaction. ".repeat(100));
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].service_tier, "priority");
    const result = await runtime.session.compact();
    assert.match(result.summary, /LOCAL_FAUX_OK/);
    assert.ok(f.requests.length > 2, "native compaction actually called the provider");
    for (const request of f.requests.slice(2)) assert.equal("service_tier" in request, false, "Pi 1.5 native compaction bypasses Agent onPayload");
    const before = f.requests.length;
    const direct = await runtime.services.modelRuntime.completeSimple(runtime.session.model!, {
      messages: [{ role: "user", content: "Direct extension request", timestamp: Date.now() }],
    });
    assert.equal(direct.stopReason, "stop");
    assert.equal(f.requests.length, before + 1);
    assert.equal("service_tier" in f.requests.at(-1)!, false, "direct registry stream bypasses extension hooks");
    await runtime.session.prompt("/fast off");
    await runtime.session.prompt("Fast is now off.");
    assert.equal("service_tier" in f.requests.at(-1)!, false);
    assert.deepEqual(f.errors, []);
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

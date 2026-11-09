import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { collectMaterials } from "../src/materials.ts";
const ctx: any = { sessionManager: { getSessionId: () => "s" } };
const memoryOwner = (response?: Record<string, unknown>) => {
  const events = createEventBus();
  if (response) events.on("cc-memory:request:materials-v1", (raw: any) => raw.reply(Promise.resolve({ version: 1, sessionId: raw.sessionId, ...response })));
  return { events } as any;
};
test("no memory owner reply reads no storage and records no uncertainty", async () => {
  const result = await collectMaterials(memoryOwner(), ctx, "/not-a-storage-contract", []);
  assert.deepEqual(result.memory, []); assert.deepEqual(result.known, []);
});
test("memory owner unavailability is a material note, not a compression failure", async () => {
  const result = await collectMaterials(memoryOwner({ memory: [], known: [{ kind: "memory-source", statement: "OWNER_REASON" }] }), ctx, "/unused", []);
  assert.deepEqual(result.memory, []); assert.equal(result.known[0]!.statement, "OWNER_REASON");
});
test("consume owner-selected content from any locator without reading its private filesystem", async () => {
  const result = await collectMaterials(memoryOwner({ memory: [{ path: "memory://logical/topic", contents: "OWNER_SELECTED", hash: "not-trusted" }] }), ctx, "/nonexistent", []);
  assert.equal(result.memory[0]!.contents, "OWNER_SELECTED"); assert.match(result.memory[0]!.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual((await collectMaterials(memoryOwner({ sessionId: "other", memory: [{ path: "wrong", contents: "WRONG" }] }), ctx, "/unused", [])).memory, []);
});

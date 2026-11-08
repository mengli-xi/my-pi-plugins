import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MainSessionAppendPortV1, continuationDigest } from "../../src/host/main-append-port.ts";
import { DeliveryPending, type SubagentMailboxTransport } from "../../src/mailbox/transport.ts";
import { nativeMailboxDouble } from "../fixtures/mailbox.ts";
const projection = { content: "done", content_sha256: "b".repeat(64), details_json: '{"completion_id":"cmp"}', details_sha256: "c".repeat(64), result_truncated: false, original_result_bytes: 4, rendered_result_bytes: 4, projection_sha256: "a".repeat(64) };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "subagent-main-mailbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return SessionManager.create(root);
}
test("Main hands unchanged cards and continuation to mailbox with stable keys", async t => {
  const session = await fixture(t), calls: any[] = [];
  const port = new MainSessionAppendPortV1(session, nativeMailboxDouble(session, (message, options) => calls.push({ message, options })));
  await port.appendCompletion({ inboxId: "inb", completionId: "cmp", projection });
  const proof = await port.proveCompletion({ inboxId: "inb", completionId: "cmp", projectionSha256: projection.projection_sha256 });
  assert.ok(session.getEntry(proof.entryId));
  assert.deepEqual(calls[0].message.details, { version: 1, inbox_id: "inb", completion_id: "cmp", projection_sha256: projection.projection_sha256, details_json: projection.details_json });
  assert.equal(calls[0].options.triggerTurn, false);
  const details = { version: 1, outbox_id: "out", wake_epoch: 1, completion_ids: ["cmp"] };
  await port.appendContinuation({ outboxId: "out", wakeEpoch: 1, content: "continue", details });
  assert.equal(calls[1].options.triggerTurn, true);
  assert.equal((await port.proveContinuation({ outboxId: "out", wakeEpoch: 1, continuationSha256: continuationDigest("continue", details) })).wakeEpoch, 1);
});
test("accepted without native proof stays pending without a source native sender", async t => {
  const session = await fixture(t), calls: any[] = [];
  const transport = { async put(input: any) { calls.push(input); return { result: { kind: "accepted" }, entries: [] }; } } as unknown as SubagentMailboxTransport;
  const port = new MainSessionAppendPortV1(session, transport);
  await port.appendCompletion({ inboxId: "inb", completionId: "cmp", projection });
  await assert.rejects(port.proveCompletion({ inboxId: "inb", completionId: "cmp", projectionSha256: projection.projection_sha256 }), DeliveryPending);
  assert.equal(session.getBranch().length, 0);
  assert.deepEqual(await port.appendMailbox({ messageId: "msg", body: "hello", bodySha256: "a".repeat(64), running: false }), { state: "pending" });
  assert.equal(calls[1].key, "mail:msg"); assert.equal(calls[1].wake, false);
});
test("replaying a proven card still obtains durable acceptance and keeps one native entry", async t => {
  const session = await fixture(t), transport = nativeMailboxDouble(session);
  for (let index = 0; index < 2; index++) await new MainSessionAppendPortV1(session, transport).appendCompletion({ inboxId: "inb", completionId: "cmp", projection });
  assert.equal(session.getBranch().filter(entry => entry.type === "custom_message").length, 1);
});
test("native replay with changed frozen card details is a conflict", async t => {
  const session = await fixture(t), transport = nativeMailboxDouble(session);
  const port = new MainSessionAppendPortV1(session, transport);
  await port.appendCompletion({ inboxId: "inb", completionId: "cmp", projection });
  await assert.rejects(port.appendCompletion({ inboxId: "inb", completionId: "cmp", projection: { ...projection, content: "changed" } }), /conflicts/);
});
test("continuation lookup is exact to its original epoch and rejects duplicates", async t => {
  const session = await fixture(t), port = new MainSessionAppendPortV1(session, nativeMailboxDouble(session));
  const details = { version: 1, outbox_id: "out", wake_epoch: 1 };
  await port.appendContinuation({ outboxId: "out", wakeEpoch: 1, content: "continue", details });
  assert.equal(await port.findContinuation({ outboxId: "out", wakeEpoch: 2 }), undefined);
  const first = await port.findContinuation({ outboxId: "out", wakeEpoch: 1 }); assert.ok(first);
  session.appendCustomMessageEntry("subagent-continuation-v1", "continue", false, details);
  await assert.rejects(port.findContinuation({ outboxId: "out", wakeEpoch: 1 }), /duplicate/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { pruneForCheckpointV1, retentionPressureV1, RETAINED_OPERATION_RECEIPTS, RETAINED_SETTLED_MAILBOX } from "../../src/persistence/retention.ts";
import type { NormalizedStoreStateV1 } from "../../src/persistence/types.ts";

const T = "2026-10-17T00:00:00.000Z";
let counter = 0;
const id = (prefix: "rcp" | "evt" | "msg" | "inb" | "cmp" | "out" | "tsk" | "agt" | "txn") => encodeDomainId(prefix, Buffer.from(String(++counter).padStart(16, "0")));
const main = { kind: "main", session_id: "main" };

function fixture() {
  const agent = id("agt"), task = id("tsk"), heldTx = id("txn");
  const receipts = Array.from({ length: 1100 }, (_, index) => ({ receipt_id: id("rcp"), record_revision: index + 1, transaction_id: id("txn"), result_json: JSON.stringify({ index }) }));
  const tied = { receipt_id: id("rcp"), record_revision: 0, transaction_id: id("txn"), result_json: JSON.stringify({ task_id: task }) };
  const prepared = { receipt_id: id("rcp"), record_revision: 0, transaction_id: heldTx, result_json: "{}" };
  const pendingEvent = { event_id: id("evt"), event_sequence: 4, state: "pending", payload_json: "" };
  const mails = Array.from({ length: 300 }, (_, index) => ({ message_id: id("msg"), sequence: index + 1, state: "consumed" }));
  const referencedMail = mails[0]!; pendingEvent.payload_json = JSON.stringify({ items: [{ messageId: referencedMail.message_id }] });
  const retired = { outbox_id: id("out"), completion_ids: [id("cmp")], state: "delivered", wake_state: "settled", settlement_proof_id: id("rcp") };
  const pendingTurn = { outbox_id: id("out"), completion_ids: [id("cmp")], state: "delivered", wake_state: "settled", settlement_proof_id: id("rcp"), turn_settlement: { state: "pending" } };
  const unreadVehicle = { outbox_id: id("out"), completion_ids: [id("cmp")], state: "delivered", wake_state: "settled", settlement_proof_id: id("rcp") };
  const state = {
    root: {
      last_owner_event_acked_sequence: 3,
      operation_receipts: [tied, prepared, ...receipts],
      owner_events: [1, 2, 3].map((sequence) => ({ event_id: id("evt"), event_sequence: sequence, state: sequence === 2 ? "cancelled" : "acked", payload_json: "{}" })).concat([pendingEvent]),
      mailbox: [...mails, { message_id: id("msg"), sequence: 301, state: "pending" }],
      inbox: [
        { inbox_id: id("inb"), completion_id: retired.completion_ids[0], recipient: main, state: "appended", ui_read_at: T },
        { inbox_id: id("inb"), completion_id: pendingTurn.completion_ids[0], recipient: main, state: "appended", ui_read_at: T },
        { inbox_id: id("inb"), completion_id: unreadVehicle.completion_ids[0], recipient: main, state: "appended" },
      ],
      outbox: [], wake_receipts: [], cleanup: [], tombstones: [],
    },
    agents: [{
      agent: { agent_id: agent, last_owner_event_acked_sequence: 0 },
      tasks: [{ task_id: task, phase: "running" }],
      outbox: [retired, pendingTurn, unreadVehicle],
      wake_receipts: [{ receipt_id: id("rcp"), outbox_id: retired.outbox_id }, { receipt_id: retired.settlement_proof_id, outbox_id: retired.outbox_id }],
      inbox: [], mailbox: [], owner_events: [], operation_receipts: [], completions: [],
    }],
  };
  return { state: state as unknown as NormalizedStoreStateV1, heldTx, tied, prepared, receipts, pendingEvent, mails, referencedMail, retired, pendingTurn, unreadVehicle };
}

test("checkpoint retention drops only records whose information is durable elsewhere and no longer needed", () => {
  const f = fixture();
  const { state, removed } = pruneForCheckpointV1(f.state, { preparedTransactionIds: new Set([f.heldTx]) });
  const receipts = state.root.operation_receipts.map((item) => item.receipt_id as string);
  assert.equal(receipts.length, RETAINED_OPERATION_RECEIPTS + 2);
  for (const item of f.receipts.slice(-RETAINED_OPERATION_RECEIPTS)) assert.ok(receipts.includes(item.receipt_id));
  assert.ok(receipts.includes(f.tied.receipt_id), "receipt that mentions an unsettled Task stays");
  assert.ok(receipts.includes(f.prepared.receipt_id), "receipt whose prepared directory still exists stays");
  assert.deepEqual(state.root.owner_events.map((event) => event.event_id), [f.pendingEvent.event_id], "acked/cancelled events at or below the ACK cursor go");
  const mail = state.root.mailbox.map((item) => item.message_id as string);
  assert.equal(mail.length, RETAINED_SETTLED_MAILBOX + 2, "newest settled mail, the one a live event mentions, and the pending one stay");
  assert.ok(mail.includes(f.referencedMail.message_id));
  assert.deepEqual(state.root.inbox.map((item) => item.completion_id), [f.retired.completion_ids[0], f.pendingTurn.completion_ids[0], f.unreadVehicle.completion_ids[0]], "Main cards remain source ACK material even after success and read");
  assert.deepEqual(state.agents[0]!.wake_receipts.map((item) => item.receipt_id), [f.retired.settlement_proof_id], "the delivered Outbox keeps its settlement proof");
  assert.deepEqual(state.agents[0]!.outbox, f.state.agents[0]!.outbox, "Outboxes are never pruned");
  assert.equal(removed, (1100 - RETAINED_OPERATION_RECEIPTS) + 3 + (300 - RETAINED_SETTLED_MAILBOX - 1) + 1);
  assert.equal(pruneForCheckpointV1(state, { preparedTransactionIds: new Set([f.heldTx]) }).removed, 0, "retention is idempotent");
});

test("retention pressure starts above half of a decode bound and is critical within 256 of it", () => {
  const f = fixture();
  assert.equal(retentionPressureV1(f.state), "none");
  const high = structuredClone(f.state); high.root.operation_receipts = Array.from({ length: 2049 }, () => f.receipts[0]!) as never; assert.equal(retentionPressureV1(high), "high");
  const critical = structuredClone(f.state); critical.root.operation_receipts = Array.from({ length: 3840 }, () => f.receipts[0]!) as never; assert.equal(retentionPressureV1(critical), "critical");
});

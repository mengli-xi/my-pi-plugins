import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mainMailboxFixture } from "./mailbox-ack.ts";
import { setTransportCheckpointForTest } from "../../../pi-session-inject/src/mailbox-v1/checkpoint.ts";
import { readDiskSession, terminalIndex } from "../../../pi-session-inject/src/mailbox-v1/proof.ts";

const [directory, point, phase] = process.argv.slice(2) as [string, string, string];
const stop = () => { process.send?.({ checkpoint: point }); process.kill(process.pid, "SIGSTOP"); };
const f = await mainMailboxFixture({ directory, recover: phase === "recover", beforeReady: async binding => {
  if (phase !== "crash") return;
  if (point === "handled") {
    const handle = binding.host.settleOutboxHandled.bind(binding.host);
    binding.host.settleOutboxHandled = async input => { const result = await handle(input); if (result.ok) stop(); return result; };
  }
} });
if (phase === "crash") {
  if (point === "source-ack") {
    await f.success();
    setTransportCheckpointForTest(value => { if (value === "after-recorded-source-ack") stop(); });
    await f.deliverCards();
  } else {
    await f.deliverCards(); f.h.setBusy(true); await f.engine.settleWake(f.current().outbox_id); await f.drain();
    await f.success();
    if (point === "import-terminal") setTransportCheckpointForTest(value => { if (value === "after-terminal") stop(); });
    if (point === "cancel-terminal") {
      const cancel = f.transport.endpoint.cancel.bind(f.transport.endpoint);
      f.transport.endpoint.cancel = async (...args) => { const result = await cancel(...args); stop(); return result; };
    }
    await f.handle();
  }
  throw new Error(`crash point not reached: ${point}`);
}
await f.drain();
assert.equal(f.current().state, "handled");
assert.equal(f.current().wake_epoch, point === "source-ack" ? 0 : 1);
assert.equal(f.h.sends.length, 0, "recovery must neither append native bodies nor request a model");
assert.equal(f.slot().snapshot.pending.length, 0); assert.equal(f.slot().snapshot.terminal.length, 0);
const index = terminalIndex(await readDiskSession(f.slot().session), f.binding.mainSessionId);
const terminals = [...index.values()].map(item => ({ key: item.mail.key, terminalId: item.evidence.terminalId, outcome: item.evidence.outcome }));
const result = { epoch: f.current().wake_epoch, outboxId: f.current().outbox_id, sends: f.h.sends.length, offers: f.counts.offers,
  recordedTokens: f.counts.recorded, terminals, sourceTransactions: f.counts.transactions,
  nativeContinuations: f.h.manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1").length };
assert.equal(result.nativeContinuations, 0);
await f.close(); process.send?.({ recovered: result });

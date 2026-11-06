import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { setTransportCheckpointForTest } from "../src/mailbox-v1/checkpoint.js";
import { MAILBOX_HOLDER_KEY, type Mail } from "../src/mailbox-v1/index.js";
import { harness, until, tick } from "./mailbox-harness.js";
import { fulfilledFinalAckLostFixture } from "./fixtures/fulfilled-final-ack-lost.js";

const [directory, mode, wanted, phase] = process.argv.slice(2) as [string, string, string, string];
const metaPath = join(directory, "meta.json"), notices = join(directory, "notices.jsonl");
let h: Awaited<ReturnType<typeof harness>>, mail: Mail;
if (phase === "crash" && mode.startsWith("import")) {
  h = await harness({ directory });
  const file = h.manager.getSessionFile()!, fixture = fulfilledFinalAckLostFixture(file, h.cwd);
  writeFileSync(file, fixture.sessionEntries.slice(0, -1).map(entry => JSON.stringify(entry)).join("\n") + "\n");
  h = await harness({ directory, manager: SessionManager.open(file) }); mail = fixture.mail;
} else if (phase === "crash") {
  h = await harness({ directory }); await h.finish();
  mail = h.mail("pi-scheduler", "transport-crash", { messages: [0, 1].map(index => ({ customType: "crash-body", content: `BODY_${index}`, display: false, details: { index } })) });
} else {
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  h = await harness({ directory, manager: SessionManager.open(meta.file) }); mail = meta.mail;
}
const slot = () => [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
let ready = existsSync(notices) && readFileSync(notices, "utf8").includes('"kind":"recorded"');
const p = h.producer("pi-scheduler", {
  checkCurrent: () => mode.startsWith("import") ? { kind: "hold", reason: "legacy must never wake" } : { kind: "allow", project: true, wake: mode !== "cancel" && ready },
  onRecorded: notice => { appendFileSync(notices, JSON.stringify({ kind: "recorded", token: notice.recordedToken }) + "\n"); ready = true; },
  onTerminal: evidence => { appendFileSync(notices, JSON.stringify({ kind: "terminal", token: evidence.terminalId }) + "\n"); },
});
if (phase === "crash") {
  writeFileSync(metaPath, JSON.stringify({ sessionId: h.manager.getSessionId(), file: h.manager.getSessionFile(), mail }));
  const counts = new Map<string, number>();
  setTransportCheckpointForTest(point => {
    const count = (counts.get(point) ?? 0) + 1; counts.set(point, count);
    if (wanted !== point && wanted !== `${point}:${count}`) return;
    process.send?.({ checkpoint: wanted }); process.kill(process.pid, "SIGSTOP");
  });
}
await h.emit("session_start", { reason: "startup" });
if (phase === "crash" && mode.startsWith("import")) {
  if (mode === "import-pending") await p.endpoint.put(mail);
  await p.endpoint.importFulfilled(mail, { sourceReceiptEntryId: "native-injection-fixture", assistantEntryId: "assistant-fixture" });
} else if (phase === "crash") {
  await p.endpoint.put(mail);
  if (mode === "cancel") { await until(() => slot().snapshot.pending[0]?.nativeEntries.length === 2); await p.endpoint.cancel(mail.key, "cancel before cleanup crash"); }
}
else {
  await tick(); await tick(); assert.equal(h.sends.length, 0, "cold recovery itself never submits");
  if (!mode.startsWith("import") && slot().snapshot.pending.length) await h.commands.get("mailbox")!.definition.handler("resume", h.ctx as any);
}
let requests = 0;
if (!mode.startsWith("import") && slot().snapshot.pending.length) {
  await until(() => h.sends.some(send => send.options.triggerTurn));
  const control = h.sends.find(send => send.options.triggerTurn)!.message;
  h.setBusy(true); await h.emit("before_agent_start", { messageType: "custom", message: control, systemPrompt: "", systemPromptOptions: {} });
  await h.context(); requests++; await h.finish();
}
await until(() => slot().snapshot.pending.length === 0 && slot().snapshot.terminal.length === 0, "transport ACK and GC");
if (phase === "crash") throw new Error(`checkpoint was not reached: ${wanted}`);
const entries = h.manager.getBranch(), rows = readFileSync(notices, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const result = { requests, sends: h.sends.length, bodies: entries.filter(entry => entry.type === "custom_message" && entry.customType === (mode.startsWith("import") ? "scheduler-injection-v1" : "crash-body")).length,
  receipts: entries.filter(entry => entry.type === "custom" && entry.customType === "agent-mailbox-delivery-v1").length,
  recordedTokens: [...new Set(rows.filter(row => row.kind === "recorded").map(row => row.token))], terminalTokens: [...new Set(rows.filter(row => row.kind === "terminal").map(row => row.token))] };
assert.equal(result.bodies, mode.startsWith("import") ? 1 : 2); assert.equal(result.receipts, 1);
assert.equal(result.recordedTokens.length, 1); assert.equal(result.terminalTokens.length, 1);
const repeated = await p.endpoint.put(mail);
assert.equal(repeated.kind, "terminal");
if (repeated.kind === "terminal") assert.equal(repeated.evidence.terminalId, result.terminalTokens[0]);
await h.commands.get("mailbox")!.definition.handler("status", h.ctx as any);
assert.ok(h.notices.at(-1)?.includes("0 pending"));
if (wanted.includes("snapshot-")) {
  assert.equal(existsSync(join(h.agentDir, "mailbox/v1", h.manager.getSessionId())), false, "cleanup-boundary recovery leaves no empty directory");
} else if (!slot().snapshot.attempt && !slot().snapshot.suspended) {
  assert.equal(existsSync(join(h.agentDir, "mailbox/v1", h.manager.getSessionId(), "pending.json")), false, "no snapshot is needed without obligations");
}
if (mode.startsWith("import")) { assert.equal(result.sends, 0); assert.equal(result.requests, 0); }
await h.cleanup(); process.send?.({ recovered: result });

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { freshHost, delay } from "../fixtures/fresh-host.ts";
const goal = resolve(import.meta.dirname, "../../../fork/pi-goal/dist/index.js");
for (const order of ["default", "reverse"] as const) test(`stock B child / C Goal / D completion has four Root requests (${order})`, { timeout: 45_000 }, async t => {
  const prior = process.env.PI_MAILBOX_JOINT; process.env.PI_MAILBOX_JOINT = "1";
  t.after(() => { if (prior === undefined) delete process.env.PI_MAILBOX_JOINT; else process.env.PI_MAILBOX_JOINT = prior; });
  const h = await freshHost(t, "unused", false, 1, [goal], order);
  await h.rpc("prompt", { message: "FOREGROUND_CHECK" });
  await h.until(() => h.rpc("get_state"), state => state.isStreaming === false && h.records.some(event => event.type === "agent_end"), "seed run settled", 5_000);
  await h.rpc("prompt", { message: "/goal JOINT_TRIPLE: spawn a PROCESS_PARENT child, read its Process result and complete." });
  await h.until(async () => (await h.rpc("get_entries")).entries as any[],
    entries => entries.filter(entry => entry.type === "custom" && entry.customType === "goal-state").some(entry => entry.data?.goal?.status === "complete"), "Goal completed", 25_000);
  await h.until(() => h.rpc("get_state"), state => state.isStreaming === false, "Root settled", 5_000);
  await delay(500); // The regression submitted an empty control immediately after success.
  const entries: any[] = (await h.rpc("get_entries")).entries, snapshot = await h.snapshot();
  const calls = (await readFile(join(h.root, "provider.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const main = calls.filter(call => call.sessionId === h.sessionId).length;
  const naming = calls.filter(call => call.sessionId === h.sessionId && call.messages.some((message: any) =>
    message.role === "system" && typeof message.content === "string" && message.content.includes("Name the task, not the tool."))).length;
  const partition = snapshot.snapshot.agents[0];
  const childEntries = (await readFile(join(snapshot.mainRoot, partition.agent.conversation.relative_path), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const summary = { order, mainProviderRequests: main, namingProviderRequests: naming, scenarioMainProviderRequests: main - naming, childProviderRequests: calls.length - main,
    childBatches: childEntries.filter(entry => entry.type === "custom_message" && entry.customType === "process-notification-batch-v1").length,
    cards: entries.filter(entry => entry.type === "custom_message" && entry.customType === "subagent-completion-v1").length,
    fallback: entries.filter(entry => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1").length,
    controls: entries.filter(entry => entry.type === "custom_message" && entry.customType === "agent-mailbox-trigger-v1").length,
    outbox: partition.outbox.map((item: any) => ({ state: item.state, settlementKind: item.settlement_kind, turn: item.turn_settlement?.state })) };
  if (process.env.PI_MAILBOX_JOINT_EVIDENCE) {
    const directory = join(process.env.PI_MAILBOX_JOINT_EVIDENCE, `triple-${order}`); await mkdir(directory, { recursive: true });
    await Promise.all([writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2)),
      writeFile(join(directory, "rpc.jsonl"), h.records.map(event => JSON.stringify(event)).join("\n") + "\n"),
      writeFile(join(directory, "entries.json"), JSON.stringify(entries)), writeFile(join(directory, "snapshot.json"), JSON.stringify(snapshot))]);
  }
  t.diagnostic(JSON.stringify(summary));
  assert.equal(naming, process.env.PI_MAILBOX_FULL_PROFILE === "1" ? 1 : 0, "full profile names the seeded session once");
  assert.equal(main - naming, 4); assert.equal(summary.childProviderRequests, 4); assert.equal(summary.childBatches, 1);
  assert.equal(summary.cards, 1); assert.equal(summary.fallback, 0); assert.equal(summary.controls, 1);
  assert.deepEqual(summary.outbox, [{ state: "delivered", settlementKind: "goal-claimed", turn: "settled" }]);
  await h.stop();
});

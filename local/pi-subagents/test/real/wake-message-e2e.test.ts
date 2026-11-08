import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { freshHost } from "../fixtures/fresh-host.js";

test("stock host wakes a barrier with a model-visible custom message and no synthetic user input", { timeout: 60_000 }, async t => {
  const host = await freshHost(t, "NEST_PARENT", false, 2);
  await host.rpc("prompt", { message: "/subagents-test-spawn" });
  const state = await host.settled(2);
  const parent = state.snapshot.agents.find((item: any) => item.agent.depth === 1);
  const entries = (await readFile(join(state.mainRoot, parent.agent.conversation.relative_path), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const wakeIndex = entries.findIndex((entry: any) => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1");
  assert.ok(wakeIndex >= 0, JSON.stringify(entries));
  assert.equal(entries[wakeIndex].display, false);
  assert.match(entries[wakeIndex].content, /Continue from the delivered completion cards/);
  assert.equal(entries.filter((entry: any) => entry.customType === "subagent-task-resume").length, 0);
  assert.equal(entries.filter((entry: any) => entry.customType === "agent-mailbox-trigger-v1").length, 1);
  assert.doesNotMatch(entries[wakeIndex].content, /accepted input/);
  assert.ok(entries.slice(wakeIndex + 1).some((entry: any) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("PARENT_DONE")));
  assert.deepEqual(entries.filter((entry: any) => entry.message?.role === "user").map((entry: any) => entry.message.content), [[{ type: "text", text: "NEST_PARENT" }]]);
  const calls = (await readFile(join(host.root, "provider.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(calls.some((call: any) => JSON.stringify(call.messages).includes("Continue from the delivered completion cards")), "custom wake must reach the provider context");
  await host.stop();
});

test("stock host process start arms waiting explicitly and process exit resumes without a user message", { timeout: 60_000 }, async t => {
  const host = await freshHost(t, "PROCESS_PARENT");
  await host.rpc("prompt", { message: "/subagents-test-spawn" });
  const state = await host.settled();
  const parent = state.snapshot.agents[0];
  const entries = (await readFile(join(state.mainRoot, parent.agent.conversation.relative_path), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const started = entries.find((entry: any) => entry.message?.role === "toolResult" && entry.message.toolName === "process");
  assert.match(JSON.stringify(started.message.content), /Waiting is armed\. End this turn now; you will be woken when the process exits/);
  assert.ok(entries.some((entry: any) => entry.type === "custom_message" && JSON.stringify(entry.content).includes("succeeded")));
  assert.ok(entries.some((entry: any) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("PROCESS_PARENT_DONE")));
  assert.equal(entries.filter((entry: any) => entry.message?.role === "user").length, 1);
  await host.stop();
});

import assert from "node:assert/strict";
import test from "node:test";
import { freshHost } from "../fixtures/fresh-host.ts";

test("deleting a completed idle Agent closes its real SDK resident before removing metadata", { timeout: 120_000 }, async t => {
  const host = await freshHost(t);
  await host.rpc("prompt", { message: "/subagents-test-spawn" });
  const state = await host.settled();
  const item = state.snapshot.agents[0];
  assert.equal(item.agent.lifecycle, "open");
  assert.ok(state.residents[0]?.nativeSessionId);
  const completionId = item.completions[0].completion_id;
  await host.until(host.snapshot, current => current.snapshot.root.inbox.some((inbox: any) => inbox.completion_id === completionId && inbox.state === "appended")
    && current.snapshot.agents.find((row: any) => row.agent.agent_id === item.agent.agent_id).outbox.every((outbox: any) => outbox.state === "delivered"), "completion handoff terminal before delete confirmation");
  await host.until(() => host.control("retirement"), facts => facts.length > 0 && facts.every((fact: any) => fact.kind === "retired"), "completion handoff/ACK/GC retired before deletion");
  let result: any, sawResident = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    result = await host.control("delete", undefined, item.agent.task_name);
    sawResident ||= !!result.before;
    if (result.message === "Deleted Subagent subtree.") break;
    // A concurrent delivery invalidates consent; simulate reviewing and
    // confirming again, never bypass the production revision/unread fences.
    assert.ok(["Failed: stale-revision", "Subagent has new unread completions; review and confirm deletion again."].includes(result.message), result.message);
    assert.equal(result.exists, true);
  }
  assert.equal(sawResident, true);
  assert.equal(result.message, "Deleted Subagent subtree.");
  assert.equal(result.after, null);
  assert.equal(result.exists, false);
  assert.deepEqual((await host.snapshot()).snapshot.agents, []);
  await host.stop();
});

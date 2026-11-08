import assert from "node:assert/strict";
import test from "node:test";
import { persistentAgentDepth, resolveTaskTimeoutMs, TASK_TIMEOUT_MIN_MS, TASK_TIMEOUT_MAX_MS } from "../../src/domain/task-policy.js";
import { validateSpawnAgentInput } from "../../src/tools/validate.js";
import { SPAWN_AGENT_SCHEMA } from "../../src/tools/schemas.js";
test("spawn timeout grammar shares exact bounds and precedence with frozen policy", () => {
  const base = { task_name: "task", message: "work" };
  for (const value of [TASK_TIMEOUT_MIN_MS, TASK_TIMEOUT_MAX_MS]) assert.equal(validateSpawnAgentInput({ ...base, task_timeout_ms: value }).task_timeout_ms, value);
  for (const value of [59_999, 86_400_001, 60_000.5, "60000", null, Infinity]) assert.throws(() => validateSpawnAgentInput({ ...base, task_timeout_ms: value }), /task_timeout_ms/);
  assert.equal(JSON.parse(JSON.stringify(SPAWN_AGENT_SCHEMA)).properties.task_timeout_ms.minimum, TASK_TIMEOUT_MIN_MS);
  assert.equal(JSON.parse(JSON.stringify(SPAWN_AGENT_SCHEMA)).properties.task_timeout_ms.maximum, TASK_TIMEOUT_MAX_MS);
  assert.equal(resolveTaskTimeoutMs(60_001, 60_002, 60_003), 60_001);
  assert.equal(resolveTaskTimeoutMs(undefined, 60_002, 60_003), 60_002);
  assert.equal(resolveTaskTimeoutMs(undefined, undefined, 60_003), 60_003);
  assert.equal(resolveTaskTimeoutMs(), 1_800_000);
});
test("depth follows the persistent parent chain and rejects missing/cyclic parents", () => {
  const agents = [{ agent_id: "a" }, { agent_id: "b", parent_agent_id: "a" }];
  assert.equal(persistentAgentDepth(agents, "a"), 1); assert.equal(persistentAgentDepth(agents, "b"), 2);
  assert.throws(() => persistentAgentDepth([...agents, { agent_id: "c", parent_agent_id: "b" }], "c"), /depth-limit/);
  assert.throws(() => persistentAgentDepth([{ agent_id: "a", parent_agent_id: "a" }], "a"), /cyclic/);
  assert.throws(() => persistentAgentDepth([{ agent_id: "b", parent_agent_id: "missing" }], "b"), /missing/);
});

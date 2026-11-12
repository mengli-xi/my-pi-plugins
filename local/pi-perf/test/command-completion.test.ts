import assert from "node:assert/strict";
import test from "node:test";
import { perfArgumentCompletions } from "../index.ts";

test("perf completes every public action", () => {
  assert.deepEqual(perfArgumentCompletions("")?.map(({ value }) => value), [
    "on", "off", "reset", "log", "memory", "top", "export", "open", "7d", "30d",
  ]);
  assert.deepEqual(perfArgumentCompletions("o")?.map(({ value }) => value), ["on", "off", "open"]);
  assert.equal(perfArgumentCompletions("memory"), null);
  assert.equal(perfArgumentCompletions("unknown"), null);
});

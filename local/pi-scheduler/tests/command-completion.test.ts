import assert from "node:assert/strict";
import test from "node:test";
import { scheduleArgumentCompletions } from "../src/command-completion.ts";

test("schedule completes public subcommands and the cancel scaffold", () => {
  assert.deepEqual(scheduleArgumentCompletions("")?.map(({ value }) => value), [
    "list", "install", "failures", "cancel ",
  ]);
  assert.deepEqual(scheduleArgumentCompletions("c")?.map(({ value }) => value), ["cancel "]);
  assert.equal(scheduleArgumentCompletions("list"), null);
  assert.equal(scheduleArgumentCompletions("unknown"), null);
});

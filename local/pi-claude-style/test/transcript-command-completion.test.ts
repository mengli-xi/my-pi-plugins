import assert from "node:assert/strict";
import test from "node:test";
import { toolTranscriptArgumentCompletions } from "../src/features/transcript/commands.ts";

test("tool-transcript completes its legacy public subcommands", () => {
  assert.deepEqual(toolTranscriptArgumentCompletions("")?.map(({ value }) => value), ["show", "config"]);
  assert.deepEqual(toolTranscriptArgumentCompletions(" C")?.map(({ value }) => value), ["config"]);
  assert.equal(toolTranscriptArgumentCompletions("show"), null);
  assert.equal(toolTranscriptArgumentCompletions("unknown"), null);
});

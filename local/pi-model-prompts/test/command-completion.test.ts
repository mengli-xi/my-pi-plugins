import assert from "node:assert/strict";
import test from "node:test";
import { modelPromptArgumentCompletions } from "../index.ts";

test("model-prompt completes its settings subcommand", () => {
  assert.deepEqual(modelPromptArgumentCompletions("")?.map(({ value }) => value), ["settings"]);
  assert.deepEqual(modelPromptArgumentCompletions(" S")?.map(({ value }) => value), ["settings"]);
  assert.equal(modelPromptArgumentCompletions("settings"), null);
  assert.equal(modelPromptArgumentCompletions("report"), null);
});

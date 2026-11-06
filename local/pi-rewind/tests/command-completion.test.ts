import assert from "node:assert/strict";
import test from "node:test";
import { rewindArgumentCompletions } from "../index.ts";

test("rewind completions expose only public subcommands", () => {
	const items = rewindArgumentCompletions("");
	assert.deepEqual(items?.map(({ value }) => value), ["undo", "history"]);
	assert.ok(items?.every(({ description }) => description.length > 0));
	assert.ok(items?.every(({ value }) => value !== "--pending-connection"));
});

test("rewind completions filter prefixes and stop after a complete command", () => {
	assert.deepEqual(rewindArgumentCompletions("u")?.map(({ value }) => value), ["undo"]);
	assert.deepEqual(rewindArgumentCompletions("  H")?.map(({ value }) => value), ["history"]);
	assert.equal(rewindArgumentCompletions("undo"), null);
	assert.equal(rewindArgumentCompletions("unknown"), null);
});

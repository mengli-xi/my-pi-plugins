import assert from "node:assert/strict";
import test from "node:test";
import { PendingConnectionRewindState } from "../pending-connection.ts";

test("only a fresh interactive prompt is rewindable before the answer arrives", () => {
	const state = new PendingConnectionRewindState();
	state.captureInput("edit me", "previous", true, 1_000);
	state.stageAgent(1_100);
	state.startAgent();
	assert.equal(state.request(), true);
	assert.deepEqual(state.takeRequested(), {
		editorText: "edit me",
		baseLeafId: "previous",
		hasImages: true,
	});
	assert.equal(state.request(), false);
});

test("the answer's first content and continuation runs disable direct rewind", () => {
	const answered = new PendingConnectionRewindState();
	answered.captureInput("sent", null, false, 1_000);
	answered.stageAgent(1_100);
	answered.startAgent();
	answered.markContentStarted();
	assert.equal(answered.request(), false);

	const continuation = new PendingConnectionRewindState();
	continuation.startAgent();
	assert.equal(continuation.request(), false);
});

test("an outgoing provider request alone still leaves the prompt rewindable", () => {
	// before_provider_request fires milliseconds after agent_start; closing the
	// window there is what made one Escape fall back to Pi's plain abort.
	const state = new PendingConnectionRewindState();
	state.captureInput("waiting on the model", "previous", false, 1_000);
	state.stageAgent(1_100);
	state.startAgent();
	assert.equal(state.request(), true, "no answer content has arrived yet");
	assert.deepEqual(state.takeRequested(), {
		editorText: "waiting on the model",
		baseLeafId: "previous",
		hasImages: false,
	});
});

test("stale captured input cannot arm an unrelated later run", () => {
	const state = new PendingConnectionRewindState();
	state.captureInput("failed auth", "old", false, 1_000);
	state.stageAgent(1_000 + 10 * 60_000 + 1);
	state.startAgent();
	assert.equal(state.request(), false);
});

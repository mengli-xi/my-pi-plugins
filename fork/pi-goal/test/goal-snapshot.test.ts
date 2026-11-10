import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildGoalSnapshotPayload,
	GOAL_SNAPSHOT_REQUEST_CHANNEL,
	installGoalSnapshotProtocol,
} from "../src/goal-snapshot.js";
import type { ActiveGoal } from "../src/persistence.js";

const NOW = 1_000_000;

function activeGoal(overrides: Partial<ActiveGoal> = {}): ActiveGoal {
	return {
		id: "goal-1",
		text: "ship semantic snapshots",
		status: "active",
		startedAt: NOW - 20_000,
		updatedAt: NOW,
		iteration: 1,
		tokensUsed: 100,
		timeUsedSeconds: 10,
		baselineTokens: 1_000,
		activeStartedAt: NOW - 5_000,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
		...overrides,
	};
}

test("owner derives a semantic snapshot without exposing persistence internals", () => {
	const ctx = {
		cwd: "/tmp/project",
		ui: {
			confirm: async () => true,
			notify: () => {},
			setStatus: () => {},
		},
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [
				{
					type: "message",
					message: { role: "assistant", usage: { totalTokens: 1_450 } },
				},
			],
		},
	};
	const snapshot = buildGoalSnapshotPayload(activeGoal(), 2, false, ctx, NOW);
	assert.deepEqual(snapshot, {
		version: 1,
		sessionId: "session-1",
		goal: {
			id: "goal-1",
			text: "ship semantic snapshots",
			phase: "active",
			clockRunning: true,
			queueFrozen: false,
			runtimeSeconds: 15,
			tokensUsed: 450,
			queued: 2,
			observedAt: NOW,
		},
	});
	assert.equal(Object.hasOwn(snapshot.goal ?? {}, "baselineTokens"), false);
	assert.equal(Object.hasOwn(snapshot.goal ?? {}, "activeStartedAt"), false);
});

test("owner reports the accounting clock, not just an active phase", () => {
	for (const goal of [
		activeGoal({ activeStartedAt: undefined }),
		activeGoal({ activeStartedAt: Number.NaN }),
		activeGoal({ status: "paused" }),
	]) {
		const first = buildGoalSnapshotPayload(goal, 1, false, undefined, NOW).goal;
		const later = buildGoalSnapshotPayload(goal, 1, false, undefined, NOW + 60_000).goal;
		assert.equal(first?.queueFrozen, false);
		assert.equal(first?.clockRunning, false);
		assert.equal(later?.clockRunning, false);
		assert.equal(first?.runtimeSeconds, 10);
		assert.equal(later?.runtimeSeconds, 10);
	}
	const frozenPaused = buildGoalSnapshotPayload(
		activeGoal({ status: "paused" }),
		1,
		true,
		undefined,
		NOW,
	).goal;
	assert.equal(frozenPaused?.queueFrozen, true);
	assert.equal(frozenPaused?.clockRunning, false);
	assert.equal(frozenPaused?.phase, "paused");
});

test("request/reply is synchronous and session scoped", () => {
	const handlers = new Map<string, (payload: unknown) => void>();
	const pi = {
		events: {
			on(channel: string, handler: (payload: unknown) => void) {
				handlers.set(channel, handler);
				return () => handlers.delete(channel);
			},
		},
	} as unknown as ExtensionAPI;
	const payload = { version: 1 as const, sessionId: "session-1", goal: null };
	const stop = installGoalSnapshotProtocol(pi, () => payload);

	let reply: unknown;
	handlers.get(GOAL_SNAPSHOT_REQUEST_CHANNEL)?.({
		sessionId: "session-1",
		reply: (value: unknown) => {
			reply = value;
		},
	});
	assert.equal(reply, payload);

	reply = undefined;
	handlers.get(GOAL_SNAPSHOT_REQUEST_CHANNEL)?.({
		sessionId: "other",
		reply: (value: unknown) => {
			reply = value;
		},
	});
	assert.equal(reply, undefined);
	stop();
	assert.equal(handlers.has(GOAL_SNAPSHOT_REQUEST_CHANNEL), false);
});

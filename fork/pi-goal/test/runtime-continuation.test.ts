import assert from "node:assert/strict";
import test from "node:test";
import {
	type BlockingLeaseHandleV1,
	getContinuationRegistryV1,
	type Result,
	type WakeProducerTransactionV1,
} from "pi-runtime-contracts/continuation-v1";
import { BackgroundContinuationBridge } from "../src/runtime-continuation.js";

const subagentProofSymbol = Symbol.for("pi.subagents.producer-continuation-proof.v1");
if (!Object.getOwnPropertyDescriptor(globalThis, subagentProofSymbol)) {
	Object.defineProperty(globalThis, subagentProofSymbol, {
		value: Object.freeze({
			version: 1,
			brand: "pi-subagents-producer-continuation-proof-v1",
			get: () => undefined,
		}),
		configurable: true,
	});
}

function resultValue<T>(result: Result<T>): T {
	if (!result.ok) assert.fail(result.message);
	return result.value;
}

function acquire(
	sessionId: string,
	logicalKey: string,
	reason: string,
	ownerId = "pi-processes",
): BlockingLeaseHandleV1 {
	return resultValue(
		getContinuationRegistryV1().acquireBlocking({
			sessionId,
			ownerId,
			logicalKey,
			reason,
		}),
	);
}

function releaseWithWake(handle: BlockingLeaseHandleV1, reason: string): WakeProducerTransactionV1 {
	return resultValue(handle.releaseAndOfferWake({ outcome: "ready", reason }));
}

test("each supported completion independently schedules and returns a consumer receipt", () => {
	const sessionId = `goal-wake-${crypto.randomUUID()}`;
	const scheduled: string[] = [];
	const bridge = new BackgroundContinuationBridge();
	bridge.bindWakeConsumer({
		sessionId,
		consumerId: "pi-goal-local",
		getActiveGoal: () => ({ id: "goal-1" }),
		scheduleContinuation: (_goalId, offer) => {
			scheduled.push(offer.offerId);
			return { continuationId: `continuation-${scheduled.length}`, scheduling: "scheduled" };
		},
	});

	const first = acquire(sessionId, "first", "first", "pi-processes");
	const second = acquire(sessionId, "second", "second", "pi-subagents");

	const firstWake = releaseWithWake(first, "first complete");
	assert.equal(firstWake.snapshot().remainingBlocking, 1);
	assert.equal(firstWake.hasClaim(), true);
	const firstSettlement = resultValue(firstWake.commit("delivered"));
	assert.equal(firstSettlement.consumerReceipt?.continuationId, "continuation-1");
	assert.equal(scheduled.length, 1);

	const finalWake = releaseWithWake(second, "second complete");
	assert.equal(finalWake.snapshot().remainingBlocking, 0);
	assert.equal(finalWake.hasClaim(), true);
	const finalSettlement = resultValue(finalWake.commit("delivered"));
	assert.equal(finalSettlement.consumerReceipt?.continuationId, "continuation-2");
	assert.equal(scheduled.length, 2);

	assert.equal(finalWake.commit("delivered").ok, false);
	assert.equal(scheduled.length, 2);
	bridge.clear();
});

test("bridge observes leases admitted before the active goal and throttles check-ins locally", () => {
	const sessionId = `goal-checkin-${crypto.randomUUID()}`;
	const bridge = new BackgroundContinuationBridge();
	const first = acquire(sessionId, "first", "first", "pi-subagents");
	const second = acquire(sessionId, "second", "second");
	const selected = bridge.activeLease(sessionId);
	assert.ok(selected);
	assert.ok([first.snapshot().leaseId, second.snapshot().leaseId].includes(selected.leaseId));
	assert.equal(bridge.checkInBase(selected), selected.lastCheckInAt);
	bridge.markCheckIn(selected.leaseId, 1_234);
	assert.equal(bridge.checkInBase(selected), 1_234);

	resultValue(first.releaseWithoutWake({ outcome: "cancelled", reason: "test cleanup" }));
	resultValue(second.releaseWithoutWake({ outcome: "cancelled", reason: "test cleanup" }));
	bridge.clear();
});

test("an offer already answered by a restored continuation cannot schedule a second turn", () => {
	const sessionId = `goal-restored-${crypto.randomUUID()}`;
	const scheduled: string[] = [];
	const bridge = new BackgroundContinuationBridge();
	bridge.bindWakeConsumer({
		sessionId,
		consumerId: "pi-goal-local",
		getActiveGoal: () => ({ id: "goal-1" }),
		scheduleContinuation: (_goalId, offer) => {
			scheduled.push(offer.offerId);
			return { continuationId: "continuation-restored", scheduling: "scheduled" };
		},
	});

	const lease = acquire(sessionId, "restored", "restored");
	const wake = releaseWithWake(lease, "finished before the reload");
	assert.equal(wake.hasClaim(), true);
	// The reloaded runtime already re-armed this offer's continuation from persisted state.
	bridge.markOfferHandled(wake.snapshot().offerId);
	assert.equal(resultValue(wake.commit("delivered")).consumerReceipt, undefined);
	assert.deepEqual(scheduled, []);
	bridge.clear();
});

test("unsupported producer remains unclaimed for producer fallback", () => {
	const sessionId = `goal-unsupported-${crypto.randomUUID()}`;
	const bridge = new BackgroundContinuationBridge();
	bridge.bindWakeConsumer({
		sessionId,
		consumerId: "pi-goal-local",
		getActiveGoal: () => ({ id: "goal-1" }),
		scheduleContinuation: () => ({ continuationId: "unexpected", scheduling: "scheduled" }),
	});
	const lease = acquire(sessionId, "unknown", "unknown", "another-producer");
	const wake = releaseWithWake(lease, "done");
	assert.equal(wake.hasClaim(), false);
	resultValue(wake.abort("test cleanup"));
	bridge.clear();
});

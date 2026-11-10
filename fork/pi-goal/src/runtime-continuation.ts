import {
	type BlockingLeaseSnapshotV1,
	type DisposableV1,
	getContinuationRegistryV1,
	type WakeConsumerReceiptV1,
	type WakeOfferSnapshotV1,
	type WakeSettlementV1,
} from "pi-runtime-contracts/continuation-v1";

export const PROCESSES_CONTINUATION_OWNER = "pi-processes";
export const SUBAGENTS_CONTINUATION_OWNER = "pi-subagents";
const SUBAGENT_PROOF_SYMBOL = Symbol.for("pi.subagents.producer-continuation-proof.v1");

interface ProducerProofRegistryV1 {
	readonly version: 1;
	readonly brand: "pi-subagents-producer-continuation-proof-v1";
	get(key: { session_id: string; offer_id: string; offer_generation: number }): unknown;
}

export interface ActiveGoalIdentity {
	readonly id: string;
}

export interface GoalContinuationReceipt {
	readonly continuationId: string;
	readonly scheduling: "scheduled" | "coalesced";
}

export interface BackgroundWakeConsumerOptions {
	readonly sessionId: string;
	readonly consumerId: string;
	readonly getActiveGoal: () => ActiveGoalIdentity | undefined;
	readonly scheduleContinuation: (
		goalId: string,
		offer: WakeOfferSnapshotV1,
	) => GoalContinuationReceipt | undefined;
	readonly diagnostic?: (message: string) => void;
}

function producerProofRegistry(): ProducerProofRegistryV1 | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, SUBAGENT_PROOF_SYMBOL);
	const value = descriptor?.value;
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<ProducerProofRegistryV1>;
	if (
		candidate.version !== 1 ||
		candidate.brand !== "pi-subagents-producer-continuation-proof-v1" ||
		typeof candidate.get !== "function"
	) {
		return undefined;
	}
	return candidate as ProducerProofRegistryV1;
}

function supportsOffer(offer: WakeOfferSnapshotV1): boolean {
	if (offer.ownerId === PROCESSES_CONTINUATION_OWNER) return true;
	return offer.ownerId === SUBAGENTS_CONTINUATION_OWNER && producerProofRegistry() !== undefined;
}

function producerAlreadyOwns(offer: WakeOfferSnapshotV1): boolean {
	if (offer.ownerId !== SUBAGENTS_CONTINUATION_OWNER) return false;
	return (
		producerProofRegistry()?.get({
			session_id: offer.sessionId,
			offer_id: offer.offerId,
			offer_generation: offer.offerGeneration,
		}) !== undefined
	);
}

export class BackgroundContinuationBridge {
	readonly #checkIns = new Map<string, number>();
	#wakeConsumer?: DisposableV1;
	readonly #handledOffers = new Set<string>();

	activeLease(sessionId: string | undefined) {
		if (!sessionId) return undefined;
		return getContinuationRegistryV1().snapshot(sessionId).blocking[0];
	}

	checkInBase(lease: BlockingLeaseSnapshotV1) {
		return this.#checkIns.get(lease.leaseId) ?? lease.lastCheckInAt ?? lease.acquiredAt;
	}

	markCheckIn(leaseId: string, checkedInAt = Date.now()) {
		this.#checkIns.set(leaseId, checkedInAt);
	}

	bindWakeConsumer(options: BackgroundWakeConsumerOptions) {
		this.unbindWakeConsumer();
		const registered = getContinuationRegistryV1().registerWakeConsumer({
			sessionId: options.sessionId,
			consumerId: options.consumerId,
			onOffer: (offer, claim) => {
				const goal = options.getActiveGoal();
				if (!goal || !supportsOffer(offer)) return;
				const claimed = claim();
				if (!claimed.ok) return;
				const identity = claimed.value.consumerIdentity();
				const receipt = claimed.value.onSettledWithReceipt(
					(settlement: WakeSettlementV1): WakeConsumerReceiptV1 | undefined => {
						if (
							settlement.state !== "committed" ||
							settlement.delivery !== "delivered" ||
							this.#handledOffers.has(settlement.offer.offerId)
						) {
							return undefined;
						}
						this.#handledOffers.add(settlement.offer.offerId);
						if (producerAlreadyOwns(settlement.offer)) return undefined;
						const active = options.getActiveGoal();
						if (!active || active.id !== goal.id) return undefined;
						const scheduled = options.scheduleContinuation(goal.id, settlement.offer);
						if (!scheduled) return undefined;
						return {
							version: 1,
							...identity,
							continuationId: scheduled.continuationId,
							scheduling: scheduled.scheduling,
						};
					},
				);
				if (!receipt.ok) {
					options.diagnostic?.(`Cannot register background wake receipt: ${receipt.message}`);
				}
			},
		});
		if (!registered.ok) {
			throw new Error(`[pi-goal/runtime-contracts] ${registered.message}`);
		}
		this.#wakeConsumer = registered.value;
	}

	/**
	 * Treat an offer as already answered. A continuation recovered from persisted state has
	 * no live producer left, so this keeps a replayed offer from scheduling a second turn.
	 */
	markOfferHandled(offerId: string) {
		this.#handledOffers.add(offerId);
	}

	unbindWakeConsumer() {
		this.#wakeConsumer?.dispose();
		this.#wakeConsumer = undefined;
	}

	clear() {
		this.unbindWakeConsumer();
		this.#checkIns.clear();
		this.#handledOffers.clear();
	}
}

// Temporary compatibility name for local imports while the Goal migration lands.
export { BackgroundContinuationBridge as ProcessContinuationBridge };

import { GOAL_MAILBOX_TYPE, goalMailKey } from "./mailbox.js";
import type { GoalStateEntryData } from "./persistence.js";

/** Pure source projection for G's locked, archived, explicitly confirmed offline
 * operation. This function does not grant abandonment or write a live session. */
export function normalizeGoalMailboxForRollback(
	state: GoalStateEntryData,
	selectedKeys: readonly string[],
) {
	const selected = new Set(selectedKeys);
	const next = structuredClone(state);
	const owed = next.pendingContinuation;
	const affected =
		next.mailbox?.intents.filter((intent) =>
			selected.has(goalMailKey(intent.goalId, intent.marker)),
		) ?? [];
	const selectedOwed = owed && selected.has(goalMailKey(owed.goalId, owed.continuationId));
	if (selectedOwed) delete next.pendingContinuation;
	if (
		next.goal &&
		next.goal.status !== "complete" &&
		((selectedOwed && owed.goalId === next.goal.id) ||
			affected.some((intent) => intent.goalId === next.goal?.id))
	) {
		// Offline abandonment is not live execution: keep recorded usage and discard
		// the stale clock so an old reader cannot charge the offline interval later.
		next.goal.status = "paused";
		delete next.goal.activeStartedAt;
	}
	if (next.mailbox) {
		next.mailbox.intents = next.mailbox.intents.filter(
			(intent) => !selected.has(goalMailKey(intent.goalId, intent.marker)),
		);
		if (next.mailbox.intents.length === 0) delete next.mailbox;
	}
	return next;
}

export function neutralizeGoalMailboxCarrier<
	T extends { customType?: string; content?: unknown; details?: unknown },
>(message: T, selectedKeys: readonly string[]): T {
	if (message.customType !== GOAL_MAILBOX_TYPE) return message;
	const details = message.details as { goalId?: unknown; continuationMarker?: unknown } | undefined;
	if (
		typeof details?.goalId !== "string" ||
		typeof details.continuationMarker !== "string" ||
		!selectedKeys.includes(goalMailKey(details.goalId, details.continuationMarker))
	)
		return message;
	return {
		...message,
		customType: "goal-mailbox-abandoned-v1",
		content: "The user abandoned this Goal delivery.",
		details: { version: 1, goalId: details.goalId, continuationMarker: details.continuationMarker },
	};
}

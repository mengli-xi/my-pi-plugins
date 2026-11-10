export interface GoalRunIntent {
	goalId: string;
	marker: string;
	prompt: string;
	anchorEntryId: string | null;
	/** Frozen source execution; copied entry IDs in a fork grant no authority. */
	sourceSessionId?: string;
	/** Source checkpoint (or exact canonical carrier for legacy recovery). */
	originEntryId?: string;
	/** Frozen at source creation; older C state defaults to new-run. */
	policy?: "new-run" | "next-request";
	kind: "continue" | "budget" | "checkin" | "activation";
	started: boolean;
}

export interface GoalMailboxState {
	intents: GoalRunIntent[];
	cancelling: boolean;
}

export function parseGoalMailboxState(value: unknown): GoalMailboxState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const state = value as Partial<GoalMailboxState>;
	if (typeof state.cancelling !== "boolean" || !Array.isArray(state.intents)) return undefined;
	if (
		!state.intents.every(
			(intent) =>
				intent &&
				typeof intent.goalId === "string" &&
				intent.goalId.length > 0 &&
				typeof intent.marker === "string" &&
				intent.marker.startsWith(`${intent.goalId}:`) &&
				!/[\s>]/u.test(intent.marker) &&
				typeof intent.prompt === "string" &&
				(intent.anchorEntryId === null || typeof intent.anchorEntryId === "string") &&
				(intent.sourceSessionId === undefined ||
					(typeof intent.sourceSessionId === "string" && intent.sourceSessionId.length > 0)) &&
				(intent.originEntryId === undefined ||
					(typeof intent.originEntryId === "string" && intent.originEntryId.length > 0)) &&
				(intent.policy === undefined ||
					intent.policy === "new-run" ||
					intent.policy === "next-request") &&
				["continue", "budget", "checkin", "activation"].includes(intent.kind) &&
				typeof intent.started === "boolean",
		)
	)
		return undefined;
	if (new Set(state.intents.map((intent) => intent.marker)).size !== state.intents.length)
		return undefined;
	return structuredClone(state as GoalMailboxState);
}

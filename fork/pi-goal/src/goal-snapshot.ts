import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentTokenTotal, nonNegativeFiniteNumber } from "./accounting.js";
import type { ActiveGoal } from "./persistence.js";
import type { StatusContext } from "./runtime.js";

export const GOAL_SNAPSHOT_CHANNEL = "goal:snapshot-v1";
export const GOAL_SNAPSHOT_REQUEST_CHANNEL = "goal:request:snapshot-v1";

export interface GoalSemanticSnapshotV1 {
	id: string;
	text: string;
	phase: ActiveGoal["status"];
	clockRunning?: boolean;
	queueFrozen?: boolean;
	runtimeSeconds: number;
	tokensUsed: number;
	tokenBudget?: number;
	queued: number;
	observedAt: number;
}

export interface GoalSnapshotPayloadV1 {
	version: 1;
	sessionId?: string;
	goal: GoalSemanticSnapshotV1 | null;
}

interface GoalSnapshotRequestV1 {
	sessionId?: string;
	reply: (payload: GoalSnapshotPayloadV1) => void;
}

export function buildGoalSnapshotPayload(
	goal: ActiveGoal | undefined,
	queued: number,
	queueFrozen: boolean,
	ctx: StatusContext | undefined,
	now = Date.now(),
): GoalSnapshotPayloadV1 {
	const sessionId = sessionIdFrom(ctx);
	if (!goal) return { version: 1, ...(sessionId ? { sessionId } : {}), goal: null };
	const settledRuntime = nonNegativeFiniteNumber(goal.timeUsedSeconds);
	const activeStartedAt = goal.activeStartedAt;
	const clockRunning =
		goal.status === "active" &&
		typeof activeStartedAt === "number" &&
		Number.isFinite(activeStartedAt);
	const liveRuntime = clockRunning ? Math.max(0, now - activeStartedAt) / 1_000 : 0;
	const checkpointedTokens = nonNegativeFiniteNumber(goal.tokensUsed);
	const derivedTokens = ctx
		? Math.max(0, currentTokenTotal(ctx) - nonNegativeFiniteNumber(goal.baselineTokens))
		: 0;
	const tokenBudget =
		typeof goal.tokenBudget === "number" &&
		Number.isFinite(goal.tokenBudget) &&
		goal.tokenBudget > 0
			? goal.tokenBudget
			: undefined;
	return {
		version: 1,
		...(sessionId ? { sessionId } : {}),
		goal: {
			id: goal.id,
			text: goal.text,
			phase: goal.status,
			clockRunning,
			queueFrozen,
			runtimeSeconds: settledRuntime + liveRuntime,
			tokensUsed:
				goal.status === "active" ? Math.max(checkpointedTokens, derivedTokens) : checkpointedTokens,
			...(tokenBudget === undefined ? {} : { tokenBudget }),
			queued: Math.max(0, Math.floor(queued)),
			observedAt: now,
		},
	};
}

export function installGoalSnapshotProtocol(
	pi: ExtensionAPI,
	read: () => GoalSnapshotPayloadV1,
): () => void {
	return pi.events.on(GOAL_SNAPSHOT_REQUEST_CHANNEL, (value) => {
		const request = parseRequest(value);
		if (!request) return;
		const snapshot = read();
		if (request.sessionId && request.sessionId !== snapshot.sessionId) return;
		try {
			request.reply(snapshot);
		} catch {
			// A consumer callback cannot interrupt the goal owner's state machine.
		}
	});
}

function parseRequest(value: unknown): GoalSnapshotRequestV1 | undefined {
	if (!value || typeof value !== "object") return undefined;
	const request = value as Partial<GoalSnapshotRequestV1>;
	if (typeof request.reply !== "function") return undefined;
	if (request.sessionId !== undefined && typeof request.sessionId !== "string") return undefined;
	return request as GoalSnapshotRequestV1;
}

function sessionIdFrom(ctx: StatusContext | undefined): string | undefined {
	const sessionManager = ctx?.sessionManager as { getSessionId?: () => unknown } | undefined;
	const sessionId = sessionManager?.getSessionId?.();
	return typeof sessionId === "string" && sessionId ? sessionId : undefined;
}

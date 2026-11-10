import {
	type AgentEndEvent,
	type AgentSettledEvent,
	type BeforeAgentStartEvent,
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { showTextPanel } from "pi-li-uikit/text-panel";
import { registerGoalContinuationObligationV1 } from "pi-runtime-contracts/goal-continuation-obligation-v1";
import type { MailboxBinding, MailboxRunStart } from "pi-session-inject/mailbox-v1";
import { Type } from "typebox";
import { currentTokenTotal, formatDuration } from "./accounting.js";
import { completeGoalArguments, parseCommand } from "./command.js";
import { GoalCommandController } from "./commands.js";
import {
	buildGoalSnapshotPayload,
	GOAL_SNAPSHOT_CHANNEL,
	installGoalSnapshotProtocol,
} from "./goal-snapshot.js";
import { GOAL_MAILBOX_TYPE, GoalMailbox, goalSourceSessionScope } from "./mailbox.js";
import { editGoalObjective, showGoalManager } from "./menu.js";
import { type ActiveGoal, loadGoalStateFromSession } from "./persistence.js";
import { buildGoalPrompt, buildGoalSystemPrompt, buildPausedGoalSystemPrompt } from "./prompts.js";
import { activateQueuedGoal } from "./queue.js";
import { GoalRunController } from "./run-protocol.js";
import {
	type AssistantMessageLike,
	abortCurrentTurn,
	blocksStaleGoalToolCalls,
	findFinalAssistantMessage,
	formatError,
	formatStatus,
	GOAL_BLOCKED_TOOL,
	GOAL_COMPLETE_TOOL,
	GoalRuntime,
	goalIdRejectionReason,
	incrementGoal,
	isContradictoryCompletionSummary,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
	resetGoalSafetyEpoch,
	STATUS_KEY,
	type StatusContext,
	transitionGoal,
	truncateNotification,
} from "./runtime.js";
import { ProcessContinuationBridge } from "./runtime-continuation.js";
import { hasAssistantToolCall } from "./safety.js";
import {
	DEFAULT_GOAL_SETTINGS,
	type GoalSettings,
	readGoalSettings,
	saveGoalSettings,
} from "./settings.js";
import { showGoalSettings } from "./settings-ui.js";

// goal.ts remains the Pi-facing composition root despite its size because tool contracts and
// lifecycle-event registration share order-sensitive wiring. Per-session mechanisms live in
// runtime.ts, while user-command transitions live in commands.ts; each factory stays isolated.

interface GoalCompleteDetails {
	goal: string;
	goal_id: string;
	summary: string;
}

interface GoalBlockedDetails {
	goal: string;
	goal_id: string;
	reason: string;
	evidence: string;
	repeated_turns: number;
}

interface GoalOptions {
	settingsPath?: string;
	mailbox?: MailboxBinding;
}

const EXPERIMENTAL_GOALS_WARNING =
	"Experimental ordered goals are enabled for pi-goal. Queue behavior and persisted state may change.";
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;

// Cohesion justification: command, tool, continuation, and lifecycle handlers coordinate one
// guarded Goal state machine whose ordering and stale-turn invariants share the same closures.
function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
	const runtime = new GoalRuntime(pi);
	const commands = new GoalCommandController(runtime);
	const endedRuns = new WeakSet<object>();
	const startedRuns = new WeakSet<object>();
	const runController = new GoalRunController(runtime, commands);
	const processContinuation = new ProcessContinuationBridge();
	let lastAppendIssue: string | undefined;
	const mailbox = new GoalMailbox(
		runtime,
		pi,
		{
			beforeRun: (start) => {
				if (startedRuns.has(start.event)) return;
				startedRuns.add(start.event);
				return beforeRun(start.event, start.ctx, start);
			},
			afterRun: (end) => {
				if (endedRuns.has(end.event)) return;
				endedRuns.add(end.event);
				return afterRun(end.event, end.ctx);
			},
			settled: (event, ctx) => settled(event, ctx),
		},
		options.mailbox,
	);
	runtime.mailbox = mailbox;
	runController.register(pi);
	let snapshotContext: StatusContext | undefined;
	const readObligation: Parameters<typeof registerGoalContinuationObligationV1>[0] = (query) => {
		const ctx = snapshotContext as ExtensionContext | undefined;
		if (!ctx || runtime.mailboxInvalid) return "unknown";
		if (ctx.sessionManager.getSessionId() !== query.sessionId) return "none";
		const state = loadGoalStateFromSession(ctx);
		if (state.mailboxInvalid) return "unknown";
		if (
			!state.goal ||
			state.goal.status === "complete" ||
			state.pendingContinuation?.continuationId !== query.continuationId
		)
			return "none";
		const scope = goalSourceSessionScope(
			ctx,
			state.pendingContinuation.sourceSessionId !== undefined
				? state.pendingContinuation
				: (state.mailbox?.intents.find((intent) => intent.marker === query.continuationId) ??
						state.pendingContinuation),
		);
		return scope === "own" ? "owed" : scope === "foreign" ? "none" : "unknown";
	};
	let obligationReader = registerGoalContinuationObligationV1(readObligation);
	// session_tree restores only durable state. Its owed completion needs one later
	// settled boundary to rebuild ephemeral continuation intent/delivery.
	let restoreOwedContinuationAtSettled = false;
	const readSemanticSnapshot = () =>
		buildGoalSnapshotPayload(
			runtime.activeGoal,
			runtime.queuedGoals.length,
			runtime.queueFrozen,
			snapshotContext,
		);
	const publishSemanticSnapshot = () => {
		pi.events.emit(GOAL_SNAPSHOT_CHANNEL, readSemanticSnapshot());
	};
	installGoalSnapshotProtocol(pi, readSemanticSnapshot);
	runtime.setSemanticSnapshotSink(publishSemanticSnapshot);

	// Bind per-factory runtime operations once so event orchestration stays concise
	// without reintroducing module-global mutable state.
	const clearCompletionStatusTimer = runtime.clearCompletionStatusTimer.bind(runtime);
	const clearContinuationTracking = runtime.clearContinuationTracking.bind(runtime);
	const clearPendingGoalPrompts = runtime.clearPendingGoalPrompts.bind(runtime);
	const clearGoalRecovery = runtime.clearGoalRecovery.bind(runtime);
	const clearBudgetWrapUp = runtime.clearBudgetWrapUp.bind(runtime);
	const clearStaleGoalToolCallBlock = runtime.clearStaleGoalToolCallBlock.bind(runtime);
	const persistGoal = runtime.persistGoal.bind(runtime);
	const updateGoalUsage = runtime.recordGoalUsage.bind(runtime);
	const updateStatus = runtime.updateStatus.bind(runtime);
	const limitActiveGoalForBudget = runtime.limitActiveGoalForBudget.bind(runtime);
	const hideGoalToolsIfLocked = runtime.hideGoalToolsIfLocked.bind(runtime);
	const goalToolsAvailable = runtime.goalToolsAvailable.bind(runtime);
	const pauseGoalForUnavailableTools = runtime.pauseGoalForUnavailableTools.bind(runtime);
	const isPiOwnedCompactionRetry = runtime.isPiOwnedCompactionRetry.bind(runtime);
	const requestContinuation = runtime.requestContinuation.bind(runtime);
	const dispatchContinuationIfSettled = runtime.dispatchContinuationIfSettled.bind(runtime);
	const keepBudgetWrapUpMessage = runtime.keepBudgetWrapUpMessage.bind(runtime);
	const isGoalToolName = runtime.isGoalToolName.bind(runtime);
	const queueBudgetWrapUp = runtime.queueBudgetWrapUp.bind(runtime);
	const clearGoalRecoveryForGoal = runtime.clearGoalRecoveryForGoal.bind(runtime);
	const blockStaleGoalToolCalls = runtime.blockStaleGoalToolCalls.bind(runtime);
	const cancelContinuationWork = runtime.cancelContinuationWork.bind(runtime);
	const consumeCancelledContinuationPrompt =
		runtime.consumeCancelledContinuationPrompt.bind(runtime);
	const consumeStaleOwnedGoalPrompt = runtime.consumeStaleOwnedGoalPrompt.bind(runtime);
	const consumePendingGoalPrompt = runtime.consumeOwnedGoalPrompt.bind(runtime);
	const markContinuationStarted = runtime.markContinuationStarted.bind(runtime);
	const confirmContinuationDispatch = runtime.confirmContinuationDispatch.bind(runtime);
	const hasContinuationWorkForGoal = runtime.hasContinuationWorkForGoal.bind(runtime);
	const recordAutomaticTurn = runtime.recordAutomaticTurn.bind(runtime);
	const recordAutomaticRunProgress = runtime.recordAutomaticRunProgress.bind(runtime);
	const enforceAutomaticTurnLimit = runtime.enforceAutomaticTurnLimit.bind(runtime);
	const enforceNoProgressLimit = runtime.enforceNoProgressLimit.bind(runtime);
	const clearActiveGoal = runtime.clearActiveGoal.bind(runtime);
	const showCompletionStatus = runtime.showCompletionStatus.bind(runtime);
	const restoreGoalToolsHiddenByPolicy = runtime.restoreGoalToolsHiddenByPolicy.bind(runtime);
	const activeBackgroundLease = (ctx: StatusContext) => {
		const sessionManager = ctx.sessionManager as { getSessionId?: () => string } | undefined;
		const sessionId = sessionManager?.getSessionId?.();
		return processContinuation.activeLease(sessionId);
	};
	const shouldDeferContinuation = (ctx: StatusContext) => activeBackgroundLease(ctx) !== undefined;
	const recordOwedBackgroundContinuation = (
		goalId: string,
		continuationId: string,
		offer: { offerId: string; ownerId: string; logicalKey: string },
		sourceSessionId: string,
	) => {
		const goal = runtime.activeGoal;
		// The receipt stands even when the dispatch attempt just paused the goal for a safety
		// limit or missing tools: that promise is then owed to the resume, not dropped.
		if (
			goal?.id !== goalId ||
			goal.status === "complete" ||
			runtime.mailboxSessionId !== sourceSessionId
		)
			return false;
		const owed = runtime.pendingBackgroundContinuation;
		// Offers that coalesce onto one continuation owe one turn between them. The first claim
		// keeps the record so the merged turn discharges it exactly once.
		if (owed?.goalId === goalId && owed.continuationId === continuationId) {
			const intent = runtime.mailboxState.intents.find((item) => item.marker === continuationId);
			if (
				!snapshotContext ||
				goalSourceSessionScope(
					snapshotContext as ExtensionContext,
					owed.sourceSessionId !== undefined ? owed : (intent ?? owed),
				) !== "own"
			)
				return false;
			runtime.pendingBackgroundContinuation = { ...owed, sourceSessionId };
			persistGoal(goal);
			return true;
		}
		runtime.pendingBackgroundContinuation = {
			goalId,
			sourceSessionId,
			continuationId,
			offerId: offer.offerId,
			ownerId: offer.ownerId,
			logicalKey: offer.logicalKey,
			recordedAt: Date.now(),
		};
		persistGoal(goal);
		return true;
	};
	// The producer already saw this wake delivered, so nothing will offer it again. Re-arm
	// the owed continuation once and let the ordinary dispatch path run it at the first
	// settled boundary. A paused or otherwise stopped goal keeps the marker until /goal
	// resume, and a cleared or completed goal never carries one (D-007, D-009).
	const restoreOwedBackgroundContinuation = async (ctx: StatusContext) => {
		const owed = runtime.pendingBackgroundContinuation;
		const goal = runtime.activeGoal;
		if (!owed || goal?.id !== owed.goalId || goal.status !== "active") return false;
		if (
			goalSourceSessionScope(
				ctx as ExtensionContext,
				owed.sourceSessionId !== undefined
					? owed
					: (runtime.mailboxState.intents.find((intent) => intent.marker === owed.continuationId) ??
							owed),
			) !== "own" ||
			hasContinuationWorkForGoal(goal.id)
		)
			return false;
		processContinuation.markOfferHandled(owed.offerId);
		if (!requestContinuation(goal, owed.continuationId)) return false;
		await dispatchContinuationIfSettled(ctx);
		return true;
	};
	const scheduleProcessWaitCheckInIfNeeded = (ctx: StatusContext) => {
		runtime.clearProcessWaitCheckInTimer();
		const intervalMs = runtime.settings.backgroundWaitCheckInMs;
		if (intervalMs === null || !runtime.activeGoal || runtime.activeGoal.status !== "active")
			return;
		const lease = activeBackgroundLease(ctx);
		if (!lease) return;
		const now = Date.now();
		const base = processContinuation.checkInBase(lease);
		const delayMs = Math.max(0, base + intervalMs - now);
		runtime.processWaitCheckInTimer = setTimeout(() => {
			runtime.processWaitCheckInTimer = undefined;
			const currentLease = activeBackgroundLease(ctx);
			const goal = runtime.activeGoal;
			if (!currentLease || !goal || goal.status !== "active") return;
			processContinuation.markCheckIn(currentLease.leaseId);
			const backgroundReason = currentLease.reason?.trim() || "background work";
			const prompt = [
				`Background work '${backgroundReason}' has been waiting for ${formatDuration(intervalMs / 1_000)} while the active /goal is paused for it.`,
				"Inspect the relevant background status or result, then decide whether to keep waiting, intervene, mark the goal blocked, or continue only if there is enough evidence.",
			].join("\n");
			void runtime.sendAutomaticGoalPrompt(ctx, goal.id, prompt, "checkin");
		}, delayMs);
		runtime.processWaitCheckInTimer.unref?.();
	};
	const dispatchPendingQueueActionIfSettled =
		commands.dispatchPendingQueueActionIfSettled.bind(commands);

	const goalCompleteTool = defineTool({
		name: GOAL_COMPLETE_TOOL,
		label: "Goal Complete",
		description:
			"Mark the active /goal as complete after all required work is done and verified, using the current goal_id stale-turn guard. Do not use for partial progress, blockers, failing, or unverified work.",
		promptSnippet:
			"Mark the active /goal as complete after fully finishing and verifying it, with the current goal_id",
		promptGuidelines: [
			"When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
			"Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
			"Pass the exact goal_id shown in the current /goal prompt; never reuse a goal_id from an older, stopped, replaced, or cleared turn.",
			"Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains; otherwise keep working.",
		],
		parameters: Type.Object({
			goal_id: Type.String({
				description:
					"The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
			}),
			summary: Type.String({
				description:
					"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const completedGoal = runtime.activeGoal;
			const goal = completedGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const summary = typeof params.summary === "string" ? params.summary.trim() : "";

			if (!completedGoal) {
				const rejection = "Goal completion rejected: no active goal.";
				ctx.ui.notify(rejection, "warning");

				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				};
			}
			const completingDuringBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
			if (!runtime.canRecordGoalUsage() && !completingDuringBudgetWrapUp) {
				const rejection = "Goal completion rejected: current run does not own the active goal.";
				ctx.ui.notify(rejection, "warning");
				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				};
			}
			if (hasPendingSkipForGoal(completedGoal.id)) {
				updateGoalUsage(completedGoal, ctx);
				persistGoal(completedGoal);
				updateStatus(ctx, completedGoal);
				clearBudgetWrapUp();
				const rejection = "Goal completion rejected: goal is queued to be skipped.";
				ctx.ui.notify(rejection, "warning");
				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					terminate: true,
				};
			}
			const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
			if (staleGoalRejection) {
				const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
				ctx.ui.notify(rejection, "warning");
				if (completingDuringBudgetWrapUp) {
					updateGoalUsage(completedGoal, ctx);
					persistGoal(completedGoal);
					updateStatus(ctx, completedGoal);
					clearBudgetWrapUp();
				}

				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					terminate: completingDuringBudgetWrapUp || undefined,
				};
			}
			if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
				const rejection = `Goal completion rejected: goal is ${completedGoal.status}, not active.`;
				ctx.ui.notify(rejection, "warning");

				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				};
			}

			const rejectionReason = !summary
				? "summary is empty"
				: isContradictoryCompletionSummary(summary)
					? "summary says the goal is not complete"
					: undefined;
			if (rejectionReason) {
				updateGoalUsage(completedGoal, ctx);
				persistGoal(completedGoal);
				updateStatus(ctx, completedGoal);
				const rejection = `Goal completion rejected: ${rejectionReason}.`;
				ctx.ui.notify(rejection, "warning");
				if (completingDuringBudgetWrapUp) clearBudgetWrapUp();

				return {
					content: [
						{
							type: "text",
							text: rejection,
						},
					],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					terminate: completingDuringBudgetWrapUp || undefined,
				};
			}

			if (runtime.needsMailboxCancellation() && !(await runtime.cancelGoalMail(ctx)))
				return {
					content: [{ type: "text", text: "Goal completion held: cancellation pending." }],
					details: { goal, goal_id: requestedGoalId, summary },
				};
			if (runtime.activeGoal?.id !== completedGoal.id)
				return {
					content: [{ type: "text", text: "Goal changed." }],
					details: { goal, goal_id: requestedGoalId, summary },
				};
			runtime.activeGoal = transitionGoal(completedGoal, "complete");
			runtime.setCompletionSummary(runtime.activeGoal.id, summary);
			updateGoalUsage(runtime.activeGoal, ctx);
			if (runtime.pendingQueueAction?.kind === "prioritize") {
				persistGoal(runtime.activeGoal);
				ctx.ui.setStatus(STATUS_KEY, "complete");
				ctx.ui.notify(`Goal complete: ${goal}. Priority goal waits for Pi to settle.`, "info");
				return {
					content: [{ type: "text", text: `Goal complete: ${summary}` }],
					details: {
						goal,
						goal_id: requestedGoalId,
						summary,
					} satisfies GoalCompleteDetails,
					terminate: true,
				};
			}
			if (runtime.queuedGoals.length > 0) {
				runtime.pendingQueueAction = {
					kind: "advance",
					goalId: runtime.activeGoal.id,
					reason: "complete",
					completedText: goal,
				};
				persistGoal(runtime.activeGoal);
				ctx.ui.setStatus(STATUS_KEY, "complete");
				ctx.ui.notify(
					`Goal complete: ${goal}. Next goal queued: ${runtime.queuedGoals[0]?.text}`,
					"info",
				);
				return {
					content: [
						{
							type: "text",
							text: `Goal complete: ${summary}\nNext goal queued: ${runtime.queuedGoals[0]?.text}`,
						},
					],
					details: {
						goal,
						goal_id: requestedGoalId,
						summary,
					} satisfies GoalCompleteDetails,
					terminate: true,
				};
			}
			persistGoal(runtime.activeGoal);

			ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal));
			await clearActiveGoal(ctx);
			showCompletionStatus(ctx);
			ctx.ui.notify(`Goal complete: ${goal}`, "info");

			return {
				content: [{ type: "text", text: `Goal complete: ${summary}` }],
				details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				terminate: true,
			};
		},
	});

	const goalBlockedTool = defineTool({
		name: GOAL_BLOCKED_TOOL,
		label: "Goal Blocked",
		description:
			"Stop the active /goal only at a true impasse after the same blocker recurs for at least three consecutive goal turns, with the current goal_id and concrete evidence that user or external action is required. Do not use for ordinary clarification, uncertainty, or recoverable failures.",
		promptSnippet:
			"Mark the active /goal blocked only after the same blocker recurs for three consecutive goal turns",
		promptGuidelines: [
			"Use goal_blocked only for a true impasse after the same blocker recurs for at least three consecutive goal turns and concrete evidence shows user or external action is required.",
			"After a blocked goal is resumed, start a fresh three-turn blocker audit before using goal_blocked again.",
			"Do not use goal_blocked for ordinary clarification, incomplete work, uncertainty, difficult tasks, or recoverable tool/provider failures.",
			"Pass goal_blocked the exact current goal_id; never reuse a goal_id from an older, stopped, replaced, or cleared goal turn.",
		],
		parameters: Type.Object({
			goal_id: Type.String({
				description: "The exact goal_id shown in the current active /goal prompt.",
			}),
			reason: Type.String({
				minLength: 1,
				maxLength: MAX_BLOCKER_REASON_LENGTH,
				description: "The specific user or external action required to unblock the goal.",
			}),
			evidence: Type.String({
				minLength: 1,
				maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
				description: "Concrete evidence from the repeated attempts that proves the impasse.",
			}),
			repeated_turns: Type.Integer({
				minimum: 3,
				description: "Number of separate turns spent trying to resolve this same blocker.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const blockedGoal = runtime.activeGoal;
			const goal = blockedGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
			const repeatedTurns =
				typeof params.repeated_turns === "number" ? params.repeated_turns : Number.NaN;
			const reject = (rejectionReason: string, terminate = false) => {
				const rejection = `goal_blocked rejected: ${rejectionReason}.`;
				ctx.ui.notify(rejection, "warning");
				return {
					content: [{ type: "text" as const, text: rejection }],
					details: {
						goal,
						goal_id: requestedGoalId,
						reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
						evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
						repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
					} satisfies GoalBlockedDetails,
					...(terminate ? { terminate: true as const } : {}),
				};
			};

			if (!blockedGoal) return reject("no active goal");
			if (!runtime.canRecordGoalUsage()) {
				return reject("current run does not own the active goal");
			}
			if (hasPendingSkipForGoal(blockedGoal.id)) {
				updateGoalUsage(blockedGoal, ctx);
				persistGoal(blockedGoal);
				updateStatus(ctx, blockedGoal);
				clearBudgetWrapUp();
				return reject("goal is queued to be skipped", true);
			}
			const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
			if (staleGoalRejection) return reject(staleGoalRejection);
			if (blockedGoal.status !== "active") {
				return reject(`goal is ${blockedGoal.status}, not active`);
			}
			if (!reason) return reject("reason is empty");
			if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
			if (!evidence) return reject("evidence is empty");
			if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
			if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
			if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");

			updateGoalUsage(blockedGoal, ctx);
			if (runtime.needsMailboxCancellation() && !(await runtime.cancelGoalMail(ctx)))
				return reject("cancellation pending");
			cancelContinuationWork();
			clearBudgetWrapUp();
			clearGoalRecoveryForGoal(blockedGoal.id);
			blockStaleGoalToolCalls();
			runtime.activeGoal = transitionGoal(blockedGoal, "blocked");
			runtime.setTerminalReason(runtime.activeGoal.id, reason);
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
			ctx.ui.notify(`Goal blocked: ${truncateNotification(reason)}`, "warning");

			return {
				content: [{ type: "text", text: `Goal blocked: ${reason}` }],
				details: {
					goal,
					goal_id: requestedGoalId,
					reason,
					evidence,
					repeated_turns: repeatedTurns,
				} satisfies GoalBlockedDetails,
				terminate: true,
			};
		},
	});

	pi.registerTool(goalCompleteTool);
	pi.registerTool(goalBlockedTool);
	// Do not touch the active tool set during factory registration: ExtensionAPI
	// actions are unbound until the session binds the runtime. session_start applies
	// baseline visibility once actions work; later hooks only enforce goal safety.

	/**
	 * `/goal status`, as a card replacing the editor.
	 *
	 * Only in the TUI, and only with something to read: RPC has no editor slot of its
	 * own and print/json have no output channel at all, so both keep the
	 * notification — which for print/json is still the error saying so. "No goal
	 * is currently set" stays a notification too; a card that has to be dismissed
	 * is more ceremony than a one-line answer deserves.
	 */
	const showGoalStatus = async (ctx: ExtensionCommandContext) => {
		if (!runtime.activeGoal || ctx.mode !== "tui" || !ctx.hasUI) {
			commands.showGoal(ctx);
			return;
		}
		await showTextPanel(ctx, {
			title: "Goal status",
			body: commands.goalStatusReport(ctx),
			format: "plain",
		});
	};

	/** `/goal modify`: the menu's edit dialog, reached without the menu. */
	const modifyGoalObjective = async (ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
			throw new Error(
				`/goal modify is unavailable in ${ctx.mode ?? "this"} mode because it opens an editor. Use /goal edit <objective>.`,
			);
		}
		if (!runtime.activeGoal) {
			ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "warning");
			return;
		}
		await editGoalObjective(runtime, commands, ctx);
	};

	pi.registerCommand("goal", {
		description: "Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>",
		getArgumentCompletions: (prefix) =>
			completeGoalArguments(prefix, {
				experimentalGoals: runtime.settings.experimental.goals,
			}),
		handler: async (args, ctx) => {
			const result = parseCommand(args, {
				experimentalGoals: runtime.settings.experimental.goals,
			});
			if (typeof result === "string") {
				ctx.ui.notify(result, "warning");
				return;
			}
			if (result.kind === "show" && args.trim() === "") {
				await showGoalManager(runtime, commands, ctx, (menuCtx, target) =>
					showGoalSettings(runtime, menuCtx, {
						settingsPath: options.settingsPath,
						initialScreen: target,
						onQueueUnfrozen: async (settingsCtx) => {
							await commands.resumeQueueAfterUnfreeze(settingsCtx);
						},
					}),
				);
				return;
			}
			if (runtime.queueFrozen) {
				if (result.kind === "show") await showGoalStatus(ctx);
				else if (result.kind === "clear") await commands.clearGoal(ctx);
				else commands.notifyFrozenQueue(ctx);
				return;
			}
			if (runtime.pendingQueueAction && result.kind !== "show" && result.kind !== "clear") {
				ctx.ui.notify(
					"A queued goal change is waiting for Pi to settle. Retry after it finishes.",
					"warning",
				);
				return;
			}

			switch (result.kind) {
				case "show":
					await showGoalStatus(ctx);
					return;
				case "modify":
					await modifyGoalObjective(ctx);
					return;
				case "pause":
					await commands.pauseGoal(ctx);
					return;
				case "resume":
					await commands.resumeGoal(ctx);
					return;
				case "clear":
					await commands.clearGoal(ctx);
					return;
				case "edit":
					await commands.editGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "add":
					await commands.addGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "prioritize":
					await commands.prioritizeGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "drop-last":
					await commands.dropLastGoal(ctx);
					return;
				case "skip":
					await commands.skipGoal(ctx);
					return;
				case "idle-checkin": {
					const next = {
						...structuredClone(runtime.settings),
						backgroundWaitCheckInMs: result.backgroundWaitCheckInMs ?? null,
					} satisfies GoalSettings;
					try {
						saveGoalSettings(next, options.settingsPath);
						runtime.settings = next;
						ctx.ui.notify(
							next.backgroundWaitCheckInMs === null
								? "Goal background-wait idle check-in: off."
								: `Goal background-wait idle check-in: ${formatDuration(next.backgroundWaitCheckInMs / 1_000)}.`,
							"info",
						);
					} catch (error) {
						ctx.ui.notify(`Cannot save /goal settings: ${formatError(error)}`, "error");
					}
					return;
				}
				case "start":
					await commands.startGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
			}
		},
	});

	async function restoreSession(ctx: ExtensionContext) {
		snapshotContext = ctx;
		obligationReader.dispose();
		obligationReader = registerGoalContinuationObligationV1(readObligation);
		restoreOwedContinuationAtSettled = false;
		lastAppendIssue = undefined;
		runtime.replaceMenuSession();
		const generation = runtime.menuGeneration;
		clearCompletionStatusTimer();
		clearContinuationTracking();
		processContinuation.clear();
		clearPendingGoalPrompts();
		runtime.clearAgentRun();
		runtime.guardAbortGoalId = undefined;
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.queuedGoals = [];
		runtime.pendingQueueAction = undefined;
		runtime.queueFrozen = false;
		runtime.queueFreezeAwaitingSettle = false;
		runtime.clearTerminalDetails();
		const previousToolVisibility = runtime.settings.toolVisibility;
		const settingsResult = readGoalSettings(options.settingsPath);
		runtime.settings =
			settingsResult.kind === "loaded" ? settingsResult.settings : DEFAULT_GOAL_SETTINGS;
		runtime.settingsLoadIssue = settingsResult.kind === "invalid" ? settingsResult : undefined;
		if (settingsResult.kind === "invalid") {
			ctx.ui.notify(
				`pi-goal settings ignored: ${settingsResult.reason}. Using default settings.`,
				"warning",
			);
		}
		if (runtime.settings.experimental.goals) {
			ctx.ui.notify(EXPERIMENTAL_GOALS_WARNING, "warning");
		}
		if (
			runtime.settings.toolVisibility === "after-first-goal" &&
			previousToolVisibility === "always"
		) {
			runtime.goalToolsUnlocked = false;
		}
		if (runtime.settings.toolVisibility === "always") {
			if (runtime.goalToolsHiddenByPolicy.size > 0) {
				try {
					restoreGoalToolsHiddenByPolicy();
				} catch (error) {
					ctx.ui.notify(
						`Could not restore always-visible goal tools: ${formatError(error)}`,
						"error",
					);
				}
			}
			runtime.goalToolsUnlocked = true;
		}

		const loaded = loadGoalStateFromSession(ctx);
		runtime.activeGoal = loaded.goal;
		runtime.queuedGoals = loaded.queue;
		runtime.pendingQueueAction = loaded.pendingAction;
		runtime.pendingBackgroundContinuation = loaded.pendingContinuation;
		runtime.mailboxState = loaded.mailbox ?? { intents: [], cancelling: false };
		runtime.mailboxInvalid = loaded.mailboxInvalid ?? false;
		runtime.mailboxSessionId = ctx.sessionManager.getSessionId();
		if (runtime.mailboxInvalid || runtime.mailboxState.cancelling)
			ctx.ui.notify("Goal mailbox is held: invalid state or pending cancellation.", "warning");
		const sessionManager = ctx.sessionManager as { getSessionId?: () => string } | undefined;
		const sessionId = sessionManager?.getSessionId?.();
		if (sessionId) {
			processContinuation.bindWakeConsumer({
				sessionId,
				consumerId: "pi-goal-local",
				getActiveGoal: () => {
					const goal = runtime.activeGoal;
					return goal?.status === "active" &&
						!runtime.mailboxState.cancelling &&
						!runtime.mailboxInvalid
						? { id: goal.id, startedAt: goal.startedAt }
						: undefined;
				},
				scheduleContinuation: (goalId, offer) => {
					const goal = runtime.activeGoal;
					if (
						goal?.status !== "active" ||
						goal.id !== goalId ||
						!snapshotContext ||
						runtime.mailboxSessionId !== sessionId
					)
						return undefined;
					const existingMarker =
						runtime.continuationIntent?.goalId === goalId
							? runtime.continuationIntent.marker
							: runtime.continuationDelivery?.goalId === goalId
								? runtime.continuationDelivery.marker
								: runtime.mailboxState.intents.find(
										(intent) =>
											intent.goalId === goalId && !intent.started && intent.kind === "continue",
									)?.marker;
					const created = requestContinuation(goal);
					const continuationId =
						existingMarker ??
						runtime.continuationIntent?.marker ??
						runtime.continuationDelivery?.marker;
					if (!continuationId) return undefined;
					runtime.noteCompletionDrivenContinuation(goalId);
					// The receipt returned below terminalizes this offer for its producer, which
					// will never notify again, so the promise is recorded with the goal before the
					// dispatch attempt rather than only when Main is busy (WAKE-003). An idle
					// dispatch is no safer: pi.sendUserMessage() returns before the host has
					// accepted the prompt, and a reload in that window would drop a delivery the
					// producer already counts as done.
					if (!recordOwedBackgroundContinuation(goalId, continuationId, offer, sessionId))
						return undefined;
					void dispatchContinuationIfSettled(snapshotContext);
					return {
						continuationId,
						scheduling: created ? ("scheduled" as const) : ("coalesced" as const),
					};
				},
				diagnostic: (message) => snapshotContext?.ui.notify(message, "warning"),
			});
		}
		runtime.queueFrozen = loaded.hasExperimentalQueueState && !runtime.settings.experimental.goals;
		runController.bindSession(ctx);
		if (runtime.queueFrozen) {
			if (runtime.activeGoal) {
				// Loading starts active clocks; a retained disabled queue has no live clock.
				runtime.activeGoal.activeStartedAt = undefined;
				persistGoal(runtime.activeGoal);
			}
			ctx.ui.setStatus(STATUS_KEY, "queue off");
			ctx.ui.notify(
				"An experimental goal queue is frozen because experimental.goals is disabled. Re-enable it and run /reload to continue, or use /goal clear.",
				"warning",
			);
			return;
		}

		let startRestoredQueuedGoal = false;
		if (runtime.activeGoal?.status === "queued" && !runtime.pendingQueueAction) {
			runtime.activeGoal = activateQueuedGoal(runtime.activeGoal, currentTokenTotal(ctx));
			startRestoredQueuedGoal = runtime.activeGoal.status === "active";
		}
		if (runtime.pendingQueueAction) await dispatchPendingQueueActionIfSettled(ctx);
		if (generation !== runtime.menuGeneration) return;
		if (runtime.activeGoal) {
			if (runtime.activeGoal.status === "active" && runtime.activeGoal.safetyResetPending) {
				// Resume/edit activation is persisted before its queued prompt starts. A
				// reload must commit that promised reset before enforcing the old limits.
				runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
			}
			if (runtime.activeGoal.status === "active") {
				updateGoalUsage(runtime.activeGoal, ctx);
				if (await limitActiveGoalForBudget(ctx, false)) return;
				if (generation !== runtime.menuGeneration) return;
				if ((await enforceAutomaticTurnLimit(ctx, false)) || (await enforceNoProgressLimit(ctx)))
					return;
			}
			if (generation !== runtime.menuGeneration) return;
			if (runtime.settings.toolVisibility === "after-first-goal") {
				// Registered tools are already active on an unrestricted fresh runtime.
				// If an earlier session_start handler removed them, that restrictive
				// policy wins: mark lazy visibility unlocked without widening its set.
				runtime.goalToolsUnlocked = true;
				runtime.goalToolsHiddenByPolicy.clear();
			}
			if (runtime.activeGoal.status === "active" && !goalToolsAvailable()) {
				await pauseGoalForUnavailableTools(ctx, false);
				return;
			}
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
			if (startRestoredQueuedGoal) {
				const restoredGoal = runtime.activeGoal;
				const sent = await runtime.sendAutomaticGoalPrompt(
					ctx,
					restoredGoal.id,
					buildGoalPrompt(restoredGoal),
				);
				if (generation !== runtime.menuGeneration) return;
				if (!sent && runtime.activeGoal?.id === restoredGoal.id) {
					runtime.activeGoal = transitionGoal(restoredGoal, "paused");
					blockStaleGoalToolCalls();
					persistGoal(runtime.activeGoal);
					updateStatus(ctx, runtime.activeGoal);
				}
			}
			await mailbox.restore(ctx);
			if (generation !== runtime.menuGeneration) return;
			await restoreOwedBackgroundContinuation(ctx);
		} else {
			if (generation !== runtime.menuGeneration) return;
			if (runtime.settings.toolVisibility === "after-first-goal" && !runtime.goalToolsUnlocked) {
				hideGoalToolsIfLocked();
			}
			ctx.ui.setStatus(STATUS_KEY, undefined);
			publishSemanticSnapshot();
		}
	}
	pi.on("session_start", (_event, ctx) => mailbox.duringRecovery(() => restoreSession(ctx)));

	// Pi emits session_before_tree while ctx still points at the outgoing branch. Checkpoint
	// active usage/time there so time spent elsewhere cannot be charged on return.
	pi.on("session_before_tree", (_event, ctx) => {
		const outgoing = runtime.activeGoal;
		if (!runtime.queueFrozen && outgoing?.status === "active") {
			// Navigation can be cancelled after this preparation hook. Persist a stopped
			// checkpoint for the still-selected branch without stopping the live runtime
			// clock, which remains authoritative until session_tree actually arrives.
			const checkpoint = { ...outgoing };
			updateGoalUsage(checkpoint, ctx, false);
			persistGoal(checkpoint);
		}
	});

	// Tree navigation keeps this extension instance alive, unlike session replacement.
	// Goal state belongs to the branch at the new leaf, so discard only runtime-local
	// ownership from the old branch and restore the target branch's persisted snapshot.
	// Do not send a prompt or activate queued work here: tree navigation is reversible.
	pi.on("session_tree", (_event, ctx) => {
		runtime.replaceMenuSession();
		clearCompletionStatusTimer();
		clearContinuationTracking();
		clearPendingGoalPrompts();
		runtime.clearAgentRun();
		runtime.guardAbortGoalId = undefined;
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.clearProcessWaitCheckInTimer();

		const restored = loadGoalStateFromSession(ctx);
		restoreOwedContinuationAtSettled = restored.pendingContinuation !== undefined;
		runtime.activeGoal = restored.goal;
		runtime.queuedGoals = restored.queue;
		runtime.pendingQueueAction = restored.pendingAction;
		runtime.pendingBackgroundContinuation = restored.pendingContinuation;
		runtime.mailboxState = restored.mailbox ?? { intents: [], cancelling: false };
		runtime.mailboxInvalid = restored.mailboxInvalid ?? false;
		runtime.queueFrozen =
			restored.hasExperimentalQueueState && !runtime.settings.experimental.goals;
		runtime.queueFreezeAwaitingSettle = false;
		runtime.clearTerminalDetails();

		if (runtime.queueFrozen) {
			if (runtime.activeGoal) runtime.activeGoal.activeStartedAt = undefined;
			ctx.ui.setStatus(STATUS_KEY, runtime.activeGoal ? "queue off" : undefined);
		} else if (runtime.activeGoal) {
			if (blocksStaleGoalToolCalls(runtime.activeGoal.status)) {
				blockStaleGoalToolCalls();
			}
			updateStatus(ctx, runtime.activeGoal);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		publishSemanticSnapshot();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		restoreOwedContinuationAtSettled = false;
		runController.unbindSession();
		obligationReader.dispose();
		runtime.closeMenuSession();
		if (runtime.activeGoal) {
			if (!runtime.queueFrozen && runtime.activeGoal.status === "active") {
				updateGoalUsage(runtime.activeGoal, ctx, false);
			}
			persistGoal(runtime.activeGoal);
		}
		clearContinuationTracking();
		processContinuation.clear();
		clearPendingGoalPrompts();
		runtime.clearAgentRun();
		runtime.guardAbortGoalId = undefined;
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.activeGoal = undefined;
		runtime.queuedGoals = [];
		runtime.pendingQueueAction = undefined;
		runtime.queueFrozen = false;
		runtime.queueFreezeAwaitingSettle = false;
		snapshotContext = undefined;
		publishSemanticSnapshot();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		clearCompletionStatusTimer();
		runtime.clearProcessWaitCheckInTimer();
		runtime.clearTerminalDetails();
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (runtime.queueFrozen) return;
		if (runtime.activeGoal?.status === "budget_limited") {
			if ((event as { willRetry?: boolean }).willRetry === true) return { cancel: true as const };
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;
		if (!updateGoalUsage(runtime.activeGoal, ctx)) return;
		cancelContinuationWork();
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		if (runtime.pendingQueueAction) return;
		if (await limitActiveGoalForBudget(ctx, false)) return { cancel: true as const };
	});

	pi.on("session_compact", async (event, ctx) => {
		const generation = runtime.menuGeneration;
		if (runtime.queueFrozen) return;
		await mailbox.restore(ctx);
		if (generation !== runtime.menuGeneration) return;
		if (runtime.activeGoal?.status !== "active") {
			clearGoalRecovery();
			if (runtime.pendingQueueAction) await dispatchPendingQueueActionIfSettled(ctx);
			return;
		}

		const restoredState = loadGoalStateFromSession(ctx);
		if (restoredState.goal?.id === runtime.activeGoal.id) {
			runtime.activeGoal = restoredState.goal;
			runtime.queuedGoals = restoredState.queue;
			runtime.pendingQueueAction = restoredState.pendingAction;
		}
		const usageRecorded = updateGoalUsage(runtime.activeGoal, ctx);
		if (usageRecorded) {
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
		}
		if (runtime.pendingQueueAction) {
			await dispatchPendingQueueActionIfSettled(ctx);
			return;
		}
		if (!usageRecorded) return;
		if (await limitActiveGoalForBudget(ctx, false)) return;
		if (generation !== runtime.menuGeneration) return;

		const wasPiRetry = isPiOwnedCompactionRetry(event, runtime.activeGoal.id);
		if (wasPiRetry) return;
		clearGoalRecoveryForGoal(runtime.activeGoal.id);
		if (shouldDeferContinuation(ctx)) return;
		requestContinuation(runtime.activeGoal);
		// Manual compaction's owned immediate retries once after Pi releases its
		// busy state; threshold compaction leaves the intent for agent_settled.
		await dispatchContinuationIfSettled(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") {
			if (
				consumeCancelledContinuationPrompt(event.text) ||
				consumeStaleOwnedGoalPrompt(event.text)
			) {
				return { action: "handled" as const };
			}
			if (runtime.queueFrozen) return;
			// Streaming input is queued before its model work starts. Keep owned
			// markers pending for message_start, and track non-goal delivery mode so a
			// steer cannot consume a later follow-up's cleanup protection.
			if (runtime.hasPendingOwnedGoalPrompt(event.text)) return;
			if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
				runtime.noteQueuedNonGoalInput(event.text, event.streamingBehavior);
			}
			clearGoalRecovery();
			return;
		}
		if (runtime.queueFrozen) return;
		if (/^\/goal(?:\s|$)/u.test(event.text.trimStart())) return;
		if (event.streamingBehavior === "followUp") {
			runtime.noteQueuedNonGoalInput(event.text, "followUp", true);
			return;
		}
		if (event.streamingBehavior === "steer") {
			runtime.noteQueuedNonGoalInput(event.text, "steer");
		}
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.resetActiveSafetyEpoch(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		const message = event.message as { role?: unknown; customType?: unknown; content?: unknown };
		if (
			message.role === "assistant" &&
			runtime.activeGoal?.status === "paused" &&
			runtime.guardAbortGoalId === runtime.activeGoal.id
		) {
			abortCurrentTurn(ctx);
			return;
		}
		if (message.role === "custom") {
			if (
				message.customType === GOAL_MAILBOX_TYPE ||
				message.customType === "agent-mailbox-trigger-v1"
			)
				return;
			if (runtime.isActiveBudgetWrapUpMessage(message)) return;
			if (runtime.guardAbortGoalId === runtime.activeGoal?.id) {
				runtime.guardAbortGoalId = undefined;
			}
			beginNonGoalFollowUp(ctx, false);
			return;
		}
		if (message.role !== "user") return;
		const prompt = Array.isArray(message.content)
			? message.content
					.filter(
						(part) => part && typeof part === "object" && Reflect.get(part, "type") === "text",
					)
					.map((part) => Reflect.get(part as object, "text"))
					.filter((text): text is string => typeof text === "string")
					.join("\n")
			: typeof message.content === "string"
				? message.content
				: "";
		// A prompt Pi queued while it was streaming never reaches before_agent_start, so its
		// message boundary is where that dispatch is finally proven started.
		confirmContinuationDispatch(prompt);
		const ownedPrompt = consumePendingGoalPrompt(prompt);
		const ownedPromptBoundary = runtime.hasOwnedPromptBoundary(prompt);
		const queuedNonGoalInput = runtime.consumeQueuedNonGoalInput(prompt, !ownedPromptBoundary);
		if (!ownedPrompt) {
			if (queuedNonGoalInput?.behavior === "followUp") {
				beginNonGoalFollowUp(ctx, queuedNonGoalInput.resetSafetyEpoch);
			}
			return;
		}
		if (runtime.activeGoal?.id !== ownedPrompt.goalId || runtime.activeGoal.status !== "active") {
			return;
		}
		if (runtime.agentRunGoalId !== undefined && runtime.agentRunGoalId !== ownedPrompt.goalId) {
			runtime.activeGoal.baselineTokens = Math.max(
				0,
				currentTokenTotal(ctx) - runtime.activeGoal.tokensUsed,
			);
		}
		runtime.beginAgentRun(ownedPrompt.goalId, "manual");
		if (ownedPrompt.resetSafetyEpoch) {
			runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
		}
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
	});

	pi.on("context", (event, ctx) => {
		const messages = event.messages.filter((message) => keepBudgetWrapUpMessage(message));
		if (
			runtime.activeGoal?.status === "paused" &&
			runtime.guardAbortGoalId === runtime.activeGoal.id
		) {
			// A current custom follow-up clears the guard at message_start. Otherwise,
			// context transformation aborts before the provider adapter receives the signal.
			abortCurrentTurn(ctx);
			if (messages.length !== event.messages.length) return { messages };
			return;
		}
		// D-007: a paused goal still gets woken by background work it started before the pause, and
		// that turn needs to know the goal is paused. It cannot be done from before_agent_start: this
		// Pi emits that event only from AgentSession.prompt(), so a producer that wakes Main with
		// sendMessage(..., { triggerTurn: true }) never reaches it. This transform runs for every
		// provider request on every path, and its result is request-scoped rather than persisted, so
		// the block rides along with the turn that actually sees the result and leaves no transcript
		// entry behind.
		if (
			runtime.activeGoal?.status === "paused" ||
			(runtime.activeGoal && runtime.mailboxState.cancelling)
		) {
			return {
				messages: [
					...messages,
					{
						role: "user" as const,
						content: [
							{ type: "text" as const, text: buildPausedGoalSystemPrompt(runtime.activeGoal) },
						],
						timestamp: Date.now(),
					},
				] as typeof event.messages,
			};
		}
		if (
			runtime.activeGoal?.status === "active" &&
			!runtime.queueFrozen &&
			runtime.agentRunGoalId === runtime.activeGoal.id
		) {
			const prompt = buildGoalSystemPrompt(runtime.activeGoal, (issue) => {
				if (issue === lastAppendIssue) return;
				lastAppendIssue = issue;
				if (!issue) return;
				if (ctx.hasUI) ctx.ui.notify(issue, "warning");
				// Headless modes have no notification channel; keep stdout/RPC output untouched.
				else process.stderr.write(`${issue}\n`);
			});
			return {
				messages: [
					...messages,
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: prompt }],
						timestamp: Date.now(),
					},
				] as typeof event.messages,
			};
		}
		if (messages.length !== event.messages.length) return { messages };
	});

	pi.on("tool_call", (event, ctx) => {
		runtime.markAgentToolAttempted();
		if (runtime.queueFrozen || runtime.mailboxState.cancelling || runtime.mailboxInvalid) {
			if (!isGoalToolName(event.toolName)) return;
			// Blocking alone feeds an error tool result back to the model. Abort too so
			// stale Goal calls cannot loop while the experimental queue remains frozen.
			abortCurrentTurn(ctx);
			return {
				block: true,
				reason:
					"The experimental goal queue is frozen. Re-enable experimental.goals and run /reload, or use /goal clear.",
			};
		}
		if (
			runtime.activeGoal?.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
			event.toolName !== "goal_complete"
		) {
			// A blocked tool result would normally trigger another model call. Abort the
			// wrap-up instead so a tool-seeking model cannot create an unbounded loop.
			abortCurrentTurn(ctx);
			return {
				block: true,
				reason: "Goal token budget is exhausted; only goal_complete is allowed during wrap-up.",
			};
		}
		if (!runtime.staleGoalToolCallsBlocked) return;
		if (!runtime.activeGoal || !blocksStaleGoalToolCalls(runtime.activeGoal.status)) {
			clearStaleGoalToolCallBlock();
			return;
		}
		// A blocked tool result would normally trigger another model call. Abort the
		// current turn so a tool-seeking model cannot create an unbounded loop that
		// burns provider quota while the goal is stopped.
		abortCurrentTurn(ctx);
		return {
			block: true,
			reason: "Blocked stale /goal tool call after the goal stopped or was interrupted.",
		};
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		if (runtime.queueFrozen) return;
		if (
			runtime.activeGoal?.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
			!runtime.budgetWrapUp.delivered
		) {
			await queueBudgetWrapUp(ctx, runtime.activeGoal);
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;

		// AgentSession persists assistant message_end before tool execution events,
		// so the completed assistant call's usage is authoritative at this boundary.
		if (!updateGoalUsage(runtime.activeGoal, ctx)) return;
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		if (await limitActiveGoalForBudget(ctx, true)) return;
		if (!goalToolsAvailable()) await pauseGoalForUnavailableTools(ctx);
	});

	async function beforeRun(
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
		start: MailboxRunStart,
	) {
		const admitted = mailbox.start(start);
		runtime.clearAgentRun();
		if (admitted?.kind === "budget")
			runtime.budgetWrapUp = { goalId: admitted.goalId, delivered: true };
		if (
			event.messageType === "custom" &&
			event.message.customType === "agent-mailbox-trigger-v1" &&
			!admitted
		) {
			runtime.beginAgentRun(null, undefined);
			return;
		}
		if (runtime.queueFrozen || runtime.mailboxState.cancelling || runtime.mailboxInvalid) return;
		// Pi-owned retries emit agent_start directly. Reaching a normal prompt
		// boundary means cleanup no longer owns the next run, so the hard-cap guard
		// must not abort it.
		if (runtime.guardAbortGoalId) runtime.guardAbortGoalId = undefined;
		const goalPrompt =
			event.messageType === "user" ? consumePendingGoalPrompt(event.prompt) : undefined;
		const goalPromptGoalId = goalPrompt?.goalId;
		const continuationGoalId =
			admitted && start.automatic
				? admitted.goalId
				: event.messageType === "user" && !goalPromptGoalId
					? markContinuationStarted(event.prompt)
					: undefined;
		// Pi reaches before_agent_start only after preflight, once the host will run this turn.
		// That is the acceptance the void dispatch call could not prove, so the owed background
		// promise is discharged here rather than at the send.
		if (event.messageType === "user" && continuationGoalId)
			confirmContinuationDispatch(event.prompt);
		const ownedPromptGoalId = goalPromptGoalId ?? continuationGoalId;
		// The queued reset belongs to the goal, not to the prompt carrying it.
		// consumePendingGoalPrompt above is destructive and six guards below
		// return before the resetSafetyEpoch branch at the end of this handler,
		// so a resume whose prompt lost the race to another owned prompt dropped
		// its reset with no way to replay it — only session_start honoured
		// safetyResetPending after that. Commit it here, on the same terms.
		if (runtime.activeGoal?.status === "active" && runtime.activeGoal.safetyResetPending) {
			runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
		}
		const ownedPromptBoundary =
			event.messageType === "user" && runtime.hasOwnedPromptBoundary(event.prompt);
		const activeBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
		const activeGoalRecovery = runtime.hasActiveGoalRecovery();
		const queuedNonGoalInput =
			event.messageType !== "user" || activeBudgetWrapUp
				? undefined
				: runtime.consumeQueuedNonGoalInput(
						event.prompt,
						!activeGoalRecovery && ownedPromptGoalId === undefined && !ownedPromptBoundary,
					);
		if (queuedNonGoalInput?.behavior === "followUp") {
			beginNonGoalFollowUp(ctx, queuedNonGoalInput.resetSafetyEpoch);
		}
		const runOrigin =
			continuationGoalId && (!admitted || admitted.kind === "continue")
				? "automatic"
				: activeGoalRecovery && runtime.goalRecovery?.automaticOwner
					? "automatic"
					: "manual";
		if (
			runtime.pendingQueueAction?.kind === "prioritize" &&
			!activeBudgetWrapUp &&
			!activeGoalRecovery
		) {
			// A turn that starts after priority intent is committed belongs to neither
			// the displaced goal nor the not-yet-activated urgent goal. Persist the
			// displaced goal's final accounting boundary so reload cannot absorb this run.
			if (!runtime.pendingQueueAction.displacedUsageFinalized) {
				if (runtime.activeGoal?.status === "active") {
					updateGoalUsage(runtime.activeGoal, ctx, false);
				}
				runtime.pendingQueueAction.displacedUsageFinalized = true;
				if (runtime.activeGoal) {
					persistGoal(runtime.activeGoal);
					updateStatus(ctx, runtime.activeGoal);
				}
			}
			runtime.beginAgentRun(null, undefined);
			if (ownedPromptGoalId) abortCurrentTurn(ctx);
			return;
		}
		if (activeBudgetWrapUp && runtime.activeGoal) {
			runtime.beginAgentRun(runtime.activeGoal.id, "manual");
			return;
		}
		if (
			runtime.pendingQueueAction?.kind === "advance" &&
			runtime.pendingQueueAction.goalId === runtime.activeGoal?.id
		) {
			runtime.beginAgentRun(ownedPromptGoalId ?? runtime.activeGoal.id, runOrigin);
			if (ownedPromptGoalId) abortCurrentTurn(ctx);
			return;
		}
		if (ownedPromptGoalId && ownedPromptGoalId !== runtime.activeGoal?.id) {
			runtime.beginAgentRun(ownedPromptGoalId, runOrigin);
			if (runtime.activeGoal?.status === "active" && !goalToolsAvailable()) {
				await pauseGoalForUnavailableTools(ctx, false);
			}
			abortCurrentTurn(ctx);
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;
		runtime.beginAgentRun(runtime.activeGoal.id, runOrigin);
		if (!goalToolsAvailable()) {
			await pauseGoalForUnavailableTools(ctx, ownedPromptGoalId !== undefined);
			return;
		}
		if (goalPrompt?.resetSafetyEpoch && goalPromptGoalId === runtime.activeGoal.id) {
			runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
		}
	}

	pi.on("agent_start", (_event, _ctx) => {
		if (runtime.queueFrozen) return;
		const activeGoal = runtime.activeGoal;
		if (
			activeGoal &&
			runtime.guardAbortGoalId === activeGoal.id &&
			activeGoal.status === "paused"
		) {
			if (runtime.consumeQueuedNonGoalFollowUpForAgentStart()) {
				runtime.guardAbortGoalId = undefined;
				clearStaleGoalToolCallBlock();
				runtime.beginAgentRun(null, undefined);
			}
			// Unknown runs defer cleanup until their message/context boundary: custom
			// follow-ups have no input event, while bare recovery is aborted pre-provider.
			return;
		}
		runtime.beginRecoveryRunIfNeeded();
	});

	pi.on("turn_end", async (event, ctx) => {
		if (runtime.queueFrozen) return;
		await recordAutomaticTurn(ctx, event.message);
	});

	async function afterRun(event: AgentEndEvent, ctx: ExtensionContext) {
		const run = runtime.finishAgentRun();
		if (runtime.queueFrozen || run.goalId === null) return;
		if (!runtime.canRecordGoalUsage() && !runtime.hasActiveBudgetWrapUp()) return;
		if (run.goalId && run.goalId !== runtime.activeGoal?.id) return;
		if (!runtime.activeGoal) return;
		if (
			runtime.activeGoal.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id
		) {
			updateGoalUsage(runtime.activeGoal, ctx);
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
			clearBudgetWrapUp();
			return;
		}
		if (runtime.activeGoal.status !== "active") return;
		if (
			runtime.pendingQueueAction?.kind === "advance" &&
			runtime.pendingQueueAction.goalId === runtime.activeGoal.id
		) {
			updateGoalUsage(runtime.activeGoal, ctx);
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
			return;
		}

		const goalId = runtime.activeGoal.id;
		const generation = runtime.menuGeneration;
		const isCurrent = () =>
			generation === runtime.menuGeneration && runtime.activeGoal?.id === goalId;
		const alreadyAwaitingContinuation = hasContinuationWorkForGoal(goalId);
		const finalAssistant = findFinalAssistantMessage(event.messages);
		const waitingForExternalEvent =
			finalAssistant?.stopReason !== "aborted" &&
			finalAssistant?.stopReason !== "error" &&
			shouldDeferContinuation(ctx);

		if (!alreadyAwaitingContinuation && !waitingForExternalEvent) {
			runtime.activeGoal = incrementGoal(runtime.activeGoal);
		}
		updateGoalUsage(runtime.activeGoal, ctx);

		if (finalAssistant?.stopReason === "aborted") {
			clearGoalRecoveryForGoal(goalId);
			await stopGoalAfterAgentEnd(ctx, runtime.activeGoal, finalAssistant, "paused");
			return;
		}

		if (finalAssistant?.stopReason === "error") {
			if (isRetryableGoalInterruption(finalAssistant)) {
				if (run.origin === "automatic" && (await enforceAutomaticTurnLimit(ctx, true))) return;
				if (!isCurrent()) return;
				if (await limitActiveGoalForBudget(ctx, false)) return;
				if (!isCurrent()) return;
				if (!goalToolsAvailable()) {
					await pauseGoalForUnavailableTools(ctx);
					return;
				}
				runtime.goalRecovery = {
					goalId,
					kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
					automaticOwner: run.origin === "automatic",
					errorMessage: finalAssistant.errorMessage,
				};
				cancelContinuationWork();
				persistGoal(runtime.activeGoal);
				updateStatus(ctx, runtime.activeGoal);
				return;
			}
			clearGoalRecoveryForGoal(goalId);
			await stopGoalAfterAgentEnd(
				ctx,
				runtime.activeGoal,
				finalAssistant,
				isUsageLimitedGoalInterruption(finalAssistant) ? "usage_limited" : "blocked",
			);
			return;
		}

		clearGoalRecoveryForGoal(goalId);

		if (await limitActiveGoalForBudget(ctx, true)) return;
		if (!isCurrent()) return;
		if (!goalToolsAvailable()) {
			await pauseGoalForUnavailableTools(ctx);
			return;
		}
		if (
			run.origin === "automatic" &&
			(await recordAutomaticRunProgress(
				ctx,
				goalId,
				event.messages,
				run.toolAttempted || hasAssistantToolCall(event.messages),
			))
		) {
			return;
		}

		if (!isCurrent() || !runtime.activeGoal) return;
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);

		if (waitingForExternalEvent) {
			scheduleProcessWaitCheckInIfNeeded(ctx);
			return;
		}
		runtime.clearProcessWaitCheckInTimer();
		const currentGoal = runtime.activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		if (runtime.pendingQueueAction?.kind === "prioritize") return;
		requestContinuation(currentGoal);
	}

	async function settled(event: AgentSettledEvent, ctx: ExtensionContext) {
		const generation = runtime.menuGeneration;
		if (!runtime.mailboxState.cancelling) await mailbox.restore(ctx);
		if (generation !== runtime.menuGeneration) return;
		const restoredOwedContinuation = restoreOwedContinuationAtSettled;
		restoreOwedContinuationAtSettled = false;
		if (runtime.queueFrozen) {
			runtime.clearSettledSafetyTracking();
			runtime.queueFreezeAwaitingSettle = false;
			if (runtime.settings.experimental.goals) {
				await commands.resumeQueueAfterUnfreeze(ctx);
			}
			return;
		}
		// Escape can abort before an assistant message exists. The settled event is
		// authoritative in that case; never let an idle continuation undo the abort.
		if (event.aborted && runtime.activeGoal?.status === "active" && runtime.canRecordGoalUsage()) {
			if (runtime.needsMailboxCancellation() && !(await runtime.cancelGoalMail(ctx))) return;
			cancelContinuationWork();
			clearBudgetWrapUp();
			clearGoalRecovery();
			blockStaleGoalToolCalls();
			runtime.activeGoal = transitionGoal(runtime.activeGoal, "paused");
			runtime.setTerminalReason(runtime.activeGoal.id, "goal paused after agent interruption");
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
			ctx.ui.notify("Goal paused after interruption. Run /goal resume to continue.", "warning");
		}
		await runtime.finalizeSettledRecovery(ctx);
		if (generation !== runtime.menuGeneration) return;
		let dispatchedQueueAction = false;
		if (runtime.pendingQueueAction) {
			dispatchedQueueAction = await dispatchPendingQueueActionIfSettled(ctx);
			if (generation !== runtime.menuGeneration) return;
		}
		if (!dispatchedQueueAction) {
			// Rebuild a tree-restored durable marker before checking unrelated producer
			// leases. This makes its intent completion-driven, so that lease cannot defer
			// the completion it already owes.
			const restoredOwedDispatched = restoredOwedContinuation
				? await restoreOwedBackgroundContinuation(ctx)
				: false;
			if (generation !== runtime.menuGeneration) return;
			// A background result recorded while Main was busy owns this boundary. An unrelated
			// lease still running is a different wait; letting it cancel the intent here means
			// the finished work is never handled until that other work also finishes (D-008 ①).
			if (shouldDeferContinuation(ctx) && !runtime.hasCompletionDrivenContinuationWork()) {
				cancelContinuationWork();
				scheduleProcessWaitCheckInIfNeeded(ctx);
			} else {
				runtime.clearProcessWaitCheckInTimer();
				// The restored marker may have just dispatched a delivery. Do not treat that
				// new delivery as unconfirmed at this same settled boundary; the next real
				// boundary must still retry it if Pi never accepted the prompt.

				if (
					!restoredOwedDispatched &&
					!(await dispatchContinuationIfSettled(ctx)) &&
					shouldDeferContinuation(ctx)
				) {
					scheduleProcessWaitCheckInIfNeeded(ctx);
				}
			}
		}
		if (generation !== runtime.menuGeneration) return;
		runtime.clearSettledSafetyTracking();
	}

	function beginNonGoalFollowUp(ctx: StatusContext, resetSafetyEpoch: boolean) {
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		if (resetSafetyEpoch) clearBudgetWrapUp();
		const activeGoalId =
			runtime.activeGoal?.status === "active" ? runtime.activeGoal.id : undefined;
		runtime.beginAgentRun(activeGoalId ?? null, activeGoalId ? "manual" : undefined);
		if (resetSafetyEpoch && activeGoalId) runtime.resetActiveSafetyEpoch(ctx);
	}

	function hasPendingSkipForGoal(goalId: string) {
		return (
			runtime.pendingQueueAction?.kind === "advance" &&
			runtime.pendingQueueAction.reason === "skip" &&
			runtime.pendingQueueAction.goalId === goalId
		);
	}

	async function stopGoalAfterAgentEnd(
		ctx: StatusContext,
		goal: ActiveGoal,
		assistant: AssistantMessageLike,
		status: "paused" | "blocked" | "usage_limited",
	) {
		if (runtime.needsMailboxCancellation() && !(await runtime.cancelGoalMail(ctx))) return;
		cancelContinuationWork();
		clearBudgetWrapUp();
		blockStaleGoalToolCalls();
		abortCurrentTurn(ctx);
		runtime.activeGoal = transitionGoal(goal, status);
		runtime.setTerminalReason(
			runtime.activeGoal.id,
			assistant.errorMessage ?? `goal ${status} after agent interruption`,
		);
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);

		const details = assistant.errorMessage
			? ` (${truncateNotification(assistant.errorMessage)})`
			: "";
		if (status === "paused") {
			ctx.ui.notify(
				`Goal paused after interruption${details}. Run /goal resume to continue.`,
				"warning",
			);
			return;
		}
		if (status === "usage_limited") {
			ctx.ui.notify(
				`Goal stopped after provider usage limit${details}. Run /goal resume when usage is available.`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`Goal blocked after agent error${details}. Resolve the blocker or run /goal resume to retry.`,
			"warning",
		);
	}
}

export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
	registerGoalRuntime(pi, options);
}

export {
	assistantUsageTokens,
	cumulativeAssistantTokens,
	formatDuration,
	formatTokenCount,
} from "./accounting.js";

export {
	completeGoalArguments,
	parseCommand,
	parseTokenBudget,
	validateObjective,
} from "./command.js";

export { buildGoalSystemPrompt, buildPausedGoalSystemPrompt } from "./prompts.js";

export {
	findFinalAssistantMessage,
	formatStatus,
	isContradictoryCompletionSummary,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
} from "./runtime.js";

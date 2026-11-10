import { checkpointGoalActiveTime, currentTokenTotal } from "./accounting.js";
import { validateObjective } from "./command.js";
import { safeGoalMenuText } from "./menu.js";
import type { ActiveGoal } from "./persistence.js";
import { buildGoalPrompt, buildObjectiveUpdatedPrompt, buildResumePrompt } from "./prompts.js";
import {
	activateQueuedGoal,
	appendGoal,
	createQueuedGoal,
	dropLastGoal as dropLastQueuedGoal,
	goalQueueIdentity,
	prioritizeGoal as prioritizeQueuedGoal,
	skipGoal as skipQueuedGoal,
} from "./queue.js";
import {
	abortCurrentTurn,
	blocksStaleGoalToolCalls,
	createGoal,
	editedGoalStatus,
	formatBudget,
	formatError,
	type GoalRuntime,
	goalSummary,
	hasPendingMessages,
	isResumableGoalStatus,
	nextGoalInstance,
	queueGoalSafetyReset,
	STATUS_KEY,
	type StatusContext,
	stoppedStatusLabel,
	transitionGoal,
} from "./runtime.js";

// User-command mutations are kept separate from Pi event wiring. Every controller
// receives exactly one per-factory GoalRuntime, preserving session isolation.
export class GoalCommandController {
	private readonly runtime: GoalRuntime;

	constructor(runtime: GoalRuntime) {
		this.runtime = runtime;
	}

	async startGoal(
		objective: string,
		tokenBudget: number | undefined,
		ctx: StatusContext,
		onActivated?: (goal: ActiveGoal) => void,
		isActivationCurrent?: (goal: ActiveGoal) => boolean,
	) {
		const generation = this.runtime.menuGeneration;
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}

		const existingGoal =
			this.runtime.activeGoal?.status !== "complete" ? this.runtime.activeGoal : undefined;
		const existingQueuedGoals = [...this.runtime.queuedGoals];
		const existingQueueIdentity = goalQueueIdentity(
			this.runtime.activeGoal,
			this.runtime.queuedGoals,
			this.runtime.pendingQueueAction,
		);
		if (existingGoal) {
			const queuedRemovalPreview =
				existingQueuedGoals.length > 0
					? `\n\nQueued goals also removed:\n${existingQueuedGoals
							.map((goal, index) => `${index + 1}. ${safeGoalMenuText(goal.text, 4_000)}`)
							.join("\n")}`
					: "";
			const shouldReplace = await ctx.ui.confirm(
				"Replace goal?",
				`Current goal: ${safeGoalMenuText(existingGoal.text, 4_000)}${queuedRemovalPreview}\n\nNew goal: ${safeGoalMenuText(objective, 4_000)}`,
			);
			if (generation !== this.runtime.menuGeneration) return false;
			if (!shouldReplace) {
				ctx.ui.notify(`Goal kept: ${existingGoal.text}`, "info");
				return;
			}
			if (
				goalQueueIdentity(
					this.runtime.activeGoal,
					this.runtime.queuedGoals,
					this.runtime.pendingQueueAction,
				) !== existingQueueIdentity
			) {
				ctx.ui.notify("The goal queue changed while confirmation was open. Try again.", "warning");
				return;
			}
		}

		// Unlock lazy visibility only for a real activation. In always mode, a
		// missing tool means another policy or allowlist intentionally removed it.
		const goalToolVisibilityBeforeActivation = this.runtime.snapshotGoalToolVisibility();
		try {
			this.runtime.prepareGoalToolsForActivation(ctx);
		} catch (error) {
			ctx.ui.notify(`Cannot start /goal: ${formatError(error)}`, "error");
			if (existingGoal?.status === "active") await this.runtime.pauseGoalForUnavailableTools(ctx);
			return;
		}

		if (this.runtime.needsMailboxCancellation() && !(await this.runtime.cancelGoalMail(ctx)))
			return false;
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		this.runtime.queuedGoals = [];
		this.runtime.pendingQueueAction = undefined;
		this.runtime.activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
		const startedGoal = this.runtime.activeGoal;
		onActivated?.(startedGoal);
		this.runtime.persistGoal(startedGoal);
		if (
			this.runtime.activeGoal?.id !== startedGoal.id ||
			this.runtime.activeGoal.status !== "active" ||
			this.runtime.mailboxState.cancelling
		) {
			return;
		}
		this.runtime.updateStatus(ctx, startedGoal);
		const sent = await this.runtime.sendOwnedGoalPrompt(
			ctx,
			startedGoal.id,
			buildGoalPrompt(startedGoal),
			true,
			() => isActivationCurrent?.(startedGoal) ?? true,
		);
		if (generation !== this.runtime.menuGeneration) return false;
		if (isActivationCurrent && !isActivationCurrent(startedGoal)) return;
		if (generation !== this.runtime.menuGeneration) return false;
		if (!sent) {
			let rolledBackStartedGoal = false;
			if (this.runtime.activeGoal?.id === startedGoal.id) {
				rolledBackStartedGoal = true;
				if (existingGoal) {
					this.runtime.queuedGoals = existingQueuedGoals;
					this.runtime.recordGoalUsage(existingGoal, ctx);
					if (existingGoal.status === "active") {
						abortCurrentTurn(ctx);
						this.runtime.activeGoal = transitionGoal(existingGoal, "paused");
						this.runtime.blockStaleGoalToolCalls();
					} else {
						this.runtime.activeGoal = existingGoal;
						if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
							this.runtime.blockStaleGoalToolCalls();
						} else {
							this.runtime.clearStaleGoalToolCallBlock();
						}
					}
					this.runtime.persistGoal(this.runtime.activeGoal);
					this.runtime.updateStatus(ctx, this.runtime.activeGoal);
				} else {
					await this.runtime.clearActiveGoal(ctx);
				}
			}
			if (rolledBackStartedGoal) {
				this.runtime.restoreGoalToolVisibility(goalToolVisibilityBeforeActivation);
			}
			return;
		}
		if (
			this.runtime.activeGoal?.id !== startedGoal.id ||
			this.runtime.activeGoal.status !== "active"
		) {
			return;
		}
		const automaticLimit = this.runtime.settings.continuationLimits.automaticTurns;
		ctx.ui.notify(
			`${existingGoal ? "Goal replaced" : "Goal started"}: ${objective}. ${
				automaticLimit === null
					? "Automatic work is Unlimited; tool loops may consume substantial tokens and provider cost. Open /goal to monitor."
					: `Automatic work pauses after ${automaticLimit} responses; open /goal to monitor progress.`
			}`,
			automaticLimit === null ? "warning" : "info",
		);
	}

	async addGoal(objective: string, tokenBudget: number | undefined, ctx: StatusContext) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		if (!this.runtime.activeGoal) {
			await this.startGoal(objective, tokenBudget, ctx);
			return;
		}
		this.runtime.queuedGoals = appendGoal(
			this.runtime.queuedGoals,
			createQueuedGoal(objective, tokenBudget),
		);
		this.runtime.persistGoal(this.runtime.activeGoal);
		ctx.ui.notify(
			`Goal added at position ${this.runtime.queuedGoals.length + 1}: ${objective}`,
			"info",
		);
	}

	async prioritizeGoal(objective: string, tokenBudget: number | undefined, ctx: StatusContext) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		if (!this.runtime.activeGoal) {
			await this.startGoal(objective, tokenBudget, ctx);
			return;
		}
		if (this.runtime.needsMailboxCancellation() && !(await this.runtime.cancelGoalMail(ctx)))
			return false;
		this.runtime.cancelContinuationWork();
		this.runtime.pendingQueueAction = { kind: "prioritize", objective, tokenBudget };
		this.runtime.persistGoal(this.runtime.activeGoal);
		if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) {
			ctx.ui.notify(`Priority goal queued until Pi settles: ${objective}`, "info");
			return;
		}
		await this.dispatchPendingQueueActionIfSettled(ctx);
	}

	async dropLastGoal(ctx: StatusContext) {
		const currentGoal = this.runtime.activeGoal;
		if (!currentGoal) {
			ctx.ui.notify("No goals to drop.", "info");
			return false;
		}
		const result = dropLastQueuedGoal(currentGoal, this.runtime.queuedGoals);
		if (!result.goal) {
			if (!(await this.runtime.clearActiveGoal(ctx))) return false;
			ctx.ui.notify(`Goal dropped: ${result.removed?.text ?? currentGoal.text}`, "warning");
			return true;
		}
		this.runtime.queuedGoals = result.queue;
		this.runtime.persistGoal(result.goal);
		ctx.ui.notify(`Goal dropped: ${result.removed?.text ?? "unknown goal"}`, "warning");
		return true;
	}

	async skipGoal(ctx: StatusContext) {
		const currentGoal = this.runtime.activeGoal;
		if (!currentGoal) {
			ctx.ui.notify("No goals to skip.", "info");
			return false;
		}
		if (this.runtime.queuedGoals.length === 0) {
			if (!(await this.runtime.clearActiveGoal(ctx))) return false;
			ctx.ui.notify(`Goal skipped: ${currentGoal.text}. No goals remain.`, "warning");
			return true;
		}
		if (currentGoal.status === "active") this.runtime.recordGoalUsage(currentGoal, ctx);
		if (this.runtime.needsMailboxCancellation() && !(await this.runtime.cancelGoalMail(ctx)))
			return false;
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		this.runtime.pendingQueueAction = {
			kind: "advance",
			goalId: currentGoal.id,
			reason: "skip",
			completedText: currentGoal.text,
		};
		this.runtime.persistGoal(currentGoal);
		ctx.ui.notify(`Goal skip queued until Pi settles: ${currentGoal.text}`, "info");
		if (ctx.isIdle?.() === true && !hasPendingMessages(ctx)) {
			await this.dispatchPendingQueueActionIfSettled(ctx);
		}
		return true;
	}

	async resumeQueueAfterUnfreeze(ctx: StatusContext) {
		if (this.runtime.queueFreezeAwaitingSettle) return false;
		this.runtime.queueFrozen = false;
		this.runtime.queueFreezeAwaitingSettle = false;
		this.runtime.guardAbortGoalId = undefined;
		this.runtime.clearStaleGoalToolCallBlock();
		if (this.runtime.activeGoal) {
			if (
				this.runtime.activeGoal.status === "active" &&
				this.runtime.activeGoal.activeStartedAt === undefined
			) {
				const now = Date.now();
				checkpointGoalActiveTime(this.runtime.activeGoal, now, true);
				this.runtime.activeGoal.updatedAt = now;
			}
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		if (this.runtime.pendingQueueAction) {
			return this.dispatchPendingQueueActionIfSettled(ctx);
		}
		const goal = this.runtime.activeGoal;
		if (goal?.status !== "active") return false;
		this.runtime.requestContinuation(goal);
		return await this.runtime.dispatchContinuationIfSettled(ctx);
	}

	async dispatchPendingQueueActionIfSettled(ctx: StatusContext) {
		const generation = this.runtime.menuGeneration;
		const pending = this.runtime.pendingQueueAction;
		if (!pending || this.runtime.queueFrozen) return false;
		if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;
		if (pending.kind === "prioritize") {
			return this.activatePrioritizedGoal(
				pending.objective,
				pending.tokenBudget,
				ctx,
				pending.displacedUsageFinalized === true,
			);
		}
		if (
			!this.runtime.activeGoal ||
			this.runtime.activeGoal.id !== pending.goalId ||
			(this.runtime.activeGoal.status !== "complete" && pending.reason === "complete")
		) {
			this.runtime.pendingQueueAction = undefined;
			if (this.runtime.activeGoal) this.runtime.persistGoal(this.runtime.activeGoal);
			return false;
		}

		const previousText = pending.completedText;
		const reason = pending.reason;
		const goalId = this.runtime.activeGoal.id;
		if (this.runtime.needsMailboxCancellation() && !(await this.runtime.cancelGoalMail(ctx)))
			return false;
		if (
			generation !== this.runtime.menuGeneration ||
			this.runtime.activeGoal?.id !== goalId ||
			this.runtime.pendingQueueAction !== pending
		)
			return false;
		this.runtime.pendingQueueAction = undefined;
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		const next = skipQueuedGoal(this.runtime.queuedGoals);
		this.runtime.queuedGoals = next.queue;
		this.runtime.activeGoal = next.goal
			? activateQueuedGoal(next.goal, currentTokenTotal(ctx))
			: undefined;
		if (!this.runtime.activeGoal) {
			await this.runtime.clearActiveGoal(ctx);
			ctx.ui.notify(
				reason === "complete"
					? `Goal complete: ${previousText}. No goals remain.`
					: `Goal skipped: ${previousText}. No goals remain.`,
				"info",
			);
			return true;
		}

		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		if (this.runtime.activeGoal.status !== "active") {
			if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
				this.runtime.blockStaleGoalToolCalls();
			}
			ctx.ui.notify(
				`${reason === "complete" ? "Goal complete" : "Goal skipped"}: ${previousText}. Next goal remains ${this.runtime.activeGoal.status}: ${this.runtime.activeGoal.text}`,
				"info",
			);
			return true;
		}

		try {
			this.runtime.prepareGoalToolsForActivation(ctx);
		} catch (error) {
			this.runtime.activeGoal = transitionGoal(this.runtime.activeGoal, "paused");
			this.runtime.blockStaleGoalToolCalls();
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
			ctx.ui.notify(`Cannot start the next /goal: ${formatError(error)}`, "error");
			return false;
		}
		const activatedGoal = this.runtime.activeGoal;
		const sent = await this.runtime.sendAutomaticGoalPrompt(
			ctx,
			activatedGoal.id,
			buildGoalPrompt(activatedGoal),
		);
		if (generation !== this.runtime.menuGeneration) return false;
		if (!sent && this.runtime.activeGoal?.id === activatedGoal.id) {
			this.runtime.activeGoal = transitionGoal(activatedGoal, "paused");
			this.runtime.blockStaleGoalToolCalls();
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
			ctx.ui.notify(
				`Next goal paused after prompt delivery failed: ${activatedGoal.text}`,
				"warning",
			);
			return false;
		}
		ctx.ui.notify(
			`${reason === "complete" ? "Goal complete" : "Goal skipped"}: ${previousText}. Started next goal: ${activatedGoal.text}`,
			"info",
		);
		return true;
	}

	notifyFrozenQueue(ctx: StatusContext) {
		ctx.ui.notify(
			"The experimental goal queue is frozen. Re-enable experimental.goals in pi-goal.json and run /reload, or use /goal clear.",
			"warning",
		);
	}

	async pauseGoal(ctx: StatusContext) {
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			return;
		}
		if (this.runtime.activeGoal.status !== "active") {
			ctx.ui.notify(
				`Goal is ${this.runtime.activeGoal.status}; only active goals can be paused.`,
				"warning",
			);
			return;
		}
		this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
		if (this.runtime.needsMailboxCancellation() && !(await this.runtime.cancelGoalMail(ctx)))
			return false;
		this.runtime.cancelContinuationWork();
		// Same reason as the safety pause: a heartbeat left armed across a pause
		// fires the instant /goal resume restores "active" and races the resume's
		// own prompt for the run boundary that commits the safety reset.
		this.runtime.clearProcessWaitCheckInTimer();
		this.runtime.clearBudgetWrapUp();
		this.runtime.blockStaleGoalToolCalls();
		abortCurrentTurn(ctx);
		this.runtime.activeGoal = transitionGoal(this.runtime.activeGoal, "paused");
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		ctx.ui.notify(`Goal paused: ${this.runtime.activeGoal.text}`, "info");
	}

	async resumeGoal(ctx: StatusContext) {
		const generation = this.runtime.menuGeneration;
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			return;
		}
		if (!isResumableGoalStatus(this.runtime.activeGoal.status)) {
			ctx.ui.notify(
				`Goal is ${this.runtime.activeGoal.status}; only paused, blocked, usage-limited, or budget-limited goals can be resumed.`,
				"warning",
			);
			return;
		}
		if (
			this.runtime.activeGoal.tokenBudget !== undefined &&
			this.runtime.activeGoal.tokensUsed >= this.runtime.activeGoal.tokenBudget
		) {
			ctx.ui.notify(
				`Goal token budget is still reached: ${formatBudget(this.runtime.activeGoal)}`,
				"warning",
			);
			return;
		}
		const goalToolVisibilityBeforeActivation = this.runtime.snapshotGoalToolVisibility();
		try {
			this.runtime.prepareGoalToolsForActivation(ctx);
		} catch (error) {
			ctx.ui.notify(`Cannot resume /goal: ${formatError(error)}`, "error");
			return;
		}
		const stoppedGoal = this.runtime.activeGoal;
		const stoppedStatus = stoppedGoal.status;
		if (this.runtime.needsMailboxCancellation() && !(await this.runtime.cancelGoalMail(ctx)))
			return false;
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		this.runtime.activeGoal = queueGoalSafetyReset(
			transitionGoal(nextGoalInstance(this.runtime.activeGoal), "active"),
		);
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		if (this.runtime.activeGoal.status !== "active") {
			ctx.ui.notify(
				`Goal token budget is still reached: ${formatBudget(this.runtime.activeGoal)}`,
				"warning",
			);
			return;
		}
		const resumedGoal = this.runtime.activeGoal;
		const sent = await this.runtime.sendOwnedGoalPrompt(
			ctx,
			resumedGoal.id,
			buildResumePrompt(resumedGoal, stoppedStatus),
		);
		if (generation !== this.runtime.menuGeneration) return false;
		if (!sent) {
			if (
				this.runtime.activeGoal?.id === resumedGoal.id &&
				this.runtime.activeGoal.status === "active"
			) {
				this.runtime.activeGoal = stoppedGoal;
				this.runtime.persistGoal(this.runtime.activeGoal);
				this.runtime.updateStatus(ctx, this.runtime.activeGoal);
				if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
					this.runtime.blockStaleGoalToolCalls();
				}
				this.runtime.restoreGoalToolVisibility(goalToolVisibilityBeforeActivation);
			}
			return;
		}
		const automaticLimit = this.runtime.settings.continuationLimits.automaticTurns;
		ctx.ui.notify(
			`Goal resumed from ${stoppedStatusLabel(stoppedStatus)}: ${resumedGoal.text}. ${
				automaticLimit === null
					? "Automatic work remains Unlimited; goal progress and cumulative usage are preserved."
					: `The automatic-work counter will reset to 0 of ${automaticLimit} when the resumed prompt starts; goal progress and cumulative usage are preserved.`
			}`,
			automaticLimit === null ? "warning" : "info",
		);
	}

	async clearGoal(ctx: StatusContext) {
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			if (this.runtime.needsMailboxCancellation() && !(await this.runtime.cancelGoalMail(ctx)))
				return false;
			this.runtime.cancelContinuationWork();
			this.runtime.clearGoalRecovery();
			this.runtime.clearBudgetWrapUp();
			this.runtime.clearStaleGoalToolCallBlock();
			this.runtime.clearPersistedGoal(ctx.cwd);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return true;
		}

		const stoppedGoal = this.runtime.activeGoal.text;
		if (!(await this.runtime.clearActiveGoal(ctx))) return false;
		ctx.ui.notify(`Goal cleared: ${stoppedGoal}`, "warning");
		return true;
	}

	async editGoal(objective: string, tokenBudget: number | undefined, ctx: StatusContext) {
		const generation = this.runtime.menuGeneration;
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		if (!this.runtime.activeGoal) {
			ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "warning");
			return;
		}

		this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
		const previousGoal = { ...this.runtime.activeGoal };
		if (this.runtime.needsMailboxCancellation() && !(await this.runtime.cancelGoalMail(ctx)))
			return false;
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		const previousStatus = this.runtime.activeGoal.status;
		const rotatedGoal = nextGoalInstance(this.runtime.activeGoal);
		const transitionedGoal = transitionGoal(
			{
				...rotatedGoal,
				text: objective,
				tokenBudget: tokenBudget ?? this.runtime.activeGoal.tokenBudget,
			},
			editedGoalStatus(previousStatus),
		);
		const nextGoal =
			transitionedGoal.status === "active"
				? queueGoalSafetyReset(transitionedGoal)
				: transitionedGoal;
		const goalToolVisibilityBeforeActivation =
			nextGoal.status === "active" ? this.runtime.snapshotGoalToolVisibility() : undefined;
		if (nextGoal.status === "active") {
			try {
				this.runtime.prepareGoalToolsForActivation(ctx);
			} catch (error) {
				ctx.ui.notify(`Cannot reactivate /goal: ${formatError(error)}`, "error");
				if (this.runtime.activeGoal?.status === "active") {
					await this.runtime.pauseGoalForUnavailableTools(ctx);
				}
				return;
			}
		}
		this.runtime.activeGoal = nextGoal;
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		const editedGoal = this.runtime.activeGoal;
		if (!editedGoal) return;
		if (editedGoal.status === "active") {
			this.runtime.clearStaleGoalToolCallBlock();
			const sent = await this.runtime.sendOwnedGoalPrompt(
				ctx,
				editedGoal.id,
				buildObjectiveUpdatedPrompt(editedGoal),
			);
			if (generation !== this.runtime.menuGeneration) return false;
			if (!sent) {
				if (this.runtime.activeGoal?.id === editedGoal.id) {
					if (previousStatus === "active") {
						abortCurrentTurn(ctx);
						this.runtime.activeGoal = transitionGoal(previousGoal, "paused");
						this.runtime.blockStaleGoalToolCalls();
					} else {
						this.runtime.activeGoal = previousGoal;
						if (blocksStaleGoalToolCalls(this.runtime.activeGoal.status)) {
							this.runtime.blockStaleGoalToolCalls();
						} else {
							this.runtime.clearStaleGoalToolCallBlock();
						}
					}
					this.runtime.persistGoal(this.runtime.activeGoal);
					this.runtime.updateStatus(ctx, this.runtime.activeGoal);
					if (goalToolVisibilityBeforeActivation) {
						this.runtime.restoreGoalToolVisibility(goalToolVisibilityBeforeActivation);
					}
				}
				return;
			}
		} else if (blocksStaleGoalToolCalls(editedGoal.status)) {
			this.runtime.blockStaleGoalToolCalls();
		} else {
			this.runtime.clearStaleGoalToolCallBlock();
		}
		ctx.ui.notify(`Goal updated: ${objective}`, "info");
	}

	/**
	 * Settle the goal's accounting and return what `/goal status` should show.
	 *
	 * Separate from `showGoal` because the reading has two destinations now: a
	 * notification in the modes that have nowhere else to put it, and the card
	 * `goal.ts` opens in the TUI. The checkpoint belongs to reading the status,
	 * not to how it is drawn, so it happens here either way.
	 */
	goalStatusReport(ctx: StatusContext): string {
		if (!this.runtime.activeGoal) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return "Usage: /goal <objective>\nNo goal is currently set.";
		}
		if (!this.runtime.queueFrozen) {
			this.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		}
		return goalSummary(
			this.runtime.activeGoal,
			this.runtime.queuedGoals,
			this.runtime.settings.experimental.goals,
			this.runtime.queueFrozen,
			this.runtime.pendingQueueAction,
			this.runtime.settings.continuationLimits.automaticTurns,
		);
	}

	showGoal(ctx: StatusContext) {
		this.reportGoalStatus(ctx, this.goalStatusReport(ctx));
	}

	private reportGoalStatus(ctx: StatusContext, message: string) {
		if (ctx.mode === "print" || ctx.mode === "json") {
			throw new Error(
				`/goal status is unavailable in ${ctx.mode} mode because Pi does not expose an extension-command output channel. Use TUI or RPC mode.`,
			);
		}
		ctx.ui.notify(message, "info");
	}

	private async activatePrioritizedGoal(
		objective: string,
		tokenBudget: number | undefined,
		ctx: StatusContext,
		displacedUsageFinalized = false,
	) {
		const generation = this.runtime.menuGeneration;
		const currentGoal = this.runtime.activeGoal;
		const pending = this.runtime.pendingQueueAction;
		if (!currentGoal) {
			await this.startGoal(objective, tokenBudget, ctx);
			return true;
		}
		if (currentGoal.status === "active" && !displacedUsageFinalized) {
			this.runtime.recordGoalUsage(currentGoal, ctx);
		}
		const previousGoal = { ...currentGoal };
		const previousQueue = [...this.runtime.queuedGoals];
		const visibilityBeforeActivation = this.runtime.snapshotGoalToolVisibility();
		try {
			this.runtime.prepareGoalToolsForActivation(ctx);
		} catch (error) {
			ctx.ui.notify(`Cannot prioritize /goal: ${formatError(error)}`, "error");
			if (currentGoal.status === "complete") {
				// Completion already committed, so retain the priority intent for a
				// later /reload after the tool policy is restored.
				this.runtime.persistGoal(currentGoal);
			} else {
				// Roll back an activation that never started. An active displaced goal
				// cannot continue safely without its terminal tools, so make it resumable.
				if (currentGoal.status === "active") {
					if (
						!(await this.runtime.pauseGoalForUnavailableTools(ctx, true, !displacedUsageFinalized))
					)
						return false;
				} else if (
					this.runtime.needsMailboxCancellation() &&
					!(await this.runtime.cancelGoalMail(ctx))
				) {
					return false;
				}
				if (
					generation !== this.runtime.menuGeneration ||
					this.runtime.activeGoal?.id !== currentGoal.id ||
					this.runtime.pendingQueueAction !== pending
				)
					return false;
				this.runtime.pendingQueueAction = undefined;
				this.runtime.persistGoal(this.runtime.activeGoal);
			}
			return false;
		}

		if (this.runtime.needsMailboxCancellation() && !(await this.runtime.cancelGoalMail(ctx)))
			return false;
		if (
			generation !== this.runtime.menuGeneration ||
			this.runtime.activeGoal?.id !== currentGoal.id ||
			this.runtime.pendingQueueAction !== pending
		)
			return false;
		this.runtime.cancelContinuationWork();
		this.runtime.clearGoalRecovery();
		this.runtime.clearBudgetWrapUp();
		this.runtime.clearStaleGoalToolCallBlock();
		const prioritized = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
		const next =
			currentGoal.status === "complete"
				? { goal: prioritized, queue: [...this.runtime.queuedGoals] }
				: prioritizeQueuedGoal(currentGoal, this.runtime.queuedGoals, prioritized);
		this.runtime.activeGoal = next.goal;
		this.runtime.queuedGoals = next.queue;
		this.runtime.pendingQueueAction = undefined;
		if (!this.runtime.activeGoal) return false;
		this.runtime.persistGoal(this.runtime.activeGoal);
		this.runtime.updateStatus(ctx, this.runtime.activeGoal);
		const sent = await this.runtime.sendAutomaticGoalPrompt(
			ctx,
			this.runtime.activeGoal.id,
			buildGoalPrompt(this.runtime.activeGoal),
		);
		if (generation !== this.runtime.menuGeneration) return false;
		if (!sent && this.runtime.activeGoal?.id === prioritized.id) {
			this.runtime.queuedGoals = previousQueue;
			if (previousGoal.status === "active") {
				abortCurrentTurn(ctx);
				this.runtime.activeGoal = transitionGoal(previousGoal, "paused");
				this.runtime.blockStaleGoalToolCalls();
			} else {
				this.runtime.activeGoal = previousGoal;
				if (previousGoal.status === "complete") {
					this.runtime.pendingQueueAction = { kind: "prioritize", objective, tokenBudget };
				} else if (blocksStaleGoalToolCalls(previousGoal.status)) {
					this.runtime.blockStaleGoalToolCalls();
				}
			}
			this.runtime.persistGoal(this.runtime.activeGoal);
			this.runtime.updateStatus(ctx, this.runtime.activeGoal);
			this.runtime.restoreGoalToolVisibility(visibilityBeforeActivation);
			return false;
		}
		ctx.ui.notify(`Goal prioritized: ${objective}`, "info");
		return true;
	}
}

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	bindMailbox,
	type Mail,
	type MailboxAttemptReceipt,
	type MailboxBinding,
	type MailboxDeliveryReceipt,
	type MailboxRunStart,
	type MailboxTriggerDetails,
	type ProducerCallbacks,
	type ProducerEndpoint,
	type TerminalEvidence,
} from "pi-session-inject/mailbox-v1/light";
import type { GoalRunIntent } from "./mailbox-state.js";
import { extractContinuationMarker } from "./markers.js";
import { buildContinuePrompt } from "./prompts.js";
import type { GoalRuntime, StatusContext } from "./runtime.js";

export const GOAL_MAILBOX_TYPE = "goal-mailbox-continuation-v1";

export function goalMailKey(goalId: string, marker: string) {
	return `continue:${goalId}:${marker}`;
}

/** Old unscoped state is adoptable only in its own publicly identified root file. */
export function goalSourceSessionScope(
	ctx: ExtensionContext,
	source?: { sourceSessionId?: string },
) {
	const sessionId = ctx.sessionManager.getSessionId();
	if (source?.sourceSessionId !== undefined)
		return typeof source.sourceSessionId !== "string" || source.sourceSessionId.length === 0
			? "unknown"
			: source.sourceSessionId === sessionId
				? "own"
				: "foreign";
	try {
		const header = ctx.sessionManager.getHeader();
		return header?.id === sessionId &&
			header.parentSession === undefined &&
			ctx.sessionManager.getSessionFile()
			? "own"
			: "unknown";
	} catch {
		return "unknown";
	}
}

function sourceCheckpointOwns(entry: SessionEntry | undefined, intent: GoalRunIntent): boolean {
	if (entry?.type !== "custom" || entry.customType !== "goal-state") return false;
	const data = entry.data as { mailbox?: { intents?: GoalRunIntent[] } } | undefined;
	return (
		Array.isArray(data?.mailbox?.intents) &&
		data.mailbox.intents.some(
			(old) =>
				old?.goalId === intent.goalId &&
				old.marker === intent.marker &&
				old.prompt === intent.prompt &&
				old.anchorEntryId === intent.anchorEntryId &&
				(old.sourceSessionId === undefined || old.sourceSessionId === intent.sourceSessionId) &&
				old.kind === intent.kind &&
				(old.policy ?? "new-run") === (intent.policy ?? "new-run"),
		)
	);
}

export function goalIntentMail(intent: GoalRunIntent): Mail {
	return {
		producer: "pi-goal",
		key: goalMailKey(intent.goalId, intent.marker),
		anchorEntryId: intent.anchorEntryId,
		policy: intent.policy ?? "new-run",
		wake: true,
		messages: [
			{
				customType: GOAL_MAILBOX_TYPE,
				content: intent.prompt,
				display: false,
				details: { version: 1, goalId: intent.goalId, continuationMarker: intent.marker },
			},
		],
	};
}

export function goalMailIdentity(mail: Mail) {
	if (!Array.isArray(mail?.messages)) return undefined;
	const message = mail.messages[0];
	const details = message?.details as Record<string, unknown> | undefined;
	if (
		mail.producer !== "pi-goal" ||
		mail.messages.length !== 1 ||
		message?.customType !== GOAL_MAILBOX_TYPE ||
		typeof message.content !== "string" ||
		details?.version !== 1 ||
		typeof details.goalId !== "string" ||
		typeof details.continuationMarker !== "string" ||
		!details.continuationMarker.startsWith(`${details.goalId}:`) ||
		extractContinuationMarker(message.content) !== details.continuationMarker ||
		mail.key !== goalMailKey(details.goalId, details.continuationMarker)
	)
		return undefined;
	return { goalId: details.goalId, marker: details.continuationMarker, prompt: message.content };
}

function userText(message: { content?: unknown }) {
	return typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content.map((part) => (part?.type === "text" ? part.text : "")).join("\n")
			: "";
}

/** New custom and legacy user carriers share one logical key. Never use absence
 * as send permission: the transport merges this observation with live submissions. */
export function proveGoalMail(mail: Mail, branch: readonly SessionEntry[]) {
	const identity = goalMailIdentity(mail);
	if (!identity) return { kind: "conflict" as const, reason: "Invalid Goal continuation carrier" };
	const entries: { messageIndex: number; entryId: string }[] = [];
	for (const entry of branch) {
		if (entry.type !== "message" && entry.type !== "custom_message") continue;
		const message =
			entry.type === "custom_message" ? { ...entry, role: "custom" as const } : entry.message;
		if (
			message.role === "user" &&
			extractContinuationMarker(userText(message)) === identity.marker
		) {
			if (userText(message) !== identity.prompt)
				return { kind: "conflict" as const, reason: "Legacy Goal marker payload conflict" };
			entries.push({ messageIndex: 0, entryId: entry.id });
		}
		if (message.role !== "custom" || message.customType !== GOAL_MAILBOX_TYPE) continue;
		const details = message.details as Record<string, unknown> | undefined;
		if (details?.continuationMarker !== identity.marker) continue;
		if (
			details.version !== 1 ||
			Object.keys(details).length !== 3 ||
			details.goalId !== identity.goalId ||
			message.content !== identity.prompt ||
			message.display !== false
		) {
			return { kind: "conflict" as const, reason: "Goal marker payload conflict" };
		}
		entries.push({ messageIndex: 0, entryId: entry.id });
	}
	if (entries.length > 1)
		return { kind: "conflict" as const, reason: "Duplicate Goal continuation carrier" };
	return { kind: "observed" as const, entries };
}

export function directSuccessfulAssistant(branch: readonly SessionEntry[], carrierId: string) {
	const index = branch.findIndex((entry) => entry.id === carrierId);
	if (index < 0) return undefined;
	for (const entry of branch.slice(index + 1)) {
		if (entry.type === "custom_message") return undefined;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user" || message.role === "custom") return undefined;
		if (message.role === "assistant")
			return message.stopReason !== "error" && message.stopReason !== "aborted" ? entry : undefined;
	}
	return undefined;
}

/** A source start checkpoint plus the successful assistant directly following
 * this carrier. A later user's successful request is never borrowed as proof. */
export function legacyGoalCompletionProof(
	intent: GoalRunIntent,
	branch: readonly SessionEntry[],
	nativeEntryId: string | undefined,
	sessionId: string,
) {
	if (!nativeEntryId) return undefined;
	const index = branch.findIndex((entry) => entry.id === nativeEntryId);
	let receipt: SessionEntry | undefined;
	const ownAttempts = new Set<string>();
	const observeAttempt = (entry: SessionEntry) => {
		if (entry.type !== "custom" || entry.customType !== "agent-mailbox-attempt-v1") return;
		const attempt = entry.data as Partial<MailboxAttemptReceipt> | undefined;
		if (
			attempt?.version === 1 &&
			attempt.sessionId === sessionId &&
			typeof attempt.id === "string" &&
			Number.isSafeInteger(attempt.sealedRevision) &&
			(attempt.sealedRevision ?? -1) >= 0 &&
			Array.isArray(attempt.members) &&
			attempt.members.some(
				(member) =>
					member?.producer === "pi-goal" &&
					member.key === goalMailKey(intent.goalId, intent.marker) &&
					member.anchorEntryId === intent.anchorEntryId,
			)
		)
			ownAttempts.add(attempt.id);
	};
	for (const entry of branch.slice(0, index)) {
		observeAttempt(entry);
		if (entry.type !== "custom" || entry.customType !== "goal-state") continue;
		const data = entry.data as
			| {
					goal?: { id?: unknown };
					pendingContinuation?: { continuationId?: unknown };
					mailbox?: { intents?: GoalRunIntent[] };
			  }
			| undefined;
		if (data?.goal?.id !== intent.goalId) continue;
		if (data.mailbox?.intents?.some((item) => item.marker === intent.marker && item.started))
			receipt = entry;
	}
	for (const entry of branch.slice(index + 1)) {
		observeAttempt(entry);
		if (entry.type === "custom_message") {
			const control = entry.details as Partial<MailboxTriggerDetails> | undefined;
			if (
				entry.customType === "agent-mailbox-trigger-v1" &&
				control?.version === 1 &&
				control.sessionId === sessionId &&
				typeof control.attemptId === "string" &&
				ownAttempts.has(control.attemptId)
			)
				continue;
			return "unknown" as const;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user" || message.role === "custom") return "unknown" as const;
		if (message.role === "assistant") {
			if (!receipt || message.stopReason === "error" || message.stopReason === "aborted")
				return undefined;
			return { sourceReceiptEntryId: receipt.id, assistantEntryId: entry.id };
		}
	}
	return undefined;
}

function hasGoalTerminalReceipt(
	mail: Mail,
	branch: readonly SessionEntry[],
	sessionId: string,
): boolean {
	const wanted = goalMailIdentity(mail);
	return branch.some((entry) => {
		if (entry.type !== "custom" || entry.customType !== "agent-mailbox-delivery-v1") return false;
		const receipt = entry.data as Partial<MailboxDeliveryReceipt> | undefined;
		return (
			receipt?.version === 1 &&
			receipt.sessionId === sessionId &&
			Array.isArray(receipt.terminals) &&
			receipt.terminals.some((terminal) => {
				if (!terminal?.mail || !terminal.evidence) return false;
				const found = goalMailIdentity(terminal.mail),
					evidence = terminal.evidence;
				return (
					wanted &&
					found &&
					wanted.goalId === found.goalId &&
					wanted.marker === found.marker &&
					wanted.prompt === found.prompt &&
					terminal.mail.anchorEntryId === mail.anchorEntryId &&
					terminal.mail.policy === mail.policy &&
					terminal.mail.wake === mail.wake &&
					evidence.producer === "pi-goal" &&
					evidence.key === mail.key &&
					evidence.scope?.sessionId === sessionId &&
					evidence.scope?.anchorEntryId === mail.anchorEntryId &&
					typeof evidence.terminalId === "string" &&
					(evidence.outcome === "fulfilled" || evidence.outcome === "cancelled")
				);
			})
		);
	});
}

export class GoalMailbox {
	readonly endpoint: ProducerEndpoint;
	private readonly runtime: GoalRuntime;
	private readonly submitting = new Map<string, Promise<boolean>>();
	private readonly terminalLookups = new Set<string>();
	private readonly liveSourceKeys = new Set<string>();
	private readonly unwrittenOrigins = new WeakMap<GoalRunIntent, number>();
	private recoveryDepth = 0;

	constructor(
		runtime: GoalRuntime,
		pi: ExtensionAPI,
		callbacks: Pick<ProducerCallbacks, "beforeRun" | "afterRun" | "settled">,
		binding: MailboxBinding = bindMailbox(pi),
	) {
		this.runtime = runtime;
		this.endpoint = binding.registerProducer({
			id: "pi-goal",
			checkCurrent: (mail, _point, fence) => {
				if (this.terminalLookups.has(mail.key))
					return { kind: "hold", reason: "Checking existing terminal receipt" };
				const identity = goalMailIdentity(mail);
				const goal = runtime.activeGoal;
				if (!identity) return { kind: "hold", reason: "Invalid Goal identity" };
				if (runtime.mailboxInvalid) return { kind: "hold", reason: "Invalid Goal mailbox state" };
				if (runtime.mailboxState.cancelling)
					return { kind: "hold", reason: "Goal cancellation pending" };
				const intent = runtime.mailboxState.intents.find((item) => item.marker === identity.marker);
				if (!intent) return { kind: "hold", reason: "Goal source intent unavailable" };
				if (intent.sourceSessionId !== fence.session.id)
					return {
						kind: "hold",
						reason: "Goal intent belongs to another or unknown source session",
					};
				if (!goal || goal.id !== identity.goalId || goal.status === "complete")
					return { kind: "cancel", reason: "Goal no longer current" };
				if (
					runtime.queueFrozen ||
					runtime.pendingQueueAction ||
					(goal.status !== "active" &&
						!(goal.status === "budget_limited" && intent.kind === "budget"))
				)
					return { kind: "hold", reason: "Goal advancement suspended" };
				if (
					intent.kind !== "budget" &&
					((goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) ||
						(runtime.settings.continuationLimits.automaticTurns !== null &&
							goal.automaticModelTurns >= runtime.settings.continuationLimits.automaticTurns) ||
						(runtime.settings.continuationLimits.noProgressTurns !== null &&
							goal.toolFreeRepeatCount >= runtime.settings.continuationLimits.noProgressTurns))
				)
					return { kind: "hold", reason: "Goal budget or safety limit reached" };
				return { kind: "allow", project: true, wake: true };
			},
			proveNative: proveGoalMail,
			...callbacks,
		});
	}

	async duringRecovery<T>(work: () => Promise<T>): Promise<T> {
		this.recoveryDepth++;
		try {
			return await work();
		} finally {
			this.recoveryDepth--;
		}
	}

	async submit(
		ctx: StatusContext,
		goalId: string,
		marker: string,
		prompt: string,
		kind: GoalRunIntent["kind"] = "continue",
	) {
		const context = ctx as ExtensionContext;
		if (
			this.runtime.mailboxSessionId !== context.sessionManager.getSessionId() ||
			this.runtime.activeGoal?.id !== goalId
		)
			return false;
		const generation = this.runtime.menuGeneration;
		let intent = this.runtime.mailboxState.intents.find((item) => item.marker === marker);
		if (!intent) {
			intent = {
				goalId,
				marker,
				prompt,
				kind,
				policy: kind === "budget" ? "next-request" : "new-run",
				started: false,
				anchorEntryId: context.sessionManager.getLeafId(),
				sourceSessionId: context.sessionManager.getSessionId(),
			};
			this.runtime.mailboxState.intents.push(intent);
			this.unwrittenOrigins.set(intent, generation);
			if (this.recoveryDepth === 0)
				this.liveSourceKeys.add(
					JSON.stringify([this.runtime.mailboxSessionId, goalMailKey(goalId, marker)]),
				);
			if (!this.recordOrigin(context, intent)) return false;
		}
		if (!this.ownsOrigin(context, intent)) return false;
		const existing = this.submitting.get(marker);
		if (existing) return existing;
		let target: ReturnType<ProducerEndpoint["target"]>;
		try {
			target = this.endpoint.target(context);
		} catch (error) {
			ctx.ui.notify(`Goal mailbox pending: ${String(error)}`, "error");
			return false;
		}
		const work = this.putIntent(intent, target)
			.then((result) => {
				if (
					result.kind === "terminal" &&
					this.runtime.mailboxSessionId === target.session.id &&
					this.runtime.menuGeneration === generation
				)
					this.forgetTerminal(result.evidence);
				return true;
			})
			.catch((error: unknown) => {
				if (this.runtime.mailboxSessionId === target.session.id)
					ctx.ui.notify(`Goal mailbox pending: ${String(error)}`, "error");
				return false;
			})
			.finally(() => {
				this.submitting.delete(marker);
			});
		this.submitting.set(marker, work);
		return work;
	}

	async restore(ctx: StatusContext) {
		if (this.runtime.mailboxInvalid) return;
		const context = ctx as ExtensionContext;
		const generation = this.runtime.menuGeneration;
		const branch = context.sessionManager.getBranch();
		const owed = this.runtime.pendingBackgroundContinuation;
		const goal = this.runtime.activeGoal;
		if (
			owed &&
			goal?.id === owed.goalId &&
			!this.runtime.mailboxState.intents.some((intent) => intent.marker === owed.continuationId) &&
			goalSourceSessionScope(context, owed) !== "foreign"
		) {
			if (goalSourceSessionScope(context, owed) !== "own") {
				this.runtime.mailboxInvalid = true;
				ctx.ui.notify(
					"Goal migration unknown: legacy owed has no original session proof.",
					"warning",
				);
				return;
			}
			const carrier = branch.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					extractContinuationMarker(userText(entry.message)) === owed.continuationId,
			);
			if (carrier?.type === "message" && carrier.message.role === "user") {
				const assistant = directSuccessfulAssistant(branch, carrier.id);
				if (assistant) {
					// Legacy user carrier is already a persisted start. Goal owns this
					// old-format acknowledgement; never present it as an A custom receipt.
					this.runtime.confirmContinuationDispatch(userText(carrier.message));
					return;
				}
				this.runtime.mailboxInvalid = true;
				ctx.ui.notify(
					"Goal migration unknown: legacy user marker has no attributable successful request.",
					"warning",
				);
				return;
			}
			const intent: GoalRunIntent = {
				goalId: goal.id,
				marker: owed.continuationId,
				prompt:
					carrier?.type === "message" && carrier.message.role === "user"
						? userText(carrier.message)
						: buildContinuePrompt(goal, owed.continuationId),
				anchorEntryId: carrier?.parentId ?? context.sessionManager.getLeafId(),
				sourceSessionId: owed.sourceSessionId ?? context.sessionManager.getSessionId(),
				kind: "continue",
				started: false,
			};
			this.runtime.mailboxState.intents.push(intent);
			this.unwrittenOrigins.set(intent, generation);
			if (!this.recordOrigin(context, intent)) return;
		}
		for (const intent of [...this.runtime.mailboxState.intents]) {
			if (this.runtime.menuGeneration !== generation) return;
			const scope = goalSourceSessionScope(context, intent);
			if (scope === "foreign") continue;
			if (scope === "unknown") {
				this.runtime.mailboxInvalid = true;
				ctx.ui.notify("Goal migration unknown: intent has no original session proof.", "warning");
				return;
			}
			if (!intent.sourceSessionId) {
				intent.sourceSessionId = context.sessionManager.getSessionId();
				if (goal) this.runtime.persistGoal(goal);
			}
			const mail = goalIntentMail(intent);
			const proof = proveGoalMail(mail, branch);
			if (proof.kind === "conflict") {
				this.runtime.mailboxInvalid = true;
				ctx.ui.notify(`Goal migration unknown: ${proof.reason}`, "error");
				return;
			}
			const native = branch.find((entry) => entry.id === proof.entries[0]?.entryId);
			if (native?.type === "message" && native.message.role === "user") {
				// A does not accept old user carriers as importFulfilled receipts.
				// Pure legacy owed is handled above before creating source intents;
				// mixed/new source intent plus a user carrier remains unknown.
				this.runtime.mailboxInvalid = true;
				ctx.ui.notify(
					"Goal migration unknown: user carrier cannot prove a mailbox source intent.",
					"warning",
				);
				return;
			}
			if (!intent.originEntryId && native?.type === "custom_message") {
				intent.originEntryId = native.id;
				if (this.runtime.activeGoal) this.runtime.persistGoal(this.runtime.activeGoal);
			}
			if (!this.ownsOrigin(context, intent)) return;
			const target = this.endpoint.target(context);
			if (!this.ownsOrigin(context, intent)) return;
			if (hasGoalTerminalReceipt(mail, branch, context.sessionManager.getSessionId())) {
				this.terminalLookups.add(mail.key);
				try {
					const result = await this.putIntent(intent, target);
					if (this.runtime.menuGeneration !== generation) return;
					if (result.kind === "terminal") this.forgetTerminal(result.evidence);
					else {
						this.runtime.mailboxInvalid = true;
						ctx.ui.notify(
							"Goal migration unknown: terminal receipt is not confirmed by mailbox.",
							"warning",
						);
						return;
					}
				} catch (error) {
					if (this.runtime.menuGeneration === generation) {
						this.runtime.mailboxInvalid = true;
						ctx.ui.notify(`Goal terminal reconciliation failed: ${String(error)}`, "warning");
					}
					return;
				} finally {
					this.terminalLookups.delete(mail.key);
				}
				continue;
			}
			const completed = legacyGoalCompletionProof(
				intent,
				branch,
				proof.entries[0]?.entryId,
				target.session.id,
			);
			if (completed === "unknown") {
				this.runtime.mailboxInvalid = true;
				ctx.ui.notify(
					"Goal migration unknown: request boundary is not attributable to this Goal attempt.",
					"warning",
				);
				return;
			}
			if (completed) {
				const evidence = await this.endpoint.importFulfilled(mail, completed, target);
				if (this.runtime.menuGeneration !== generation) return;
				this.forgetTerminal(evidence);
			} else {
				const result = await this.putIntent(intent, target);
				if (this.runtime.menuGeneration !== generation) return;
				if (result.kind === "terminal") this.forgetTerminal(result.evidence);
			}
		}
	}

	private putIntent(intent: GoalRunIntent, target: ReturnType<ProducerEndpoint["target"]>) {
		if (intent.sourceSessionId !== target.session.id)
			return Promise.reject(new Error("Goal intent is outside its source session"));
		const mail = goalIntentMail(intent);
		return this.liveSourceKeys.has(JSON.stringify([target.session.id, mail.key]))
			? this.endpoint.put(mail, target)
			: this.endpoint.put(mail, target, { recovered: true });
	}

	private recordOrigin(ctx: ExtensionContext, intent: GoalRunIntent): boolean {
		const goal = this.runtime.activeGoal;
		if (!goal || goal.id !== intent.goalId) return false;
		this.runtime.persistGoal(goal);
		const origin = ctx.sessionManager
			.getBranch()
			.find(
				(entry) => entry.parentId === intent.anchorEntryId && sourceCheckpointOwns(entry, intent),
			);
		if (!origin) {
			ctx.ui.notify("Goal mailbox pending: source checkpoint is unavailable.", "warning");
			return false;
		}
		// The first checkpoint is already recoverable by its exact parent edge,
		// frozen mail and source session. No second write is needed to make it valid.
		intent.originEntryId = origin.id;
		this.unwrittenOrigins.delete(intent);
		return true;
	}

	private ownsOrigin(ctx: ExtensionContext, intent: GoalRunIntent): boolean {
		if (goalSourceSessionScope(ctx, intent) !== "own") return false;
		if (!intent.sourceSessionId) {
			intent.sourceSessionId = ctx.sessionManager.getSessionId();
			if (this.runtime.activeGoal) this.runtime.persistGoal(this.runtime.activeGoal);
		}
		const branch = ctx.sessionManager.getBranch();
		if (!intent.originEntryId) {
			const checkpoint = branch.find(
				(entry) => entry.parentId === intent.anchorEntryId && sourceCheckpointOwns(entry, intent),
			);
			const proof = proveGoalMail(goalIntentMail(intent), branch);
			const canonical =
				proof.kind === "observed" && proof.entries.length === 1
					? branch.find(
							(entry) => entry.id === proof.entries[0]?.entryId && entry.type === "custom_message",
						)
					: undefined;
			if (checkpoint || canonical) {
				intent.originEntryId = (checkpoint ?? canonical)?.id;
				if (this.runtime.activeGoal) this.runtime.persistGoal(this.runtime.activeGoal);
			} else if (
				this.unwrittenOrigins.get(intent) === this.runtime.menuGeneration &&
				ctx.sessionManager.getLeafId() === intent.anchorEntryId
			) {
				// A failed append that wrote no checkpoint may retry only in the
				// unchanged live source binding, never by guessing a restored scope.
				return this.recordOrigin(ctx, intent);
			}
		}
		const origin = branch.find((entry) => entry.id === intent.originEntryId);
		const native =
			origin?.type === "custom_message"
				? proveGoalMail(goalIntentMail(intent), [origin])
				: undefined;
		if (
			this.runtime.mailboxSessionId === ctx.sessionManager.getSessionId() &&
			(sourceCheckpointOwns(origin, intent) ||
				(native?.kind === "observed" && native.entries.length === 1))
		)
			return true;
		ctx.ui.notify(
			"Goal migration unknown: the original source scope is not on this branch.",
			"warning",
		);
		return false;
	}

	private forgetTerminal(evidence: TerminalEvidence) {
		const key = evidence.key;
		const intent = this.runtime.mailboxState.intents.find(
			(item) => goalMailKey(item.goalId, item.marker) === key,
		);
		if (intent && evidence.outcome === "fulfilled")
			this.runtime.confirmContinuationDispatch(intent.prompt);
		this.runtime.mailboxState.intents = this.runtime.mailboxState.intents.filter(
			(intent) => goalMailKey(intent.goalId, intent.marker) !== key,
		);
		if (
			this.runtime.continuationDelivery &&
			goalMailKey(
				this.runtime.continuationDelivery.goalId,
				this.runtime.continuationDelivery.marker,
			) === key
		)
			this.runtime.continuationDelivery = undefined;
		if (this.runtime.activeGoal) this.runtime.persistGoal(this.runtime.activeGoal);
	}

	async cancelGoal(ctx: StatusContext, goalId: string) {
		const context = ctx as ExtensionContext;
		const generation = this.runtime.menuGeneration;
		const owed = this.runtime.pendingBackgroundContinuation;
		if (
			owed?.goalId === goalId &&
			goalSourceSessionScope(
				context,
				owed.sourceSessionId !== undefined
					? owed
					: (this.runtime.mailboxState.intents.find(
							(intent) => intent.marker === owed.continuationId,
						) ?? owed),
			) === "unknown"
		)
			throw new Error("Goal cancellation held without the owed source session proof");
		for (const intent of [...this.runtime.mailboxState.intents]) {
			if (intent.goalId !== goalId) continue;
			if (goalSourceSessionScope(context, intent) === "foreign") continue;
			if (!this.ownsOrigin(context, intent))
				throw new Error("Goal cancellation held outside its original source scope");
			const target = this.endpoint.target(context);
			// A source intent can survive failure before acceptance. Idempotent put
			// establishes exactly this frozen key before its durable tombstone.
			await this.putIntent(intent, target);
			if (generation !== this.runtime.menuGeneration || !this.ownsOrigin(context, intent))
				throw new Error("Goal cancellation scope changed");
			await this.endpoint.cancel(
				goalMailKey(goalId, intent.marker),
				"Goal authority revoked",
				target,
			);
		}
	}

	start(start: MailboxRunStart) {
		for (const member of start.members) {
			const identity = goalMailIdentity(member.mail);
			if (!identity || this.runtime.activeGoal?.id !== identity.goalId) continue;
			const intent = this.runtime.mailboxState.intents.find(
				(item) => item.marker === identity.marker,
			);
			if (!intent || intent.sourceSessionId !== start.fence.session.id) continue;
			if (intent.started) return { ...identity, duplicate: true, kind: intent.kind };
			intent.started = true;
			this.runtime.markContinuationStarted(identity.prompt);
			this.runtime.confirmContinuationDispatch(identity.prompt);
			this.runtime.persistGoal(this.runtime.activeGoal);
			return { ...identity, duplicate: false, kind: intent.kind };
		}
		return undefined;
	}
}

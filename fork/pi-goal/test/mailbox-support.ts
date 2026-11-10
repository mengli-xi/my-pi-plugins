import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	Mail,
	MailboxBinding,
	MailboxCallbackFence,
	MailboxTarget,
	ProducerCallbacks,
	ProducerEndpoint,
	TerminalEvidence,
} from "pi-session-inject/mailbox-v1";
import goal from "../src/goal.js";
import { GoalMailbox } from "../src/mailbox.js";
import { extractContinuationMarker } from "../src/markers.js";
import type { GoalRuntime } from "../src/runtime.js";

const transcripts = new WeakMap<
	Parameters<typeof goal>[0],
	(ctx: ExtensionContext, reset?: boolean) => void
>();

/** Give the domain-only port fixture the public source-checkpoint view that a
 * real SessionManager supplies. Delivery itself remains the legacy-reader seam. */
function transcriptFor(pi: Parameters<typeof goal>[0]) {
	const existing = transcripts.get(pi);
	if (existing) return existing;
	let current: ExtensionContext | undefined;
	const states = new WeakMap<
		object,
		{
			overlay: {
				id: string;
				parentId: string | null;
				type: "custom";
				customType: string;
				data: unknown;
			}[];
			base(): unknown[];
		}
	>();
	const prepare = (ctx: ExtensionContext, reset = false) => {
		current = ctx;
		const manager = ctx.sessionManager;
		if (!manager.getHeader)
			Object.assign(manager, { getHeader: () => ({ id: manager.getSessionId() }) });
		if (!manager.getSessionFile)
			Object.assign(manager, {
				getSessionFile: () => `/tmp/goal-domain-${manager.getSessionId()}.jsonl`,
			});
		let state = states.get(manager);
		if (!state) {
			state = { overlay: [], base: manager.getBranch.bind(manager) };
			states.set(manager, state);
			const captured = state;
			const view = () => {
				const base = captured.base() as { id?: string; parentId?: string | null; data?: unknown }[];
				const extras = captured.overlay.filter((entry) => {
					const persisted = base.find((row) => row.data === entry.data);
					if (persisted && !persisted.id) persisted.id = entry.id;
					if (persisted && persisted.parentId === undefined) persisted.parentId = entry.parentId;
					return !persisted;
				});
				return [...base, ...extras];
			};
			Object.assign(manager, { getBranch: view, getLeafId: () => view().at(-1)?.id ?? null });
		}
		if (reset) state.overlay = [];
	};
	const on = pi.on.bind(pi);
	pi.on = ((name: string, handler: (...args: unknown[]) => unknown) =>
		on(
			name as never,
			((event: unknown, ctx: ExtensionContext) => {
				prepare(ctx, name === "session_start" || name === "session_tree");
				return handler(event, ctx);
			}) as never,
		)) as typeof pi.on;
	const append = pi.appendEntry.bind(pi);
	pi.appendEntry = (customType, data) => {
		const parentId = current?.sessionManager.getLeafId() ?? null;
		append(customType, data);
		if (current)
			states
				.get(current.sessionManager)
				?.overlay.push({ id: crypto.randomUUID(), parentId, type: "custom", customType, data });
	};
	transcripts.set(pi, prepare);
	return prepare;
}

/** Domain fixture: dispatches through the legacy user-marker carrier to keep
 * exercising that supported reader. It is deliberately not a transport proof;
 * mailbox.test.ts covers the new custom carrier without any native send. */
export function goalWithTestMailbox(
	pi: Parameters<typeof goal>[0],
	options: Parameters<typeof goal>[1] = {},
) {
	return goal(pi, { ...options, mailbox: legacyMarkerMailbox(pi) });
}

export function legacyMarkerMailbox(pi: Parameters<typeof goal>[0]): MailboxBinding {
	const prepare = transcriptFor(pi);
	return {
		registerProducer(callbacks) {
			const pending = new Map<string, Mail>();
			const dispatched = new Set<string>();
			const drain = (ctx: ExtensionContext) => {
				if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
				for (const mail of pending.values()) {
					if (dispatched.has(mail.key) || mailboxHeld(callbacks, mail, fence(ctx))) continue;
					dispatched.add(mail.key);
					try {
						if (
							String(mail.messages[0]?.content).startsWith(
								"The active /goal token budget is exhausted",
							)
						)
							pi.sendMessage(mail.messages[0] as NonNullable<(typeof mail.messages)[0]>, {
								triggerTurn: false,
								deliverAs: "steer",
							});
						else pi.sendUserMessage(String(mail.messages[0]?.content), { deliverAs: "followUp" });
					} catch (error) {
						dispatched.delete(mail.key);
						throw error;
					}
				}
			};
			const terminal = new Map<string, TerminalEvidence>();
			const token = Symbol();
			const target = (ctx: ExtensionContext): MailboxTarget => {
				prepare(ctx);
				lastContext = ctx;
				return {
					slotKey: "fixture",
					session: { id: ctx.sessionManager.getSessionId(), file: null },
					bindingGeneration: 1,
					producerToken: token,
				};
			};
			const fence = (ctx: ExtensionContext): MailboxCallbackFence => ({
				...target(ctx),
				ownerEpoch: 1,
				attemptId: null,
			});
			pi.on("before_agent_start", async (event, ctx) => {
				const marker =
					event.messageType === "user" ? extractContinuationMarker(event.prompt) : undefined;
				const members = [...pending.values()]
					.filter((mail) =>
						marker
							? extractContinuationMarker(String(mail.messages[0]?.content)) === marker
							: !mailboxHeld(callbacks, mail, fence(ctx)),
					)
					.map((mail) => ({ mail, entries: [] }));
				for (const { mail } of members) dispatched.add(mail.key);
				await callbacks.beforeRun?.({
					event,
					ctx,
					fence: fence(ctx),
					members,
					automatic: !!marker,
				});
			});
			pi.on("agent_end", async (event, ctx) => {
				await callbacks.afterRun?.({
					event,
					ctx,
					fence: fence(ctx),
					members: [],
					outcome: "completed",
					assistantEntryId: null,
				});
			});
			pi.on("agent_settled", async (event, ctx) => {
				await callbacks.settled?.(event, ctx, fence(ctx));
				try {
					drain(ctx);
				} catch (error) {
					ctx.ui.notify(String(error), "error");
				}
			});
			let lastContext: ExtensionContext | undefined;
			const endpoint: ProducerEndpoint = {
				id: "pi-goal",
				token,
				target,
				async put(mail) {
					const existing = terminal.get(mail.key);
					if (existing) return { kind: "terminal", evidence: existing };
					if (!pending.has(mail.key)) pending.set(mail.key, mail);
					if (lastContext) drain(lastContext);
					return { kind: "accepted", key: mail.key, revision: pending.size };
				},
				async cancel(key, reason) {
					const existing = terminal.get(key);
					if (existing) return existing;
					const evidence: TerminalEvidence = {
						producer: "pi-goal",
						key,
						terminalId: key,
						scope: {
							sessionId: "test-session",
							anchorEntryId: pending.get(key)?.anchorEntryId ?? null,
						},
						outcome: "cancelled",
						reason,
					};
					pending.delete(key);
					terminal.set(key, evidence);
					return evidence;
				},
				async importFulfilled(mail, proof) {
					const evidence: TerminalEvidence = {
						producer: "pi-goal",
						key: mail.key,
						terminalId: mail.key,
						scope: { sessionId: "test-session", anchorEntryId: mail.anchorEntryId },
						outcome: "fulfilled",
						receiptEntryId: proof.sourceReceiptEntryId,
						assistantEntryId: proof.assistantEntryId,
						nativeEntryIds: [],
					};
					terminal.set(mail.key, evidence);
					return evidence;
				},
				async activateNewExecution() {
					throw new Error("Goal cannot activate a Subagent execution");
				},
				close() {},
			};
			return endpoint;
		},
		close() {},
	};
}

function mailboxHeld(callbacks: ProducerCallbacks, mail: Mail, fence: MailboxCallbackFence) {
	const result = callbacks.checkCurrent(mail, "before-seal", fence);
	return result instanceof Promise || result.kind !== "allow";
}

export function attachTestMailbox(runtime: GoalRuntime, pi: Parameters<typeof goal>[0]) {
	const binding = legacyMarkerMailbox(pi);
	const mailbox = new GoalMailbox(runtime, pi, {}, binding);
	const submit = mailbox.submit.bind(mailbox);
	mailbox.submit = (ctx, ...args) => {
		transcriptFor(pi)(ctx as ExtensionContext);
		return submit(ctx, ...args);
	};
	runtime.mailbox = mailbox;
	runtime.mailboxSessionId = "test-session";
}

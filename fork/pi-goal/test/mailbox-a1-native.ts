import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BlockingLeaseHandleV1,
	getContinuationRegistryV1,
} from "pi-runtime-contracts/continuation-v1";
import { queryGoalContinuationObligationV1 } from "pi-runtime-contracts/goal-continuation-obligation-v1";
import type { MailboxHolder } from "pi-session-inject/mailbox-v1";
import { Type } from "typebox";

const scenario = process.env.GOAL_JOINT_SCENARIO ?? "normal";
const phase = process.env.GOAL_JOINT_PHASE ?? "run";
const symbol = Symbol.for("pi.goal.mailbox.joint-faux.v1");
interface Stats {
	calls: number;
	main: number;
	child: number;
	goal: number;
	kind: string;
	ctx?: ExtensionContext;
}
const root = globalThis as unknown as Record<symbol, Stats>;
if (!root[symbol]) root[symbol] = { calls: 0, main: 0, child: 0, goal: 0, kind: "none" };
const stats = root[symbol];
const log = (value: unknown) =>
	appendFileSync(process.env.GOAL_JOINT_LOG ?? "", `${JSON.stringify(value)}\n`);
function text(message: { content?: unknown }) {
	return typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content
					.filter((part) => part?.type === "text")
					.map((part) => part.text)
					.join("\n")
			: "";
}
function goalId(messages: { content?: unknown }[]) {
	return [
		...messages
			.map(text)
			.join("\n")
			.matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/g),
	].at(-1)?.[1];
}
function snapshot(ctx: ExtensionContext) {
	const branch = ctx.sessionManager.getBranch();
	const state = branch
		.filter((entry) => entry.type === "custom" && entry.customType === "goal-state")
		.at(-1) as
		| {
				data?: {
					goal?: { id: string; status: string; iteration: number; automaticModelTurns: number };
					mailbox?: { intents: unknown[] };
					pendingContinuation?: { continuationId: string };
				};
		  }
		| undefined;
	const slot = [
		...((globalThis as unknown as Record<symbol, MailboxHolder>)[
			Symbol.for("pi.session-inject.mailbox.v1")
		]?.slots.values() ?? []),
	].find((candidate) => candidate.session.id === ctx.sessionManager.getSessionId());
	return {
		calls: stats.calls,
		main: stats.main,
		child: stats.child,
		goalCalls: stats.goal,
		kind: stats.kind,
		sessionId: ctx.sessionManager.getSessionId(),
		file: ctx.sessionManager.getSessionFile(),
		goal: state?.data?.goal ?? null,
		sourceIntents: state?.data?.mailbox?.intents ?? [],
		owed: state?.data?.pendingContinuation ?? null,
		obligation: state?.data?.pendingContinuation
			? queryGoalContinuationObligationV1({
					sessionId: ctx.sessionManager.getSessionId(),
					continuationId: state.data.pendingContinuation.continuationId,
				})
			: "none",
		held: slot?.recoveryHeld,
		suspended: slot?.snapshot.suspended,
		pending: slot?.snapshot.pending.map((record) => ({
			key: record.key,
			producer: record.producer,
			anchor: record.anchorEntryId,
			recorded:
				record.nativeEntries.length === record.messages.length &&
				record.recorded?.ack === "acknowledged",
		})),
		deliveries: branch.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "agent-mailbox-delivery-v1"
				? ((entry.data as { terminals?: { evidence: unknown }[] })?.terminals ?? []).map(
						(terminal) => terminal.evidence,
					)
				: [],
		),
		bodies: branch.filter(
			(entry) =>
				entry.type === "custom_message" && entry.customType === "goal-mailbox-continuation-v1",
		).length,
		controls: branch.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "agent-mailbox-trigger-v1",
		).length,
		users: branch.filter(
			(entry) =>
				entry.type === "message" && entry.message.role === "user" && text(entry.message) === "USER",
		).length,
	};
}
export function installGoalProvider(pi: ExtensionAPI) {
	const faux = fauxProvider({
		provider: "goal-native-faux",
		api: "goal-native-faux",
		models: [{ id: "fixture", reasoning: false, contextWindow: 128000, maxTokens: 8192 }],
		tokensPerSecond: scenario === "abort" ? 150 : 1000000,
	});
	faux.setResponses(
		Array.from({ length: 30 }, () => async (context) => {
			stats.calls++;
			stats.main++;
			const auth = stats.kind === "auth";
			if (!auth) stats.goal++;
			const id = goalId(context.messages);
			log({
				stage: "request",
				sessionFile: stats.ctx?.sessionManager.getSessionFile(),
				call: stats.calls,
				main: stats.main,
				child: stats.child,
				goalCalls: stats.goal,
				kind: stats.kind,
				goalId: id,
				messages: context.messages.filter((message) => message.role !== "system"),
			});
			if (auth) return fauxAssistantMessage("AUTHORIZED");
			if (scenario === "legacy-queued") {
				if (!id) throw new Error("Recovered queued activation has no Goal id");
				return fauxAssistantMessage(
					fauxToolCall("goal_complete", {
						goal_id: id,
						summary: "Recovered queued Goal completed.",
					}),
				);
			}
			if (scenario === "no-progress" || scenario.startsWith("user-"))
				return fauxAssistantMessage("REPEATED_PROGRESS");
			if (scenario.startsWith("budget"))
				return stats.goal === 1
					? fauxAssistantMessage(
							scenario === "budget"
								? fauxToolCall("budget_probe", {})
								: "Initial request ended at the budget boundary.",
						)
					: fauxAssistantMessage("Budget summary only.");
			if (scenario === "abort") {
				if (stats.goal === 1) return fauxAssistantMessage("First pass needs more work.");
				if (stats.goal === 2) return fauxAssistantMessage("x".repeat(6000));
			}
			if (scenario.startsWith("crash-")) {
				if (phase === "recover") return fauxAssistantMessage("Recovered continuation once.");
				return fauxAssistantMessage("First pass needs more work.");
			}
			if (stats.goal === 1) return fauxAssistantMessage("First pass needs more work.");
			if (!id) throw new Error("Goal id is missing from admitted request");
			return fauxAssistantMessage(
				fauxToolCall("goal_complete", {
					goal_id: id,
					summary: "Goal fixture complete and verified.",
				}),
			);
		}),
	);
	pi.registerProvider(faux.provider);
}

export default async function (pi: ExtensionAPI) {
	installGoalProvider(pi);
	let closed = false;
	const timers: ReturnType<typeof setTimeout>[] = [];
	pi.on("session_shutdown", () => {
		closed = true;
		for (const timer of timers) clearTimeout(timer);
	});
	pi.on("before_agent_start", (event, ctx) => {
		stats.ctx = ctx;
		stats.kind =
			event.messageType === "custom"
				? "control"
				: event.prompt === "AUTHORIZE"
					? "auth"
					: event.prompt === "USER"
						? "user"
						: "goal";
	});
	let userQueued = false;
	const queueUser = (_event: unknown, ctx: ExtensionContext) => {
		if (!userQueued && stats.goal === 1 && stats.kind === "goal") {
			userQueued = true;
			pi.sendUserMessage("USER", { deliverAs: "followUp" });
			log({ stage: "user-queued", ...snapshot(ctx) });
		}
	};
	if (scenario === "user-first") pi.on("agent_settled", queueUser);
	if (scenario === "crash-after-success" && phase === "run")
		pi.on("agent_end", async (_event, ctx) => {
			if (stats.kind === "control" && stats.goal === 2) {
				log({ stage: "gate", label: "after-success", ...snapshot(ctx) });
				await new Promise<void>(() => {});
			}
		});
	pi.registerTool({
		name: "budget_probe",
		label: "Budget Probe",
		description: "Isolated no-op for budget boundary verification",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "probe" }], details: {} };
		},
	});
	const module = await import(
		process.env.GOAL_JOINT_BUNDLE ?? new URL("../dist/index.js", import.meta.url).href
	);
	let owedLease: BlockingLeaseHandleV1 | undefined;
	if (scenario.startsWith("own-fork-owed")) {
		pi.on("session_start", (_event, ctx) => {
			if (phase !== "run") return;
			const acquired = getContinuationRegistryV1().acquireBlocking({
				sessionId: ctx.sessionManager.getSessionId(),
				ownerId: "pi-processes",
				logicalKey: "own-fork-owed-fixture",
				reason: "Local fork work",
			});
			if (!acquired.ok) throw new Error(acquired.message);
			owedLease = acquired.value;
		});
		pi.registerCommand("goal-fixture-commit-owed", {
			description: "Commit a local faux producer receipt and stop before asynchronous submit",
			handler: async (_args, ctx) => {
				if (!owedLease) throw new Error("Missing local blocking lease");
				const offered = owedLease.releaseAndOfferWake({
					outcome: "ready",
					reason: "Local fork work completed",
				});
				if (!offered.ok) throw new Error(offered.message);
				const committed = offered.value.commit("delivered");
				if (!committed.ok || !committed.value.consumerReceipt)
					throw new Error("Producer did not receive a consumer receipt");
				log({
					stage: "gate",
					label: "owed-receipt-before-submit",
					receipt: committed.value.consumerReceipt,
					...snapshot(ctx),
				});
				process.kill(process.pid, "SIGKILL");
			},
		});
	}
	if (phase === "run" && (scenario === "crash-origin" || scenario === "fork-intent")) {
		const append = pi.appendEntry.bind(pi);
		pi.appendEntry = (type, data) => {
			append(type, data);
			if (
				type === "goal-state" &&
				(data as { mailbox?: { intents: unknown[] } }).mailbox?.intents.length
			) {
				if (!stats.ctx) throw new Error("Missing source context at crash checkpoint");
				log({ stage: "gate", label: "first-source-checkpoint", ...snapshot(stats.ctx) });
				process.kill(process.pid, "SIGKILL");
			}
		};
	}
	module.default(pi);
	pi.on("session_start", (_event, ctx) => {
		stats.ctx = ctx;
		log({ stage: "ready", phase, ...snapshot(ctx) });
		timers.push(
			setTimeout(() => {
				if (!closed) log({ stage: "passive", phase, ...snapshot(ctx) });
			}, 800),
		);
		if (scenario === "user-control-first") pi.on("agent_settled", queueUser);
		pi.on("agent_settled", (_event, context) =>
			log({ stage: "settled-final", phase, ...snapshot(context) }),
		);
		if (phase === "run" && scenario === "crash-before-provider")
			pi.on("before_agent_start", async (event, context) => {
				if (event.messageType === "custom") {
					log({ stage: "gate", label: "before-provider", ...snapshot(context) });
					await new Promise<void>(() => {});
				}
			});
		if (phase === "run" && scenario === "crash-context")
			pi.on("context", async (_event, context) => {
				if (stats.kind === "control") {
					log({ stage: "gate", label: "context", ...snapshot(context) });
					await new Promise<void>(() => {});
				}
			});
	});
	pi.registerCommand("goal-joint-inspect", {
		description: "Read the isolated fixture's public state",
		handler: async (_args, ctx) => {
			log({ stage: "inspect", ...snapshot(ctx) });
		},
	});
}

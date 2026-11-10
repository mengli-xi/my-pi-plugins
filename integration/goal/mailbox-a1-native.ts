import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	captureEntrypointDescriptorV1,
	getOrCreateChildCapabilityRegistryV1,
} from "pi-runtime-contracts/child-capabilities-v1";
import { queryGoalContinuationObligationV1 } from "pi-runtime-contracts/goal-continuation-obligation-v1";
import type { MailboxHolder } from "pi-session-inject/mailbox-v1";
import { jointProcessCommand, waitForJointGate } from "./mailbox-a1-barriers.ts";

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
		processBodies: branch.filter(
			(entry) =>
				entry.type === "custom_message" && entry.customType === "process-notification-batch-v1",
		).length,
		completions: branch.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "subagent-completion-v1",
		).length,
		fallbacks: branch.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1",
		).length,
		users: branch.filter(
			(entry) =>
				entry.type === "message" && entry.message.role === "user" && text(entry.message) === "USER",
		).length,
	};
}
export function installJointProvider(pi: ExtensionAPI) {
	let providerContext: ExtensionContext | undefined;
	let childExecution = false;
	pi.on("agent_settled", () => {
		if (childExecution)
			log({
				stage: "child-settled",
				child: stats.child,
				sessionFile: providerContext?.sessionManager.getSessionFile(),
			});
	});
	pi.on("session_start", (_event, ctx) => {
		providerContext = ctx;
	});
	const faux = fauxProvider({
		provider: "goal-joint-faux",
		api: "goal-joint-faux",
		models: [{ id: "fixture", reasoning: false, contextWindow: 128000, maxTokens: 8192 }],
		tokensPerSecond: scenario === "abort" ? 150 : 1000000,
	});
	faux.setResponses(
		Array.from({ length: 30 }, () => async (context, options) => {
			const child = context.messages.some(
				(message) =>
					message.role === "system" &&
					message.toolsAdded?.some((tool) => tool.name === "finish_task"),
			);
			childExecution = child;
			stats.calls++;
			if (child) stats.child++;
			else stats.main++;
			const auth = !child && stats.kind === "auth";
			if (!auth && !child) stats.goal++;
			const id = goalId(context.messages);
			log({
				stage: "request",
				sessionFile: providerContext?.sessionManager.getSessionFile(),
				call: stats.calls,
				main: stats.main,
				child: stats.child,
				goalCalls: stats.goal,
				kind: child ? "child" : stats.kind,
				goalId: id,
				messages: context.messages.filter((message) => message.role !== "system"),
			});
			if (child) {
				if (scenario === "joint-grant") {
					if (stats.child === 1)
						return fauxAssistantMessage(
							fauxToolCall("process", {
								action: "start",
								name: "child-watch",
								kind: "process",
								command: jointProcessCommand("child-process", "CHILD_READY"),
								watches: [
									{
										key: "ready",
										pattern: "CHILD_READY",
										mode: "literal",
										stream: "stdout",
										attention: "turn",
										repeat: false,
									},
								],
								continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
								notify: {
									onSuccess: "ignore",
									onFailure: "ignore",
									onKilled: "ignore",
									onCrash: "ignore",
								},
							}),
						);
					if (stats.child === 2)
						return fauxAssistantMessage("Waiting for the child Process watch.");
				}
				if (scenario === "joint-bd" || scenario.startsWith("joint-paused"))
					await waitForJointGate("child", options?.signal);
				return fauxAssistantMessage("SUBAGENT_OK");
			}
			if (auth) return fauxAssistantMessage("AUTHORIZED");
			if (scenario.startsWith("joint-")) {
				if (scenario === "joint-grant") {
					if (stats.goal === 1)
						return fauxAssistantMessage(
							fauxToolCall("spawn_agent", {
								task_name: "worker",
								message: "Use the process watch and reply SUBAGENT_OK",
								fork_turns: "none",
								reasoning_effort: "off",
							}),
						);
					if (
						!stats.ctx?.sessionManager
							.getBranch()
							.some(
								(entry) =>
									entry.type === "custom_message" && entry.customType === "subagent-completion-v1",
							)
					)
						return fauxAssistantMessage("Waiting for the child Process grant and result.");
					if (!id) throw new Error("Goal id missing after child grant");
					return fauxAssistantMessage(
						fauxToolCall("goal_complete", {
							goal_id: id,
							summary: "Child Process grant completed.",
						}),
					);
				}
				if (stats.goal === 1) {
					const process = fauxToolCall("process", {
						action: "start",
						name: "watcher",
						kind: "monitor",
						command: jointProcessCommand("process", "READY", true),
						watches: [
							{
								key: "ready",
								pattern: "READY",
								mode: "literal",
								stream: "stdout",
								attention: "turn",
								repeat: false,
							},
						],
						continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
						notify: {
							onKilled: "ignore",
							onSuccess: "ignore",
							onFailure: "ignore",
							onCrash: "ignore",
						},
					});
					return fauxAssistantMessage(
						scenario !== "joint-b"
							? [
									process,
									fauxToolCall("spawn_agent", {
										task_name: "worker",
										message: "Reply SUBAGENT_OK",
										fork_turns: "none",
										reasoning_effort: "off",
									}),
								]
							: process,
					);
				}
				const branch = stats.ctx?.sessionManager.getBranch() ?? [];
				const ready = branch.some(
					(entry) =>
						entry.type === "custom_message" && entry.customType === "process-notification-batch-v1",
				);
				const done =
					scenario === "joint-b" ||
					branch.some(
						(entry) =>
							entry.type === "custom_message" && entry.customType === "subagent-completion-v1",
					);
				if (!ready || !done)
					return fauxAssistantMessage("Recorded current results; waiting for remaining work.");
				if (scenario.startsWith("joint-paused"))
					return fauxAssistantMessage("Background results recorded while Goal remains paused.");
				const stopped = context.messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "process" &&
						text(message).includes("Process stop requested"),
				);
				if (!stopped)
					return fauxAssistantMessage(
						fauxToolCall("process", { action: "stop", target: "watcher" }),
					);
			}
			if (!id) throw new Error("Goal id is missing from admitted request");
			return fauxAssistantMessage(
				fauxToolCall("goal_complete", {
					goal_id: id,
					summary: "Joint fixture complete and verified.",
				}),
			);
		}),
	);
	pi.registerProvider(faux.provider);
}

export default async function (pi: ExtensionAPI) {
	installJointProvider(pi);
	let binding: { release(): void } | undefined;
	let registration: { release(): void; registrationToken: string } | undefined;
	let generation = 0;
	if (process.env.GOAL_JOINT_FAUX_CHILD) {
		const registry = getOrCreateChildCapabilityRegistryV1();
		const descriptor = captureEntrypointDescriptorV1(process.env.GOAL_JOINT_FAUX_CHILD);
		registration = registry.register({
			version: 1,
			manifest: {
				version: 1,
				owner_id: "goal-joint-faux",
				main_entrypoint: captureEntrypointDescriptorV1(fileURLToPath(import.meta.url)),
				targets: {
					"pi-subagents": {
						child_entrypoint: descriptor,
						activation: "required-only",
						commands: [],
						tools: [],
						providers: [
							{ provider_id: "goal-joint-faux", service_tiers: [], service_tier_application: "none" },
						],
						hooks: [],
						requires: [],
						sdk_provider_factory: {
							provider_id: "goal-joint-faux",
							package_manifest: captureEntrypointDescriptorV1(
								join(process.env.GOAL_JOINT_FAUX_CHILD, "../../package.json"),
							),
							module: captureEntrypointDescriptorV1(
								join(process.env.GOAL_JOINT_FAUX_CHILD, "../child-factory.ts"),
							),
							export: "createGoalChildFactory",
							config: {},
							artifacts: [
								captureEntrypointDescriptorV1(
									fileURLToPath(new URL("./mailbox-a1-barriers.ts", import.meta.url)),
								),
								captureEntrypointDescriptorV1(fileURLToPath(import.meta.url)),
							],
						},
					},
				},
			},
		});
		const registrationToken = registration.registrationToken;
		pi.on("session_start", (_event, ctx) => {
			binding?.release();
			binding = registry.bind({
				version: 1,
				registrationToken,
				session_id: ctx.sessionManager.getSessionId(),
				runtime_generation: ++generation,
				mode: ctx.mode === "json" ? "print" : ctx.mode,
			});
		});
	}
	let closed = false;
	const timers: ReturnType<typeof setTimeout>[] = [];
	pi.on("session_shutdown", () => {
		if (process.env.GOAL_JOINT_BARRIER_DIR)
			writeFileSync(join(process.env.GOAL_JOINT_BARRIER_DIR, "stop"), "stop");
		closed = true;
		for (const timer of timers) clearTimeout(timer);
		binding?.release();
		registration?.release();
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
	const module = await import(
		process.env.GOAL_JOINT_BUNDLE ?? new URL("../../fork/pi-goal/dist/index.js", import.meta.url).href
	);
	module.default(pi);
	pi.on("session_start", (_event, ctx) => {
		stats.ctx = ctx;
		log({ stage: "ready", phase, ...snapshot(ctx) });
		if (scenario.startsWith("joint-")) {
			let last = "";
			timers.push(
				setInterval(() => {
					const current = snapshot(ctx),
						signature = JSON.stringify([
							current.pending,
							current.goal?.status,
							current.suspended,
							current.bodies,
							current.processBodies,
							current.completions,
							current.fallbacks,
						]);
					if (!closed && signature !== last) {
						last = signature;
						log({ stage: "observe", ...current });
					}
				}, 20),
			);
		}
		timers.push(
			setTimeout(() => {
				if (!closed) log({ stage: "passive", phase, ...snapshot(ctx) });
			}, 800),
		);
		pi.on("agent_settled", (_event, context) =>
			log({ stage: "settled-final", phase, ...snapshot(context) }),
		);
	});
	pi.registerCommand("goal-joint-inspect", {
		description: "Read the isolated fixture's public state",
		handler: async (_args, ctx) => {
			log({ stage: "inspect", ...snapshot(ctx) });
		},
	});
}

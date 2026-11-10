import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Test-side controls only. Goal state is observed through its public semantic
// protocol; no Goal implementation, private TUI field, or other plugin is imported.
export default function (pi: ExtensionAPI) {
	const root = process.env.GOAL_UI_ROOT ?? "";
	if (!root) throw new Error("GOAL_UI_ROOT must identify an isolated PTY fixture directory");
	const commands = join(root, "commands.jsonl");
	const record = (value: object) =>
		appendFileSync(join(root, "events.jsonl"), `${JSON.stringify(value)}\n`);
	let current: ExtensionContext | undefined;
	let closed = true;
	let calls = 0;
	let consumed = 0;
	let version = "";
	const pending = new Set<() => void>();
	let watcher: ReturnType<typeof setInterval> | undefined;
	const snapshot = () => {
		let payload: unknown;
		pi.events.emit("goal:request:snapshot-v1", {
			sessionId: current?.sessionManager.getSessionId(),
			reply: (value: unknown) => {
				payload = value;
			},
		});
		return payload;
	};
	const state = () => ({
		mode: current?.mode,
		sessionId: current?.sessionManager.getSessionId(),
		editor: current?.ui.getEditorText(),
		idle: current?.isIdle(),
		pendingMessages: current?.hasPendingMessages(),
		calls,
		pending: pending.size,
		snapshot: snapshot(),
	});
	const stopSnapshots = pi.events.on("goal:snapshot-v1", (payload) => {
		if (!closed) record({ event: "snapshot", payload });
	});
	function waitForRelease(call: number, signal?: AbortSignal): Promise<boolean> {
		const gate = join(root, `release-${call}`);
		return new Promise((resolve) => {
			let finished = false;
			const finish = (released: boolean) => {
				if (finished) return;
				finished = true;
				clearInterval(gateWatcher);
				signal?.removeEventListener("abort", cancel);
				pending.delete(cancel);
				resolve(released);
			};
			const cancel = () => finish(false);
			const check = () => {
				if (existsSync(gate)) finish(true);
			};
			const gateWatcher = setInterval(check, 25);
			pending.add(cancel);
			signal?.addEventListener("abort", cancel, { once: true });
			if (closed || signal?.aborted) cancel();
			else check();
		});
	}
	const faux = fauxProvider({
		provider: "goal-ui-faux",
		api: "goal-ui-faux",
		models: [{ id: "fixture", reasoning: false, contextWindow: 32768, maxTokens: 512 }],
		tokensPerSecond: 1000000,
	});
	faux.setResponses(
		Array.from({ length: 3 }, () => async (context, options) => {
			const call = ++calls;
			const sessionId = current?.sessionManager.getSessionId();
			const text = context.messages
				.map((message) =>
					message.role === "system"
						? getSystemMessageText(message)
						: typeof message.content === "string"
							? message.content
							: message.content
									.map((block) => (block.type === "text" ? block.text : ""))
									.join("\n"),
				)
				.join("\n");
			const id = [...text.matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/g)].at(-1)?.[1];
			record({ event: "request", call, sessionId, goalId: id });
			if (call > 2 || !id)
				throw new Error("Unexpected provider work in the bounded Goal UI scenario");
			const released = await waitForRelease(call, options?.signal);
			if (
				!released ||
				closed ||
				options?.signal?.aborted ||
				current?.sessionManager.getSessionId() !== sessionId
			) {
				record({ event: "provider-cancelled", call, sessionId });
				return fauxAssistantMessage("", { stopReason: "aborted" });
			}
			record({ event: "provider-released", call, sessionId, goalId: id });
			return fauxAssistantMessage(
				fauxToolCall("goal_complete", {
					goal_id: id,
					summary: "Verified the real Goal PTY flow.",
				}),
			);
		}),
	);
	pi.registerProvider(faux.provider);
	pi.registerShortcut("alt+g", {
		description: "Open the real Goal command without consuming the Main editor draft",
		handler: () => pi.sendUserMessage("/goal", { expandPromptTemplates: true }),
	});
	pi.registerCommand("goal-ui-new", {
		description: "Replace the isolated TUI session while its Goal menu is open",
		handler: async (_args, ctx) => {
			await ctx.newSession();
			return;
		},
	});
	pi.registerCommand("goal-ui-exit", {
		description: "Gracefully stop the isolated Goal PTY test",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		closed = false;
		// A stable metadata signal prevents repeated parsing of an unchanged file.
		// A replacement instance skips controls already handled by its predecessor.
		version = "";
		let priming = true;
		const inspect = () => {
			if (closed) return;
			const info = statSync(commands, { bigint: true });
			const next = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
			if (next === version) return;
			version = next;
			const lines = readFileSync(commands, "utf8").split("\n");
			lines.pop();
			if (priming) {
				consumed = lines.length;
				priming = false;
				return;
			}
			for (const line of lines.slice(consumed)) {
				const command = JSON.parse(line) as { id: number; op: string };
				if (command.op !== "inspect" && command.op !== "replace")
					throw new Error(`Unknown Goal UI control: ${command.op}`);
				record({ event: "inspect", id: command.id, ...state() });
				if (command.op === "replace")
					pi.sendUserMessage("/goal-ui-new", { expandPromptTemplates: true });
			}
			consumed = lines.length;
		};
		watcher = setInterval(inspect, 25);
		inspect();
		record({ event: "ready", ...state() });
	});
	pi.on("agent_settled", () => record({ event: "settled", ...state() }));
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "goal_complete")
			record({ event: "complete-tool", isError: event.isError });
	});
	pi.on("session_shutdown", (event) => {
		closed = true;
		if (watcher) clearInterval(watcher);
		watcher = undefined;
		for (const cancel of [...pending]) cancel();
		stopSnapshots();
		record({
			event: "shutdown",
			reason: event.reason,
			pending: pending.size,
			snapshot: snapshot(),
		});
		current = undefined;
	});
}

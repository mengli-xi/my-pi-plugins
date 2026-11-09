import assert from "node:assert/strict";
import test from "node:test";
import { ActivityTimelineStore } from "../src/activity-timeline.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { registerTranscriptCommands } from "../src/features/transcript/commands.ts";
import { TranscriptOverlayActions } from "../src/features/transcript/overlay-actions.ts";
import { GroupStore } from "../src/grouping.ts";
import { LifecycleManager } from "../src/lifecycle.ts";
import { CcStyleObservability } from "../src/observability.ts";
import { TodoSnapshot } from "../src/todo-state.ts";

test("legacy tool-transcript returns structured output without TUI APIs", async () => {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const sent: any[] = [];
	const store = new GroupStore({ maxGroups: 10 });
	store.start("call-1", "read", { path: "example.ts" }, 1);
	store.end("call-1", { text: "ok", truncated: false, isError: false }, "completed", 2);
	const observability = new CcStyleObservability();
	const lifecycle = new LifecycleManager();
	try {
		registerTranscriptCommands({
			pi: {
				registerShortcut: () => {},
				registerCommand: (name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) => {
					assert.equal(name, "tool-transcript");
					handler = command.handler;
				},
				sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
			} as any,
			config: DEFAULT_CONFIG,
			observability,
			lifecycle,
			store,
			activityTimeline: new ActivityTimelineStore({ isManagedTool: () => true }),
			todos: new TodoSnapshot(),
			drawTodos: () => {},
			overlayActions: new TranscriptOverlayActions(),
			formatActivity: (activity) => activity.toolName,
		});
		assert.ok(handler);
		const ctx = { hasUI: false, mode: "print" };

		await handler!("show", ctx);
		assert.match(sent.at(-1).message.content, /Tool transcript \(deprecated\).*mode: overlay/s);

		await handler!("", ctx);
		assert.match(sent.at(-1).message.content, /Grouped tool transcript:.*read/s);
		assert.equal(sent.at(-1).message.display, true);
	} finally {
		await lifecycle.teardownAll();
		await observability.dispose();
	}
});

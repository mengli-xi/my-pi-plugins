import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piRewind from "../index.ts";

test("agent completion does not rebuild an editor already composed at session start", () => {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const pi = {
		registerCommand() {},
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	piRewind(pi);

	const editor = {
		getText: () => "",
		setText() {},
		handleInput() {},
		render: () => ["editor"],
		invalidate() {},
	};
	let factory = (() => editor) as unknown as NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
	let setCalls = 0;
	const ctx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent(next: typeof factory) {
				factory = next;
				setCalls++;
			},
		},
	} as unknown as ExtensionContext;

	handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
	assert.equal(setCalls, 1, "rewind composes its editor behavior once at session start");

	const rewindFactory = factory;
	factory = ((...args: Parameters<typeof rewindFactory>) => rewindFactory(...args)) as typeof factory;
	handlers.get("agent_end")?.[0]?.({ type: "agent_end" }, ctx);
	handlers.get("agent_end")?.[0]?.({ type: "agent_end" }, ctx);

	assert.equal(
		setCalls,
		1,
		"a later outer wrapper must not make agent_end rebuild the editor and discard its history",
	);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RewindChoice } from "../conversation.ts";
import { formatRewindChoiceLabel, pickRewindChoice } from "../index.ts";

const choices: RewindChoice[] = [
	{
		entryId: "user-1",
		role: "user",
		text: "first",
		retainThroughId: null,
		editorText: "first",
		hasImages: false,
	},
	{
		entryId: "assistant-1",
		role: "assistant",
		text: "second",
		retainThroughId: "assistant-1",
		hasImages: false,
	},
];

test("selection closes ui.custom before the caller touches the session", async () => {
	const events: string[] = [];
	let rendered: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getLeafId: () => "assistant-1" },
		ui: {
			focusedComponent: undefined as unknown,
			theme: {
				fg: (_tone: string, text: string) => text,
			},
			custom: async (factory: (...args: unknown[]) => unknown, options?: unknown) => {
				assert.equal((options as { overlay?: unknown })?.overlay, true);
				let resolve!: (value: unknown) => void;
				const closed = new Promise((done) => { resolve = done; });
				const setFocus = (value: unknown): void => {
					(ctx.ui as unknown as { focusedComponent: unknown }).focusedComponent = value;
					if (value && typeof value === "object" && "focused" in value) {
						(value as { focused: boolean }).focused = true;
					}
				};
				const component = factory(
					{
						terminal: { rows: 24, columns: 60, write() {} },
						children: [],
						requestRender() {},
						setFocus,
					},
					{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text },
					{},
					(value: unknown) => {
						events.push("panel-closed");
						resolve(value);
					},
				) as { handleInput(data: string): void; render(width: number): string[] };
				// The panel mounts as an overlay, and TUI.showOverlay() focuses the
				// component it returns. Without that focus the panel ignores input.
				setFocus(component);
				rendered = component.render(60);
				component.handleInput("\r");
				return closed;
			},
		},
	} as unknown as ExtensionCommandContext;

	const selected = await pickRewindChoice(ctx, choices);
	events.push("picker-resolved");

	assert.equal((ctx.ui as { focusedComponent?: unknown }).focusedComponent !== undefined, true);

	assert.equal(selected?.entryId, "user-1");
	assert.deepEqual(events, ["panel-closed", "picker-resolved"]);
	assert.ok(rendered.some((line) => line === "  (1/1)"));
	assert.ok(rendered.some((line) => line === "  first"));
	assert.ok(!rendered.some((line) => line.includes("AI") && line.includes("second")));
});

test("role labels differ while every message preview uses the same text tone", () => {
	const theme = {
		fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
	};
	assert.equal(
		formatRewindChoiceLabel(choices[0]!, theme as never),
		"<accent>You</accent>  <text>first</text>",
	);
	assert.equal(
		formatRewindChoiceLabel(choices[1]!, theme as never),
		"<warning>AI </warning>  <text>second</text>",
	);
});

test("an assistant-only input cannot open a rewind target picker", async () => {
	const ctx = { ui: { custom: () => { throw new Error("picker must stay closed"); } } } as unknown as ExtensionCommandContext;
	assert.equal(await pickRewindChoice(ctx, choices.filter((choice) => choice.role === "assistant")), undefined);
});

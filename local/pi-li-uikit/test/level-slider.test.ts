import { mouseInput } from "./mouse-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { LevelSlider } from "../src/level-slider.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	getFgAnsi: (color: string) => color,
	getColorMode: () => "ansi256",
} as unknown as Theme;

test("uses the shared accent title, body spacing, and right-aligned hint rule", () => {
	const selected: string[] = [];
	const view = new LevelSlider(
		{ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
		theme,
		{
			title: "Reasoning effort",
			choices: [
				{ value: "low", description: "Faster" },
				{ value: "high", description: "Deeper" },
			],
			current: "low",
			onSelect: (value) => selected.push(value),
			onCancel() {},
		},
	);
	const rows = view.render(60);
	assert.match(rows[0]!, /^── Reasoning effort ─+$/);
	assert.equal(rows[1], "");
	assert.match(rows.at(-1)!, /^─+ ←\/→ adjust · Enter confirm · Esc cancel ──$/);
	assert.ok(rows.every((line) => !/[│╭╮╰╯]/u.test(line)));
	view.handleInput("\x1b[C");
	view.handleInput("\r");
	assert.deepEqual(selected, ["high"]);
});

test("outside click cancels a standalone slider and consumes its report", () => {
	let cancelled = 0;
	const writes: string[] = [];
	const view = new LevelSlider(
		{
			terminal: { rows: 24, columns: 60, write: (data: string) => writes.push(data) },
			requestRender() {},
			mode: "tui",
		} as unknown as TUI,
		theme,
		{
			title: "Reasoning effort",
			choices: [{ value: "low" }, { value: "high" }],
			current: "low",
			onSelect() {},
			onCancel: () => { cancelled++; },
		},
	);
	view.render(60);
	view.setScreenOrigin(10, 0);
	assert.equal(view.wantsMouse, true);
	mouseInput(view, "\x1b[<0;2;2M");
	assert.equal(cancelled, 1);
	view.dispose();
	assert.deepEqual(writes, [], "Pi owns terminal mouse tracking");
});

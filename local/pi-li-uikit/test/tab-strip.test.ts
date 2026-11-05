import assert from "node:assert/strict";
import test from "node:test";
import {
	nextTab,
	renderTabHintDivider,
	renderTabStrip,
	TabStrip,
} from "../src/tab-strip.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const tabs = [
	{ value: "anthropic", label: "Anthropic", count: 12 },
	{ value: "disabled", label: "Disabled", disabled: true },
	{ value: "openai", label: "OpenAI", count: 3 },
];

const theme = {
	active: (text: string) => `<a>${text}</a>`,
	inactive: (text: string) => `<i>${text}</i>`,
	hint: (text: string) => `<h>${text}</h>`,
};

test("moves through enabled tabs in both directions and wraps", () => {
	assert.equal(nextTab(tabs, "anthropic", 1), "openai");
	assert.equal(nextTab(tabs, "openai", 1), "anthropic");
	assert.equal(nextTab(tabs, "anthropic", -1), "openai");
	assert.equal(nextTab(tabs, undefined, 1), "anthropic");
});

test("renders the active tab and optional keyboard hint", () => {
	assert.equal(
		renderTabStrip({ tabs, selected: "openai", theme, hint: "Tab/Shift+Tab provider" }),
		"<i> Anthropic (12) </i>  <i> Disabled </i>  <a>[OpenAI (3)]</a>  · <h>Tab/Shift+Tab provider</h>",
	);
	const lines = new TabStrip({ tabs, selected: "anthropic", theme, paddingX: 0 }).render(80);
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /<a>\[Anthropic \(12\)\]<\/a>/);
	assert.equal(
		renderTabHintDivider("Tab/Shift+Tab provider", 32, (text) => `<d>${text}</d>`),
		"<d>── Tab/Shift+Tab provider ──────</d>",
	);
});

test("keeps every tab and trailing hint at a fixed column while selection moves", () => {
	const plainTheme = {
		active: (text: string) => text,
		inactive: (text: string) => text,
		hint: (text: string) => text,
	};
	const frames = [undefined, "anthropic", "openai"].map((selected) =>
		renderTabStrip({ tabs, selected, theme: plainTheme, hint: "Tab/Shift+Tab provider" })
	);

	assert.equal(new Set(frames.map((frame) => visibleWidth(frame))).size, 1);
	for (const label of ["Anthropic", "Disabled", "OpenAI", "Tab/Shift+Tab provider"]) {
		assert.equal(new Set(frames.map((frame) => frame.indexOf(label))).size, 1, label);
	}
});

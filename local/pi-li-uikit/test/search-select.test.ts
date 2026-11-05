import assert from "node:assert/strict";
import test from "node:test";
import { EditorPanel } from "../src/editor-panel.ts";
import { searchSelectScreen } from "../src/search-select.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function panelWith(screen: ReturnType<typeof searchSelectScreen>) {
	const panel = new EditorPanel({
		tui: { terminal: { rows: 24 }, requestRender: () => {} } as never,
		theme,
		initialScreen: "pick" as const,
		getScreen: () => screen as never,
		onClose: () => {},
	});
	panel.focused = true;
	return panel;
}

test("choices render as aligned label [badge] rows with the current tick", () => {
	const picked: string[] = [];
	const lines = panelWith(searchSelectScreen({
		id: "pick",
		title: "Naming model",
		breadcrumbs: [],
		choices: [
			{ value: "session", label: "session", description: "follow the session model" },
			{ value: "gw/ds", label: "ds", badge: "gw", current: true },
		],
		onPick: (value) => void picked.push(value),
	})).render(60);
	assert.match(lines[0]!, /── Naming model ─+/);
	const rows = lines.filter((line) => /session|\[gw\]/.test(line));
	assert.match(rows[0]!, /session\s{8}follow the session model/);
	assert.match(rows[1]!, /ds\s+\[gw\] ✓/);
	// Column alignment: descriptions start at the same column.
	assert.equal(rows[0]!.indexOf("follow"), rows[1]!.indexOf("[gw]"));
	assert.match(lines[lines.length - 1]!, /^─+ Enter select · Esc back · Ctrl\+C close ──$/);
});

test("tab drives onTab and enter picks the selected choice", async () => {
	let cycles = 0;
	const picked: string[] = [];
	const panel = panelWith(searchSelectScreen({
		id: "pick",
		title: "T",
		breadcrumbs: [],
		statusLine: "effort: minimal · tab to cycle",
		onTab: () => void cycles++,
		choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
		onPick: (value) => void picked.push(value),
	}));
	assert.ok(panel.render(60).some((line) => /effort: minimal/.test(line)));
	panel.handleInput("\t");
	assert.equal(cycles, 1);
	panel.handleInput("\x1b[B"); // down
	panel.handleInput("\r"); // enter
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(picked, ["b"]);
});

test("an initial choice opens selected", async () => {
	const picked: string[] = [];
	const panel = panelWith(searchSelectScreen({
		id: "pick",
		title: "Conversation",
		breadcrumbs: [],
		initialSelected: "latest",
		choices: [
			{ value: "older", label: "Older", detail: "Older conversation" },
			{ value: "latest", label: "Latest", detail: "Latest conversation" },
		],
		onPick: (value) => void picked.push(value),
	}));
	const lines = panel.render(60);
	assert.ok(lines.some((line) => /^→ Latest/.test(line)));
	assert.ok(lines.some((line) => line === "  Latest conversation"));
	panel.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(picked, ["latest"]);
});

test("uses the model-selector section order and keeps position plus detail below choices", () => {
	const panel = panelWith(searchSelectScreen({
		id: "pick",
		title: "Models",
		breadcrumbs: [],
		statusLine: "Only configured providers are shown.",
		initialSelected: "b",
		choices: [
			{ value: "a", label: "Alpha", detail: "Alpha model" },
			{ value: "b", label: "Beta", detail: "Beta model" },
		],
		onPick: () => {},
	}));
	const lines = panel.render(60);
	const hint = lines.indexOf("Only configured providers are shown.");
	const search = lines.indexOf("> ");
	const choice = lines.findIndex((line) => line.startsWith("→ Beta"));
	const position = lines.indexOf("  (2/2)");
	const detail = lines.indexOf("  Beta model");

	assert.equal(lines[hint + 1], "");
	assert.equal(lines[search - 1], "");
	assert.equal(lines[search + 1], "");
	assert.ok(hint < search && search < choice && choice < position && position < detail);
	assert.equal(lines[position + 1], "");
	assert.equal(lines[detail + 1], "");
});

test("pins right-hand content and gives the focused row accent text without a background", () => {
	const backgrounds: Array<{ color: string; text: string }> = [];
	const foregrounds: Array<{ color: string; text: string }> = [];
	const panel = new EditorPanel({
		tui: { terminal: { rows: 24 }, requestRender: () => {} } as never,
		theme: {
			fg: (color: string, text: string) => {
				foregrounds.push({ color, text });
				return text;
			},
			bg: (color: string, text: string) => {
				backgrounds.push({ color, text });
				return text;
			},
			bold: (text: string) => text,
		} as never,
		initialScreen: "pick" as const,
		getScreen: () => searchSelectScreen({
			id: "pick" as const,
			title: "Processes",
			breadcrumbs: [],
			choices: [{
				value: "api",
				label: "api · running · 4s",
				rightText: "npm run dev",
			}],
			onPick: () => {},
		}),
		onClose: () => {},
	});
	panel.focused = true;
	const row = panel.render(60).find((line) => line.includes("npm run dev"))!;
	assert.equal(row.indexOf("npm run dev"), 49);
	assert.equal(backgrounds.length, 0);
	assert.ok(foregrounds.some(({ color, text }) => color === "accent" && text.includes("npm run dev")));
});

test("category tabs filter choices and cycle in both directions", async () => {
	let selectedTab = "anthropic";
	const panel = new EditorPanel({
		tui: { terminal: { rows: 24 }, requestRender: () => {} } as never,
		theme,
		initialScreen: "pick" as const,
		getScreen: () => searchSelectScreen({
			id: "pick",
			title: "Models",
			breadcrumbs: [],
			search: true,
			tabs: {
				items: [
					{ value: "anthropic", label: "Anthropic" },
					{ value: "openai", label: "OpenAI" },
				],
				selected: selectedTab,
				onChange: (value) => { selectedTab = value; },
				hint: "Tab/Shift+Tab provider",
			},
			choices: [
				{ value: "claude", label: "Claude", tab: "anthropic" },
				{ value: "opus", label: "Opus", tab: "anthropic" },
				{ value: "gpt", label: "GPT", tab: "openai" },
			],
			onPick: () => {},
		}),
		onClose: () => {},
	});
	panel.focused = true;

	let lines = panel.render(60);
	const largestTabHeight = lines.length;
	const tabLine = lines.find((line) => line.includes("[Anthropic (2)]"));
	assert.ok(tabLine);
	assert.ok(!tabLine.includes("Tab/Shift+Tab"), "the navigation hint leaves the tab row");
	assert.ok(lines[lines.length - 1]?.includes("Tab/Shift+Tab provider"));
	assert.ok(lines.some((line) => line.includes("Claude")));
	assert.ok(!lines.some((line) => line.includes("GPT")));

	panel.handleInput("\t");
	await new Promise((resolve) => setImmediate(resolve));
	lines = panel.render(60);
	assert.ok(lines.some((line) => line.includes("[OpenAI (1)]")));
	assert.ok(lines.some((line) => line.includes("GPT")));
	assert.equal(lines.length, largestTabHeight, "smaller tabs keep the largest tab's height");

	panel.handleInput("z");
	lines = panel.render(60);
	assert.ok(lines.some((line) => line.includes("No matching items")));
	assert.ok(lines.some((line) => line.includes("(0/0)")));
	assert.equal(lines.length, largestTabHeight, "search results retain the fixed tab height");

	panel.handleInput("\x1b[Z");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(selectedTab, "anthropic");
});

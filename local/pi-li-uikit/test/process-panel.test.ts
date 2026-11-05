import { mouseInput } from "./mouse-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatProcessRuntime,
	ProcessPanel,
	processStatusTone,
	type ProcessPanelDetail,
	type ProcessPanelItem,
} from "../src/process-panel.ts";

const items: ProcessPanelItem[] = [
	{
		id: "api",
		name: "api",
		kind: "service",
		status: "running",
		runtimeMs: 3_723_000,
		command: "npm run dev",
		script: "npm run dev -- --port 3000",
		live: true,
	},
	{
		id: "build",
		name: "build",
		kind: "process",
		status: "succeeded",
		runtimeMs: 5_000,
		command: "npm run build",
		live: false,
	},
];

function harness(options: { direct?: boolean } = {}) {
	let closed = 0;
	let renders = 0;
	const terminalWrites: string[] = [];
	const stopped: string[] = [];
	const backgrounds: string[] = [];
	const foregrounds: Array<{ color: string; text: string }> = [];
	const bolds: string[] = [];
	let output = Array.from({ length: 16 }, (_, index) => `output ${index + 1}`);
	const theme = {
		fg: (color: string, text: string) => {
			foregrounds.push({ color, text });
			return text;
		},
		bg: (color: string, text: string) => {
			backgrounds.push(color);
			return text;
		},
		bold: (text: string) => {
			bolds.push(text);
			return text;
		},
	} as unknown as Theme;
	const panel = new ProcessPanel({
		tui: {
			terminal: { rows: 24, columns: 70, write: (data: string) => terminalWrites.push(data) },
			requestRender: () => renders++,
			mode: "tui",
		} as never,
		theme,
		getItems: () => items,
		loadDetail: async (id): Promise<ProcessPanelDetail> => ({
			item: items.find((item) => item.id === id)!,
			output: output.map((text) => ({ text })),
			totalLines: output.length,
		}),
		onStop: async (id) => { stopped.push(id); },
		onClose: () => { closed++; },
		...(options.direct ? { initialProcessId: "api", directDetail: true } : {}),
	});
	panel.focused = true;
	return {
		panel,
		backgrounds,
		foregrounds,
		bolds,
		stopped,
		terminalWrites,
		get closed() { return closed; },
		get renders() { return renders; },
		append(line: string) { output = [...output, line]; },
	};
}

test("formats long runtimes as spaced hour, minute, and second units", () => {
	assert.equal(formatProcessRuntime(3_723_000), "1h 2m 3s");
	assert.equal(formatProcessRuntime(65_000), "1m 5s");
	assert.equal(formatProcessRuntime(5_000), "5s");
});

test("maps process statuses to blue, green, red, and yellow semantic tones", () => {
	assert.equal(processStatusTone("running"), "mdLink");
	assert.equal(processStatusTone("success"), "success");
	assert.equal(processStatusTone("succeeded"), "success");
	assert.equal(processStatusTone("exit 2"), "error");
	assert.equal(processStatusTone("crashed"), "error");
	assert.equal(processStatusTone("timeout"), "warning");
	assert.equal(processStatusTone("timed out after 30s"), "warning");
});

test("re-reads callback title and hint on every render so live state stays visible", () => {
	let renders = 0;
	let state = "pending";
	const panel = new ProcessPanel({
		tui: {
			terminal: { rows: 24, columns: 70, write: () => {} },
			requestRender: () => renders++,
			mode: "tui",
		} as never,
		theme: {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme,
		title: () => `Processes · ${state}`,
		listHint: () => `hint for ${state}`,
		getItems: () => items,
		loadDetail: async (id): Promise<ProcessPanelDetail> => ({
			item: items.find((item) => item.id === id)!,
			output: [],
			totalLines: 0,
		}),
		onClose: () => {},
	});
	panel.focused = true;
	const first = panel.render(70);
	assert.match(first[0] ?? "", /── Processes · pending ─+/);
	assert.ok(first.some((line) => line === "hint for pending"));

	state = "contained";
	const second = panel.render(70);
	assert.match(second[0] ?? "", /── Processes · contained ─+/);
	assert.ok(second.some((line) => line === "hint for contained"));
	panel.dispose();
});

test("uses SearchSelect layout, accent selection text, and one left-aligned command column", () => {
	const view = harness();
	const lines = view.panel.render(70);
	assert.ok(lines.some((line) => line === "Select a process to inspect its output."));
	assert.ok(lines.some((line) => line === "> "));
	const row = lines.find((line) => line.includes("running") && line.includes("npm run dev"))!;
	const buildRow = lines.find((line) => line.includes("succeeded") && line.includes("npm run build"))!;
	assert.equal(row.indexOf("npm run dev"), buildRow.indexOf("npm run build"));
	assert.equal(row.indexOf("npm run dev"), 34);
	assert.equal(view.backgrounds.length, 0);
	assert.ok(view.foregrounds.some(({ color, text }) => color === "accent" && text.includes("npm run dev")));
	assert.ok(view.foregrounds.some(({ color, text }) => color === "mdLink" && text === "running"));
	assert.ok(view.foregrounds.some(({ color, text }) => color === "success" && text === "succeeded"));
	view.panel.dispose();
});

test("opens the requested process detail with metadata, output, count, follow and stop", async () => {
	const view = harness();
	view.panel.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(view.panel.view, "detail");
	let rendered = view.panel.render(70).join("\n");
	assert.match(rendered, /── api · service ─+/);
	assert.match(rendered, /  Status: running/);
	assert.match(rendered, /Runtime: 1h 2m 3s/);
	assert.match(rendered, /Scripts: npm run dev -- --port 3000/);
	assert.match(rendered, /Scripts: npm run dev -- --port 3000\n  Output:\n  ─+\n  output 4/);
	assert.doesNotMatch(rendered, /── Output/);
	assert.doesNotMatch(rendered, /output 1\n/);
	assert.match(rendered, /  output 16/);
	assert.match(rendered, /  16 lines\n\n─+ x to stop · f to follow newest \[on\] · Esc back/);
	assert.deepEqual(view.bolds.filter((text) => /^(Status|Runtime|Scripts|Output):/.test(text)).slice(-4), [
		"Status: ",
		"Runtime: ",
		"Scripts: ",
		"Output:",
	]);
	assert.ok(view.foregrounds.some(({ color, text }) => color === "text" && text === "output 16"));
	assert.ok(view.foregrounds.some(({ color, text }) => color === "text" && /^─+$/.test(text)));

	view.panel.handleInput("g");
	assert.equal(view.panel.following, false);
	rendered = view.panel.render(70).join("\n");
	assert.match(rendered, /output 1/);
	view.panel.handleInput("f");
	assert.equal(view.panel.following, true);

	view.panel.handleInput("x");
	assert.equal(view.panel.confirmationState, "stop");
	view.panel.handleInput("y");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(view.stopped, ["api"]);
	view.panel.handleInput("\x1b");
	assert.equal(view.panel.view, "list");
	view.panel.handleInput("\x1b[B");
	view.panel.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	rendered = view.panel.render(70).join("\n");
	assert.doesNotMatch(rendered, /x to stop/);
	assert.match(rendered, /─+ f to follow newest \[on\]/);
	view.panel.dispose();
});

test("a short editor-position viewport keeps the process title and footer", async () => {
	const view = harness({ direct: true });
	await new Promise((resolve) => setImmediate(resolve));
	view.panel.setAvailableHeight(22);
	const lines = view.panel.render(70);
	assert.equal(lines.length, 22);
	assert.match(lines[0] ?? "", /^── api · service ─+/);
	assert.match(lines.at(-1) ?? "", /Esc close ──$/);
	assert.ok(lines.some((line) => line.includes("output 16")));
	view.panel.dispose();
});

test("outside click closes both list and detail views", async () => {
	const list = harness();
	list.panel.render(70);
	list.panel.setScreenOrigin(8, 0);
	assert.equal(list.panel.wantsMouse, true);
	mouseInput(list.panel, "\x1b[<0;2;2M");
	assert.equal(list.closed, 1);
	assert.deepEqual(list.terminalWrites, [], "Pi owns terminal mouse tracking");

	const detail = harness({ direct: true });
	await new Promise((resolve) => setImmediate(resolve));
	detail.panel.render(70);
	detail.panel.setScreenOrigin(8, 0);
	mouseInput(detail.panel, "\x1b[<0;2;2M");
	assert.equal(detail.closed, 1);
});

test("a strip-opened detail closes directly on Escape", async () => {
	const view = harness({ direct: true });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(view.panel.view, "detail");
	view.panel.handleInput("\x1b");
	assert.equal(view.closed, 1);
	view.panel.dispose();
});

/** One item's list row, taken from the `(x/y)` position line below the rows. */
function rowsOf(lines: readonly string[]): string[] {
	const position = lines.findIndex((line) => /^\s+\(\d+\/\d+\)$/.test(line));
	assert.ok(position > 0, `no selector position row in ${JSON.stringify(lines)}`);
	const total = Number(/\/(\d+)\)/.exec(lines[position]!)![1]);
	const rows: string[] = [];
	for (let index = position - 1; index >= 0 && rows.length < total; index--) {
		if (lines[index]!.trim() !== "") rows.push(lines[index]!);
	}
	return rows.reverse();
}

function panelFor(panelItems: readonly ProcessPanelItem[]): ProcessPanel {
	const panel = new ProcessPanel({
		tui: {
			terminal: { rows: 24, columns: 80, write: () => {} },
			requestRender: () => {},
			mode: "tui",
		} as never,
		theme: {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme,
		getItems: () => panelItems,
		loadDetail: async (id): Promise<ProcessPanelDetail> => ({
			item: panelItems.find((item) => item.id === id)!,
			output: [],
			totalLines: 0,
		}),
		onClose: () => {},
	});
	panel.focused = true;
	return panel;
}

const contained: ProcessPanelItem[] = [
	{
		id: "proc_cjk",
		name: "故障恢复服务",
		kind: "process",
		status: "crashed · runtime-contained",
		statusShort: "crashed",
		runtimeMs: 5_000,
		command: "node recover.js",
		live: false,
	},
	{
		id: "proc_long",
		name: "a-very-long-companion-process-name",
		kind: "process",
		status: "crashed · supervisor-unavailable",
		statusShort: "crashed",
		runtimeMs: 3_661_000,
		command: "node companion.js",
		live: false,
	},
];

test("the status column falls back to statusShort only when the full status stops fitting", () => {
	const panel = panelFor(contained);
	const wide = rowsOf(panel.render(120));
	assert.match(wide[0]!, /crashed · runtime-contained/);
	assert.match(wide[1]!, /crashed · supervisor-unavailable/);

	const narrow = rowsOf(panel.render(60));
	for (const row of narrow) {
		// The short status takes its own width into the allocation, so the column
		// never has to clip it.
		assert.match(row, / · crashed +· /, `clipped status in ${JSON.stringify(row)}`);
		assert.doesNotMatch(row, /crashed ·? ?\S*…/);
	}
	assert.match(narrow[0]!, /故障/, "the name survives the fallback");
	assert.match(narrow[0]!, /node/, "the command survives the fallback");
	for (const line of panel.render(60)) assert.ok(visibleWidth(line) <= 60);
	panel.dispose();
});

test("an item without a short status keeps the earlier column behaviour", () => {
	const withoutShort = contained.map(({ statusShort: _drop, ...item }) => item);
	const panel = panelFor(withoutShort);
	const rows = rowsOf(panel.render(60));
	// No shorter wording exists, so the column clips the one status there is,
	// exactly as it did before `statusShort`.
	assert.match(rows[0]!, /crashed · runti\S*…/);
	panel.dispose();

	const untouched = panelFor(items);
	const row = rowsOf(untouched.render(70)).find((line) => line.includes("npm run dev"))!;
	assert.match(row, /running/);
	untouched.dispose();
});

test("search reads the semantic fields, so a resize cannot change what a query finds", () => {
	for (const [query, expected] of [
		["companion", "proc_long"],
		["proc_cjk", "proc_cjk"],
		["recover.js", "proc_cjk"],
	] as const) {
		for (const width of [39, 120]) {
			const panel = panelFor(contained);
			panel.render(width);
			for (const character of query) panel.handleInput(character);
			const lines = panel.render(width);
			assert.match(lines.join("\n"), /\(1\/1\)/, `'${query}' at ${width} columns`);
			assert.equal(panel.selectedId, expected, `'${query}' at ${width} columns`);
			panel.dispose();
		}
	}
});

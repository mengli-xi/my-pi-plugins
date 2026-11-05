import { mouseInput } from "./mouse-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	INFORMATION_PANEL_MAX_HEIGHT_RATIO,
	INFORMATION_PANEL_MIN_BODY_ROWS,
	InformationPanel,
	renderKeyValue,
} from "../src/information-panel.ts";
import { printablePanelInput } from "../src/editor-panel.ts";
import { stripAnsi } from "../src/text-overlay.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function panel(options: {
	rows?: number;
	availableHeight?: number;
	title?: string;
	breadcrumbs?: readonly string[];
	body?: readonly string[];
	state?: { kind: "loading" | "cached" | "error"; detail?: string };
	onClose?: () => void;
} = {}) {
	const tui = {
		terminal: { rows: options.rows ?? 30, columns: 80, write: () => {} },
		requestRender: () => {},
	} as unknown as TUI;
	const view = new InformationPanel({
		tui,
		theme,
		getView: () => ({
			title: options.title ?? "Current page",
			breadcrumbs: options.breadcrumbs,
			contentKey: "page",
			state: options.state,
			renderBody: () => options.body ?? ["one"],
		}),
		onClose: options.onClose ?? (() => {}),
	});
	if (options.availableHeight !== undefined) view.setAvailableHeight(options.availableHeight);
	return view;
}

test("uses the shared editor information frame and reserves three body rows", () => {
	const view = panel({ body: ["one"] });
	const lines = view.render(60).map(stripAnsi);
	assert.match(lines[0]!, /^── Current page ─+$/);
	assert.equal(lines[1], "");
	assert.equal(lines.length, INFORMATION_PANEL_MIN_BODY_ROWS + 4);
	assert.equal(lines.at(-2), "", "the footer divider has one blank row above it");
	assert.match(lines.at(-1)!, /Enter\/Esc close ──$/);
});

test("caps overall height at terminal 70 percent and editor-slot availability", () => {
	const body = Array.from({ length: 100 }, (_, index) => `line ${index}`);
	const terminalCapped = panel({ rows: 20, body }).render(60);
	assert.equal(terminalCapped.length, Math.floor(20 * INFORMATION_PANEL_MAX_HEIGHT_RATIO));

	const slotCapped = panel({ rows: 40, availableHeight: 9, body }).render(60);
	assert.equal(slotCapped.length, 9);
});

test("truncates breadcrumbs from the left and keeps the current page", () => {
	const view = panel({
		title: "Available tools",
		breadcrumbs: ["System prompt", "Provider profile", "Capabilities"],
	});
	const wide = view.render(80).map(stripAnsi)[0]!;
	assert.ok(wide.includes("System prompt > Provider profile > Capabilities > Available tools"));
	const narrow = view.render(30).map(stripAnsi)[0]!;
	assert.ok(narrow.includes("… > Available tools"));
	assert.ok(!narrow.includes("System prompt"));
});

test("outside click closes the panel and consumes the mouse report", () => {
	let closed = 0;
	const view = panel({ onClose: () => closed++ });
	view.render(60);
	view.setScreenOrigin(10, 0);
	mouseInput(view, "\x1b[<0;2;25M");
	assert.equal(closed, 1);
	assert.equal(view.isClosed, true);
});

test("shows loading, cached, and error states without owning caller data", () => {
	assert.ok(panel({ state: { kind: "loading", detail: "Reading file…" } })
		.render(60).some((line) => line.includes("Loading · Reading file…")));
	assert.ok(panel({ state: { kind: "cached", detail: "30s ago · Refreshing…" } })
		.render(60).some((line) => line.includes("Cached · 30s ago · Refreshing…")));
	assert.ok(panel({ state: { kind: "error", detail: "Permission denied" } })
		.render(60).some((line) => line.includes("Error · Permission denied")));
});

test("metadata keys use the muted tone while values remain caller-owned", () => {
	const calls: Array<{ color: string; text: string }> = [];
	const recordingTheme = {
		fg: (color: string, text: string) => {
			calls.push({ color, text });
			return text;
		},
	} as unknown as Theme;
	assert.equal(renderKeyValue(recordingTheme, "Status", "running"), "Status: running");
	assert.deepEqual(calls, [{ color: "muted", text: "Status: " }]);
});

test("panel text input accepts only printable content after paste framing", () => {
	assert.equal(printablePanelInput("\x1b[D"), "");
	assert.equal(printablePanelInput("\x1b[C"), "");
	assert.equal(printablePanelInput("\x1b[200~alpha\x1b[201~"), "alpha");
	assert.equal(printablePanelInput("alpha\x03beta"), "alphabeta");
});

test("a view that fills the body is given the exact row budget and keeps the frame height", () => {
	const budgets: number[] = [];
	const tui = {
		terminal: { rows: 30, columns: 80, write: () => {} },
		requestRender: () => {},
	} as unknown as TUI;
	const view = new InformationPanel({
		tui,
		theme,
		getView: () => ({
			title: "Two columns",
			contentKey: "page",
			fillsBody: true,
			renderBody: (_width, bodyRows) => {
				budgets.push(bodyRows);
				return Array.from({ length: bodyRows }, (_line, index) => `row ${index}`);
			},
		}),
		onClose: () => {},
	});
	view.setAvailableHeight(12);

	const lines = view.render(60).map(stripAnsi);
	assert.equal(lines.length, 12, "the frame keeps the tallest allowed height");
	assert.deepEqual(budgets, [12 - 4]);
	// The view owns scrolling, so the generic reader has nothing left to move.
	view.handleInput("\x1b[B");
	const again = view.render(60).map(stripAnsi);
	assert.equal(again[2]!.trimEnd(), "row 0");
	assert.deepEqual(budgets, [8, 8]);
});

test("a filled body reserves one row for the shared deferred-data state line", () => {
	const budgets: number[] = [];
	const tui = {
		terminal: { rows: 30, columns: 80, write: () => {} },
		requestRender: () => {},
	} as unknown as TUI;
	const view = new InformationPanel({
		tui,
		theme,
		getView: () => ({
			title: "Two columns",
			contentKey: "page",
			fillsBody: true,
			state: { kind: "loading" },
			renderBody: (_width, bodyRows) => {
				budgets.push(bodyRows);
				return Array.from({ length: bodyRows }, () => "row");
			},
		}),
		onClose: () => {},
	});
	view.setAvailableHeight(12);
	assert.equal(view.render(60).length, 12);
	assert.deepEqual(budgets, [7]);
});

test("onMouse sees panel events and consumes them before the reader scrolls", () => {
	const seen: Array<{ kind: string; row: number; col: number }> = [];
	const body = Array.from({ length: 100 }, (_, index) => `line ${index}`);
	const view = panel({ body });
	const consuming = new InformationPanel({
		tui: { terminal: { rows: 30, columns: 80, write: () => {} }, requestRender: () => {} } as unknown as TUI,
		theme,
		getView: () => ({ title: "Page", contentKey: "page", renderBody: () => body }),
		onMouse: (event) => {
			seen.push({ kind: event.kind, row: event.row, col: event.col });
			return true;
		},
		onClose: () => {},
	});
	consuming.render(60);
	consuming.setScreenOrigin(10, 0);
	mouseInput(consuming, "\x1b[<65;5;12M");
	assert.deepEqual(seen, [{ kind: "wheel", row: 11, col: 4 }]);
	assert.equal(consuming.render(60).map(stripAnsi)[2]!.trimEnd(), "line 0",
		"a consumed wheel must not scroll the reader");

	// The same report still scrolls a panel that does not claim it.
	view.render(60);
	view.setScreenOrigin(10, 0);
	mouseInput(view, "\x1b[<65;5;12M");
	assert.equal(view.render(60).map(stripAnsi)[2]!.trimEnd(), "line 3");
});

test("an outside left press still closes before a panel-owned mouse handler sees it", () => {
	let closed = 0;
	let handled = 0;
	const view = new InformationPanel({
		tui: { terminal: { rows: 30, columns: 80, write: () => {} }, requestRender: () => {} } as unknown as TUI,
		theme,
		getView: () => ({ title: "Page", contentKey: "page", renderBody: () => ["one"] }),
		onMouse: () => { handled++; return true; },
		onClose: () => { closed++; },
	});
	view.render(60);
	view.setScreenOrigin(10, 0);
	mouseInput(view, "\x1b[<0;2;25M");
	assert.equal(closed, 1);
	assert.equal(handled, 0);
});

test("bodyPointAt maps a screen point to the body row and panel column", () => {
	const points: Array<{ row: number; column: number } | undefined> = [];
	const view = new InformationPanel({
		tui: { terminal: { rows: 30, columns: 80, write: () => {} }, requestRender: () => {} } as unknown as TUI,
		theme,
		getView: () => ({
			title: "Page",
			contentKey: "page",
			fillsBody: true,
			renderBody: (_width, bodyRows) => Array.from({ length: bodyRows }, () => "row"),
		}),
		onMouse: (event, controller) => {
			points.push(controller.bodyPointAt(event.row, event.col));
			return true;
		},
		onClose: () => {},
	});
	view.setAvailableHeight(12);
	view.render(60);
	view.setScreenOrigin(10, 0);
	// Screen row 12 is the first body row: 10 is the title rule and 11 the blank.
	mouseInput(view, "\x1b[<0;8;13M");
	// The title rule itself is inside the frame but outside the body.
	mouseInput(view, "\x1b[<0;8;11M");
	// So is a column past the panel's own width.
	mouseInput(view, "\x1b[<65;90;13M");
	assert.deepEqual(points, [{ row: 0, column: 7 }, undefined, undefined]);
});

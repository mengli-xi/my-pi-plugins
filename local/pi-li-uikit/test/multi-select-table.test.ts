import { mouseInput } from "./mouse-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	MultiSelectTable,
	type MultiSelectTableAction,
} from "../src/multi-select-table.ts";

function fixture(options: { disabledSecond?: boolean; rows?: number } = {}) {
	const actions: MultiSelectTableAction<string>[] = [];
	const terminalWrites: string[] = [];
	const backgrounds: Array<{ color: string; text: string }> = [];
	const foregrounds: Array<{ color: string; text: string }> = [];
	let renders = 0;
	const count = options.rows ?? 3;
	const table = new MultiSelectTable({
		tui: {
			terminal: { rows: 24, columns: 100, write: (data: string) => terminalWrites.push(data) },
			requestRender: () => renders++,
			mode: "tui",
		} as never,
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
		keybindings: {
			matches(data: string, key: string) {
				const values: Record<string, string> = {
					"tui.select.up": "up",
					"tui.select.down": "down",
					"tui.select.pageUp": "page-up",
					"tui.select.pageDown": "page-down",
					"tui.select.confirm": "enter",
					"tui.select.cancel": "escape",
				};
				return values[key] === data;
			},
		} as never,
		title: "Managed resources",
		columns: [
			{ id: "title", header: "Title", minWidth: 8, maxWidth: 24 },
			{ id: "model", header: "Model", minWidth: 6, maxWidth: 16 },
			{ id: "state", header: "State", minWidth: 5, maxWidth: 10 },
			{ id: "id", header: "Conversation", minWidth: 8, maxWidth: 36 },
		],
		rows: Array.from({ length: count }, (_, index) => ({
			id: `row-${index + 1}`,
			cells: {
				title: index === 0 ? "One" : `Conversation ${index + 1}`,
				model: index === 0 ? "Fable 5" : "Claude Opus 4.6",
				state: "ready",
				id: `019f0000-0000-0000-0000-00000000000${index}`,
			},
			current: index === 0,
			selectionDisabled: options.disabledSecond && index === 1,
			selectionDisabledReason: options.disabledSecond && index === 1
				? "Another process owns this row"
				: undefined,
		})),
		onAction: (action) => actions.push(action),
		maxVisible: 4,
	});
	return { table, actions, backgrounds, foregrounds, terminalWrites, get renders() { return renders; } };
}

test("renders aligned columns and never exceeds the terminal width", () => {
	const { table, backgrounds, foregrounds } = fixture();
	const lines = table.render(100);
	assert.match(lines[0]!, /^── Managed resources ─+ 3 rows · 0 selected$/);
	assert.equal(lines[1], "");
	assert.match(lines.at(-1)!, /^─+ ↑↓ move · Space select · a all · d delete · Enter open · v inspect · Esc close ──$/);
	const header = lines.find((line) => line.includes("Conversation"))!;
	const first = lines.find((line) => line.includes("Fable 5"))!;
	const second = lines.find((line) => line.includes("Claude Opus 4.6"))!;
	assert.match(first, /^→ \[ \] ● /, "focused rows match SearchSelect's arrow state");
	assert.equal(backgrounds.length, 0);
	assert.ok(foregrounds.some(({ color, text }) => color === "accent" && text.includes("Fable 5")));
	assert.equal(header.indexOf("Model"), 24, "intrinsic columns do not share spare terminal width");
	assert.equal(header.indexOf("State"), 41);
	assert.equal(header.indexOf("Conversation"), 48, "the fixed two-column gaps remain between every column");
	for (const label of ["Model", "State", "Conversation"]) {
		assert.equal(first.indexOf(label === "Model" ? "Fable 5" : label === "State" ? "ready" : "019f"), header.indexOf(label));
	}
	assert.equal(second.indexOf("ready"), header.indexOf("State"));
	const explanation = lines.findIndex((line) => line.includes("Space selects rows"));
	assert.equal(lines[explanation - 1], "", "the explanation is separated from the table body");
	assert.ok(lines.every((line) => visibleWidth(line) <= 100));
	assert.ok(table.render(32).every((line) => visibleWidth(line) <= 32));
});

test("Space multi-selects rows and d deletes selected rows in table order", () => {
	const view = fixture();
	view.table.handleInput("down");
	view.table.handleInput(" ");
	view.table.handleInput("down");
	view.table.handleInput(" ");
	assert.deepEqual(view.table.selected, ["row-2", "row-3"]);
	view.table.handleInput("d");
	assert.deepEqual(view.actions, [{ kind: "delete", ids: ["row-2", "row-3"] }]);
	assert.ok(view.renders >= 5);
});

test("d targets the focused row when nothing is checked", () => {
	const view = fixture();
	view.table.handleInput("down");
	view.table.handleInput("d");
	assert.deepEqual(view.actions, [{ kind: "delete", ids: ["row-2"] }]);
});

test("disabled rows remain openable but cannot be selected or deleted", () => {
	const view = fixture({ disabledSecond: true });
	view.table.handleInput("down");
	view.table.handleInput(" ");
	view.table.handleInput("d");
	assert.deepEqual(view.table.selected, []);
	assert.ok(view.table.render(100).some((line) => line.includes("Another process owns this row")));
	assert.deepEqual(view.actions, []);
	view.table.handleInput("enter");
	view.table.handleInput("v");
	assert.deepEqual(view.actions, [
		{ kind: "activate", id: "row-2" },
		{ kind: "inspect", id: "row-2" },
	]);
});

test("a toggles all selectable rows and Escape cancels", () => {
	const view = fixture({ disabledSecond: true });
	view.table.handleInput("a");
	assert.deepEqual(view.table.selected, ["row-1", "row-3"]);
	view.table.handleInput("a");
	assert.deepEqual(view.table.selected, []);
	view.table.handleInput("escape");
	assert.deepEqual(view.actions, [{ kind: "cancel" }]);
});

test("outside click cancels a standalone table", () => {
	const view = fixture();
	view.table.render(100);
	view.table.setScreenOrigin(8, 0);
	assert.equal(view.table.wantsMouse, true);
	mouseInput(view.table, "\x1b[<0;2;2M");
	assert.deepEqual(view.actions, [{ kind: "cancel" }]);
	view.table.dispose();
	assert.deepEqual(view.terminalWrites, [], "Pi owns terminal mouse tracking");
});

test("scrolling stays bounded across page, home, and end navigation", () => {
	const { table } = fixture({ rows: 12 });
	table.handleInput("page-down");
	table.handleInput("page-down");
	assert.ok(table.render(90).some((line) => line.includes("row") || line.includes("Conversation 9")));
	table.handleInput("\u001b[F");
	assert.ok(table.render(90).some((line) => line.includes("Conversation 12")));
	table.handleInput("\u001b[H");
	assert.ok(table.render(90).some((line) => line.includes("One")));
});

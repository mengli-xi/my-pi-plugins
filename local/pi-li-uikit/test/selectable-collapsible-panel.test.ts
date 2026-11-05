import { mouseInput } from "./mouse-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { SelectableCollapsiblePanel } from "../src/selectable-collapsible-panel.ts";
import type { BodyLayout, ScrollOverlayOptions } from "../src/text-overlay.ts";
import { stripAnsi } from "../src/text-overlay.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

class ExamplePanel extends SelectableCollapsiblePanel {
	private ids = ["one", "two"];

	constructor(options: ScrollOverlayOptions) {
		super(options);
		this.setItemIds(this.ids);
	}

	protected title(): string {
		return "Tools";
	}

	protected panelFooterCandidates(): readonly string[] {
		return [
			"↑↓ select · Enter/Space/click expand/fold · Esc close",
			"↑↓ select · Enter expand/fold · Esc close",
		];
	}

	protected buildBody(width: number): BodyLayout {
		const lines: string[] = [];
		const headings: number[] = [];
		for (let index = 0; index < this.ids.length; index++) {
			headings.push(lines.length);
			lines.push(...this.renderSelectableRows(index, {
				summary: `Item ${this.ids[index]}`,
				preview: [`detail ${this.ids[index]}`],
				expanded: this.isItemExpanded(index),
				showPreview: this.isItemExpanded(index),
			}, width));
			if (index < this.ids.length - 1) lines.push(this.renderItemDivider(width));
		}
		return { lines, headings };
	}

	updateIds(ids: string[]): void {
		this.ids = ids;
		this.setItemIds(ids);
	}
}

function panel(theme: Theme = plainTheme, rows = 12) {
	let renders = 0;
	const tui = {
		terminal: { rows, columns: 60, write: () => {} },
		requestRender: () => { renders++; },
		mode: "tui",
	} as unknown as TUI;
	return {
		view: new ExamplePanel({
			tui,
			theme,
			overlay: { mouseScrollLines: 3 },
			placement: { anchor: "top", marginX: 0 },
			onClose: () => {},
		}),
		get renders() {
			return renders;
		},
	};
}

const clean = (lines: readonly string[]) => lines.map(stripAnsi);
const click = (row: number, column = 3) =>
	`\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`;

test("uses one accent rule tone with right-aligned title and key hints", () => {
	const calls: Array<{ color: string; text: string }> = [];
	const recordingTheme = {
		...plainTheme,
		fg: (color: string, text: string) => {
			calls.push({ color, text });
			return text;
		},
	} as unknown as Theme;
	const rendered = clean(panel(recordingTheme).view.render(60));

	assert.match(rendered[0]!, /^─+ Tools ──$/u);
	assert.match(rendered.at(-1)!, /^─+ ↑↓ select · Enter\/Space\/click expand\/fold · Esc close ──$/u);
	assert.equal(rendered[1]!.trim(), "");
	assert.ok(rendered.every((line) => !/[│╭╮╰╯]/u.test(line)));
	const chromeRuleCalls = calls.filter(({ text }) =>
		text.includes("Tools") || text.includes("select")
	);
	assert.ok(chromeRuleCalls.length >= 2);
	assert.ok(chromeRuleCalls.every(({ color }) => color === "accent"));
});

test("item dividers use a muted inset rule without becoming selectable", () => {
	const calls: Array<{ color: string; text: string }> = [];
	const recordingTheme = {
		...plainTheme,
		fg: (color: string, text: string) => {
			calls.push({ color, text });
			return text;
		},
	} as unknown as Theme;
	const rendered = clean(panel(recordingTheme).view.render(60));
	const dividers = rendered.filter((line) => /^\s+─+\s+$/u.test(line));
	assert.equal(dividers.length, 1);
	assert.equal(visibleWidth(dividers[0]!), 60, "the divider row preserves panel width");
	assert.ok(calls.some(({ color, text }) =>
		color === "borderMuted" && /^\s+─+\s+$/u.test(text) && visibleWidth(text) === 56
	));
	assert.equal(rendered.filter((line) => line.includes("→")).length, 1);
});

test("clicking an item divider does not select or toggle either neighbour", () => {
	const { view } = panel();
	const initial = clean(view.render(60));
	const divider = initial.findIndex((line) => /^\s+─+\s+$/u.test(line));
	assert.ok(divider >= 0);

	mouseInput(view, click(divider));
	const rendered = clean(view.render(60));
	assert.ok(rendered.some((line) => line.includes("→ ▸ Item one")));
	assert.ok(rendered.some((line) => line.includes("▸ Item two")));
	assert.ok(!rendered.some((line) => line.includes("detail one") || line.includes("detail two")));
});

test("up and down move selection while enter toggles the selected item", () => {
	const { view } = panel();
	let rendered = clean(view.render(60));
	assert.ok(rendered.some((line) => line.includes("→ ▸ Item one")));

	view.handleInput("\x1b[B");
	rendered = clean(view.render(60));
	assert.ok(rendered.some((line) => line.includes("→ ▸ Item two")));
	assert.ok(!rendered.some((line) => line.includes("detail two")));

	view.handleInput("\r");
	rendered = clean(view.render(60));
	assert.ok(rendered.some((line) => line.includes("→ ▾ Item two")));
	assert.ok(rendered.some((line) => line.includes("detail two")));

	view.handleInput("\x1b[A");
	rendered = clean(view.render(60));
	assert.ok(rendered.some((line) => line.includes("→ ▸ Item one")));
	assert.ok(rendered.some((line) => line.includes("▾ Item two")), "moving selection preserves fold state");
});

test("click selects and toggles the clicked item", () => {
	const { view } = panel();
	const initial = clean(view.render(60));
	const row = initial.findIndex((line) => line.includes("▸ Item two"));
	assert.ok(row >= 0);

	mouseInput(view, click(row));
	const rendered = clean(view.render(60));
	assert.ok(rendered.some((line) => line.includes("→ ▾ Item two")));
	assert.ok(rendered.some((line) => line.includes("detail two")));
});

test("stable ids preserve selection and expansion across live reordering", () => {
	const { view } = panel();
	view.render(60);
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	view.updateIds(["two", "one"]);
	const rendered = clean(view.render(60));

	assert.ok(rendered.some((line) => line.includes("→ ▾ Item two")));
	assert.ok(rendered.some((line) => line.includes("detail two")));
});

test("live reordering keeps the selected item visible in a long viewport", () => {
	const { view } = panel(plainTheme, 8);
	view.updateIds(Array.from({ length: 10 }, (_, index) => `id${index}`));
	view.render(60);
	for (let index = 0; index < 7; index++) view.handleInput("\x1b[B");
	assert.ok(clean(view.render(60)).some((line) => line.includes("→ ▸ Item id7")));

	view.updateIds(["id7", "id0", "id1", "id2", "id3", "id4", "id5", "id6", "id8", "id9"]);
	const rendered = clean(view.render(60));
	assert.ok(rendered.some((line) => line.includes("→ ▸ Item id7")));
});

test("narrow panels preserve truncated right-edge title and shortcut labels", () => {
	const rendered = clean(panel().view.render(30));
	assert.match(rendered[0]!, /Tools ──$/u);
	assert.match(rendered.at(-1)!, /Enter expand\/fold · Esc close ──$|… ──$/u);
	assert.equal(visibleWidth(rendered[0]!), 30);
	assert.equal(visibleWidth(rendered.at(-1)!), 30);
});

test("an unfocused panel does not consume selection input", () => {
	const { view, renders } = panel();
	view.render(60);
	view.focused = false;
	view.handleInput("\x1b[B");
	const rendered = clean(view.render(60));
	assert.ok(rendered.some((line) => line.includes("→ ▸ Item one")));
	assert.equal(renders, 0);
});

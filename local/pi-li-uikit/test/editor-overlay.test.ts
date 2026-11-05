import assert from "node:assert/strict";
import test from "node:test";
import type { Component, TUI } from "@earendil-works/pi-tui";

import {
	createEditorOverlayMount,
	resolveEditorOverlayPlacement,
} from "../src/editor-overlay.ts";

const EDITOR_SLOT_GEOMETRY_KEY = Symbol.for("pi.pinned-layout.editor-slot-geometry.v1");

class Lines implements Component {
	readonly lines: string[];
	constructor(lines: string[]) { this.lines = lines; }
	render(): string[] { return this.lines; }
	invalidate(): void {}
}

class Editor extends Lines {
	getText(): string { return "draft"; }
	setText(): void {}
	handleInput(): void {}
}

function tui() {
	const editor = new Editor(["top", "draft", "bottom"]);
	const below = new Lines(["statusline"]);
	const footer = new Lines(["footer"]);
	const value = {
		terminal: { rows: 24, columns: 80 },
		children: [
			new Lines(["transcript"]),
			new Lines(["working"]),
			{ children: [editor], render: () => editor.render(), invalidate() {} },
			below,
			footer,
		],
	} as unknown as TUI;
	return { value, below, footer };
}

test("uses the editor slot's full width and bottom edge", () => {
	const view = tui();
	const placement = resolveEditorOverlayPlacement(view.value);
	assert.equal(placement.options.anchor, "bottom-left");
	assert.equal(placement.options.width, "100%");
	assert.deepEqual(placement.options.margin, { bottom: 2 });
	assert.deepEqual(placement.origin(8), { row: 14, column: 0 });
});

test("tracks rows below the editor without moving the underlying layout", () => {
	const view = tui();
	const placement = resolveEditorOverlayPlacement(view.value);
	view.below.lines.push("second status row");
	assert.deepEqual(placement.options.margin, { bottom: 3 });
	assert.deepEqual(placement.origin(8), { row: 13, column: 0 });
});

test("prefers the layout owner's allocated editor geometry over natural root heights", () => {
	const view = tui();
	const provider = {
		version: 1,
		snapshot: () => ({ version: 1, width: 80, bottomMargin: 4, availableHeight: 20 }),
	};
	(globalThis as Record<PropertyKey, unknown>)[EDITOR_SLOT_GEOMETRY_KEY] = {
		version: 1,
		resolvers: new Set([provider]),
	};
	try {
		const placement = resolveEditorOverlayPlacement(view.value);
		assert.deepEqual(placement.options.margin, { bottom: 4 });
		assert.equal(placement.availableHeight(), 20);
		assert.deepEqual(placement.origin(8), { row: 12, column: 0 });
	} finally {
		delete (globalThis as Record<PropertyKey, unknown>)[EDITOR_SLOT_GEOMETRY_KEY];
	}
});

test("uses a dynamic geometry resolver after Pi replaces the TUI instance", () => {
	const first = tui();
	const replacement = tui();
	const resolver = {
		version: 1,
		snapshot: (candidate: TUI) => candidate === replacement.value
			? { version: 1, width: 80, bottomMargin: 5, availableHeight: 19 }
			: undefined,
	};
	(globalThis as Record<PropertyKey, unknown>)[EDITOR_SLOT_GEOMETRY_KEY] = {
		version: 1,
		resolvers: new Set([resolver]),
	};
	try {
		assert.deepEqual(resolveEditorOverlayPlacement(first.value).options.margin, { bottom: 2 });
		const placement = resolveEditorOverlayPlacement(replacement.value);
		assert.deepEqual(placement.options.margin, { bottom: 5 });
		assert.equal(placement.availableHeight(), 19);
	} finally {
		delete (globalThis as Record<PropertyKey, unknown>)[EDITOR_SLOT_GEOMETRY_KEY];
	}
});

test("mount wrapper forwards focus, input, disposal, and absolute origin", () => {
	const view = tui();
	const mount = createEditorOverlayMount();
	let focused = false;
	let input = "";
	let disposed = 0;
	let origin: { row: number; column: number } | undefined;
	let availableHeight: number | undefined;
	const child = {
		get focused() { return focused; },
		set focused(value: boolean) { focused = value; },
		wantsMouse: true,
		render: () => Array.from({ length: 8 }, (_, index) => `panel-${index}`),
		handleInput: (data: string) => { input = data; },
		invalidate() {},
		dispose: () => { disposed++; },
		setScreenOrigin: (row: number, column: number) => { origin = { row, column }; },
		setAvailableHeight: (rows: number) => { availableHeight = rows; },
	};
	const wrapper = mount.mount(view.value, child) as Component & {
		focused: boolean;
		wantsMouse: boolean;
		dispose(): void;
	};
	wrapper.focused = true;
	wrapper.handleInput?.("x");
	assert.equal(wrapper.wantsMouse, true);
	assert.equal(focused, true);
	assert.equal(input, "x");
	const rendered = wrapper.render(80);
	assert.equal(rendered.length, 9);
	assert.equal(rendered[0], " ".repeat(80), "the overlay clears one full row above its title rule");
	assert.deepEqual(rendered.slice(1), Array.from({ length: 8 }, (_, index) => `panel-${index}`));
	assert.equal(availableHeight, 21);
	assert.deepEqual(origin, { row: 14, column: 0 });
	wrapper.dispose();
	assert.equal(disposed, 1);

	assert.equal(mount.customOptions.overlay, true);
	assert.equal(typeof mount.customOptions.overlayOptions, "function");
	const options = mount.customOptions.overlayOptions();
	assert.equal(options.anchor, "bottom-left");
	assert.equal(options.width, "100%");
	assert.deepEqual(options.margin, { bottom: 2 });
});

test("a one-row editor slot preserves content instead of spending its only row on the gap", () => {
	const view = tui();
	(globalThis as Record<PropertyKey, unknown>)[EDITOR_SLOT_GEOMETRY_KEY] = {
		version: 1,
		resolvers: new Set([{
			version: 1,
			snapshot: () => ({ version: 1, width: 80, bottomMargin: 23, availableHeight: 1 }),
		}]),
	};
	try {
		const wrapper = createEditorOverlayMount().mount(view.value, {
			render: () => ["title", "footer"],
			invalidate() {},
		});
		assert.deepEqual(wrapper.render(80), ["footer"]);
	} finally {
		delete (globalThis as Record<PropertyKey, unknown>)[EDITOR_SLOT_GEOMETRY_KEY];
	}
});

test("an over-height panel is cropped from the top and keeps its editor bottom edge", () => {
	const view = tui();
	const mount = createEditorOverlayMount();
	let origin: { row: number; column: number } | undefined;
	const child: Component & { setScreenOrigin(row: number, column: number): void } = {
		render: () => Array.from({ length: 30 }, (_, index) => `panel-${index}`),
		invalidate() {},
		setScreenOrigin: (row, column) => { origin = { row, column }; },
	};
	const wrapper = mount.mount(view.value, child);
	assert.deepEqual(wrapper.render(80), [
		" ".repeat(80),
		...Array.from({ length: 21 }, (_, index) => `panel-${index + 9}`),
	]);
	assert.deepEqual(origin, { row: -8, column: 0 });
});

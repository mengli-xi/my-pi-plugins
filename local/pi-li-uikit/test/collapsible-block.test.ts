import assert from "node:assert/strict";
import test from "node:test";
import {
	CollapsibleBlock,
	renderCollapsibleRows,
} from "../src/collapsible-block.ts";

test("a block is one stable summary row by default", () => {
	const block = new CollapsibleBlock({ summary: "Read 3 files", preview: ["a", "b"] });
	assert.deepEqual(block.render(80), ["▸ Read 3 files"]);
});

test("expanded previews are bounded and advertise the overlay", () => {
	const block = new CollapsibleBlock({
		summary: "Read files",
		preview: ["a", "b", "c"],
		previewLimit: 2,
		expanded: true,
	});
	assert.deepEqual(block.render(80), [
		"▾ Read files",
		"  a",
		"  b",
		"  … 1 more · press o to open overlay",
	]);
});

test("shared rows can keep a bounded preview visible while details stay folded", () => {
	assert.deepEqual(renderCollapsibleRows({
		summary: "Ran git diff",
		preview: ["one", "two", "three"],
		previewLimit: 2,
		showPreview: true,
	}, 80), [
		"▸ Ran git diff",
		"  one",
		"  two",
		"  … 1 more · press o to open overlay",
	]);
});

test("shared rows accept themed markers without changing the two-column grammar", () => {
	assert.deepEqual(renderCollapsibleRows({
		summary: "Read src/a.ts",
		expanded: true,
		renderMarker: (marker) => `[${marker}]`,
	}, 80), ["[▾] Read src/a.ts"]);
});

test("payload reclamation never removes the summary row", () => {
	const block = new CollapsibleBlock({ summary: "Finished", preview: ["payload"], expanded: true });
	block.setPreview(undefined);
	assert.deepEqual(block.render(80), ["▾ Finished"]);
});

test("open-overlay action is local and does not append a message", () => {
	let opened = 0;
	const block = new CollapsibleBlock({ summary: "Result", onOpenOverlay: () => { opened++; } });
	block.focused = true;
	block.handleInput("o");
	assert.equal(opened, 1);
	block.handleInput(" ");
	assert.deepEqual(block.render(80), ["▾ Result"]);
});

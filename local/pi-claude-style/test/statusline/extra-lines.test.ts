import assert from "node:assert/strict";
import test from "node:test";

import { ContributedRows } from "../../src/statusline/extra-lines.ts";

test("a row is taken, replaced and withdrawn by key", () => {
	const rows = new ContributedRows();
	assert.equal(rows.handle({ key: "goal", line: "goal a" }), true);
	assert.deepEqual(rows.lines(), ["goal a"]);
	assert.equal(rows.handle({ key: "goal", line: "goal a" }), false, "没变就不该重绘");
	assert.equal(rows.handle({ key: "goal", line: "goal b" }), true);
	assert.deepEqual(rows.lines(), ["goal b"]);
	assert.equal(rows.handle({ key: "goal" }), true);
	assert.deepEqual(rows.lines(), []);
});

test("withdrawing a row that was never there is not a redraw", () => {
	const rows = new ContributedRows();
	assert.equal(rows.handle({ key: "ghost" }), false);
});

test("a click reaches the contributor that drew that row", () => {
	const rows = new ContributedRows();
	let clicked: string | undefined;
	rows.handle({ key: "goal", line: "goal", onClick: () => { clicked = "goal"; return true; } });
	rows.handle({ key: "ps", line: "3 processes", onClick: () => { clicked = "ps"; return true; } });

	assert.equal(rows.clickHandlerAt(1)?.(), true);
	assert.equal(clicked, "ps", "第二行应当路由到第二个贡献者");
	rows.clickHandlerAt(0)?.();
	assert.equal(clicked, "goal");
});

test("a row with no handler, and an index past the end, are inert", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "goal", line: "goal" });
	assert.equal(rows.clickHandlerAt(0), undefined);
	assert.equal(rows.clickHandlerAt(9), undefined);
});

test("withdrawing a row takes its handler with it", () => {
	// Otherwise a click would land on a stale closure after the row is gone.
	const rows = new ContributedRows();
	rows.handle({ key: "ps", line: "3 processes", onClick: () => true });
	rows.handle({ key: "ps" });
	assert.equal(rows.clickHandlerAt(0), undefined);
});

test("a replaced row hands over the newer handler", () => {
	const rows = new ContributedRows();
	let seen = 0;
	rows.handle({ key: "ps", line: "1 process", onClick: () => { seen = 1; return true; } });
	rows.handle({ key: "ps", line: "2 processes", onClick: () => { seen = 2; return true; } });
	rows.clickHandlerAt(0)?.();
	assert.equal(seen, 2);
});

test("the contributor is told synchronously that the row was taken", () => {
	// How a contributor finds out this extension is loaded at all, rather than
	// emitting into the void.
	const rows = new ContributedRows();
	let accepted = false;
	rows.handle({ key: "ps", line: "x", reply: () => { accepted = true; } });
	assert.equal(accepted, true);
});

// ------------------------------------------------------- inline placement

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("an inline row joins the command's first row instead of taking one", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "ps", line: "3 processes", placement: "inline" });
	assert.deepEqual(rows.lines(), [], "内联行不应出现在追加行里");

	const line = rows.spliceInline(["~/repo │ main\tright side"]).lines[0]!;
	assert.equal(strip(line), "~/repo │ main │ 3 processes\tright side");
});

test("an inline row goes before the tab, so the right column stays right", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "ps", line: "1 process", placement: "inline" });
	const line = rows.spliceInline(["left\tright"]).lines[0]!;
	assert.equal(line.indexOf("1 process") < line.indexOf("\t"), true);
});

test("a first row with no tab still takes an inline row", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "ps", line: "2 processes", placement: "inline" });
	assert.equal(strip(rows.spliceInline(["just left"]).lines[0]!), "just left │ 2 processes");
});

test("the inline span covers the text and not the separator", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "ps", line: "3 processes", placement: "inline", onClick: () => true });
	const spliced = rows.spliceInline(["~/repo\tright"]);
	const line = spliced.lines[0]!;
	const spans = spliced.spans[0]!;
	assert.equal(spans.length, 1);
	// "~/repo" is 6 columns, " │ " is 3, so the text starts at 9.
	assert.equal(spans[0]!.from, 9);
	assert.equal(spans[0]!.to, 9 + "3 processes".length);
	assert.equal(strip(line).slice(spans[0]!.from, spans[0]!.to), "3 processes");
});

test("two inline rows get spans that do not overlap", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "a", line: "AA", placement: "inline", onClick: () => true });
	rows.handle({ key: "b", line: "BBB", placement: "inline", onClick: () => true });
	const spliced = rows.spliceInline(["x"]);
	const line = spliced.lines[0]!;
	const spans = spliced.spans[0]!;
	assert.equal(spans.length, 2);
	assert.ok(spans[0]!.to <= spans[1]!.from);
	assert.equal(strip(line).slice(spans[0]!.from, spans[0]!.to), "AA");
	assert.equal(strip(line).slice(spans[1]!.from, spans[1]!.to), "BBB");
});

test("withdrawing an inline row leaves the command's row untouched", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "ps", line: "3 processes", placement: "inline" });
	rows.handle({ key: "ps" });
	const spliced = rows.spliceInline(["~/repo\tright"]);
	assert.equal(spliced.lines[0], "~/repo\tright");
	assert.deepEqual(spliced.spans[0], []);
});

test("inline and appended rows coexist without being confused", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "goal", line: "goal row" });
	rows.handle({ key: "ps", line: "3 processes", placement: "inline" });
	assert.deepEqual(rows.lines(), ["goal row"]);
	assert.equal(rows.clickHandlerAt(0), undefined, "追加行的索引不应数上内联行");
	assert.match(strip(rows.spliceInline(["first"]).lines[0]!), /3 processes/);
});

test("an inline row can target a later command row", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "fast", line: "⚡fast", placement: "inline", row: 2 });
	const spliced = rows.spliceInline(["one\tright", "model stuff\tCH", "todo"]);
	assert.equal(spliced.lines[0], "one\tright", "第 1 行不应被动到");
	assert.equal(strip(spliced.lines[1]!), "model stuff │ ⚡fast\tCH");
	assert.equal(spliced.lines[2], "todo");
	assert.equal(spliced.spans[1]!.length, 1);
});

test("inline rows use the host-painted separator without shifting click columns", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "ps", line: "\x1b[2m2 processes\x1b[22m", placement: "inline", row: 3 });
	const spliced = rows.spliceInline(
		["project", "model", "todo"],
		"\x1b[2m │ \x1b[22m",
	);
	assert.equal(strip(spliced.lines[2]!), "todo │ 2 processes");
	assert.equal(spliced.spans[2]![0]!.from, 7);
	assert.equal(spliced.spans[2]![0]!.to, 18);
});

test("a target row beyond the command's rows clamps to the last row", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "goal", line: "goal", placement: "inline", row: 5 });
	const spliced = rows.spliceInline(["only\tright"]);
	assert.match(strip(spliced.lines[0]!), /goal/);
});

test("a right-aligned inline row retains its right-column click span", () => {
	const rows = new ContributedRows();
	let clicks = 0;
	rows.handle({
		key: "goal",
		line: "goal 3/5",
		placement: "inline",
		row: 3,
		align: "right",
		onClick: () => { clicks++; return true; },
	});
	const spliced = rows.spliceInline(["a\t", "b\t", "todo 1/2\t"]);
	const third = spliced.lines[2]!;
	assert.equal(third.indexOf("goal 3/5") > third.indexOf("\t"), true);
	assert.deepEqual(spliced.spans[2]?.map(({ from, to, align }) => ({ from, to, align })), [{
		from: 0,
		to: 8,
		align: "right",
	}]);
	assert.equal(spliced.spans[2]?.[0]?.onClick?.(), true);
	assert.equal(clicks, 1);
});

test("a right-aligned inline row creates the tab a left-only row lacks", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "goal", line: "goal", placement: "inline", align: "right" });
	const spliced = rows.spliceInline(["just left"]);
	assert.equal(spliced.lines[0], "just left\tgoal");
});

test("a slot contribution fills the command's marker in place", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "fast", line: "\u26a1", placement: "slot" });
	const out = rows.substituteSlots(["model xhigh [[pi:slot:fast]] | more\tright"]);
	assert.equal(out[0], "model xhigh \u26a1 | more\tright");
});

test("a command can cap a slot while preserving its click span", () => {
	const rows = new ContributedRows();
	let clicks = 0;
	rows.handle({
		key: "path-short",
		line: "very-long-directory",
		placement: "slot",
		onClick: () => { clicks++; return true; },
	});
	const composed = rows.composeSlots(["[[pi:slot:path-short@8]] │ model"]);
	assert.equal(strip(composed.lines[0]!), "very-lo… │ model");
	assert.equal(composed.spans[0]![0]!.from, 0);
	assert.equal(composed.spans[0]![0]!.to, 8);
	assert.equal(composed.spans[0]![0]!.onClick?.(), true);
	assert.equal(clicks, 1);
});

test("a left-column slot carries its click handler with exact columns", () => {
	const rows = new ContributedRows();
	let clicks = 0;
	rows.handle({
		key: "todo",
		line: "✓ todo 3/3",
		placement: "slot",
		onClick: () => { clicks++; return true; },
	});
	const composed = rows.composeSlots(["left [[pi:slot:todo]]\tright"]);
	assert.equal(strip(composed.lines[0]!), "left ✓ todo 3/3\tright");
	assert.equal(composed.spans[0]!.length, 1);
	assert.equal(composed.spans[0]![0]!.from, 5);
	assert.equal(composed.spans[0]![0]!.to, 15);
	assert.equal(composed.spans[0]![0]!.onClick?.(), true);
	assert.equal(clicks, 1);
});

test("a slot resolves a replacement click handler without a redraw", () => {
	const rows = new ContributedRows();
	let seen = 0;
	rows.handle({ key: "todo", line: "todo 1/2", placement: "slot", onClick: () => { seen = 1; return true; } });
	const composed = rows.composeSlots(["[[pi:slot:todo]]"]);
	assert.equal(
		rows.handle({ key: "todo", line: "todo 1/2", placement: "slot", onClick: () => { seen = 2; return true; } }),
		false,
	);
	composed.spans[0]![0]!.onClick?.();
	assert.equal(seen, 2);
});

test("a slot after the tab retains its right-column click span", () => {
	const rows = new ContributedRows();
	let clicks = 0;
	rows.handle({
		key: "cache-quality",
		line: "CH:90%",
		placement: "slot",
		onClick: () => { clicks++; return true; },
	});
	const composed = rows.composeSlots(["left\tright [[pi:slot:cache-quality]]"]);
	assert.deepEqual(composed.spans[0]?.map(({ from, to, align }) => ({ from, to, align })), [{
		from: 6,
		to: 12,
		align: "right",
	}]);
	assert.equal(composed.spans[0]?.[0]?.onClick?.(), true);
	assert.equal(clicks, 1);
});

test("an unfilled slot marker is stripped with its leading space", () => {
	const rows = new ContributedRows();
	const out = rows.substituteSlots(["model xhigh [[pi:slot:fast]] | more"]);
	assert.equal(out[0], "model xhigh | more");
});

test("withdrawing a slot restores the stripped marker form", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "fast", line: "\u26a1", placement: "slot" });
	rows.handle({ key: "fast" });
	const out = rows.substituteSlots(["a [[pi:slot:fast]] b"]);
	assert.equal(out[0], "a b");
});

test("slot contributions stay out of rows and inline splices", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "fast", line: "\u26a1", placement: "slot" });
	assert.deepEqual(rows.lines(), []);
	const spliced = rows.spliceInline(["left\tright"]);
	assert.equal(spliced.lines[0], "left\tright");
});

test("an inline segment on an empty left column takes no leading separator", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "ps", line: "proc 2", placement: "inline", row: 3 });
	const spliced = rows.spliceInline(["a", "b", "\tright"]);
	assert.equal(spliced.lines[2], "proc 2\tright");
	assert.equal(spliced.spans[2]![0]!.from, 0);
});

test("moving a row between placements is a redraw", () => {
	const rows = new ContributedRows();
	rows.handle({ key: "ps", line: "3 processes" });
	assert.equal(rows.handle({ key: "ps", line: "3 processes", placement: "inline" }), true);
});

for (const placement of ["row", "inline"] as const) {
	const layout = (rows: ContributedRows) => placement === "row" ? rows.lines() : rows.spliceInline([""]).lines[0].split(" │ ");
	const send = (rows: ContributedRows, key: string, order?: number) => rows.handle({ key, line: key, placement, order });
	test(`${placement}: ordered peers sort ascending, retaining arrival order for ties`, () => {
		const rows = new ContributedRows();
		send(rows, "b", 20); send(rows, "a", -10); send(rows, "c", 20);
		assert.deepEqual(layout(rows), ["a", "b", "c"]);
	});
	test(`${placement}: unnumbered peers retain first arrival when resent`, () => {
		const rows = new ContributedRows();
		send(rows, "b"); send(rows, "a"); send(rows, "b");
		assert.deepEqual(layout(rows), ["b", "a"]);
	});
	test(`${placement}: ordered peers precede unnumbered peers`, () => {
		const rows = new ContributedRows();
		send(rows, "u1"); send(rows, "b", 20); send(rows, "u2"); send(rows, "a", 10);
		assert.deepEqual(layout(rows), ["a", "b", "u1", "u2"]);
	});
	test(`${placement}: resending the same key updates or clears order and redraws`, () => {
		const rows = new ContributedRows();
		send(rows, "a", 10); send(rows, "b", 20);
		assert.equal(send(rows, "b", 5), true);
		assert.deepEqual(layout(rows), ["b", "a"]);
		assert.equal(send(rows, "b"), true);
		assert.deepEqual(layout(rows), ["a", "b"]);
		assert.equal(send(rows, "a"), true);
		assert.deepEqual(layout(rows), ["a", "b"], "clearing order restores original arrival order");
	});
}

test("inline ordering stays within the rendered row and alignment, with matching click spans", () => {
	const rows = new ContributedRows();
	const seen: string[] = [];
	for (const [key, row, align, order] of [["memory", 2, "left", 20], ["right-b", 2, "right", 2], ["first", 1, "left", 1], ["compact", 9, "left", 10], ["right-a", 2, "right", 1]] as const)
		rows.handle({ key, line: key, placement: "inline", row, align, order, onClick: () => { seen.push(key); return true; } });
	const result = rows.spliceInline(["one", "two\tright"]);
	assert.deepEqual(result.lines, ["one │ first", "two │ compact │ memory\tright │ right-a │ right-b"]);
	for (const span of result.spans[1]) span.onClick?.();
	assert.deepEqual(seen, ["compact", "memory", "right-a", "right-b"]);
	rows.handle({ key: "slot-b", line: "B", placement: "slot", order: -100 });
	rows.handle({ key: "slot-a", line: "A", placement: "slot", order: 100 });
	assert.deepEqual(rows.substituteSlots(["[[pi:slot:slot-a]] [[pi:slot:slot-b]]"]), ["A B"]);
});

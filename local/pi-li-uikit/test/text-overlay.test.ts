import { mouseInput } from "./mouse-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	TextPanel,
	TextOverlay,
	highlightSpan,
	parseMouseEvents,
	showTextPanel,
	stripAnsi,
} from "../src/text-overlay.ts";
import { createCustomSelectorHarness } from "./support.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

function overlay(
	body: string,
	rows = 24,
	onClose = () => {},
	overlayTheme: Theme = theme,
) {
	const tui = {
		terminal: { rows, columns: 100, write: () => {} },
		requestRender: () => {},
	} as unknown as TUI;
	return new TextPanel({
		tui,
		theme: overlayTheme,
		heading: "Goal status",
		body,
		format: "plain",
		tone: "text",
		overlay: { mouseScrollLines: 3 },
		placement: { anchor: "center", marginX: 0 },
		onClose,
	});
}

test("TextPanel uses an open frame with a titled accent rule and body spacing", () => {
	const rendered = overlay("Goal: ship it\n\nStatus: active").render(60).map(stripAnsi);
	assert.match(rendered[0]!, /^── ✻ Goal status ─+ 3 lines$/);
	assert.equal(rendered[1]!.trim(), "", "the title rule leaves one blank row before the body");
	assert.equal(rendered.at(-2)!.trim(), "", "the footer rule has one blank row after the body");
	assert.match(rendered.at(-1)!, /^─+ g\/G top\/bottom · y copy · Enter\/Esc close ──$/);
	assert.ok(rendered.every((line) => !/[│╭╮╰╯]/u.test(line)), "there are no side borders");
	const goal = rendered.findIndex((line) => line.includes("Goal: ship it"));
	const status = rendered.findIndex((line) => line.includes("Status: active"));
	assert.equal(status - goal, 2);
});

test("the complete top separator follows the accent colour", () => {
	const colours: Array<{ color: string; text: string }> = [];
	const recordingTheme = {
		...theme,
		fg: (color: string, text: string) => {
			colours.push({ color, text });
			return text;
		},
	} as unknown as Theme;
	overlay("one", 24, () => {}, recordingTheme).render(60);
	const accentText = colours
		.filter(({ color }) => color === "accent")
		.map(({ text }) => text)
		.join("");
	assert.match(accentText, /^── ✻ Goal status ─+$/);
});

test("the footer right-aligns the richest navigation hint that fits", () => {
	const wide = overlay("one").render(80).map(stripAnsi).at(-1)!;
	assert.match(wide, /^─+ ↑↓\/jk scroll · PgUp\/PgDn page · g\/G top\/bottom · y copy · Enter\/Esc close ──$/);
	const compact = overlay("one").render(40).map(stripAnsi).at(-1)!;
	assert.match(compact, /^─+ y copy · Enter\/Esc close ──$/);
	assert.ok(!compact.includes("↑↓/jk"));
});

test("an explicit body cap wraps short content and scrolls only past the cap", () => {
  const shortTui = {
    terminal: { rows: 42, columns: 100, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  const shortCapped = new TextPanel({
    tui: shortTui,
    theme,
    heading: "Capacity",
    body: "line 1\nline 2\nline 3",
    format: "plain",
    tone: "text",
    maxVisible: 18,
    overlay: { mouseScrollLines: 3 },
    placement: { anchor: "center", marginX: 0 },
    onClose: () => {},
  });
  assert.equal(shortCapped.render(60).length, 7, "three body rows plus open-panel chrome and footer spacer");

  const tui = {
    terminal: { rows: 42, columns: 100, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  const long = new TextPanel({
    tui,
    theme,
    heading: "Capacity",
    body: Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
    format: "plain",
    tone: "text",
    maxVisible: 18,
    overlay: { mouseScrollLines: 3 },
    placement: { anchor: "center", marginX: 0 },
    onClose: () => {},
  });
  const rendered = long.render(60).map(stripAnsi);
  assert.equal(rendered.length, 22, "18 body rows plus open-panel chrome and footer spacer");
  assert.ok(rendered.some((line) => line.includes("line 17")));
  assert.ok(!rendered.some((line) => line.includes("line 18")));
  long.handleInput("\x1b[B");
  const scrolled = long.render(60).map(stripAnsi);
  assert.ok(scrolled.some((line) => line.includes("line 18")), "content beyond the cap remains scrollable");
});

test("a mounted TextPanel can replace its document and request a render", () => {
	let renders = 0;
	const tui = {
		terminal: { rows: 24, columns: 100, write: () => {} },
		requestRender: () => { renders++; },
	} as unknown as TUI;
	const view = new TextPanel({
		tui,
		theme,
		heading: "Capacity",
		body: "State: Refreshing\nLoad: 113%",
		format: "plain",
		tone: "text",
		overlay: { mouseScrollLines: 3 },
		placement: { anchor: "center", marginX: 0 },
		onClose: () => {},
	});
	assert.ok(view.render(60).map(stripAnsi).some((line) => line.includes("Refreshing")));

	view.update({
		heading: "Capacity",
		body: "State: Current\nLoad: 119%",
		note: "12s",
		format: "plain",
		tone: "text",
	});
	const updated = view.render(60).map(stripAnsi);
	assert.equal(renders, 1);
	assert.match(updated[0]!, /Capacity ─+ 12s$/u);
	assert.ok(updated.some((line) => line.includes("Current")));
	assert.ok(updated.some((line) => line.includes("119%")));
	assert.ok(!updated.some((line) => line.includes("113%")));
});

test("TextPanel reports its first frame only after render returns", async () => {
	const order: string[] = [];
	const tui = {
		terminal: { rows: 24, columns: 100, write: () => {} },
		requestRender: () => {},
	} as unknown as TUI;
	const view = new TextPanel({
		tui,
		theme,
		heading: "Capacity",
		body: "State: Refreshing",
		format: "plain",
		tone: "text",
		overlay: { mouseScrollLines: 3 },
		placement: { anchor: "center", marginX: 0 },
		onClose: () => {},
		onFirstRender: () => order.push("first-render"),
	});
	view.render(60);
	order.push("render-returned");
	assert.deepEqual(order, ["render-returned"]);
	await Promise.resolve();
	assert.deepEqual(order, ["render-returned", "first-render"]);
	view.render(60);
	await Promise.resolve();
	assert.deepEqual(order, ["render-returned", "first-render"], "the signal fires once");
});

test("an explicit body cap still fits the shared floating height budget", () => {
	const tui = {
		terminal: { rows: 12, columns: 100, write: () => {} },
		requestRender: () => {},
	} as unknown as TUI;
	const view = new TextPanel({
		tui,
		theme,
		heading: "Short terminal",
		body: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
		format: "plain",
		tone: "text",
		maxVisible: 12,
		overlay: { mouseScrollLines: 3 },
		placement: { anchor: "center", marginX: 0 },
		onClose: () => {},
	});
	assert.ok(view.render(60).length <= Math.floor(12 * 0.75));
});

test("fullscreen keeps ownership of terminal mouse tracking", () => {
	const writes: string[] = [];
	const tui = {
		mode: "fullscreen",
		terminal: { rows: 24, columns: 100, write: (data: string) => writes.push(data) },
		requestRender: () => {},
	} as unknown as TUI;
	const view = new TextPanel({
		tui,
		theme,
		heading: "Fullscreen",
		body: "one",
		format: "plain",
		tone: "text",
		overlay: { mouseScrollLines: 3 },
		placement: { anchor: "editor", marginX: 0 },
		onClose: () => {},
	});
	view.setScreenOrigin(10, 0);
	view.dispose();
	assert.deepEqual(writes, []);
});

test("the footer keeps the regular muted hint tone", () => {
	const colours: Array<{ color: string; text: string }> = [];
	const recordingTheme = {
		...theme,
		fg: (color: string, text: string) => {
			colours.push({ color, text });
			return text;
		},
	} as unknown as Theme;
	overlay("one", 24, () => {}, recordingTheme).render(60);
	assert.ok(colours.some(({ color, text }) =>
		color === "muted" && text.includes("g/G top/bottom")
	));
	assert.ok(!colours.some(({ color, text }) =>
		color === "borderMuted" && text.includes("g/G top/bottom")
	));
});

test("the body defaults to normal conversation text", () => {
	const colours: Array<{ color: string; text: string }> = [];
	const recordingTheme = {
		...theme,
		fg: (color: string, text: string) => {
			colours.push({ color, text });
			return text;
		},
	} as unknown as Theme;
	const tui = {
		terminal: { rows: 24, columns: 100, write: () => {} },
		requestRender: () => {},
	} as unknown as TUI;
	new TextPanel({
		tui,
		theme: recordingTheme,
		heading: "Quiet body",
		body: "body text",
		format: "plain",
		overlay: { mouseScrollLines: 3 },
		placement: { anchor: "center", marginX: 0 },
		onClose: () => {},
	}).render(60);
	assert.ok(colours.some(({ color, text }) => color === "text" && text === "body text"));
	assert.ok(!colours.some(({ color, text }) => color === "thinkingText" && text === "body text"));
	assert.ok(!colours.some(({ color, text }) => color === "muted" && text === "body text"));
});

test("long plain text scrolls without losing the frame", () => {
	const view = overlay(Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"));
	assert.ok(view.render(60).map(stripAnsi).some((line) => line.includes("line 0")));
	view.handleInput("\x1b[6~");
	const rendered = view.render(60).map(stripAnsi);
	assert.ok(!rendered.some((line) => line.includes("line 0")));
	assert.match(rendered[0]!, /\d+-\d+\/100/);
	assert.ok(rendered.every((line) => !line.includes("│")), "the scrollbar has no track border");
});

test("escape and enter both close a text-only overlay", () => {
	let closed = 0;
	const escapeView = overlay("one", 24, () => closed++);
	escapeView.render(40);
	escapeView.handleInput("\x1b");
	const enterView = overlay("two", 24, () => closed++);
	enterView.render(40);
	enterView.handleInput("\r");
	assert.equal(closed, 2);
});

test("TextOverlay remains a compatibility alias of the unified TextPanel", () => {
	const tui = {
		terminal: { rows: 24, columns: 100, write: () => {} },
		requestRender: () => {},
	} as unknown as TUI;
	const legacy = new TextOverlay({
		tui,
		theme,
		heading: "Legacy",
		body: "one",
		format: "plain",
		overlay: { mouseScrollLines: 3 },
		placement: { anchor: "editor", marginX: 0 },
		onClose: () => {},
	});
	assert.ok(legacy instanceof TextPanel);
});

test("mouse decoding and selection highlighting remain part of the public overlay API", () => {
	assert.deepEqual(parseMouseEvents("\x1b[<65;10;5M"), [{
		kind: "wheel",
		button: 1,
		col: 9,
		row: 4,
		shift: false,
		alt: false,
		ctrl: false,
		wheel: 1,
	}]);
	const highlighted = highlightSpan("abcdefghij", 2, 5, 10);
	assert.equal(stripAnsi(highlighted), "abcdefghij");
	assert.ok(highlighted.includes("\x1b[7mcde\x1b[27m"));
});

test("showTextPanel floats at the editor position without replacing it", async () => {
	let options: unknown = "not called";
	let rendered: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			async custom(factory: unknown, customOptions?: unknown) {
				options = customOptions;
				const harness = createCustomSelectorHarness(factory, 40);
				rendered = harness.render().map(stripAnsi);
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		},
	};

	await showTextPanel(ctx as never, { title: "Goal status", body: "Goal: ship it", format: "plain" });
	assert.equal((options as { overlay?: unknown }).overlay, true);
	const overlayOptions = (options as { overlayOptions(): unknown }).overlayOptions();
	assert.deepEqual(overlayOptions, {
		anchor: "bottom-left",
		width: "100%",
		margin: { bottom: 0 },
	});
	assert.equal(rendered[0], " ".repeat(40), "the overlay clears one full row above its title rule");
	assert.equal(rendered[1]?.length, 40, "the title rule fills the editor width");
	assert.ok(rendered.some((line) => line.includes("Goal: ship it")));
});

test("showTextPanel is the canonical editor-position overlay helper", async () => {
	let rendered: string[] = [];
	let options: unknown;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			async custom(factory: unknown, customOptions?: unknown) {
				options = customOptions;
				const harness = createCustomSelectorHarness(factory, 40);
				rendered = harness.render().map(stripAnsi);
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		},
	};
	await showTextPanel(ctx as never, {
		title: "Session info",
		body: "ID: abc",
		format: "plain",
		glyph: "",
		maxVisible: 5,
	});
	assert.equal((options as { overlay?: unknown }).overlay, true);
	const overlayOptions = (options as { overlayOptions(): unknown }).overlayOptions();
	assert.deepEqual(overlayOptions, {
		anchor: "bottom-left",
		width: "100%",
		margin: { bottom: 0 },
	});
	assert.equal(rendered[0], " ".repeat(40));
	assert.match(rendered[1]!, /^── Session info ─+ 1 line$/);
	assert.ok(rendered.some((line) => line.includes("ID: abc")));
});

test("showTextPanel exposes its panel instance for live updates", async () => {
	let rendered: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			async custom(factory: unknown) {
				const harness = createCustomSelectorHarness(factory, 40);
				rendered = harness.render().map(stripAnsi);
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		},
	};
	await showTextPanel(ctx as never, {
		title: "Capacity",
		body: "cached",
		format: "plain",
	}, {
		onCreate(panel) {
			panel.update({ heading: "Capacity", body: "fresh", format: "plain" });
		},
	});
	assert.ok(rendered.some((line) => line.includes("fresh")));
	assert.ok(!rendered.some((line) => line.includes("cached")));
});

test("an editor-position panel accepts its absolute screen origin from the layout host", () => {
	let closed = 0;
	const tui = {
		terminal: { rows: 30, columns: 100, write: () => {} },
		requestRender: () => {},
	} as unknown as TUI;
	const view = new TextPanel({
		tui,
		theme,
		heading: "Session",
		body: "one",
		format: "plain",
		tone: "text",
		overlay: { mouseScrollLines: 3 },
		placement: { anchor: "editor", marginX: 0 },
		onClose: () => closed++,
	});
	view.render(40);
	view.setScreenOrigin(4, 0);

	mouseInput(view, "\x1b[<0;2;6M");
	assert.equal(closed, 0);
	mouseInput(view, "\x1b[<0;2;21M");
	assert.equal(closed, 1);
});

test("showTextPanel is a no-op outside interactive TUI sessions", async () => {
	let opened = false;
	await showTextPanel({
		mode: "rpc",
		hasUI: false,
		ui: { custom: async () => { opened = true; } },
	} as never, { title: "ignored", body: "ignored", format: "plain" });
	assert.equal(opened, false);
});

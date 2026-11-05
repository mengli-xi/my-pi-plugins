import { mouseInput } from "./mouse-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { EditorPanel, showEditorPanel } from "../src/editor-panel.ts";

function harness() {
	let closed = 0;
	let renders = 0;
	const panel = new EditorPanel<"a" | "b" | "c">({
		tui: { terminal: { rows: 24 }, requestRender: () => renders++ } as never,
		theme: {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		initialScreen: "a",
		getScreen: (id) => id === "a" ? {
			id,
			title: "A",
			breadcrumbs: [],
			search: true,
			items: [
				{ id: "one", label: "One" },
				{ id: "two", label: "Two", transition: { kind: "push", screen: "b" } },
			],
		} : {
			id,
			title: "B",
			breadcrumbs: ["A"],
			items: [{ id: "replace", label: "Replace", transition: { kind: "replace", screen: "c" } }],
		},
		onClose: () => closed++,
	});
	panel.focused = true;
	return { panel, get closed() { return closed; }, get renders() { return renders; } };
}

test("starts unfocused until the TUI mounts the panel", () => {
	const panel = new EditorPanel<"a">({
		tui: { terminal: { rows: 24 }, requestRender() {} } as never,
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
		initialScreen: "a",
		getScreen: () => ({ id: "a", title: "A", breadcrumbs: [], items: [] }),
		onClose() {},
	});
	assert.equal(panel.focused, false);
	panel.focused = true;
	assert.equal(panel.focused, true);
});

test("showEditorPanel lets Pi capture and restore the original editor focus", async () => {
	let editorText = "";
	let editorFocused = true;
	const editor: Component & {
		focused: boolean;
		getText(): string;
		setText(text: string): void;
		handleInput(data: string): void;
	} = {
		get focused() { return editorFocused; },
		set focused(value: boolean) { editorFocused = value; },
		getText: () => editorText,
		setText: (text) => { editorText = text; },
		handleInput: (data) => { if (editorFocused) editorText += data; },
		render: () => ["editor"],
		invalidate() {},
	};
	let focused: Component | null = editor;
	const setFocus = (component: Component | null): void => {
		if (focused && "focused" in focused) (focused as Component & { focused: boolean }).focused = false;
		focused = component;
		if (component && "focused" in component) (component as Component & { focused: boolean }).focused = true;
	};
	const tui = {
		children: [editor],
		mode: "tui",
		terminal: { rows: 24, columns: 80, write() {}, hideCursor() {} },
		requestRender() {},
		setFocus,
	} as unknown as TUI;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: (...args: unknown[]) => Component, options: { overlay?: boolean }) => {
				assert.equal(options.overlay, true);
				let component!: Component & { dispose?(): void; handleInput?(data: string): void };
				let preFocus!: Component | null;
				return new Promise<void>((resolve) => {
					const done = (): void => {
						if (focused === component) setFocus(preFocus);
						component.dispose?.();
						resolve();
					};
					component = factory(
						tui,
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						done,
					) as typeof component;
					// Pi captures this inside showOverlay(), after the factory returns.
					preFocus = focused;
					setFocus(component);
					component.handleInput?.("\x1b");
				});
			},
		},
	};

	await showEditorPanel(ctx as never, {
		initialScreen: "a" as const,
		getScreen: () => ({ id: "a" as const, title: "A", breadcrumbs: [], items: [] }),
	});
	focused?.handleInput?.("x");
	assert.strictEqual(focused, editor);
	assert.equal(editorText, "x");
});

test("A → B → Escape returns to A and restores its selection", () => {
	const view = harness();
	view.panel.handleInput("\x1b[B");
	view.panel.handleInput("\r");
	assert.equal(view.panel.currentScreenId, "b");
	assert.equal(view.panel.depth, 2);
	view.panel.handleInput("\x1b");
	assert.equal(view.panel.currentScreenId, "a");
	assert.ok(view.panel.render(80).some((line) => /^› Two/.test(line)));
});

test("root Escape and Ctrl+C close the entire invocation", () => {
	const escape = harness();
	escape.panel.handleInput("\x1b");
	assert.equal(escape.closed, 1);
	const ctrlC = harness();
	ctrlC.panel.handleInput("\x03");
	assert.equal(ctrlC.closed, 1);
});

test("outside click closes and consumes the EditorPanel mouse report", () => {
	let closed = 0;
	const writes: string[] = [];
	const panel = new EditorPanel<"a">({
		tui: {
			terminal: { rows: 30, columns: 80, write: (data: string) => writes.push(data) },
			requestRender() {},
			mode: "tui",
		} as never,
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
		initialScreen: "a",
		getScreen: () => ({ id: "a", title: "A", breadcrumbs: [], items: [{ id: "one", label: "One" }] }),
		onClose: () => { closed++; },
	});
	panel.focused = true;
	const lines = panel.render(60);
	panel.setScreenOrigin(10, 0);
	assert.equal(panel.wantsMouse, true);
	assert.deepEqual(writes, [], "Pi owns terminal mouse tracking");

	mouseInput(panel, "\x1b[<0;2;12M");
	assert.equal(closed, 0, "an inside click keeps the panel open");
	mouseInput(panel, "\x1b[<0;2;2M");
	assert.equal(closed, 1, "an outside click closes it");
	assert.ok(lines.length > 0);
	assert.deepEqual(writes, [], "Pi owns terminal mouse tracking");

	mouseInput(panel, "\x1b[<0;2;2M");
	assert.equal(closed, 1, "the consumed report cannot close twice");
});

test("replace changes the current screen without growing the stack", () => {
	const view = harness();
	view.panel.transition({ kind: "push", screen: "b" });
	view.panel.transition({ kind: "replace", screen: "c" });
	assert.equal(view.panel.currentScreenId, "c");
	assert.equal(view.panel.depth, 2);
});

test("search state, including bracketed paste, is restored per screen", () => {
	const view = harness();
	view.panel.handleInput("\x1b[200~Tw\x1b[201~");
	assert.ok(view.panel.render(80).some((line) => /Tw/.test(line)));
	view.panel.transition({ kind: "push", screen: "b" });
	view.panel.transition({ kind: "back" });
	assert.ok(view.panel.render(80).some((line) => /Tw/.test(line)));
});

test("uses the shared accent title, body spacing, conversation text, and right hints", () => {
	const colours: Array<{ color: string; text: string }> = [];
	const panel = new EditorPanel<"a">({
		tui: { terminal: { rows: 24 }, requestRender() {} } as never,
		theme: {
			fg: (color: string, text: string) => {
				colours.push({ color, text });
				return text;
			},
			bold: (text: string) => text,
		} as never,
		initialScreen: "a",
		getScreen: (id) => ({
			id,
			title: "Components",
			breadcrumbs: [],
			items: [{ id: "one", label: "One" }, { id: "two", label: "Two" }],
		}),
		onClose() {},
	});
	const rows = panel.render(60);
	assert.match(rows[0]!, /^── Components ─+$/);
	assert.equal(rows[1], "");
	assert.match(rows.at(-1)!, /^─+ Enter select · Esc back · Ctrl\+C close ──$/);
	assert.ok(colours.some(({ color, text }) => color === "text" && text.includes("Two")));
});

test("clips every rendered row to the available terminal width", () => {
	const panel = new EditorPanel<"a">({
		tui: { terminal: { rows: 24 }, requestRender() {} } as never,
		theme: {
			fg: (color: string, text: string) => `\x1b[3${color.length % 8}m${text}\x1b[39m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		} as never,
		initialScreen: "a",
		getScreen: (id) => ({
			id,
			title: "A title that is wider than the terminal",
			breadcrumbs: [],
			presentation: "selector",
			statusLine: "4 dialogue messages · tools omitted · selection prunes later JSONL entries",
			items: [{
				id: "one",
				label: "A very long item label",
				description: "with a long description",
				detail: "A detail that is also wider than the terminal",
			}],
		}),
		onClose() {},
	});

	for (const width of [60, 20, 8, 1]) {
		const rows = panel.render(width);
		assert.ok(rows.length > 0);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `${visibleWidth(row)} > ${width}: ${row}`);
	}
});

test("uses up to eight columns between aligned labels and descriptions, then narrows smoothly", () => {
	const panel = new EditorPanel<"a">({
		tui: { terminal: { rows: 24 }, requestRender() {} } as never,
		theme: {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		initialScreen: "a",
		getScreen: (id) => ({
			id,
			title: "Components",
			breadcrumbs: [],
			items: [
				{ id: "short", label: "Short", description: "Alphas" },
				{ id: "long", label: "Long title", description: "Betaaa" },
			],
		}),
		onClose() {},
	});
	const wide = panel.render(60);
	const wideShort = wide.find((row) => row.includes("Alphas"))!;
	const wideLong = wide.find((row) => row.includes("Betaaa"))!;
	assert.match(wideShort, /^› Short {13}Alphas$/);
	assert.match(wideLong, /^  Long title {8}Betaaa$/);
	assert.equal(wideShort.indexOf("Alphas"), wideLong.indexOf("Betaaa"));

	const medium = panel.render(21);
	const mediumShort = medium.find((row) => row.includes("Alphas"))!;
	const mediumLong = medium.find((row) => row.includes("Betaaa"))!;
	assert.match(mediumShort, /^› Short {8}Alphas$/);
	assert.match(mediumLong, /^  Long title {3}Betaaa$/);
	assert.equal(mediumShort.indexOf("Alphas"), mediumLong.indexOf("Betaaa"));

	const narrow = panel.render(20);
	const narrowShort = narrow.find((row) => row.includes("Alphas"))!;
	const narrowLong = narrow.find((row) => row.includes("Betaaa"))!;
	assert.match(narrowShort, /^› Short {7}Alphas$/);
	assert.match(narrowLong, /^  Long title {2}Betaaa$/);
	assert.equal(narrowShort.indexOf("Alphas"), narrowLong.indexOf("Betaaa"));
});

test("disposing aborts pending actions so they cannot transition stale UI", async () => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const panel = new EditorPanel<"a" | "b">({
		tui: { terminal: { rows: 24 }, requestRender() {} } as never,
		theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never,
		initialScreen: "a",
		getScreen: (id) => ({ id, title: "A", breadcrumbs: [], items: [{
			id: "go",
			label: "Go",
			onSelect: async () => { await pending; return { kind: "push", screen: "b" as const }; },
		}] }),
		onClose() {},
	});
	panel.focused = true;
	panel.handleInput("\r");
	panel.dispose();
	release();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(panel.currentScreenId, "a");
});

test("action failures stay inside the panel and disposing resolves its invocation", async () => {
	let closed = 0;
	const panel = new EditorPanel<"a">({
		tui: { terminal: { rows: 24 }, requestRender() {} } as never,
		theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never,
		initialScreen: "a",
		getScreen: (id) => ({ id, title: "A", breadcrumbs: [], items: [{
			id: "fail",
			label: "Fail",
			onSelect: async () => { throw new Error("action failed safely"); },
		}] }),
		onClose: () => { closed++; },
	});
	panel.focused = true;
	panel.handleInput("\r");
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(panel.render(80).some((line) => line.includes("action failed safely")));
	panel.dispose();
	assert.equal(closed, 1);
});

test("rendered item hit identity follows scrolling and remains independent of clipped labels",()=>{
 const items=Array.from({length:20},(_,index)=>({id:`id-${index}`,label:index?`worker${index}`:"worker",disabled:index===4}));
 const panel=new EditorPanel({tui:{requestRender(){}} as any,theme:{fg:(_c:string,s:string)=>s,bold:(s:string)=>s} as any,initialScreen:"list",maxVisible:3,getScreen:()=>({id:"list",title:"List",breadcrumbs:[],items}),onClose(){}});
 panel.focused=true;
 try{
  for(let index=0;index<5;index++)panel.handleInput("\x1b[B");
  panel.render(4);
  assert.deepEqual(panel.getRenderedItemAt(2,1),{id:"id-3",disabled:false});
  assert.deepEqual(panel.getRenderedItemAt(3,1),{id:"id-4",disabled:true});
  assert.deepEqual(panel.getRenderedItemAt(4,1),{id:"id-5",disabled:false});
  for(const [row,col] of [[1,1],[5,1],[2,-1],[2,4],[2.5,1]])assert.equal(panel.getRenderedItemAt(row!,col!),undefined);
  panel.handleInput("\x1b[B");assert.equal(panel.getRenderedItemAt(2,1),undefined);
  panel.render(4);assert.equal(panel.getRenderedItemAt(2,1)?.id,"id-4");
  panel.invalidate();assert.equal(panel.getRenderedItemAt(2,1),undefined);
 }finally{panel.dispose();}
 assert.equal(panel.getRenderedItemAt(2,1),undefined);
});

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import "./doubles/register.ts";

const configUrl = new URL("../config.ts", import.meta.url).href;
const hook = registerHooks({ load(url, context, nextLoad) {
	if (url === configUrl) return { format: "module", shortCircuit: true, source: `
		export const COLLAPSE_KEY_OFF = "off", DEFAULT_COLLAPSE_KEY = "ctrl+]", DEFAULT_NOTES_KEY = "n";
		export const loadConfig = () => ({}), validateGuidanceFields = () => ({});
		export const resolveCollapseKey = () => "ctrl+]", resolveNotesKey = () => "n";
		export const formatKeySpecForDisplay = x => x, formatNotesKeyForDisplay = x => x;
	` };
	return nextLoad(url, context);
} });
const { registerAskUserQuestionTool } = await import("../ask-user-question.ts");
hook.deregister();

test("inline stays inline; concurrent overlay mounts yield visuals and collapse keys to native dialogs", { timeout: 3000 }, async () => {
	let tool: any;
	registerAskUserQuestionTool({ registerTool: (value: any) => { tool = value; }, events: { on() {}, emit() {} }, on() {} } as never);
	const params = { context: "Choose when checkout updates; live refresh shows a discount immediately.", questions: [{ question: "When should checkout refresh?", header: "Refresh", options: [
		{ label: "Live", description: "While open." }, { label: "On reopen", description: "When reopened." },
	] }] };
	const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
	let focus: any = null;
	const tui = { terminal: { rows: 40, columns: 120 }, children: [], requestRender() {}, hasOverlay: () => false, getFocusedComponent: () => focus };
	const mounted: any[] = [];
	const arrivals = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let listener: (data: string) => any;
	let removals = 0;
	let hidden = false;
	const ctx = { hasUI: true, ui: {
		onTerminalInput: (fn: any) => { listener = fn; return () => { removals++; }; },
		custom: (factory: any, options: any) => new Promise(resolve => {
			const component = factory(tui, theme, { matches: () => false }, resolve);
			mounted.push({ component, options, done: resolve });
			arrivals[mounted.length - 1].resolve();
			focus = component;
			options.onHandle?.({ isHidden: () => hidden, isFocused: () => focus === component, setHidden: (value: boolean) => { hidden = value; focus = value ? mounted[0].component : component; } });
		}),
	} };
	const first = tool.execute("inline", params, undefined, undefined, ctx);
	await arrivals[0].promise;
	assert.equal(mounted[0]?.options.overlay, false);
	const controller = new AbortController();
	const second = tool.execute("overlay", params, controller.signal, undefined, ctx);
	await arrivals[1].promise;
	assert.equal(mounted[1]?.options.overlay, true);
	const visible = mounted[1].options.overlayOptions.visible;
	assert.equal(visible(), true);
	focus = { render: () => ["NATIVE_DIALOG"] };
	assert.equal(visible(), false);
	assert.equal(listener!("\x1d"), undefined, "a native dialog owns the collapse key too");
	assert.equal(hidden, false);
	focus = mounted[1].component;
	assert.deepEqual(listener!("\x1d"), { consume: true });
	assert.equal(hidden, true);
	focus = { render: () => ["NATIVE_DIALOG"] };
	assert.equal(listener!("\x1d"), undefined, "a hidden overlay cannot reopen over a native dialog");
	assert.equal(hidden, true);
	focus = mounted[0].component;
	assert.deepEqual(listener!("\x1d"), { consume: true });
	assert.equal(hidden, false);
	controller.abort();
	await second;
	assert.equal(removals, 1);
	mounted[0].done({ answers: [], cancelled: true });
	await first;
});

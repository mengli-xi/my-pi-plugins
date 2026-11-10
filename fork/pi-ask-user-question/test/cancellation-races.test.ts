import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";
import "./doubles/register.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
const params = { context: "Choose how checkout updates; live refresh shows a discount immediately.", questions: [{
	question: "When should checkout refresh?", header: "Refresh", options: [
		{ label: "Live", description: "Update immediately." }, { label: "On reopen", description: "Update after reopening." },
	],
}] };
const configUrl = new URL("../config.ts", import.meta.url).href;
const hooks = registerHooks({ load(url, context, nextLoad) {
	if (url === configUrl) return { format: "module", shortCircuit: true, source: `
		export const COLLAPSE_KEY_OFF = "off", DEFAULT_COLLAPSE_KEY = "ctrl+]", DEFAULT_NOTES_KEY = "n";
		export const loadConfig = () => ({}), validateGuidanceFields = () => ({});
		export const resolveCollapseKey = () => "ctrl+]", resolveNotesKey = () => "n";
		export const formatKeySpecForDisplay = x => x, formatNotesKeyForDisplay = x => x;
	` };
	return nextLoad(url, context);
} });
const { registerAskUserQuestionTool } = await import("../ask-user-question.ts");
hooks.deregister();
const { ASK_USER_ANSWER_EVENT, ASK_USER_ANSWER_RESULT_EVENT, ASK_USER_BLOCKED_EVENT } = await import("../events.ts");
function fixture() {
	let tool: any;
	const events: Array<{ name: string; data: any }> = [];
	const listeners = new Map<string, (value: any) => void>();
	const lifecycle = new Map<string, () => void>();
	const pi = { registerTool: (value: any) => { tool = value; }, on: (name: string, fn: () => void) => { lifecycle.set(name, fn); }, events: {
		on: (name: string, fn: (value: any) => void) => { listeners.set(name, fn); },
		emit: (name: string, data: any) => { events.push({ name, data }); listeners.get(name)?.(data); },
	} };
	registerAskUserQuestionTool(pi as never);
	return { tool, pi, events, lifecycle };
}
const theme = { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value, bold: (value: string) => value };
const tui = { children: [], terminal: { rows: 40, columns: 120 }, requestRender() {}, getFocusedComponent() { return null; }, hasOverlay() { return false; } };

// A controlled module delays only the asynchronous import; the actual execute,
// first-answer gate, events, presentation and mount teardown stay real.
test("cancel during cold import returns promptly; late import cannot mount or accept answers", { timeout: 3000 }, async (t) => {
	const gate = deferred<void>();
	const key = `ask-session-${Date.now()}`;
	(globalThis as any)[key] = gate.promise;
	const source = `await globalThis[${JSON.stringify(key)}]; export class QuestionnaireSession { constructor() { throw new Error("late session construction"); } }`;
	const delayed = registerHooks({ resolve(specifier, context, nextResolve) {
		if (specifier === "./state/questionnaire-session.ts") return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
		return nextResolve(specifier, context);
	} });
	t.after(() => { delayed.deregister(); gate.resolve(); delete (globalThis as any)[key]; });
	const f = fixture();
	const controller = new AbortController();
	let mounts = 0;
	const pending = f.tool.execute("cold-abort", params, controller.signal, undefined, { hasUI: true, ui: { custom: async () => { mounts++; } } });
	await tick();
	controller.abort();
	assert.deepEqual((await pending).details, { answers: [], cancelled: true });
	f.pi.events.emit(ASK_USER_ANSWER_EVENT, { toolCallId: "cold-abort", cancel: true });
	assert.equal(f.events.at(-1)?.name, ASK_USER_ANSWER_RESULT_EVENT);
	assert.equal(f.events.at(-1)?.data.code, "not_found");
	gate.resolve();
	await tick();
	assert.equal(mounts, 0);
	assert.deepEqual(f.events.filter(e => e.name === ASK_USER_BLOCKED_EVENT).map(e => e.data.active), [true, false]);
});

test("a late overlay mount is inert and its terminal listener is removed at cancellation", { timeout: 3000 }, async () => {
	const f = fixture();
	const firstMounted = deferred<void>();
	let firstDone!: (result: any) => void;
	const first = f.tool.execute("inline-holder", params, undefined, undefined, { hasUI: true, ui: { custom: (factory: any) => new Promise(resolve => {
		firstDone = resolve;
		factory(tui, theme, { matches: () => false }, resolve);
		firstMounted.resolve();
	}) } });
	await firstMounted.promise;
	const requested = deferred<void>();
	let lateFactory: any;
	let lateDone = 0;
	let removed = 0;
	const controller = new AbortController();
	const second = f.tool.execute("overlay-late", params, controller.signal, undefined, { hasUI: true, ui: {
		onTerminalInput: () => () => { removed++; },
		custom: (factory: any, options: any) => { assert.equal(options.overlay, true); lateFactory = factory; requested.resolve(); return new Promise(() => {}); },
	} });
	await requested.promise;
	controller.abort();
	assert.deepEqual((await second).details, { answers: [], cancelled: true });
	assert.equal(removed, 1, "cleanup must not wait for an absent factory");
	const inert = lateFactory(tui, theme, {}, () => { lateDone++; });
	assert.deepEqual(inert.render(100), []);
	assert.equal(lateDone, 1);
	firstDone({ answers: [], cancelled: true });
	await first;
});

test("cancel while external-editor import is pending cannot stop or restart the old TUI", { timeout: 3000 }, async (t) => {
	const gate = deferred<void>();
	const key = `ask-editor-${Date.now()}`;
	(globalThis as any)[key] = gate.promise;
	let launched = 0;
	(globalThis as any)[`${key}-launch`] = () => { launched++; };
	const delayed = registerHooks({ resolve(specifier, context, nextResolve) {
		if (specifier === "./state/external-editor.ts") return { url: `data:text/javascript,${encodeURIComponent(`await globalThis[${JSON.stringify(key)}]; export const editWithExternalEditor = () => globalThis[${JSON.stringify(`${key}-launch`)}]();`)}`, shortCircuit: true };
		return nextResolve(specifier, context);
	} });
	t.after(() => { delayed.deregister(); gate.resolve(); delete (globalThis as any)[key]; delete (globalThis as any)[`${key}-launch`]; });
	const f = fixture();
	const mounted = deferred<void>();
	const controller = new AbortController();
	let component: any;
	const pending = f.tool.execute("editor-import", params, controller.signal, undefined, { hasUI: true, ui: { custom: (factory: any) => new Promise(resolve => {
		component = factory(tui, theme, { matches: (data: string, name: string) => data === "\x07" && name === "app.editor.external" }, resolve);
		mounted.resolve();
	}) } });
	await mounted.promise;
	component.handleInput("3");
	component.handleInput("\x07");
	await tick();
	controller.abort();
	await pending;
	gate.resolve();
	await tick();
	assert.equal(launched, 0);
});

test("an external answer accepted after undefined mount wins over RPC fallback", { timeout: 3000 }, async () => {
	const f = fixture();
	let fallbackCalls = 0;
	const result = await f.tool.execute("undefined-race", params, undefined, undefined, { hasUI: true, ui: {
		custom: () => {
			const unsupported = Promise.resolve(undefined);
			void unsupported.then(() => queueMicrotask(() => f.pi.events.emit(ASK_USER_ANSWER_EVENT, {
				toolCallId: "undefined-race", requestId: "accepted", answers: [{ questionIndex: 0, optionIndexes: [0] }],
			})));
			return unsupported;
		},
		select: async (_title: string, options: string[]) => { fallbackCalls++; return options[1]; },
		input: async () => { fallbackCalls++; return "fallback"; },
	} });
	assert.deepEqual(f.events.find(event => event.name === ASK_USER_ANSWER_RESULT_EVENT)?.data, {
		ok: true, requestId: "accepted", toolCallId: "undefined-race",
	});
	assert.equal(fallbackCalls, 0, "a successful first-answer verdict must not open another dialog");
	assert.equal(result.details.answers[0].answer, "Live");
	assert.equal(result.details.cancelled, false);
});

test("external editor restores once during abort/replacement, never from late child completion", async (t) => {
	const key = `ask-child-${Date.now()}`;
	let child!: EventEmitter;
	(globalThis as any)[key] = () => { child = new EventEmitter(); return child; };
	const childHook = registerHooks({ resolve(specifier, context, nextResolve) {
		if (specifier === "node:child_process") return { url: `data:text/javascript,${encodeURIComponent(`export const spawn = (...args) => globalThis[${JSON.stringify(key)}](...args);`)}`, shortCircuit: true };
		return nextResolve(specifier, context);
	} });
	t.after(() => { childHook.deregister(); delete (globalThis as any)[key]; });
	const { editWithExternalEditor } = await import("../state/external-editor.ts");
	for (const replacement of [false, true]) {
		const calls: string[] = [];
		const controller = new AbortController();
		const pending = editWithExternalEditor({ stop: () => { calls.push("stop"); }, start: () => { calls.push("start"); }, requestRender: () => { calls.push("render"); } }, "fixture-editor", "draft", controller.signal);
		controller.abort(replacement ? "session_shutdown" : undefined);
		assert.deepEqual(calls, ["stop", "start", "render"]);
		child.emit("close", 0, null);
		assert.equal(await pending, undefined);
		assert.deepEqual(calls, ["stop", "start", "render"], "late completion must not restart the old renderer");
	}
});

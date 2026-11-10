import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import "./doubles/register.ts";

const params = {
	context: "Choose when checkout totals refresh; live updates show the discount immediately.",
	questions: [{ question: "When should totals refresh?", header: "Refresh", options: [
		{ label: "Live", description: "While open." }, { label: "On reopen", description: "On reopening." },
	] }],
};
const cancel = { answers: [], cancelled: true };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

// Config is isolated; no machine-local settings, real terminal, or provider is used.
const configUrl = new URL("../config.ts", import.meta.url).href;
const hooks = registerHooks({
	load(url, context, nextLoad) {
		if (url === configUrl) return { format: "module", shortCircuit: true, source: `
			export const COLLAPSE_KEY_OFF = "off";
			export const DEFAULT_COLLAPSE_KEY = "ctrl+]";
			export const DEFAULT_NOTES_KEY = "n";
			export const loadConfig = () => ({});
			export const validateGuidanceFields = () => ({});
			export const resolveCollapseKey = () => "ctrl+]";
			export const resolveNotesKey = () => "n";
			export const formatKeySpecForDisplay = x => x;
			export const formatNotesKeyForDisplay = x => x;
		` };
		return nextLoad(url, context);
	},
});
const { registerAskUserQuestionTool } = await import("../ask-user-question.ts");
const { ASK_USER_ANSWER_EVENT, ASK_USER_ANSWER_RESULT_EVENT, ASK_USER_BLOCKED_EVENT } = await import("../events.ts");
hooks.deregister();

function fixture() {
	let tool: any;
	const events: Array<{ name: string; data: any }> = [];
	const listeners = new Map<string, (data: any) => void>();
	const lifecycle = new Map<string, () => void>();
	const pi = {
		registerTool: (definition: any) => { tool = definition; },
		on: (name: string, listener: () => void) => { lifecycle.set(name, listener); },
		events: {
			on: (name: string, listener: (data: any) => void) => { listeners.set(name, listener); },
			emit: (name: string, data: any) => { events.push({ name, data }); listeners.get(name)?.(data); },
		},
	};
	registerAskUserQuestionTool(pi as never);
	return { tool, pi, events, lifecycle };
}
function assertBalanced(events: Array<{ name: string; data: any }>) {
	assert.deepEqual(events.filter(e => e.name === ASK_USER_BLOCKED_EVENT).map(e => e.data.active), [true, false]);
}

test("RPC cancellation passes the public dialog signal and closes the wait", { timeout: 3000 }, async () => {
	const f = fixture();
	const controller = new AbortController();
	let dialogSignal: AbortSignal | undefined;
	const pending = f.tool.execute("rpc-cancel", params, controller.signal, undefined, {
		hasUI: true, mode: "rpc", ui: {
			select: (_title: string, _options: string[], options: { signal?: AbortSignal } = {}) => {
				dialogSignal = options.signal;
				return new Promise(resolve => options.signal?.addEventListener("abort", () => resolve(undefined), { once: true }));
			}, input: async () => { throw new Error("late input"); },
		},
	});
	await tick();
	controller.abort();
	await tick();
	assert.equal(dialogSignal?.aborted, true, "execute must forward cancellation to the dialog");
	assert.deepEqual((await pending).details, cancel);
	assertBalanced(f.events);
});

test("aborted calls never mount, and late external answers are refused", async () => {
	const f = fixture();
	const controller = new AbortController();
	controller.abort();
	let mounts = 0;
	const result = await f.tool.execute("before-mount", params, controller.signal, undefined, {
		hasUI: true, mode: "tui", ui: { custom: async () => { mounts++; return cancel; } },
	});
	assert.equal(mounts, 0);
	assert.deepEqual(result.details, cancel);
	f.pi.events.emit(ASK_USER_ANSWER_EVENT, { toolCallId: "before-mount", cancel: true });
	assert.equal(f.events.at(-1)?.data.code, "not_found");
});

test("cancel and session replacement close mounted UI once and remove listeners", { timeout: 3000 }, async () => {
	for (const replace of [false, true]) {
		const f = fixture();
		const controller = new AbortController();
		const mounted = deferred<void>();
		let finishCount = 0;
		let removed = 0;
		let component: any;
		const pending = f.tool.execute(`mounted-${replace}`, params, controller.signal, undefined, {
			hasUI: true, mode: "tui", ui: {
				onTerminalInput: () => () => { removed++; },
				custom: (factory: any) => new Promise(resolve => {
					const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {}, getFocusedComponent() { return component; }, hasOverlay() { return false; } };
					component = factory(tui, { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value, bold: (value: string) => value }, { matches: () => false }, (value: any) => { finishCount++; resolve(value); });
					mounted.resolve();
				}),
			},
		});
		await Promise.race([mounted.promise, pending.then((result: any) => { throw new Error(`UI did not mount: ${JSON.stringify(result)}`); })]);
		if (replace) f.lifecycle.get("session_shutdown")?.(); else controller.abort();
		await tick();
		assert.equal(finishCount, 1, "cancellation must finish the host UI, not leave it mounted");
		assert.deepEqual((await pending).details, cancel);
		assert.ok(removed <= 1, "listener cleanup is paired with registration");
		assert.deepEqual(component.render(100), [], "a disposed session must not repaint old UI");
		component.handleInput("\r");
		f.pi.events.emit(ASK_USER_ANSWER_EVENT, { toolCallId: `mounted-${replace}`, cancel: true });
		assert.equal(f.events.at(-1)?.name, ASK_USER_ANSWER_RESULT_EVENT);
		assert.equal(f.events.at(-1)?.data.code, "not_found");
		assert.equal(finishCount, 1);
		assertBalanced(f.events);
	}
});

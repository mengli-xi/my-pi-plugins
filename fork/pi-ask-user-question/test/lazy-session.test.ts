import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("jiti merges concurrent cold TUI loads and supports subsequent serial calls", () => {
	// A fresh process avoids both the native ESM cache and ts-resolve's peer
	// doubles, exercising the actual loader/peers used by Pi without opening UI.
	execFileSync(process.execPath, ["--input-type=module", "--eval", `
		import assert from "node:assert/strict";
		import { createJiti } from "jiti";
		const jiti = createJiti(import.meta.url, {
			moduleCache: false, fsCache: false,
			virtualModules: { "./config.ts": {
				loadConfig: () => ({}), validateGuidanceFields: () => ({}),
				COLLAPSE_KEY_OFF: "off", DEFAULT_COLLAPSE_KEY: "ctrl+]", DEFAULT_NOTES_KEY: "n",
				formatKeySpecForDisplay: key => key, formatNotesKeyForDisplay: key => key,
				resolveCollapseKey: () => "off", resolveNotesKey: () => "n",
			} },
		});
		const mod = await jiti.import("./ask-user-question.ts");
		let tool;
		mod.registerAskUserQuestionTool({
			registerTool: definition => { tool = definition; }, events: { emit() {}, on() {} }, on() {},
		});
		const params = {
			context: "Choose when checkout totals refresh; live updates show the discount immediately.",
			questions: [{ question: "When should totals refresh?", header: "Refresh", options: [
				{ label: "Live", description: "While open." },
				{ label: "On reopen", description: "On reopening." },
			] }],
		};
		let customCalls = 0;
		const ctx = { hasUI: true, ui: { custom: async () => {
			customCalls++; return { answers: [], cancelled: true };
		} } };
		const invoke = id => tool.execute(id, params, undefined, undefined, ctx);
		const cold = await Promise.all([invoke("cold-1"), invoke("cold-2"), invoke("cold-3")]);
		assert.deepEqual(cold.map(result => result.details), [
			{ answers: [], cancelled: true },
			{ answers: [], cancelled: true },
			{ answers: [], cancelled: true },
		]);
		assert.equal(customCalls, 3);
		for (const id of ["warm-1", "warm-2"]) {
			assert.deepEqual((await invoke(id)).details, { answers: [], cancelled: true });
		}
		assert.equal(customCalls, 5);
	`], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000 });
});

test("registration stays cold through idle time; the first TUI call loads the questionnaire", async (t) => {
	const sessionUrl = new URL("../state/questionnaire-session.ts", import.meta.url).href;
	const builderUrl = new URL("../state/build-questionnaire.ts", import.meta.url).href;
	const configUrl = new URL("../config.ts", import.meta.url).href;
	const loaded = new Set<string>();
	const hooks = registerHooks({
		load(url, context, nextLoad) {
			loaded.add(url);
			// Isolate machine-local config and its source-only npm dependency. All
			// questionnaire modules, including the dynamically imported graph, are real.
			if (url === configUrl) return {
				format: "module", shortCircuit: true,
				source: `export const loadConfig = () => ({});
					export const validateGuidanceFields = () => ({});
					export const COLLAPSE_KEY_OFF = "off";
					export const DEFAULT_COLLAPSE_KEY = "ctrl+]";
					export const DEFAULT_NOTES_KEY = "n";
					export const formatKeySpecForDisplay = key => key;
					export const formatNotesKeyForDisplay = key => key;
					export const resolveNotesKey = () => "n";
					export const resolveCollapseKey = () => "off";`,
			};
			return nextLoad(url, context);
		},
	});
	t.after(() => hooks.deregister());
	t.mock.timers.enable({ apis: ["setTimeout"] });

	const { registerAskUserQuestionTool, loadQuestionnaireSession } = await import("../ask-user-question.ts");
	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	registerAskUserQuestionTool({
		registerTool: (definition) => { tool = definition; },
		events: { emit: () => {}, on: () => {} },
		on: () => {},
	} as unknown as ExtensionAPI);
	assert.ok(tool);
	assert.equal(loaded.has(sessionUrl), false);
	assert.equal(loaded.has(builderUrl), false);
	// Advance beyond the removed two-second prewarm and let any queued import run.
	t.mock.timers.tick(10_000);
	await setImmediate();
	assert.equal(loaded.has(sessionUrl), false, "idle registration must not load the session");
	assert.equal(loaded.has(builderUrl), false, "idle registration must not load the view graph");

	let customCalls = 0;
	const result = await tool.execute("first-question", {
		context: "Choose when checkout totals refresh. Live updates show a new discount immediately.",
		questions: [{
			question: "When should totals refresh?", header: "Refresh",
			options: [
				{ label: "Live", description: "Update while the page is open." },
				{ label: "On reopen", description: "Update when the page opens again." },
			],
		}],
	}, undefined, undefined, {
		hasUI: true,
		ui: { custom: async () => { customCalls++; return { answers: [], cancelled: true }; } },
	} as never);
	assert.equal(loaded.has(sessionUrl), true);
	assert.equal(loaded.has(builderUrl), true);
	assert.equal(customCalls, 1, "the real session module must load successfully before custom UI opens");
	assert.equal(result.details?.cancelled, true);
	assert.equal(result.details?.error, undefined);

	// Inject each original failure shape, then a repaired module. A failure must
	// release the in-flight promise so the next call actually retries the import.
	const outcomes = [
		'throw new Error("transient import failure");',
		'export const unrelated = true;',
		'export class QuestionnaireSession {}',
	].map((source) => `data:text/javascript,${encodeURIComponent(source)}`);
	let attempts = 0;
	const failureHooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "./state/questionnaire-session.ts" &&
				context.parentURL === new URL("../ask-user-question.ts", import.meta.url).href) {
				return { url: outcomes[Math.min(attempts++, outcomes.length - 1)], shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	t.after(() => failureHooks.deregister());
	for (const error of ["session_load_failed", "stale_module_cache"]) {
		const batch = await Promise.all([
			loadQuestionnaireSession(), loadQuestionnaireSession(), loadQuestionnaireSession(),
		]);
		for (const load of batch) {
			assert.equal(load.ok, false);
			if (!load.ok) assert.equal(load.error, error);
		}
	}
	assert.equal(attempts, 2, "each failed concurrent batch must perform one import");
	assert.equal((await loadQuestionnaireSession()).ok, true, "a later call can retry successfully");
	assert.equal(attempts, 3);
});

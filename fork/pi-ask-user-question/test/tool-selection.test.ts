import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Reconciliation needs only the tool name, not the UI graph or config reader.
const toolUrl = new URL("../ask-user-question.ts", import.meta.url).href;
const hook = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "./ask-user-question.ts" && context.parentURL === new URL("../reconcile.ts", import.meta.url).href) {
			return { url: toolUrl, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === toolUrl) return {
			format: "module", shortCircuit: true,
			source: 'export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";',
		};
		return nextLoad(url, context);
	},
});
const { reconcileAskUserQuestionTool, registerAskUserQuestionReconciler } = await import("../reconcile.ts");
hook.deregister();

const ASK = "ask_user_question";

function host(initial: string[], configured = ["read", "write", ASK]) {
	let active = [...initial];
	const writes: string[][] = [];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		getActiveTools: () => [...active],
		// Pi 1.5 ignores names outside the configured/allowlisted registry.
		setActiveTools: (names: string[]) => {
			active = names.filter((name) => configured.includes(name));
			writes.push([...names]);
		},
		on: (name: string, callback: (...args: any[]) => unknown) => handlers.set(name, callback),
	} as unknown as ExtensionAPI;
	const context = (hasUI: boolean) => ({ hasUI }) as ExtensionContext;
	return { pi, context, writes, handlers, get active() { return active; } };
}

test("UI does not activate an unselected, disabled, or allowlist-excluded tool", () => {
	for (const configured of [["read", ASK], ["read"]]) {
		const h = host(["read"], configured);
		reconcileAskUserQuestionTool(h.pi, h.context(true));
		reconcileAskUserQuestionTool(h.pi, h.context(false));
		reconcileAskUserQuestionTool(h.pi, h.context(true));
		assert.deepEqual(h.active, ["read"]);
		assert.deepEqual(h.writes, []);
	}
});

test("headless hides once and UI returning never restores the tool", () => {
	const h = host(["read", ASK, "write"]);
	reconcileAskUserQuestionTool(h.pi, h.context(false));
	reconcileAskUserQuestionTool(h.pi, h.context(false));
	assert.deepEqual(h.active, ["read", "write"]);
	assert.equal(h.writes.length, 1);
	reconcileAskUserQuestionTool(h.pi, h.context(true));
	reconcileAskUserQuestionTool(h.pi, h.context(true));
	assert.deepEqual(h.active, ["read", "write"]);
	assert.equal(h.writes.length, 1);
});

test("explicitly reselecting the same list without Ask never revives it", () => {
	const h = host(["read", ASK]);
	reconcileAskUserQuestionTool(h.pi, h.context(false));
	h.pi.setActiveTools(["read"]);
	reconcileAskUserQuestionTool(h.pi, h.context(true));
	assert.deepEqual(h.active, ["read"]);
	assert.equal(h.writes.length, 2);
});

test("an explicit host activation remains usable with UI and is hidden again without it", () => {
	const h = host(["read", ASK]);
	reconcileAskUserQuestionTool(h.pi, h.context(false));
	h.pi.setActiveTools(["read", ASK]);
	reconcileAskUserQuestionTool(h.pi, h.context(true));
	assert.deepEqual(h.active, ["read", ASK]);
	assert.equal(h.writes.length, 2);
	reconcileAskUserQuestionTool(h.pi, h.context(false));
	assert.deepEqual(h.active, ["read"]);
});

test("before_agent_start preserves RPC's selected tools and a fresh session's initialization", () => {
	const h = host(["read", ASK]);
	registerAskUserQuestionReconciler(h.pi);
	h.handlers.get("before_agent_start")!({}, { ...h.context(true), mode: "rpc" });
	assert.deepEqual(h.active, ["read", ASK]);
	assert.equal(h.writes.length, 0);
	assert.deepEqual([...h.handlers.keys()], ["before_agent_start"]);
	h.handlers.get("before_agent_start")!({}, h.context(false));
	assert.deepEqual(h.active, ["read"]);
	const fresh = host(["read", ASK]);
	reconcileAskUserQuestionTool(fresh.pi, fresh.context(true));
	assert.deepEqual(fresh.active, ["read", ASK]);
});

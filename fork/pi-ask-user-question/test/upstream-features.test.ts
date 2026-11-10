import assert from "node:assert/strict";
import test from "node:test";
import { inlineRowBudget, mustYieldInlineSlot, resolvePresentation } from "../presentation.ts";
import { routeKey } from "../state/key-router.ts";
import { sentinelsToAppend } from "../state/row-intent.ts";
import { reduce } from "../state/state-reducer.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "../state/state.ts";
import { normalizeQuestionParams, prepareQuestionArguments } from "../tool/normalize-params.ts";
import { buildQuestionnaireResponse } from "../tool/response-envelope.ts";
import type { QuestionData, QuestionParams } from "../tool/types.ts";
import { runRpcQuestionnaire } from "../rpc-fallback.ts";
import { renderAskCall, renderAskResult } from "../view/transcript.ts";
import { windowLines } from "../view/scroll-window.ts";

const question: QuestionData = { question: "When should totals refresh?", header: "Refresh", options: [
	{ label: "Live (Recommended)", description: "While open.", preview: "preview" },
	{ label: "On reopen", description: "When reopened." },
] };
const params: QuestionParams = { context: "Choose how checkout updates; live refresh shows a new discount immediately.", questions: [question] };
function initial(): QuestionnaireState {
	return { currentTab: 0, optionIndex: 0, inputMode: false, explainInputOpen: false, notesVisible: false,
		answers: new Map(), multiSelectChecked: new Set(), customDraftsByTab: new Map(), explainDraftsByTab: new Map(),
		notesByTab: new Map(), submitChoiceIndex: 0, notesDraft: "", collapsed: false };
}
function itemsFor(q: QuestionData) {
	return [...q.options.map(o => ({ kind: "option" as const, label: o.label })), ...sentinelsToAppend(q).map(kind => ({ kind, label: kind }))];
}
function runtime(q: QuestionData, state: QuestionnaireState, inputBuffer = ""): QuestionnaireRuntime {
	const items = itemsFor(q);
	return { questions: [q], items, currentItem: items[state.optionIndex], inputBuffer, isMulti: false,
		canMoveInputUp: false, canMoveInputDown: false, collapseKey: "off", notesKey: "Ж",
		keybindings: { matches: (data, name) => data === "\r" && name === "tui.select.confirm" } };
}
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as any;

test("prepareArguments retains upstream decoding and normalizes context with all displayed strings", () => {
	const decoded = prepareQuestionArguments({ context: "checkout\r\nupdates\r", questions: JSON.stringify([
		JSON.stringify({ ...question, question: "When\r?", options: JSON.stringify(question.options.map(o => JSON.stringify(o))) }),
	]) });
	const clean = normalizeQuestionParams(decoded);
	assert.equal(clean.context, "checkout\nupdates");
	assert.equal(clean.questions[0].question, "When?");
	assert.deepEqual(clean.questions[0].options, question.options);
	assert.equal(decoded.context, "checkout\r\nupdates\r", "normalization must not mutate arguments");
});

test("numeric keys retain option/custom behavior and activate Chat/Explain exactly as Enter", () => {
	for (const index of [0, 2, 3, 4]) {
		const state = { ...initial(), optionIndex: index };
		const numeric = routeKey(String(index + 1), initial(), runtime(question, initial()));
		const enter = routeKey("\r", state, runtime(question, state));
		if (index === 2) assert.deepEqual(numeric, { kind: "nav", nextIndex: 2, inputValue: "" });
		else assert.deepEqual(numeric, enter);
	}
	const input = { ...initial(), inputMode: true, optionIndex: 2 };
	assert.equal(routeKey("1", input, runtime(question, input)).kind, "ignore", "digits remain editor text");
	assert.equal(routeKey("\r", input, runtime(question, input, "  ")).kind, "ignore", "blank custom text is not an answer");
});

test("multi-select keeps checked choices and custom text, and configurable notes/global notes survive", () => {
	const q = { ...question, multiSelect: true };
	const ctx = { questions: [q, question], itemsByTab: [itemsFor(q), itemsFor(question)] };
	let state = reduce(initial(), { kind: "toggle", index: 0 }, ctx).state;
	state = reduce(state, { kind: "nav", nextIndex: 2, inputValue: "" }, ctx).state;
	state = reduce(state, { kind: "input_replace", value: "and another trigger" }, ctx).state;
	state = reduce(state, { kind: "nav", nextIndex: 3, inputValue: "and another trigger" }, ctx).state;
	assert.deepEqual(state.answers.get(0)?.selected, [q.options[0].label]);
	assert.equal(state.answers.get(0)?.answer, "and another trigger");
	assert.equal(routeKey("Ж", state, runtime(q, state)).kind, "notes_enter");
	state = reduce(state, { kind: "notes_enter" }, ctx).state;
	state = reduce({ ...state, notesDraft: "question note" }, { kind: "notes_exit" }, ctx).state;
	state = reduce(state, { kind: "tab_switch", nextTab: 2 }, ctx).state;
	state = reduce(state, { kind: "notes_enter" }, ctx).state;
	state = reduce({ ...state, notesDraft: "global note" }, { kind: "notes_exit" }, ctx).state;
	const result = reduce(state, { kind: "submit" }, ctx).effects.find(e => e.kind === "done");
	assert.equal(result?.kind, "done");
	if (result?.kind !== "done") return;
	assert.equal(result.result.globalNote, "global note");
	assert.equal(result.result.answers[0].notes, "question note");
	const response = buildQuestionnaireResponse(result.result, { ...params, questions: ctx.questions });
	assert.deepEqual(response.details.unanswered, [1]);
	assert.match(response.content[0].text, /unanswered:/);
	assert.match(response.content[0].text, /global note: global note/);
});

test("inline presentation keeps its 70% budget and passive overlays do not steal the slot", () => {
	assert.equal(inlineRowBudget(40), 28);
	assert.equal(inlineRowBudget(10), 10);
	const first = resolvePresentation();
	const second = resolvePresentation();
	try { assert.equal(first.overlay, false); assert.equal(second.overlay, true); } finally { first.release?.(); second.release?.(); }
	const editor = { render: () => [], invalidate() {} };
	const base = { terminal: {}, hasOverlay: () => true, children: [editor], getFocusedComponent: () => editor };
	assert.equal(mustYieldInlineSlot(base), false);
	assert.equal(mustYieldInlineSlot({ ...base, getFocusedComponent: () => ({ render: () => [], invalidate() {} }) }), true);
	assert.equal(mustYieldInlineSlot({ terminal: {}, hasOverlay: () => true }), true, "unknown host conservatively stacks");
	const window = windowLines(Array.from({ length: 50 }, (_, i) => `row ${i}`), 10, [30, 31], theme);
	assert.equal(window.lines.length, 10);
	assert.ok(window.lines.includes("row 30"));
	assert.equal(window.lines[0], "↑");
	assert.equal(window.lines.at(-1), "↓");
});

test("native RPC replies preserve free text, custom retry, and multi-select plus custom", async () => {
	assert.equal((await runRpcQuestionnaire({ select: async () => "user supplied text", input: async () => undefined }, params)).answers[0].answer, "user supplied text");
	let calls = 0;
	const retried = await runRpcQuestionnaire({ select: async (_title, options) => options[calls++ === 0 ? 2 : 1], input: async () => " " }, params);
	assert.equal(retried.answers[0].answer, "On reopen");
	const multi = await runRpcQuestionnaire({ select: async () => undefined, input: async () => "1,2; extra" }, { ...params, questions: [{ ...question, multiSelect: true }] });
	assert.deepEqual(multi.answers[0].selected, question.options.map(o => o.label));
	assert.equal(multi.answers[0].answer, "extra");
});

test("native receipts retain answers, notes and previews, while controls are not fabricated answers", () => {
	const details = { answers: [{ questionIndex: 0, question: question.question, kind: "option" as const, answer: question.options[0].label, preview: "preview", notes: "note" }], cancelled: false, globalNote: "global" };
	assert.match(renderAskCall(params, theme).render(80).join("\n"), /Ask Refresh/);
	const receipt = renderAskResult({ content: [], details }, params, theme, { expanded: true, isError: false }).render(80).join("\n");
	assert.match(receipt, /✓ Live/);
	assert.match(receipt, /preview/);
	assert.match(receipt, /✎ note/);
	assert.match(receipt, /✎ global/);
	for (const expanded of [false, true]) {
		for (const kind of ["chat", "explain"] as const) {
			const notes = kind === "explain" ? "Why live?\nWhat happens on reopen?" : undefined;
			const control = renderAskResult({ content: [], details: { answers: [], cancelled: false,
				[kind]: { questionIndex: 0, question: question.question, ...(notes ? { notes } : {}) },
			} }, params, theme, { expanded, isError: false }).render(80).join("\n");
			assert.equal(control, `↪ ${kind === "chat" ? "Chat about this" : "Explain More"}\n  ${question.question}${notes ? "\n  ✎ Why live?\n  What happens on reopen?" : ""}`);
		}
	}
});

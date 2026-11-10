import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../state/state-reducer.ts";
import type { QuestionnaireState } from "../state/state.ts";
import type { QuestionData } from "../tool/types.ts";
import { validateQuestionnaire } from "../tool/validate-questionnaire.ts";

const question: QuestionData = {
	question: "Which cache should this endpoint use?",
	header: "Cache",
	options: [
		{ label: "Memory", description: "Keep results in this process." },
		{ label: "Redis", description: "Share results across processes." },
	],
};

const initialState: QuestionnaireState = {
	currentTab: 0,
	optionIndex: 0,
	inputMode: false,
	explainInputOpen: false,
	notesVisible: false,
	answers: new Map(),
	multiSelectChecked: new Set(),
	customDraftsByTab: new Map(),
	explainDraftsByTab: new Map(),
	notesByTab: new Map(),
	submitChoiceIndex: 0,
	notesDraft: "",
	collapsed: false,
};

function resultFor(kind: "chat" | "explain", notes?: string) {
	const action = kind === "explain" ? { kind, ...(notes ? { notes } : {}) } as const : { kind } as const;
	const reduced = reduce(initialState, action, { questions: [question], itemsByTab: [[]] });
	const done = reduced.effects.find((effect) => effect.kind === "done");
	assert.ok(done && done.kind === "done");
	return done.result;
}

test("discussion and explanation actions produce distinct result fields", () => {
	const chat = resultFor("chat");
	assert.ok(chat.chat);
	assert.equal(chat.explain, undefined);

	const explain = resultFor("explain", "What does shared mean?");
	assert.deepEqual(explain.explain, {
		questionIndex: 0,
		question: question.question,
		notes: "What does shared mean?",
	});
	assert.equal(explain.chat, undefined);
	assert.deepEqual(explain.answers, []);

	const emptyExplain = resultFor("explain");
	assert.deepEqual(emptyExplain.explain, { questionIndex: 0, question: question.question });
});

test("Explain More opens a separate editor and closing preserves its isolated draft", () => {
	const items = [
		{ kind: "option" as const, label: "Memory" },
		{ kind: "other" as const, label: "Type something." },
		{ kind: "chat" as const, label: "Chat about this" },
		{ kind: "explain" as const, label: "Explain More" },
	];
	const focused = { ...initialState, optionIndex: 3 };
	const opened = reduce(focused, { kind: "explain_open" }, { questions: [question], itemsByTab: [items] });
	assert.equal(opened.state.explainInputOpen, true);
	assert.equal(opened.state.inputMode, false);
	assert.deepEqual(opened.effects, [
		{ kind: "set_input_buffer", value: "" },
		{ kind: "set_input_focused", focused: true },
	]);

	const closed = reduce(opened.state, { kind: "explain_close", value: "Why Redis?" }, {
		questions: [question],
		itemsByTab: [items],
	});
	assert.equal(closed.state.explainInputOpen, false);
	assert.equal(closed.state.explainDraftsByTab.get(0), "Why Redis?");
	assert.equal(closed.state.customDraftsByTab.has(0), false);
	// Closing hands the shared inline editor back to the `Type something.` row, which has
	// no draft on this tab — see test/explain-draft-display.test.ts for what the row renders.
	assert.deepEqual(closed.effects, [
		{ kind: "set_input_buffer", value: "" },
		{ kind: "set_input_focused", focused: false },
	]);

	const reopened = reduce(closed.state, { kind: "explain_open" }, { questions: [question], itemsByTab: [items] });
	assert.equal(reopened.state.explainInputOpen, true);
	assert.deepEqual(reopened.effects, [
		{ kind: "set_input_buffer", value: "Why Redis?" },
		{ kind: "set_input_focused", focused: true },
	]);
});

test("runtime validation rejects a whitespace-only context", () => {
	const validation = validateQuestionnaire({ context: "  \n", questions: [question] });
	assert.deepEqual(validation, {
		ok: false,
		error: "empty_context",
		message: "Error: Context must explain why the user is being asked to decide",
	});
});

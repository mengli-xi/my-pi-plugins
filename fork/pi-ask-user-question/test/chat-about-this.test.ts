import assert from "node:assert/strict";
import test from "node:test";
import { ROW_INTENT_META, leadingDividerFor, sentinelsToAppend } from "../state/row-intent.ts";
import { buildQuestionnaireResponse } from "../tool/response-envelope.ts";
import type { QuestionData, QuestionParams } from "../tool/types.ts";

const singleQuestion: QuestionData = {
	question: "Which cache should this endpoint use?",
	header: "Cache",
	options: [
		{ label: "Memory", description: "Keep data inside this process." },
		{ label: "Redis", description: "Share data across processes." },
	],
};
const params: QuestionParams = {
	context: "Customers are opening the catalog. This choice changes whether repeated requests share saved results. For example, Redis lets two API workers reuse the same cached product list.",
	questions: [singleQuestion],
};

function textOf(result: ReturnType<typeof buildQuestionnaireResponse>): string {
	return result.content[0]?.text ?? "";
}

test("discussion and explanation controls stay distinct and single-select only", () => {
	assert.equal(ROW_INTENT_META.chat.label, "Chat about this");
	assert.equal(ROW_INTENT_META.explain.label, "Explain More");
	assert.equal(ROW_INTENT_META.chat.leadingDivider, true);
	assert.equal(ROW_INTENT_META.explain.leadingDivider, false);
	assert.deepEqual(sentinelsToAppend(singleQuestion), ["other", "chat", "explain"]);
	assert.deepEqual(sentinelsToAppend({ ...singleQuestion, multiSelect: true }), ["other", "next"]);
});

test("discussion controls share one separated section", () => {
	assert.equal(leadingDividerFor("chat", 24), "─".repeat(24));
	assert.equal(leadingDividerFor("explain", 24), undefined);
	assert.equal(leadingDividerFor("option", 24), undefined);
});

test("Chat about this invites discussion of a concern", () => {
	const text = textOf(buildQuestionnaireResponse({
		answers: [],
		cancelled: false,
		chat: { questionIndex: 0, question: singleQuestion.question },
	}, params));
	assert.match(text, /disagree with an assumption/);
	assert.match(text, /Ask what they want to discuss/);
	assert.doesNotMatch(text, /Do not first ask/);
});

test("Explain More requires an immediate concrete explanation without a follow-up question", () => {
	const text = textOf(buildQuestionnaireResponse({
		answers: [],
		cancelled: false,
		explain: { questionIndex: 0, question: singleQuestion.question },
	}, params));
	assert.match(text, /Explain it immediately in plain language/);
	assert.match(text, /define any unfamiliar terms/);
	assert.match(text, /compare what each option would change/);
	assert.match(text, /one concrete example using the current task/);
	assert.match(text, /Do not first ask what they did not understand/);
	assert.match(text, /Question to explain/);
	assert.match(text, /Options to compare:\n- Memory: Keep data inside this process\./);
	assert.match(text, /- Redis: Share data across processes\./);
});

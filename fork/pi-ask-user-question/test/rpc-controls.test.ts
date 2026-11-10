import assert from "node:assert/strict";
import test from "node:test";
import { runRpcQuestionnaire, type DialogUI } from "../rpc-fallback.ts";
import type { QuestionParams } from "../tool/types.ts";

const params: QuestionParams = {
	context: "Customers are choosing how checkout totals refresh. This choice changes whether updates appear immediately or after reopening the page. For example, live refresh shows a new discount as soon as it is applied.",
	questions: [{
		question: "How should checkout totals refresh?",
		header: "Refresh",
		options: [
			{ label: "Live", description: "Update while the page remains open." },
			{ label: "On reopen", description: "Update the next time the page opens." },
		],
	}],
};

function dialogReturning(
	index: number,
	seen: { title?: string; options?: string[]; inputTitle?: string },
	explainNotes?: string,
): DialogUI {
	return {
		select: async (title, options) => {
			seen.title = title;
			seen.options = options;
			return options[index];
		},
		input: async (title) => {
			seen.inputTitle = title;
			return explainNotes;
		},
	};
}

test("RPC exposes separate Chat about this and Explain More controls", async () => {
	const chatSeen: { title?: string; options?: string[] } = {};
	const chat = await runRpcQuestionnaire(dialogReturning(3, chatSeen), params);
	assert.ok(chat.chat);
	assert.equal(chat.explain, undefined);
	assert.deepEqual(chatSeen.options?.slice(-2), ["4. Chat about this", "5. Explain More"]);
	assert.match(chatSeen.title ?? "", /Why this decision matters:/);

	const explainSeen: { title?: string; options?: string[]; inputTitle?: string } = {};
	const explain = await runRpcQuestionnaire(dialogReturning(4, explainSeen, "What does live mean?"), params);
	assert.deepEqual(explain.explain, {
		questionIndex: 0,
		question: params.questions[0].question,
		notes: "What does live mean?",
	});
	assert.equal(explain.chat, undefined);
	assert.match(explainSeen.inputTitle ?? "", /What would you like explained\? \(optional\)/);

	const empty = await runRpcQuestionnaire(dialogReturning(4, {}), params);
	assert.deepEqual(empty.explain, { questionIndex: 0, question: params.questions[0].question });
});

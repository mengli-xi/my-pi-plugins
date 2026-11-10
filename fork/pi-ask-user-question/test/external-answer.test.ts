import assert from "node:assert/strict";
import test from "node:test";
import { registerAnswerChannel } from "../answer-channel.ts";
import { ASK_USER_ANSWER_EVENT, ASK_USER_ANSWER_RESULT_EVENT } from "../events.ts";

const questions = [{ question: "When should checkout refresh?", header: "Refresh", options: [
	{ label: "Live", description: "Immediately.", preview: "preview" }, { label: "On reopen", description: "After reopening." },
] }];
function fixture() {
	const handlers = new Map<string, (value: unknown) => void>();
	const verdicts: any[] = [];
	const pi = { events: {
		on: (name: string, fn: (value: unknown) => void) => { handlers.set(name, fn); },
		emit: (name: string, data: unknown) => { if (name === ASK_USER_ANSWER_RESULT_EVENT) verdicts.push(data); else handlers.get(name)?.(data); },
	} };
	const channel = registerAnswerChannel(pi as never);
	return { channel, verdicts, answer: (value: unknown) => pi.events.emit(ASK_USER_ANSWER_EVENT, value) };
}

test("external answers name one toolCallId, preserve canonical preview/notes, and first answer wins", async () => {
	const f = fixture();
	const a = f.channel.open("a", questions, "tui");
	const b = f.channel.open("b", questions, "tui");
	f.answer({ toolCallId: "b", requestId: "r1", answers: [{ questionIndex: 0, optionIndexes: [0], notes: " note " }], globalNote: " global " });
	assert.equal(a.settled, undefined);
	assert.deepEqual((await b.answeredEarly).answers[0], { questionIndex: 0, question: questions[0].question, kind: "option", answer: "Live", preview: "preview", notes: "note" });
	assert.equal(b.settled?.globalNote, "global");
	assert.deepEqual(f.verdicts.at(-1), { ok: true, requestId: "r1", toolCallId: "b" });
	assert.equal(b.settle({ answers: [], cancelled: true }), false);
	f.answer({ toolCallId: "b", cancel: true });
	assert.equal(f.verdicts.at(-1).code, "not_found");
	f.channel.close(a);
	f.answer({ toolCallId: "a", cancel: true });
	assert.equal(f.verdicts.at(-1).code, "not_found");
});

test("external validation is atomic; mounted cancellation completes exactly once", () => {
	const f = fixture();
	const open = f.channel.open("mounted", questions, "tui");
	let completions = 0;
	open.attach(() => { completions++; });
	f.answer({ toolCallId: "mounted", answers: [{ questionIndex: 0, optionIndexes: [0, 1] }] });
	assert.equal(f.verdicts.at(-1).code, "invalid_answer");
	assert.equal(open.settled, undefined);
	assert.equal(completions, 0);
	f.answer({ toolCallId: "mounted", cancel: true });
	assert.deepEqual(open.settled, { answers: [], cancelled: true });
	assert.equal(completions, 1);
	f.answer({ toolCallId: "mounted", cancel: true });
	assert.equal(completions, 1);
	assert.equal(f.verdicts.length, 3, "one verdict per attempt");
});

test("RPC remains unsupported and controls never extend the inbound payload grammar", () => {
	const f = fixture();
	f.channel.open("rpc", questions, "rpc");
	f.answer({ toolCallId: "rpc", cancel: true });
	assert.equal(f.verdicts.at(-1).code, "unsupported_host");
	const tui = f.channel.open("tui", questions, "tui");
	f.answer({ toolCallId: "tui", explain: { questionIndex: 0 } });
	assert.equal(f.verdicts.at(-1).ok, false);
	assert.equal(tui.settled, undefined);
});

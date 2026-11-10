import { formatAnswerScalar } from "./format-answer.ts";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.ts";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";
export const CHAT_MESSAGE = 'The user chose "Chat about this" instead of answering the current question. They may disagree with an assumption, see a flaw in the proposed choices, or want to discuss a different direction. Ask what they want to discuss, then address that concern before asking again when appropriate.';
export const EXPLAIN_MESSAGE = 'The user chose "Explain More" because the current question is not yet understandable enough to answer. Explain it immediately in plain language: describe the user-visible situation, define any unfamiliar terms, compare what each option would change, and give one concrete example using the current task. Do not first ask what they did not understand. After the explanation, ask the question again when appropriate.';

/**
 * Map a `QuestionnaireResult` (or null/cancelled) to the LLM-facing tool envelope.
 * Pure of `(result, params)`; cancelled and "no segments" both fall to `DECLINE_MESSAGE`
 * so the model sees a single canonical "didn't answer" signal regardless of why.
 * "No segments" means no answers AND no global note — the `global note:` segment is
 * pushed before the zero-segments check, so a note-bearing submit with zero answers
 * still yields the answered envelope. A partial submit names the questions left blank
 * in an `unanswered:` segment (and `details.unanswered`, their indexes) so the model can
 * tell "not decided yet" from "settled" (#291); it never counts as an answer, and a fully
 * answered result stays byte-identical.
 */
export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		// Decline text stays canonical even when a global note rides the cancelled result;
		// the note survives in `details` (like partial `answers`) for replay consumers.
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
			...(result?.globalNote && result.globalNote.length > 0 ? { globalNote: result.globalNote } : {}),
		});
	}
	const control = result.explain
		? { request: result.explain, message: EXPLAIN_MESSAGE, label: "Question to explain" }
		: result.chat ? { request: result.chat, message: CHAT_MESSAGE, label: "Question selected for discussion" } : undefined;
	if (control) {
		const parts = [control.message, `User-facing context: ${params.context.trim()}`, `${control.label}: "${control.request.question}".`];
		const question = params.questions[control.request.questionIndex];
		if (result.explain && question) parts.push(`Options to compare:\n${question.options.map(o => `- ${o.label}: ${o.description}`).join("\n")}`);
		if (result.answers.length) parts.push(`Answers already provided: ${result.answers.map(buildAnswerSegment).join(" ")}`);
		if (control.request.notes) parts.push(`User notes: ${control.request.notes}`);
		if (result.globalNote) parts.push(`global note: ${result.globalNote}.`);
		return buildToolResult(parts.join("\n"), result);
	}
	const segments: string[] = [];
	const unanswered: number[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
		else unanswered.push(i);
	}
	const hasGlobalNote = result.globalNote !== undefined && result.globalNote.length > 0;
	if (segments.length === 0 && !hasGlobalNote) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	if (unanswered.length > 0) segments.push(buildUnansweredSegment(unanswered, params));
	// Global note rides after the per-question segments: raw multiline echo (no
	// reformatting), trailing period mirroring `buildAnswerSegment`'s shape.
	if (hasGlobalNote) segments.push(`global note: ${result.globalNote}.`);
	const details = unanswered.length > 0 ? { ...result, unanswered } : result;
	return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, details);
}

/** `unanswered: "<question>", "<question>".` — the questions shown but left blank on a partial submit. */
export function buildUnansweredSegment(indexes: readonly number[], params: QuestionParams): string {
	return `unanswered: ${indexes.map((i) => `"${params.questions[i]?.question}"`).join(", ")}.`;
}

/**
 * Format a single answer segment for the envelope. Pure of `a`. The `"Q"="A"` shape and
 * the optional `selected preview:` / `user notes:` suffixes are pinned by envelope tests.
 */
export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a, "envelope")}"`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

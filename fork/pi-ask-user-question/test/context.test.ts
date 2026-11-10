import assert from "node:assert/strict";
import test from "node:test";
import { formatQuestionContext, normalizeQuestionContext, QUESTION_CONTEXT_GUIDANCE } from "../context.ts";
import { QuestionParamsSchema } from "../tool/types.ts";

test("question context guidance is user-visible, concrete, and keeps one schema field", () => {
	assert.match(QUESTION_CONTEXT_GUIDANCE, /what they are currently seeing or doing/);
	assert.match(QUESTION_CONTEXT_GUIDANCE, /what this decision will change for them/);
	assert.match(QUESTION_CONTEXT_GUIDANCE, /one concrete example/);
	assert.match(QUESTION_CONTEXT_GUIDANCE, /Do not expose internal reasoning/);
	const contextSchema = (QuestionParamsSchema as { properties?: Record<string, { type?: string }> }).properties?.context;
	assert.equal(contextSchema?.type, "string");
	assert.deepEqual(Object.keys((QuestionParamsSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort(), [
		"context",
		"questions",
	]);
});

test("question context normalization tolerates legacy missing and whitespace-only values", () => {
	assert.equal(normalizeQuestionContext(undefined), undefined);
	assert.equal(normalizeQuestionContext("  \n  "), undefined);
	assert.equal(normalizeQuestionContext("  A concrete deployment scene. \n"), "A concrete deployment scene.");
});

test("native dialog context carries a visible purpose heading", () => {
	assert.equal(formatQuestionContext(undefined), "");
	assert.equal(
		formatQuestionContext("  The release is already serving paid users.  "),
		"\n\nWhy this decision matters:\nThe release is already serving paid users.",
	);
	assert.equal(
		formatQuestionContext("Users will see a different button.", "Why now:"),
		"\n\nWhy now:\nUsers will see a different button.",
	);
});

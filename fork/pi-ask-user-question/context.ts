/** Shared model guidance for authoring question context. */
export const QUESTION_CONTEXT_GUIDANCE =
	"Every ask_user_question call must include context. In 1-3 short plain-language sentences, tell a user who has not read the prior chat: what they are currently seeing or doing, what this decision will change for them, and one concrete example using the actual feature, value, or action. Lead with user-visible consequences; translate necessary technical terms into what the user would observe. Do not expose internal reasoning, merely restate the question or options, or rely on unexplained names, acronyms, architecture terms, or file paths.";

export const QUESTION_CONTEXT_HEADING = "Why this decision matters:";

/** Normalize display context while remaining tolerant of legacy/internal callers. */
export function normalizeQuestionContext(context: string | undefined): string | undefined {
	const normalized = context?.trim();
	return normalized ? normalized : undefined;
}

/** Description-like suffix for hosts that only expose native dialog titles. */
export function formatQuestionContext(
	context: string | undefined,
	heading = QUESTION_CONTEXT_HEADING,
): string {
	const normalized = normalizeQuestionContext(context);
	return normalized ? `\n\n${heading}\n${normalized}` : "";
}

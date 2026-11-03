import { formatAnswerScalar } from "./format-answer.js";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.js";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

/**
 * Map a `QuestionnaireResult` (or null/cancelled) to the LLM-facing tool envelope.
 * Pure of `(result, params)`; cancelled and "no segments" both fall to `DECLINE_MESSAGE`
 * so the model sees a single canonical "didn't answer" signal regardless of why.
 *
 * Partial submission is a normal outcome — the Submit tab does not require every
 * question to be answered — so the questions left blank are named explicitly in an
 * `unanswered:` segment and listed in `details.unanswered`. Without that, the model
 * reads `ENVELOPE_SUFFIX` and concludes the open topics were settled. They are not
 * rendered as `"Q"="(no input)"`: that placeholder reads as "answered with nothing"
 * rather than "never answered".
 */
export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
		});
	}
	const segments: string[] = [];
	const unanswered: number[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
		else unanswered.push(i);
	}
	if (segments.length === 0) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	segments.push(buildUnansweredSegment(unanswered, params));
	return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, {
		...result,
		unanswered,
	});
}

/**
 * Format a single answer segment for the envelope. Pure of `a`. The `"Q"="A"` shape and
 * the optional `selected preview:` / `user notes:` suffixes are pinned by envelope tests.
 */
export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"=${JSON.stringify(formatAnswerScalar(a, "envelope"))}`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

/**
 * Name the questions the user skipped. Addressed to the model in the third person so
 * the line still reads as a statement of fact rather than a UI label: `unanswered:
 * "Which auth?", "Ship now?"`. Empty string when everything was answered, so the
 * caller can append unconditionally.
 */
export function buildUnansweredSegment(indices: readonly number[], params: QuestionParams): string {
	if (indices.length === 0) return "";
	const questions = indices.map((i) => JSON.stringify(params.questions[i]?.question ?? `Q${i + 1}`));
	return `unanswered: ${questions.join(", ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

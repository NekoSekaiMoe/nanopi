import type { QuestionParams } from "./types.js";

/**
 * Collapse bare CR in model-supplied text to LF, dropping the CRs that stand
 * alone. A tool argument can carry `\r` that the model never meant as a line
 * break (`GEMBA\r_LOG`); passed through, `wrapTextWithAnsi` breaks the row on
 * it and the cursor is overwritten, and the guard strings compare unequal
 * (`"A\r"` vs `"A"`), so `reserved_label` / `duplicate_option_label` miss.
 *
 * `\r\n` is a real line break and becomes `\n`. A lone `\r` is removed, not
 * turned into a space: a space would still differentiate the guard strings
 * (`"A "` is not `"A"`), and the rendered row would carry a blank the model
 * did not write.
 */
export function normalizeText(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

/**
 * Normalize every free-text field the questionnaire accepts, so the validator,
 * the TUI, the envelope and the prompt event all read the same strings.
 * Option `preview` is markdown rendered as-is and stays untouched.
 */
export function normalizeQuestionParams(params: QuestionParams): QuestionParams {
	return {
		...params,
		questions: params.questions.map((q) => ({
			...q,
			question: normalizeText(q.question),
			header: normalizeText(q.header),
			options: q.options.map((o) => ({
				...o,
				label: normalizeText(o.label),
				description: normalizeText(o.description),
			})),
		})),
	};
}

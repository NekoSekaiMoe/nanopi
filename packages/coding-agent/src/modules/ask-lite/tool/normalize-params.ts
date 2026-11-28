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

/**
 * Decode double-encoded nested arguments before schema validation (upstream
 * #244, ported for CNB issue #885). Some tool-call parsers serialize an array
 * or its elements as JSON strings; `questions` then fails the array check, or
 * `questions.0` fails the object check, before the tool can display anything.
 * Only a string at an array/object position is decoded, and only when it
 * parses to the expected shape. Everything else passes through so validation
 * still reports the real problem.
 */
export function prepareQuestionArguments(args: unknown): QuestionParams {
	if (!isRecord(args) || !isEncoded(args.questions)) return args as QuestionParams;

	const rawQuestions = args.questions;
	const questions = decodeArray(rawQuestions);
	if (!Array.isArray(questions)) return args as QuestionParams;
	let changed = rawQuestions !== questions;
	const decoded = questions.map((q) => {
		const question = decodeObject(q);
		if (question === q) return question;
		changed = true;
		if (!isRecord(question)) return question;
		const options = decodeArray(question.options);
		if (options === question.options) return question;
		changed = true;
		return Array.isArray(options) ? { ...question, options: options.map(decodeObject) } : question;
	});
	if (!changed) return args as QuestionParams;
	return { ...args, questions: decoded } as unknown as QuestionParams;
}

/** True only when there is a JSON string at a position we may decode. */
function isEncoded(value: unknown): boolean {
	return typeof value === "string" || (Array.isArray(value) && value.some((item) => typeof item === "string"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeArray(value: unknown): unknown {
	const parsed = typeof value === "string" ? parseJson(value) : value;
	return Array.isArray(parsed) ? parsed : value;
}

function decodeObject(value: unknown): unknown {
	const parsed = typeof value === "string" ? parseJson(value) : value;
	return isRecord(parsed) ? parsed : value;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// Regression test for CNB issue #635: a bare CR in model-supplied tool args
// tore the option row apart and slipped past the label guards.
import { describe, expect, test } from "vitest";
import { normalizeQuestionParams, normalizeText } from "../src/extras/ask-lite/tool/normalize-params.ts";
import type { QuestionParams } from "../src/extras/ask-lite/tool/types.ts";
import { validateQuestionnaire } from "../src/extras/ask-lite/tool/validate-questionnaire.ts";

function params(overrides: Partial<QuestionParams["questions"][number]> = {}): QuestionParams {
	return {
		questions: [
			{
				question: "Which log?",
				header: "log",
				options: [
					{ label: "GEMBA\r_LOG", description: "fast" },
					{ label: "other", description: "slow" },
				],
				...overrides,
			},
		],
	};
}

describe("normalizeText", () => {
	test("turns CRLF into LF and drops a lone CR", () => {
		expect(normalizeText("a\r\nb")).toBe("a\nb");
		expect(normalizeText("GEMBA\r_LOG")).toBe("GEMBA_LOG");
	});

	test("leaves text without CR untouched", () => {
		expect(normalizeText("plain\ntext")).toBe("plain\ntext");
	});
});

describe("normalizeQuestionParams", () => {
	test("normalizes question, header, label and description", () => {
		const out = normalizeQuestionParams({
			questions: [
				{
					question: "Why?\r",
					header: "h\r",
					options: [
						{ label: "A\r", description: "d\r" },
						{ label: "B", description: "e" },
					],
				},
			],
		});
		const q = out.questions[0]!;
		expect(q.question).toBe("Why?");
		expect(q.header).toBe("h");
		expect(q.options[0]).toEqual({ label: "A", description: "d" });
		expect(q.options[1]).toEqual({ label: "B", description: "e" });
	});

	test("keeps a CR inside option preview — it is rendered markdown", () => {
		const out = normalizeQuestionParams({
			questions: [
				{
					question: "Why?",
					header: "h",
					options: [
						{ label: "A", description: "", preview: "line\r" },
						{ label: "B", description: "" },
					],
				},
			],
		});
		expect(out.questions[0]!.options[0]!.preview).toBe("line\r");
	});

	test("a trailing CR no longer escapes the reserved-label guard", () => {
		const raw: QuestionParams = {
			questions: [
				{
					question: "Why?",
					header: "h",
					options: [
						{ label: "Type something.\r", description: "" },
						{ label: "B", description: "" },
					],
				},
			],
		};
		expect(validateQuestionnaire(raw)).toMatchObject({ ok: true });
		expect(validateQuestionnaire(normalizeQuestionParams(raw))).toMatchObject({
			ok: false,
			error: "reserved_label",
		});
	});

	test("a trailing CR no longer escapes the duplicate-label guard", () => {
		const raw: QuestionParams = {
			questions: [
				{
					question: "Why?",
					header: "h",
					options: [
						{ label: "A\r", description: "" },
						{ label: "A", description: "" },
					],
				},
			],
		};
		expect(validateQuestionnaire(raw)).toMatchObject({ ok: true });
		expect(validateQuestionnaire(normalizeQuestionParams(raw))).toMatchObject({
			ok: false,
			error: "duplicate_option_label",
		});
	});

	test("keeps the normalized form for the questions the dialog renders", () => {
		const out = normalizeQuestionParams(params());
		expect(out.questions[0]!.options[0]!.label).toBe("GEMBA_LOG");
	});
});

// Regression test for CNB issue #449: a partially submitted questionnaire used to
// reach the model as if every question had been answered.
import { describe, expect, test } from "vitest";
import {
	buildQuestionnaireResponse,
	DECLINE_MESSAGE,
	ENVELOPE_SUFFIX,
} from "../src/extras/ask-lite/tool/response-envelope.ts";
import type { QuestionnaireResult, QuestionParams } from "../src/extras/ask-lite/tool/types.ts";

const params: QuestionParams = {
	questions: [
		{ question: "Which database?", header: "DB", options: [] },
		{ question: "Which auth?", header: "Auth", options: [] },
		{ question: "Ship now?", header: "Ship", options: [] },
	],
};

function text(result: QuestionnaireResult): string {
	return buildQuestionnaireResponse(result, params).content[0]!.text;
}

describe("buildQuestionnaireResponse", () => {
	test("names the questions left blank on partial submission", () => {
		const out = text({
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Which database?", kind: "option", answer: "Postgres" }],
		});
		expect(out).toBe(
			`User has answered your questions: "Which database?"="Postgres". ` +
				`unanswered: "Which auth?", "Ship now?". ${ENVELOPE_SUFFIX}`,
		);
	});

	test("reports the unanswered indices in details", () => {
		const details = buildQuestionnaireResponse(
			{
				cancelled: false,
				answers: [{ questionIndex: 1, question: "Which auth?", kind: "option", answer: "Passkey" }],
			},
			params,
		).details;
		expect(details.unanswered).toEqual([0, 2]);
		expect(details.answers).toHaveLength(1);
	});

	test("does not render skipped questions as (no input)", () => {
		const out = text({
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Which database?", kind: "option", answer: "Postgres" }],
		});
		expect(out).not.toContain("(no input)");
	});

	test("omits the unanswered segment when every question is answered", () => {
		const out = text({
			cancelled: false,
			answers: params.questions.map((q, i) => ({
				questionIndex: i,
				question: q.question,
				kind: "option" as const,
				answer: `a${i}`,
			})),
		});
		expect(out).not.toContain("unanswered:");
		expect(
			buildQuestionnaireResponse(
				{
					cancelled: false,
					answers: params.questions.map((q, i) => ({
						questionIndex: i,
						question: q.question,
						kind: "option" as const,
						answer: `a${i}`,
					})),
				},
				params,
			).details.unanswered,
		).toEqual([]);
	});

	test("cancelled and empty results keep the single decline signal", () => {
		expect(text({ cancelled: true, answers: [] })).toBe(DECLINE_MESSAGE);
		expect(text({ cancelled: false, answers: [] })).toBe(DECLINE_MESSAGE);
	});
});

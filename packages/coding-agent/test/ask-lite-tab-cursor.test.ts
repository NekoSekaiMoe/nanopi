// Regression test for CNB issue #635: switching back to an answered tab reset the
// cursor to row 0, so a stray Enter replaced the stored answer with option 1.
import { describe, expect, test } from "vitest";
import { answeredRowIndex } from "../src/extras/ask-lite/state/selectors/derivations.ts";
import type { QuestionnaireState } from "../src/extras/ask-lite/state/state.ts";
import { reduce } from "../src/extras/ask-lite/state/state-reducer.ts";
import type { QuestionAnswer, QuestionData } from "../src/extras/ask-lite/tool/types.ts";
import type { WrappingSelectItem } from "../src/extras/ask-lite/view/components/wrapping-select.ts";

const singleItems: WrappingSelectItem[] = [
	{ kind: "option", label: "A" },
	{ kind: "option", label: "B" },
	{ kind: "option", label: "C" },
];

const multiItems: WrappingSelectItem[] = [
	{ kind: "option", label: "A" },
	{ kind: "option", label: "B" },
	{ kind: "next", label: "Next" },
];

const singleQuestion: QuestionData = {
	question: "pick one",
	header: "pick",
	options: [
		{ label: "A", description: "" },
		{ label: "B", description: "" },
		{ label: "C", description: "" },
	],
};

const multiQuestion: QuestionData = { ...singleQuestion, multiSelect: true };

const customItems: WrappingSelectItem[] = [...singleItems, { kind: "other", label: "Type something." }];

const customQuestion: QuestionData = {
	question: "pick one",
	header: "pick",
	options: [
		{ label: "A", description: "", preview: "```\ncode\n```" },
		{ label: "B", description: "", preview: "```\nmore\n```" },
		{ label: "C", description: "", preview: "```\nat last\n```" },
	],
};

function state(overrides: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		chatFocused: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		notesByTab: new Map(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
		...overrides,
	};
}

describe("answeredRowIndex", () => {
	test("returns the row of the previously confirmed option", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: singleQuestion.question, kind: "option", answer: "C" }],
		]);
		expect(answeredRowIndex([singleQuestion], answers, singleItems, 0)).toBe(2);
	});

	test("returns 0 for an unanswered tab", () => {
		expect(answeredRowIndex([singleQuestion], new Map(), singleItems, 0)).toBe(0);
	});

	test("returns the Next row for an answered multi-select tab", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: multiQuestion.question, kind: "multi", answer: null, selected: ["A"] }],
		]);
		expect(answeredRowIndex([multiQuestion], answers, multiItems, 0)).toBe(2);
	});

	test("returns the Type something row for an answered custom tab", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: customQuestion.question, kind: "custom", answer: "typed" }],
		]);
		expect(answeredRowIndex([customQuestion], answers, customItems, 0)).toBe(3);
	});

	test("returns 0 when the stored label no longer matches a row", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: singleQuestion.question, kind: "option", answer: "gone" }],
		]);
		expect(answeredRowIndex([singleQuestion], answers, singleItems, 0)).toBe(0);
	});
});

describe("tab_switch", () => {
	const questions = [singleQuestion, singleQuestion];
	const itemsByTab = [singleItems, singleItems];

	test("lands on the row that already answered the tab", () => {
		const answers = new Map<number, QuestionAnswer>([
			[1, { questionIndex: 1, question: singleQuestion.question, kind: "option", answer: "B" }],
		]);
		const result = reduce(state({ answers }), { kind: "tab_switch", nextTab: 1 }, { questions, itemsByTab });
		expect(result.state.currentTab).toBe(1);
		expect(result.state.optionIndex).toBe(1);
	});

	test("lands on row 0 for an unanswered tab", () => {
		const result = reduce(state({ optionIndex: 2 }), { kind: "tab_switch", nextTab: 1 }, { questions, itemsByTab });
		expect(result.state.optionIndex).toBe(0);
	});

	test("restores the stored custom text when landing on its row", () => {
		const answers = new Map<number, QuestionAnswer>([
			[1, { questionIndex: 1, question: customQuestion.question, kind: "custom", answer: "typed" }],
		]);
		const result = reduce(
			state({ answers }),
			{ kind: "tab_switch", nextTab: 1 },
			{ questions: [customQuestion, customQuestion], itemsByTab: [customItems, customItems] },
		);
		expect(result.state.optionIndex).toBe(3);
		expect(result.state.inputMode).toBe(false);
		expect(result.effects).toContainEqual({ kind: "set_input_buffer", value: "typed" });
	});

	test("clears the inline buffer when landing on a plain option", () => {
		const result = reduce(state(), { kind: "tab_switch", nextTab: 1 }, { questions, itemsByTab });
		expect(result.effects).toContainEqual({ kind: "clear_input_buffer" });
	});
});

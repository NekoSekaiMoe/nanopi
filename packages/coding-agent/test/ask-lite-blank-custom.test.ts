// Regression test for CNB issue #635: Enter on an untouched "Type something."
// row recorded a `custom` answer with a null body, which the envelope sent to
// the model as `(no input)` — read as "answered, but empty".
import { getKeybindings } from "@nanopi/pi-tui";
import { describe, expect, test } from "vitest";
import { routeKey } from "../src/extras/ask-lite/state/key-router.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "../src/extras/ask-lite/state/state.ts";
import type { QuestionData } from "../src/extras/ask-lite/tool/types.ts";
import type { WrappingSelectItem } from "../src/extras/ask-lite/view/components/wrapping-select.ts";

const ENTER = "\r";

const items: WrappingSelectItem[] = [
	{ kind: "option", label: "A" },
	{ kind: "option", label: "B" },
	{ kind: "other", label: "Type something." },
];

const question: QuestionData = {
	question: "pick one",
	header: "pick",
	options: [
		{ label: "A", description: "" },
		{ label: "B", description: "" },
	],
};

function state(optionIndex: number): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex,
		inputMode: true,
		notesVisible: false,
		chatFocused: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		notesByTab: new Map(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
	};
}

function runtime(inputBuffer: string): QuestionnaireRuntime {
	return {
		keybindings: getKeybindings(),
		inputBuffer,
		questions: [question],
		isMulti: false,
		currentItem: items[2],
		items,
		visibleRows: 5,
	};
}

describe("blank custom answer", () => {
	test("Enter on an empty draft is a no-op, not a null answer", () => {
		expect(routeKey(ENTER, state(2), runtime(""))).toEqual({ kind: "ignore" });
	});

	test("Enter on a typed draft still confirms the custom answer", () => {
		expect(routeKey(ENTER, state(2), runtime("something else"))).toEqual({
			kind: "confirm",
			answer: { questionIndex: 0, question: "pick one", kind: "custom", answer: "something else" },
		});
	});
});

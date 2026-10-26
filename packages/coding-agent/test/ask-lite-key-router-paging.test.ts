import { getKeybindings } from "@nanopi/pi-tui";
import { describe, expect, test } from "vitest";
import { routeKey } from "../src/extras/ask-lite/state/key-router.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "../src/extras/ask-lite/state/state.ts";
import type { QuestionData } from "../src/extras/ask-lite/tool/types.ts";
import type { WrappingSelectItem } from "../src/extras/ask-lite/view/components/wrapping-select.ts";

/** PageUp/PageDown as the terminal sends them (xterm CSI 5~/6~). */
const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";
const UP = "\u001b[A";
const DOWN = "\u001b[B";

const items: WrappingSelectItem[] = Array.from({ length: 12 }, (_, index) => ({
	kind: "option",
	label: `option-${index}`,
}));

const question: QuestionData = {
	question: "pick one",
	header: "pick",
	options: items.map((item) => ({ label: item.label, description: "" })),
};

function state(optionIndex: number): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex,
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
	};
}

function runtime(visibleRows: number): QuestionnaireRuntime {
	return {
		keybindings: getKeybindings(),
		inputBuffer: "",
		questions: [question],
		isMulti: false,
		currentItem: items[0],
		items,
		visibleRows,
	};
}

describe("ask-lite option list paging", () => {
	test("PgUp/PgDn move by the visible window and wrap like the arrows do", () => {
		const rows = 5;
		expect(routeKey(PAGE_DOWN, state(0), runtime(rows))).toEqual({ kind: "nav", nextIndex: 5 });
		expect(routeKey(PAGE_DOWN, state(10), runtime(rows))).toEqual({ kind: "nav", nextIndex: 3 });
		expect(routeKey(PAGE_UP, state(0), runtime(rows))).toEqual({ kind: "nav", nextIndex: 7 });
	});

	test("Paging uses the mounted list height, not a fixed step", () => {
		// A short list (4 visible) pages by 4; the old router had no paging at all and the
		// arrows moved one row.
		expect(routeKey(PAGE_DOWN, state(0), runtime(4))).toEqual({ kind: "nav", nextIndex: 4 });
		expect(routeKey(UP, state(3), runtime(4))).toEqual({ kind: "nav", nextIndex: 2 });
		expect(routeKey(DOWN, state(3), runtime(4))).toEqual({ kind: "nav", nextIndex: 4 });
	});

	test("Paging out of the chat row lands in the option list", () => {
		const chat = { ...state(0), chatFocused: true };
		expect(routeKey(PAGE_DOWN, chat, runtime(5))).toEqual({ kind: "focus_options", optionIndex: 0 });
		expect(routeKey(PAGE_UP, chat, runtime(5))).toEqual({ kind: "focus_options", optionIndex: 11 });
	});
});

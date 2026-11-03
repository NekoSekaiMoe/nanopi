import { getKeybindings } from "@nanopi/pi-tui";
import { describe, expect, test } from "vitest";
import { buildQuestionnaire } from "../src/extras/ask-lite/state/build-questionnaire.ts";
import { routeKey } from "../src/extras/ask-lite/state/key-router.ts";
import type { QuestionnaireState } from "../src/extras/ask-lite/state/state.ts";
import type { QuestionData } from "../src/extras/ask-lite/tool/types.ts";
import type { WrappingSelectItem } from "../src/extras/ask-lite/view/components/wrapping-select.ts";

const PAGE_DOWN = "\u001b[6~";

function options(count: number): QuestionData["options"] {
	return Array.from({ length: count }, (_, i) => ({ label: `q${i}`, description: "" }));
}

function items(count: number): WrappingSelectItem[] {
	return Array.from({ length: count }, (_, i) => ({ kind: "option", label: `q${i}` }));
}

// Two tabs with different option counts: the tall tab 0 used to dictate the
// page step for every tab, so paging tab 1 jumped by tab 0's window.
const questions: QuestionData[] = [
	{ question: "first?", header: "first", options: options(4) },
	{ question: "second?", header: "second", options: options(2) },
];
const itemsByTab = [items(4), items(2)];

function state(currentTab: number): QuestionnaireState {
	return {
		currentTab,
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
	};
}

function build(tab: number) {
	const built = buildQuestionnaire({
		tui: { terminal: { columns: 80, rows: 24 }, requestRender: () => {} },
		theme: {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		questions,
		itemsByTab,
		isMulti: true,
		initialState: state(tab),
		getCurrentTab: () => tab,
	});
	return built;
}

describe("ask-lite option page size", () => {
	test("follows the active tab's own option list", () => {
		expect(build(0).optionPageSize()).toBe(4);
		expect(build(1).optionPageSize()).toBe(2);
	});

	test("PgDn on a short tab steps by that tab's window, not tab 0's", () => {
		const built = build(1);
		expect(
			routeKey(PAGE_DOWN, state(1), {
				keybindings: getKeybindings(),
				inputBuffer: "",
				questions,
				isMulti: true,
				currentItem: itemsByTab[1]![0],
				items: itemsByTab[1]!,
				visibleRows: built.optionPageSize(),
			}),
		).toEqual({ kind: "nav", nextIndex: 0 });
	});
});

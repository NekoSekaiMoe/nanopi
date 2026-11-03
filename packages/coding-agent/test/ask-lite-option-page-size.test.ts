import { describe, expect, test } from "vitest";
import { buildQuestionnaire } from "../src/extras/ask-lite/state/build-questionnaire.ts";
import type { QuestionnaireState } from "../src/extras/ask-lite/state/state.ts";
import type { QuestionData } from "../src/extras/ask-lite/tool/types.ts";
import { MAX_VISIBLE_OPTIONS } from "../src/extras/ask-lite/view/components/option-list-view.ts";
import type { WrappingSelectItem } from "../src/extras/ask-lite/view/components/wrapping-select.ts";
import { Theme, type ThemeBg, type ThemeColor } from "../src/modes/interactive/theme/theme.ts";

/** Minimal theme: the questionnaire only needs the tokens it styles with. */
const theme = new Theme(
	{ text: "#e5e5e7", accent: "#3b82f6", muted: "#6b7280", dim: "#4b5563", thinkingXhigh: "#a78bfa" } as Partial<
		Record<ThemeColor, string>
	> as never,
	{} as Partial<Record<ThemeBg, string>> as never,
	"truecolor",
	{ name: "test", appearance: "dark" },
);

function question(optionCount: number): QuestionData {
	return {
		question: "pick one",
		header: "pick",
		options: Array.from({ length: optionCount }, (_, i) => ({ label: `option-${i}`, description: "" })),
	};
}

function items(optionCount: number): WrappingSelectItem[] {
	return Array.from({ length: optionCount }, (_, i) => ({ kind: "option" as const, label: `option-${i}` }));
}

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

/** Page size is read once per keystroke, so it must track the live tab. */
function pageSizeAfterSwitchingTo(optionCounts: number[], currentTab: number): number {
	let tab = 0;
	const built = buildQuestionnaire({
		tui: { terminal: { columns: 80, rows: 24 }, requestRender: () => {} },
		theme,
		questions: optionCounts.map(question),
		itemsByTab: optionCounts.map(items),
		isMulti: optionCounts.length > 1,
		initialState: state(0),
		getCurrentTab: () => tab,
	});
	tab = currentTab;
	return built.optionPageSize();
}

describe("ask-lite optionPageSize", () => {
	test("follows the current tab instead of always reading tab 0", () => {
		// Tab 0 has 2 options (window 2), tab 1 has 7 (window 7). PgDn on tab 1 must
		// step 7 rows, not 2.
		expect(pageSizeAfterSwitchingTo([2, 7], 0)).toBe(2);
		expect(pageSizeAfterSwitchingTo([2, 7], 1)).toBe(7);
	});

	test("caps at MAX_VISIBLE_OPTIONS on every tab", () => {
		const tall = MAX_VISIBLE_OPTIONS + 2;
		expect(pageSizeAfterSwitchingTo([2, tall], 1)).toBe(MAX_VISIBLE_OPTIONS);
		expect(pageSizeAfterSwitchingTo([tall, 2], 0)).toBe(MAX_VISIBLE_OPTIONS);
	});

	test("falls back to the last tab when the index is out of range", () => {
		expect(pageSizeAfterSwitchingTo([2, 5], 9)).toBe(5);
	});
});

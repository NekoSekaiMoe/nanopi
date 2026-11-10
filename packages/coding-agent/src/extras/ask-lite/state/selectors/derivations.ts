import type { QuestionAnswer, QuestionData } from "../../tool/types.js";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.js";
import { ROW_INTENT_META } from "../row-intent.js";

/**
 * Pure derivation: does the option focused by `(currentTab, optionIndex)` carry a
 * non-empty `preview` string? Mode gates (chat focus, notes mode, multiSelect) layer
 * on top via dispatch branches; this predicate is intentionally mode-agnostic.
 */
export function computeFocusedOptionHasPreview(
	questions: readonly QuestionData[],
	currentTab: number,
	optionIndex: number,
): boolean {
	const q = questions[currentTab];
	if (!q) return false;
	const opt = q.options[optionIndex];
	return !!opt && typeof opt.preview === "string" && opt.preview.length > 0;
}

/**
 * Numbering for the chat row's WrappingSelect, computed from the active tab's items.
 *
 * The chat row lives in its own one-item WrappingSelect; the host calls this on every tab
 * switch / selection update to keep the chat row's `N. ` label continuous with the visible
 * numbered rows of the active tab. The shape `{ offset, total }` mirrors
 * `WrappingSelect.setNumbering(numberStartOffset, totalItemsForNumbering)` directly.
 */
export function chatNumberingFor(items: readonly WrappingSelectItem[]): {
	offset: number;
	total: number;
} {
	// Count only the visible-numbered rows. The Next sentinel renders without a number
	// (see MultiSelectView), so it must NOT advance the chat row's number — otherwise
	// chat reads as "6." next to options labeled 1-4. Sourced from `ROW_INTENT_META[kind].numbered`
	// so adding a new non-numbered kind is a single META edit.
	const count = items.filter((i) => ROW_INTENT_META[i.kind].numbered).length;
	return { offset: count, total: count + 1 };
}

/**
 * Which row in the active tab should be marked as "previously confirmed"? Drives the
 * `WrappingSelect` confirmed-row indicator (label + ` ✔`) when the user navigates back
 * to a question they already answered. Returns `undefined` when no marker should be drawn —
 * multi-select handles its own `[✔]` boxes via `multiSelectChecked`, `kind: "chat"` ends the
 * dialog so the row can never be re-entered, and a missing/non-matching answer (defensive)
 * silently skips the marker.
 */
export function selectConfirmedIndicator(
	questions: readonly QuestionData[],
	currentTab: number,
	answers: ReadonlyMap<number, QuestionAnswer>,
	items: readonly WrappingSelectItem[],
): { index: number; labelOverride?: string } | undefined {
	const q = questions[currentTab];
	if (!q || q.multiSelect === true) return undefined;
	const prior = answers.get(currentTab);
	if (!prior || prior.kind === "chat") return undefined;
	if (prior.kind === "custom") {
		const otherIndex = items.findIndex((it) => it.kind === "other");
		if (otherIndex < 0) return undefined;
		return { index: otherIndex, labelOverride: prior.answer ?? "" };
	}
	if (prior.kind !== "option" || typeof prior.answer !== "string") return undefined;
	const index = items.findIndex((it) => it.kind === "option" && it.label === prior.answer);
	if (index < 0) return undefined;
	return { index };
}

/**
 * Row the option list should focus when the user lands on a tab, so switching back
 * to an answered question does not move the selection and quietly rewrite the answer.
 *
 * - multi-select lands on `Next`: the row that commits the question, and the only row
 *   whose Enter is not a checkbox toggle (`autoSubmitsInMulti`).
 * - a `custom` answer lands on the "Type something." row: focusing it restores the typed
 *   text through `nav`'s `set_input_buffer` effect.
 * - an `option` answer lands on that option.
 * - unanswered, or answered with the chat sentinel (which ends the dialog, so the row can
 *   never be re-entered), lands on 0.
 */
export function answeredRowIndex(
	questions: readonly QuestionData[],
	answers: ReadonlyMap<number, QuestionAnswer>,
	items: readonly WrappingSelectItem[],
	tab: number,
): number {
	if (items.length === 0) return 0;
	const q = questions[tab];
	const prior = answers.get(tab);
	if (!q || !prior) return 0;
	if (q.multiSelect === true) {
		const nextIndex = items.findIndex((it) => ROW_INTENT_META[it.kind].autoSubmitsInMulti);
		return nextIndex < 0 ? 0 : nextIndex;
	}
	if (prior.kind === "custom") {
		const otherIndex = items.findIndex((it) => it.kind === "other");
		return otherIndex < 0 ? 0 : otherIndex;
	}
	if (prior.kind !== "option" || typeof prior.answer !== "string") return 0;
	const index = items.findIndex((it) => it.kind === "option" && it.label === prior.answer);
	return index < 0 ? 0 : index;
}

/**
 * Index of the preview pane to display for the current tab. The Submit tab (currentTab ===
 * questions.length) reuses the last question's pane purely for layout — the strategy
 * machinery picks the right body component independently. Defensive against `totalQuestions === 0`.
 */
export function selectActivePreviewPaneIndex(currentTab: number, totalQuestions: number): number {
	if (totalQuestions <= 0) return 0;
	return Math.min(currentTab, totalQuestions - 1);
}

/**
 * Items array for the active tab, with the same Submit-tab clamp as `selectActivePreviewPaneIndex`.
 * Falls back to an empty array if the index lands outside the items array (defensive).
 */
export function selectActiveTabItems(
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
	currentTab: number,
	totalQuestions: number,
): readonly WrappingSelectItem[] {
	const idx = selectActivePreviewPaneIndex(currentTab, totalQuestions);
	return itemsByTab[idx] ?? [];
}
